// Stateless, allow-listed CORS relay. Written against the standard Fetch API
// (Request/Response), so the same code runs on Node 18+, Cloudflare Workers/Pages,
// Netlify Edge, Vercel Edge and Deno Deploy. It only forwards to the data services
// and pages of the challenge resources; it is not an open proxy.

export const ALLOW = [
  // IRSA (SPHEREx archive, TAP, SIA, IBE cutouts, docs)
  { host: 'irsa.ipac.caltech.edu', paths: ['/TAP/', '/TAP?', '/SIA', '/ibe/', '/Missions/spherex', '/data/SPHEREx/', '/spherex-archive-documentation', '/data/hips/', '/voapi.html'], post: ['/TAP/'] },
  { host: 'caltech-ipac.github.io', paths: ['/irsa-tutorials/', '/spherex-archive-documentation/'] },
  // WiseView (Backyard Worlds tools)
  { host: 'byw.tools', paths: ['/'] },
  // MAST: Gaia mission page and MAST API
  { host: 'archive.stsci.edu', paths: ['/missions-and-data/gaia'] },
  { host: 'mast.stsci.edu', paths: ['/api/v0/invoke'], post: ['/api/v0/invoke'] },
  // Canadian Space Agency NEOSSat + open data, CADC
  { host: 'www.asc-csa.gc.ca', paths: ['/eng/satellites/neossat'] },
  { host: 'data.asc-csa.gc.ca', paths: ['/dataset/neossat', '/api/3/action/'] },
  { host: 'donnees-data.asc-csa.gc.ca', paths: ['/en/dataset/', '/api/3/action/'] },
  { host: 'www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca', paths: ['/en/'] },
  { host: 'ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca', paths: ['/argus/', '/caom2ops/'] },
  // GitHub (NEOSSat tutorial repository)
  { host: 'github.com', paths: ['/asc-csa/NEOSSAT_Tutorial'] },
];

const MAX_BYTES = 40 * 1024 * 1024;
const MAX_BODY = 64 * 1024;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Range',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Content-Type, Last-Modified, ETag, X-Relay-Upstream-Status, X-Relay-Error',
  'Access-Control-Max-Age': '86400',
};

export function isAllowed(target, method = 'GET') {
  let u;
  try { u = new URL(target); } catch { return false; }
  if (!/^https?:$/.test(u.protocol) || u.username || u.password) return false;
  if (u.port && u.port !== '443' && u.port !== '80') return false;
  const rule = ALLOW.find((r) => r.host === u.hostname);
  if (!rule) return false;
  const pathq = u.pathname + (u.search ? '?' : '');
  const list = method === 'POST' ? rule.post || [] : rule.paths;
  // a prefix matches whole path segments only: '/asc-csa/NEOSSAT_Tutorial' allows '/asc-csa/NEOSSAT_Tutorial/…' but not
  // '/asc-csa/NEOSSAT_Tutorial-other'; prefixes ending in '/' or '?' already mark their own boundary
  return list.some((p) => u.pathname === p.replace(/[/?]$/, '') || (pathq.startsWith(p) && (/[/?]$/.test(p) || /^[/?.]|^$/.test(pathq.slice(p.length)))));
}

const json = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// best-effort in-memory rate limit (per isolate / process)
const hits = new Map();
function limited(ip) {
  const now = Date.now(), win = 60000, max = 240;
  const h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > win) { h.n = 0; h.t = now; }
  h.n++; hits.set(ip, h);
  if (hits.size > 5000) hits.clear();
  return h.n > max;
}

function cacheControlFor(u) {
  if (/\/TAP\b|argus|api\/v0/.test(u.pathname)) return 'public, max-age=120';
  if (/\/ibe\//.test(u.pathname)) return 'public, max-age=86400';
  return 'public, max-age=600';
}

export async function handle(request, { clientIp = 'anon', fetchImpl = fetch } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'method not allowed' });
  const self = new URL(request.url);
  if (!self.searchParams.has('url')) return json(200, { ok: true, service: 'skyshift-relay', allow: ALLOW.map((r) => r.host) });
  const target = self.searchParams.get('url');
  if (!isAllowed(target, request.method)) return json(403, { error: 'target not on allow-list', target: String(target).slice(0, 200) });
  if (limited(clientIp)) return json(429, { error: 'rate limited' });

  const init = {
    method: request.method,
    headers: { 'User-Agent': 'SkyShift-relay/1.0', Accept: request.headers.get('accept') || '*/*' },
    redirect: 'manual', // every hop is checked against the allow-list before it is followed
  };
  const range = request.headers.get('range');
  if (range && /^bytes=\d*-\d*$/.test(range)) init.headers.Range = range;
  if (request.method === 'POST') {
    const body = await request.arrayBuffer();
    if (body.byteLength > MAX_BODY) return json(413, { error: 'body too large' });
    init.body = body;
    init.headers['Content-Type'] = request.headers.get('content-type') || 'application/x-www-form-urlencoded';
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 55000);
  let up;
  try {
    let url = target;
    for (let hop = 0; ; hop++) {
      up = await fetchImpl(url, { ...init, signal: ctl.signal });
      const loc = up.status >= 300 && up.status < 400 ? up.headers.get('location') : null;
      if (!loc) break;
      const next = new URL(loc, url).toString();
      if (hop >= 3 || !isAllowed(next, 'GET')) {
        clearTimeout(timer);
        return json(403, { error: hop >= 3 ? 'too many redirects' : 'redirect off allow-list' });
      }
      url = next;
      if (init.method === 'POST' && up.status !== 307 && up.status !== 308) { init.method = 'GET'; delete init.body; }
    }
  } catch (e) {
    clearTimeout(timer);
    // Answer 200 with an explicit error header: the relay itself is healthy, the upstream is not.
    return new Response(JSON.stringify({ error: 'upstream unreachable', detail: String(e?.cause?.code || e?.message || e).slice(0, 200) }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'X-Relay-Error': 'upstream-unreachable', 'X-Relay-Upstream-Status': '0' } });
  }
  // the 55 s limit covers waiting for the archive's answer; while the body streams, only a 30 s stall aborts it
  clearTimeout(timer);
  let idle = null;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => ctl.abort(), 30000); };
  const len = Number(up.headers.get('content-length') || 0);
  if (len > MAX_BYTES) { ctl.abort(); return json(413, { error: 'response too large' }); }
  // every relayed body is inert on the relay's origin (no scripts, no rendering as an active page)
  const headers = { ...CORS, 'X-Relay-Upstream-Status': String(up.status), 'Cache-Control': cacheControlFor(new URL(target)), 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'attachment' };
  for (const h of ['content-type', 'content-range', 'last-modified', 'etag']) {
    const v = up.headers.get(h); if (v) headers[h] = v;
  }
  let seen = 0;
  const limiter = new TransformStream({
    start() { kick(); },
    transform(chunk, c) {
      kick();
      seen += chunk.byteLength;
      if (seen > MAX_BYTES) { clearTimeout(idle); c.error(new Error('too large')); ctl.abort(); return; }
      c.enqueue(chunk);
    },
    flush() { clearTimeout(idle); },
  });
  // An archive's server error (e.g. IRSA's gateway answering 502) is reported in X-Relay-Upstream-Status with a
  // 200 from the relay: the relay is healthy, so clients do not fail over to another relay (the archive is down for
  // every relay alike) and browsers do not log a failed request; clients read the header and use their fallbacks.
  // 502/503/504 from the relay itself therefore always mean "this relay is broken".
  const status = up.status >= 500 ? 200 : up.status;
  if (up.status >= 500) headers['Cache-Control'] = 'no-store';
  return new Response(up.body ? up.body.pipeThrough(limiter) : null, { status, headers });
}
