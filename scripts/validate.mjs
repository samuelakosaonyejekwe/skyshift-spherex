// Validation of the five challenge targets with the same pipeline the browser uses:
// IRSA TAP search -> byte-range reads from the IRSA S3 bucket -> reprojection -> six-month
// co-adds -> centroid motion (first vs last epoch) and aperture photometry per exposure.
// Compares measured proper motion with Gaia DR3 and reports brightness changes between
// survey passes. Writes docs/VALIDATION.md.  Usage: node scripts/validate.mjs [maxExposures]

import { readFileSync, writeFileSync } from 'node:fs';
import { SpherexImage } from '../src/lib/spherex.js';
import { makeGrid, renderExposure } from '../src/lib/engine.js';
import { groupExposures, perDetector } from '../src/lib/render.js';
import { measureMotion } from '../src/lib/dossier.js';
import { epochBrightness, questionable } from '../src/lib/discover.js';
import { mjdToISO } from '../src/lib/coords.js';
import { parseCSV } from '../src/lib/tap.js';

const MAX = Number(process.argv[2] || 360);
const T = JSON.parse(readFileSync('data/targets.json', 'utf8')).targets;
const DETS = { wise0855: [4, 5, 6] };

async function search(ra, dec) {
  const q = `SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid WHERE 1 = CONTAINS(POINT('ICRS', ${ra}, ${dec}), p.poly) ORDER BY p.time_bounds_lower`;
  const r = await fetch(`https://irsa.ipac.caltech.edu/TAP/sync?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`);
  return parseCSV(await r.text()).filter((x) => /spx_l2b.*\.fits$/.test(x.uri) && !/\/qr[12]\//.test(x.uri))
    .map((x) => ({ uri: x.uri, mjd: x.time_bounds_lower, det: Number(String(x.energy_bandpassname).replace(/\D/g, '')) }));
}

async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } })); }

const rows = [];
for (const t of T) {
  const t0 = Date.now();
  const all = (await search(t.ra, t.dec)).filter((e) => !DETS[t.id] || DETS[t.id].includes(e.det));
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

const f = (x, d = 0) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
let md = `# Validation of the five challenge targets

Generated ${new Date().toISOString()} by \`node scripts/validate.mjs ${MAX}\` with the same code the browser runs
(IRSA TAP search, byte-range reads from the IRSA S3 bucket, TAN-SIP reprojection, six-month co-adds, centroids,
aperture photometry). Up to ${MAX} exposures per target, sampled evenly in time; 6′ fields; WISE 0855 uses D4–D6.

Browser maths is separately checked against Astropy (\`test/astropy.test.mjs\`, reference from
\`test/validate_astropy.py\`): worst differences 4e-10″ in position, 1e-8 px, 1e-15 µm in wavelength.

## Proper motion (first vs last survey co-add) compared with Gaia DR3

| Target | Exposures used | Epochs | Measured μα*, μδ (mas/yr) | Gaia DR3 μα*, μδ (mas/yr) | Residual (mas/yr) | ±1σ μα*, μδ (mas/yr) | Notes |
|---|---|---|---|---|---|---|---|
`;
for (const r of rows) {
  const m = r.motion;
  md += `| ${r.name} | ${r.used} of ${r.searched} | ${r.epochs.length} (${r.epochs[0] || '–'} → ${r.epochs[r.epochs.length - 1] || '–'}) | ${m ? `${f(m.measured.pmra)}, ${f(m.measured.pmdec)}` : '–'} | ${m?.predicted ? `${f(m.predicted.pmra)}, ${f(m.predicted.pmdec)}` : 'not in Gaia DR3'} | ${m?.residual ? `${f(m.residual.pmra)}, ${f(m.residual.pmdec)}` : '–'} | ${m ? `${f(m.errRa)}, ${f(m.errDec)} (${m.nEpochs} epochs)` : '–'} | ${[r.saturated ? `${r.saturated} exposures with saturated core` : '', m?.saturatedCore ? 'centroid on saturated star (wings only)' : ''].filter(Boolean).join('; ') || '–'} |\n`;
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
## Reading the results

- Motion: Gaussian-weighted centroids of the target in every six-month co-add, then a weighted straight-line fit;
  uncertainties from the fit residuals (3+ epochs) or centroid noise. A residual within about 2σ means the motion
  SkyShift measures from SPHEREx agrees with Gaia. Saturated stars are centroided on their wings. Parallax is not
  fitted, so for nearby stars part of the residual is the yearly parallax wobble (Barnard's Star ϖ = 0.55″).
- Brightness changes use quick-look aperture photometry divided by the target's mean spectrum, so they mix
  wavelengths; ≥3σ is flagged as a candidate, not a confirmed variation.
- Transfer: ${rows.map((r) => `${r.name} ${r.mb.toFixed(0)} MB in ${r.s.toFixed(0)} s`).join('; ')}.
`;
writeFileSync('docs/VALIDATION.md', md);
console.log('docs/VALIDATION.md written');
