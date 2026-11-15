// Inspector for the user's own FITS image: hover for coordinates and pixel values, click to measure an object
// (centroid, J2000 and equinox-of-date coordinates, magnitude calibrated on Gaia DR3 stars, nearest Gaia star) and
// export the measurements. Runs on the device; Gaia DR3 comes from MAST (or IRSA) through the archive layer.

import { h, sheet, toast, download } from './dom.js';
import { formatRA, formatDec, precessFromJ2000, niceDateTime, propagate, mjdToYear, separation } from '../lib/coords.js';
import { readFitsImage, pixelToSky, imageMjd, imageStats, centroid, aperture, calibrate, headerZeroPoint } from '../lib/userimage.js';
import { gaiaCone } from '../lib/tap.js';

/** Open the inspector for a FITS file (ArrayBuffer, gzip allowed). */
export async function inspectImage(buf, name) {
  let bytes = new Uint8Array(buf);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) bytes = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  let img;
  try { img = readFitsImage(bytes); } catch (e) { toast({ title: 'This image cannot be inspected', text: e.message, glyph: '⚠️', timeout: 7000 }); return; }
  const H = img.header, mjd = imageMjd(H), st = imageStats(img);
  const sorted = st.sample.slice().sort((a, b) => a - b);
  let lo = sorted[Math.floor(sorted.length * 0.005)], hi = sorted[Math.floor(sorted.length * 0.997)];
  if (!(hi > lo)) hi = lo + 1;

  // full-resolution rendering, north up (FITS row 1 is at the bottom)
  const off = document.createElement('canvas'); off.width = img.width; off.height = img.height;
  const paint = () => {
    const id = off.getContext('2d').createImageData(img.width, img.height), a = Math.asinh(10);
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
      const v = img.data[y * img.width + x], k = ((img.height - 1 - y) * img.width + x) * 4;
      const t = Number.isFinite(v) ? Math.asinh(10 * Math.min(1, Math.max(0, (v - lo) / (hi - lo)))) / a : 0;
      const c = Math.round(t * 255); id.data[k] = c; id.data[k + 1] = c; id.data[k + 2] = c; id.data[k + 3] = 255;
    }
    off.getContext('2d').putImageData(id, 0, 0);
  };
  paint();

  const canvas = h('canvas', { style: { width: '100%', aspectRatio: `${img.width} / ${img.height}`, maxHeight: '62vh', background: '#05061a', borderRadius: '8px', cursor: 'crosshair', touchAction: 'none' }, 'aria-label': 'Your image: hover for coordinates, click to measure' });
  const readout = h('div', { class: 'tiny', style: { fontFamily: 'var(--mono)', minHeight: '1.4em' } }, 'Move over the image for coordinates; click a star or object to measure it.');
  const calLine = h('p', { class: 'tiny' }, 'Calibrating on Gaia DR3 stars in the image…');
  const results = h('div');
  const marks = [];
  let view = { s: 1, x: 0, y: 0 }; // zoom and top-left of the visible part (image pixels, display orientation)
  let cal = null, gaia = [];

  const fit = () => { const r = canvas.getBoundingClientRect(); const dpr = Math.min(2, devicePixelRatio || 1); canvas.width = Math.max(50, Math.round(r.width * dpr)); canvas.height = Math.round(canvas.width * img.height / img.width); };
  const draw = () => {
    const ctx = canvas.getContext('2d'), k = (canvas.width / img.width) * view.s;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = view.s < 2;
    ctx.setTransform(k, 0, 0, k, -view.x * k, -view.y * k); ctx.drawImage(off, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.strokeStyle = '#ffb547'; ctx.lineWidth = 1.5; ctx.font = '12px system-ui'; ctx.fillStyle = '#ffb547';
    marks.forEach((m, i) => {
      const cx = (m.x - view.x) * k, cy = (img.height - 1 - m.y - view.y) * k, r = Math.max(6, (cal?.rAp || 4) * k);
      ctx.beginPath(); ctx.arc(cx, cy, r, 0, 2 * Math.PI); ctx.stroke(); ctx.fillText(String(i + 1), cx + r + 3, cy - r);
    });
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
    if (p.x < 0 || p.y < 0 || p.x >= img.width || p.y >= img.height) return;
    const s = pixelToSky(img, p.x, p.y), v = img.data[Math.floor(p.y) * img.width + Math.floor(p.x)];
    readout.textContent = `${formatRA(s.ra)} ${formatDec(s.dec)} (J2000) · ${s.ra.toFixed(6)}, ${s.dec.toFixed(6)} · pixel ${(p.x + 1).toFixed(1)}, ${(p.y + 1).toFixed(1)} · ${Number.isFinite(v) ? v.toPrecision(5) : 'no data'}${H.BUNIT ? ' ' + H.BUNIT : ''}`;
  });
  canvas.addEventListener('pointerup', (e) => { const d = drag; drag = null; if (d && !d.moved) measure(toPixel(e)); });
  canvas.addEventListener('wheel', (e) => { e.preventDefault(); const p = toPixel(e); zoomAt(e.deltaY < 0 ? 1.4 : 1 / 1.4, p.x, p.y); }, { passive: false });

  const magOf = (a) => {
    const z = cal?.ok ? { zp: cal.zp, err: cal.err, label: `Gaia G-band equivalent, calibrated on ${cal.n} Gaia DR3 stars` } : headerZeroPoint(H) ? { zp: headerZeroPoint(H).zp, err: 0, label: `zero point from the header (${headerZeroPoint(H).key})` } : null;
    if (!z || !a) return { text: '–', z };
    if (a.snr < 3) return { text: `not detected (S/N ${a.snr.toFixed(1)}): fainter than ${(z.zp - 2.5 * Math.log10(3 * a.err)).toFixed(2)} (3σ)`, z };
    const m = z.zp - 2.5 * Math.log10(a.flux), e = Math.sqrt(z.err ** 2 + (1.0857 * a.err / a.flux) ** 2);
    const sat = a.peak >= (cal?.saturation ?? Infinity);
    return { text: `${sat ? '≤ ' : ''}${m.toFixed(2)} ± ${e < 0.005 ? '<0.01' : e.toFixed(2)}${sat ? ' (saturated: brighter than this)' : ''}`, mag: m, err: e, z, sat };
  };

  function measure(p) {
    const r = Math.max(3, Math.round((cal?.fwhm || 3) * 1.2));
    const c = centroid(img, p.x, p.y, r) || p;
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
        h('dt', {}, 'RA, Dec (J2000)'), h('dd', {}, `${formatRA(s.ra)} ${formatDec(s.dec)}`, h('br'), `${s.ra.toFixed(6)}, ${s.dec.toFixed(6)}`, h('span', { class: 'note' }, m.centred ? `light-weighted centre (pixel ${(c.x + 1).toFixed(2)}, ${(c.y + 1).toFixed(2)})` : 'where you clicked (no clear peak to centre on)')),
        date ? [h('dt', {}, 'Equinox of date'), h('dd', {}, `${formatRA(date.ra)} ${formatDec(date.dec)}`, h('span', { class: 'note' }, `mean equinox of ${niceDateTime(new Date((mjd - 40587) * 86400000))}`))] : null,
        h('dt', {}, 'Magnitude'), h('dd', {}, mg.text, mg.z ? h('span', { class: 'note' }, mg.z.label) : h('span', { class: 'note' }, 'no calibration: too few Gaia stars and no zero point in the header')),
        h('dt', {}, 'Flux'), h('dd', {}, a ? `${a.flux.toPrecision(5)} ± ${a.err.toPrecision(3)} (S/N ${a.snr.toFixed(1)})` : 'no clean measurement', h('span', { class: 'note' }, `aperture ${rAp.toFixed(1)} px, background ring ${rIn.toFixed(1)}–${rOut.toFixed(1)} px`)),
        h('dt', {}, 'Gaia DR3'), h('dd', {}, match ? `${match.g.source_id}, G = ${match.g.phot_g_mean_mag?.toFixed(2) ?? '–'}, ${match.d.toFixed(1)}″ away` : near ? `no star within ${Math.max(2, 1.5 * (cal?.fwhm || 2) * img.wcs.pixelScaleArcsec).toFixed(1)}″ (nearest ${near.d.toFixed(1)}″): possibly a new, moving or variable object; check it` : 'not loaded'))));
  }

  const exportCsv = () => {
    const esc = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = [['n', 'image', 'date_utc', 'mjd', 'ra_deg', 'dec_deg', 'ra_hms', 'dec_dms', 'x_px', 'y_px', 'flux', 'flux_err', 'snr', 'mag', 'mag_err', 'calibration', 'gaia_dr3', 'gaia_sep_arcsec']];
    for (const m of marks) rows.push([m.n, name, mjd ? new Date((mjd - 40587) * 86400000).toISOString() : '', mjd ?? '', m.ra.toFixed(7), m.dec.toFixed(7), formatRA(m.ra), formatDec(m.dec), (m.x + 1).toFixed(2), (m.y + 1).toFixed(2), m.a?.flux ?? '', m.a?.err ?? '', m.a?.snr?.toFixed(2) ?? '', m.mg.mag?.toFixed(3) ?? '', m.mg.err?.toFixed(3) ?? '', m.mg.z?.label ?? '', m.match?.g.source_id ?? '', m.match?.d.toFixed(2) ?? '']);
    download(`${name.replace(/\.[^.]+$/, '')}-measurements.csv`, rows.map((r) => r.map(esc).join(',')).join('\n'), 'text/csv');
  };

  sheet(h('div', { class: 'grid' },
    h('h2', {}, `Your image: ${name}`),
    h('p', { class: 'tiny muted' }, `${img.width}×${img.height} pixels, ${img.wcs.pixelScaleArcsec.toFixed(2)}″ per pixel${mjd ? `, taken ${niceDateTime(new Date((mjd - 40587) * 86400000))}` : ', no date in the header'}${H.TELESCOP ? `, ${H.TELESCOP}` : ''}${H.FILTER ? `, filter ${H.FILTER}` : ''}. User-supplied image, not SPHEREx data. North is up.`),
    canvas, readout,
    h('div', { class: 'row' },
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
