// Stateless, allow-listed CORS relay. Written against the standard Fetch API
// (Request/Response), so the same code runs on Node 18+, Cloudflare Workers/Pages,
// Netlify Edge, Vercel Edge and Deno Deploy. It only forwards to the data services
// and pages of the challenge resources (and JPL Horizons for Solar System positions); it is not an open proxy.

import { parseHeader, riceDecode32 } from '../src/lib/fits.js';

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
  // NASA JPL Horizons (positions of asteroids and comets by name; added by the author beyond the eight resources)
  { host: 'ssd.jpl.nasa.gov', paths: ['/api/horizons.api'] },
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
function limited(ip, max = 240) {
  const now = Date.now(), win = 60000;
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

// ------------------------------------------------------------------ gather: many small byte ranges of one SPHEREx file
// A SPHEREx cutout needs one short range per image row (about 100 per exposure). Browsers would send each as its own
// request; the relay instead reads the rows in a few large reads near the archive and returns only the requested
// bytes, in the order asked: one request per exposure instead of about 100. Only files of IRSA's public SPHEREx
// bucket are read, with fixed limits on ranges and bytes.
export const GATHER_HOSTS = ['nasa-irsa-spherex.s3.us-east-1.amazonaws.com', 'nasa-irsa-spherex.s3.amazonaws.com'];
const GATHER = { ranges: 600, want: 6 * 1024 * 1024, fetch: 24 * 1024 * 1024, spans: 8, gap: 256 * 1024 };

export function parseGather(target, rspec) {
  let u;
  try { u = new URL(target); } catch { return { error: 'bad url' }; }
  if (u.protocol !== 'https:' || !GATHER_HOSTS.includes(u.hostname) || u.search || u.username || !/^\/[\w./-]+\.fits$/.test(u.pathname)) return { error: 'gather is only for SPHEREx files of IRSA’s public bucket' };
  const ranges = String(rspec || '').split(',').filter(Boolean).map((x) => x.split('-').map(Number));
  if (!ranges.length || ranges.length > GATHER.ranges) return { error: `1 to ${GATHER.ranges} ranges` };
  let want = 0;
  for (const r of ranges) {
    if (r.length !== 2 || !r.every(Number.isSafeInteger) || r[0] < 0 || r[1] < r[0]) return { error: 'ranges are start-end byte offsets' };
    want += r[1] - r[0] + 1;
  }
  if (want > GATHER.want) return { error: 'too many bytes asked' };
  // merge ranges whose gaps are small into spans, each read with one request
  const sorted = ranges.map((r, i) => [r[0], r[1], i]).sort((a, b) => a[0] - b[0]);
  const spans = [];
  for (const [a, b] of sorted) {
    const last = spans[spans.length - 1];
    if (last && a - last[1] <= GATHER.gap) last[1] = Math.max(last[1], b); else spans.push([a, b]);
  }
  if (spans.length > GATHER.spans || spans.reduce((n, [a, b]) => n + b - a + 1, 0) > GATHER.fetch) return { error: 'ranges too spread out' };
  return { url: u.toString(), ranges, spans, want };
}

async function gather(target, rspec, fetchImpl) {
  const g = parseGather(target, rspec);
  if (g.error) return json(400, { error: g.error });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const parts = await Promise.all(g.spans.map(async ([a, b]) => {
      const r = await fetchImpl(g.url, { headers: { Range: `bytes=${a}-${b}`, 'User-Agent': 'SkyShift-relay/1.0' }, signal: ctl.signal });
      if (r.status !== 206 && r.status !== 200) throw Object.assign(new Error(`archive answered ${r.status}`), { upstream: r.status });
      const buf = new Uint8Array(await r.arrayBuffer());
      const start = r.status === 200 ? 0 : Number((r.headers.get('content-range') || '').match(/bytes (\d+)-/)?.[1] ?? a);
      return { a: start, buf };
    }));
    const out = new Uint8Array(g.want);
    let o = 0;
    for (const [s, e] of g.ranges) {
      const p = parts.find((x) => s >= x.a && e < x.a + x.buf.length);
      if (!p) throw Object.assign(new Error('range beyond the end of the file'), { upstream: 416 });
      out.set(p.buf.subarray(s - p.a, e - p.a + 1), o); o += e - s + 1;
    }
    return new Response(out, { status: 200, headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'attachment', 'X-Relay-Upstream-Status': '206' } });
  } catch (e) {
    // as for relayed requests: the relay is healthy, the archive is not (clients fall back to direct reads)
    return new Response(JSON.stringify({ error: 'gather failed', detail: String(e?.message || e).slice(0, 200) }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Relay-Error': 'gather-failed', 'X-Relay-Upstream-Status': String(e?.upstream || 0) } });
  } finally { clearTimeout(timer); }
}

// ------------------------------------------------------------------ flagwin: quality flags around one position
// SPHEREx quality flags are stored as RICE-compressed full-width rows (about 100 kB for the rows around a target).
// The relay reads and decodes those rows near the archive and returns only a small window (int32, little-endian,
// row by row); the flag names (MSKNnnnn) come back in X-Flag-Bits. Same files and limits as gather.
export function parseFlagWindow(q) {
  const g = parseGather(q.get('flagwin'), '0-0');
  if (g.error) return { error: g.error };
  const n = (k) => Number(q.get(k));
  const off = n('off'), x0 = n('x0'), x1 = n('x1'), y0 = n('y0'), y1 = n('y1');
  if (![off, x0, x1, y0, y1].every(Number.isSafeInteger) || off < 2880 || x0 < 1 || y0 < 1 || x1 < x0 || y1 < y0 || x1 - x0 > 255 || y1 - y0 > 63) return { error: 'flag window: off, x0, x1, y0, y1 (1-based, at most 256 × 64 pixels)' };
  return { url: g.url, off, x0, x1, y0, y1 };
}

async function flagWindow(q, fetchImpl) {
  const w = parseFlagWindow(q);
  if (w.error) return json(400, { error: w.error });
  const get = async (a, b) => {
    const r = await fetchImpl(w.url, { headers: { Range: `bytes=${a}-${b}`, 'User-Agent': 'SkyShift-relay/1.0' } });
    if (r.status !== 206 && r.status !== 200) throw Object.assign(new Error(`archive answered ${r.status}`), { upstream: r.status });
    const buf = new Uint8Array(await r.arrayBuffer());
    return r.status === 200 ? buf.subarray(a, b + 1) : buf;
  };
  try {
    let hb = await get(w.off, w.off + 2880 * 7 - 1), p = parseHeader(hb, 0);
    if (!p) { hb = await get(w.off, w.off + 2880 * 20 - 1); p = parseHeader(hb, 0); }
    const h = p?.header;
    if (!h || h.EXTNAME !== 'FLAGS' || h.ZCMPTYPE !== 'RICE_1' || (h.ZTILE2 ?? 1) !== 1) throw new Error('FLAGS HDU not where expected');
    const W = h.ZNAXIS1, H = h.ZNAXIS2, rowBytes = h.NAXIS1, dataStart = w.off + p.end, heapStart = dataStart + (h.THEAP ?? h.NAXIS1 * h.NAXIS2);
    const y0 = Math.max(1, w.y0), y1 = Math.min(H, w.y1), x0 = Math.max(1, w.x0), x1 = Math.min(W, w.x1);
    const desc = await get(dataStart + (y0 - 1) * rowBytes, dataStart + y1 * rowBytes - 1);
    const dv = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
    const rows = []; let lo = Infinity, hi = 0;
    for (let r = 0; r <= y1 - y0; r++) { const len = dv.getInt32(r * 8, false), o = dv.getInt32(r * 8 + 4, false); rows.push([len, o]); lo = Math.min(lo, o); hi = Math.max(hi, o + len); }
    const heap = await get(heapStart + lo, heapStart + hi - 1);
    const ww = x1 - x0 + 1, out = new Int32Array(ww * rows.length);
    rows.forEach(([len, o], r) => { const row = riceDecode32(heap.subarray(o - lo, o - lo + len), W, h.ZVAL1 ?? 32); out.set(row.subarray(x0 - 1, x1), r * ww); });
    const bits = Object.fromEntries(Object.entries(h).filter(([k]) => /^MSKN\d{4}$/.test(k)).map(([k, v]) => [Number(k.slice(4)), v]));
    return new Response(new Uint8Array(out.buffer), { status: 200, headers: { ...CORS, 'Content-Type': 'application/octet-stream', 'Cache-Control': 'public, max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': 'attachment', 'X-Relay-Upstream-Status': '206',
      'X-Flag-Window': `${x0},${x1},${y0},${y1}`, 'X-Flag-Bits': encodeURIComponent(JSON.stringify(bits)), 'Access-Control-Expose-Headers': `${CORS['Access-Control-Expose-Headers']}, X-Flag-Window, X-Flag-Bits` } });
  } catch (e) {
    return new Response(JSON.stringify({ error: 'flag window failed', detail: String(e?.message || e).slice(0, 200) }),
      { status: 200, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Relay-Error': 'flagwin-failed', 'X-Relay-Upstream-Status': String(e?.upstream || 0) } });
  }
}

export async function handle(request, { clientIp = 'anon', fetchImpl = fetch } = {}) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (!['GET', 'HEAD', 'POST'].includes(request.method)) return json(405, { error: 'method not allowed' });
  const self = new URL(request.url);
  if (self.searchParams.has('flagwin') && request.method === 'GET') {
    if (limited(`g:${clientIp}`, 3000)) return json(429, { error: 'rate limited' });
    return flagWindow(self.searchParams, fetchImpl);
  }
  if (self.searchParams.has('gather') && request.method === 'GET') {
    if (limited(`g:${clientIp}`, 3000)) return json(429, { error: 'rate limited' });
    return gather(self.searchParams.get('gather'), self.searchParams.get('r'), fetchImpl);
  }
  if (!self.searchParams.has('url')) return json(200, { ok: true, service: 'skyshift-relay', allow: ALLOW.map((r) => r.host), gather: GATHER_HOSTS });
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
