// Builds the static SPHEREx image index (data/idx/) from IRSA TAP (seed 1): every SPHEREx spectral
// image (spherex.artifact JOIN spherex.plane, level-2b files) with its time, detector and footprint,
// written as small per-tile files (layout and encoding in src/lib/skyindex.js). The app uses it to
// search any position on static hosts that cannot run the archive relay (e.g. GitHub Pages).
// Not committed (too large); built by the scheduled workflow and carried between runs in the
// Actions cache. Keeps the previous index if IRSA does not answer.

import { mkdirSync, writeFileSync, rmSync, renameSync, existsSync, readFileSync } from 'node:fs';
import { parseCSV } from '../src/lib/tap.js';
import { encodeRow, cornersFromWkb, tileOf, sep } from '../src/lib/skyindex.js';

const TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
const OUT = 'data/idx', TMP = 'data/idx.tmp';
const WINDOW = Number(process.env.INDEX_WINDOW_DAYS || 5), PARALLEL = Number(process.env.INDEX_PARALLEL || 3);
const excluded = JSON.parse(readFileSync('config.json', 'utf8')).excludeReleases || [];

async function tap(q, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${TAP}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'SkyShift-build/1.0' }, signal: AbortSignal.timeout(900000) });
      const t = await r.text();
      if (r.ok && !/QUERY_STATUS" value="ERROR/.test(t)) return parseCSV(t);
      console.warn('TAP error', (t.match(/<INFO[^>]*>([^<]+)/) || [])[1] || t.slice(0, 200));
    } catch (e) { console.warn('TAP failed', e.message); }
    await new Promise((r) => setTimeout(r, 10000 * (i + 1)));
  }
  throw new Error('TAP unavailable: ' + q.slice(0, 100));
}

try {
  const t0 = Date.now();
  const span = await tap("SELECT MIN(p.time_bounds_lower) AS t0, MAX(p.time_bounds_lower) AS t1 FROM spherex.plane p WHERE p.energy_bandpassname LIKE 'SPHEREx-D%'");
  const T0 = Math.floor(span[0].t0), T1 = Math.floor(span[0].t1) + 1; // snapshot: images starting before T1
  const windows = []; for (let a = T0; a < T1; a += WINDOW) windows.push([a, Math.min(T1, a + WINDOW)]);
  const tiles = new Map();
  let count = 0, skipped = 0, newest = 0, rMax = 0, fallbackKeys = 0;
  const run = async ([a, b]) => {
    const rows = await tap(`SELECT a.uri, p.time_bounds_lower AS t, p.energy_bandpassname AS band, p.poly FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid WHERE p.time_bounds_lower >= ${a} AND p.time_bounds_lower < ${b} AND a.uri LIKE '%spx_l2b%'`);
    for (const x of rows) {
      const uri = String(x.uri).replace(/^\//, '');
      const det = Number(String(x.band).replace(/\D/g, ''));
      if (!/\.fits$/.test(uri) || !(det >= 1 && det <= 6) || excluded.some((r) => uri.includes(`/${r}/`)) || !x.poly) { skipped++; continue; }
      let corners;
      try { corners = cornersFromWkb(x.poly); } catch { skipped++; continue; }
      if (corners.length !== 4) { skipped++; continue; }
      const { line, centre } = encodeRow(uri, x.t, det, corners);
      if (line.startsWith('=')) fallbackKeys++;
      for (const [r, d] of corners) rMax = Math.max(rMax, sep(centre[0], centre[1], r, d));
      const k = tileOf(centre[0], centre[1]); const id = `${k.b}/${k.c}`;
      if (!tiles.has(id)) tiles.set(id, []);
      tiles.get(id).push(line);
      count++; newest = Math.max(newest, x.t);
    }
    process.stdout.write(`window ${a}-${b}: ${rows.length} rows, total ${count}\n`);
  };
  for (let i = 0; i < windows.length; i += PARALLEL) await Promise.all(windows.slice(i, i + PARALLEL).map(run));
  if (!count) throw new Error('no images returned');
  rmSync(TMP, { recursive: true, force: true });
  let bytes = 0;
  for (const [id, lines] of tiles) {
    const [b] = id.split('/');
    mkdirSync(`${TMP}/${b}`, { recursive: true });
    lines.sort((x, y) => Number(x.split(',')[1]) - Number(y.split(',')[1]));
    const txt = lines.join('\n') + '\n';
    writeFileSync(`${TMP}/${id}.txt`, txt); bytes += txt.length;
  }
  const meta = { built: new Date().toISOString(), images: count, newestMjd: newest, tiles: tiles.size, r: Math.ceil(rMax * 100 + 1) / 100, bandDeg: 2, version: 1, source: 'IRSA TAP spherex.artifact JOIN spherex.plane (level-2b spectral images), releases excluded: ' + (excluded.join(', ') || 'none') };
  writeFileSync(`${TMP}/meta.json`, JSON.stringify(meta));
  rmSync(OUT, { recursive: true, force: true });
  renameSync(TMP, OUT);
  console.log('index written', { ...meta, skipped, fallbackKeys, MB: (bytes / 1e6).toFixed(1), s: ((Date.now() - t0) / 1000).toFixed(0) });
} catch (e) {
  console.error(e.message);
  rmSync(TMP, { recursive: true, force: true });
  if (!existsSync(`${OUT}/meta.json`)) console.warn('no index available (the app falls back to the relay)');
  else {
    console.warn('kept previous index; adding new images from the archive storage instead (scripts/index-s3.mjs)');
    try { await (await import('./index-s3.mjs')).updateFromStorage(); } catch (e2) { console.warn('storage update failed:', e2.message); }
  }
}
