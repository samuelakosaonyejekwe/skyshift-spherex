// Imaging engine: resample any SPHEREx exposure onto a common north-up
// tangent-plane grid centred on the target, measure aperture photometry at the
// target, and summarise flags. Runs inside a Web Worker (and in Node for tests).

import { BAD_MASK, FLAG_BITS, META_KEYS, describeUri } from './spherex.js';
import { apparent } from './coords.js';
import { interpEph } from './ephem.js';

const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const NATIVE_SCALE = 6.15; // arcsec / pixel (SPHEREx spectral image pixel)
export const MAX_GRID = 360;
const ARCSEC2_TO_SR = (Math.PI / 180 / 3600) ** 2;

/** Output grid: n x n pixels, scale arcsec/px, north up, east left. */
export function makeGrid(ra, dec, fovArcmin, maxN = MAX_GRID) {
  const fov = Math.max(0.5, fovArcmin) * 60;
  let scale = NATIVE_SCALE;
  let n = Math.round(fov / scale);
  if (n > maxN) { n = maxN; scale = fov / n; }
  n = Math.max(9, n | 1);
  return { ra, dec, n, scale, fovArcmin };
}

/** Sky position of grid pixel (i column, j row from top), optionally around a shifted centre. */
export function gridToWorld(g, i, j, cra = g.ra, cdec = g.dec) {
  const c = (g.n - 1) / 2;
  const xi = -(i - c) * g.scale / 3600 * D2R;
  const eta = (c - j) * g.scale / 3600 * D2R;
  const rho = Math.hypot(xi, eta);
  if (!rho) return [cra, cdec];
  const d0 = cdec * D2R, cc = Math.cos(Math.atan(rho)), sc = Math.sin(Math.atan(rho));
  const dec = Math.asin(cc * Math.sin(d0) + (eta * sc * Math.cos(d0)) / rho);
  const ra = cra * D2R + Math.atan2(xi * sc, rho * Math.cos(d0) * cc - eta * Math.sin(d0) * sc);
  return [(((ra * R2D) % 360) + 360) % 360, dec * R2D];
}

/** Grid pixel (fractional) of a sky position. */
export function worldToGrid(g, ra, dec, cra = g.ra, cdec = g.dec) {
  const d0 = cdec * D2R, da = (ra - cra) * D2R, d = dec * D2R;
  const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
  const xi = (Math.cos(d) * Math.sin(da)) / cosc * R2D * 3600;
  const eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc * R2D * 3600;
  const c = (g.n - 1) / 2;
  return [c - xi / g.scale, c - eta / g.scale];
}

/** Coarse mapping grid -> source pixel, interpolated (mapping is smooth). */
function buildMapping(g, wcs, cra, cdec) {
  const step = 8;
  const m = Math.ceil((g.n - 1) / step) + 1;
  const MX = new Float64Array(m * m), MY = new Float64Array(m * m);
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (let b = 0; b < m; b++) {
    for (let a = 0; a < m; a++) {
      const i = Math.min(g.n - 1, a * step), j = Math.min(g.n - 1, b * step);
      const [ra, dec] = gridToWorld(g, i, j, cra, cdec);
      const [x, y] = wcs.worldToPix(ra, dec);
      MX[b * m + a] = x; MY[b * m + a] = y;
      if (Number.isFinite(x)) { xmin = Math.min(xmin, x); xmax = Math.max(xmax, x); ymin = Math.min(ymin, y); ymax = Math.max(ymax, y); }
    }
  }
  const at = (i, j) => {
    const fa = i / step, fb = j / step;
    const a = Math.min(m - 2, Math.floor(fa)), b = Math.min(m - 2, Math.floor(fb));
    // last coarse node may sit at n-1 rather than a*step
    const ia0 = a * step, ia1 = Math.min(g.n - 1, (a + 1) * step);
    const jb0 = b * step, jb1 = Math.min(g.n - 1, (b + 1) * step);
    const tx = ia1 > ia0 ? (i - ia0) / (ia1 - ia0) : 0;
    const ty = jb1 > jb0 ? (j - jb0) / (jb1 - jb0) : 0;
    const k00 = b * m + a, k10 = k00 + 1, k01 = k00 + m, k11 = k01 + 1;
    return [
      (1 - tx) * (1 - ty) * MX[k00] + tx * (1 - ty) * MX[k10] + (1 - tx) * ty * MX[k01] + tx * ty * MX[k11],
      (1 - tx) * (1 - ty) * MY[k00] + tx * (1 - ty) * MY[k10] + (1 - tx) * ty * MY[k01] + tx * ty * MY[k11],
    ];
  };
  return { at, bbox: [xmin, xmax, ymin, ymax] };
}

function median(arr) {
  if (!arr.length) return NaN;
  const a = Float64Array.from(arr).sort();
  const k = a.length >> 1;
  return a.length % 2 ? a[k] : 0.5 * (a[k - 1] + a[k]);
}

/** Robust background (median) and noise (1.4826 * MAD) of finite values. */
export function robustStats(data, sampleMax = 6000) {
  const vals = [];
  const stride = Math.max(1, Math.floor(data.length / sampleMax));
  for (let i = 0; i < data.length; i += stride) { const v = data[i]; if (Number.isFinite(v)) vals.push(v); }
  const med = median(vals);
  const mad = median(vals.map((v) => Math.abs(v - med)));
  return { median: med, sigma: 1.4826 * mad || 1e-6, n: vals.length };
}

/**
 * Aperture photometry in native pixels at FITS pixel (x, y).
 * rows: {y0, width, data}; flags optional (same geometry). Returns µJy.
 */
export function photometry(rows, flags, x, y, omegaArcsec2, { rAp = 2.5, rIn = 5, rOut = 8 } = {}) {
  const val = (xx, yy) => {
    const ry = yy - rows.y0, rx = xx - (rows.x0 || 1);
    if (ry < 0 || rx < 0 || rx >= rows.width || ry >= rows.data.length / rows.width) return undefined;
    return rows.data[ry * rows.width + rx];
  };
  const flg = (xx, yy) => {
    if (!flags) return 0;
    const ry = yy - flags.y0, rx = xx - (flags.x0 || 1);
    if (ry < 0 || rx < 0 || rx >= flags.width || ry >= flags.data.length / flags.width) return 0;
    return flags.data[ry * flags.width + rx];
  };
  const ap = [], ann = [], annSrc = [];
  let nbad = 0, nap = 0, flagOr = 0;
  const xr = Math.round(x), yr = Math.round(y);
  for (let yy = yr - rOut; yy <= yr + rOut; yy++) {
    for (let xx = xr - rOut; xx <= xr + rOut; xx++) {
      const v = val(xx, yy);
      if (v === undefined) continue;
      const r = Math.hypot(xx - x, yy - y);
      const f = flg(xx, yy);
      if (r <= rAp) {
        nap++; flagOr |= f;
        if (!Number.isFinite(v) || (f & BAD_MASK)) { nbad++; continue; }
        ap.push(v);
      } else if (r >= rIn && r <= rOut && Number.isFinite(v) && !(f & BAD_MASK)) (f & (1 << 21) ? annSrc : ann).push(v);
    }
  }
  // Crowded fields can have most pixels flagged SOURCE; then use all good annulus pixels.
  if (ann.length < 12) ann.push(...annSrc);
  if (!nap || ap.length < Math.max(1, nap * 0.5) || ann.length < 8) return null;
  const bkg = median(ann);
  const sig = 1.4826 * median(ann.map((v) => Math.abs(v - bkg)));
  let sum = 0;
  for (const v of ap) sum += v - bkg;
  sum *= nap / ap.length; // correct for masked pixels
  const toUJy = 1e12 * omegaArcsec2 * ARCSEC2_TO_SR; // MJy/sr * sr -> µJy
  return {
    flux: sum * toUJy,
    err: sig * Math.sqrt(nap) * Math.sqrt(1 + nap / ann.length) * toUJy,
    bkg, nbad, nap, flags: flagOr,
  };
}

/**
 * Render one exposure onto the grid.
 * @returns {Promise<null | {data, flags, meta, phot}>}
 */
export async function renderExposure(img, grid, rec, opts = {}) {
  const { withFlags = true, track = null, phot = true, photTrack = null, readMode = 'fast' } = opts;
  const m = await img.meta();
  const wcs = img.wcs;
  const H = m.header.NAXIS2, W = m.header.NAXIS1;
  const mjd = m.header['MJD-AVG'] ?? rec.mjd;
  let cra = grid.ra, cdec = grid.dec;
  if (track?.eph) {
    // a Solar System object: its position at this exposure's time, from the user's table (outside it: skipped)
    const p = interpEph(track.eph, mjd);
    if (!p) return null;
    cra = p.ra; cdec = p.dec;
  } else if (track && (track.pmra || track.pmdec || track.plx)) {
    const p = apparent(grid.ra, grid.dec, track.pmra, track.pmdec, track.plx, track.refYear, mjd);
    cra = p.ra; cdec = p.dec;
  }
  const map = buildMapping(grid, wcs, cra, cdec);
  const [xmin, xmax, ymin, ymax] = map.bbox;
  // photometry follows the target's predicted position (proper motion) when known
  let pra = cra, pdec = cdec;
  if (photTrack?.eph) {
    const p = interpEph(photTrack.eph, mjd);
    if (p) { pra = p.ra; pdec = p.dec; }
  } else if (photTrack && (photTrack.pmra || photTrack.pmdec || photTrack.plx)) {
    const p = apparent(grid.ra, grid.dec, photTrack.pmra, photTrack.pmdec, photTrack.plx, photTrack.refYear, mjd);
    pra = p.ra; pdec = p.dec;
  }
  const [tx, ty] = wcs.worldToPix(pra, pdec);
  if (!(xmax >= 1 && xmin <= W && ymax >= 1 && ymin <= H)) return null;
  const pad = 11;
  const y0 = Math.max(1, Math.floor(Math.min(ymin, ty) - pad)), y1 = Math.min(H, Math.ceil(Math.max(ymax, ty) + pad));
  // withFlags: 'field' (map flags over the whole cutout) | 'target' (only rows needed for photometry) | false
  const flagMode = withFlags === true ? 'field' : withFlags;
  const fy0 = flagMode === 'target' ? Math.max(1, Math.floor(ty) - 8) : y0;
  const fy1 = flagMode === 'target' ? Math.min(H, Math.ceil(ty) + 8) : y1;
  const x0 = Math.max(1, Math.floor(Math.min(xmin, tx) - pad)), x1 = Math.min(W, Math.ceil(Math.max(xmax, tx) + pad));
  const [rows, flagsRaw, wave] = await Promise.all([
    readMode === 'saver' ? img.block(x0, x1, y0, y1) : img.rows(y0, y1),
    flagMode && Number.isFinite(ty) && fy1 >= fy0 ? img.flagRows(fy0, fy1).catch(() => null) : Promise.resolve(null),
    img.wave().catch(() => null),
  ]);
  const flags = flagsRaw ? { ...flagsRaw, partial: flagMode === 'target' } : null;
  const n = grid.n;
  const out = new Float32Array(n * n).fill(NaN);
  const fout = flags && !flags.partial ? new Int32Array(n * n) : null;
  const f = grid.scale / NATIVE_SCALE;
  const sub = f > 1.5 ? Math.min(4, Math.round(f)) : 1;
  const RW = rows.width, RX = rows.x0 || 1;
  const nrow = rows.data.length / RW;
  const sample = (x, y) => {
    // bilinear on 1-based pixel coords, within the fetched window
    const xa = Math.floor(x), yb = Math.floor(y);
    if (xa < RX || xa >= RX + RW - 1 || yb < rows.y0 || yb >= rows.y0 + nrow - 1) return NaN;
    const ax = x - xa, ay = y - yb;
    const k = (yb - rows.y0) * RW + (xa - RX);
    const v00 = rows.data[k], v10 = rows.data[k + 1], v01 = rows.data[k + RW], v11 = rows.data[k + RW + 1];
    const v = (1 - ax) * (1 - ay) * v00 + ax * (1 - ay) * v10 + (1 - ax) * ay * v01 + ax * ay * v11;
    if (Number.isFinite(v)) return v;
    const nn = rows.data[(Math.round(y) - rows.y0) * RW + (Math.round(x) - RX)];
    return Number.isFinite(nn) ? nn : NaN;
  };
  const fnrow = flags ? flags.data.length / flags.width : 0;
  const flagCounts = new Map();
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      let acc = 0, cnt = 0;
      for (let sj = 0; sj < sub; sj++) {
        for (let si = 0; si < sub; si++) {
          const ii = i + (si + 0.5) / sub - 0.5, jj = j + (sj + 0.5) / sub - 0.5;
          const [x, y] = sub === 1 ? map.at(i, j) : map.at(Math.max(0, Math.min(n - 1, ii)), Math.max(0, Math.min(n - 1, jj)));
          const v = sample(x, y);
          if (Number.isFinite(v)) { acc += v; cnt++; }
        }
      }
      const k = j * n + i;
      if (cnt) out[k] = acc / cnt;
      if (fout) {
        const [x, y] = map.at(i, j);
        const xr = Math.round(x), yr = Math.round(y) - flags.y0;
        if (xr >= 1 && xr <= W && yr >= 0 && yr < fnrow) {
          const fv = flags.data[yr * flags.width + xr - 1];
          fout[k] = fv;
          if (fv) for (const [b] of FLAG_BITS) if (fv & (1 << b)) flagCounts.set(b, (flagCounts.get(b) || 0) + 1);
        }
      }
    }
  }
  const stats = robustStats(out);
  const spec = wave && Number.isFinite(tx) ? wave.at(tx, ty) : null;
  const header = {};
  for (const k of META_KEYS) if (m.header[k] !== undefined) header[k] = m.header[k];
  header.VERSION = m.primary.VERSION;
  const omega = m.header.OMEGA_MEDIAN || NATIVE_SCALE ** 2;
  const ph = phot && Number.isFinite(tx) ? photometry(rows, flags, tx, ty, omega) : null;
  const inside = tx >= 1 && tx <= W && ty >= 1 && ty <= H;
  // saturation: NaN pixels within 2 grid px of the (tracked) centre
  let satur = 0;
  const [gi, gj] = worldToGrid(grid, pra, pdec, cra, cdec);
  for (let j = Math.floor(gj - 2); j <= Math.ceil(gj + 2); j++) for (let i = Math.floor(gi - 2); i <= Math.ceil(gi + 2); i++) {
    if (i >= 0 && j >= 0 && i < n && j < n && !Number.isFinite(out[j * n + i])) satur++;
  }
  return {
    data: out, flags: fout,
    phot: ph,
    meta: {
      uri: rec.uri, mjd, detector: m.header.DETECTOR ?? describeUri(rec.uri).detector,
      release: describeUri(rec.uri).release, obsid: m.header.OBSID,
      wavelength: spec?.wavelength ?? null, bandwidth: spec?.bandwidth ?? null,
      targetPixel: inside ? [tx, ty] : null, center: [cra, cdec], photPos: [pra, pdec],
      bg: stats.median, sigma: stats.sigma, coverage: stats.n,
      flagCounts: fout ? Object.fromEntries(flagCounts) : null, header,
      rowsFetched: y1 - y0 + 1, readMode, saturated: inside && satur > 2,
    },
  };
}

/** Photometry at an arbitrary sky position for one exposure (used for click-spectra). */
export async function photAt(img, ra, dec, withFlags = true) {
  const m = await img.meta();
  const [x, y] = img.wcs.worldToPix(ra, dec);
  const H = m.header.NAXIS2, W = m.header.NAXIS1;
  if (!(x >= 1 && x <= W && y >= 1 && y <= H)) return null;
  const y0 = Math.max(1, Math.floor(y) - 12), y1 = Math.min(H, Math.ceil(y) + 12);
  const [rows, flags, wave] = await Promise.all([
    img.rows(y0, y1), withFlags ? img.flagRows(y0, y1).catch(() => null) : null, img.wave().catch(() => null),
  ]);
  const p = photometry(rows, flags, x, y, m.header.OMEGA_MEDIAN || NATIVE_SCALE ** 2);
  if (!p) return null;
  const s = wave ? wave.at(x, y) : null;
  return { ...p, wavelength: s?.wavelength, bandwidth: s?.bandwidth, mjd: m.header['MJD-AVG'], detector: m.header.DETECTOR };
}

/** Bytes a cutout of this field costs per exposure (header + tail + rows + flags). */
export function estimateBytesPerExposure(fovArcmin, flagMode = 'target', readMode = 'saver') {
  // rows/columns spanned by a rotated square field, plus photometry padding
  const span = Math.ceil((fovArcmin * 60 * 1.42) / NATIVE_SCALE) + 22;
  const image = readMode === 'saver' ? span * (span * 4 + 900) : (span + 8) * 2040 * 4;
  const flagRows = flagMode === 'field' ? span + 8 : flagMode === 'target' ? 22 : 0;
  return 28800 + 17280 + image + (flagMode ? 20160 + 512 + flagRows * 5200 : 0);
}
