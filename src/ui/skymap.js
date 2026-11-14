// Interactive all-sky map: the real SPHEREx sky (DR1 all-sky cube from IRSA's HiPS, rendered by
// scripts/allsky.mjs) in an equatorial Mollweide projection (RA 12h at the centre, increasing to
// the left), with an hour/degree grid, the ecliptic, target markers and a hover readout that
// counts, live from IRSA, how many SPHEREx images cover the point under the cursor.

import { h } from './dom.js';
import { formatRA, formatDec } from '../lib/coords.js';

const NS = 'http://www.w3.org/2000/svg';
const R2 = Math.SQRT2;
const D2R = Math.PI / 180;

/** RA/Dec (deg) -> map fraction [0..1] x [0..1]. */
export function project(ra, dec) {
  let lon = ((ra - 180 + 540) % 360) - 180; // centre 12h
  const phi = dec * D2R;
  let th = phi;
  for (let i = 0; i < 20; i++) {
    const f = 2 * th + Math.sin(2 * th) - Math.PI * Math.sin(phi);
    const d = 2 + 2 * Math.cos(2 * th);
    if (Math.abs(d) < 1e-9) break;
    th -= f / d;
    if (Math.abs(f) < 1e-10) break;
  }
  const X = -(2 * R2 / Math.PI) * lon * D2R * Math.cos(th), Y = R2 * Math.sin(th);
  return [X / (4 * R2) + 0.5, 0.5 - Y / (2 * R2)];
}
/** Map fraction -> RA/Dec, or null outside the ellipse. */
export function unproject(fx, fy) {
  const X = (fx - 0.5) * 4 * R2, Y = (0.5 - fy) * 2 * R2;
  if ((X * X) / 8 + (Y * Y) / 2 > 1) return null;
  const th = Math.asin(Y / R2);
  const lat = Math.asin((2 * th + Math.sin(2 * th)) / Math.PI);
  const lon = -(Math.PI * X) / (2 * R2 * Math.cos(th));
  return { ra: (((180 + lon / D2R) % 360) + 360) % 360, dec: lat / D2R };
}

const el = (n, a = {}, p) => { const e = document.createElementNS(NS, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, String(v)); if (p) p.appendChild(e); return e; };

/**
 * @param {{targets: Array<{id,name,ra,dec,kind?}>, onPick: (ra,dec)=>void, onTarget: (t)=>void, count?: (ra,dec)=>Promise<number>}} opts
 */
export function skyMap({ targets = [], onPick, onTarget, count, coverage = null, livePts = [] }) {
  const W = 1000, H = 500;
  const img = h('img', { src: 'assets/allsky-1000.jpg', srcset: 'assets/allsky-1000.jpg 1000w, assets/allsky-1600.jpg 1600w', sizes: '(min-width: 1200px) 1200px, 100vw',
    width: W, height: H, alt: 'The whole sky seen by NASA SPHEREx in infrared (equatorial coordinates); the Milky Way arcs across it', decoding: 'async', draggable: 'false' });
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'skymap-ov', 'aria-hidden': 'true' });
  // graticule: RA every 2h (labels every 4h), Dec every 30°
  const g = el('g', { class: 'grat' }, svg);
  const line = (pts, cls) => { const d = pts.filter(Boolean).map(([x, y], i) => `${i ? 'L' : 'M'}${(x * W).toFixed(1)},${(y * H).toFixed(1)}`).join(''); el('path', { d, class: cls }, g); };
  for (let raH = 0; raH < 24; raH += 2) {
    const pts = []; for (let dec = -90; dec <= 90; dec += 3) pts.push(project(raH * 15 === 180 ? 180 : raH * 15, dec));
    line(pts, 'g-line');
  }
  for (const dec of [-60, -30, 0, 30, 60]) {
    const pts = []; for (let ra = 180.001; ra <= 540; ra += 3) pts.push(project(ra % 360, dec));
    line(pts, dec === 0 ? 'g-eq' : 'g-line');
  }
  for (const raH of [4, 8, 12, 16, 20]) {
    const [x, y] = project(raH * 15, 0);
    const t = el('text', { x: x * W, y: y * H - 6, class: 'g-lab', 'text-anchor': 'middle' }, g); t.textContent = `${raH}h`;
  }
  for (const dec of [-60, -30, 30, 60]) {
    const [x, y] = project(180.0001 + 179.9, dec);
    const t = el('text', { x: Math.max(14, x * W - 4), y: y * H + 4, class: 'g-lab', 'text-anchor': 'end' }, g); t.textContent = `${dec > 0 ? '+' : ''}${dec}°`;
  }
  // ecliptic (obliquity 23.44°)
  const eps = 23.4393 * D2R, ecl = [];
  for (let lam = 0; lam <= 360; lam += 2) {
    const l = lam * D2R;
    const ra = (Math.atan2(Math.cos(eps) * Math.sin(l), Math.cos(l)) / D2R + 360) % 360, dec = Math.asin(Math.sin(eps) * Math.sin(l)) / D2R;
    ecl.push([ra, dec]);
  }
  ecl.sort((a, b) => ((a[0] - 180 + 360) % 360) - ((b[0] - 180 + 360) % 360));
  line(ecl.map(([ra, dec]) => project(ra, dec)), 'g-ecl');
  {
    const [x, y] = project(232, -18.6); // a clear spot along the ecliptic
    const t = el('text', { x: x * W + 6, y: y * H + 16, class: 'g-lab g-ecl-lab' }, g); t.textContent = 'ecliptic';
  }
  // target markers (four-point stars)
  const mk = el('g', { class: 'marks' }, svg);
  const star = (cx, cy, r) => `M${cx},${cy - r} Q${cx + r * 0.18},${cy - r * 0.18} ${cx + r},${cy} Q${cx + r * 0.18},${cy + r * 0.18} ${cx},${cy + r} Q${cx - r * 0.18},${cy + r * 0.18} ${cx - r},${cy} Q${cx - r * 0.18},${cy - r * 0.18} ${cx},${cy - r}Z`;
  const markers = targets.map((t) => {
    const [x, y] = project(t.ra, t.dec);
    const gg = el('g', { class: 'mark', tabindex: '0', role: 'button', 'aria-label': `Open ${t.name}` }, mk);
    el('circle', { cx: x * W, cy: y * H, r: 16, class: 'mark-hit' }, gg);
    el('path', { d: star(x * W, y * H, 11), class: 'mark-star' }, gg);
    const lab = el('text', { x: x * W + 14, y: y * H + 4, class: 'mark-lab' }, gg); lab.textContent = t.name;
    return { t, gg, x, y };
  });

  // galactic plane (dashed) and centre
  const gal = el('g', { class: 'galp' }, svg);
  {
    const M = [[-0.0548755604, 0.4941094279, -0.8676661490], [-0.8734370902, -0.4448296300, -0.1980763734], [-0.4838350155, 0.7469822445, 0.4559837762]];
    const pts = [];
    for (let l = 0; l <= 360; l += 2) {
      const x = Math.cos(l * D2R), y = Math.sin(l * D2R);
      const ex = M[0][0] * x + M[0][1] * y, ey = M[1][0] * x + M[1][1] * y, ez = M[2][0] * x + M[2][1] * y;
      pts.push([(Math.atan2(ey, ex) / D2R + 360) % 360, Math.asin(ez) / D2R]);
    }
    pts.sort((a, b) => ((a[0] - 180 + 360) % 360) - ((b[0] - 180 + 360) % 360));
    const d = pts.map(([ra, dec], i) => { const [x, y] = project(ra, dec); return `${i ? 'L' : 'M'}${(x * W).toFixed(1)},${(y * H).toFixed(1)}`; }).join('');
    el('path', { d, class: 'g-gal' }, gal);
    const [cx, cy] = project(266.405, -28.936);
    const t = el('text', { x: cx * W + 8, y: cy * H - 6, class: 'g-lab g-gal-lab' }, gal); t.textContent = 'Galactic centre';
  }
  // newest frames developed on the Live page
  const live = el('g', { class: 'livepts' }, svg);
  for (const p of livePts) { const [x, y] = project(p.ra, p.dec); el('circle', { cx: x * W, cy: y * H, r: 6, class: 'live-ring' }, live); }
  svg.insertBefore(gal, svg.firstChild);

  // coverage glow (canvas under the grid)
  const cov = h('canvas', { class: 'skymap-cov', width: 500, height: 250, 'aria-hidden': 'true' });
  let covMode = 'counts', covGrid = null;
  if (coverage) {
    const dec16 = (b64) => { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < u.length; i++) u[i] = bin.charCodeAt(i); return new Uint16Array(u.buffer); };
    covGrid = { w: coverage.w, h: coverage.h, counts: dec16(coverage.counts), last: dec16(coverage.lastDay), mjd0: coverage.mjd0 };
    // smooth the scan-pattern stripes for display (separable [1,3,4,3,1] blur, RA wraps; zero cells ignored)
    const blur = (src) => {
      const W = covGrid.w, Hh = covGrid.h, k = [1, 3, 4, 3, 1], tmp = new Float32Array(W * Hh), out = new Uint16Array(W * Hh);
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { let s = 0, w = 0; for (let d = -2; d <= 2; d++) { const v = src[j * W + (((i + d) % W) + W) % W]; if (v) { s += v * k[d + 2]; w += k[d + 2]; } } tmp[j * W + i] = w ? s / w : 0; }
      for (let j = 0; j < Hh; j++) for (let i = 0; i < W; i++) { let s = 0, w = 0; for (let d = -2; d <= 2; d++) { const jj = j + d; if (jj < 0 || jj >= Hh) continue; const v = tmp[jj * W + i]; if (v) { s += v * k[d + 2]; w += k[d + 2]; } } out[j * W + i] = w ? Math.round(s / w) : 0; }
      return out;
    };
    covGrid.countsSmooth = blur(blur(covGrid.counts));
  }
  const RAMP = [[10, 20, 70], [30, 60, 160], [40, 130, 200], [60, 190, 190], [150, 220, 120], [240, 210, 80], [255, 160, 60], [255, 250, 230]];
  function drawCoverage() {
    if (!covGrid) return;
    const ctx = cov.getContext('2d'), cw = cov.width, ch = cov.height, im = ctx.createImageData(cw, ch);
    const vals = [];
    const src = covMode === 'counts' ? covGrid.countsSmooth : covGrid.last;
    for (let k = 0; k < src.length; k += 7) if (src[k]) vals.push(src[k]);
    vals.sort((a, b) => a - b);
    const lo = vals[Math.floor(vals.length * 0.03)] || 1, hi = vals[Math.floor(vals.length * 0.97)] || 2;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const p = unproject((i + 0.5) / cw, (j + 0.5) / ch);
      if (!p) continue;
      const v = src[Math.min(covGrid.h - 1, Math.floor(p.dec + 90)) * covGrid.w + (Math.floor(p.ra) % 360)];
      if (!v) continue;
      let t = covMode === 'counts' ? (Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1) : (v - lo) / (hi - lo || 1);
      t = Math.max(0, Math.min(1, t));
      const x = t * (RAMP.length - 1), a = Math.floor(Math.min(RAMP.length - 2, x)), f = x - a;
      const o = (j * cw + i) * 4;
      for (let c = 0; c < 3; c++) im.data[o + c] = RAMP[a][c] + (RAMP[a + 1][c] - RAMP[a][c]) * f;
      im.data[o + 3] = 14 + 96 * t;
    }
    ctx.putImageData(im, 0, 0);
    legend.replaceChildren(h('span', { class: 'tiny' }, covMode === 'counts' ? 'fewer' : `${new Date((covGrid.mjd0 + lo - 40587) * 864e5).toISOString().slice(0, 10)}`), h('i', { class: 'ramp' }), h('span', { class: 'tiny' }, covMode === 'counts' ? 'more images' : `${new Date((covGrid.mjd0 + hi - 40587) * 864e5).toISOString().slice(0, 10)}`));
  }
  const legend = h('div', { class: 'row skymap-legend' });

  const tip = h('div', { class: 'skymap-tip', hidden: true, role: 'status', 'aria-live': 'polite' });
  const stageEl = h('div', { class: 'skymap-stage' }, img, cov, svg);
  const wrap = h('div', { class: 'skymap', role: 'application', 'aria-label': 'Interactive map of the whole sky. Hover to read coordinates, click to open that patch of sky.' }, stageEl, tip);

  // ---- layers, mode and zoom
  const layers = { photo: true, coverage: !!covGrid, targets: true, live: true, ecliptic: true, galactic: false, grid: true };
  const applyLayers = () => {
    img.style.opacity = layers.photo ? '1' : '0';
    cov.style.display = layers.coverage ? '' : 'none';
    cov.style.mixBlendMode = layers.photo ? 'screen' : 'normal';
    mk.style.display = layers.targets ? '' : 'none';
    live.style.display = layers.live ? '' : 'none';
    g.querySelectorAll('.g-ecl, .g-ecl-lab').forEach((e) => { e.style.display = layers.ecliptic ? '' : 'none'; });
    gal.style.display = layers.galactic ? '' : 'none';
    g.querySelectorAll('.g-line, .g-eq, .g-lab:not(.g-ecl-lab)').forEach((e) => { e.style.display = layers.grid ? '' : 'none'; });
    legend.style.visibility = layers.coverage ? 'visible' : 'hidden';
  };
  const view = { s: 1, x: 0, y: 0 };
  const applyView = () => { stageEl.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`; wrap.classList.toggle('zoomed', view.s > 1); };
  const zoomBy = (f, cx = 0.5, cy = 0.5) => {
    const r = wrap.getBoundingClientRect();
    const s1 = Math.min(12, Math.max(1, view.s * f));
    const px = cx * r.width, py = cy * r.height;
    view.x = px - ((px - view.x) * s1) / view.s; view.y = py - ((py - view.y) * s1) / view.s; view.s = s1;
    if (s1 === 1) { view.x = 0; view.y = 0; }
    applyView();
  };
  const toolbar = h('div', { class: 'row skymap-tools' },
    covGrid ? h('div', { class: 'seg', role: 'group', 'aria-label': 'Coverage colouring' },
      h('button', { type: 'button', 'aria-pressed': 'true', onclick: (e) => { covMode = 'counts'; [...e.currentTarget.parentElement.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); drawCoverage(); } }, 'Times observed'),
      h('button', { type: 'button', 'aria-pressed': 'false', onclick: (e) => { covMode = 'recent'; [...e.currentTarget.parentElement.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); drawCoverage(); } }, 'Most recent')) : null,
    legend, h('div', { class: 'spacer' }),
    h('button', { class: 'btn small icon', type: 'button', 'aria-label': 'Zoom in', title: 'Zoom in', onclick: () => zoomBy(1.5) }, '+'),
    h('button', { class: 'btn small icon', type: 'button', 'aria-label': 'Zoom out', title: 'Zoom out', onclick: () => zoomBy(1 / 1.5) }, '−'),
    h('details', { class: 'layers' }, h('summary', { class: 'btn small' }, 'Layers'),
      h('div', { class: 'layers-menu card' },
        h('b', { class: 'tiny' }, 'Sky'),
        ...[['photo', 'Infrared sky photo (SPHEREx DR1)'], ['coverage', 'SPHEREx coverage glow']].filter(([k]) => k !== 'coverage' || covGrid).map(([k, l]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: layers[k], onchange: (e) => { layers[k] = e.target.checked; applyLayers(); } }), l)),
        h('b', { class: 'tiny' }, 'Markers'),
        ...[['targets', 'Challenge targets'], ['live', 'Newest frames (from Live)']].map(([k, l]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: layers[k], onchange: (e) => { layers[k] = e.target.checked; applyLayers(); } }), l)),
        h('b', { class: 'tiny' }, 'Guides'),
        ...[['ecliptic', 'Ecliptic (path of planets, asteroids, comets)'], ['galactic', 'Galactic plane'], ['grid', 'Coordinate grid']].map(([k, l]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: layers[k], onchange: (e) => { layers[k] = e.target.checked; applyLayers(); } }), l)))));
  const outer = h('div', { class: 'skymap-outer' }, toolbar, wrap);
  // wheel zoom with Ctrl/⌘ or once zoomed; drag to pan when zoomed; pinch
  wrap.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey || view.s > 1)) return;
    e.preventDefault();
    const r = wrap.getBoundingClientRect();
    zoomBy(e.deltaY < 0 ? 1.25 : 0.8, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  }, { passive: false });
  let drag = null; const touches = new Map(); let pinch = null; let moved = false;
  wrap.addEventListener('pointerdown', (e) => { touches.set(e.pointerId, [e.clientX, e.clientY]); moved = false; if (touches.size === 2) { const [a, b] = [...touches.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: view.s }; } else if (view.s > 1) drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y }; });
  wrap.addEventListener('pointermove', (e) => {
    if (touches.has(e.pointerId)) touches.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && touches.size === 2) { const [a, b] = [...touches.values()]; zoomBy((pinch.s * Math.hypot(a[0] - b[0], a[1] - b[1])) / pinch.d / view.s); moved = true; return; }
    if (drag) { const dx = e.clientX - drag.x, dy = e.clientY - drag.y; if (Math.abs(dx) + Math.abs(dy) > 4) moved = true; view.x = drag.vx + dx; view.y = drag.vy + dy; applyView(); }
  });
  const end = (e) => { touches.delete(e.pointerId); if (touches.size < 2) pinch = null; drag = null; };
  wrap.addEventListener('pointerup', end); wrap.addEventListener('pointercancel', end);
  wrap.style.touchAction = 'pan-y';

  const counts = new Map();
  let hoverTimer = 0, last = null;
  const showTip = (px, py, text) => {
    tip.hidden = false; tip.textContent = text;
    const r = wrap.getBoundingClientRect();
    const tw = tip.offsetWidth || 200;
    tip.style.left = `${Math.min(r.width - tw - 6, Math.max(6, px + 14))}px`;
    tip.style.top = `${Math.max(6, py - 44)}px`;
  };
  const posText = (p) => `RA ${p.ra.toFixed(1)}° (${formatRA(p.ra).slice(0, 6)}), Dec ${p.dec >= 0 ? '+' : ''}${p.dec.toFixed(1)}°`;
  wrap.addEventListener('pointermove', (e) => {
    const r = stageEl.getBoundingClientRect(), rw = wrap.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const onMark = markers.find((m) => Math.hypot((m.x - fx) * r.width, (m.y - fy) * r.height) < 14);
    if (onMark) { showTip(e.clientX - rw.left, e.clientY - rw.top, `${onMark.t.name} · ${onMark.t.kind || ''} · click to play`); wrap.style.cursor = 'pointer'; return; }
    const p = unproject(fx, fy);
    if (!p) { tip.hidden = true; wrap.style.cursor = 'default'; return; }
    wrap.style.cursor = view.s > 1 ? 'grab' : 'crosshair';
    const key = `${Math.round(p.ra * 2) / 2},${Math.round(p.dec * 2) / 2}`;
    last = { p, key, px: e.clientX - rw.left, py: e.clientY - rw.top };
    if (covGrid) {
      const n = covGrid.counts[Math.min(covGrid.h - 1, Math.floor(p.dec + 90)) * covGrid.w + (Math.floor(p.ra) % 360)];
      if (!counts.has(key)) counts.set(key, n ? `~${n}` : '0');
    }
    const known = counts.get(key);
    showTip(last.px, last.py, `${posText(p)} · ${known == null ? 'imaged …' : `imaged ${known}×`}`);
    clearTimeout(hoverTimer);
    if (known == null && count) {
      hoverTimer = setTimeout(async () => {
        const at = last;
        try {
          const n = await count(at.p.ra, at.p.dec);
          counts.set(at.key, n);
          if (last?.key === at.key) showTip(last.px, last.py, `${posText(at.p)} · imaged ${n}× by SPHEREx`);
        } catch { if (last?.key === at.key) showTip(last.px, last.py, `${posText(at.p)} · image count unavailable offline`); }
      }, 450);
    }
  });
  wrap.addEventListener('pointerleave', () => { tip.hidden = true; clearTimeout(hoverTimer); });
  wrap.addEventListener('click', (e) => {
    if (moved) return;
    const r = stageEl.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    const onMark = markers.find((m) => Math.hypot((m.x - fx) * r.width, (m.y - fy) * r.height) < 16);
    if (onMark) { onTarget?.(onMark.t); return; }
    const p = unproject(fx, fy);
    if (p) onPick?.(p.ra, p.dec);
  });
  for (const m of markers) m.gg.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onTarget?.(m.t); } });
  applyLayers(); drawCoverage();
  return outer;
}
