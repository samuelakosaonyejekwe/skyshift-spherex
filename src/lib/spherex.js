// SPHEREx Level 2 spectral-image access over HTTP byte ranges.
// File layout (verified against DR1/QR3 files, pipeline 7.x):
//   HDU0 PRIMARY (no data) | HDU1 IMAGE float32 2040x2040 MJy/sr | HDU2 FLAGS (RICE_1, one row per tile)
//   | HDU3 VARIANCE | HDU4 ZODI | HDU5 EPSF | HDU6 WCS-WAVE (last HDU, tiny)

import { RangeSource, parseHeader, dataSize, beFloat32, riceDecode32, parseBinTableRow } from './fits.js';
import { CelestialWCS, SpectralWCS } from './wcs.js';

export const S3_BASE = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
export const IRSA_BASE = 'https://irsa.ipac.caltech.edu/';
export const BLOCK_ROWS = 8;

/** IRSA IBE path ("ibe/data/spherex/dr1/...") -> public S3 object URL (same relative key). */
export function uriToS3(uri) {
  const rel = String(uri).replace(/^https?:\/\/[^/]+\//, '').replace(/^\/?ibe\/data\/spherex\//, '');
  return S3_BASE + rel;
}
export function uriToIbe(uri) {
  const rel = String(uri).replace(/^https?:\/\/[^/]+\//, '').replace(/^\//, '');
  return IRSA_BASE + rel;
}
/** Parse release, planning period, detector from a SPHEREx file path. */
export function describeUri(uri) {
  const m = String(uri).match(/spherex\/([a-z0-9_]+)\/level2\/([^/]+)\/([^/]+)\/(\d)\/level2_([^/]+?)D(\d)_spx_/i)
    || String(uri).match(/([a-z]+\d)\/level2\/([^/]+)\/([^/]+)\/(\d)\/level2_([^/]+?)D(\d)_spx_/i);
  if (!m) return { release: '?', detector: null };
  return { release: m[1], period: m[2], version: m[3], detector: Number(m[4]), obsid: m[5] };
}

// Detector bands and resolving power as listed on https://irsa.ipac.caltech.edu/Missions/spherex.html and in the
// IRSA SPHEREx tutorials; colours are the Okabe–Ito colour-blind-safe palette.
export const DETECTORS = [
  { id: 1, range: [0.75, 1.09], R: 39, color: '#56b4e9' },
  { id: 2, range: [1.10, 1.62], R: 41, color: '#009e73' },
  { id: 3, range: [1.63, 2.41], R: 41, color: '#f0e442' },
  { id: 4, range: [2.42, 3.82], R: 35, color: '#e69f00' },
  { id: 5, range: [3.83, 4.41], R: 112, color: '#d55e00' },
  { id: 6, range: [4.42, 5.00], R: 128, color: '#cc79a7' },
];

// FLAGS bit definitions as written in the MSKNnnnn/MSKDnnnn keywords of the FLAGS HDU.
export const FLAG_BITS = [
  [0, 'TRANSIENT', 'Transient detected during SUR'],
  [1, 'OVERFLOW', 'Overflow detected during SUR'],
  [2, 'SUR_ERROR', 'Error in onboard processing'],
  [6, 'NONFUNC', 'Permanently unusable'],
  [7, 'DICHROIC', 'Low efficiency due to dichroic'],
  [9, 'MISSING_DATA', 'Onboard data lost'],
  [10, 'HOT', 'Hot pixel'],
  [11, 'COLD', 'Anomalously low signal'],
  [12, 'FULLSAMPLE', 'Pixel full sample history is available'],
  [14, 'PHANMISS', 'Phantom correction was not applied'],
  [15, 'NONLINEAR', 'Nonlinearity correction cannot be applied reliably'],
  [17, 'PERSIST', 'Persistent charge above threshold'],
  [19, 'OUTLIER', 'Pixel flagged by Detect Outliers'],
  [20, 'CROSSTALK', 'Pixel affected by crosstalk'],
  [21, 'SOURCE', 'Pixel mapped to a known source'],
  [22, 'GHOST', 'Affected by a bright source inside the exposure'],
  [23, 'GHOST_FPA', 'Affected by a bright source on another detector'],
  [24, 'GHOST_EXT', 'Pixel affected by a bright source outside FOV'],
  [25, 'STREAK', 'Pixel affected by a streak'],
  [26, 'BLOOM', 'Pixel part of a bloom artifact'],
  [27, 'SNOWBALL', 'Pixel part of a snowball artifact'],
  [28, 'HALO', 'Pixel part of a transient halo'],
];
// Bits treated as "bad" for photometry; follows the bad_flags list of the IRSA
// Source Discovery Tool tutorial (SATELLITE_HALO has no bit in these headers).
export const BAD_FLAG_NAMES = ['TRANSIENT', 'OVERFLOW', 'SUR_ERROR', 'NONFUNC', 'DICHROIC', 'MISSING_DATA', 'HOT', 'COLD',
  'NONLINEAR', 'CROSSTALK', 'GHOST', 'GHOST_FPA', 'GHOST_EXT', 'STREAK', 'PERSIST', 'BLOOM', 'SNOWBALL', 'HALO'];
export const BAD_MASK = FLAG_BITS.filter(([, n]) => BAD_FLAG_NAMES.includes(n)).reduce((m, [b]) => m | (1 << b), 0);
export function decodeFlags(v) { return FLAG_BITS.filter(([b]) => v & (1 << b)).map(([, n]) => n); }

const memo = new Map(); // in-flight request de-duplication

export class SpherexImage {
  /**
   * @param {string} uri IBE path or S3 URL
   * @param {{cache?:{get:Function,set:Function}, fetchImpl?:Function, onBytes?:Function, signal?:AbortSignal}} opts
   */
  constructor(uri, opts = {}) {
    this.uri = uri;
    this.url = /amazonaws\.com/.test(uri) ? uri : uriToS3(uri);
    this.cache = opts.cache || null;
    this.src = new RangeSource(this.url, opts);
  }

  async _cached(key, fn) {
    const k = `${key}|${this.url}`;
    if (this.cache) { const v = await this.cache.get(k); if (v) return v; }
    if (memo.has(k)) return memo.get(k);
    const p = (async () => {
      const v = await fn();
      if (this.cache) await this.cache.set(k, v);
      return v;
    })().finally(() => memo.delete(k));
    memo.set(k, p);
    return p;
  }

  /** Primary + IMAGE headers and IMAGE data offset. */
  async meta() {
    if (this._meta) return this._meta;
    const m = await this._cached('meta', async () => {
      let n = 2880 * 10; // IMAGE header ends near 26 kB in DR1/QR3 files; grows automatically if needed
      for (;;) {
        const bytes = await this.src.get(0, n - 1);
        const p = parseHeader(bytes, 0);
        const im = p && parseHeader(bytes, p.end);
        if (p && im) return { primary: p.header, header: im.header, dataStart: im.end, size: this.src.size };
        if (bytes.length < n) throw new Error('FITS header not found');
        n *= 2;
      }
    });
    this._meta = m;
    this.wcs = new CelestialWCS(m.header);
    return m;
  }

  /** Spectral WCS from the WCS-WAVE table at the end of the file. */
  async wave() {
    if (this._wave) return this._wave;
    const t = await this._cached('wave', async () => {
      const n = 2880 * 6;
      const bytes = await this.src.tail(n);
      for (let off = 0; off + 2880 <= bytes.length; off += 2880) {
        if (bytes[off] !== 88 /* X */) continue;
        const p = parseHeader(bytes, off);
        if (p && p.header.EXTNAME === 'WCS-WAVE') {
          const row = parseBinTableRow(p.header, bytes.subarray(p.end, p.end + p.header.NAXIS1));
          return { X: Array.from(row.X), Y: Array.from(row.Y), VALUES: Array.from(row.VALUES) };
        }
      }
      throw new Error('WCS-WAVE not found');
    });
    this._wave = new SpectralWCS(t);
    return this._wave;
  }

  /** IMAGE rows y0..y1 (1-based, inclusive), full width. Uses aligned 16-row cached blocks. */
  async rows(y0, y1) {
    const m = await this.meta();
    const W = m.header.NAXIS1, H = m.header.NAXIS2;
    y0 = Math.max(1, y0); y1 = Math.min(H, y1);
    const b0 = Math.floor((y0 - 1) / BLOCK_ROWS), b1 = Math.floor((y1 - 1) / BLOCK_ROWS);
    const blocks = await this._blocks('img', b0, b1, async (s, e) => {
      const r0 = s * BLOCK_ROWS, r1 = Math.min(H, (e + 1) * BLOCK_ROWS) - 1; // 0-based rows
      const bytes = await this.src.get(m.dataStart + r0 * W * 4, m.dataStart + (r1 + 1) * W * 4 - 1);
      const all = beFloat32(bytes);
      const out = [];
      for (let b = s; b <= e; b++) {
        const a = (b - s) * BLOCK_ROWS * W;
        out.push(all.slice(a, Math.min(all.length, a + BLOCK_ROWS * W)));
      }
      return out;
    });
    const out = new Float32Array((y1 - y0 + 1) * W);
    for (let y = y0; y <= y1; y++) {
      const b = Math.floor((y - 1) / BLOCK_ROWS), r = (y - 1) % BLOCK_ROWS;
      out.set(blocks[b - b0].subarray(r * W, (r + 1) * W), (y - y0) * W);
    }
    return { y0, y1, width: W, data: out };
  }

  /**
   * Column-precise read: IMAGE pixels x0..x1, y0..y1 (1-based, inclusive), one small range
   * request per row (rotated across hostnames). About 10x less data than whole rows.
   */
  async block(x0, x1, y0, y1) {
    const m = await this.meta();
    const W = m.header.NAXIS1, H = m.header.NAXIS2;
    x0 = Math.max(1, x0); x1 = Math.min(W, x1); y0 = Math.max(1, y0); y1 = Math.min(H, y1);
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    const data = await this._cached(`blk${x0},${x1},${y0},${y1}`, async () => {
      const out = new Float32Array(w * h);
      await Promise.all(Array.from({ length: h }, async (_, k) => {
        const a = m.dataStart + ((y0 - 1 + k) * W + (x0 - 1)) * 4;
        out.set(beFloat32(await this.src.get(a, a + w * 4 - 1)), k * w);
      }));
      return out;
    });
    return { y0, y1, x0, width: w, data };
  }

  async _flagsLayout() {
    if (this._fl) return this._fl;
    const m = await this.meta();
    this._fl = await this._cached('flaghdr', async () => {
      const off = m.dataStart + dataSize(m.header);
      let bytes = await this.src.get(off, off + 2880 * 7 - 1);
      let p = parseHeader(bytes, 0);
      if (!p) { bytes = await this.src.get(off, off + 2880 * 20 - 1); p = parseHeader(bytes, 0); }
      if (!p || p.header.EXTNAME !== 'FLAGS') throw new Error('FLAGS HDU not where expected');
      const h = p.header;
      const dataStart = off + p.end;
      return {
        dataStart, heapStart: dataStart + (h.THEAP ?? h.NAXIS1 * h.NAXIS2),
        width: h.ZNAXIS1, height: h.ZNAXIS2, tileRows: h.ZTILE2 ?? 1, cmp: h.ZCMPTYPE,
        blocksize: h.ZVAL1 ?? 32, rowBytes: h.NAXIS1,
        bits: Object.fromEntries(Object.entries(h).filter(([k]) => /^MSKN\d{4}$/.test(k)).map(([k, v]) => [Number(k.slice(4)), v])),
      };
    });
    return this._fl;
  }

  /** FLAGS rows y0..y1 (1-based), full width, decoded from RICE_1 row tiles. */
  async flagRows(y0, y1) {
    const L = await this._flagsLayout();
    if (L.cmp !== 'RICE_1' || L.tileRows !== 1) throw new Error(`Unsupported FLAGS compression ${L.cmp}`);
    const W = L.width, H = L.height;
    y0 = Math.max(1, y0); y1 = Math.min(H, y1);
    const b0 = Math.floor((y0 - 1) / BLOCK_ROWS), b1 = Math.floor((y1 - 1) / BLOCK_ROWS);
    const blocks = await this._blocks('flg', b0, b1, async (s, e) => {
      const r0 = s * BLOCK_ROWS, r1 = Math.min(H, (e + 1) * BLOCK_ROWS) - 1;
      const desc = await this.src.get(L.dataStart + r0 * L.rowBytes, L.dataStart + (r1 + 1) * L.rowBytes - 1);
      const dv = new DataView(desc.buffer, desc.byteOffset, desc.byteLength);
      const rows = [];
      let lo = Infinity, hi = 0;
      for (let r = 0; r <= r1 - r0; r++) {
        const n = dv.getInt32(r * 8, false), o = dv.getInt32(r * 8 + 4, false);
        rows.push([n, o]); lo = Math.min(lo, o); hi = Math.max(hi, o + n);
      }
      const heap = await this.src.get(L.heapStart + lo, L.heapStart + hi - 1);
      const out = [];
      for (let b = s; b <= e; b++) {
        const arr = new Int32Array(BLOCK_ROWS * W);
        for (let k = 0; k < BLOCK_ROWS; k++) {
          const ri = (b - s) * BLOCK_ROWS + k;
          if (ri >= rows.length) break;
          const [n, o] = rows[ri];
          arr.set(riceDecode32(heap.subarray(o - lo, o - lo + n), W, L.blocksize), k * W);
        }
        out.push(arr);
      }
      return out;
    });
    const out = new Int32Array((y1 - y0 + 1) * W);
    for (let y = y0; y <= y1; y++) {
      const b = Math.floor((y - 1) / BLOCK_ROWS), r = (y - 1) % BLOCK_ROWS;
      out.set(blocks[b - b0].subarray(r * W, (r + 1) * W), (y - y0) * W);
    }
    return { y0, y1, x0: 1, width: W, data: out, bits: L.bits };
  }

  /** Load blocks b0..b1, using cache, fetching contiguous missing runs in single requests. */
  async _blocks(kind, b0, b1, fetchRun) {
    const res = new Array(b1 - b0 + 1);
    const missing = [];
    for (let b = b0; b <= b1; b++) {
      const v = this.cache ? await this.cache.get(`${kind}${b}|${this.url}`) : null;
      if (v) res[b - b0] = v; else missing.push(b);
    }
    const runs = [];
    for (const b of missing) {
      const last = runs[runs.length - 1];
      if (last && last[1] === b - 1) last[1] = b; else runs.push([b, b]);
    }
    await Promise.all(runs.map(async ([s, e]) => {
      const arrs = await fetchRun(s, e);
      for (let b = s; b <= e; b++) {
        res[b - b0] = arrs[b - s];
        if (this.cache) await this.cache.set(`${kind}${b}|${this.url}`, arrs[b - s]);
      }
    }));
    return res;
  }
}

/** Header keywords worth showing as per-frame metadata. */
export const META_KEYS = ['OBSID', 'DETECTOR', 'DATE-AVG', 'MJD-AVG', 'XPOSURE', 'PSF_FWHM', 'L2DQAFLG', 'L1DQAFLG',
  'SPS_FLAGS', 'NON_SURVEY', 'OBS_IN_SBAND', 'HE_AIRGLOW_CONT', 'AURORA_CONT', 'SHUTTLE_GLOW_CONT', 'PXSRCMSK',
  'NSNOWSRC', 'NBLMSRCS', 'L2 SATSTRKS', 'L2 N_PERSIST', 'L2 N_HALO', 'L2 N_SNOWBALL', 'L2 N_GHOST', 'L2 N_XTALK',
  'OMEGA_MEDIAN', 'FINAST', 'ASTRONETSOLVED'];
