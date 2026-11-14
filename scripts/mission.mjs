// Builds data/coverage.json and data/mission.json from IRSA TAP aggregate queries on
// spherex.obscore (seed 1). Coverage: SPHEREx spectral images per 1° cell, spread over each
// image's ~3.5° x 3.5° footprint (2040 px x 6.15″), plus the date each cell was last observed.
// Mission: totals, images per day, images per detector band, survey dates, sky fraction.
// Safe to run on a schedule; keeps the previous files if IRSA does not answer.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { parseCSV } from '../src/lib/tap.js';

const TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
const MJD0 = 60780;
async function tap(q, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${TAP}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'SkyShift-build/1.0' }, signal: AbortSignal.timeout(900000) });
      const t = await r.text();
      if (r.ok && !/QUERY_STATUS" value="ERROR/.test(t)) return parseCSV(t);
      console.warn('TAP error', (t.match(/<INFO[^>]*>([^<]+)/) || [])[1] || t.slice(0, 200));
    } catch (e) { console.warn('TAP failed', e.message); }
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
  }
  throw new Error('TAP unavailable: ' + q.slice(0, 80));
}

try {
  const t0 = Date.now();
  const span = await tap('SELECT MIN(t_min) AS t0, MAX(t_min) AS t1, COUNT(*) AS n FROM spherex.obscore');
  const T0 = Math.floor(span[0].t0), T1 = Math.ceil(span[0].t1);
  const cells = [], perDayRows = [];
  for (let a = T0; a <= T1; a += 20) {
    const b = Math.min(T1 + 1, a + 20);
    const w = `t_min >= ${a} AND t_min < ${b}`;
    cells.push(...await tap(`SELECT FLOOR(s_ra) AS ra, FLOOR(s_dec) AS dc, COUNT(*) AS n, MAX(t_min) AS tlast FROM spherex.obscore WHERE ${w} GROUP BY ra, dc`));
    perDayRows.push(...await tap(`SELECT FLOOR(t_min) AS d, COUNT(*) AS n FROM spherex.obscore WHERE ${w} GROUP BY d`));
    process.stdout.write(`window ${a}-${b}: ${cells.length} cells\n`);
  }
  console.log('cells', cells.length, ((Date.now() - t0) / 1000).toFixed(0), 's');
  const W = 360, H = 180;
  const centres = new Float64Array(W * H), lastC = new Float64Array(W * H);
  let total = 0;
  for (const c of cells) {
    const i = ((c.ra % 360) + 360) % 360, j = Math.min(179, Math.max(0, c.dc + 90));
    centres[j * W + i] += c.n; lastC[j * W + i] = Math.max(lastC[j * W + i], c.tlast); total += c.n;
  }
  // spread each cell's images over the ~3.5° footprint (half-width 1.74°)
  const R = 1.74;
  const counts = new Float64Array(W * H), last = new Float64Array(W * H);
  for (let j = 0; j < H; j++) {
    const dec = j - 90 + 0.5;
    for (let i = 0; i < W; i++) {
      const n = centres[j * W + i];
      if (!n) continue;
      const cosd = Math.max(0.05, Math.cos((dec * Math.PI) / 180));
      const dr = Math.min(180, Math.ceil(R / cosd)), dd = Math.ceil(R);
      for (let y = Math.max(0, j - dd); y <= Math.min(H - 1, j + dd); y++) for (let dx = -dr; dx <= dr; dx++) {
        const x = (((i + dx) % W) + W) % W;
        counts[y * W + x] += n; last[y * W + x] = Math.max(last[y * W + x], lastC[j * W + i]);
      }
    }
  }
  const u16 = (arr, f) => { const a = new Uint16Array(W * H); for (let k = 0; k < a.length; k++) a[k] = Math.min(65535, Math.round(f(arr[k]))); return Buffer.from(a.buffer).toString('base64'); };
  let covered = 0, area = 0;
  for (let j = 0; j < H; j++) { const w = Math.cos(((j - 90 + 0.5) * Math.PI) / 180); for (let i = 0; i < W; i++) { area += w; if (counts[j * W + i]) covered += w; } }
  writeFileSync('data/coverage.json', JSON.stringify({ w: W, h: H, mjd0: MJD0, note: 'SPHEREx spectral images per 1° cell (IRSA spherex.obscore, spread over each image footprint); lastDay = days after mjd0', counts: u16(counts, (v) => v), lastDay: u16(last, (v) => (v ? v - MJD0 : 0)), built: new Date().toISOString() }));

  const dayMap = new Map(); for (const r of perDayRows) dayMap.set(r.d, (dayMap.get(r.d) || 0) + r.n);
  const perDay = [...dayMap].sort((x, y) => x[0] - y[0]).map(([d, n]) => ({ d, n }));
  const perBand = await tap('SELECT energy_bandpassname AS band, COUNT(*) AS n FROM spherex.obscore GROUP BY band ORDER BY band');
  const mission = {
    built: new Date().toISOString(), images: total, firstMjd: span[0].t0, lastMjd: span[0].t1, skyFraction: covered / area,
    days: perDay.length, perDay: perDay.map((r) => [r.d, r.n]), perBand: perBand.map((r) => [r.band, r.n]),
    source: 'IRSA TAP spherex.obscore (all releases currently served)',
  };
  writeFileSync('data/mission.json', JSON.stringify(mission));
  console.log('data/coverage.json and data/mission.json written', { images: total, sky: mission.skyFraction.toFixed(3), days: mission.days, s: ((Date.now() - t0) / 1000).toFixed(0) });
} catch (e) {
  console.error(e.message);
  if (!existsSync('data/coverage.json')) process.exit(1);
  console.warn('kept previous data files');
}
