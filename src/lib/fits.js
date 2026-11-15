// Minimal, dependency-free FITS reader built for HTTP byte-range access.
// Reads only the bytes it needs from SPHEREx Level 2 MEF files hosted on the
// public, CORS-enabled IRSA S3 bucket (nasa-irsa-spherex), so a 65 MB file can
// yield a small cutout, its flags and its wavelength table in a few hundred kB.

export const BLOCK = 2880;

/** Parse FITS header cards from a byte array starting at `start`. Returns {header, end} or null if END not found. */
export function parseHeader(bytes, start = 0) {
  const h = {};
  const td = new TextDecoder('latin1');
  for (let i = start; i + 80 <= bytes.length; i += 80) {
    const card = td.decode(bytes.subarray(i, i + 80));
    const key8 = card.slice(0, 8).trim();
    if (key8 === 'END') {
      const end = start + Math.ceil((i + 80 - start) / BLOCK) * BLOCK;
      return { header: h, end };
    }
    if (!key8 || key8 === 'COMMENT' || key8 === 'HISTORY') continue;
    let key, rest;
    if (key8 === 'HIERARCH') {
      const eq = card.indexOf('=');
      if (eq < 0) continue;
      key = card.slice(9, eq).trim().replace(/\s+/g, ' ');
      rest = card.slice(eq + 1);
    } else {
      if (card[8] !== '=') continue;
      key = key8;
      rest = card.slice(10);
    }
    h[key] = parseValue(rest);
  }
  return null;
}

function parseValue(rest) {
  const s = rest.trimStart();
  if (s.startsWith("'")) {
    let out = '', j = 1;
    while (j < s.length) {
      if (s[j] === "'") {
        if (s[j + 1] === "'") { out += "'"; j += 2; continue; }
        break;
      }
      out += s[j++];
    }
    return out.trimEnd();
  }
  const v = s.split('/')[0].trim();
  if (v === 'T') return true;
  if (v === 'F') return false;
  const n = Number(v.replace(/D/i, 'E'));
  return Number.isFinite(n) && v !== '' ? n : v;
}

export function dataSize(h) {
  const naxis = h.NAXIS || 0;
  if (!naxis) return 0;
  let n = 1;
  for (let i = 1; i <= naxis; i++) n *= h[`NAXIS${i}`];
  const bytes = (Math.abs(h.BITPIX) / 8) * (h.GCOUNT ?? 1) * ((h.PCOUNT ?? 0) + n);
  return Math.ceil(bytes / BLOCK) * BLOCK;
}

// The public IRSA SPHEREx bucket answers on several CORS-enabled hostnames. Rotating small
// range requests across them multiplies the browser's per-host connection limit.
export const S3_HOSTS = [
  'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/',
  'https://nasa-irsa-spherex.s3.amazonaws.com/',
  'https://s3.us-east-1.amazonaws.com/nasa-irsa-spherex/',
  'https://s3.amazonaws.com/nasa-irsa-spherex/',
  'https://nasa-irsa-spherex.s3.dualstack.us-east-1.amazonaws.com/',
  'https://nasa-irsa-spherex.s3-external-1.amazonaws.com/',
  'https://s3-external-1.amazonaws.com/nasa-irsa-spherex/',
  'https://s3.dualstack.us-east-1.amazonaws.com/nasa-irsa-spherex/',
];
let hostRR = 0;
function viaHost(url, shift) {
  const base = S3_HOSTS[0];
  if (!url.startsWith(base)) return url;
  return S3_HOSTS[(hostRR++ + shift) % S3_HOSTS.length] + url.slice(base.length);
}
// global limiter: 8 hosts x 6 HTTP/1.1 connections
const POOL = { max: 48, active: 0, q: [] };
function pooled(fn) {
  return new Promise((res, rej) => {
    const run = () => { POOL.active++; fn().then(res, rej).finally(() => { POOL.active--; const n = POOL.q.shift(); if (n) n(); }); };
    if (POOL.active < POOL.max) run(); else POOL.q.push(run);
  });
}

/** Byte-range fetcher with host rotation, stall timeout, retry, abort support and transfer accounting. */
export class RangeSource {
  constructor(url, { fetchImpl, onBytes = () => {}, signal } = {}) {
    // keep fetch unbound from this object (browsers throw "Illegal invocation" otherwise)
    const f = fetchImpl || globalThis.fetch.bind(globalThis);
    this.url = url; this.fetch = (...a) => f(...a); this.onBytes = onBytes; this.signal = signal;
    this.size = null;
  }
  async get(start, end /* inclusive */) {
    const range = end == null ? `bytes=${start}` : `bytes=${start}-${end}`;
    return this._req(range);
  }
  async tail(n) { return this._req(`bytes=-${n}`); }
  async _req(range) {
    let lastErr;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await pooled(() => this._once(range, attempt));
      } catch (e) {
        if (e.name === 'AbortError' && this.signal?.aborted) throw e;
        lastErr = e;
        await new Promise((r) => setTimeout(r, 150 * (attempt + 1) ** 2));
      }
    }
    throw lastErr;
  }
  async _once(range, attempt) {
    // a request queued before the page was left is dropped, not fetched
    if (this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // a stalled request is abandoned after 10 s and retried on another hostname
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 10000);
    const onAbort = () => ctl.abort();
    this.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      {
        // no-store: the HTTP cache's per-URL lock would serialise parallel ranges (results are cached in IndexedDB)
        const res = await this.fetch(viaHost(this.url, attempt), { headers: { Range: range }, signal: ctl.signal, cache: 'no-store', mode: 'cors' });
        if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status} for ${range}`);
        const cr = res.headers.get('content-range');
        if (cr) { const m = cr.match(/\/(\d+)$/); if (m) this.size = Number(m[1]); }
        const buf = new Uint8Array(await res.arrayBuffer());
        this.onBytes(buf.length);
        if (res.status === 200 && !/^bytes=-/.test(range)) {
          // server ignored Range: slice what was asked
          const [a, b] = range.slice(6).split('-').map(Number);
          return buf.subarray(a, Number.isFinite(b) ? b + 1 : undefined);
        }
        return buf;
      }
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Many small ranges of this file in one request through a SkyShift relay ("gather", relay/core.mjs): the relay
   * reads them near the archive and returns only these bytes. Returns one Uint8Array per range, or null when no
   * relay is set or it cannot help (the caller then reads the ranges directly).
   */
  async gather(ranges) {
    const relay = gatherRelays.find((r) => (gatherFails.get(r) || 0) < 3);
    if (!relay || !ranges.length || ranges.length > 600) return null;
    if (this.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const q = `${relay}${relay.includes('?') ? '&' : '?'}gather=${encodeURIComponent(this.url)}&r=${ranges.map(([a, b]) => `${a}-${b}`).join(',')}`;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    const onAbort = () => ctl.abort();
    this.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const res = await pooled(() => this.fetch(q, { signal: ctl.signal, mode: 'cors' }));
      if (!res.ok || res.headers.get('x-relay-error')) throw new Error(`gather answered ${res.status}${res.headers.get('x-relay-error') ? ' (' + res.headers.get('x-relay-error') + ')' : ''}`);
      const buf = new Uint8Array(await res.arrayBuffer());
      const want = ranges.reduce((n, [a, b]) => n + b - a + 1, 0);
      if (buf.length !== want) throw new Error(`gather returned ${buf.length} of ${want} bytes`);
      this.onBytes(buf.length);
      gatherFails.set(relay, 0);
      const out = []; let o = 0;
      for (const [a, b] of ranges) { out.push(buf.subarray(o, o + b - a + 1)); o += b - a + 1; }
      return out;
    } catch (e) {
      if (this.signal?.aborted) throw e;
      gatherFails.set(relay, (gatherFails.get(relay) || 0) + 1); // after 3 failures in a row this relay is not asked again
      return null;
    } finally {
      clearTimeout(timer);
      this.signal?.removeEventListener('abort', onAbort);
    }
  }
}

// relays that can gather ranges (absolute URLs, set by the page through the frame worker); failures per relay
let gatherRelays = [];
const gatherFails = new Map();
export function setGatherRelays(list) { gatherRelays = Array.isArray(list) ? list.filter((r) => /^https?:\/\//.test(r)) : []; }

/** Convert big-endian float32 bytes into a Float32Array (copy). */
export function beFloat32(bytes) {
  const n = bytes.length >> 2;
  const out = new Float32Array(n);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) out[i] = dv.getFloat32(i * 4, false);
  return out;
}

const bitLen = (b) => (b < 4294967296 ? 32 - Math.clz32(b) : Math.floor(Math.log2(b)) + 1);

/**
 * RICE_1 decompression for 32-bit integers (algorithm of the FITS tiled image
 * compression convention; same bitstream as CFITSIO's fits_rdecomp).
 * Uses Number arithmetic for the bit buffer so no 32-bit overflow can occur.
 */
export function riceDecode32(bytes, nx, nblock = 32) {
  const fsbits = 5, fsmax = 25, bbits = 32;
  const out = new Int32Array(nx);
  let c = 0;
  let lastpix = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) | 0;
  c = 4;
  let b = bytes[c++];
  let nbits = 8;
  const P = (n) => 2 ** n;
  for (let i = 0; i < nx;) {
    nbits -= fsbits;
    while (nbits < 0) { b = b * 256 + bytes[c++]; nbits += 8; }
    const fs = Math.floor(b / P(nbits)) - 1;
    b = b % P(nbits);
    const imax = Math.min(i + nblock, nx);
    if (fs < 0) {
      for (; i < imax; i++) out[i] = lastpix;
    } else if (fs === fsmax) {
      for (; i < imax; i++) {
        let k = bbits - nbits;
        let diff = b * P(k);
        for (k -= 8; k >= 0; k -= 8) { b = bytes[c++]; diff += b * P(k); }
        if (nbits > 0) {
          b = bytes[c++];
          diff += Math.floor(b / P(-k));
          b = b % P(nbits);
        } else b = 0;
        diff = diff % 4294967296;
        const d = diff % 2 === 1 ? -(diff + 1) / 2 : diff / 2;
        lastpix = (lastpix + d) | 0;
        out[i] = lastpix;
      }
    } else {
      for (; i < imax; i++) {
        while (b === 0) { nbits += 8; b = bytes[c++]; }
        const nzero = nbits - bitLen(b);
        nbits -= nzero + 1;
        b -= P(nbits);
        nbits -= fs;
        while (nbits < 0) { b = b * 256 + bytes[c++]; nbits += 8; }
        const diff = nzero * P(fs) + Math.floor(b / P(nbits));
        b = b % P(nbits);
        const d = diff % 2 === 1 ? -(diff + 1) / 2 : diff / 2;
        lastpix = (lastpix + d) | 0;
        out[i] = lastpix;
      }
    }
    if (c > bytes.length + 1) throw new Error('Rice decode overrun');
  }
  return out;
}

/** Parse a one-row binary table with fixed-size array columns of type J (int32) or E (float32). */
export function parseBinTableRow(header, bytes) {
  const out = {};
  let off = 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let k = 1; k <= header.TFIELDS; k++) {
    const name = header[`TTYPE${k}`];
    const m = String(header[`TFORM${k}`]).match(/^(\d*)([A-Z])/);
    const rep = m[1] ? Number(m[1]) : 1;
    const t = m[2];
    const size = { J: 4, E: 4, D: 8, I: 2, K: 8, B: 1, A: 1 }[t] ?? 4;
    let arr;
    if (t === 'J') { arr = new Int32Array(rep); for (let i = 0; i < rep; i++) arr[i] = dv.getInt32(off + 4 * i, false); }
    else if (t === 'E') { arr = new Float32Array(rep); for (let i = 0; i < rep; i++) arr[i] = dv.getFloat32(off + 4 * i, false); }
    else if (t === 'D') { arr = new Float64Array(rep); for (let i = 0; i < rep; i++) arr[i] = dv.getFloat64(off + 8 * i, false); }
    out[name] = arr;
    off += rep * size;
  }
  return out;
}
