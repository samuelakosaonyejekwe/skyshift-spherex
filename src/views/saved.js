// Saved: watchlist (fields saved for offline use, with new-data alerts), candidates
// with full provenance, and CSV/JSON export. Everything stays on this device.

import { h, toast, download, icon } from '../ui/dom.js';
import { toParams, normalise } from '../state.js';
import { formatRA, formatDec, mjdToISO } from '../lib/coords.js';
import { searchSpherex } from '../lib/tap.js';
import { cache } from '../lib/store.js';

export const title = 'Saved';
const WATCH = 'skyshift.watch', CANDS = 'skyshift.candidates';
const read = (k) => { try { return JSON.parse(localStorage.getItem(k) || '[]'); } catch { return []; } };
const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
const same = (a, b) => Math.abs(a.ra - b.ra) < 1e-5 && Math.abs(a.dec - b.dec) < 1e-5;

export function isWatched(req) { return read(WATCH).some((w) => same(w.target, req.target)); }
export function toggleWatch(req) {
  const list = read(WATCH);
  const i = list.findIndex((w) => same(w.target, req.target));
  if (i >= 0) { list.splice(i, 1); write(WATCH, list); return false; }
  list.unshift({ target: req.target, url: `#/view?${toParams(normalise(req))}`, saved: Date.now(), knownNewest: null, knownCount: null });
  write(WATCH, list);
  searchSpherex(req.target.ra, req.target.dec).then((r) => {
    const l = read(WATCH); const w = l.find((x) => same(x.target, req.target));
    if (w && r.source === 'live') { w.knownCount = r.data.length; w.knownNewest = Math.max(...r.data.map((e) => e.mjd)); write(WATCH, l); }
  }).catch(() => {});
  return true;
}

/** Called when IRSA's newest exposure date advances: re-check saved fields for new coverage. */
export async function checkWatchlist(newestMjd) {
  const list = read(WATCH);
  const last = Number(localStorage.getItem('skyshift.watchChecked') || 0);
  if (!list.length || newestMjd <= last) return;
  localStorage.setItem('skyshift.watchChecked', String(newestMjd));
  for (const w of list) {
    try {
      const r = await searchSpherex(w.target.ra, w.target.dec);
      if (r.source !== 'live') continue;
      const newest = Math.max(...r.data.map((e) => e.mjd));
      if (w.knownNewest && newest > w.knownNewest + 0.01) {
        const added = r.data.filter((e) => e.mjd > w.knownNewest).length;
        toast({ kind: 'update', glyph: '🛰', timeout: 0, title: `New SPHEREx data for ${w.target.name || 'a saved field'}`, text: `${added} new exposure${added > 1 ? 's' : ''} up to ${mjdToISO(newest, false)}.`, actions: [{ label: 'Open', primary: true, onClick: () => { location.hash = w.url; } }, { label: 'Later' }] });
      }
      w.knownNewest = newest; w.knownCount = r.data.length;
    } catch { /* try next time */ }
  }
  write(WATCH, list);
}

export function saveCandidate(c) {
  const list = read(CANDS);
  const id = `C${Date.now().toString(36)}`;
  list.unshift({ id, created: new Date().toISOString(), software: 'SkyShift', ...c });
  write(CANDS, list);
  return id;
}

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

export async function render(root) {
  const draw = () => {
    const watch = read(WATCH), cands = read(CANDS);
    root.replaceChildren(
      h('h1', {}, 'Saved on this device'),
      h('p', { class: 'muted' }, 'Fields you save keep working offline, and SkyShift checks them whenever IRSA ingests new SPHEREx data. Nothing here leaves your device unless you export it.'),
      h('section', { class: 'card', style: { marginBottom: '14px' } },
        h('h2', {}, `Watchlist (${watch.length})`),
        watch.length ? h('table', { class: 'table' }, h('tr', {}, ['Field', 'Position', 'Saved', 'Known data', ''].map((x) => h('th', {}, x))),
          watch.map((w) => h('tr', {},
            h('td', {}, h('a', { href: w.url }, w.target.name || 'Field')),
            h('td', { class: 'mono' }, `${formatRA(w.target.ra)} ${formatDec(w.target.dec)}`),
            h('td', {}, new Date(w.saved).toLocaleDateString()),
            h('td', {}, w.knownCount != null ? `${w.knownCount} exposures to ${mjdToISO(w.knownNewest, false)}` : '–'),
            h('td', {}, h('button', { class: 'btn small ghost', onclick: () => { write(WATCH, read(WATCH).filter((x) => !same(x.target, w.target))); draw(); } }, 'Remove')))))
          : h('p', { class: 'empty' }, 'No saved fields yet. Use “Save” in the viewer.')),
      h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, `Candidates (${cands.length})`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small', disabled: !cands.length, onclick: () => download('skyshift-candidates.json', JSON.stringify({ exported: new Date().toISOString(), note: 'Candidates require your own vetting before any report.', candidates: cands }, null, 2), 'application/json') }, icon('download'), 'JSON'),
          h('button', { class: 'btn small', disabled: !cands.length, onclick: () => {
            const cols = ['id', 'created', 'type', 'ra', 'dec', 'catalog', 'frameDate', 'note', 'url', 'exposures'];
            const csv = cols.join(',') + '\n' + cands.map((c) => cols.map((k) => csvEscape(k === 'exposures' ? (c.exposures || []).join(' ') : k === 'frameDate' && c.frameDate ? mjdToISO(c.frameDate) : c[k])).join(',')).join('\n');
            download('skyshift-candidates.csv', csv, 'text/csv');
          } }, icon('download'), 'CSV')),
        h('p', { class: 'tiny' }, 'Each candidate keeps the exact view link and the SPHEREx files it was seen in, so anyone can re-check it. Candidates are not discoveries: report only after your own checks.'),
        cands.length ? h('table', { class: 'table' }, h('tr', {}, ['Type', 'Position', 'Note', 'Saved', ''].map((x) => h('th', {}, x))),
          cands.map((c) => h('tr', {},
            h('td', {}, h('span', { class: 'chip' }, c.type)),
            h('td', { class: 'mono' }, `${formatRA(c.ra)} ${formatDec(c.dec)}`, c.catalog ? h('div', { class: 'tiny' }, c.catalog) : null),
            h('td', {}, c.note || '–'),
            h('td', {}, new Date(c.created).toLocaleString()),
            h('td', {}, h('a', { class: 'btn small', href: c.url && c.url.includes('#/view') ? c.url.slice(c.url.indexOf('#')) : '#/' }, 'Open'), ' ',
              h('button', { class: 'btn small ghost', onclick: () => { write(CANDS, read(CANDS).filter((x) => x.id !== c.id)); draw(); } }, 'Delete')))))
          : h('p', { class: 'empty' }, 'No candidates yet. Click an object in the viewer and choose “Mark candidate”.')),
      h('section', { class: 'card', style: { marginTop: '14px' } },
        h('h2', {}, 'Storage'), storageLine,
        h('button', { class: 'btn small', onclick: async () => { if (confirm('Delete all cached images and searches from this device? Saved fields and candidates are kept.')) { await cache.clear(); toast({ title: 'Cache cleared', glyph: '🧹', timeout: 2500 }); updateStorage(); } } }, 'Clear cached images')),
    );
  };
  const storageLine = h('p', { class: 'tiny' }, 'Checking storage…');
  const updateStorage = async () => {
    const { usage = 0, quota = 0 } = await cache.usage();
    storageLine.textContent = quota ? `SkyShift uses ${(usage / 1048576).toFixed(1)} MB of ${(quota / 1073741824).toFixed(1)} GB available for offline data. Older images are removed automatically when space runs low.` : 'Storage information is not available in this browser.';
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  };
  draw(); updateStorage();
  return () => {};
}
