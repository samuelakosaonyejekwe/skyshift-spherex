// Builds data/packs/: the default Time Machine view (6′ field, no motion tracking; for each detector its first
// 64 exposures in the app's loading order, one file per detector) of each challenge target and of the fastest-moving Gaia DR3 stars,
// cut out of the SPHEREx images on IRSA's public S3 bucket with the same code the browser runs
// (src/lib/engine.js renderExposure). The app shows a pack at once and streams only newer exposures, so these
// fields open in about a second. Image lists come from IRSA TAP, as in the app. Run on the data schedule;
// a target whose search or reads fail keeps its previous pack.
//   node scripts/packs.mjs            all targets
//   node scripts/packs.mjs barnard    only targets whose id contains the argument
//   node scripts/packs.mjs --if-missing   only when there are no packs in the current format (push builds)

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { SpherexImage, describeUri } from '../src/lib/spherex.js';
import { renderExposure, makeGrid } from '../src/lib/engine.js';
import { orderForLoading } from '../src/lib/render.js';
import { encodePack } from '../src/lib/packs.js';
import { parseCSV } from '../src/lib/tap.js';
import { tilesNear, tilePath, decodeRow, contains } from '../src/lib/skyindex.js';

const OUT = 'data/packs';
const FOV = 6, PER_DET = 64, CONCURRENCY = Number(process.env.PACK_PARALLEL || 16);
const TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
const config = JSON.parse(readFileSync('config.json', 'utf8'));
const EXCLUDED = config.excludeReleases || ['qr1', 'qr2'];
const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--')) || '';
const FORMAT = 2; // 2: one file per detector (index.json packs[key] = { d1: file, … })

// the same targets, positions and motions the app opens (src/targets.js presetToTarget, src/views/chase.js fastTarget)
const bundled = JSON.parse(readFileSync('data/targets.json', 'utf8'));
const fast = existsSync('data/fastmovers.json') ? JSON.parse(readFileSync('data/fastmovers.json', 'utf8')).stars : [];
const presetGaia = new Set(bundled.targets.map((t) => String(t.gaia?.source_id || t.gaia || '')));
const targets = [
  ...bundled.targets.map((t) => ({ id: t.id, ra: t.ra, dec: t.dec, pmra: t.pmra || 0, pmdec: t.pmdec || 0, plx: t.parallax || 0, refEpoch: t.pmra || t.pmdec ? 2026.0 : 2016 })),
  // Chase cards round the position to 6 decimals in the address, so the pack uses the same grid centre
  ...fast.filter((s) => !presetGaia.has(s.id)).map((s) => ({ id: s.id, ra: Number(s.ra.toFixed(6)), dec: Number(s.dec.toFixed(6)), pmra: s.pmra, pmdec: s.pmdec, plx: s.parallax > 0 ? s.parallax : 0, refEpoch: 2016.0 })),
].filter((t) => t.id.includes(only));

// must match viewer.js loadKey for { fov: 6, track: false, no flag overlay }
const viewKey = (t) => `${t.ra.toFixed(6)},${t.dec.toFixed(6)},${FOV},0,`;

async function tap(q) {
  const url = `${TAP}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'SkyShift-packs/1.0' }, signal: AbortSignal.timeout(120000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const txt = await r.text();
      // IRSA can answer 200 with an error or maintenance page: never treat that as an empty result
      if (/QUERY_STATUS" value="ERROR|<html/i.test(txt)) throw new Error('TAP error document');
      return parseCSV(txt);
    } catch (e) { if (i === 2) throw e; await new Promise((res) => setTimeout(res, 5000 * (i + 1))); }
  }
}

// Fixed per detector at IRSA (as in src/lib/tap.js), for rows read from the image index
const BAND_BOUNDS = { 1: [7.455e-7, 1.1167e-6], 2: [1.1033e-6, 1.6499e-6], 3: [1.6301e-6, 2.4346e-6], 4: [2.4027e-6, 3.8473e-6], 5: [3.8113e-6, 4.43e-6], 6: [4.4115e-6, 5.0096e-6] };
const idxMeta = (() => { try { return JSON.parse(readFileSync('data/idx/meta.json', 'utf8')); } catch { return null; } })();

/** Same rows as src/lib/tap.js searchIndex, from the local image index (the list the deployed app searches). */
function indexRows(t) {
  const rows = [];
  for (const tile of tilesNear(t.ra, t.dec, idxMeta.r)) {
    let txt = ''; try { txt = readFileSync(tilePath(tile), 'utf8'); } catch { /* empty tile */ }
    for (const line of txt.split('\n')) { const x = line && decodeRow(line); if (x && contains(x.corners, t.ra, t.dec)) rows.push(x); }
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.map((x) => ({ uri: x.uri, time_bounds_lower: x.t, time_bounds_upper: x.t + 0.0013324, energy_bandpassname: `SPHEREx-D${x.det}`, energy_bounds_lower: BAND_BOUNDS[x.det][0], energy_bounds_upper: BAND_BOUNDS[x.det][1] }));
}

async function images(t) {
  // the image index when this run has one (what the deployed app searches), otherwise IRSA TAP
  const rows = idxMeta ? indexRows(t) : await tap(`SELECT a.uri, p.time_bounds_lower, p.time_bounds_upper, p.energy_bandpassname, p.energy_bounds_lower, p.energy_bounds_upper, p.datarelease
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', ${t.ra}, ${t.dec}), p.poly)
ORDER BY p.time_bounds_lower`);
  // same filtering and fields as src/lib/tap.js searchSpherex
  return rows.filter((x) => /spx_l2b.*\.fits$/.test(x.uri) && !EXCLUDED.some((r) => x.uri.includes(`/${r}/`))).map((x) => {
    const d = describeUri(x.uri);
    const det = Number(String(x.energy_bandpassname || '').replace(/\D/g, '')) || d.detector;
    return {
      uri: String(x.uri).replace(/^\//, ''), mjd: x.time_bounds_lower, mjdEnd: x.time_bounds_upper ?? x.time_bounds_lower,
      det, release: d.release, obsid: d.obsid, period: d.period,
      wlmin: x.energy_bounds_lower ? x.energy_bounds_lower * 1e6 : null, wlmax: x.energy_bounds_upper ? x.energy_bounds_upper * 1e6 : null,
    };
  });
}

let index = { packs: {} };
try { index = JSON.parse(readFileSync(`${OUT}/index.json`, 'utf8')); } catch { /* first run */ }
if (args.includes('--if-missing') && index.format === FORMAT) { console.log('frame packs present (current format): not rebuilt'); process.exit(0); }
if (index.format !== FORMAT) index = { packs: {} };
mkdirSync(OUT, { recursive: true });

for (const t of targets) {
  const t0 = Date.now();
  try {
    const list = await images(t);
    // one file per detector: that detector's first PER_DET exposures in the app's loading order, so any detector
    // selection of two or more is covered by the default budget of 120 images
    const perDet = [1, 2, 3, 4, 5, 6].map((d) => orderForLoading(list.filter((e) => e.det === d)).slice(0, PER_DET));
    const wanted = perDet.flat();
    const grid = makeGrid(t.ra, t.dec, FOV);
    const pm = t.pmra || t.pmdec || t.plx ? { pmra: t.pmra, pmdec: t.pmdec, plx: t.plx, refYear: t.refEpoch } : null;
    const got = new Map();
    let i = 0, failed = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (i < wanted.length) {
        const rec = wanted[i++];
        try {
          // as the app with default settings: quality flags for photometry only, column-precise reads
          const r = await renderExposure(new SpherexImage(rec.uri), grid, rec, { withFlags: 'target', track: null, photTrack: pm, readMode: 'saver' });
          if (r) got.set(rec, { data: r.data, meta: r.meta, phot: r.phot, rec });
        } catch { failed++; }
      }
    }));
    if (!got.size) throw new Error(`no frames (${list.length} images found)`);
    if (failed > wanted.length * 0.1) throw new Error(`${failed} of ${wanted.length} exposures unreadable`);
    const built = new Date().toISOString(), entry = {};
    let bytes = 0;
    perDet.forEach((recs, k) => {
      const frames = recs.map((r) => got.get(r)).filter(Boolean);
      if (!frames.length) return;
      const gz = gzipSync(encodePack({ key: viewKey(t), built, n: grid.n, frames }), { level: 9 });
      const file = `${t.id}-d${k + 1}.bin`;
      writeFileSync(`${OUT}/${file}`, gz); entry[`d${k + 1}`] = file; bytes += gz.length;
    });
    index.packs[viewKey(t)] = entry;
    console.log(`${t.id}: ${got.size} frames (of ${list.length} images) in ${Object.keys(entry).length} detector files, ${(bytes / 1024).toFixed(0)} kB, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  } catch (e) {
    console.warn(`${t.id}: kept the previous pack (${e.message})`);
  }
}
// drop entries and files of targets no longer in the lists
const keep = new Set(targets.length && !only ? targets.map(viewKey) : Object.keys(index.packs));
for (const k of Object.keys(index.packs)) if (!keep.has(k)) delete index.packs[k];
// entries from the older one-file-per-field layout are dropped (the app reads one file per detector)
for (const k of Object.keys(index.packs)) if (typeof index.packs[k] !== 'object') delete index.packs[k];
const files = new Set(Object.values(index.packs).flatMap((e) => Object.values(e)));
for (const f of readdirSync(OUT)) if (f.endsWith('.bin') && !files.has(f)) rmSync(`${OUT}/${f}`);
index.built = new Date().toISOString();
index.format = FORMAT;
writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
