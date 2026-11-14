// Coordinate parsing, formatting, epoch propagation and time helpers.
// Pure functions: run in browsers, workers and Node.

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

/** Wrap an angle into [0, 360) without disturbing values already in range (keeps typed and uploaded values identical). */
export const wrap360 = (a) => (a >= 0 && a < 360 ? a : ((a % 360) + 360) % 360);

/** Parse one sexagesimal or decimal angle. hours=true treats "h m s" / 3-part input as hours. */
export function parseAngle(text, { hours = false } = {}) {
  if (text == null) return NaN;
  let s = String(text).trim().toLowerCase().replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-');
  if (!s) return NaN;
  const hasH = /h/.test(s);
  const hasD = /[d°]/.test(s);
  s = s.replace(/[hdm°'′:"″s]/g, ' ').replace(/,/g, '.').trim();
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 3) return NaN;
  const neg = parts[0].startsWith('-');
  const nums = parts.map((p) => Number(p.replace(/^[+-]/, '')));
  if (nums.some((n) => !Number.isFinite(n))) return NaN;
  if (nums.length > 1 && (nums[1] >= 60 || (nums[2] ?? 0) >= 60)) return NaN;
  let v = nums[0] + (nums[1] ?? 0) / 60 + (nums[2] ?? 0) / 3600;
  const asHours = hasH || (hours && !hasD && nums.length > 1);
  if (asHours) v *= 15;
  return neg ? -v : v;
}

/**
 * Parse a free-form position: "269.452 4.693", "17:57:48.5 +04:41:36",
 * "17h57m48.5s +4d41m36s", "ra=269.45, dec=4.69".
 */
export function parsePosition(text) {
  if (!text) return null;
  let s = String(text).trim().replace(/[\u2212\u2012\u2013\u2014\uFE63\uFF0D]/g, '-').replace(/ra\s*=?|dec\s*=?/gi, ' ').replace(/[;]/g, ' ');
  // split on comma between numbers or on whitespace before a signed dec
  let raStr, decStr;
  const comma = s.split(/\s*,\s*/);
  if (comma.length === 2) [raStr, decStr] = comma;
  else {
    const m = s.match(/^(.*?)\s+([+-].*)$/);
    if (m) [, raStr, decStr] = m;
    else {
      const p = s.trim().split(/\s+/);
      if (p.length === 2) [raStr, decStr] = p;
      else if (p.length === 6) { raStr = p.slice(0, 3).join(' '); decStr = p.slice(3).join(' '); }
      else return null;
    }
  }
  const raSexa = /[:hm\s]/.test(raStr.trim());
  const ra = parseAngle(raStr, { hours: raSexa });
  const dec = parseAngle(decStr);
  if (!Number.isFinite(ra) || !Number.isFinite(dec)) return null;
  if (dec < -90 || dec > 90) return null;
  return { ra: wrap360(ra), dec };
}

const pad = (n, w, d = 0) => {
  const s = n.toFixed(d);
  const [i, f] = s.split('.');
  return i.padStart(w, '0') + (f ? '.' + f : '');
};

export function formatRA(deg) {
  let h = (((deg % 360) + 360) % 360) / 15;
  let hh = Math.floor(h), mm = Math.floor((h - hh) * 60), ss = ((h - hh) * 60 - mm) * 60;
  if (ss >= 59.9995) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; hh = (hh + 1) % 24; }
  return `${pad(hh, 2)}h${pad(mm, 2)}m${pad(ss, 2, 3)}s`;
}

export function formatDec(deg) {
  const sign = deg < 0 ? '-' : '+';
  let a = Math.abs(deg);
  let dd = Math.floor(a), mm = Math.floor((a - dd) * 60), ss = ((a - dd) * 60 - mm) * 60;
  if (ss >= 59.995) { ss = 0; mm += 1; }
  if (mm >= 60) { mm = 0; dd += 1; }
  return `${sign}${pad(dd, 2)}°${pad(mm, 2)}′${pad(ss, 2, 2)}″`;
}

/** Galactic coordinates (IAU 1958, J2000 rotation). */
export function toGalactic(ra, dec) {
  const r = ra * D2R, d = dec * D2R;
  const x = Math.cos(d) * Math.cos(r), y = Math.cos(d) * Math.sin(r), z = Math.sin(d);
  const M = [
    [-0.0548755604, -0.8734370902, -0.4838350155],
    [0.4941094279, -0.4448296300, 0.7469822445],
    [-0.8676661490, -0.1980763734, 0.4559837762],
  ];
  const gx = M[0][0] * x + M[0][1] * y + M[0][2] * z;
  const gy = M[1][0] * x + M[1][1] * y + M[1][2] * z;
  const gz = M[2][0] * x + M[2][1] * y + M[2][2] * z;
  let l = Math.atan2(gy, gx) * R2D;
  if (l < 0) l += 360;
  return { l, b: Math.asin(Math.max(-1, Math.min(1, gz))) * R2D };
}

/** Angular separation in degrees (Vincenty form, stable at all scales). */
export function separation(ra1, dec1, ra2, dec2) {
  const dra = (ra2 - ra1) * D2R;
  const p1 = dec1 * D2R, p2 = dec2 * D2R;
  const a = Math.cos(p2) * Math.sin(dra);
  const b = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dra);
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos(dra);
  return Math.atan2(Math.hypot(a, b), c) * R2D;
}

/**
 * Linear proper-motion propagation (adequate over decades for display).
 * pmra is mu_alpha* (includes cos dec), mas/yr, as delivered by Gaia.
 */
export function propagate(ra, dec, pmra, pmdec, fromYear, toYear) {
  const dt = toYear - fromYear;
  if (!dt || (!pmra && !pmdec)) return { ra, dec };
  const ddec = (pmdec * dt) / 3.6e6;
  const cosd = Math.cos(dec * D2R) || 1e-9;
  const dra = (pmra * dt) / 3.6e6 / cosd;
  return { ra: wrap360(ra + dra), dec: dec + ddec };
}

export const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);
export const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
export const yearToMjd = (yr) => 51544.5 + (yr - 2000) * 365.25;
export const nowMjd = () => Date.now() / 86400000 + 40587;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Readable UTC date with the month named, e.g. "5 Oct 2026" (or "Oct 2026" with monthOnly). Accepts MJD, Date or ISO text. */
// Dates without a timezone (FITS DATE-OBS/DATE-AVG, archive listings) are UTC by definition, not local time.
const toUTCDate = (x) => (typeof x === 'number' ? mjdToDate(x) : x instanceof Date ? x : new Date(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(String(x)) ? `${x}Z` : x));
export function niceDate(x, monthOnly = false) {
  const d = toUTCDate(x);
  if (Number.isNaN(d.getTime())) return '–';
  return monthOnly ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Readable UTC date and time, e.g. "5 Oct 2026 00:01 UTC". */
export function niceDateTime(x) {
  const d = toUTCDate(x);
  return Number.isNaN(d.getTime()) ? '–' : `${niceDate(d)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function mjdToISO(mjd, withTime = true) {
  const s = mjdToDate(mjd).toISOString();
  return withTime ? s.slice(0, 16).replace('T', ' ') + ' UTC' : s.slice(0, 10);
}

/** Geocentric equatorial position of the Sun (AU), low-precision formula (accurate to ~0.01° in longitude). */
export function sunXYZ(mjd) {
  const n = mjd + 2400000.5 - 2451545.0, D = Math.PI / 180;
  const L = 280.460 + 0.9856474 * n, g = (357.528 + 0.9856003 * n) * D;
  const lam = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D;
  const R = 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g);
  const eps = (23.439 - 0.0000004 * n) * D;
  return [R * Math.cos(lam), R * Math.cos(eps) * Math.sin(lam), R * Math.sin(eps) * Math.sin(lam)];
}

/**
 * Apparent position at a date: proper motion plus annual parallax (observer at Earth's centre;
 * SPHEREx's low orbit adds < 0.0001″ for stars). plx in mas.
 */
export function apparent(ra, dec, pmra, pmdec, plx, refYear, mjd) {
  const p = propagate(ra, dec, pmra || 0, pmdec || 0, refYear, mjdToYear(mjd));
  if (!plx) return p;
  const [X, Y, Z] = sunXYZ(mjd), a = (p.ra * Math.PI) / 180, d = (p.dec * Math.PI) / 180;
  const dra = plx * (X * Math.sin(a) - Y * Math.cos(a)); // mas, includes cos(dec)
  const ddec = plx * (X * Math.cos(a) * Math.sin(d) + Y * Math.sin(a) * Math.sin(d) - Z * Math.cos(d));
  return { ra: wrap360(p.ra + dra / 3.6e6 / (Math.cos(d) || 1e-9)), dec: p.dec + ddec / 3.6e6 };
}
