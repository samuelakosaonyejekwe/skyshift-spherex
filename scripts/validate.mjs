// Validation of the five challenge targets with the same pipeline the browser uses:
// IRSA TAP search -> byte-range reads from the IRSA S3 bucket -> reprojection -> six-month
// co-adds -> centroid motion (first vs last epoch) and aperture photometry per exposure.
// Compares measured proper motion with Gaia DR3 and reports brightness changes between
// survey passes. Writes docs/VALIDATION.md.  Usage: node scripts/validate.mjs [maxExposures]

import { readFileSync, writeFileSync } from 'node:fs';
import { SpherexImage } from '../src/lib/spherex.js';
import { makeGrid, renderExposure } from '../src/lib/engine.js';
import { uriToS3 } from '../src/lib/spherex.js';
import { groupExposures, perDetector } from '../src/lib/render.js';
import { measureMotion } from '../src/lib/dossier.js';
import { epochBrightness, questionable } from '../src/lib/discover.js';
import { mjdToISO } from '../src/lib/coords.js';
import { parseCSV } from '../src/lib/tap.js';

const MAX = Number(process.argv[2] || 360);
const T = JSON.parse(readFileSync('data/targets.json', 'utf8')).targets;
const DETS = { wise0855: [4, 5, 6] };
const EXCLUDED = JSON.parse(readFileSync('config.json', 'utf8')).excludeReleases || [];

let listSource = 'IRSA TAP search';
async function search(ra, dec, t) {
  const q = `SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', ${ra}, ${dec}), p.poly) ORDER BY p.time_bounds_lower`;
  let txt = null;
  try { const r = await fetch(`https://irsa.ipac.caltech.edu/TAP/sync?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(120000) }); if (r.ok) txt = await r.text(); } catch { /* below */ }
  if (!txt || /QUERY_STATUS" value="ERROR|<html/i.test(txt)) {
    // IRSA's search is down: use the same image list saved from it in data/targets.json (scripts/prebake.mjs)
    listSource = 'image lists saved from IRSA TAP in data/targets.json (TAP was unavailable)';
    return (t.images || []).filter(([u]) => !EXCLUDED.some((rel) => u.includes(`/${rel}/`))).map(([uri, mjd, det]) => ({ uri, mjd, det }));
  }
  return parseCSV(txt).filter((x) => /spx_l2b.*\.fits$/.test(x.uri) && !EXCLUDED.some((rel) => x.uri.includes(`/${rel}/`)))
    .map((x) => ({ uri: x.uri, mjd: x.time_bounds_lower, det: Number(String(x.energy_bandpassname).replace(/\D/g, '')) }));
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

const rows = [];
for (const t of T) {
  const t0 = Date.now();
  const all = (await search(t.ra, t.dec, t)).filter((e) => !DETS[t.id] || DETS[t.id].includes(e.det));
  const step = Math.max(1, all.length / MAX);
  const list = all.length > MAX ? Array.from({ length: MAX }, (_, k) => all[Math.floor(k * step)]) : all;
  const grid = makeGrid(t.ra, t.dec, 6);
  const target = { ra: t.ra, dec: t.dec, pmra: t.pmra || 0, pmdec: t.pmdec || 0, plx: t.parallax || 0, refEpoch: 2026.0 };
  const pm = t.pmra || t.pmdec ? { pmra: t.pmra, pmdec: t.pmdec, plx: t.parallax || 0, refYear: 2026.0 } : null;
  const frames = [];
  let bytes = 0, failed = 0;
  await pool(list, 16, async (rec) => {
    try {
      const r = await renderExposure(new SpherexImage(rec.uri, { onBytes: (b) => (bytes += b) }), grid, rec, { readMode: 'saver', withFlags: 'target', photTrack: pm });
      if (r) frames.push(r);
    } catch { failed++; }
  });
  const groups = groupExposures(frames, 'survey');
  const display = { groups, dmaps: groups.map((g) => perDetector(g, grid.n)) };
  const motion = measureMotion(display, grid, { target });
  const pts = frames.filter((f) => f.phot && Number.isFinite(f.meta.wavelength)).map((f) => ({ ...f.phot, wavelength: f.meta.wavelength, mjd: f.meta.mjd, det: f.meta.detector, saturated: f.meta.saturated }));
  const eb = epochBrightness(pts);
  const row = { id: t.id, name: t.name, searched: all.length, used: frames.length, failed, epochs: groups.map((g) => mjdToISO(Math.min(...g.map((e) => e.meta.mjd)), false)),
    saturated: frames.filter((f) => f.meta.saturated).length, questionable: pts.filter(questionable).length, points: pts.length, motion, change: eb.change, epochsB: eb.epochs, mb: bytes / 1048576, s: (Date.now() - t0) / 1000 };
  rows.push(row);
  console.log(t.name, JSON.stringify({ used: row.used, epochs: row.epochs.length, motion: motion && { m: motion.measured, r: motion.residual }, change: eb.change, mb: row.mb.toFixed(1), s: row.s.toFixed(0) }));
}

// Data per image: the same exposures read with only the columns the field needs ('saver') and with full rows.
const sample = [];
for (const t of T.slice(0, 3)) for (const im of (t.images || []).slice(0, 2)) sample.push({ t, rec: { uri: im[0], mjd: im[1], det: im[2] } });
let fileBytes = null;
try { fileBytes = Number((await fetch(uriToS3(sample[0].rec.uri), { method: 'HEAD' })).headers.get('content-length')) || null; } catch { /* keep null */ }
const perImage = [];
for (const fov of [2, 6, 10]) {
  const avg = {};
  for (const mode of ['saver', 'rows']) {
    let tot = 0, n = 0;
    for (const { t, rec } of sample) {
      let b = 0;
      try { await renderExposure(new SpherexImage(rec.uri, { onBytes: (x) => (b += x) }), makeGrid(t.ra, t.dec, fov), rec, { readMode: mode, withFlags: 'target' }); tot += b; n++; } catch { /* skip */ }
    }
    avg[mode] = n ? tot / n : null;
  }
  perImage.push({ fov, ...avg, n: sample.length });
}

const f = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
// speed (total proper motion) ratio and direction difference against Gaia, so partial agreement is visible
const speedDir = (m) => {
  if (!m?.predicted) return '–';
  // a speed or direction comparison only means something when Gaia's motion is well above the measurement noise
  const gsp = Math.hypot(m.predicted.pmra, m.predicted.pmdec), noise = Math.max(m.errRa || 0, m.errDec || 0);
  if (!(gsp > 3 * noise)) return `motion below SPHEREx noise (Gaia ${f(gsp)} mas/yr, ±${f(noise)})`;
  const sp = (v) => Math.hypot(v.pmra, v.pmdec), pa = (v) => (Math.atan2(v.pmra, v.pmdec) * 180) / Math.PI;
  let d = pa(m.measured) - pa(m.predicted); d = ((d + 540) % 360) - 180;
  return `${f(sp(m.measured))} vs ${f(sp(m.predicted))} (${f((sp(m.measured) / sp(m.predicted) - 1) * 100)}%); ${f(Math.abs(d))}°`;
};
let md = `# Validation of the five challenge targets

Generated ${new Date().toISOString()} by \`node scripts/validate.mjs ${MAX}\` with the same code the browser runs
(${listSource}, byte-range reads from the IRSA S3 bucket, TAN-SIP reprojection, six-month co-adds, centroids,
aperture photometry). Up to ${MAX} exposures per target, sampled evenly in time; 6′ fields; WISE 0855 uses D4–D6.

Browser maths is separately checked against Astropy (\`test/astropy.test.mjs\`, reference from
\`test/validate_astropy.py\`): worst differences 4e-10″ in position, 1e-8 px, 1e-15 µm in wavelength.

## Proper motion (first vs last survey co-add) compared with Gaia DR3

| Target | Exposures used | Epochs | Measured μα*, μδ (mas/yr) | Gaia DR3 μα*, μδ (mas/yr) | Residual (mas/yr) | ±1σ μα*, μδ (mas/yr) | Speed vs Gaia; direction difference | Notes |
|---|---|---|---|---|---|---|---|---|
`;
for (const r of rows) {
  const m = r.motion;
  md += `| ${r.name} | ${r.used} of ${r.searched} | ${r.epochs.length} (${r.epochs[0] || '–'} → ${r.epochs[r.epochs.length - 1] || '–'}) | ${m ? `${f(m.measured.pmra)}, ${f(m.measured.pmdec)}` : '–'} | ${m?.predicted ? `${f(m.predicted.pmra)}, ${f(m.predicted.pmdec)}` : 'not in Gaia DR3'} | ${m?.residual ? `${f(m.residual.pmra)}, ${f(m.residual.pmdec)}` : '–'} | ${m ? `${f(m.errRa)}, ${f(m.errDec)} (${m.nEpochs} epochs)` : '–'} | ${speedDir(m)} | ${[r.saturated ? `${r.saturated} exposures with saturated core` : '', m?.saturatedCore ? 'centroid on saturated star (wings only)' : '', m?.parallaxRemoved ? `parallax removed (up to ${m.maxParallaxShift.toFixed(2)}″)` : ''].filter(Boolean).join('; ') || '–'} |\n`;
}
md += `
## Brightness change between survey passes (relative to the target's mean spectrum)

| Target | Photometric points | Questionable | Per-pass mean (relative) | Largest change | Significance |
|---|---|---|---|---|---|
`;
for (const r of rows) {
  md += `| ${r.name} | ${r.points} | ${r.questionable} | ${r.epochsB.map((e) => `${((e.mean - 1) * 100).toFixed(1)}%±${(e.err * 100).toFixed(1)}`).join(' / ') || '–'} | ${r.change ? `${(r.change.delta * 100).toFixed(1)}% ± ${(r.change.err * 100).toFixed(1)}%` : '–'} | ${r.change ? `${r.change.sig.toFixed(1)}σ${r.change.sig >= 3 ? ' (candidate)' : ''}` : '–'} |\n`;
}
md += `
## Data per image (byte-range reads)

The same ${perImage[0].n} exposures (two each of the first three targets) read by the app's reader with flags for the
target only. A full SPHEREx level-2 file is ${fileBytes ? `${fileBytes.toLocaleString('en')} bytes` : 'about 65 MB'} (HTTP HEAD on the S3 copy).
Both modes give identical pixels; saver reads only the columns the field covers.

| Field | Saver mode | Full rows | Saving vs full rows | Saving vs whole file |
|---|---|---|---|---|
`;
for (const p of perImage) md += `| ${p.fov}′${p.fov === 6 ? ' (default)' : ''} | ${f(p.saver / 1e6, 3)} MB | ${f(p.rows / 1e6, 3)} MB | ${f(p.rows / p.saver, 1)}× | ${fileBytes ? `${f(fileBytes / p.saver)}×` : '–'} |\n`;
md += `
## Reading the results

- Motion: Gaussian-weighted centroids of the target in every six-month co-add, then a weighted straight-line fit;
  uncertainties from the fit residuals (3+ epochs) or centroid noise. A residual within about 2σ means the motion
  SkyShift measures from SPHEREx agrees with Gaia. The speed and direction column shows partial agreement (for
  example the right speed in a slightly wrong direction). Saturated stars are centroided on their wings. Parallax is
  removed: each epoch's annual-parallax shift (from the Gaia DR3 parallax) is subtracted from the measured position
  before the straight-line fit, and the predicted positions include parallax.
- Brightness changes use quick-look aperture photometry divided by the target's mean spectrum, so they mix
  wavelengths; ≥3σ is flagged as a candidate, not a confirmed variation.
- Transfer: ${rows.map((r) => `${r.name} ${r.mb.toFixed(0)} MB in ${r.s.toFixed(0)} s`).join('; ')}.
`;
writeFileSync('docs/VALIDATION.md', md);
console.log('docs/VALIDATION.md written');
