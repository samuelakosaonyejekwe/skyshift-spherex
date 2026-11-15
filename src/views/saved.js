// Saved: watchlist (fields saved for offline use, with new-data alerts), candidates
// with full provenance, and CSV/JSON export. Everything stays on this device.

import { h, toast, download, icon } from '../ui/dom.js';
import { toParams, normalise } from '../state.js';
import { formatRA, formatDec, mjdToISO, niceDate, niceDateTime } from '../lib/coords.js';
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
  let allChecked = true;
  for (const w of list) {
    try {
      const r = await searchSpherex(w.target.ra, w.target.dec);
      if (r.source !== 'live') { allChecked = false; continue; }
      const newest = Math.max(...r.data.map((e) => e.mjd));
      if (w.knownNewest && newest > w.knownNewest + 0.01) {
        const added = r.data.filter((e) => e.mjd > w.knownNewest).length;
        toast({ kind: 'update', glyph: '🛰', timeout: 0, title: `New SPHEREx data for ${w.target.name || 'a saved field'}`, text: `${added} new exposure${added > 1 ? 's' : ''} up to ${niceDate(newest)}.`, actions: [{ label: 'Open', primary: true, onClick: () => { location.hash = w.url; } }, { label: 'Later' }] });
      }
      // update only this field in the list as it is now, so saves or removals made meanwhile are kept
      const now = read(WATCH), cur = now.find((x) => x.url === w.url);
      if (cur) { cur.knownNewest = newest; cur.knownCount = r.data.length; write(WATCH, now); }
    } catch { allChecked = false; /* try next time */ }
  }
  // remembered only when every field was checked, so a failed check is retried next time
  if (allChecked) localStorage.setItem('skyshift.watchChecked', String(newestMjd));
}

// ---- queue of fields to inspect (from uploads or "many hands" lists)
const QUEUE = 'skyshift.queue';
export function setQueue(hashes, names = []) { localStorage.setItem(QUEUE, JSON.stringify({ items: hashes.map((h, i) => ({ hash: h, name: names[i] || null })), created: Date.now() })); }
export function getQueue() { try { return JSON.parse(localStorage.getItem(QUEUE) || 'null'); } catch { return null; } }
export function clearQueue() { localStorage.removeItem(QUEUE); }

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
      h('div', { class: 'saved-grid' },
      h('section', { class: 'card' },
        h('h2', {}, `Watchlist (${watch.length})`),
        watch.length ? h('table', { class: 'table' }, h('tr', {}, ['Field', 'Position', 'Saved', 'Known data', ''].map((x) => h('th', {}, x))),
          watch.map((w) => h('tr', {},
            h('td', {}, h('a', { href: w.url }, w.target.name || 'Field')),
            h('td', { class: 'mono' }, `${formatRA(w.target.ra)} ${formatDec(w.target.dec)}`),
            h('td', {}, niceDate(new Date(w.saved))),
            h('td', {}, w.knownCount != null ? `${w.knownCount} exposures to ${niceDate(w.knownNewest)}` : '–'),
            h('td', {}, h('button', { class: 'btn small ghost', onclick: () => { write(WATCH, read(WATCH).filter((x) => !same(x.target, w.target))); draw(); } }, 'Remove')))))
          : h('p', { class: 'empty compact' }, 'No saved fields yet. Use “Save” in the Time Machine to keep a field offline and get new-data alerts.')),
      h('section', { class: 'card' },
        h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, `Candidates (${cands.length})`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small', disabled: !cands.length, onclick: () => download('skyshift-candidates.json', JSON.stringify({ exported: new Date().toISOString(), note: 'Candidates require your own vetting before any report.', candidates: cands }, null, 2), 'application/json') }, icon('download'), 'JSON'),
          h('button', { class: 'btn small', disabled: !cands.length, title: 'MPC ADES (pipe-separated) observation records for candidates; reporting requires your own vetting', onclick: () => {
            // ADES PSV (Minor Planet Center Astrometry Data Exchange Standard), optical observations
            const pad = (v, w) => String(v).padEnd(w);
            const rows = cands.filter((c) => c.frameDate).map((c, i) => [pad(`SKY${String(i + 1).padStart(4, '0')}`, 9), pad('XXX', 4), pad(new Date((c.frameDate - 40587) * 864e5).toISOString().slice(0, 23) + 'Z', 25), pad(c.ra.toFixed(6), 11), pad((c.dec >= 0 ? '+' : '') + c.dec.toFixed(6), 11), pad('IR', 4), pad('SPHEREx candidate (SkyShift); unvetted', 40)].join('|'));
            const head = ['# version=2017', '# observatory', '! mpcCode XXX', '# submitter', '! name (fill in your name)', '# telescope', '! design Spectro-photometer', '! aperture 0.2', '# comment', '! line Candidates from SkyShift quick-look of SPHEREx images; positions not yet vetted or measured astrometrically.',
              'trkSub   |stn |obsTime                  |ra         |dec        |mode|remarks'];
            download('skyshift-candidates-ades.psv', [...head, ...rows].join('\n'), 'text/plain');
          } }, icon('download'), 'MPC ADES'),
          h('button', { class: 'btn small', disabled: !cands.length, onclick: () => {
            const cols = ['id', 'created', 'type', 'ra', 'dec', 'catalog', 'frameDate', 'note', 'url', 'exposures'];
            const csv = cols.join(',') + '\n' + cands.map((c) => cols.map((k) => csvEscape(k === 'exposures' ? (c.exposures || []).join(' ') : k === 'frameDate' && c.frameDate ? mjdToISO(c.frameDate) : c[k])).join(',')).join('\n');
            download('skyshift-candidates.csv', csv, 'text/csv');
          } }, icon('download'), 'CSV')),
        h('p', { class: 'tiny' }, 'Each candidate keeps the exact view link and the SPHEREx files it was seen in, so anyone can re-check it. Candidates are not discoveries: report only after your own checks. The MPC ADES file is a template (observatory code XXX is a placeholder: no SPHEREx MPC code is given in the approved sources; replace it and your name before any submission).'),
        cands.length ? h('table', { class: 'table' }, h('tr', {}, ['Type', 'Position', 'Note', 'Saved', ''].map((x) => h('th', {}, x))),
          cands.map((c) => h('tr', {},
            h('td', {}, h('span', { class: 'chip' }, c.type)),
            h('td', { class: 'mono' }, `${formatRA(c.ra)} ${formatDec(c.dec)}`, c.catalog ? h('div', { class: 'tiny' }, c.catalog) : null),
            h('td', {}, c.note || '–'),
            h('td', {}, niceDateTime(c.created)),
            h('td', {}, h('a', { class: 'btn small', href: c.url && c.url.includes('#/view') ? c.url.slice(c.url.indexOf('#')) : '#/' }, 'Open'), ' ',
              h('button', { class: 'btn small ghost', onclick: () => { write(CANDS, read(CANDS).filter((x) => x.id !== c.id)); draw(); } }, 'Delete')))))
          : h('p', { class: 'empty compact' }, 'No candidates yet. Click an object in the viewer and choose “Mark candidate”.'))),
      queueSection(),
      h('section', { class: 'card', style: { marginTop: '14px' } },
        h('h2', {}, 'Storage'), storageLine,
        h('button', { class: 'btn small', onclick: async () => { if (confirm('Delete all cached images and searches from this device? Saved fields and candidates are kept.')) { await cache.clear(); toast({ title: 'Cache cleared', glyph: '🧹', timeout: 2500 }); updateStorage(); } } }, 'Clear cached images')),
    );
  };
  function queueSection() {
    const q = getQueue();
    if (!q?.items?.length) return null;
    const status = h('p', { class: 'tiny', 'aria-live': 'polite' });
    return h('section', { class: 'card', style: { marginTop: '14px' } },
      h('div', { class: 'row' }, h('h2', { style: { margin: 0 } }, `Queue of fields (${q.items.length})`), h('div', { class: 'spacer' }),
        h('a', { class: 'btn small primary', href: q.items[0].hash }, 'Start inspecting'),
        h('button', { class: 'btn small', onclick: () => queueDossier(q, status) }, icon('download'), 'Multi-target dossier'),
        h('button', { class: 'btn small ghost', onclick: () => { clearQueue(); draw(); } }, 'Clear queue')),
      h('table', { class: 'table' }, h('tr', {}, ['#', 'Field', ''].map((x) => h('th', {}, x))),
        q.items.map((it, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, it.name || `Field ${i + 1}`), h('td', {}, h('a', { href: it.hash }, 'Open'))))),
      status);
  }
  async function queueDossier(q, status) {
    const { sha256Hex, zip, SPHEREX_ACK, DOIS } = await import('../lib/dossier.js');
    const rows = [];
    for (const [i, it] of q.items.entries()) {
      status.textContent = `Searching the SPHEREx archive for field ${i + 1} of ${q.items.length}…`;
      const p = new URLSearchParams(it.hash.split('?')[1] || '');
      const ra = Number(p.get('ra')), dec = Number(p.get('dec'));
      try {
        const r = await searchSpherex(ra, dec);
        const ms = r.data.map((e) => e.mjd);
        const rel = [...new Set(r.data.map((e) => e.release))].sort();
        rows.push({ name: it.name || `Field ${i + 1}`, ra, dec, n: r.data.length, from: ms.length ? Math.min(...ms) : null, to: ms.length ? Math.max(...ms) : null, rel, source: r.source, url: `${location.origin}${location.pathname}${it.hash}` });
      } catch (e) { rows.push({ name: it.name || `Field ${i + 1}`, ra, dec, n: null, error: e.message, url: `${location.origin}${location.pathname}${it.hash}` }); }
    }
    let version = 'dev'; try { version = (await (await fetch('./version.json', { cache: 'no-cache' })).json()).version; } catch { /* offline */ }
    const id = (await sha256Hex(JSON.stringify({ items: q.items.map((x) => x.hash), version, counts: rows.map((r) => r.n) }))).slice(0, 16);
    const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const iso = (m) => (m ? new Date((m - 40587) * 864e5).toISOString().slice(0, 10) : '–');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>SkyShift multi-target dossier ${id}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;max-width:1000px;margin:0 auto;padding:24px;color:#111}h1{font-size:24px}table{border-collapse:collapse;width:100%;font-size:12.5px}th,td{border-bottom:1px solid #dde;padding:4px 6px;text-align:left}th{background:#f1f0ff}footer{margin-top:24px;font-size:12px;color:#444;border-top:1px solid #ccd;padding-top:8px}@page{margin:14mm}</style></head><body>
<h1>SkyShift multi-target dossier</h1><p>Dossier ID <b>${id}</b> · ${new Date().toISOString()} · SkyShift ${esc(version)} · ${q.items.length} fields from an uploaded or typed list.</p>
<h2>Summary</h2><p>${rows.filter((r) => r.n).length} of ${rows.length} fields have SPHEREx images (${rows.reduce((a, r) => a + (r.n || 0), 0).toLocaleString('en-GB')} spectral images in total). Each row links to the full analysis; open it and use “Dossier” for a per-target report with figures.</p>
<h2>Fields</h2><table><tr><th>#</th><th>Field</th><th>RA (deg)</th><th>Dec (deg)</th><th>SPHEREx images</th><th>First</th><th>Latest</th><th>Releases</th><th>Open</th></tr>
${rows.map((r, i) => `<tr><td>${i + 1}</td><td>${esc(r.name)}</td><td>${r.ra.toFixed(5)}</td><td>${r.dec.toFixed(5)}</td><td>${r.n ?? `unavailable (${esc(r.error)})`}</td><td>${iso(r.from)}</td><td>${iso(r.to)}</td><td>${(r.rel || []).map((x) => `${x.toUpperCase()}${DOIS[x] ? ` (DOI ${DOIS[x]})` : ''}`).join(', ')}</td><td><a href="${esc(r.url)}">view</a></td></tr>`).join('')}</table>
<h2>Credits and data use</h2><p>${esc(SPHEREX_ACK)}</p><footer>© 2026 SkyShift · Apache-2.0 · Dossier ${id}</footer></body></html>`;
    const csv = ['name,ra_deg,dec_deg,spherex_images,first_utc,latest_utc,releases,url', ...rows.map((r) => [JSON.stringify(r.name), r.ra, r.dec, r.n ?? '', iso(r.from), iso(r.to), (r.rel || []).join('|'), r.url].join(','))].join('\n');
    download(`skyshift-queue-dossier-${id}.zip`, await zip([{ name: 'dossier.html', data: html }, { name: 'fields.csv', data: csv }, { name: 'queue.json', data: JSON.stringify(q, null, 2) }]));
    status.textContent = `Multi-target dossier ${id} downloaded (HTML, CSV, queue JSON).`;
  }
  const storageLine = h('p', { class: 'tiny' }, 'Checking storage…');
  const updateStorage = async () => {
    const { usage = 0, quota = 0 } = await cache.usage();
    storageLine.textContent = quota ? `SkyShift uses ${(usage / 1048576).toFixed(1)} MB of ${(quota / 1073741824).toFixed(1)} GB available for offline data. Older images are removed automatically when space runs low.` : 'Storage information is not available in this browser.';
    if (navigator.storage?.persist) navigator.storage.persist().catch(() => {});
  };
  draw(); updateStorage();
  return () => {};
}
