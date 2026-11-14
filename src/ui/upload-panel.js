// Upload panel: drop or pick files, preview what was read, fix the column mapping,
// add optional typed instructions, then open one field or inspect them all as a queue.
// Parsing happens in a Web Worker; files never leave the device.

import { h, toast, icon } from './dom.js';
import { normalise, parseText, toParams } from '../state.js';
import { formatRA, formatDec } from '../lib/coords.js';
import { setQueue } from '../views/saved.js';
import { pushRecent } from '../views/home.js';
import { splitStatements } from '../lib/expr.js';

let worker = null;
let seq = 0;
function parseInWorker(name, buffer, mapping) {
  worker ||= new Worker(new URL('../upload-worker.js', import.meta.url), { type: 'module' });
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const on = (e) => { if (e.data.id !== id) return; worker.removeEventListener('message', on); e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)); };
    worker.addEventListener('message', on);
    worker.postMessage({ id, name, buffer, mapping }, mapping ? [] : []);
  });
}

async function sha256(buf) {
  const d = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const MAPKEY = 'skyshift.colmaps';
const savedMap = (cols) => { try { return JSON.parse(localStorage.getItem(MAPKEY) || '{}')[cols.join('|')] || null; } catch { return null; } };
const rememberMap = (cols, m) => { try { const all = JSON.parse(localStorage.getItem(MAPKEY) || '{}'); all[cols.join('|')] = m; localStorage.setItem(MAPKEY, JSON.stringify(all)); } catch { /* ignore */ } };

export function uploadPanel({ go }) {
  const input = h('input', { type: 'file', multiple: true, hidden: true, 'aria-label': 'Choose files' });
  const out = h('div', { class: 'grid', 'aria-live': 'polite' });
  const instr = h('input', { type: 'text', placeholder: 'Optional: e.g. only detectors 5-6, 5 arcmin fields, blink', 'aria-label': 'Instructions applied to every uploaded target' });
  const zone = h('div', { class: 'dropzone', tabindex: '0', role: 'button', 'aria-label': 'Drop files here or press Enter to choose files',
    onclick: () => input.click(), onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
  icon('download'), h('b', {}, 'Drop a target list or data file'),
  h('span', { class: 'tiny' }, 'CSV, TSV, TXT, JSON/GeoJSON, VOTable, IPAC .tbl, ECSV, FITS (tables or images with WCS), Excel, OpenDocument, Word, DS9 regions, MPC 80-column / ADES, YAML, Markdown, ZIP/TAR. Read on this device only.'));
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('over')));
  zone.addEventListener('drop', (e) => { e.preventDefault(); handle([...e.dataTransfer.files]); });
  input.addEventListener('change', () => handle([...input.files]));

  async function handle(files) {
    out.replaceChildren(h('p', { class: 'tiny' }, `Reading ${files.length} file${files.length > 1 ? 's' : ''}…`));
    const all = [];
    for (const f of files.slice(0, 10)) {
      try {
        const buf = await f.arrayBuffer();
        const sum = await sha256(buf);
        let res = await parseInWorker(f.name, buf.slice(0), null);
        const remembered = res.columns?.length ? savedMap(res.columns) : null;
        if (remembered) res = await parseInWorker(f.name, buf.slice(0), remembered);
        all.push({ file: f, buf, sum, res });
      } catch (e) {
        all.push({ file: f, error: e.message });
      }
    }
    render(all);
  }

  function render(all) {
    out.replaceChildren();
    for (const item of all) out.append(fileCard(item, () => render(all)));
    const targets = all.flatMap((it) => (it.res?.targets || []).map((t) => ({ ...t, file: it.file.name })));
    if (!targets.length) return;
    const pt = instr.value.trim() ? parseText(instr.value) : null;
    const st = instr.value.trim() ? splitStatements(instr.value.split(/[;]/).filter((l) => /where|=|\bD[1-6]\b/.test(l)).join('\n')) : null;
    const extra = { ...(pt?.partial || {}) };
    delete extra.preset; delete extra.target; delete extra.galactic; delete extra.blinkFirstLast;
    if (st?.where) extra.where = st.where;
    if (st?.image) { extra.expr = st.image; extra.mode = 'expr'; }
    const reqs = targets.map((t) => normalise({ ...extra, target: { ra: t.ra, dec: t.dec, name: t.name, pmra: t.pmra, pmdec: t.pmdec, refEpoch: t.pmra || t.pmdec ? 2016 : undefined, source: 'upload' } }));
    out.append(h('div', { class: 'notice' },
      h('b', {}, `Understood: ${targets.length} target${targets.length > 1 ? 's' : ''}`),
      pt?.understood.length ? h('ul', {}, pt.understood.map((u) => h('li', {}, h('code', {}, u.text), ' → ', u.meaning))) : null,
      h('div', { class: 'row', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary small', onclick: () => { pushRecent(reqs[0].target); go(`#/view?${toParams(reqs[0])}`); } }, `Open ${reqs[0].target.name || 'first'}`),
        reqs.length > 1 ? h('button', { class: 'btn small', onclick: () => { setQueue(reqs.map((r) => `#/view?${toParams(r)}`), reqs.map((r) => r.target.name)); go(`#/view?${toParams(reqs[0])}`); toast({ title: `Queue of ${reqs.length} fields ready`, text: 'Use Next / Previous above the viewer to work through them.', glyph: '🗂', timeout: 4000 }); } }, `Inspect all ${reqs.length} as a queue`) : null)));
  }

  function fileCard(item, rerender) {
    const { file, res, error, sum } = item;
    if (error) return h('div', { class: 'notice bad' }, h('b', {}, file.name), ` — ${error}`);
    const cols = res.columns || [];
    const sel = (key, label) => h('label', { class: 'field' }, label, h('select', { onchange: async (e) => {
      const m = { ...(res.mapping || {}) }; m[key] = e.target.value === '' ? null : Number(e.target.value);
      item.res = await parseInWorker(file.name, item.buf.slice(0), m);
      if (m.ra != null && m.dec != null) rememberMap(cols, m);
      rerender();
    } }, h('option', { value: '' }, '—'), cols.map((c, i) => h('option', { value: i, selected: res.mapping?.[key] === i }, c))));
    return h('div', { class: 'card' },
      h('div', { class: 'row' }, h('b', {}, file.name), h('span', { class: 'chip' }, res.format), h('span', { class: 'chip' }, `${(file.size / 1024).toFixed(1)} kB`),
        h('span', { class: 'chip', title: `SHA-256 ${sum}` }, `sha256 ${sum.slice(0, 10)}…`), res.targets?.length ? h('span', { class: 'chip good' }, `${res.targets.length} targets`) : null),
      res.userImage ? h('div', { class: 'notice warn' }, h('b', {}, 'User-supplied image — not SPHEREx data. '),
        res.userImage.kind === 'fits' ? `${res.userImage.width}×${res.userImage.height} px, ${res.userImage.pixelScale.toFixed(2)}″/px, centre ${formatRA(res.userImage.center[0])} ${formatDec(res.userImage.center[1])}${res.userImage.telescope ? `, ${res.userImage.telescope}` : ''}${res.userImage.dateObs ? `, ${res.userImage.dateObs}` : ''}. SkyShift can open SPHEREx images of the same field.` : res.userImage.note) : null,
      res.files ? h('ul', { class: 'tiny' }, res.files.map((f) => h('li', {}, `${f.path}: ${f.error || `${f.format}, ${f.targets} targets`}`))) : null,
      cols.length > 1 ? h('div', { class: 'row' }, sel('ra', 'RA column'), sel('dec', 'Dec column'), sel('name', 'Name column'), sel('pmra', 'pm RA (mas/yr)'), sel('pmdec', 'pm Dec (mas/yr)')) : null,
      res.preview?.length ? h('div', { class: 'explist' }, h('table', {}, cols.length ? h('tr', {}, cols.map((c) => h('th', {}, c))) : null, res.preview.map((r) => h('tr', {}, r.map((v) => h('td', {}, String(v).slice(0, 40))))))) : null,
      res.targets?.length ? h('p', { class: 'tiny' }, `First: ${res.targets.slice(0, 3).map((t) => `${t.name} (${t.ra.toFixed(4)}, ${t.dec.toFixed(4)})`).join('; ')}${res.targets.length > 3 ? '…' : ''}. Frame: ICRS degrees (assumed for decimal values; sexagesimal is read as h m s / d m s).`) : null,
      res.errors?.length ? h('details', {}, h('summary', { class: 'tiny' }, `${res.errors.length} line(s) not used`), h('ul', { class: 'tiny' }, res.errors.slice(0, 20).map((e) => h('li', {}, `${e.line ? `line ${e.line}: ` : ''}${e.text ? `“${e.text}” — ` : ''}${e.msg}`)))) : null);
  }

  return h('section', { class: 'card typed', 'aria-labelledby': 'up-h' },
    h('h2', { id: 'up-h' }, 'Or upload your own list'),
    h('p', { class: 'muted' }, 'Bring a target list, an ephemeris, a table from a paper, or your own FITS image. SkyShift reads it in your browser, shows what it understood, and fetches the SPHEREx images for each position.'),
    zone, input, h('label', { class: 'field', style: { marginTop: '8px' } }, 'Instructions for every target (optional)', instr), out);
}
