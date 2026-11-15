// Inspector for the user's own FITS image: hover for coordinates and pixel values, click to measure an object
// (centroid, J2000.0 and equinox-of-date coordinates, magnitude calibrated on Gaia DR3 stars, nearest Gaia star) and
// export the measurements. Runs on the device; Gaia DR3 comes from MAST (or IRSA) through the archive layer.

import { h, sheet, toast, download, closeSheets } from './dom.js';
import { formatRA, formatDec, precessFromJ2000, niceDateTime, niceDate, propagate, mjdToYear, separation, toGalactic } from '../lib/coords.js';
import { lut } from '../lib/render.js';
import { makeGrid, gridToWorld } from '../lib/engine.js';
import { normalise, toParams } from '../state.js';
import { pixelToSky, skyToPixel, imageMjd, imageStats, centroid, aperture, calibrate, headerZeroPoint } from '../lib/userimage.js';
import { gaiaCone } from '../lib/tap.js';
import { CelestialWCS } from '../lib/wcs.js';

/** The image's declared coordinate frame (FITS RADESYS / EQUINOX), as shown to the user. */
function frameName(h) {
  const sys = String(h.RADESYS || h.RADECSYS || '').trim().toUpperCase();
  const eq = Number(h.EQUINOX ?? h.EPOCH);
  if (sys === 'ICRS' || (!sys && !Number.isFinite(eq))) return 'ICRS, aligned with the J2000.0 equator and equinox to about 0.02″';
  if (sys === 'FK5' || (!sys && eq === 2000)) return 'FK5, equator and equinox J2000.0';
  if (sys === 'FK4' || eq === 1950) return 'FK4, equinox B1950.0';
  return `${sys || 'unstated'}${Number.isFinite(eq) ? `, equinox ${eq}` : ''}`;
}
/** A warning when the image is not in a J2000.0-based frame (positions are then not converted). */
function frameNote(h) {
  const sys = String(h.RADESYS || h.RADECSYS || '').trim().toUpperCase(), eq = Number(h.EQUINOX ?? h.EPOCH);
  return sys === 'FK4' || eq === 1950 ? 'This image uses the old B1950.0 (FK4) frame: the positions shown are in that frame, not J2000.0. Re-solve the image in J2000.0 for reports.' : null;
}

/** Open the inspector for a FITS file (ArrayBuffer, gzip allowed). */
export async function inspectImage(buf, name) {
  // decoding runs in a background worker (large or compressed images take a few seconds), with a message meanwhile
  const wait = sheet(h('div', { class: 'grid' }, h('h2', {}, `Your image: ${name}`), h('p', {}, 'Reading your image… large or compressed images take a few seconds.'), h('div', { class: 'boot-orbit', style: { margin: '6px auto' } }, h('span'))), { label: 'Your image' });
  let img;
  try {
    img = await new Promise((resolve, reject) => {
      const w = new Worker(new URL('../image-worker.js', import.meta.url), { type: 'module' });
      w.onmessage = (e) => { w.terminate(); if (!e.data.ok) { reject(new Error(e.data.error)); return; } const hdr = e.data.header; resolve({ ...e.data, header: hdr, wcs: new CelestialWCS(hdr) }); };
      w.onerror = (e) => { w.terminate(); reject(new Error(e.message || 'the image could not be read')); };
      w.postMessage({ buf }, [buf]);
    });
  } catch (e) {
    wait(); toast({ title: 'This image cannot be inspected', text: e.message, glyph: '⚠️', timeout: 7000 }); return;
  }
  wait();
  const H = img.header, mjd = imageMjd(H), st = imageStats(img);
  const sorted = st.sample.slice().sort((a, b) => a - b);
  const W = img.width, Hh = img.height;

  // ---- display settings, as in FITS viewers such as JS9: brightness scale, limits, colour map, negative
  const disp = { scale: 'asinh', limits: 'zscale', cmap: 'gray', negative: false, magnifier: true, coords: 'icrs' };
  const zscale = () => {
    // IRAF-style zscale: a line through the sorted sample's middle half, contrast 0.25
    const n = sorted.length, med = sorted[n >> 1], i1 = Math.floor(n * 0.25), i3 = Math.floor(n * 0.75);
    const slope = (sorted[i3] - sorted[i1]) / Math.max(1, i3 - i1);
    return [Math.max(sorted[0], med - (n / 2) * slope / 0.25), Math.min(sorted[n - 1], med + (n / 2) * slope / 0.25)];
  };
  const limitsFor = (m) => {
    const n = sorted.length;
    if (m === 'minmax') return [sorted[0], sorted[n - 1]];
    if (m === '99.5') return [sorted[Math.floor(n * 0.0025)], sorted[Math.min(n - 1, Math.floor(n * 0.9975))]];
    return zscale();
  };
  let lo, hi, histLut = null, cmapLut = lut('gray');
  const applyLimits = () => {
    [lo, hi] = limitsFor(disp.limits); if (!(hi > lo)) hi = lo + 1;
    // histogram equalisation table: share of the sample below each of 4096 levels between the limits
    const L = new Float32Array(4096); let j = 0;
    const first = sorted.findIndex((v) => v >= lo), last = sorted.length - 1;
    for (let b = 0; b < 4096; b++) { const v = lo + ((b + 0.5) / 4096) * (hi - lo); while (j < sorted.length && sorted[j] < v) j++; L[b] = Math.min(1, Math.max(0, (j - first) / Math.max(1, last - first))); }
    histLut = L; cmapLut = lut(disp.cmap);
  };
  applyLimits();
  const tone = (v) => {
    if (!Number.isFinite(v)) return -1;
    let t = (v - lo) / (hi - lo); t = t <= 0 ? 0 : t >= 1 ? 1 : t;
    if (disp.scale === 'sqrt') t = Math.sqrt(t);
    else if (disp.scale === 'log') t = Math.log10(1 + 999 * t) / 3;
    else if (disp.scale === 'asinh') t = Math.asinh(10 * t) / Math.asinh(10);
    else if (disp.scale === 'histeq') t = histLut[Math.min(4095, (t * 4096) | 0)];
    return disp.negative ? 1 - t : t;
  };
  const put = (data, k, v) => { const t = tone(v); if (t < 0) { data[k] = 38; data[k + 1] = 24; data[k + 2] = 64; } else { const i = ((t * 255) | 0) * 3; data[k] = cmapLut[i]; data[k + 1] = cmapLut[i + 1]; data[k + 2] = cmapLut[i + 2]; } data[k + 3] = 255; };

  // overview: averaged blocks of f × f pixels (large images stay smooth); detail is drawn at full resolution when zoomed
  const f = Math.max(1, Math.ceil(Math.sqrt((W * Hh) / 4e6))), bw = Math.ceil(W / f), bh = Math.ceil(Hh / f);
  const bins = new Float32Array(bw * bh);
  if (f === 1) bins.set(img.data);
  else for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    let sum = 0, n = 0;
    for (let y = by * f; y < Math.min(Hh, (by + 1) * f); y++) for (let x = bx * f; x < Math.min(W, (bx + 1) * f); x++) { const v = img.data[y * W + x]; if (Number.isFinite(v)) { sum += v; n++; } }
    bins[by * bw + bx] = n ? sum / n : NaN;
  }
  const off = document.createElement('canvas'); off.width = bw; off.height = bh;
  const paint = () => {
    const id = off.getContext('2d').createImageData(bw, bh);
    for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) put(id.data, ((bh - 1 - y) * bw + x) * 4, bins[y * bw + x]);
    off.getContext('2d').putImageData(id, 0, 0);
    detail = null;
  };
  let detail = null; // { key, canvas, x0, y0 } full-resolution crop of the visible part
  paint();

  const canvas = h('canvas', { style: { width: '100%', aspectRatio: `${W} / ${Hh}`, maxHeight: '62vh', background: '#05061a', borderRadius: '8px', cursor: 'crosshair', touchAction: 'none', display: 'block' }, 'aria-label': 'Your image: hover for coordinates, click to measure' });
  const mag = h('canvas', { width: 150, height: 150, 'aria-hidden': 'true', style: { position: 'absolute', top: '8px', right: '8px', width: '150px', height: '150px', borderRadius: '8px', border: '2px solid #ffb547', boxShadow: '0 4px 14px #0008', display: 'none', pointerEvents: 'none', imageRendering: 'pixelated' } });
  const imgBox = h('div', { style: { position: 'relative' } }, canvas, mag);
  const readout = h('div', { class: 'tiny', style: { fontFamily: 'var(--mono)', minHeight: '1.4em' } }, 'Move over the image for coordinates; click a star or object to measure it.');
  const calLine = h('p', { class: 'tiny' }, 'Calibrating on Gaia DR3 stars in the image…');
  const results = h('div');
  const marks = [];
  let view = { s: 1, x: 0, y: 0 }; // zoom and top-left of the visible part (image pixels, display orientation)
  let cal = null, gaia = [];

  const fit = () => { const r = canvas.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1); canvas.width = Math.max(50, Math.round(r.width * dpr)); canvas.height = Math.round(canvas.width * Hh / W); };
  const draw = () => {
    const ctx = canvas.getContext('2d'), k = (canvas.width / W) * view.s;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const vw = W / view.s, vh = Hh / view.s;
    if (f > 1 && k * f > 1.5 && vw * vh <= 9e6) {
      // zoomed in: the visible part at full resolution
      const x0 = Math.max(0, Math.floor(view.x)), y0 = Math.max(0, Math.floor(view.y)), x1 = Math.min(W, Math.ceil(view.x + vw) + 1), y1 = Math.min(Hh, Math.ceil(view.y + vh) + 1);
      const key = `${x0},${y0},${x1},${y1},${disp.scale},${disp.limits},${disp.cmap},${disp.negative}`;
      if (!detail || detail.key !== key) {
        const cw = x1 - x0, ch = y1 - y0, c = document.createElement('canvas'); c.width = cw; c.height = ch;
        const id = c.getContext('2d').createImageData(cw, ch);
        for (let dy = 0; dy < ch; dy++) { const fy = Hh - 1 - (y0 + dy); for (let dx = 0; dx < cw; dx++) put(id.data, (dy * cw + dx) * 4, img.data[fy * W + x0 + dx]); }
        c.getContext('2d').putImageData(id, 0, 0); detail = { key, canvas: c, x0, y0 };
      }
      ctx.imageSmoothingEnabled = k < 2;
      ctx.setTransform(k, 0, 0, k, (detail.x0 - view.x) * k, (detail.y0 - view.y) * k); ctx.drawImage(detail.canvas, 0, 0);
    } else {
      ctx.imageSmoothingEnabled = k * f < 2;
      ctx.setTransform(k * f, 0, 0, k * f, -view.x * k, -view.y * k); ctx.drawImage(off, 0, 0);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    const ink = disp.negative ? '#b85500' : '#ffb547';
    ctx.strokeStyle = ink; ctx.lineWidth = 1.5; ctx.font = '12px system-ui'; ctx.fillStyle = ink;
    marks.forEach((m, i) => {
      const cx = (m.x - view.x) * k, cy = (Hh - 1 - m.y - view.y) * k, r = Math.max(6, (cal?.rAp || 4) * k);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke(); ctx.fillText(String(i + 1), cx + r + 3, cy - r);
    });
  };
  // magnifier: 10 × 10 image pixels around the pointer, enlarged 15 times
  const drawMag = (p) => {
    if (!disp.magnifier) { mag.style.display = 'none'; return; }
    const ctx = mag.getContext('2d'), n = 10, id = ctx.createImageData(n, n);
    for (let dy = 0; dy < n; dy++) for (let dx = 0; dx < n; dx++) {
      const x = Math.floor(p.x) - n / 2 + dx, y = Math.floor(p.y) + n / 2 - 1 - dy;
      put(id.data, (dy * n + dx) * 4, x >= 0 && y >= 0 && x < W && y < Hh ? img.data[y * W + x] : NaN);
    }
    const t = document.createElement('canvas'); t.width = n; t.height = n; t.getContext('2d').putImageData(id, 0, 0);
    ctx.imageSmoothingEnabled = false; ctx.clearRect(0, 0, 150, 150); ctx.drawImage(t, 0, 0, 150, 150);
    ctx.strokeStyle = disp.negative ? '#b85500' : '#ffb547'; ctx.lineWidth = 1; ctx.strokeRect(75 - 7.5, 75 - 7.5, 15, 15);
    mag.style.display = 'block';
  };
  // coordinates in the chosen system
  const ecliptic = (ra, dec) => {
    const e = 23.4392911 * Math.PI / 180, a = ra * Math.PI / 180, d = dec * Math.PI / 180;
    const lam = Math.atan2(Math.sin(a) * Math.cos(e) + Math.tan(d) * Math.sin(e), Math.cos(a)), bet = Math.asin(Math.sin(d) * Math.cos(e) - Math.cos(d) * Math.sin(e) * Math.sin(a));
    return { l: ((lam * 180 / Math.PI) + 360) % 360, b: bet * 180 / Math.PI };
  };
  const coordText = (s) => {
    if (disp.coords === 'gal') { const g = toGalactic(s.ra, s.dec); return `l = ${g.l.toFixed(5)}°, b = ${g.b.toFixed(5)}° (galactic)`; }
    if (disp.coords === 'ecl') { const q = ecliptic(s.ra, s.dec); return `λ = ${q.l.toFixed(5)}°, β = ${q.b.toFixed(5)}° (ecliptic, J2000.0)`; }
    return `${formatRA(s.ra)} ${formatDec(s.dec)} (J2000.0) · ${s.ra.toFixed(6)}, ${s.dec.toFixed(6)}`;
  };
  // canvas point -> image pixel (0-based FITS x, y)
  const toPixel = (e) => {
    const r = canvas.getBoundingClientRect(), k = (r.width / img.width) * view.s;
    const dx = (e.clientX - r.left) / k + view.x, dy = (e.clientY - r.top) / k + view.y;
    return { x: dx, y: img.height - 1 - dy };
  };
  const clampView = () => {
    const w = img.width / view.s, hh = img.height / view.s;
    view.x = Math.min(Math.max(0, view.x), img.width - w); view.y = Math.min(Math.max(0, view.y), img.height - hh);
  };
  const zoomAt = (f, px = img.width / 2, py = img.height / 2) => {
    const ns = Math.min(32, Math.max(1, view.s * f)), dy = img.height - 1 - py;
    view.x = px - (px - view.x) * (view.s / ns); view.y = dy - (dy - view.y) * (view.s / ns); view.s = ns; clampView(); draw();
  };

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener('pointermove', (e) => {
    const p = toPixel(e);
    if (drag && (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4)) {
      drag.moved = true; const r = canvas.getBoundingClientRect(), k = (r.width / img.width) * view.s;
      view.x = drag.vx - (e.clientX - drag.x) / k; view.y = drag.vy - (e.clientY - drag.y) / k; clampView(); draw(); return;
    }
    if (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) { mag.style.display = 'none'; return; }
    const s = pixelToSky(img, p.x, p.y), v = img.data[Math.floor(p.y) * img.width + Math.floor(p.x)];
    readout.textContent = `${coordText(s)} · pixel ${(p.x + 1).toFixed(1)}, ${(p.y + 1).toFixed(1)} · ${Number.isFinite(v) ? v.toPrecision(5) : 'no data'}${H.BUNIT ? ' ' + H.BUNIT : ''}`;
    drawMag(p);
  });
  canvas.addEventListener('pointerup', (e) => { const d = drag; drag = null; if (d && !d.moved) measure(toPixel(e)); });
  canvas.addEventListener('pointerleave', () => { mag.style.display = 'none'; });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const p = toPixel(e); zoomAt(e.deltaY < 0 ? 1.4 : 1 / 1.4, p.x, p.y); }, { passive: false });

  const magOf = (a) => {
    const z = cal?.ok ? { zp: cal.zp, err: cal.err, label: `Gaia G-band equivalent, calibrated on ${cal.n} Gaia DR3 stars` } : headerZeroPoint(H) ? { zp: headerZeroPoint(H).zp, err: 0, label: `zero point from the header (${headerZeroPoint(H).key})` } : null;
    if (!z || !a) return { text: '–', z };
    if (a.snr < 3) return { text: `not detected (S/N ${a.snr.toFixed(1)}): fainter than ${(z.zp - 2.5 * Math.log10(3 * a.err)).toFixed(2)} (3σ)`, z };
    const m = z.zp - 2.5 * Math.log10(a.flux), e = Math.sqrt(z.err ** 2 + (1.0857 * a.err / a.flux) ** 2);
    const sat = a.peak >= (cal?.saturation ?? Infinity);
    return { text: `${sat ? '≤ ' : ''}${m.toFixed(2)} ± ${e < 0.005 ? '<0.01' : e.toFixed(2)}${sat ? ' (saturated: brighter than this)' : ''}`, mag: m, err: e, z, sat };
  };

  // the 5 × 5 pixel values around a position (north up), as in a FITS viewer's pixel table
  function pixelTable(c) {
    const cx = Math.round(c.x), cy = Math.round(c.y), rows = [];
    for (let dy = 2; dy >= -2; dy--) {
      const cells = [];
      for (let dx = -2; dx <= 2; dx++) { const x = cx + dx, y = cy + dy, v = x >= 0 && y >= 0 && x < W && y < Hh ? img.data[y * W + x] : NaN; cells.push(h('td', { style: { padding: '1px 5px', textAlign: 'right', fontWeight: dx === 0 && dy === 0 ? '700' : '400' } }, Number.isFinite(v) ? v.toPrecision(4) : '–')); }
      rows.push(h('tr', {}, cells));
    }
    return h('table', { style: { fontFamily: 'var(--mono)', fontSize: '.72rem', borderCollapse: 'collapse' } }, h('tbody', {}, rows));
  }

  // compare with SPHEREx: the image resampled onto the Time Machine's grid for the same patch of sky
  function compareInTimeMachine() {
    const c0 = pixelToSky(img, W / 2, Hh / 2);
    const ra = Number(c0.ra.toFixed(6)), dec = Number(c0.dec.toFixed(6));
    // at most 15′: the centre of large images, so the Time Machine stays quick on any device
    const fov = Math.min(15, Math.max(2, Math.round((Math.min(W, Hh) * img.wcs.pixelScaleArcsec) / 60)));
    const g = makeGrid(ra, dec, fov), n = g.n, out = new Float32Array(n * n).fill(NaN);
    const sub = Math.max(1, Math.min(8, Math.round(g.scale / img.wcs.pixelScaleArcsec / 3)));
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const [r0, d0] = gridToWorld(g, i, j), p0 = skyToPixel(img, r0, d0);
      if (!p0) continue;
      const [r1, d1] = gridToWorld(g, i + 1, j), [r2, d2] = gridToWorld(g, i, j + 1);
      const p1 = skyToPixel(img, r1, d1), p2 = skyToPixel(img, r2, d2);
      let sum = 0, cnt = 0;
      for (let b = 0; b < sub; b++) for (let a = 0; a < sub; a++) {
        const u = (a + 0.5) / sub - 0.5, v = (b + 0.5) / sub - 0.5;
        const x = Math.round(p0.x + u * (p1.x - p0.x) + v * (p2.x - p0.x)), y = Math.round(p0.y + u * (p1.y - p0.y) + v * (p2.y - p0.y));
        if (x >= 0 && y >= 0 && x < W && y < Hh) { const val = img.data[y * W + x]; if (Number.isFinite(val)) { sum += val; cnt++; } }
      }
      if (cnt) out[j * n + i] = sum / cnt;
    }
    const label = [H['FPA.TELESCOPE'] || H.TELESCOP, H['FPA.FILTER'] ? String(H['FPA.FILTER']).split('.')[0] : H.FILTER].filter(Boolean).join(' ') || name;
    (globalThis.__skyshiftUserLayers ||= new Map()).set(`${ra.toFixed(6)},${dec.toFixed(6)},${fov}`, { n, data: out, label, mjd, name });
    closeSheets();
    location.hash = `#/view?${toParams(normalise({ target: { ra, dec, name: `Your image: ${name}`.slice(0, 80), source: 'upload' }, fov, group: 'survey', ov: ['compass'] }))}`;
  }

  function measure(p) {
    const r = Math.max(3, Math.round((cal?.fwhm || 3) * 1.2));
    // snap to the brightest pixel near the click (within about two star widths), then find the light-weighted centre
    let px = p.x, py = p.y, best = -Infinity; const R = Math.max(4, Math.round((cal?.fwhm || 3) * 2));
    for (let y = Math.round(p.y) - R; y <= Math.round(p.y) + R; y++) for (let x = Math.round(p.x) - R; x <= Math.round(p.x) + R; x++) {
      if (x < 0 || y < 0 || x >= W || y >= Hh || Math.hypot(x - p.x, y - p.y) > R) continue;
      const v = img.data[y * W + x]; if (Number.isFinite(v) && v > best) { best = v; px = x; py = y; }
    }
    const c = centroid(img, px, py, r) || p;
    const rAp = cal?.rAp || 4, rIn = cal?.rIn || 8, rOut = cal?.rOut || 12;
    const a = aperture(img, c.x, c.y, rAp, rIn, rOut);
    const s = pixelToSky(img, c.x, c.y);
    const year = mjd ? mjdToYear(mjd) : null;
    let near = null;
    for (const g of gaia) {
      const q = year ? propagate(g.ra, g.dec, g.pmra || 0, g.pmdec || 0, g.ref_epoch || 2016, year) : g;
      const d = separation(s.ra, s.dec, q.ra, q.dec) * 3600;
      if (!near || d < near.d) near = { d, g };
    }
    const match = near && near.d <= Math.max(2, 1.5 * (cal?.fwhm || 2) * img.wcs.pixelScaleArcsec) ? near : null;
    const mg = magOf(a);
    const date = mjd ? precessFromJ2000(s.ra, s.dec, mjd + 2400000.5) : null;
    const m = { n: marks.length + 1, x: c.x, y: c.y, ra: s.ra, dec: s.dec, a, mg, match, date, centred: c !== p };
    marks.push(m); draw();
    results.prepend(h('div', { class: 'card', style: { padding: '10px', marginTop: '8px' } },
      h('b', {}, `Measurement ${m.n}${match ? ` · Gaia DR3 ${match.g.source_id}` : ''}`),
      h('dl', { class: 'kv' },
        h('dt', {}, 'RA, Dec (J2000.0)'), h('dd', {}, `${formatRA(s.ra)} ${formatDec(s.dec)}`, h('br'), `${s.ra.toFixed(6)}, ${s.dec.toFixed(6)}`, h('span', { class: 'note' }, m.centred ? `light-weighted centre (pixel ${(c.x + 1).toFixed(2)}, ${(c.y + 1).toFixed(2)})` : 'where you clicked (no clear peak to centre on)')),
        date ? [h('dt', {}, 'Equinox of date'), h('dd', {}, `${formatRA(date.ra)} ${formatDec(date.dec)}`, h('span', { class: 'note' }, `mean equinox of ${niceDateTime(new Date((mjd - 40587) * 86400000))}`))] : null,
        h('dt', {}, 'Magnitude'), h('dd', {}, mg.text, mg.z ? h('span', { class: 'note' }, mg.z.label) : h('span', { class: 'note' }, 'no calibration: too few Gaia stars and no zero point in the header')),
        h('dt', {}, 'Flux'), h('dd', {}, a ? `${a.flux.toPrecision(5)} ± ${a.err.toPrecision(3)} (S/N ${a.snr.toFixed(1)})` : 'no clean measurement', h('span', { class: 'note' }, `aperture ${rAp.toFixed(1)} px, background ring ${rIn.toFixed(1)}–${rOut.toFixed(1)} px`)),
        h('dt', {}, 'Pixels'), h('dd', {}, pixelTable(c)),
        h('dt', {}, 'Gaia DR3'), h('dd', {}, match ? `${match.g.source_id}, G = ${match.g.phot_g_mean_mag?.toFixed(2) ?? '–'}, ${match.d.toFixed(1)}″ away` : near ? `no star within ${Math.max(2, 1.5 * (cal?.fwhm || 2) * img.wcs.pixelScaleArcsec).toFixed(1)}″ (nearest ${near.d.toFixed(1)}″): possibly a new, moving or variable object; check it` : 'not loaded'))));
  }

  const exportCsv = () => {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [['n', 'image', 'date_utc', 'mjd', 'ra_deg', 'dec_deg', 'ra_hms', 'dec_dms', 'x_px', 'y_px', 'flux', 'flux_err', 'snr', 'mag', 'mag_err', 'calibration', 'gaia_dr3', 'gaia_sep_arcsec']];
    for (const m of marks) rows.push([m.n, name, mjd ? new Date((mjd - 40587) * 86400000).toISOString() : '', mjd ?? '', m.ra.toFixed(7), m.dec.toFixed(7), formatRA(m.ra), formatDec(m.dec), (m.x + 1).toFixed(2), (m.y + 1).toFixed(2), m.a?.flux ?? '', m.a?.err ?? '', m.a?.snr?.toFixed(2) ?? '', m.mg.mag?.toFixed(3) ?? '', m.mg.err?.toFixed(3) ?? '', m.mg.z?.label ?? '', m.match?.g.source_id ?? '', m.match?.d.toFixed(2) ?? '']);
    download(`${name.replace(/\.[^.]+$/, '')}-measurements.csv`, rows.map((r) => r.map(esc).join(',')).join('\n'), 'text/csv');
  };

  function sel(label, opts, key) {
    return h('label', { class: 'field', style: { minWidth: '120px' } }, label, h('select', { onchange: (e) => {
      disp[key] = e.target.value;
      if (key === 'limits' || key === 'cmap') applyLimits();
      if (key !== 'coords') { paint(); draw(); }
    } }, opts.map(([v, t]) => h('option', { value: v, selected: disp[key] === v }, t))));
  }

  sheet(h('div', { class: 'grid' },
    h('h2', {}, `Your image: ${name}`),
    frameNote(H) ? h('p', { class: 'notice warn tiny' }, frameNote(H)) : null,
    h('p', { class: 'tiny muted' }, `Coordinates: ${frameName(H)}. ${img.width}×${img.height} pixels, ${img.wcs.pixelScaleArcsec.toFixed(2)}″ per pixel${mjd ? `, taken ${niceDateTime(new Date((mjd - 40587) * 86400000))}` : ', no date in the header'}${H.TELESCOP ? `, ${H.TELESCOP}` : ''}${H.FILTER ? `, filter ${H.FILTER}` : ''}. User-supplied image, not SPHEREx data. North is up.`),
    imgBox, readout,
    h('div', { class: 'row', style: { gap: '8px' } },
      sel('Scale', [['linear', 'Linear'], ['sqrt', 'Square root'], ['log', 'Log'], ['asinh', 'Asinh'], ['histeq', 'Histogram equalised']], 'scale'),
      sel('Limits', [['zscale', 'zscale'], ['99.5', '99.5%'], ['minmax', 'Min–max']], 'limits'),
      sel('Colours', [['gray', 'Grey'], ['heat', 'Heat'], ['ice', 'Ice'], ['viridis', 'Viridis']], 'cmap'),
      sel('Coordinates', [['icrs', 'J2000.0 (ICRS)'], ['gal', 'Galactic'], ['ecl', 'Ecliptic (J2000.0)']], 'coords'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', onchange: (e) => { disp.negative = e.target.checked; paint(); draw(); } }), 'Invert'),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: true, onchange: (e) => { disp.magnifier = e.target.checked; if (!disp.magnifier) mag.style.display = 'none'; } }), 'Magnifier')),
    h('div', { class: 'row' },
      h('button', { class: 'btn small primary', type: 'button', title: 'Open the same patch of sky in the Time Machine with your image aligned to the SPHEREx frames, to blink between them', onclick: () => compareInTimeMachine() }, 'Compare with SPHEREx (Time Machine)'),
      h('button', { class: 'btn small', type: 'button', onclick: () => zoomAt(1.6) }, 'Zoom in'),
      h('button', { class: 'btn small', type: 'button', onclick: () => zoomAt(1 / 1.6) }, 'Zoom out'),
      h('button', { class: 'btn small', type: 'button', onclick: () => { view = { s: 1, x: 0, y: 0 }; draw(); } }, 'Whole image'),
      h('button', { class: 'btn small', type: 'button', onclick: () => (marks.length ? exportCsv() : toast({ title: 'Nothing measured yet', text: 'Click an object in the image first.', glyph: 'ℹ️', timeout: 3000 })) }, 'Download measurements (CSV)')),
    calLine, results), { label: 'Your image' });
  requestAnimationFrame(() => { fit(); draw(); });
  new ResizeObserver(() => { fit(); draw(); }).observe(canvas);

  // calibration on Gaia DR3 stars in the image
  try {
    const c = pixelToSky(img, img.width / 2, img.height / 2);
    const radius = Math.min(1, (Math.hypot(img.width, img.height) / 2) * img.wcs.pixelScaleArcsec / 3600);
    gaia = (await gaiaCone(c.ra, c.dec, radius)).data?.rows || [];
    cal = calibrate(img, gaia, mjd);
    const hz = headerZeroPoint(H);
    calLine.textContent = cal.ok
      ? `Calibrated on ${cal.n} Gaia DR3 stars: zero point ${cal.zp.toFixed(3)} ± ${cal.err.toFixed(3)} (G band; star-to-star scatter ${cal.scatter.toFixed(2)} mag, larger when the image’s filter differs from Gaia G). Star width ${cal.fwhm.toFixed(1)} px (${(cal.fwhm * img.wcs.pixelScaleArcsec).toFixed(1)}″).${hz ? ` The header also gives ${hz.key} = ${hz.zp}.` : ''}`
      : `Only ${cal.n} isolated, unsaturated Gaia DR3 stars could be measured (5 are needed)${hz ? `: using the header zero point ${hz.key} = ${hz.zp}` : ': magnitudes are not calibrated; fluxes are still given'}.`;
    draw();
  } catch (e) {
    calLine.textContent = `Gaia DR3 could not be loaded (${e.message}); ${headerZeroPoint(H) ? 'using the zero point in the header.' : 'fluxes are given without calibration.'}`;
  }
}
