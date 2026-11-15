// Moving objects of the Solar System (asteroids, comets): the user supplies a table of times and positions (an
// ephemeris, e.g. from any ephemeris service, as CSV or as plain text), and SkyShift follows the object along it:
// it searches SPHEREx images along the path and centres every exposure on the position at that exposure's time.
// No ephemeris service is called: positions come only from the user's table.

import { parsePosition, parseAngle, wrap360 } from './coords.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const mjdFromUTC = (y, mo, d, h = 0, mi = 0, s = 0) => Date.UTC(y, mo - 1, d, h, mi, s) / 86400000 + 40587;

/**
 * A time in a table cell or line → MJD (UTC), or NaN. Accepts ISO dates (2026-03-14, 2026-03-14T05:30:00,
 * 2026-03-14 05:30), month names (2026-Mar-14 05:30, 14 Mar 2026), JD (2461000.5, "JD 2461000.5") and MJD
 * ("MJD 61000.25", or a bare number between 40000 and 99999).
 */
export function parseTime(s) {
  const t = String(s ?? '').trim();
  if (!t) return NaN;
  let m = t.match(/^(?:A\.?D\.?\s*)?(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/);
  if (m) return mjdFromUTC(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = t.match(/^(?:A\.?D\.?\s*)?(\d{4})-([A-Za-z]{3})-(\d{1,2})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/);
  if (m && MONTHS[m[2].toLowerCase()]) return mjdFromUTC(+m[1], MONTHS[m[2].toLowerCase()], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = t.match(/^(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?\s+(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?/);
  if (m && MONTHS[m[2].toLowerCase()]) return mjdFromUTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  m = t.match(/^(M?JD)\s*[:=]?\s*(\d+(?:\.\d+)?)$/i);
  if (m) return m[1].toUpperCase() === 'JD' ? Number(m[2]) - 2400000.5 : Number(m[2]);
  if (/^\d+(\.\d+)?$/.test(t)) {
    const v = Number(t);
    if (v > 2400000 && v < 2500000) return v - 2400000.5; // JD
    if (v > 40000 && v < 99999) return v; // MJD
  }
  return NaN;
}

/** A time at the start of a text line, with the rest of the line (for plain-text ephemerides). */
function leadingTime(line) {
  const s = line.trim();
  const pats = [
    /^(?:A\.?D\.?\s*)?\d{4}-[A-Za-z]{3}-\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/,
    /^\d{4}-\d{1,2}-\d{1,2}(?:[T\s]+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?Z?/,
    /^\d{1,2}\s+[A-Za-z]{3}[a-z]*\.?\s+\d{4}(?:\s+\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?/,
    /^M?JD\s*[:=]?\s*\d+(?:\.\d+)?/i,
    /^24\d{5}(?:\.\d+)?/,
  ];
  for (const re of pats) {
    const m = s.match(re);
    if (m) { const mjd = parseTime(m[0].replace(/Z$/, '')); if (Number.isFinite(mjd)) return { mjd, rest: s.slice(m[0].length) }; }
  }
  return null;
}

/** RA and Dec at the start of the rest of a line: sexagesimal (12 34 56.7 +12 34 56) or decimal degrees. */
function leadingPosition(rest) {
  // skip short status flags between the time and the position (e.g. "*m", "C", "N" in ephemeris-service tables)
  const s = rest.replace(/[,;|]+/g, ' ').replace(/^(\s*[*a-zA-Z]{1,3}(?=\s))+/, '').trim();
  let m = s.match(/^(\d{1,2}[h:\s]\s*\d{1,2}[m:\s]\s*\d{1,2}(?:\.\d+)?s?)\s+([+\-−]?\s*\d{1,2}[d°:\s]\s*\d{1,2}[m′':\s]\s*\d{1,2}(?:\.\d+)?[s″"]?)/i);
  if (m) {
    const p = parsePosition(`${m[1]} ${/^[+\-−]/.test(m[2].trim()) ? m[2].trim().replace('−', '-').replace(/^([+-])\s+/, '$1') : '+' + m[2].trim()}`);
    if (p) return p;
  }
  m = s.match(/^(\d{1,3}(?:\.\d+)?)\s+([+\-−]?\d{1,2}(?:\.\d+)?)(?:\s|$)/);
  if (m) {
    const ra = Number(m[1]), dec = Number(m[2].replace('−', '-'));
    if (ra >= 0 && ra < 360 && Math.abs(dec) <= 90) return { ra, dec };
  }
  return null;
}

/**
 * Plain-text ephemeris (one position per line: time, then RA and Dec), e.g. the text table of an ephemeris
 * service; anything outside a $$SOE … $$EOE block is ignored when such markers are present.
 */
export function ephemerisFromText(text) {
  let lines = String(text).split(/\r?\n/);
  const soe = lines.findIndex((l) => /^\s*\$\$SOE/.test(l)), eoe = lines.findIndex((l) => /^\s*\$\$EOE/.test(l));
  if (soe >= 0 && eoe > soe) lines = lines.slice(soe + 1, eoe);
  const points = [], bad = [];
  lines.forEach((l, i) => {
    if (!l.trim()) return;
    const t = leadingTime(l);
    const p = t && leadingPosition(t.rest);
    if (t && p) points.push([t.mjd, wrap360(p.ra), p.dec]); else bad.push(i + 1);
  });
  return finishEphemeris(points, bad);
}

/** Table ephemeris: rows with a time column and RA/Dec columns (indexes from the column mapping). */
export function ephemerisFromTable(rows, map) {
  const points = [], bad = [];
  rows.forEach((r, i) => {
    const mjd = parseTime(r[map.time]);
    const raS = String(r[map.ra] ?? '').trim(), decS = String(r[map.dec] ?? '').trim();
    const ra = parseAngle(raS, { hours: /[:hms ]/.test(raS) }), dec = parseAngle(decS);
    if (Number.isFinite(mjd) && Number.isFinite(ra) && Number.isFinite(dec) && Math.abs(dec) <= 90) points.push([mjd, wrap360(ra), dec]);
    else bad.push(i + 2);
  });
  return finishEphemeris(points, bad);
}

function finishEphemeris(points, bad) {
  points.sort((a, b) => a[0] - b[0]);
  const out = points.filter((p, i) => i === 0 || p[0] > points[i - 1][0]); // one position per time
  return out.length >= 2 ? { points: out, bad } : null;
}

/** Position at a time by linear interpolation (RA unwrapped across 0/360°); null outside the table's span. */
export function interpEph(points, mjd) {
  if (!points?.length || mjd < points[0][0] || mjd > points[points.length - 1][0]) return null;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid][0] <= mjd) lo = mid; else hi = mid; }
  const [t0, r0, d0] = points[lo], [t1, r1, d1] = points[hi];
  const f = t1 > t0 ? (mjd - t0) / (t1 - t0) : 0;
  let dr = r1 - r0; if (dr > 180) dr -= 360; if (dr < -180) dr += 360;
  return { ra: wrap360(r0 + f * dr), dec: d0 + f * (d1 - d0) };
}

/**
 * Search positions along the path: at most maxN points spread evenly in time, each with the time window it
 * stands for (half-way to its neighbours, plus a day). Images found at a point are kept only for that window.
 */
export function pathSamples(points, maxN = 240) {
  const n = points.length, step = Math.max(1, Math.ceil(n / maxN));
  const idx = [];
  for (let i = 0; i < n; i += step) idx.push(i);
  if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
  return idx.map((i, k) => {
    const t = points[i][0];
    const prev = k ? points[idx[k - 1]][0] : t, next = k < idx.length - 1 ? points[idx[k + 1]][0] : t;
    return { ra: points[i][1], dec: points[i][2], t0: (prev + t) / 2 - 1, t1: (t + next) / 2 + 1 };
  });
}

// ------------------------------------------------------------------ storage (this device): addresses carry an id
const KEY = 'skyshift.ephemerides';
const all = () => { try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch { return {}; } };

/** Keep an ephemeris on this device; returns its id (stable for the same table). */
export function saveEphemeris(name, points) {
  let h = 2166136261;
  for (const p of points) for (const v of p) { h ^= Math.round(v * 1e6) & 0xffffffff; h = Math.imul(h, 16777619) >>> 0; }
  const id = `e${h.toString(36)}`;
  const store = all();
  store[id] = { name: String(name || 'Moving object').slice(0, 80), points, saved: Date.now() };
  // keep the 20 most recent tables
  const ids = Object.keys(store).sort((a, b) => store[b].saved - store[a].saved);
  for (const old of ids.slice(20)) delete store[old];
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch { /* storage full: still usable this session */ }
  return id;
}

export function getEphemeris(id) { return all()[id] || null; }
