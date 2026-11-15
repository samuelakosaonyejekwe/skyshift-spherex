// Auto-generated dossier: a self-contained, reproducible record of one analysis, built in the
// browser from real results only. Outputs: print-ready HTML (A4 / US Letter via the browser's
// "Save as PDF"), and a ZIP bundle with figures (PNG + SVG), an animated PNG, data tables
// (CSV + VOTable), FITS cutouts of the displayed frames and the SkyRequest JSON.

import { formatRA, formatDec, mjdToISO, mjdToYear, apparent } from './coords.js';
import { NATIVE_SCALE } from './engine.js';
import { paint, paintDiff, paintRGB, limits, detectorBalanced, matchedDifference, tintName } from './render.js';
import { decodeFlags, uriToS3 } from './spherex.js';
import { questionable, epochBrightness } from './discover.js';
import { toParams, normalise } from '../state.js';

export const DOIS = { dr1: '10.26131/IRSA678', qr3: '10.26131/IRSA662', qr2: '10.26131/IRSA652' };
export const SPHEREX_ACK = 'This publication makes use of data products from the Spectro-Photometer for the History of the Universe, Epoch of Reionization and Ices Explorer (SPHEREx), which is a joint project of the Jet Propulsion Laboratory and the California Institute of Technology, and is funded by the National Aeronautics and Space Administration.';
const COPYRIGHT = '© 2026 SkyShift · Apache-2.0';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Stable dossier ID: hash of normalised inputs + data releases + software version + exposures used. */
export async function dossierId({ req, exposures, version, inputs }) {
  const r = normalise(req);
  const stable = { ...r, t: 0, speed: 0, embed: false };
  const releases = [...new Set(exposures.map((e) => e.meta.release))].sort();
  const uris = exposures.map((e) => e.meta.uri).sort();
  const payload = JSON.stringify({ request: stable, releases, version, uris, inputs: inputs || null });
  return (await sha256Hex(payload)).slice(0, 16);
}

/**
 * Measured proper motion of the target from all epoch co-adds: iterative Gaussian-weighted
 * centroids (kept within 1.5 px of the predicted position, so neighbours are not picked up),
 * then a weighted straight-line fit of position against time. Uncertainty from the fit
 * residuals when there are 3+ epochs, otherwise from the centroid noise.
 */
export function measureMotion(display, grid, req) {
  const D = display;
  if (!D?.dmaps || D.groups.length < 2) return null;
  const hasPm = !!(req.target.pmra || req.target.pmdec);
  const N = grid.n, D2R = Math.PI / 180;
  const mid = (g) => g.reduce((a, e) => a + e.meta.mjd, 0) / g.length;
  const pred = (m) => {
    const p = apparent(req.target.ra, req.target.dec, req.target.pmra || 0, req.target.pmdec || 0, req.target.plx || 0, req.target.refEpoch || 2016, m);
    const d0 = grid.dec * D2R, da = (p.ra - grid.ra) * D2R, d = p.dec * D2R;
    const cosc = Math.sin(d0) * Math.sin(d) + Math.cos(d0) * Math.cos(d) * Math.cos(da);
    const xi = (Math.cos(d) * Math.sin(da)) / cosc / D2R * 3600, eta = (Math.cos(d0) * Math.sin(d) - Math.sin(d0) * Math.cos(d) * Math.cos(da)) / cosc / D2R * 3600;
    const c = (N - 1) / 2;
    return [c - xi / grid.scale, c - eta / grid.scale];
  };
  const sigPx = 1.2 * (NATIVE_SCALE / grid.scale); // PSF-like weighting width in grid pixels
  const centroid = (img, [px, py]) => {
    // local background and noise from a ring
    const ring = [];
    for (let j = Math.round(py) - 9; j <= Math.round(py) + 9; j++) for (let i = Math.round(px) - 9; i <= Math.round(px) + 9; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) continue;
      const d = Math.hypot(i - px, j - py), v = img[j * N + i];
      if (d > 5 && d < 9 && Number.isFinite(v)) ring.push(v);
    }
    if (ring.length < 10) return null;
    ring.sort((a, b) => a - b);
    const bg = ring[ring.length >> 1];
    const noise = 1.4826 * ring.map((v) => Math.abs(v - bg)).sort((a, b) => a - b)[ring.length >> 1] || 1e-6;
    let x = px, y = py, nan = 0, s = 0, peak = 0;
    for (let it = 0; it < 8; it++) {
      let sx = 0, sy = 0; s = 0; nan = 0; peak = 0;
      for (let j = Math.round(y) - 4; j <= Math.round(y) + 4; j++) for (let i = Math.round(x) - 4; i <= Math.round(x) + 4; i++) {
        if (i < 0 || j < 0 || i >= N || j >= N) continue;
        const v = img[j * N + i];
        if (!Number.isFinite(v)) { nan++; continue; }
        const wgt = Math.exp(-((i - x) ** 2 + (j - y) ** 2) / (2 * sigPx * sigPx)) * Math.max(0, v - bg);
        peak = Math.max(peak, v - bg);
        sx += wgt * i; sy += wgt * j; s += wgt;
      }
      if (s <= 0) return null;
      const nx = sx / s, ny = sy / s;
      // stay near the prediction (protects against neighbours and noise)
      const dx = nx - px, dy = ny - py, r = Math.hypot(dx, dy);
      const lim = 1.5 * (NATIVE_SCALE / grid.scale);
      x = r > lim ? px + (dx / r) * lim : nx; y = r > lim ? py + (dy / r) * lim : ny;
      if (Math.abs(nx - x) < 1e-3 && Math.abs(ny - y) < 1e-3) break;
    }
    const snr = peak / noise;
    if (snr < 4 && !nan) return null;
    // centroid noise ≈ PSF width / S/N (floor 0.05 px)
    return { x, y, nan, snr, err: Math.max(0.05, (sigPx * 1.2) / Math.max(1, snr)) };
  };
  // annual parallax shift (grid pixels) at a date, so the fit measures proper motion only
  const plx = req.target.plx || 0;
  const plxShift = (m) => {
    if (!plx) return [0, 0];
    const a = apparent(req.target.ra, req.target.dec, 0, 0, plx, 2016, m);
    const dra = ((a.ra - req.target.ra + 540) % 360 - 180) * Math.cos((req.target.dec * Math.PI) / 180) * 3600;
    const ddec = (a.dec - req.target.dec) * 3600;
    return [-dra / grid.scale, -ddec / grid.scale]; // grid x grows west, y grows south
  };
  const pts = [];
  D.groups.forEach((g, i) => {
    const img = detectorBalanced(D.dmaps[i], N);
    const t = mid(g), c = centroid(img, pred(t));
    if (c) { const [sx, sy] = plxShift(t); pts.push({ t: mjdToYear(t), ...c, x: c.x - sx, y: c.y - sy, plxShiftArcsec: Math.hypot(sx, sy) * grid.scale, date: mjdToISO(t, false) }); }
  });
  if (pts.length < 2) return null;
  // weighted least squares x = a + b t, y = c + d t
  const fit = (key) => {
    let S = 0, St = 0, Sx = 0, Stt = 0, Stx = 0;
    for (const p of pts) { const w = 1 / p.err ** 2; S += w; St += w * p.t; Sx += w * p[key]; Stt += w * p.t * p.t; Stx += w * p.t * p[key]; }
    const den = S * Stt - St * St;
    const slope = (S * Stx - St * Sx) / den, icpt = (Sx - slope * St) / S;
    let err = Math.sqrt(S / den);
    if (pts.length >= 3) {
      const chi2 = pts.reduce((a, p) => a + ((p[key] - icpt - slope * p.t) / p.err) ** 2, 0) / (pts.length - 2);
      err *= Math.sqrt(Math.max(1, chi2));
    }
    return { slope, err };
  };
  const fx = fit('x'), fy = fit('y');
  const muRa = -fx.slope * grid.scale * 1000, muDec = -fy.slope * grid.scale * 1000; // grid x grows west, y south
  const unc = Math.hypot(fx.err, fy.err) / Math.SQRT2 * grid.scale * 1000;
  const dt = pts[pts.length - 1].t - pts[0].t;
  return {
    dtYears: dt, nEpochs: pts.length, measured: { pmra: muRa, pmdec: muDec }, predicted: hasPm ? { pmra: req.target.pmra, pmdec: req.target.pmdec } : null,
    residual: hasPm ? { pmra: muRa - req.target.pmra, pmdec: muDec - req.target.pmdec } : null, uncertainty: unc,
    errRa: fx.err * grid.scale * 1000, errDec: fy.err * grid.scale * 1000,
    saturatedCore: pts.some((p) => p.nan), epochs: [pts[0].date, pts[pts.length - 1].date],
    parallaxRemoved: !!plx, maxParallaxShift: Math.max(0, ...pts.map((p) => p.plxShiftArcsec || 0)),
  };
}

// ------------------------------------------------------------------ figures
function frameCanvas(data, N, lims, kind, opts, scale = 6, grid = null, caption = '') {
  const c = document.createElement('canvas');
  const W = N * scale, foot = 34;
  c.width = W; c.height = W + foot;
  const ctx = c.getContext('2d');
  const off = document.createElement('canvas'); off.width = N; off.height = N;
  const im = off.getContext('2d').createImageData(N, N);
  if (kind === 'rgb') paintRGB(data, im.data, lims, opts); else if (kind === 'diff') paintDiff(data, im.data, lims, opts); else paint(data, im.data, lims, opts);
  off.getContext('2d').putImageData(im, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.fillStyle = '#0b0e24'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(off, 0, 0, W, W);
  // compass and scale bar
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 2; ctx.font = '600 13px system-ui, sans-serif';
  const x0 = W - 30, y0 = W - 30;
  ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x0, y0 - 22); ctx.moveTo(x0, y0); ctx.lineTo(x0 - 22, y0); ctx.stroke();
  ctx.fillText('N', x0 - 4, y0 - 26); ctx.fillText('E', x0 - 36, y0 + 5);
  if (grid) {
    const arcsecPerPx = grid.scale / scale;
    const L = [10, 30, 60, 120, 300, 600].find((a) => a / arcsecPerPx > 50) || 600;
    ctx.fillRect(10, W - 14, L / arcsecPerPx, 3);
    ctx.fillText(L >= 60 ? `${L / 60}′` : `${L}″`, 10, W - 20);
  }
  ctx.fillStyle = '#dfe3ff'; ctx.font = '13px system-ui, sans-serif';
  ctx.fillText(caption.slice(0, Math.floor(W / 7)), 6, W + 22);
  return c;
}
const toPng = (canvas) => new Promise((res) => canvas.toBlob((b) => res(b), 'image/png'));
async function blobToDataURL(b) { return new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(b); }); }

/** Colour bar for mono figures. */
function colourBar(lims, kind, opts) {
  const c = document.createElement('canvas'); c.width = 360; c.height = 46;
  const ctx = c.getContext('2d');
  const N = 256, row = new Float32Array(N);
  for (let i = 0; i < N; i++) row[i] = lims[0] + ((lims[1] - lims[0]) * i) / (N - 1);
  const off = document.createElement('canvas'); off.width = N; off.height = 1;
  const im = off.getContext('2d').createImageData(N, 1);
  if (kind === 'diff') paintDiff(row, im.data, lims, opts); else paint(row, im.data, lims, opts);
  off.getContext('2d').putImageData(im, 0, 0);
  ctx.fillStyle = '#0b0e24'; ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingEnabled = false; ctx.drawImage(off, 10, 4, 340, 16);
  ctx.fillStyle = '#dfe3ff'; ctx.font = '12px system-ui, sans-serif';
  ctx.fillText(`${lims[0].toPrecision(3)}`, 10, 38); ctx.fillText(`${lims[1].toPrecision(3)} MJy/sr`, 250, 38);
  return c;
}

// ------------------------------------------------------------------ data files
export function writeFitsImage(data, N, grid, cards = {}) {
  const head = [];
  const card = (k, v, c = '') => {
    let val = typeof v === 'string' ? `'${v.replace(/'/g, "''").padEnd(8)}'` : typeof v === 'boolean' ? (v ? 'T' : 'F') : Number.isInteger(v) ? String(v) : Number(v).toExponential(12).toUpperCase();
    if (typeof v !== 'string') val = val.padStart(20);
    head.push(`${k.padEnd(8)}= ${val}${c ? ` / ${c}` : ''}`.slice(0, 80).padEnd(80));
  };
  card('SIMPLE', true); card('BITPIX', -32); card('NAXIS', 2); card('NAXIS1', N); card('NAXIS2', N);
  card('CTYPE1', 'RA---TAN'); card('CTYPE2', 'DEC--TAN'); card('CRVAL1', grid.ra); card('CRVAL2', grid.dec);
  card('CRPIX1', (N + 1) / 2); card('CRPIX2', (N + 1) / 2); card('CDELT1', -grid.scale / 3600); card('CDELT2', grid.scale / 3600);
  card('CUNIT1', 'deg'); card('CUNIT2', 'deg'); card('RADESYS', 'ICRS'); card('BUNIT', 'MJy/sr');
  for (const [k, v] of Object.entries(cards)) card(k, v);
  card('ORIGIN', 'SkyShift', 'resampled SPHEREx data (IRSA)');
  head.push('END'.padEnd(80));
  while (head.length % 36) head.push(' '.repeat(80));
  const hdr = new TextEncoder().encode(head.join(''));
  const n = N * N, bytes = Math.ceil((n * 4) / 2880) * 2880;
  const body = new Uint8Array(bytes);
  const dv = new DataView(body.buffer);
  // FITS rows go bottom-up; display rows are top-down
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) dv.setFloat32(((N - 1 - j) * N + i) * 4, data[j * N + i], false);
  const out = new Uint8Array(hdr.length + body.length); out.set(hdr); out.set(body, hdr.length);
  return out;
}

export function votable(name, columns, rows) {
  const x = ['<?xml version="1.0" encoding="UTF-8"?>', '<VOTABLE version="1.4" xmlns="http://www.ivoa.net/xml/VOTable/v1.3">', `<RESOURCE><TABLE name="${esc(name)}">`];
  for (const c of columns) x.push(`<FIELD name="${esc(c.name)}" datatype="${c.type || 'char'}"${c.type === 'char' || !c.type ? ' arraysize="*"' : ''}${c.unit ? ` unit="${esc(c.unit)}"` : ''}/>`);
  x.push('<DATA><TABLEDATA>');
  for (const r of rows) x.push(`<TR>${r.map((v) => `<TD>${esc(v)}</TD>`).join('')}</TR>`);
  x.push('</TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>');
  return x.join('\n');
}

// ------------------------------------------------------------------ APNG (animated PNG) writer
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export function crc32(buf, crc = 0xffffffff) { for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4); out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
export async function apng(canvases, delayMs) {
  const W = canvases[0].width, H = canvases[0].height;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])];
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, W); dv.setUint32(4, H); ihdr[8] = 8; ihdr[9] = 6;
  parts.push(chunk('IHDR', ihdr));
  const actl = new Uint8Array(8); new DataView(actl.buffer).setUint32(0, canvases.length); parts.push(chunk('acTL', actl));
  let seqn = 0;
  for (let f = 0; f < canvases.length; f++) {
    const px = canvases[f].getContext('2d').getImageData(0, 0, W, H).data;
    const raw = new Uint8Array((W * 4 + 1) * H);
    for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; raw.set(px.subarray(y * W * 4, (y + 1) * W * 4), y * (W * 4 + 1) + 1); }
    const z = await deflate(raw);
    const fc = new Uint8Array(26); const fv = new DataView(fc.buffer);
    fv.setUint32(0, seqn++); fv.setUint32(4, W); fv.setUint32(8, H); fv.setUint32(12, 0); fv.setUint32(16, 0);
    fv.setUint16(20, delayMs); fv.setUint16(22, 1000); fc[24] = 0; fc[25] = 0;
    parts.push(chunk('fcTL', fc));
    if (f === 0) parts.push(chunk('IDAT', z));
    else { const fd = new Uint8Array(4 + z.length); new DataView(fd.buffer).setUint32(0, seqn++); fd.set(z, 4); parts.push(chunk('fdAT', fd)); }
  }
  parts.push(chunk('IEND', new Uint8Array()));
  return new Blob(parts, { type: 'image/apng' });
}

// ------------------------------------------------------------------ ZIP writer (stored entries)
export async function zip(files) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let off = 0;
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  for (const f of files) {
    const data = f.data instanceof Uint8Array ? f.data : typeof f.data === 'string' ? enc.encode(f.data) : new Uint8Array(await f.data.arrayBuffer());
    const name = enc.encode(f.name);
    const crc = crc32(data);
    const lh = new Uint8Array(30 + name.length); const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x0800, true); lv.setUint16(8, 0, true);
    lv.setUint16(10, dosTime, true); lv.setUint16(12, dosDate, true); lv.setUint32(14, crc, true); lv.setUint32(18, data.length, true); lv.setUint32(22, data.length, true);
    lv.setUint16(26, name.length, true); lh.set(name, 30);
    chunks.push(lh, data);
    const ch = new Uint8Array(46 + name.length); const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x0800, true); cv.setUint16(10, 0, true);
    cv.setUint16(12, dosTime, true); cv.setUint16(14, dosDate, true); cv.setUint32(16, crc, true); cv.setUint32(20, data.length, true); cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true); cv.setUint32(42, off, true); ch.set(name, 46);
    central.push(ch);
    off += lh.length + data.length;
  }
  const cdSize = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22); const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, files.length, true); ev.setUint16(10, files.length, true); ev.setUint32(12, cdSize, true); ev.setUint32(16, off, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}

// ------------------------------------------------------------------ the dossier itself
/**
 * snap = { req, grid, display, frames (array of loaded exposures), phot (points), cats, movers, variables,
 *          version, specSvg, lcSvg, inputs, candidates }
 */
export async function buildDossier(snap) {
  const { req, grid, display: D } = snap;
  const N = grid.n;
  const exps = snap.frames;
  const id = await dossierId({ req, exposures: exps, version: snap.version, inputs: snap.inputs });
  const generated = new Date().toISOString();
  const name = req.target.name || `${formatRA(req.target.ra)} ${formatDec(req.target.dec)}`;
  const files = [];
  const figs = [];
  let figNo = 0;
  const opts = { stretch: req.stretch, cmap: req.cmap === 'auto' ? (req.invert ? 'gray' : tintName(req.dets)) : req.cmap, invert: req.invert };
  const addFig = async (canvas, file, caption) => {
    const blob = await toPng(canvas);
    files.push({ name: `figures/${file}.png`, data: blob });
    figs.push({ n: ++figNo, src: await blobToDataURL(blob), caption, file });
  };
  const groups = D.groups;
  const mono = groups.map((g, i) => detectorBalanced(D.dmaps[i], N));
  const monoLims = limits(mono, req.lo, req.hi);
  const dates = groups.map((g) => { const m = g.map((e) => e.meta.mjd); return [Math.min(...m), Math.max(...m)]; });
  // 1. sequence strip (up to 8 epochs)
  const stripIdx = groups.length <= 8 ? groups.map((_, i) => i) : Array.from({ length: 8 }, (_, k) => Math.round((k * (groups.length - 1)) / 7));
  const seqCanvases = stripIdx.map((i) => frameCanvas(mono[i], N, monoLims, 'mono', opts, Math.max(2, Math.round(240 / N)), grid, `${i + 1}: ${mjdToISO(dates[i][0], false)} (${groups[i].length} exp.)`));
  const strip = document.createElement('canvas');
  strip.width = seqCanvases.reduce((a, c) => a + c.width + 6, 0); strip.height = seqCanvases[0].height;
  const sctx = strip.getContext('2d'); sctx.fillStyle = '#0b0e24'; sctx.fillRect(0, 0, strip.width, strip.height);
  let sx = 0; for (const c of seqCanvases) { sctx.drawImage(c, sx, 0); sx += c.width + 6; }
  await addFig(strip, 'sequence', `Image sequence: ${groups.length} ${req.group === 'survey' ? 'six-month survey co-adds' : req.group === 'day' ? 'daily co-adds' : 'exposures'} of ${req.fov}′ × ${req.fov}′ around ${name}, detectors ${req.dets.map((d) => 'D' + d).join(', ')}, shared ${req.stretch} stretch (${monoLims[0].toPrecision(3)} to ${monoLims[1].toPrecision(3)} MJy/sr). North up, east left.`);
  const cb = colourBar(monoLims, 'mono', opts);
  await addFig(cb, 'colourbar', 'Colour bar for the sequence and blink figures (background-subtracted surface brightness, MJy/sr).');
  // 2. blink pair
  if (groups.length >= 2) {
    const a = 0, b = groups.length - 1, sc = Math.max(3, Math.round(360 / N));
    const pair = document.createElement('canvas');
    const ca = frameCanvas(mono[a], N, monoLims, 'mono', opts, sc, grid, `A: ${mjdToISO(dates[a][0], false)}`), cbv = frameCanvas(mono[b], N, monoLims, 'mono', opts, sc, grid, `B: ${mjdToISO(dates[b][0], false)}`);
    pair.width = ca.width * 2 + 8; pair.height = ca.height;
    const pc = pair.getContext('2d'); pc.fillStyle = '#0b0e24'; pc.fillRect(0, 0, pair.width, pair.height); pc.drawImage(ca, 0, 0); pc.drawImage(cbv, ca.width + 8, 0);
    await addFig(pair, 'blink-pair', `Blink pair: first (A) and last (B) epochs, ${(mjdToYear(dates[b][0]) - mjdToYear(dates[a][0])).toFixed(2)} years apart. A moving object changes position between A and B.`);
    files.push({ name: 'figures/blink.png', data: await apng([ca, cbv], 700) });
    // 3. difference
    const diff = matchedDifference(D.dmaps[b], D.dmaps[a], N);
    if (diff.dets.length) {
      const dl = limits([diff.data], req.lo, req.hi, true);
      await addFig(frameCanvas(diff.data, N, dl, 'diff', opts, sc, grid, `B − A (${diff.dets.map((d) => 'D' + d).join(' ')})`), 'difference',
        `Difference image: last minus first epoch, matched detector by detector (wavelength-matched). Grey = no change; a dark/bright pair = motion; a single spot = brightness change. Scale ±${dl[1].toPrecision(3)} MJy/sr.`);
      files.push({ name: 'fits/difference.fits', data: writeFitsImage(diff.data, N, grid, { DATE: generated.slice(0, 19), OBJECT: name.slice(0, 60), COMMENT: 'last minus first epoch' }) });
    }
  }
  // 4. false colour (last epoch)
  const last = groups.length - 1;
  const rgb = [detectorBalanced(D.dmaps[last], N, [5, 6]), detectorBalanced(D.dmaps[last], N, [3, 4]), detectorBalanced(D.dmaps[last], N, [1, 2])];
  if (rgb.some((c) => c.some(Number.isFinite))) {
    const rl = [0, 1, 2].map((c) => limits([rgb[c]], req.lo, req.hi));
    await addFig(frameCanvas(rgb, N, rl, 'rgb', { stretch: req.stretch }, Math.max(3, Math.round(360 / N)), grid, `False colour, ${mjdToISO(dates[last][0], false)}`), 'false-colour',
      'False-colour composite of the latest epoch: blue = D1–D2 (0.75–1.62 µm), green = D3–D4 (1.63–3.82 µm), red = D5–D6 (3.83–5.00 µm). Cold, molecule-rich objects such as brown dwarfs appear red.');
  }
  // 5. animation of all epochs
  if (groups.length >= 2) {
    const sc = Math.max(2, Math.round(300 / N));
    files.push({ name: 'figures/sequence-animation.png', data: await apng(groups.map((g, i) => frameCanvas(mono[i], N, monoLims, 'mono', opts, sc, grid, `${i + 1}/${groups.length} ${mjdToISO(dates[i][0], false)}`)), Math.min(2000, Math.max(200, req.speed))) });
  }
  // FITS cutouts of every epoch co-add
  // with tracking on, each epoch is drawn around the target's position on that date, so that is its sky centre
  const gridAt = (i) => {
    if (!req.track) return grid;
    const p = apparent(req.target.ra, req.target.dec, req.target.pmra || 0, req.target.pmdec || 0, req.target.plx || 0, req.target.refEpoch || 2016, (dates[i][0] + dates[i][1]) / 2);
    return { ...grid, ra: p.ra, dec: p.dec };
  };
  mono.forEach((img, i) => files.push({ name: `fits/epoch-${String(i + 1).padStart(2, '0')}.fits`, data: writeFitsImage(img, N, gridAt(i), { 'DATE-OBS': mjdToISO(dates[i][0]).replace(' UTC', '').replace(' ', 'T'), MJD_BEG: dates[i][0], MJD_END: dates[i][1], NEXP: groups[i].length, OBJECT: name.slice(0, 60) }) }));
  // 6. charts
  if (snap.specSvg) { files.push({ name: 'figures/spectrum.svg', data: snap.specSvg }); figs.push({ n: ++figNo, svg: snap.specSvg, caption: `Spectrum of ${name} from ${snap.phot.length} exposures (aperture photometry at the predicted position, 15″ radius). Hollow points are questionable (saturated core or >20% masked). Dashed lines: spectral lines stated in the IRSA SPHEREx documentation.`, file: 'spectrum' }); }
  if (snap.lcSvg) { files.push({ name: 'figures/lightcurve.svg', data: snap.lcSvg }); figs.push({ n: ++figNo, svg: snap.lcSvg, caption: `Light curve of ${name}: brightness relative to its average spectrum, coloured by detector.`, file: 'lightcurve' }); }

  // ---------- numbers
  const pts = snap.phot;
  const eb = epochBrightness(pts);
  // tracked frames keep the target fixed on purpose, so its motion cannot be measured from them
  const motion = req.track ? null : measureMotion(D, grid, req);
  const nQ = pts.filter(questionable).length;
  const satur = exps.filter((e) => e.meta.saturated).length;
  const releases = [...new Set(exps.map((e) => e.meta.release))].sort();
  const flagFrac = (() => { let bad = 0, tot = 0; for (const e of exps) if (e.phot) { tot += e.phot.nap; bad += e.phot.nbad; } return tot ? bad / tot : 0; })();

  // ---------- data tables
  const photCols = ['mjd', 'utc', 'detector', 'wavelength_um', 'bandwidth_um', 'flux_uJy', 'err_uJy', 'n_bad_pixels', 'flags', 'questionable', 'release', 'file'];
  const photRows = pts.map((p) => [p.mjd?.toFixed(6), mjdToISO(p.mjd), p.det, p.wavelength?.toFixed(5), p.bandwidth?.toFixed(5), p.flux?.toFixed(2), p.err?.toFixed(2), p.nbad, decodeFlags(p.flags || 0).join('|'), questionable(p) ? 1 : 0, p.release, String(p.uri).split('/').pop()]);
  files.push({ name: 'data/photometry.csv', data: [photCols.join(','), ...photRows.map((r) => r.join(','))].join('\n') });
  files.push({ name: 'data/photometry.vot', data: votable('photometry', photCols.map((n2) => ({ name: n2, type: /mjd|um|uJy/.test(n2) ? 'double' : /detector|n_bad|questionable/.test(n2) ? 'int' : 'char', unit: n2.endsWith('_um') ? 'um' : n2.endsWith('_uJy') ? 'uJy' : n2 === 'mjd' ? 'd' : '' })), photRows) });
  const expCols = ['file', 'release', 'doi', 'mjd_avg', 'utc', 'detector', 'wavelength_um', 'l2_qa', 'saturated_core', 's3_url'];
  const expRows = exps.map((e) => [String(e.meta.uri).split('/').pop(), e.meta.release, DOIS[e.meta.release] || '', e.meta.mjd?.toFixed(6), mjdToISO(e.meta.mjd), e.meta.detector, e.meta.wavelength?.toFixed(5) ?? '', e.meta.header?.L2DQAFLG || '', e.meta.saturated ? 1 : 0, uriToS3(e.meta.uri)]);
  files.push({ name: 'data/exposures.csv', data: [expCols.join(','), ...expRows.map((r) => r.join(','))].join('\n') });
  files.push({ name: 'data/exposures.vot', data: votable('exposures', expCols.map((n2) => ({ name: n2, type: /mjd|wavelength/.test(n2) ? 'double' : /detector|saturated/.test(n2) ? 'int' : 'char' })), expRows) });
  const shareUrl = `${location.origin}${location.pathname}?${toParams(normalise({ ...req, t: 0 }))}`;
  const requestJson = JSON.stringify({ schema: 'SkyRequest', ...normalise(req) }, null, 2);
  files.push({ name: 'request.json', data: requestJson });

  // ---------- quality checks before download
  const checks = [];
  checks.push(['Every figure rendered', figs.every((f) => f.src?.length > 100 || f.svg?.length > 100)]);
  checks.push(['At least one epoch of real data', exps.length > 0]);
  const size = files.reduce((a, f) => a + (f.data.size ?? f.data.length ?? 0), 0);
  checks.push([`Bundle size reasonable (${(size / 1048576).toFixed(1)} MB)`, size < 80 * 1048576]);

  // ---------- HTML
  const summary = [];
  summary.push(`SkyShift looked at a ${req.fov}′ × ${req.fov}′ patch of sky around ${esc(name)} (RA ${formatRA(req.target.ra)}, Dec ${formatDec(req.target.dec)}) in ${exps.length} SPHEREx exposures taken between ${mjdToISO(Math.min(...exps.map((e) => e.meta.mjd)), false)} and ${mjdToISO(Math.max(...exps.map((e) => e.meta.mjd)), false)}, grouped into ${groups.length} frame${groups.length > 1 ? 's' : ''}.`);
  if (motion && motion.predicted) summary.push(`Its measured motion between the first and last epochs is ${(Math.hypot(motion.measured.pmra, motion.measured.pmdec) / 1000).toFixed(2)}″/yr, against ${(Math.hypot(motion.predicted.pmra, motion.predicted.pmdec) / 1000).toFixed(2)}″/yr predicted from Gaia DR3${motion.saturatedCore ? ' (the core is saturated, so the centroid uses the star’s wings)' : ''}.`);
  if (eb.change) summary.push(eb.change.sig >= 3 ? `Its brightness changed by ${(eb.change.delta * 100).toFixed(1)}% ± ${(eb.change.err * 100).toFixed(1)}% between survey passes (${eb.change.sig.toFixed(1)}σ): a brightness-change candidate.` : `No significant brightness change between survey passes (${(eb.change.delta * 100).toFixed(1)}% ± ${(eb.change.err * 100).toFixed(1)}%).`);
  if (snap.movers?.length) summary.push(`The mover helper flagged ${snap.movers.length} motion candidate${snap.movers.length > 1 ? 's' : ''} for human checking.`);
  if (satur) summary.push(`${satur} exposure${satur > 1 ? 's have' : ' has'} a saturated core at the target.`);

  const sec = (title, body) => (body ? `<section><h2>${esc(title)}</h2>${body}</section>` : '');
  const table = (cols, rows, max = 400) => `<table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.slice(0, max).map((r) => `<tr>${r.map((v) => `<td>${esc(v)}</td>`).join('')}</tr>`).join('')}</tbody></table>${rows.length > max ? `<p class="small">${rows.length - max} more rows in the ZIP bundle.</p>` : ''}`;
  const figHtml = figs.map((f) => `<figure>${f.svg ? f.svg.replace(/<svg /, '<svg role="img" ') : `<img src="${f.src}" alt="${esc(f.caption)}">`}<figcaption><b>Figure ${f.n}.</b> ${esc(f.caption)}</figcaption></figure>`).join('');
  const thumb = figs[0]?.src;
  const motionHtml = motion && motion.predicted ? table(['Quantity', 'μα* (mas/yr)', 'μδ (mas/yr)'], [
    ['Measured (SkyShift, first→last epoch)', motion.measured.pmra.toFixed(0), motion.measured.pmdec.toFixed(0)],
    ['Gaia DR3 (catalogue)', motion.predicted.pmra.toFixed(0), motion.predicted.pmdec.toFixed(0)],
    ['Residual', motion.residual.pmra.toFixed(0), motion.residual.pmdec.toFixed(0)],
  ]) + `<p class="small">Baseline ${motion.dtYears.toFixed(2)} years (${motion.epochs.join(' → ')}); estimated uncertainty ≈ ±${motion.uncertainty.toFixed(0)} mas/yr per axis from centroiding on ${grid.scale.toFixed(2)}″ pixels.</p>` : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SkyShift dossier ${id} — ${esc(name)}</title>
<style>
:root{color-scheme:light}body{font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:#111;max-width:980px;margin:0 auto;padding:24px}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;border-bottom:2px solid #4b3fd0;padding-bottom:3px;margin-top:28px;break-after:avoid}
.cover{display:flex;gap:18px;align-items:center;border:1px solid #ccd;border-radius:12px;padding:16px;margin-bottom:12px}.cover img{width:200px;border-radius:8px;image-rendering:pixelated}
.small{font-size:12px;color:#444}figure{margin:14px 0;break-inside:avoid}figure img,figure svg{max-width:100%;height:auto;image-rendering:pixelated;background:#0b0e24;border-radius:6px}
figcaption{font-size:12.5px;color:#333;margin-top:4px}table{border-collapse:collapse;width:100%;font-size:11.5px;margin:8px 0;break-inside:auto}th,td{border-bottom:1px solid #dde;padding:3px 6px;text-align:left;vertical-align:top}th{background:#f1f0ff}
code,pre{font:11.5px ui-monospace,Menlo,Consolas,monospace}pre{background:#f6f6fb;padding:10px;border-radius:8px;white-space:pre-wrap;word-break:break-all}
.ok{color:#0a7a45}.no{color:#b00020}footer{margin-top:30px;border-top:1px solid #ccd;padding-top:8px;font-size:12px;color:#444}
@page{margin:14mm}@media print{body{padding:0}a{color:#111}}
</style></head><body>
<div class="cover">${thumb ? `<img src="${thumb}" alt="Thumbnail of the field">` : ''}<div><h1>SkyShift dossier: ${esc(name)}</h1>
<div>RA ${formatRA(req.target.ra)} · Dec ${formatDec(req.target.dec)} (ICRS) · field ${req.fov}′</div>
<div class="small">Dossier ID <b>${id}</b> · generated ${generated} · SkyShift ${esc(snap.version)} · data releases ${releases.map((r) => r.toUpperCase()).join(', ')}</div></div></div>
${sec('Summary', `<p>${summary.join(' ')}</p>`)}
${sec('Input record', `<p>What was supplied and how it was understood. Re-running the same request on the same data release reproduces this dossier (same ID).</p>${snap.inputs ? `<pre>${esc(JSON.stringify(snap.inputs, null, 2))}</pre>` : ''}<p><b>Interpreted request (SkyRequest):</b></p><pre>${esc(requestJson)}</pre><p>Reproduce: <a href="${esc(shareUrl)}">${esc(shareUrl)}</a></p>`)}
${sec('Results', figHtml)}
${sec('Validation', `${motionHtml}${eb.epochs.length > 1 ? table(['Survey pass', 'Dates', 'Mean relative brightness', 'N'], eb.epochs.map((e, i) => [i + 1, `${mjdToISO(e.t0, false)} – ${mjdToISO(e.t1, false)}`, `${((e.mean - 1) * 100).toFixed(1)}% ± ${(e.err * 100).toFixed(1)}%`, e.n])) : ''}${req.track ? '<p>Motion was not measured: this view follows the target’s catalogue motion, so the target is held still. Turn tracking off to measure it.</p>' : ''}${!motion && !eb.epochs.length && !req.track ? '<p>No catalogue comparison was possible for this field (no proper motion known, or too few clean epochs).</p>' : ''}`)}
${snap.movers?.length || snap.candidates?.length ? sec('Candidates', `${snap.movers?.length ? table(['#', 'RA', 'Dec', 'Shift (″)', 'Rate (″/yr)', 'PA (° E of N)', 'S/N'], snap.movers.map((m, i) => [i + 1, formatRA(m.ra), formatDec(m.dec), m.shift.toFixed(1), m.rate.toFixed(2), m.pa.toFixed(0), m.snr.toFixed(1)])) : ''}${snap.candidates?.length ? table(['Type', 'RA', 'Dec', 'Note', 'Saved'], snap.candidates.map((c) => [c.type, formatRA(c.ra), formatDec(c.dec), c.note || '', c.created])) : ''}<p class="small">Candidates are for the user's own vetting; they are not discoveries.</p>`) : ''}
${sec('Data used', `<p>${exps.length} SPHEREx Level 2 spectral images (IRSA), releases ${releases.map((r) => `${r.toUpperCase()} (DOI ${DOIS[r] || 'see IRSA'})`).join(', ')}.</p>${table(expCols.slice(0, 9), expRows.map((r) => r.slice(0, 9)), 120)}<p>Overlay sources: ${[snap.cats?.gaia ? `Gaia DR3 (${esc(snap.cats.gaia.via)})` : '', snap.cats?.wise ? esc(snap.cats.wise.via) : ''].filter(Boolean).join('; ') || 'none shown'}.</p>`)}
${sec('Methods', `<ul>
<li>Image list ${snap.imageList === 'index' ? 'from SkyShift’s image index, built from IRSA TAP every 6 hours' : snap.imageList === 'live' ? 'from IRSA TAP' : 'from a saved copy of an IRSA TAP search'} (<code>spherex.artifact</code> joined with <code>spherex.plane</code>, footprint containing the position), all current releases.</li>
<li>Pixels read from IRSA's public cloud copy with HTTP byte ranges; IMAGE (MJy/sr), FLAGS (RICE_1 decoded) and WCS-WAVE read directly from each file.</li>
<li>Each exposure resampled onto a common north-up tangent-plane grid (${grid.scale.toFixed(2)}″/px) with the file's TAN-SIP WCS; background (field median) subtracted.</li>
<li>Co-adds: inverse-variance mean per detector array, arrays combined with equal weight. Differences: detector by detector (wavelength-matched).</li>
<li>Photometry: aperture radius 2.5 px (15″), background median in a 5–8 px annulus; pixels with bad flags excluded and the aperture sum scaled for them; flux density from MJy/sr × pixel solid angle (header OMEGA_MEDIAN). Wavelength at the target from the WCS-WAVE table (bilinear).</li>
<li>Positions of Gaia stars and of the target propagated linearly with proper motion to each date.</li>
${req.expr ? `<li>Image equation: <code>${esc(req.expr)}</code>.</li>` : ''}${req.where ? `<li>Exposure selection: <code>where ${esc(req.where)}</code>.</li>` : ''}
</ul>`)}
${sec('Limitations and data quality', `<ul>
<li>${nQ} of ${pts.length} photometric points are questionable (saturated core or more than 20% of the aperture masked); ${(flagFrac * 100).toFixed(1)}% of aperture pixels were masked by contamination flags.</li>
${satur ? `<li>${satur} exposures have a saturated core at the target; their photometry is excluded or unreliable.</li>` : ''}
<li>SPHEREx pixels are 6.15″, so nearby sources can blend; quick-look aperture photometry is not a substitute for the IRSA SPHEREx Spectrophotometry Tool.</li>
<li>Wavelengths come from the per-file WCS-WAVE table, accurate to about 1 nm (IRSA).</li>
</ul>`)}
${sec('Credits and data use', `<p>${esc(SPHEREX_ACK)}</p><p>SPHEREx data from the NASA/IPAC Infrared Science Archive. Gaia DR3: European Space Agency mission Gaia, processed by the Gaia DPAC, accessed via IRSA/MAST. CatWISE2020 / AllWISE via IRSA. NEOSSat (Canadian Space Agency) data via CADC where listed. Aladin Lite (CDS) used for the sky atlas.</p>`)}
<section><h2>Quality checks</h2><ul>${checks.map(([t, ok]) => `<li class="${ok ? 'ok' : 'no'}">${ok ? '✔' : '✘'} ${esc(t)}</li>`).join('')}</ul></section>
<footer>${COPYRIGHT} · Dossier ${id} · Generated by SkyShift in the browser from live SPHEREx data.</footer>
</body></html>`;
  files.unshift({ name: 'dossier.html', data: html });
  return { id, html, files, checks, name };
}
