// Local server: serves the built app from dist/ and the allow-listed relay at /api/relay.
// Usage: npm start   (PORT=8080 HOST=127.0.0.1 by default; HOST=0.0.0.0 to test from a phone on your LAN)

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { gzipSync, brotliCompressSync, constants as zc } from 'node:zlib';
import { Readable } from 'node:stream';
import { handle } from './relay/core.mjs';

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
    if (url.pathname === '/api/relay') return relay(req, res, url);
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = normalize(join(ROOT, p));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    let st = await stat(file).catch(() => null);
    let target = file;
    if (!st || st.isDirectory()) { target = join(ROOT, 'index.html'); st = await stat(target); }
    const ext = extname(target);
    const headers = { ...SECURITY, 'Content-Type': MIME[ext] || 'application/octet-stream' };
    headers['Cache-Control'] = /\/(sw\.js|index\.html|version\.json|config\.json|manifest\.webmanifest)$/.test(target) || ext === '.html'
      ? 'no-cache' : /\/(assets|vendor|icons)\//.test(target) ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
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
  const chunks = [];
  if (req.method === 'POST') for await (const c of req) { chunks.push(c); if (chunks.reduce((a, b) => a + b.length, 0) > 65536) break; }
  const request = new Request(url, {
    method: req.method,
    headers: Object.fromEntries(Object.entries(req.headers).filter(([k]) => ['accept', 'content-type', 'range'].includes(k))),
    body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
  });
  const out = await handle(request, { clientIp: req.socket.remoteAddress || 'anon' });
  res.writeHead(out.status, Object.fromEntries(out.headers));
  if (!out.body || req.method === 'HEAD') return res.end();
  Readable.fromWeb(out.body).on('error', () => res.destroy()).pipe(res);
}

server.listen(PORT, HOST, () => {
  console.log(`SkyShift running at http://localhost:${PORT}/  (serving ${ROOT})`);
});
