// Local server: serves the built app from dist/ and the allow-listed relay at /api/relay.
// Usage: npm start   (PORT=8080 HOST=127.0.0.1 by default; HOST=0.0.0.0 to test from a phone on your LAN)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { Readable } from 'node:stream';
import { handle } from './relay/core.mjs';
import https from 'node:https';
import tls from 'node:tls';

// CSA open-data hosts send an incomplete certificate chain; add the missing public intermediate
// (relay/certs/README.txt) to the normal roots for those hosts only. Verification stays on.
const EXTRA_CA_HOSTS = new Set(['data.asc-csa.gc.ca', 'donnees-data.asc-csa.gc.ca']);
const extraCa = await readFile('relay/certs/entrust-ov-tls-issuing-rsa-ca-2.pem', 'utf8').catch(() => null);
function relayFetch(url, init = {}) {
  const u = new URL(url);
  if (!extraCa || !EXTRA_CA_HOSTS.has(u.hostname)) return fetch(url, init);
  return new Promise((resolve, reject) => {
    // redirects are returned to the relay core, which checks every hop against the allow-list
    const req = https.request(u, { method: init.method || 'GET', headers: init.headers, ca: [...tls.rootCertificates, extraCa], signal: init.signal }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      const r = new Response(Readable.toWeb(res), { status: res.statusCode, headers });
      Object.defineProperty(r, 'url', { value: u.toString() });
      resolve(r);
    });
    req.on('error', reject);
    if (init.body) req.write(Buffer.from(init.body));
    req.end();
  });
}

const ROOT = resolve(process.argv.includes('--src') ? '.' : 'dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '127.0.0.1';

if (!existsSync(join(ROOT, 'index.html'))) {
  console.error(`No build found in ${ROOT}. Run "npm run build" first.`);
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml',
};
const COMPRESSIBLE = /\.(html|js|mjs|css|json|webmanifest|svg|txt|xml)$/;
const SECURITY = JSON.parse(await readFile(join(ROOT, 'security-headers.json'), 'utf8').catch(() => '{}'));
const memo = new Map();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/api/relay') return await relay(req, res, url); // awaited, so a failing request is answered, not fatal
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (file !== ROOT && !file.startsWith(ROOT + sep)) { res.writeHead(403).end(); return; }
    let st = await stat(file).catch(() => null);
    let target = file;
    if (!st || st.isDirectory()) {
      // a missing file with an extension is a real 404 (never the app page under a script's name, which the service
      // worker would otherwise store as that script); page addresses without one get the app
      if (!st && extname(file)) { res.writeHead(404, { ...SECURITY, 'Content-Type': 'text/plain' }).end('Not found'); return; }
      target = join(ROOT, 'index.html'); st = await stat(target);
    }
    const ext = extname(target);
    const headers = { ...SECURITY, 'Content-Type': MIME[ext] || 'application/octet-stream' };
    headers['Cache-Control'] = /\/(sw\.js|index\.html|version\.json|config\.json|manifest\.webmanifest)$/.test(target) || ext === '.html'
      ? 'no-cache' : /\/(vendor|icons)\//.test(target) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'; // assets/ is rewritten in place by the data refresh
    if (target.endsWith('sw.js')) headers['Service-Worker-Allowed'] = '/';
    const etag = `"${st.size.toString(36)}-${st.mtimeMs.toString(36)}"`;
    headers.ETag = etag;
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers).end(); return; }
    const ae = String(req.headers['accept-encoding'] || '');
    if (COMPRESSIBLE.test(target) && st.size > 1024) {
      const enc = /\bbr\b/.test(ae) ? 'br' : /\bgzip\b/.test(ae) ? 'gzip' : null;
      if (enc) {
        const key = `${target}|${etag}|${enc}`;
        let buf = memo.get(key);
        if (!buf) {
          const raw = await readFile(target);
          buf = enc === 'br' ? brotliCompressSync(raw, { params: { [zc.BROTLI_PARAM_QUALITY]: 9 } }) : gzipSync(raw, { level: 9 });
          memo.set(key, buf);
        }
        res.writeHead(200, { ...headers, 'Content-Encoding': enc, Vary: 'Accept-Encoding', 'Content-Length': buf.length });
        res.end(req.method === 'HEAD' ? undefined : buf);
        return;
      }
    }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    createReadStream(target).pipe(res);
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' }).end('Server error');
    console.error(e);
  }
});

async function relay(req, res, url) {
  // only the methods the relay serves; others (TRACE, CONNECT…) cannot even be built into a Request
  if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD, POST, OPTIONS' }); return res.end(); }
  const chunks = [];
  if (req.method === 'POST') for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 65536) break; }
  const request = new Request(url, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['accept', 'content-type', 'range'].includes(k))),
    body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  });
  const out = await handle(request, { clientIp: req.socket.remoteAddress || 'anon', fetchImpl: relayFetch });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (!out.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(out.body).on('error', () => res.destroy()).pipe(res);
}

server.listen(PORT, HOST, () => {
  console.log(`SkyShift running at http://localhost:${PORT}/  (serving ${ROOT})`);
});
