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
  s = s.replace(/[hdm°'′:"″s]/g, ' ').replace(/,/g, '.').trim().replace(/^([+-])\s+/, '$1'); // "- 5" is -5
  const parts = s.split(/\s+/).filter(Boolean);
  if (!parts.length || parts.length > 3) return NaN;
  const neg = parts[0].startsWith('-');
  const nums = parts.map((p) => { const q = p.replace(/^[+-]/, ''); return q === '' ? NaN : Number(q); }); // a lone sign is not 0
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

// ICRS → galactic rotation (IAU 1958, J2000); one copy, used both ways
const GAL = [
  [-0.0548755604, -0.8734370902, -0.4838350155],
  [0.4941094279, -0.4448296300, 0.7469822445],
  [-0.8676661490, -0.1980763734, 0.4559837762],
];
/** Galactic (l, b) → ICRS (ra, dec), the inverse (transpose) rotation. */
export function fromGalactic(l, b) {
  const x = Math.cos(b * D2R) * Math.cos(l * D2R), y = Math.cos(b * D2R) * Math.sin(l * D2R), z = Math.sin(b * D2R);
  const M = GAL;
  const ex = M[0][0] * x + M[1][0] * y + M[2][0] * z, ey = M[0][1] * x + M[1][1] * y + M[2][1] * z, ez = M[0][2] * x + M[1][2] * y + M[2][2] * z;
  let ra = Math.atan2(ey, ex) * R2D; if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(Math.max(-1, Math.min(1, ez))) * R2D };
}
/** Galactic coordinates (IAU 1958, J2000 rotation). */
export function toGalactic(ra, dec) {
  const r = ra * D2R, d = dec * D2R;
  const x = Math.cos(d) * Math.cos(r), y = Math.cos(d) * Math.sin(r), z = Math.sin(d);
  const M = GAL;
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
 * Move a sky position along its proper motion from fromYear to toYear. pmra is μα* (mas/yr, already including
 * cos dec), pmdec is μδ (mas/yr). The star moves in a straight line through space (constant tangential velocity,
 * radial velocity taken as zero), the rigorous form described in the Gaia DR3 documentation (sec. 4.1.7): the
 * displacement is added to the unit position vector along the local east and north directions and the result is
 * normalised. Unlike adding Δα = μα*·t / cos δ, this stays exact at the celestial poles and never gives |δ| > 90°.
 */
export function propagate(ra, dec, pmra, pmdec, fromYear, toYear) {
  const dt = toYear - fromYear;
  if (!dt || (!pmra && !pmdec)) return { ra, dec };
  return offsetOnSky(ra, dec, (pmra || 0) * dt, (pmdec || 0) * dt);
}

/** Shift a position by dEast and dNorth milliarcseconds on the sphere (vector form, valid at the poles too). */
export function offsetOnSky(ra, dec, dEast, dNorth) {
  const a = ra * D2R, d = dec * D2R, k = D2R / 3.6e6;
  const ca = Math.cos(a), sa = Math.sin(a), cd = Math.cos(d), sd = Math.sin(d);
  const e = dEast * k, n = dNorth * k;
  // unit vector to the star, plus displacement along east (−sin α, cos α, 0) and north (−sin δ cos α, −sin δ sin α, cos δ)
  const x = cd * ca - e * sa - n * sd * ca, y = cd * sa + e * ca - n * sd * sa, z = sd + n * cd;
  return { ra: wrap360(Math.atan2(y, x) / D2R), dec: Math.atan2(z, Math.hypot(x, y)) / D2R };
}

export const mjdToDate = (mjd) => new Date((mjd - 40587) * 86400000);
export const mjdToYear = (mjd) => 2000 + (mjd - 51544.5) / 365.25;
export const yearToMjd = (yr) => 51544.5 + (yr - 2000) * 365.25;
export const nowMjd = () => Date.now() / 86400000 + 40587;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** Readable UTC date with the month named, e.g. "5 Oct 2026" (or "Oct 2026" with monthOnly). Accepts MJD, Date or ISO text. */
// Dates without a timezone (FITS DATE-OBS/DATE-AVG, archive listings) are UTC by definition, not local time.
const toUTCDate = (x) => (typeof x === 'number' ? mjdToDate(x) : x instanceof Date ? x : new Date(/T\d\d:\d\d(:\d\d(\.\d+)?)?$/.test(String(x)) ? `${x}Z` : x));
// Month names follow the interface language chosen in Settings (html data-ui-lang); English otherwise.
const uiLang = () => (typeof document !== 'undefined' && document.documentElement?.dataset?.uiLang) || 'en';
const fmtCache = new Map();
function dateFmt(monthOnly) {
  const lang = uiLang(), key = lang + monthOnly;
  if (!fmtCache.has(key)) {
    try { fmtCache.set(key, new Intl.DateTimeFormat(lang === 'en' ? 'en-GB' : lang, monthOnly ? { month: 'short', year: 'numeric', timeZone: 'UTC' } : { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })); } catch { fmtCache.set(key, null); }
  }
  return fmtCache.get(key);
}
const niceMemo = new Map(); // the same epoch dates are formatted thousands of times while frames stream
export function niceDate(x, monthOnly = false) {
  if (typeof x === 'number') {
    const k = `${uiLang()}|${monthOnly ? 1 : 0}|${Math.floor(x)}`;
    let v = niceMemo.get(k);
    if (v === undefined) { v = niceDateRaw(Math.floor(x) + 0.5, monthOnly); if (niceMemo.size > 5000) niceMemo.clear(); niceMemo.set(k, v); }
    return v;
  }
  return niceDateRaw(x, monthOnly);
}
function niceDateRaw(x, monthOnly) {
  const d = toUTCDate(x);
  if (Number.isNaN(d.getTime())) return '–';
  const f = dateFmt(monthOnly);
  if (f) return f.format(d).replace(/\.$/, '');
  return monthOnly ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Readable UTC date and time, e.g. "5 Oct 2026 00:01 UTC". */
export function niceDateTime(x) {
  const d = toUTCDate(x);
  return Number.isNaN(d.getTime()) ? '–' : `${niceDate(d)} ${d.toISOString().slice(11, 16)} UTC`;
}

/** Locale for numbers and clock times, following the interface language. */
export const uiLocale = () => { const l = uiLang(); return l === 'en' ? 'en-GB' : l; };
/** Local clock time, e.g. "20:26", in the interface language. */
export const niceTime = (d = new Date()) => new Date(d).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
/** A whole number with the interface language's digit grouping. */
export const niceNum = (n) => Number(n).toLocaleString(uiLocale());

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
  // (X, Y, Z) is the Sun seen from Earth; a nearby star is displaced toward the Sun by plx × (unit vector to Sun,
  // projected on the sky). Checked against Astropy's GCRS transform (test/core.test.mjs).
  const dra = plx * (Y * Math.cos(a) - X * Math.sin(a)); // mas, includes cos(dec)
  const ddec = plx * (Z * Math.cos(d) - X * Math.cos(a) * Math.sin(d) - Y * Math.sin(a) * Math.sin(d));
  return offsetOnSky(p.ra, p.dec, dra, ddec);
}

/**
 * Precess ICRS/J2000.0 coordinates to the mean equinox of date (IAU 1976 precession, Meeus, Astronomical
 * Algorithms, 2nd ed., eqs. 21.2–21.4). jd: Julian date of the equinox wanted. Degrees in and out.
 */
export function precessFromJ2000(ra, dec, jd) {
  const T = (jd - 2451545.0) / 36525, as = Math.PI / 180 / 3600;
  const zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T ** 3) * as;
  const z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T ** 3) * as;
  const th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T ** 3) * as;
  const a0 = ra * Math.PI / 180, d0 = dec * Math.PI / 180;
  const A = Math.cos(d0) * Math.sin(a0 + zeta);
  const B = Math.cos(th) * Math.cos(d0) * Math.cos(a0 + zeta) - Math.sin(th) * Math.sin(d0);
  const C = Math.sin(th) * Math.cos(d0) * Math.cos(a0 + zeta) + Math.cos(th) * Math.sin(d0);
  return { ra: ((((Math.atan2(A, B) + z) * 180 / Math.PI) % 360) + 360) % 360, dec: Math.asin(Math.max(-1, Math.min(1, C))) * 180 / Math.PI };
}

/** AB magnitude of a flux density in µJy (m = 23.9 − 2.5 log10 F), with its 1σ error; null when not positive. */
export function abMag(fluxUJy, errUJy) {
  if (!(fluxUJy > 0)) return null;
  return { mag: 23.9 - 2.5 * Math.log10(fluxUJy), err: errUJy > 0 ? 1.0857 * errUJy / fluxUJy : null };
}
