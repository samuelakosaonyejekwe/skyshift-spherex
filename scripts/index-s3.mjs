// Updates the static image index (data/idx/) from IRSA's public SPHEREx bucket when IRSA's search service (TAP) is
// down: it lists the newest planning periods in the bucket, reads the FITS header of each new level-2b file (one
// small range request: time, detector, WCS) and adds the file's footprint to the index tiles. Same rows as the TAP
// build (scripts/index.mjs): path, start time (MJD-BEG = TAP time_bounds_lower), detector and the four corners.
//   node scripts/index-s3.mjs          add files newer than the index (run by scripts/index.mjs when TAP fails)
//   node scripts/index-s3.mjs --check  compare corners computed from headers with rows IRSA TAP gave (no writes)

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { list } from '../src/lib/livelist.js';
import { SpherexImage } from '../src/lib/spherex.js';
import { encodeRow, decodeRow, tileOf, tilePath, sep } from '../src/lib/skyindex.js';

const OUT = 'data/idx';
const PARALLEL = Number(process.env.INDEX_S3_PARALLEL || 24);

/** ISO week of a period name like 2026W40_1A → MJD of that week's Monday. */
function periodStartMjd(period) {
  const m = /^(\d{4})W(\d{2})/.exec(period);
  if (!m) return NaN;
  const jan4 = Date.UTC(+m[1], 0, 4), dow = (new Date(jan4).getUTCDay() + 6) % 7;
  return (jan4 - dow * 86400000 + (+m[2] - 1) * 7 * 86400000) / 86400000 + 40587;
}

/** Footprint of a SPHEREx image from its header WCS: the four outer pixel corners, as the TAP footprints. */
export function footprint(img, h) {
  const W = h.NAXIS1, H = h.NAXIS2;
  return [[0.5, 0.5], [W + 0.5, 0.5], [W + 0.5, H + 0.5], [0.5, H + 0.5]].map(([x, y]) => img.wcs.pixToWorld(x, y));
}

async function listAll(prefix) {
  let keys = [], startAfter = '';
  for (let page = 0; page < 200; page++) {
    const l = await list(prefix, { delimiter: '', startAfter });
    keys = keys.concat(l.keys.map((k) => k.key).filter((k) => /spx_l2b.*\.fits$/.test(k)));
    if (!l.truncated || !l.keys.length) break;
    startAfter = l.keys[l.keys.length - 1].key;
  }
  return keys;
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function headerRow(key) {
  const uri = `ibe/data/spherex/${key}`;
  const img = new SpherexImage(uri);
  const m = await img.meta();
  const h = m.header;
  const t = h['MJD-BEG'] ?? (h['MJD-AVG'] != null && h.XPOSURE ? h['MJD-AVG'] - h.XPOSURE / 172800 : null);
  const det = Number(h.DETECTOR);
  if (!Number.isFinite(t) || !(det >= 1 && det <= 6)) return null;
  return { uri, t, det, corners: footprint(img, h) };
}

export async function updateFromStorage({ log = console.log } = {}) {
  const meta = JSON.parse(readFileSync(`${OUT}/meta.json`, 'utf8'));
  const excluded = JSON.parse(readFileSync('config.json', 'utf8')).excludeReleases || [];
  const since = meta.newestMjd;
  // the release that receives weekly data (the newest periods); finished releases do not change
  const rels = (await list('')).prefixes.map((p) => p.replace(/\/$/, '')).filter((r) => /^(qr|dr)\d+$/.test(r) && !excluded.includes(r));
  const periods = [];
  for (const rel of rels) {
    for (const p of (await list(`${rel}/level2/`)).prefixes) {
      const period = p.split('/')[2];
      if (periodStartMjd(period) >= since - 8) periods.push(p); // the week holding the newest indexed image, and later
    }
  }
  // every processing folder of each period (a main run and sometimes a smaller "retry" run)
  let keys = [];
  for (const p of periods) for (const v of (await list(p)).prefixes) keys.push(...(await listAll(v)));
  // files the index already holds are skipped, so only new files cost a header read
  const names = periods.map((p) => `|${p.split('/')[2]}|`);
  const known = new Set();
  for (const b of readdirSync(OUT).filter((d) => /^\d+$/.test(d))) for (const f of readdirSync(`${OUT}/${b}`)) {
    for (const line of readFileSync(`${OUT}/${b}/${f}`, 'utf8').split('\n')) if (line && names.some((x) => line.includes(x))) { const r = decodeRow(line); if (r) known.add(r.uri); }
  }
  const total = keys.length;
  keys = keys.filter((k) => !known.has(`ibe/data/spherex/${k}`));
  if (process.env.INDEX_S3_LIMIT) keys.splice(Number(process.env.INDEX_S3_LIMIT)); // trial runs only
  log(`archive storage: ${periods.length} recent planning periods, ${total} files, ${keys.length} not in the index yet`);
  const added = new Map();
  let n = 0, failed = 0, newest = since, rMax = 0;
  await pool(keys, PARALLEL, async (key) => {
    try {
      const row = await headerRow(key);
      if (row) {
        const { line, centre } = encodeRow(row.uri, row.t, row.det, row.corners);
        for (const [r, d] of row.corners) rMax = Math.max(rMax, sep(centre[0], centre[1], r, d));
        const k = tileOf(centre[0], centre[1]); const id = `${k.b}/${k.c}`;
        if (!added.has(id)) added.set(id, []);
        added.get(id).push(line);
        n++; newest = Math.max(newest, row.t);
      }
    } catch { failed++; }
  });
  if (failed > keys.length * 0.2) throw new Error(`${failed} of ${keys.length} headers unreadable: index left unchanged`);
  for (const [id, lines] of added) {
    const [b, c] = id.split('/');
    const f = tilePath({ b, c });
    mkdirSync(`${OUT}/${b}`, { recursive: true });
    const old = existsSync(f) ? readFileSync(f, 'utf8').split('\n').filter(Boolean) : [];
    const all = [...new Set([...old, ...lines])].sort((x, y) => Number(x.split(',')[1]) - Number(y.split(',')[1]));
    writeFileSync(f, all.join('\n') + '\n');
  }
  const next = { ...meta, built: new Date().toISOString(), images: meta.images + n, newestMjd: newest, r: n ? Math.max(meta.r || 0, Math.ceil(rMax * 100 + 1) / 100) : meta.r,
    tiles: readdirSync(OUT).filter((d) => /^\d+$/.test(d)).reduce((s, d) => s + readdirSync(`${OUT}/${d}`).length, 0),
    updatedFromStorage: { at: new Date().toISOString(), added: n, checked: keys.length, note: 'IRSA TAP unavailable: new files read from the public SPHEREx bucket (FITS headers)' } };
  writeFileSync(`${OUT}/meta.json`, JSON.stringify(next));
  log(`index updated from the archive storage: ${n} new images (checked ${keys.length}, ${failed} unreadable), newest MJD ${newest.toFixed(5)}`);
  return next;
}

/** Compare corners computed from headers with the rows IRSA TAP produced for the same files. */
async function check() {
  const meta = JSON.parse(readFileSync(`${OUT}/meta.json`, 'utf8'));
  const tiles = readdirSync(OUT).filter((d) => /^\d+$/.test(d)).slice(0, 40);
  const rows = [];
  for (const b of tiles) for (const f of readdirSync(`${OUT}/${b}`).slice(0, 2)) {
    const lines = readFileSync(`${OUT}/${b}/${f}`, 'utf8').split('\n').filter(Boolean);
    if (lines.length) rows.push(decodeRow(lines[lines.length - 1]));
  }
  let worst = 0, dt = 0;
  for (const r of rows.slice(0, 12)) {
    const key = r.uri.replace(/^ibe\/data\/spherex\//, '');
    const h = await headerRow(key);
    const enc = decodeRow(encodeRow(h.uri, h.t, h.det, h.corners).line);
    const d = Math.max(...r.corners.map((c, i) => sep(c[0], c[1], enc.corners[i][0], enc.corners[i][1]) * 3600));
    worst = Math.max(worst, d); dt = Math.max(dt, Math.abs(enc.t - r.t) * 86400);
    console.log(key.split('/').pop(), `corners differ by ≤ ${d.toFixed(2)}″, time by ${(Math.abs(enc.t - r.t) * 86400).toFixed(2)} s`);
  }
  console.log(`worst: ${worst.toFixed(2)}″ and ${dt.toFixed(2)} s (index corners are stored to 0.0001° = 0.36″); index newest MJD ${meta.newestMjd}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.includes('--check')) await check();
  else await updateFromStorage().catch((e) => { console.error('storage update failed:', e.message); process.exitCode = 0; });
}
