// Builds data/fastmovers.json: the fastest-moving stars in Gaia DR3 (IRSA TAP gaia_dr3_source, seed 1), offered as
// suggestions on the Chase page. Gaia DR3 is a fixed release, so this needs re-running only for a new Gaia release.
import { writeFileSync } from 'node:fs';
import { parseCSV } from '../src/lib/tap.js';
const q = 'SELECT TOP 15 source_id, ra, dec, pm, pmra, pmdec, parallax, phot_g_mean_mag FROM gaia_dr3_source WHERE pm > 3000 ORDER BY pm DESC';
// long query (several minutes): IRSA's asynchronous TAP job, which is not cut off by the gateway's time limit
const job = await fetch('https://irsa.ipac.caltech.edu/TAP/async', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ LANG: 'ADQL', FORMAT: 'csv', QUERY: q, PHASE: 'RUN' }) });
let jobUrl = job.headers.get('location');
if (!jobUrl) { console.error('IRSA did not create a job:', job.status, (await job.text()).slice(0, 200)); process.exit(1); }
jobUrl = new URL(jobUrl, 'https://irsa.ipac.caltech.edu/').href;
let phase = '';
for (let i = 0; i < 120; i++) {
  phase = (await (await fetch(`${jobUrl}/phase`)).text()).trim();
  if (['COMPLETED', 'ERROR', 'ABORTED'].includes(phase)) break;
  await new Promise((res) => setTimeout(res, 10000));
}
if (phase !== 'COMPLETED') { console.error('IRSA job ended as', phase); process.exit(1); }
const r = await fetch(`${jobUrl}/results/result`);
const text = await r.text();
const rows = parseCSV(text).filter((x) => x.source_id);
if (!rows.length) { console.error('IRSA returned no rows:', r.status, text.slice(0, 300)); process.exit(1); }
writeFileSync('data/fastmovers.json', JSON.stringify({ built: new Date().toISOString(), source: `IRSA TAP: ${q}`, stars: rows.map((x) => ({ id: String(x.source_id), ra: x.ra, dec: x.dec, pm: x.pm, pmra: x.pmra, pmdec: x.pmdec, parallax: x.parallax, g: x.phot_g_mean_mag })) }));
console.log('data/fastmovers.json:', rows.length, 'stars');
