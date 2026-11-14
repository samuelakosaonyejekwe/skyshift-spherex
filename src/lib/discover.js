// Discovery aids. They point at things worth checking; results are always candidates.

import { detectorBalanced, matchedDifference, SURVEY_GAP_DAYS } from './render.js';
import { robustStats } from './engine.js';
import { gridToWorld } from './engine.js';
import { mjdToYear } from './coords.js';
import { BAD_MASK } from './spherex.js';

function peaks(img, n, nsig = 5) {
  const st = robustStats(img, 20000);
  const thr = st.median + nsig * st.sigma;
  const out = [];
  for (let j = 2; j < n - 2; j++) {
    for (let i = 2; i < n - 2; i++) {
      const v = img[j * n + i];
      if (!(v > thr)) continue;
      let isMax = true;
      for (let dj = -1; dj <= 1 && isMax; dj++) for (let di = -1; di <= 1; di++) {
        if ((di || dj) && !(img[(j + dj) * n + i + di] < v)) { if (img[(j + dj) * n + i + di] === v && (dj < 0 || (dj === 0 && di < 0))) continue; if (img[(j + dj) * n + i + di] >= v) { isMax = false; break; } }
      }
      if (!isMax) continue;
      // 3x3 flux-weighted centroid and sum
      let sx = 0, sy = 0, s = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const w = Math.max(0, img[(j + dj) * n + i + di] - st.median);
        if (Number.isFinite(w)) { sx += w * (i + di); sy += w * (j + dj); s += w; }
      }
      if (s > 0) out.push({ x: sx / s, y: sy / s, i, j, flux: s, snr: (v - st.median) / st.sigma });
    }
  }
  return { list: out, sigma: st.sigma, median: st.median };
}

function badFraction(group, k) {
  let bad = 0, tot = 0;
  for (const e of group) { if (!e.flags) continue; tot++; if (e.flags[k] & BAD_MASK) bad++; }
  return tot ? bad / tot : 0;
}
/** Peak seen above 3σ in at least two individual exposures (rejects cosmic rays and one-off artefacts). */
function persistent(group, k) {
  if (group.length < 2) return true;
  let c = 0;
  for (const e of group) { const v = e.data[k] - (e.meta.bg || 0); if (v > 3 * e.meta.sigma) c++; }
  return c >= 2;
}

const meanMjd = (g) => g.reduce((a, e) => a + e.meta.mjd, 0) / g.length;

export function findMovers(display, n, grid, req, centre = [grid.ra, grid.dec]) {
  const D = display;
  if (!D?.dmaps || D.groups.length < 2) return [];
  const ia = 0, ib = D.groups.length - 1;
  const common = [...D.dmaps[ia].keys()].filter((d) => D.dmaps[ib].has(d));
  if (!common.length) return [];
  const A = detectorBalanced(D.dmaps[ia], n, common), B = detectorBalanced(D.dmaps[ib], n, common);
  const pa = peaks(A, n), pb = peaks(B, n);
  const gA = D.groups[ia], gB = D.groups[ib];
  const keep = (p, g) => badFraction(g, p.j * n + p.i) < 0.5 && persistent(g, p.j * n + p.i);
  const la = pa.list.filter((p) => keep(p, gA)), lb = pb.list.filter((p) => keep(p, gB));
  const stationary = (p, list) => list.some((q) => Math.hypot(p.x - q.x, p.y - q.y) < 0.5);
  const ua = la.filter((p) => !stationary(p, lb)), ub = lb.filter((p) => !stationary(p, la));
  const dtYr = Math.max(1e-3, mjdToYear(meanMjd(gB)) - mjdToYear(meanMjd(gA)));
  const maxShift = Math.max(2, Math.min(12, n / 4));
  const used = new Set();
  const out = [];
  for (const p of ua.sort((x, y) => y.snr - x.snr)) {
    let best = null;
    for (const [k, q] of ub.entries()) {
      if (used.has(k)) continue;
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      const ratio = q.flux / p.flux;
      if (d >= 0.5 && d <= maxShift && ratio > 0.5 && ratio < 2 && (!best || d < best.d)) best = { k, q, d };
    }
    if (!best) continue;
    // the object must have left its old place and arrived at the new one
    const vacated = B[p.j * n + p.i] < A[p.j * n + p.i] * 0.7;
    const arrived = A[best.q.j * n + best.q.i] < B[best.q.j * n + best.q.i] * 0.7;
    if (!vacated || !arrived) continue;
    used.add(best.k);
    const shift = best.d * grid.scale;
    // position angle east of north: grid x grows west, y grows south
    const pa = ((Math.atan2(-(best.q.x - p.x), -(best.q.y - p.y)) * 180) / Math.PI + 360) % 360;
    const [ra, dec] = gridToWorld(grid, best.q.x, best.q.y, centre[0], centre[1]);
    out.push({ a: [p.x, p.y], b: [best.q.x, best.q.y], shift, rate: shift / dtYr, pa, snr: Math.min(p.snr, best.q.snr), ra, dec });
  }
  return out.slice(0, 25);
}

export function findVariables(display, n, grid, centre = [grid?.ra, grid?.dec]) {
  const D = display;
  if (!D?.dmaps || D.groups.length < 2) return [];
  const ia = 0, ib = D.groups.length - 1;
  const diff = matchedDifference(D.dmaps[ib], D.dmaps[ia], n);
  if (!diff.dets.length) return [];
  const st = robustStats(diff.data, 20000);
  const out = [];
  const abs = Float32Array.from(diff.data, (v) => (Number.isFinite(v) ? Math.abs(v - st.median) : NaN));
  const pk = peaks(abs, n, 5).list;
  const gA = D.groups[ia], gB = D.groups[ib];
  for (const p of pk) {
    const k = p.j * n + p.i;
    if (badFraction(gA, k) >= 0.5 || badFraction(gB, k) >= 0.5) continue;
    // reject dipoles (movers): opposite-sign residual within 3 px
    let opp = false;
    const sign = Math.sign(diff.data[k] - st.median);
    for (let dj = -3; dj <= 3 && !opp; dj++) for (let di = -3; di <= 3; di++) {
      const jj = p.j + dj, ii = p.i + di;
      if (jj < 0 || ii < 0 || jj >= n || ii >= n) continue; // stay inside the frame (no wrap into the next row)
      const kk = jj * n + ii;
      if ((di || dj) && Math.sign(diff.data[kk] - st.median) === -sign && Math.abs(diff.data[kk] - st.median) > 3 * st.sigma) { opp = true; break; }
    }
    if (opp) continue;
    const [ra, dec] = grid ? gridToWorld(grid, p.x, p.y, centre[0], centre[1]) : [null, null];
    out.push({ at: [p.x, p.y], snr: p.snr, sign, ra, dec });
  }
  return out.slice(0, 25);
}

/**
 * Relative brightness against the mean spectrum, per survey pass, plus the largest
 * change between passes with its uncertainty.
 */
/** A measurement is questionable when its core is saturated or more than 20% of the aperture is masked. */
export function questionable(p) {
  return !!p.saturated || (p.nap > 0 && p.nbad / p.nap > 0.2);
}

export function epochBrightness(pts) {
  const good = pts.filter((p) => Number.isFinite(p.flux) && p.flux > 0 && !questionable(p) && Number.isFinite(p.wavelength));
  if (good.length < 4) return { points: pts.map((p) => ({ ...p, rel: NaN, relErr: NaN })), epochs: [], change: null };
  // spectral template: median flux in log-wavelength bins
  const NB = 36, l0 = Math.log(0.74), l1 = Math.log(5.02);
  const bins = Array.from({ length: NB }, () => []);
  for (const p of good) bins[Math.min(NB - 1, Math.max(0, Math.floor(((Math.log(p.wavelength) - l0) / (l1 - l0)) * NB)))].push(p.flux);
  const med = bins.map((b) => (b.length ? b.slice().sort((x, y) => x - y)[b.length >> 1] : NaN));
  const centre = (k) => Math.exp(l0 + ((k + 0.5) / NB) * (l1 - l0));
  const tmpl = (wl) => {
    const x = ((Math.log(wl) - l0) / (l1 - l0)) * NB - 0.5;
    let lo = Math.floor(x), hi = lo + 1;
    while (lo >= 0 && !Number.isFinite(med[lo])) lo--;
    while (hi < NB && !Number.isFinite(med[hi])) hi++;
    if (lo < 0 && hi >= NB) return NaN;
    if (lo < 0) return med[hi];
    if (hi >= NB) return med[lo];
    const t = (Math.log(wl) - Math.log(centre(lo))) / (Math.log(centre(hi)) - Math.log(centre(lo)));
    return med[lo] + (med[hi] - med[lo]) * Math.min(1, Math.max(0, t));
  };
  const points = pts.map((p) => { const t = tmpl(p.wavelength); return { ...p, rel: p.flux / t, relErr: p.err / Math.abs(t) }; });
  // survey passes
  const goodSet = new Set(good);
  const usable = points.filter((p, k) => goodSet.has(pts[k]) && Number.isFinite(p.rel)).sort((a, b) => a.mjd - b.mjd);
  const groups = [];
  for (const p of usable) {
    const g = groups[groups.length - 1];
    if (g && p.mjd - g[g.length - 1].mjd <= SURVEY_GAP_DAYS) g.push(p); else groups.push([p]);
  }
  const epochs = groups.filter((g) => g.length >= 3).map((g) => {
    const v = g.map((p) => p.rel).sort((a, b) => a - b);
    const m = v[v.length >> 1];
    const mad = v.map((x) => Math.abs(x - m)).sort((a, b) => a - b)[v.length >> 1] * 1.4826;
    return { mean: m, err: (mad || 0.01) / Math.sqrt(v.length) * 1.25, n: v.length, t0: g[0].mjd, t1: g[g.length - 1].mjd };
  });
  let change = null;
  if (epochs.length >= 2) {
    let hi = epochs[0], lo = epochs[0];
    for (const e of epochs) { if (e.mean > hi.mean) hi = e; if (e.mean < lo.mean) lo = e; }
    const delta = hi.mean - lo.mean, err = Math.hypot(hi.err, lo.err);
    change = { delta: (hi.t0 > lo.t0 ? 1 : -1) * delta, err, sig: delta / err };
  }
  return { points, epochs, change };
}
