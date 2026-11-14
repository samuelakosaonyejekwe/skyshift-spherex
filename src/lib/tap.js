// Queries against the services named by the challenge resources:
//  IRSA TAP (SPHEREx spherex.plane/spherex.artifact, Gaia DR3, AllWISE, CatWISE2020),
//  MAST API (Gaia DR3 cone, fallback), CADC TAP "argus" (NEOSSat observations).
// Every result is cached so the tool keeps working offline and when a service is down.

import { smartFetch, getConfig, relayCount } from './net.js';
import { tilesNear, tilePath, decodeRow, contains } from './skyindex.js';
import { cache } from './store.js';
import { describeUri } from './spherex.js';

export const IRSA_TAP = 'https://irsa.ipac.caltech.edu/TAP/sync';
export const CADC_TAP = 'https://ws.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/argus/sync';
export const MAST_API = 'https://mast.stsci.edu/api/v0/invoke';

/** RFC-4180 CSV parser -> array of objects; numeric strings become numbers. */
export function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => {
    const o = {};
    head.forEach((h, k) => {
      const v = r[k] ?? '';
      const t = v.trim();
      // integers beyond 2^53 (e.g. Gaia DR3 source_id) must stay exact: keep them as strings
      if (/^-?\d{16,}$/.test(t)) { o[h] = t; return; }
      const n = t === '' ? null : Number(t);
      o[h] = n === null ? null : Number.isFinite(n) && /^[-+.\deE]+$/.test(t) ? n : v;
    });
    return o;
  });
}

const num = (x, d = 7) => Number(x).toFixed(d);

// When an archive's TAP service fails with a server error (e.g. IRSA's gateway answering 502), it is not called
// again for 10 minutes: callers go straight to their fallbacks instead of retrying a service that is down.
const tapDownUntil = new Map();
export const tapIsDown = (service) => (tapDownUntil.get(service) || 0) > Date.now();

export async function tap(service, adql, { timeout = 60000, signal } = {}) {
  if (tapIsDown(service)) throw new Error('TAP service unavailable (recent server error)');
  const url = `${service}?LANG=ADQL&FORMAT=csv&QUERY=${encodeURIComponent(adql)}`;
  let res;
  try { res = await smartFetch(url, { timeout, signal }); } catch (e) { if (e?.name === 'TimeoutError') tapDownUntil.set(service, Date.now() + 10 * 60e3); throw e; }
  const upstream = Number(res.headers.get('x-relay-upstream-status') || res.status);
  if (upstream >= 500 || upstream === 0) tapDownUntil.set(service, Date.now() + 10 * 60e3);
  const text = await res.text();
  if (!res.ok || upstream >= 400 || upstream === 0 || /<VOTABLE|QUERY_STATUS.*ERROR/i.test(text.slice(0, 600))) {
    const msg = (text.match(/<INFO[^>]*>([^<]+)/) || [])[1] || `HTTP ${upstream || res.status}`;
    throw new Error(`TAP error: ${msg.trim().slice(0, 200)}`);
  }
  return parseCSV(text);
}

/**
 * Network-first with cache fallback. Returns { data, source: 'live'|'cache'|'bundled', ts }.
 */
export async function fresh(key, fn, { bundled } = {}) {
  try {
    const data = await fn();
    await cache.set(key, data);
    return { data, source: 'live', ts: Date.now() };
  } catch (err) {
    const c = await cache.getFresh(key);
    if (c) return { data: c.v, source: 'cache', ts: c.ts, error: err };
    if (bundled) { const b = await bundled(); if (b) return { data: b, source: 'bundled', ts: null, error: err }; }
    throw err;
  }
}

let bundledTargets = null;
export async function loadBundled() {
  if (bundledTargets) return bundledTargets;
  try { bundledTargets = await (await fetch('./data/targets.json')).json(); } catch { bundledTargets = { targets: [] }; }
  return bundledTargets;
}

// Fixed per detector at IRSA (spherex.plane energy_bounds_lower/upper, metres) and the exposure length (days)
const BAND_BOUNDS = { 1: [7.455e-7, 1.1167e-6], 2: [1.1033e-6, 1.6499e-6], 3: [1.6301e-6, 2.4346e-6], 4: [2.4027e-6, 3.8473e-6], 5: [3.8113e-6, 4.43e-6], 6: [4.4115e-6, 5.0096e-6] };
const EXPOSURE_DAYS = 0.0013324;

let idxMeta;
/** The static image index on this host (data/idx/meta.json), or null when there is none. */
export async function indexMeta() {
  if (idxMeta !== undefined) return idxMeta;
  try { const r = await fetch('./data/idx/meta.json', { cache: 'no-cache' }); idxMeta = r.ok ? await r.json() : null; } catch { idxMeta = null; }
  return idxMeta;
}

/** Image search from the static index: same rows as the TAP search, as of the index build time. */
async function searchIndex(ra, dec) {
  const meta = await indexMeta();
  if (!meta) throw new Error('no archive relay or image index is available on this host');
  const texts = await Promise.all(tilesNear(ra, dec, meta.r).map(async (t) => {
    const r = await fetch(`./${tilePath(t)}`);
    if (r.ok) return r.text();
    if (r.status === 404) return ''; // empty tile
    throw new Error(`image index tile answered ${r.status}`);
  }));
  const rows = [];
  for (const txt of texts) for (const line of txt.split('\n')) {
    const x = line && decodeRow(line);
    if (x && contains(x.corners, ra, dec)) rows.push(x);
  }
  rows.sort((a, b) => a.t - b.t);
  return rows.map((x) => ({ uri: x.uri, time_bounds_lower: x.t, time_bounds_upper: x.t + EXPOSURE_DAYS, energy_bandpassname: `SPHEREx-D${x.det}`, energy_bounds_lower: BAND_BOUNDS[x.det][0], energy_bounds_upper: BAND_BOUNDS[x.det][1] }));
}

/**
 * All SPHEREx spectral images (every release currently ingested at IRSA) whose
 * footprint contains the position. Query pattern follows the IRSA SPHEREx cutouts
 * tutorial (spherex.artifact JOIN spherex.plane, CONTAINS on plane.poly).
 * Releases are not hard-coded: new DR/QR data appear as soon as IRSA ingests them.
 */
export async function searchSpherex(ra, dec, opts = {}) {
  const key = `search:${num(ra, 4)},${num(dec, 4)}`;
  const adql = `SELECT a.uri, p.time_bounds_lower, p.time_bounds_upper, p.energy_bandpassname, p.energy_bounds_lower, p.energy_bounds_upper, p.datarelease
FROM spherex.artifact a JOIN spherex.plane p ON a.planeid = p.planeid
WHERE 1 = CONTAINS(POINT('ICRS', ${num(ra)}, ${num(dec)}), p.poly)
ORDER BY p.time_bounds_lower`;
  let via = 'tap';
  const r = await fresh(key, async () => {
    // The pre-built index is the primary source wherever it exists (rebuilt every 6 hours; IRSA adds images
    // weekly): instant, and independent of IRSA's search service being up. Live TAP is used where there is no
    // recent index (e.g. local development), through the relay.
    let rows;
    const meta = await indexMeta();
    if (meta && Date.now() - Date.parse(meta.built) < 24 * 3600e3) { rows = await searchIndex(ra, dec); via = 'index'; }
    else if (relayCount() > 0) {
      try { rows = await tap(IRSA_TAP, adql, opts); } catch (e) { if (!meta) throw e; }
    }
    if (!rows) { rows = await searchIndex(ra, dec); via = 'index'; }
    // Superseded releases are listed in config.json ("excludeReleases"), so a new release needs no code change.
    const excluded = getConfig().excludeReleases || ['qr1', 'qr2'];
    return rows.filter((x) => /spx_l2b.*\.fits$/.test(x.uri) && !excluded.some((r) => x.uri.includes(`/${r}/`))).map(normalise);
  }, {
    bundled: async () => {
      const b = await loadBundled();
      const t = b.targets.find((t) => Math.abs(t.ra - ra) < 1e-3 && Math.abs(t.dec - dec) < 1e-3);
      return t?.images?.map((x) => normalise({ uri: x[0], time_bounds_lower: x[1], energy_bandpassname: `SPHEREx-D${x[2]}` }));
    },
  });
  return { ...r, adql, via, indexBuilt: via === 'index' ? (await indexMeta())?.built : undefined };
}

/** Saved (IndexedDB) or built-in image list for a position, without touching the network. */
export async function quickSpherex(ra, dec) {
  const key = `search:${num(ra, 4)},${num(dec, 4)}`;
  const c = await cache.getFresh(key);
  if (c?.v?.length) return { data: c.v, source: 'cache', ts: c.ts };
  const b = await loadBundled();
  const t = b.targets?.find((t) => Math.abs(t.ra - ra) < 1e-3 && Math.abs(t.dec - dec) < 1e-3);
  if (t?.images?.length) return { data: t.images.map((x) => normalise({ uri: x[0], time_bounds_lower: x[1], energy_bandpassname: `SPHEREx-D${x[2]}` })), source: 'bundled', ts: b.generated ? Date.parse(b.generated) : null };
  return null;
}

function normalise(x) {
  const d = describeUri(x.uri);
  const det = Number(String(x.energy_bandpassname || '').replace(/\D/g, '')) || d.detector;
  return {
    uri: String(x.uri).replace(/^\//, ''),
    mjd: x.time_bounds_lower, mjdEnd: x.time_bounds_upper ?? x.time_bounds_lower,
    det, release: d.release, obsid: d.obsid, period: d.period,
    wlmin: x.energy_bounds_lower ? x.energy_bounds_lower * 1e6 : null,
    wlmax: x.energy_bounds_upper ? x.energy_bounds_upper * 1e6 : null,
  };
}

/** Newest SPHEREx exposure date ingested at IRSA (signals new data); from the image index on static hosts. */
export async function latestSpherex() {
  return fresh('latest:spherex', async () => {
    // the index (rebuilt every 6 hours) already holds the newest exposure: use it while recent, sparing IRSA a
    // whole-table scan (about 30 s) on every visit; the live query is used when there is no recent index
    const m0 = await indexMeta();
    if (m0?.newestMjd && Date.now() - Date.parse(m0.built) < 7 * 3600e3) return m0.newestMjd;
    if (relayCount() > 0) {
      try { const r = await tap(IRSA_TAP, 'SELECT MAX(time_bounds_lower) AS newest FROM spherex.plane', { timeout: 60000 }); return r[0]?.newest ?? null; }
      catch (e) { if (!(await indexMeta())) throw e; }
    }
    const m = await indexMeta();
    if (!m) throw new Error('no archive relay or image index is available on this host');
    return m.newestMjd;
  });
}

// Built-in catalogue cones for the challenge targets (scripts/overlays.mjs), used when no relay answers.
const overlayFiles = new Map();
async function bundledCone(kind, ra, dec, radiusDeg) {
  const b = await loadBundled();
  const t = b.targets?.find((x) => Math.abs(x.ra - ra) < 0.01 && Math.abs(x.dec - dec) < 0.01);
  if (!t) return null;
  if (!overlayFiles.has(t.id)) overlayFiles.set(t.id, fetch(`./data/overlays/${t.id}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  const o = await overlayFiles.get(t.id);
  if (!o?.[kind] || radiusDeg > o.radiusDeg + 1e-6) return null;
  const cosd = Math.cos((dec * Math.PI) / 180);
  const rows = o[kind].rows.map((r) => Object.fromEntries(o[kind].cols.map((c, i) => [c, r[i]])))
    .filter((r) => Math.hypot((r.ra - ra) * cosd, r.dec - dec) <= radiusDeg);
  return { via: `built-in ${kind === 'gaia' ? 'Gaia DR3' : 'CatWISE2020'} list from IRSA TAP (${o.built.slice(0, 10)})`, rows };
}

/** Gaia DR3 cone: MAST's Mast.Catalogs.GaiaDR3.Cone (challenge resource 4) first, IRSA's gaia_dr3_source as fallback. */
export async function gaiaCone(ra, dec, radiusDeg, limit = 3000) {
  const key = `gaia:${num(ra, 4)},${num(dec, 4)},${num(radiusDeg, 3)}`;
  return fresh(key, async () => {
    try {
      const request = { service: 'Mast.Catalogs.GaiaDR3.Cone', params: { ra, dec, radius: radiusDeg }, format: 'json', pagesize: limit, page: 1 };
      const res = await smartFetch(MAST_API, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'request=' + encodeURIComponent(JSON.stringify(request)), timeout: 45000,
      });
      // quote 64-bit IDs before parsing so they are not rounded by JSON number precision
      const j = JSON.parse((await res.text()).replace(/"(source_id|solution_id|random_index)"\s*:\s*(-?\d{16,})/g, '"$1":"$2"'));
      if (!Array.isArray(j.data)) throw new Error(`MAST: ${j.status || 'no data'}`);
      return {
        via: 'MAST Mast.Catalogs.GaiaDR3.Cone',
        rows: j.data.map((s) => ({ source_id: String(s.source_id), ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, parallax: s.parallax, phot_g_mean_mag: s.phot_g_mean_mag, bp_rp: s.bp_rp, ref_epoch: s.ref_epoch })),
      };
    } catch (e) {
      const rows = await tap(IRSA_TAP, `SELECT TOP ${limit} source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, bp_rp, ref_epoch
FROM gaia_dr3_source WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${num(ra)}, ${num(dec)}, ${num(radiusDeg, 5)}))
ORDER BY phot_g_mean_mag`);
      return { via: `IRSA TAP gaia_dr3_source (MAST unavailable: ${e.message})`, rows };
    }
  }, { bundled: () => bundledCone('gaia', ra, dec, radiusDeg) });
}

/** CatWISE2020 (positions at MJD meanobsmjd, motions in arcsec/yr) from IRSA. */
export async function catwiseCone(ra, dec, radiusDeg, limit = 3000) {
  const key = `catwise:${num(ra, 4)},${num(dec, 4)},${num(radiusDeg, 3)}`;
  return fresh(key, async () => ({
    via: 'IRSA TAP catwise_2020',
    rows: await tap(IRSA_TAP, `SELECT TOP ${limit} source_name, ra, dec, pmra, pmdec, w1mpro, w2mpro, meanobsmjd
FROM catwise_2020 WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${num(ra)}, ${num(dec)}, ${num(radiusDeg, 5)}))`),
  }), { bundled: () => bundledCone('catwise', ra, dec, radiusDeg) });
}

/** AllWISE point sources from IRSA. */
export async function allwiseCone(ra, dec, radiusDeg, limit = 3000) {
  const key = `allwise:${num(ra, 4)},${num(dec, 4)},${num(radiusDeg, 3)}`;
  return fresh(key, async () => ({
    via: 'IRSA TAP allwise_p3as_psd',
    rows: await tap(IRSA_TAP, `SELECT TOP ${limit} designation, ra, dec, w1mpro, w2mpro, w3mpro, w4mpro, pmra, pmdec, cc_flags
FROM allwise_p3as_psd WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${num(ra)}, ${num(dec)}, ${num(radiusDeg, 5)}))`),
  }));
}

/** NEOSSat observations near a position from CADC's TAP service (collection NEOSSAT). */
export async function neossatCone(ra, dec, radiusDeg = 0.5) {
  const key = `neossat:${num(ra, 3)},${num(dec, 3)},${num(radiusDeg, 2)}`;
  return fresh(key, async () => ({
    via: 'CADC argus ivoa.ObsCore',
    rows: await tap(CADC_TAP, `SELECT TOP 300 obs_id, target_name, t_min, t_exptime, s_ra, s_dec, dataproduct_type, calib_level, access_url
FROM ivoa.ObsCore WHERE obs_collection = 'NEOSSAT'
AND 1 = CONTAINS(POINT('ICRS', s_ra, s_dec), CIRCLE('ICRS', ${num(ra)}, ${num(dec)}, ${num(radiusDeg, 4)}))
ORDER BY t_min DESC`),
  }));
}

/** Newest NEOSSat observation archived at CADC. */
export async function latestNeossat() {
  return fresh('latest:neossat', async () => {
    const r = await tap(CADC_TAP, "SELECT TOP 1 obs_id, target_name, t_min FROM ivoa.ObsCore WHERE obs_collection = 'NEOSSAT' ORDER BY t_min DESC");
    return r[0] || null;
  });
}
