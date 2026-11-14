// Data freshness (shown inside Mission): checks each of the eight challenge resources from the user's browser
// (directly where CORS allows, otherwise through the allow-listed relay) and shows
// what SkyShift takes from each, how fresh it is, and whether it answered.

import { h, icon, masonry } from '../ui/dom.js';
import { smartFetch } from '../lib/net.js';
import { latestSpherex, latestNeossat, loadBundled } from '../lib/tap.js';
import { niceDate, niceDateTime } from '../lib/coords.js';

const ago = (iso) => { const m = Math.max(0, (Date.now() - Date.parse(iso)) / 60000); return m < 90 ? `${Math.round(m)} min ago` : m < 2880 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`; };
import { cache } from '../lib/store.js';

export const title = 'Data freshness';

export const SOURCES = [
  { id: 'irsa', n: 1, name: 'SPHEREx at NASA/IPAC IRSA', url: 'https://irsa.ipac.caltech.edu/Missions/spherex.html',
    uses: 'Image search (TAP: spherex.plane + spherex.artifact), spectral images (public S3 bucket, byte ranges), cutouts, band definitions, flags, releases, DOIs, the SPHEREx all-sky HiPS, Gaia DR3 and WISE catalogues hosted at IRSA.',
    probe: async () => {
      const [page, newest] = await Promise.all([pageInfo('https://irsa.ipac.caltech.edu/Missions/spherex.html', /(\w+ \d{1,2}, 20\d\d|\w+ 20\d\d):[^\n]{5,140}/g), latestSpherex()]);
      return { ...page, extra: newest.data ? `Newest SPHEREx exposure in the archive: ${niceDateTime(newest.data)}${newest.source !== 'live' ? ' (saved)' : ''}` : null };
    } },
  { id: 'tutorials', n: 2, name: 'IRSA SPHEREx tutorials', url: 'https://caltech-ipac.github.io/irsa-tutorials/spherex/',
    uses: 'Access patterns SkyShift follows: TAP query of spherex.artifact/plane, cutout syntax, WCS-WAVE wavelength lookup, FLAGS bits, ePSF, all-sky cube indexing, photometry flags.',
    probe: async () => {
      const r = await fetch('https://api.github.com/repos/Caltech-IPAC/irsa-tutorials/commits?per_page=1', { cache: 'no-store' });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const [c] = await r.json();
      const page = await pageInfo('https://caltech-ipac.github.io/irsa-tutorials/spherex/', /SPHEREx[^\n<]{3,80}/g).catch(() => ({}));
      return { ok: true, status: 200, lines: page.lines?.slice(0, 6), extra: c ? `Latest tutorial repository change: ${niceDate(c.commit.committer.date)} — “${c.commit.message.split('\n')[0].slice(0, 90)}”` : null };
    } },
  { id: 'wiseview', n: 3, name: 'WiseView (Backyard Worlds)', url: 'http://byw.tools/wiseview',
    uses: 'The citizen-science blink design; WiseView-style URL parameters are accepted, and every field has an “Open in WiseView” link for a then-and-now look with WISE/NEOWISE.',
    probe: async () => pageInfo('http://byw.tools/wiseview', /<title>([^<]+)/g) },
  { id: 'gaia', n: 4, name: 'Gaia at MAST', url: 'https://archive.stsci.edu/missions-and-data/gaia',
    uses: 'Gaia DR3 positions, proper motions and parallaxes (MAST API Mast.Catalogs.GaiaDR3.Cone first, with IRSA’s gaia_dr3_source as the fallback) for overlays, target motion and blend warnings.',
    probe: async () => {
      const page = await pageInfo('https://archive.stsci.edu/missions-and-data/gaia', /Gaia (?:DR\d|EDR\d)[^\n<]{0,80}/g).catch((e) => ({ ok: false, error: e.message }));
      const res = await smartFetch('https://mast.stsci.edu/api/v0/invoke', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'request=' + encodeURIComponent(JSON.stringify({ service: 'Mast.Catalogs.GaiaDR3.Cone', params: { ra: 269.4485, dec: 4.7394, radius: 0.005 }, format: 'json', pagesize: 1, page: 1 })) });
      const j = JSON.parse((await res.text().catch(() => '{}')).replace(/"(source_id|solution_id|random_index)"\s*:\s*(-?\d{16,})/g, '"$1":"$2"') || '{}');
      return { ...page, ok: page.ok !== false || j.status === 'COMPLETE', extra: j.status === 'COMPLETE' ? `MAST Gaia DR3 cone search answered live (${j.data?.length ?? 0} row test).` : `MAST API status: ${j.status || res.status}` };
    } },
  { id: 'neossat', n: 5, name: 'NEOSSat (Canadian Space Agency)', url: 'https://www.asc-csa.gc.ca/eng/satellites/neossat/',
    uses: 'Mission context for NEOSSat, the microsatellite that observes asteroids and comets; its images are listed per field from CADC.',
    probe: async () => pageInfo('https://www.asc-csa.gc.ca/eng/satellites/neossat/', /Date modified:\s*[\d-]+/g) },
  { id: 'cadc', n: 6, name: 'Canadian Astronomy Data Centre', url: 'https://www.cadc-ccda.hia-iha.nrc-cnrc.gc.ca/en/',
    uses: 'NEOSSat observations near each field (TAP service “argus”, ivoa.ObsCore, collection NEOSSAT) with links to the data.',
    probe: async () => {
      const r = await latestNeossat();
      return { ok: true, status: 200, extra: r.data ? `Newest NEOSSat observation at CADC: ${niceDateTime(r.data.t_min)} (${r.data.target_name || 'unnamed target'})${r.source !== 'live' ? ' (saved)' : ''}` : 'No NEOSSat rows returned' };
    } },
  { id: 'neotut', n: 7, name: 'NEOSSat tutorial (GitHub)', url: 'https://github.com/asc-csa/NEOSSAT_Tutorial',
    uses: 'How NEOSSat FITS images are organised and read (open-data folders by year/day, FITS headers); informs the NEOSSat listing and its caveats.',
    probe: async () => {
      const r = await fetch('https://api.github.com/repos/asc-csa/NEOSSAT_Tutorial/commits?per_page=1', { cache: 'no-store' });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const [c] = await r.json();
      return { ok: true, status: 200, extra: c ? `Latest change: ${niceDate(c.commit.committer.date)} — “${c.commit.message.split('\n')[0].slice(0, 90)}”` : null };
    } },
  { id: 'neodata', n: 8, name: 'NEOSSat open data (CSA)', url: 'https://data.asc-csa.gc.ca/dataset/neossat',
    uses: 'The open-data catalogue of NEOSSat images. Checked live; when its server cannot be reached securely, SkyShift lists NEOSSat data through CADC instead.',
    probe: async () => {
      const res = await smartFetch('https://data.asc-csa.gc.ca/api/3/action/package_show?id=neossat', { timeout: 30000 });
      const j = await res.json();
      if (!j.success) throw new Error('Open-data API did not answer');
      const r = j.result;
      return { ok: true, status: 200, lastModified: r.metadata_modified ? `${niceDate(r.metadata_modified)} (catalogue record)` : null,
        extra: `${r.title?.en || r.title || 'NEOSSat'} · ${r.num_resources ?? r.resources?.length ?? '?'} resources · licence: ${r.license_title || r.license_id || 'see portal'}`,
        lines: (r.resources || []).slice(0, 5).map((x) => (typeof x.name === 'object' ? x.name.en : x.name) || x.format || 'resource') };
    } },
];

async function pageInfo(url, re) {
  const res = await smartFetch(url, { timeout: 30000 });
  const upstream = Number(res.headers.get('x-relay-upstream-status') || res.status);
  const text = await res.text();
  if (!res.ok || upstream >= 400) {
    let detail = '';
    try { detail = JSON.parse(text).detail || JSON.parse(text).error || ''; } catch { /* html */ }
    throw new Error(`HTTP ${upstream}${detail ? ` (${detail})` : ''}`);
  }
  const lines = [];
  const plain = text.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, '').replace(/<(?!title)[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  for (const m of plain.matchAll(re)) { const s = (m[1] || m[0]).replace(/\s+/g, ' ').trim(); if (s && !lines.includes(s)) lines.push(s); if (lines.length >= 8) break; }
  return { ok: true, status: upstream, lastModified: res.headers.get('last-modified'), lines, bytes: text.length };
}

export async function render(root, route, ctx, { embedded = false } = {}) {
  const grid = h('div', { class: 'sources-m' });
  const stamp = h('span', { class: 'tiny' });
  const refreshBtn = h('button', { class: 'btn small', onclick: () => run() }, icon('refresh'), 'Check again');
  const bundle = await loadBundled();
  // results of the scheduled server-side check (scripts/sources.mjs), used where a live check is not possible
  const scheduled = await fetch('./data/sources.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  root.append(
    embedded ? null : h('h1', {}, 'Data freshness'),
    h('p', { class: 'muted prose' }, 'SkyShift uses only the eight resources listed by the challenge, and pages and services reached from them. Every check below runs now, from your device, against the live sites. Archives that do not allow direct browser access are reached through a small relay that only forwards to these sites.'),
    h('div', { class: 'row', style: { marginBottom: '12px' } }, refreshBtn, stamp, h('span', { class: 'tiny' }, bundle.generated ? ` · built-in fallback image lists refreshed ${niceDate(bundle.generated)}` : '')),
    grid);
  const cards = new Map();
  for (const s of SOURCES) {
    const status = h('span', { class: 'src-status wait' }, 'Checking…');
    const body = h('div', { class: 'tiny' });
    const card = h('article', { class: 'card' },
      h('div', { class: 'row' }, h('span', { class: 'chip' }, `Resource ${s.n}`), h('div', { class: 'spacer' }), status),
      h('h3', {}, s.name), h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer', class: 'tiny' }, s.url),
      h('p', { class: 'tiny', style: { marginTop: '8px' } }, h('b', {}, 'Used for: '), s.uses), body);
    cards.set(s.id, { status, body });
    grid.append(card);
  }
  const cardEls = [...grid.children];
  const relayout = masonry(grid, cardEls);
  let timer;
  async function run() {
    stamp.textContent = `Last checked ${new Date().toLocaleTimeString()}`;
    await Promise.all(SOURCES.map(async (s) => {
      const c = cards.get(s.id);
      c.status.className = 'src-status wait'; c.status.textContent = 'Checking…';
      const t0 = performance.now();
      try {
        // GitHub-hosted resources: use the scheduled server check while it is recent (spares visitors' GitHub API limit)
        const sch = scheduled?.results?.[s.id];
        if (/github/.test(s.url + s.id) || s.id === 'tutorials') {
          if (sch?.ok && Date.now() - Date.parse(scheduled.checked) < 8 * 3600e3) throw Object.assign(new Error('scheduled'), { useScheduled: true });
        }
        const r = await s.probe();
        const ms = Math.round(performance.now() - t0);
        c.status.className = `src-status ${r.ok === false ? 'bad' : 'ok'}`;
        c.status.textContent = r.ok === false ? 'Not reachable' : `Live · ${ms} ms`;
        c.body.replaceChildren(
          r.extra ? h('p', {}, r.extra) : null,
          r.lastModified ? h('p', {}, `Page last modified: ${r.lastModified}`) : null,
          r.lines?.length ? h('ul', {}, r.lines.slice(0, 6).map((l) => h('li', {}, l))) : null,
          r.error ? h('p', { class: 'notice warn' }, r.error) : null);
        await cache.set(`src:${s.id}`, { at: Date.now(), extra: r.extra || null, lines: r.lines || [] });
        relayout();
      } catch (e) {
        const prev = await cache.get(`src:${s.id}`);
        const sched = scheduled?.results?.[s.id];
        if (sched?.ok && (navigator.onLine || e.useScheduled)) {
          // this host cannot check the resource live (no relay): show the scheduled server-side check instead
          c.status.className = 'src-status ok';
          c.status.textContent = `Checked ${ago(scheduled.checked)}`;
          c.body.replaceChildren(
            h('p', { class: 'tiny muted' }, `Checked from SkyShift’s build server on ${niceDateTime(scheduled.checked)} (${sched.ms} ms)${sched.stale ? '; latest attempt failed, showing the last good check' : ''}.${e.useScheduled ? '' : ' This host has no archive relay for a live check.'}`),
            sched.extra ? h('p', {}, sched.extra) : null,
            sched.lastModified ? h('p', {}, `Page last modified: ${sched.lastModified}`) : null,
            sched.lines?.length ? h('ul', {}, sched.lines.slice(0, 6).map((l) => h('li', {}, l))) : null);
        } else {
          c.status.className = 'src-status bad';
          c.status.textContent = navigator.onLine ? 'Not reachable now' : 'Offline';
          c.body.replaceChildren(h('p', { class: 'notice warn' }, `${e.message || e}`),
            prev ? h('p', {}, `Last good check ${new Date(prev.at).toLocaleString()}: ${prev.extra || (prev.lines || []).slice(0, 2).join(' · ')}`) : null);
        }
        relayout();
      }
    }));
  }
  run();
  timer = setInterval(run, 10 * 60 * 1000);
  return () => { clearInterval(timer); relayout.disconnect?.(); };
}
