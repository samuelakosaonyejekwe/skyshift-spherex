// The user's own FITS image: pixels, sky coordinates from its WCS, and calibrated aperture photometry. Magnitudes
// are calibrated on the Gaia DR3 stars in the image (positions moved to the image's date with their proper
// motions), the usual way to measure brightness for discovery reports; a zero point in the header is used when the
// field has too few Gaia stars. Everything runs on the device.

import { parseHeader, dataSize, BLOCK } from './fits.js';
import { CelestialWCS } from './wcs.js';
import { fromGalactic, propagate, mjdToYear } from './coords.js';

const MAX_PIXELS = 40e6;

/** First image HDU with a celestial WCS → { width, height, data (Float32Array, row 0 = FITS row 1), header, wcs, galactic }. */
export function readFitsImage(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let off = 0;
  for (let hdu = 0; off + BLOCK <= bytes.length && hdu < 30; hdu++) {
    const p = parseHeader(bytes, off);
    if (!p) break;
    const h = p.header;
    if (h.ZIMAGE) throw new Error('This FITS image is tile-compressed: save it uncompressed (for example with funpack) to inspect it here.');
    const w = h.NAXIS1, hh = h.NAXIS2;
    if (h.NAXIS >= 2 && w > 0 && hh > 0 && /RA-|GLON/.test(h.CTYPE1 || '') && h.XTENSION !== 'BINTABLE') {
      if (w * hh > MAX_PIXELS) throw new Error(`The image has ${(w * hh / 1e6).toFixed(0)} million pixels; up to ${MAX_PIXELS / 1e6} million can be inspected.`);
      const bp = h.BITPIX, n = w * hh, bz = h.BZERO ?? 0, bs = h.BSCALE ?? 1, blank = h.BLANK;
      const start = p.end, size = Math.abs(bp) / 8;
      if (start + n * size > bytes.length) throw new Error('The FITS image is truncated.');
      const dv = new DataView(bytes.buffer, bytes.byteOffset + start, n * size);
      const data = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let v;
        if (bp === -32) v = dv.getFloat32(i * 4, false);
        else if (bp === -64) v = dv.getFloat64(i * 8, false);
        else if (bp === 16) v = dv.getInt16(i * 2, false);
        else if (bp === 32) v = dv.getInt32(i * 4, false);
        else if (bp === 8) v = dv.getUint8(i);
        else throw new Error(`BITPIX ${bp} is not supported.`);
        data[i] = bp > 0 && blank !== undefined && v === blank ? NaN : v * bs + bz;
      }
      return { width: w, height: hh, data, header: h, wcs: new CelestialWCS(h), galactic: /^GLON/.test(h.CTYPE1 || '') };
    }
    off = p.end + dataSize(h);
  }
  throw new Error('No image with sky coordinates (WCS) was found in this FITS file.');
}

/** Sky position (ICRS degrees) of 0-based pixel (x, y). */
export function pixelToSky(img, x, y) {
  let [ra, dec] = img.wcs.pixToWorld(x + 1, y + 1);
  if (img.galactic && Number.isFinite(ra)) ({ ra, dec } = fromGalactic(ra, dec));
  return { ra, dec };
}

/** 0-based pixel of a sky position (ICRS). Galactic-WCS images are not supported for this direction. */
export function skyToPixel(img, ra, dec) {
  if (img.galactic) return null;
  const [x, y] = img.wcs.worldToPix(ra, dec);
  return Number.isFinite(x) && Number.isFinite(y) ? { x: x - 1, y: y - 1 } : null;
}

/** Date of the image (MJD, UTC) from MJD-OBS, JD, DATE-OBS (+ TIME-OBS) or DATE-AVG; null if none. */
export function imageMjd(h) {
  if (Number.isFinite(h['MJD-OBS'])) return h['MJD-OBS'];
  if (Number.isFinite(h['MJD-AVG'])) return h['MJD-AVG'];
  if (Number.isFinite(h['JD'])) return h['JD'] - 2400000.5;
  let d = h['DATE-OBS'] || h['DATE-AVG'];
  if (!d) return null;
  d = String(d).trim();
  if (!/T/.test(d) && h['TIME-OBS']) d = `${d}T${String(h['TIME-OBS']).trim()}`;
  const t = Date.parse(/Z$|[+-]\d\d:\d\d$/.test(d) ? d : `${d}Z`);
  return Number.isFinite(t) ? t / 86400000 + 40587 : null;
}

const median = (a) => { const s = a.slice().sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };

/** Robust background level and noise of the whole image (sampled). */
export function imageStats(img) {
  const step = Math.max(1, Math.floor(img.data.length / 200000));
  const v = []; for (let i = 0; i < img.data.length; i += step) if (Number.isFinite(img.data[i])) v.push(img.data[i]);
  const med = median(v);
  return { median: med, sigma: 1.4826 * median(v.map((x) => Math.abs(x - med))), max: v.reduce((m, x) => Math.max(m, x), -Infinity), sample: v };
}

/** Light-weighted centre near (x, y) within radius r (pixels); null when there is no clear peak. */
export function centroid(img, x, y, r = 5, bg = null) {
  const { width: W, height: H, data } = img;
  let cx = x, cy = y;
  for (let it = 0; it < 12; it++) {
    const ring = [];
    for (let j = Math.round(cy) - Math.ceil(r * 2.2); j <= Math.round(cy) + Math.ceil(r * 2.2); j++) for (let i = Math.round(cx) - Math.ceil(r * 2.2); i <= Math.round(cx) + Math.ceil(r * 2.2); i++) {
      if (i < 0 || j < 0 || i >= W || j >= H) continue;
      const d = Math.hypot(i - cx, j - cy), v = data[j * W + i];
      if (d > r * 1.5 && d < r * 2.2 && Number.isFinite(v)) ring.push(v);
    }
    const b = bg ?? median(ring);
    let sx = 0, sy = 0, sw = 0;
    for (let j = Math.round(cy) - r; j <= Math.round(cy) + r; j++) for (let i = Math.round(cx) - r; i <= Math.round(cx) + r; i++) {
      if (i < 0 || j < 0 || i >= W || j >= H || Math.hypot(i - cx, j - cy) > r) continue;
      const v = data[j * W + i]; if (!Number.isFinite(v)) continue;
      const w = Math.max(0, v - b); sx += w * i; sy += w * j; sw += w;
    }
    if (sw <= 0) return null;
    const nx = sx / sw, ny = sy / sw;
    const moved = Math.hypot(nx - cx, ny - cy);
    cx = nx; cy = ny;
    if (moved < 0.01) break;
  }
  return Math.hypot(cx - x, cy - y) <= r ? { x: cx, y: cy } : null;
}

/** Aperture photometry at (x, y): flux above the local background (image units), its error, peak and S/N. */
export function aperture(img, x, y, rAp, rIn, rOut) {
  const { width: W, height: H, data } = img;
  const ring = [], ap = [];
  let peak = -Infinity, nbad = 0;
  for (let j = Math.floor(y - rOut); j <= Math.ceil(y + rOut); j++) for (let i = Math.floor(x - rOut); i <= Math.ceil(x + rOut); i++) {
    if (i < 0 || j < 0 || i >= W || j >= H) { if (Math.hypot(i - x, j - y) <= rAp) nbad++; continue; }
    const d = Math.hypot(i - x, j - y), v = data[j * W + i];
    if (d <= rAp) { if (Number.isFinite(v)) { ap.push(v); peak = Math.max(peak, v); } else nbad++; }
    else if (d >= rIn && d <= rOut && Number.isFinite(v)) ring.push(v);
  }
  if (ap.length < 3 || ring.length < 8) return null;
  const bkg = median(ring), sig = 1.4826 * median(ring.map((v) => Math.abs(v - bkg)));
  let sum = 0; for (const v of ap) sum += v - bkg;
  const n = ap.length + nbad;
  sum *= n / ap.length;
  const err = Math.sqrt(sig * sig * n * (1 + n / ring.length) + Math.max(0, sum) / Math.max(1, Number(img.header.GAIN) || 1e9));
  return { flux: sum, err, snr: err > 0 ? sum / err : 0, peak, bkg, nbad };
}

/** Typical star width (FWHM, pixels): area above half the peak of bright, unsaturated stars, FWHM = 2√(A/π). */
export function measureFwhm(img, stars, saturation) {
  const s = [], { width: W, height: H, data } = img;
  for (const st of stars) {
    const r = 10;
    const a = aperture(img, st.x, st.y, 3, r, r + 6);
    if (!a || a.snr < 30 || a.peak >= saturation) continue;
    const half = a.bkg + (a.peak - a.bkg) / 2;
    let area = 0;
    for (let j = Math.round(st.y) - r; j <= Math.round(st.y) + r; j++) for (let i = Math.round(st.x) - r; i <= Math.round(st.x) + r; i++) {
      if (i < 0 || j < 0 || i >= W || j >= H || Math.hypot(i - st.x, j - st.y) > r) continue;
      if (data[j * W + i] >= half) area++;
    }
    if (area >= 2) s.push(2 * Math.sqrt(area / Math.PI));
    if (s.length >= 40) break;
  }
  return s.length >= 3 ? Math.min(15, Math.max(1.2, median(s))) : null;
}

/**
 * Photometric zero point from Gaia DR3 stars in the image: ZP = G + 2.5 log10(flux), median and robust scatter.
 * gaia: rows with ra, dec, pmra, pmdec, ref_epoch, phot_g_mean_mag. Returns the calibration and the aperture used.
 */
export function calibrate(img, gaia, mjd) {
  const st = imageStats(img);
  const saturation = Number(img.header.SATURATE || img.header.DATAMAX || 0) || st.max * 0.95;
  const year = mjd ? mjdToYear(mjd) : 2016;
  const margin = 20;
  const cand = [];
  for (const g of gaia) {
    if (!(g.phot_g_mean_mag >= 9 && g.phot_g_mean_mag <= 19)) continue;
    const p = propagate(g.ra, g.dec, g.pmra || 0, g.pmdec || 0, g.ref_epoch || 2016, year);
    const px = skyToPixel(img, p.ra, p.dec);
    if (!px || px.x < margin || px.y < margin || px.x > img.width - margin || px.y > img.height - margin) continue;
    cand.push({ g, ...px });
  }
  cand.sort((a, b) => a.g.phot_g_mean_mag - b.g.phot_g_mean_mag);
  const stars = cand.slice(0, 400).map((c) => { const cc = centroid(img, c.x, c.y, 4, null); return cc ? { ...c, ...cc } : null; }).filter(Boolean);
  const fwhm = measureFwhm(img, stars, saturation) || 3;
  const rAp = Math.max(2.5, 1.5 * fwhm), rIn = Math.max(rAp + 2, 2.5 * fwhm), rOut = rIn + Math.max(4, 1.5 * fwhm);
  const zps = [];
  for (const s of stars) {
    // isolated stars only: no Gaia star brighter than 2.5 mag fainter inside the aperture and background ring
    if (cand.some((o) => o.g.source_id !== s.g.source_id && o.g.phot_g_mean_mag < s.g.phot_g_mean_mag + 2.5 && Math.hypot(o.x - s.x, o.y - s.y) < rOut)) continue;
    const a = aperture(img, s.x, s.y, rAp, rIn, rOut);
    if (!a || a.snr < 20 || a.peak >= saturation || a.flux <= 0) continue;
    zps.push(s.g.phot_g_mean_mag + 2.5 * Math.log10(a.flux));
  }
  if (zps.length < 5) return { ok: false, n: zps.length, fwhm, rAp, rIn, rOut, saturation, stars: cand.length };
  const zp = median(zps), scatter = 1.4826 * median(zps.map((z) => Math.abs(z - zp)));
  return { ok: true, zp, scatter, err: scatter / Math.sqrt(zps.length), n: zps.length, fwhm, rAp, rIn, rOut, saturation, stars: cand.length };
}

/** Zero point written in the header (PHOTZP, MAGZPT, MAGZERO, ZEROPT, ZP), if any. */
export function headerZeroPoint(h) {
  for (const k of ['PHOTZP', 'MAGZPT', 'MAGZP', 'MAGZERO', 'ZEROPT', 'ZP']) if (Number.isFinite(h[k])) return { zp: h[k], key: k };
  return null;
}
