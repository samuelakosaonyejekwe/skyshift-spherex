// Builds data/overlays/<target>.json: Gaia DR3 and CatWISE2020 catalogue cones (IRSA TAP, seed 1) around
// each challenge target, so the Gaia and WISE overlays also work on hosts without an archive relay.
// Gaia DR3 and CatWISE2020 are fixed releases, so these files do not go stale; re-run only if the
// target list changes. Radius matches the viewer's largest overlay cone (0.6°).

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parseCSV } from '../src/lib/tap.js';

const TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
const R = 0.6, LIMIT = 3000;
async function tap(q) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(`${TAP}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'SkyShift-build/1.0' }, signal: AbortSignal.timeout(600000) });
      const t = await r.text();
      if (r.ok && !/QUERY_STATUS" value="ERROR|<html/i.test(t)) return parseCSV(t);
      console.warn('TAP error', t.slice(0, 200));
    } catch (e) { console.warn('TAP failed', e.message); }
    await new Promise((r) => setTimeout(r, 5000 * (i + 1)));
  }
  throw new Error('TAP unavailable');
}
const cone = (ra, dec) => `1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${ra}, ${dec}, ${R}))`;
// columns + rows arrays keep the files small; the app turns them back into objects
const pack = (rows, cols) => ({ cols, rows: rows.map((r) => cols.map((c) => r[c])) });

const T = JSON.parse(readFileSync('data/targets.json', 'utf8')).targets;
mkdirSync('data/overlays', { recursive: true });
for (const t of T) {
  const gaiaCols = ['source_id', 'ra', 'dec', 'pmra', 'pmdec', 'parallax', 'phot_g_mean_mag', 'bp_rp', 'ref_epoch'];
  const catCols = ['source_name', 'ra', 'dec', 'pmra', 'pmdec', 'w1mpro', 'w2mpro', 'meanobsmjd'];
  const gaia = await tap(`SELECT TOP ${LIMIT} ${gaiaCols.join(', ')} FROM gaia_dr3_source WHERE ${cone(t.ra, t.dec)} ORDER BY phot_g_mean_mag`);
  const catwise = await tap(`SELECT TOP ${LIMIT} ${catCols.join(', ')} FROM catwise_2020 WHERE ${cone(t.ra, t.dec)} ORDER BY w1mpro`);
  const out = { target: t.id, ra: t.ra, dec: t.dec, radiusDeg: R, built: new Date().toISOString(), source: 'IRSA TAP gaia_dr3_source and catwise_2020', gaia: pack(gaia, gaiaCols), catwise: pack(catwise, catCols) };
  writeFileSync(`data/overlays/${t.id}.json`, JSON.stringify(out));
  console.log(t.id, 'gaia', gaia.length, 'catwise', catwise.length);
}
