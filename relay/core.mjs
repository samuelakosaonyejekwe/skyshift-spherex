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
  return list.some((p) => pathq.startsWith(p) || u.pathname === p.replace(/[/?]$/, ''));
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
    redirect: 'follow',
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
    up = await fetchImpl(target, { ...init, signal: ctl.signal });
  } catch (e) {
    clearTimeout(timer);
    // Answer 200 with an explicit error header: the relay itself is healthy, the upstream is not.
    return new Response(JSON.stringify({ error: 'upstream unreachable', detail: String(e?.cause?.code || e?.message || e).slice(0, 200) }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'X-Relay-Error': 'upstream-unreachable', 'X-Relay-Upstream-Status': '0' } });
  }
  if (up.url && !isAllowed(up.url, 'GET') && up.url !== target) {
    clearTimeout(timer);
    return json(403, { error: 'redirected off allow-list' });
  }
  const len = Number(up.headers.get('content-length') || 0);
  if (len > MAX_BYTES) { clearTimeout(timer); return json(413, { error: 'response too large' }); }
  const headers = { ...CORS, 'X-Relay-Upstream-Status': String(up.status), 'Cache-Control': cacheControlFor(new URL(target)), 'X-Content-Type-Options': 'nosniff' };
  for (const h of ['content-type', 'content-range', 'last-modified', 'etag']) {
    const v = up.headers.get(h); if (v) headers[h] = v;
  }
  // HTML from upstream must never render as a page on the relay origin
  if (/html/i.test(headers['content-type'] || '')) {
    headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
  }
  let seen = 0;
  const limiter = new TransformStream({
    transform(chunk, c) {
      seen += chunk.byteLength;
      if (seen > MAX_BYTES) { c.error(new Error('too large')); ctl.abort(); return; }
      c.enqueue(chunk);
    },
    flush() { clearTimeout(timer); },
  });
  // upstream 5xx is passed as 502 so the client can fail over to another relay
  const status = up.status >= 500 ? 502 : up.status;
  return new Response(up.body ? up.body.pipeThrough(limiter) : null, { status, headers });
}
