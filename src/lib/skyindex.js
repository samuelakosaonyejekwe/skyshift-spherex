// Static SPHEREx image index: lets the browser find every SPHEREx spectral image covering a
// position without calling IRSA TAP (which sends no CORS headers), so searching works on static
// hosts such as GitHub Pages with no relay. Built by scripts/index.mjs from IRSA TAP
// (spherex.artifact JOIN spherex.plane, seed 1) and refreshed by the scheduled workflow.
//
// Layout: data/idx/meta.json + one CSV-like text file per sky tile (data/idx/<band>/<cell>.txt).
// Tiles are 2° bands in declination, each split into cells about 2° wide in right ascension.
// An image is stored in the tile that contains its footprint centre; a search reads every tile
// within the largest centre-to-corner distance (meta.r) and keeps images whose footprint
// polygon contains the position. Pure functions only: shared by the builder (Node) and the app.

export const BAND_DEG = 2;
export const NBANDS = 180 / BAND_DEG;
const D2R = Math.PI / 180;

/** Number of right-ascension cells in declination band b. */
export function cellsInBand(b) {
  const dc = -90 + (b + 0.5) * BAND_DEG;
  return Math.max(1, Math.round((360 / BAND_DEG) * Math.cos(dc * D2R)));
}

export const wrap360 = (ra) => ((ra % 360) + 360) % 360;

export function tileOf(ra, dec) {
  const b = Math.min(NBANDS - 1, Math.max(0, Math.floor((dec + 90) / BAND_DEG)));
  const n = cellsInBand(b);
  return { b, c: Math.min(n - 1, Math.floor((wrap360(ra) / 360) * n)) };
}

/** Every tile that can hold the centre of an image whose footprint reaches (ra, dec), given radius r (deg). */
export function tilesNear(ra, dec, r) {
  const out = [];
  const lo = Math.max(-90, dec - r), hi = Math.min(90, dec + r);
  const b0 = Math.max(0, Math.floor((lo + 90) / BAND_DEG)), b1 = Math.min(NBANDS - 1, Math.floor((hi + 90 - 1e-9) / BAND_DEG));
  for (let b = b0; b <= b1; b++) {
    const n = cellsInBand(b);
    // widest RA half-width needed anywhere in this band (largest |dec| within the band and the search range)
    const bLo = -90 + b * BAND_DEG, bHi = bLo + BAND_DEG;
    const maxAbs = Math.max(Math.abs(Math.max(lo, bLo)), Math.abs(Math.min(hi, bHi)));
    const cosd = Math.cos(maxAbs * D2R);
    const half = cosd < 1e-6 ? 180 : Math.asin(Math.min(1, Math.sin(r * D2R) / cosd)) / D2R;
    if (half >= 180 || Math.sin(r * D2R) >= cosd || maxAbs + r >= 90) { for (let c = 0; c < n; c++) out.push({ b, c }); continue; }
    const w = 360 / n;
    const c0 = Math.floor(wrap360(ra - half) / w), c1 = Math.floor(wrap360(ra + half) / w);
    if (c0 <= c1) for (let c = c0; c <= c1; c++) out.push({ b, c });
    else { for (let c = c0; c < n; c++) out.push({ b, c }); for (let c = 0; c <= c1; c++) out.push({ b, c }); }
  }
  return out;
}

export const tilePath = ({ b, c }) => `data/idx/${b}/${c}.txt`;

function unit(ra, dec) { const a = ra * D2R, d = dec * D2R; return [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)]; }

/** Footprint centre: normalised mean of the corner unit vectors. */
export function centreOf(corners) {
  let x = 0, y = 0, z = 0;
  for (const [ra, dec] of corners) { const u = unit(ra, dec); x += u[0]; y += u[1]; z += u[2]; }
  const n = Math.hypot(x, y, z);
  return [wrap360(Math.atan2(y, x) / D2R), Math.asin(z / n) / D2R];
}

/** Great-circle distance in degrees. */
export function sep(ra1, dec1, ra2, dec2) {
  const a = unit(ra1, dec1), b = unit(ra2, dec2);
  return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) / D2R;
}

/** True if (ra, dec) lies inside the spherical polygon (corners in order), via a gnomonic projection about the point. */
export function contains(corners, ra, dec) {
  const a0 = ra * D2R, d0 = dec * D2R, sd0 = Math.sin(d0), cd0 = Math.cos(d0);
  const pts = [];
  for (const [r, d] of corners) {
    const a = r * D2R, dd = d * D2R;
    const cosc = sd0 * Math.sin(dd) + cd0 * Math.cos(dd) * Math.cos(a - a0);
    if (cosc <= 0) return false;
    pts.push([(Math.cos(dd) * Math.sin(a - a0)) / cosc, (cd0 * Math.sin(dd) - sd0 * Math.cos(dd) * Math.cos(a - a0)) / cosc]);
  }
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > 0) !== (yj > 0) && 0 < ((xj - xi) * (0 - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// ---- row encoding ----------------------------------------------------------------------------
// One line per image: key,t,det,ra,dec,dx1,dy1,dx2,dy2,dx3,dy3,dx4,dy4
//  key   compact file name: "<release>|<week>|<version>|<seq>_<exposure>" (rebuilt into the IRSA path),
//        or "=" followed by the full path when it does not follow the usual pattern
//  t     exposure start, MJD, in units of 1e-5 day after MJD 60000
//  ra,dec footprint centre in units of 1e-4 degree; dx,dy corner offsets in 1e-4 degree
//        (dx in RA degrees, unwrapped, not multiplied by cos dec)
const URI_RE = /^ibe\/data\/spherex\/([a-z0-9]+)\/level2\/([^/]+)\/(l2b-[^/]+)\/([1-6])\/level2_\2_(\d+)_(\d+)D\4_spx_\3\.fits$/;
export const T0 = 60000;

export function encodeRow(uri, t, det, corners) {
  const m = URI_RE.exec(uri);
  const key = m && Number(m[4]) === det ? `${m[1]}|${m[2]}|${m[3]}|${m[5]}_${m[6]}` : `=${uri}`;
  const [cra, cdec] = centreOf(corners);
  const parts = [key, Math.round((t - T0) * 1e5), det, Math.round(cra * 1e4), Math.round(cdec * 1e4)];
  for (const [r, d] of corners) {
    let dx = r - cra; if (dx > 180) dx -= 360; if (dx < -180) dx += 360;
    parts.push(Math.round(dx * 1e4), Math.round((d - cdec) * 1e4));
  }
  return { line: parts.join(','), centre: [cra, cdec] };
}

export function decodeRow(line) {
  const p = line.split(',');
  if (p.length !== 13) return null;
  const det = Number(p[2]);
  let uri;
  if (p[0].startsWith('=')) uri = p[0].slice(1);
  else {
    const [rel, week, ver, se] = p[0].split('|');
    uri = `ibe/data/spherex/${rel}/level2/${week}/${ver}/${det}/level2_${week}_${se}D${det}_spx_${ver}.fits`;
  }
  const ra = Number(p[3]) / 1e4, dec = Number(p[4]) / 1e4;
  const corners = [];
  for (let k = 5; k < 13; k += 2) corners.push([wrap360(ra + Number(p[k]) / 1e4), dec + Number(p[k + 1]) / 1e4]);
  return { uri, t: T0 + Number(p[1]) / 1e5, det, ra, dec, corners };
}

/** Corners from an IRSA TAP poly column (WKB hex, little-endian POLYGON with SRID; closing point repeated). */
export function cornersFromWkb(hex) {
  const buf = new Uint8Array(hex.length / 2);
  for (let i = 0; i < buf.length; i++) buf[i] = parseInt(hex.substr(i * 2, 2), 16);
  const dv = new DataView(buf.buffer);
  const le = buf[0] === 1;
  let o = 1;
  const type = dv.getUint32(o, le); o += 4;
  if (type & 0x20000000) o += 4; // SRID
  if ((type & 0xffff) !== 3) throw new Error('not a polygon');
  const rings = dv.getUint32(o, le); o += 4;
  if (rings < 1) throw new Error('empty polygon');
  const n = dv.getUint32(o, le); o += 4;
  const pts = [];
  for (let i = 0; i < n; i++) { pts.push([wrap360(dv.getFloat64(o, le)), dv.getFloat64(o + 8, le)]); o += 16; }
  if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
  return pts;
}
