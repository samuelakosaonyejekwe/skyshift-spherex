// Asteroids and comets by name: their daily positions since SPHEREx images began (May 2025) from NASA JPL Horizons,
// through the relay (Horizons sends no CORS headers). Added by the author beyond the challenge's eight resources.

import { smartFetch } from './net.js';
import { horizonsCommand, horizonsQuery, readHorizons } from './ephem.js';

export const HORIZONS_API = 'https://ssd.jpl.nasa.gov/api/horizons.api';
export const SURVEY_START_DATE = '2025-05-01';

/** Does this text look like an asteroid or comet rather than a star (numbered "4 Vesta", "67P", "C/2023 A3", "2024 YR4")? */
export function looksSolarSystem(text) {
  const s = String(text || '').trim();
  return /^\(?\d{1,7}\)?\s+[A-Za-z][\w' -]*$/.test(s) // 4 Vesta, (433) Eros
    || /^\d{1,4}[PDCXI](?:[-/].*)?$/i.test(s) // 67P, 67P/Churyumov-Gerasimenko
    || /^[PDCXI]\/\d{4}\s?[A-Z]{1,2}\d{0,3}/i.test(s) // C/2023 A3
    || /^\d{4}\s?[A-Z]{2}\d{0,3}$/i.test(s); // 2024 YR4
}

/** { name, points: [[mjd, ra, dec], …], source } or { error, options } for what the user typed. */
export async function lookupSolarSystem(text, { signal } = {}) {
  const command = horizonsCommand(text);
  if (!command) return { error: 'type the name, number or designation of an asteroid or comet' };
  const end = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const res = await smartFetch(`${HORIZONS_API}?${horizonsQuery(command, SURVEY_START_DATE, end)}`, { timeout: 60000, signal });
  if (res.headers.get('x-relay-upstream-status') && Number(res.headers.get('x-relay-upstream-status')) >= 500) throw new Error('NASA JPL Horizons did not answer');
  let body;
  try { body = await res.json(); } catch { throw new Error('NASA JPL Horizons gave an unreadable answer'); }
  const h = readHorizons(body.result || body.error || '');
  return h.error ? h : { ...h, name: h.name || String(text).trim(), source: 'NASA JPL Horizons' };
}
