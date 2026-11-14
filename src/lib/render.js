// Frame grouping, co-adding, differencing and display (stretch + colour maps).
// All arithmetic is on background-subtracted surface brightness (MJy/sr).

export const SURVEY_GAP_DAYS = 30; // a new six-month survey pass starts after a gap longer than this
export const DAY_GAP_DAYS = 1;

/** Cluster exposures (sorted by mjd) into display groups. */
export function groupExposures(exps, mode) {
  const sorted = [...exps].sort((a, b) => a.meta.mjd - b.meta.mjd);
  if (mode === 'exposure') return sorted.map((e) => [e]);
  const gap = mode === 'day' ? DAY_GAP_DAYS : SURVEY_GAP_DAYS;
  const groups = [];
  let cur = [];
  for (const e of sorted) {
    if (cur.length && e.meta.mjd - cur[cur.length - 1].meta.mjd > gap) { groups.push(cur); cur = []; }
    cur.push(e);
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Inverse-variance weighted, NaN-aware mean of background-subtracted frames. */
export function coadd(exps, n) {
  const sum = new Float64Array(n * n), wsum = new Float64Array(n * n);
  for (const e of exps) {
    const w = 1 / Math.max(1e-12, e.meta.sigma) ** 2;
    const bg = e.meta.bg || 0;
    const d = e.data;
    for (let k = 0; k < d.length; k++) {
      const v = d[k];
      if (Number.isFinite(v)) { sum[k] += (v - bg) * w; wsum[k] += w; }
    }
  }
  const out = new Float32Array(n * n);
  for (let k = 0; k < out.length; k++) out[k] = wsum[k] ? sum[k] / wsum[k] : NaN;
  return out;
}

/** Per-detector co-adds of one group: Map(det -> Float32Array). */
export function perDetector(exps, n) {
  const by = new Map();
  for (const e of exps) {
    const d = e.meta.detector;
    if (!by.has(d)) by.set(d, []);
    by.get(d).push(e);
  }
  const out = new Map();
  for (const [d, list] of by) out.set(d, coadd(list, n));
  return out;
}

/** Equal-weight average of per-detector co-adds (each array contributes equally). */
export function detectorBalanced(dmap, n, dets = null) {
  const keys = [...dmap.keys()].filter((d) => !dets || dets.includes(d));
  const out = new Float32Array(n * n).fill(NaN);
  if (!keys.length) return out;
  for (let k = 0; k < out.length; k++) {
    let s = 0, c = 0;
    for (const d of keys) { const v = dmap.get(d)[k]; if (Number.isFinite(v)) { s += v; c++; } }
    if (c) out[k] = s / c;
  }
  return out;
}

/** Wavelength-matched difference: mean over detectors present in both of (A_d − B_d). */
export function matchedDifference(a, b, n) {
  const common = [...a.keys()].filter((d) => b.has(d));
  const out = new Float32Array(n * n).fill(NaN);
  if (!common.length) return { data: out, dets: [] };
  for (let k = 0; k < out.length; k++) {
    let s = 0, c = 0;
    for (const d of common) {
      const v = a.get(d)[k] - b.get(d)[k];
      if (Number.isFinite(v)) { s += v; c++; }
    }
    if (c) out[k] = s / c;
  }
  return { data: out, dets: common };
}

/** Average of several detector maps (reference epoch built from many groups). */
export function meanOfMaps(maps, n) {
  const acc = new Map();
  for (const m of maps) {
    for (const [d, arr] of m) {
      if (!acc.has(d)) acc.set(d, { s: new Float64Array(n * n), c: new Uint16Array(n * n) });
      const a = acc.get(d);
      for (let k = 0; k < arr.length; k++) if (Number.isFinite(arr[k])) { a.s[k] += arr[k]; a.c[k]++; }
    }
  }
  const out = new Map();
  for (const [d, { s, c }] of acc) {
    const f = new Float32Array(n * n);
    for (let k = 0; k < f.length; k++) f[k] = c[k] ? s[k] / c[k] : NaN;
    out.set(d, f);
  }
  return out;
}

/** Percentile limits from a sample of finite values across frames. */
export function limits(frames, lo, hi, symmetric = false) {
  const vals = [];
  for (const f of frames) {
    const stride = Math.max(1, Math.floor(f.length / 20000));
    for (let k = 0; k < f.length; k += stride) { const v = f[k]; if (Number.isFinite(v)) vals.push(symmetric ? Math.abs(v) : v); }
  }
  if (!vals.length) return [0, 1];
  vals.sort((a, b) => a - b);
  const q = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((p / 100) * (vals.length - 1))))];
  if (symmetric) { const m = q(hi) || 1e-6; return [-m, m]; }
  let a = q(lo), b = q(hi);
  if (!(b > a)) b = a + 1e-6;
  return [a, b];
}

const STRETCH = {
  linear: (x) => x,
  sqrt: (x) => Math.sqrt(x),
  log: (x) => Math.log10(1 + 999 * x) / 3,
  asinh: (x) => Math.asinh(10 * x) / Math.asinh(10),
};

function lerpStops(stops, t) {
  const n = stops.length - 1;
  const x = Math.min(n - 1e-9, Math.max(0, t * n));
  const i = Math.floor(x), f = x - i;
  return stops[i].map((c, k) => c + (stops[i + 1][k] - c) * f);
}
const CMAP_STOPS = {
  gray: [[0, 0, 0], [255, 255, 255]],
  heat: [[0, 0, 0], [120, 20, 10], [230, 90, 20], [255, 210, 80], [255, 255, 255]],
  ice: [[0, 0, 0], [20, 40, 110], [40, 140, 210], [150, 230, 255], [255, 255, 255]],
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
};
const LUTS = {};
export function lut(name) {
  if (LUTS[name]) return LUTS[name];
  const stops = CMAP_STOPS[name] || CMAP_STOPS.gray;
  const l = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) { const c = lerpStops(stops, i / 255); l[i * 3] = c[0]; l[i * 3 + 1] = c[1]; l[i * 3 + 2] = c[2]; }
  return (LUTS[name] = l);
}
export const NAN_RGB = [38, 24, 64]; // saturated / no data

/** Single-channel frame -> RGBA pixels. */
export function paint(data, out, [a, b], { stretch = 'asinh', cmap = 'gray', invert = false } = {}) {
  const L = lut(cmap), fn = STRETCH[stretch] || STRETCH.asinh;
  const scale = 1 / (b - a);
  for (let k = 0; k < data.length; k++) {
    const v = data[k];
    const o = k * 4;
    if (!Number.isFinite(v)) { out[o] = NAN_RGB[0]; out[o + 1] = NAN_RGB[1]; out[o + 2] = NAN_RGB[2]; out[o + 3] = 255; continue; }
    let t = (v - a) * scale;
    t = t <= 0 ? 0 : t >= 1 ? 1 : fn(t);
    if (invert) t = 1 - t;
    const i = (t * 255) | 0;
    out[o] = L[i * 3]; out[o + 1] = L[i * 3 + 1]; out[o + 2] = L[i * 3 + 2]; out[o + 3] = 255;
  }
}

/** Diverging paint for difference images (blue negative, white zero... or gray for WiseView-like look). */
export function paintDiff(data, out, [a, b], { invert = false } = {}) {
  const m = Math.max(Math.abs(a), Math.abs(b)) || 1;
  for (let k = 0; k < data.length; k++) {
    const v = data[k], o = k * 4;
    if (!Number.isFinite(v)) { out[o] = NAN_RGB[0]; out[o + 1] = NAN_RGB[1]; out[o + 2] = NAN_RGB[2]; out[o + 3] = 255; continue; }
    let t = Math.asinh(5 * Math.max(-1, Math.min(1, v / m))) / Math.asinh(5); // -1..1
    if (invert) t = -t;
    const g = 128 + 127 * t;
    out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
  }
}

/** False-colour composite from three channels (each with own limits). */
export function paintRGB(chs, out, lims, { stretch = 'asinh' } = {}) {
  const fn = STRETCH[stretch] || STRETCH.asinh;
  const n = chs[0].length;
  for (let k = 0; k < n; k++) {
    const o = k * 4;
    let any = false;
    for (let c = 0; c < 3; c++) {
      const v = chs[c][k];
      if (!Number.isFinite(v)) { out[o + c] = 0; continue; }
      any = true;
      const [a, b] = lims[c];
      let t = (v - a) / (b - a);
      t = t <= 0 ? 0 : t >= 1 ? 1 : fn(t);
      out[o + c] = t * 255;
    }
    if (!any) { out[o] = NAN_RGB[0]; out[o + 1] = NAN_RGB[1]; out[o + 2] = NAN_RGB[2]; }
    out[o + 3] = 255;
  }
}

/**
 * Smooth display upsampling (separable Catmull-Rom bicubic) of an RGBA image n x n by factor f.
 * Used only for display: measurements always use the original pixels.
 */
export function upsampleRGBA(src, n, f) {
  if (f <= 1) return { data: src, size: n };
  const m = n * f;
  const w = (t) => { const a = Math.abs(t); return a < 1 ? 1.5 * a ** 3 - 2.5 * a ** 2 + 1 : a < 2 ? -0.5 * a ** 3 + 2.5 * a ** 2 - 4 * a + 2 : 0; };
  // precompute taps for one axis
  const taps = new Array(m);
  for (let o = 0; o < m; o++) {
    const x = (o + 0.5) / f - 0.5, x0 = Math.floor(x);
    const ws = [], idx = [];
    let sum = 0;
    for (let k = -1; k <= 2; k++) { const wk = w(x - (x0 + k)); ws.push(wk); idx.push(Math.min(n - 1, Math.max(0, x0 + k))); sum += wk; }
    taps[o] = { idx, ws: ws.map((v) => v / sum) };
  }
  const tmp = new Float32Array(m * n * 4);
  for (let y = 0; y < n; y++) {
    for (let o = 0; o < m; o++) {
      const { idx, ws } = taps[o];
      for (let c = 0; c < 4; c++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += ws[k] * src[(y * n + idx[k]) * 4 + c];
        tmp[(y * m + o) * 4 + c] = v;
      }
    }
  }
  const out = new Uint8ClampedArray(m * m * 4);
  for (let o = 0; o < m; o++) {
    const { idx, ws } = taps[o];
    for (let x = 0; x < m; x++) {
      for (let c = 0; c < 4; c++) {
        let v = 0;
        for (let k = 0; k < 4; k++) v += ws[k] * tmp[(idx[k] * m + x) * 4 + c];
        out[(o * m + x) * 4 + c] = v;
      }
    }
  }
  return { data: out, size: m };
}
