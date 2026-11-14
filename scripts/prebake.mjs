// Refreshes data/targets.json: the challenge test targets with Gaia DR3 astrometry
// and the list of SPHEREx images covering each one (from IRSA TAP). The app always
// queries IRSA live first; this file is only the fallback for static hosting
// without a relay, and for first-run offline use. Safe to run on a schedule.

import { writeFileSync, readFileSync } from 'node:fs';
import { propagate } from '../src/lib/coords.js';
import { parseCSV } from '../src/lib/tap.js';

const TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
// releases left out of searches, from config.json (one list shared with the app and the index)
const EXCLUDE = new RegExp(`/(${(JSON.parse(readFileSync('config.json', 'utf8')).excludeReleases || ['qr2']).join('|')})/`);
const EPOCH = 2026.0; // display epoch near the middle of the SPHEREx surveys to date

const TARGETS = [
  { id: 'barnard', name: "Barnard's Star", kind: 'Nearby red dwarf — the fastest proper motion of any star (≈10.4″/yr)', gaia: '4472832130942575872',
    labels: { '4472832130942575872': "Barnard's Star" },
    tip: 'Very bright: its core saturates SPHEREx. Turn on motion tracking or compare the first and last epochs to see it march north.' },
  { id: 'epsindib', name: 'Epsilon Indi B', kind: 'Pair of brown dwarfs (Ba/Bb) orbiting the star ε Indi A', gaia: '6412596012146801152',
    tip: 'Cold brown dwarfs are brightest at long wavelengths: try detectors D5–D6 or the colour mode. Open a 15′ field to include the host star ε Indi A.',
    labels: { '6412596012146801152': 'ε Indi Ba/Bb (brown-dwarf pair, unresolved)', '6412595290592307840': 'ε Indi A (host star)' } },
  { id: 'wise0855', name: 'WISE 0855−0714', kind: 'Coldest known brown dwarf, fast-moving (challenge position 08h55m10.831s −7°14′42.53″)',
    ra: 133.786245, dec: -7.244372, posNote: 'Centre from the WiseView link in the challenge resources',
    tip: 'Very faint below 3 µm. Use D5–D6, co-add each survey and difference the epochs.' },
  { id: 'rwaur', name: 'RW Aurigae', kind: 'Young variable binary star (T Tauri type)', gaia: '156430822114424576', labels: { '156430822114424576': 'RW Aur' },
    tip: 'Open the light curve: brightness changes between epochs show up at the same wavelength.' },
  { id: 'rdra', name: 'R Draconis', kind: 'Mira-type long-period variable star', gaia: '1648328016354496384', labels: { '1648328016354496384': 'R Dra' },
    tip: 'Large-amplitude variable. Compare spectra from different surveys.' },
];

// Each request gives up after 2 minutes; once IRSA has failed every retry of one query, the rest of this run
// keeps the previous data instead of waiting on a service that is down.
let tapDown = false;
async function tap(q) {
  if (tapDown) throw new Error('TAP skipped (IRSA unavailable earlier in this run): ' + q.slice(0, 60));
  const url = `${TAP}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`;
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': 'SkyShift-prebake/1.0' }, signal: AbortSignal.timeout(120000) });
      const t = await r.text();
      // IRSA can answer 200 with an error document: never treat that as an empty result
      if (r.ok && !/QUERY_STATUS" value="ERROR|<html/i.test(t)) return parseCSV(t);
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 3000 * (i + 1)));
  }
  tapDown = true;
  throw new Error('TAP failed: ' + q.slice(0, 80));
}

const out = { generated: new Date().toISOString(), epoch: EPOCH, targets: [] };
let prev = null, fresh = 0;
try { prev = JSON.parse(readFileSync('data/targets.json', 'utf8')); } catch { /* first run */ }

for (const t of TARGETS) {
  try {
    const rec = { id: t.id, name: t.name, kind: t.kind, tip: t.tip, labels: t.labels || {} };
    if (t.gaia) {
      const [g] = await tap(`SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ref_epoch FROM gaia_dr3_source WHERE source_id = ${t.gaia}`);
      const p = propagate(g.ra, g.dec, g.pmra, g.pmdec, g.ref_epoch, EPOCH);
      Object.assign(rec, { ra: +p.ra.toFixed(6), dec: +p.dec.toFixed(6), pmra: g.pmra, pmdec: g.pmdec, parallax: g.parallax, gmag: g.phot_g_mean_mag,
        gaia: { source_id: String(g.source_id), ra: g.ra, dec: g.dec, ref_epoch: g.ref_epoch }, posNote: `Gaia DR3 ${g.source_id} propagated to ${EPOCH}` });
    } else Object.assign(rec, { ra: t.ra, dec: t.dec, posNote: t.posNote });
    const rows = await tap(`SELECT a.uri, p.time_bounds_lower, p.energy_bandpassname FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', ${rec.ra}, ${rec.dec}), p.poly) ORDER BY p.time_bounds_lower`);
    rec.images = rows.filter((r) => /spx_l2b.*\.fits$/.test(r.uri) && !EXCLUDE.test(r.uri))
      .map((r) => [r.uri, +Number(r.time_bounds_lower).toFixed(6), Number(String(r.energy_bandpassname).replace(/\D/g, ''))]);
    const was = prev?.targets?.find((x) => x.id === t.id);
    if (!rec.images.length && was?.images?.length) throw new Error('no images returned (kept the previous list)');
    out.targets.push(rec); fresh++;
    console.log(t.name, rec.ra, rec.dec, rec.images.length, 'images');
  } catch (e) {
    const old = prev?.targets?.find((x) => x.id === t.id);
    if (old) { out.targets.push(old); console.warn(t.name, 'kept previous:', e.message); } else console.warn(t.name, 'failed:', e.message);
  }
}
try {
  const [n] = await tap('SELECT MAX(time_bounds_lower) AS newest FROM spherex.plane');
  out.newestSpherexMjd = n.newest;
} catch { out.newestSpherexMjd = prev?.newestSpherexMjd ?? null; }
// the time stamp says when the data were last refreshed, so a run that kept everything keeps the old stamp
if (!fresh && prev?.generated) out.generated = prev.generated;
writeFileSync('data/targets.json', JSON.stringify(out));
console.log('data/targets.json written');
