// Chase: follow fast-moving stars and brown dwarfs. Motions come from Gaia DR3 (IRSA / MAST).
// "Follow" keeps the object centred (background stars drift); "Watch it move" keeps the sky
// fixed so the object crosses the frame. Asteroids and comets follow the user's own table of times and
// positions (no ephemeris service is reached from the challenge resources).

import { h, icon } from '../ui/dom.js';
import { presets, presetToTarget, resolveTarget } from '../targets.js';
import { normalise, toParams } from '../state.js';
import { parsePosition, formatRA, formatDec } from '../lib/coords.js';
import { tap, IRSA_TAP } from '../lib/tap.js';
import { recent } from './home.js';
import { ephemerisCard } from '../ui/upload-panel.js';

export const title = 'Chase';

export async function render(root, route, { go }) {
  const list = (await presets()).filter((t) => Math.hypot(t.pmra || 0, t.pmdec || 0) > 500);
  const open = (target, follow) => go(`#/view?${toParams(normalise({ target, track: follow, mode: 'movie', group: 'survey', ov: ['track', 'compass', 'gaia'] }))}`);
  const card = (t) => {
    const pm = Math.hypot(t.pmra || 0, t.pmdec || 0) / 1000;
    return h('div', { class: 'card chase-card' },
      h('b', {}, t.name), h('span', { class: 'tiny' }, t.kind || ''),
      h('div', { class: 'row' }, h('span', { class: 'chip warn' }, `${pm.toFixed(2)}″ per year`), h('span', { class: 'chip' }, `${(pm / 2).toFixed(1)}″ per six-month survey`), t.parallax ? h('span', { class: 'chip' }, `${(1000 / t.parallax).toFixed(1)} pc away`) : null),
      h('div', { class: 'row' },
        h('button', { class: 'btn small primary', onclick: () => open(t.target || presetToTarget(t), false) }, icon('play'), 'Watch it move'),
        h('button', { class: 'btn small', onclick: () => open(t.target || presetToTarget(t), true) }, 'Follow it')));
  };
  // Suggestions: the fastest-moving stars in Gaia DR3 (data/fastmovers.json, from IRSA). Choosing one fills the box;
  // Look up then opens it from the stored Gaia values, so these work even without an archive relay.
  const fast = await fetch('./data/fastmovers.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const known = Object.fromEntries((await presets()).filter((t) => t.gaia).map((t) => [String(t.gaia?.source_id || t.gaia), t.name]));
  const fastList = h('datalist', { id: 'fastmovers' }, (fast?.stars || []).map((s) => h('option', { value: s.id, label: `${known[s.id] ? known[s.id] + ' · ' : ''}${(s.pm / 1000).toFixed(2)}″ per year · ${s.parallax > 0 ? (1000 / s.parallax).toFixed(1) + ' pc away' : ''} · G ${s.g?.toFixed(1)}` })));
  // the fastest-moving stars in Gaia DR3 (built-in list from IRSA), as cards; works without an archive relay
  const fastTarget = (s) => ({ ra: s.ra, dec: s.dec, pmra: s.pmra, pmdec: s.pmdec, plx: s.parallax > 0 ? s.parallax : 0, refEpoch: 2016.0, name: known[s.id] || `Gaia DR3 ${s.id}`, id: s.id, source: 'gaia' });
  const fastSection = () => {
    const stars = (fast?.stars || []).filter((s) => !known[s.id]).slice(0, 12); // 12 fills whole rows at 2, 3, 4 or 6 columns
    if (!stars.length) return null;
    return h('section', { style: { marginTop: '18px' } },
      h('h2', {}, 'The fastest stars in Gaia DR3'),
      h('p', { class: 'tiny muted' }, 'The twelve fastest-moving stars in Gaia DR3 after the challenge targets, fastest first (from IRSA’s copy of the catalogue). All lie within about 10 parsecs of the Sun.'),
      h('div', { class: 'chase-cards fast-cards' }, stars.map((s) => card({ name: `Gaia DR3 ${s.id}`, kind: `G = ${s.g?.toFixed(1)} · ${s.ra.toFixed(2)}°, ${s.dec >= 0 ? '+' : ''}${s.dec.toFixed(2)}°`, pmra: s.pmra, pmdec: s.pmdec, parallax: s.parallax, target: fastTarget(s) }))));
  };
  const idIn = h('input', { type: 'text', list: 'fastmovers', inputmode: 'numeric', placeholder: 'Gaia DR3 source ID, or pick one of the fastest-moving stars', 'aria-label': 'Gaia DR3 source ID' });
  const idOut = h('div');
  const posIn = h('input', { type: 'text', placeholder: 'Position, e.g. 269.45 4.69 (or leave empty for your last field)', 'aria-label': 'Search position' });
  const radSel = h('select', { 'aria-label': 'Search radius', style: { width: 'auto' } }, [[0.5, '0.5°'], [1, '1°'], [2, '2°']].map(([v, l]) => h('option', { value: v, selected: v === 1 }, l)));
  const minSel = h('select', { 'aria-label': 'Minimum motion', style: { width: 'auto' } }, [[200, '> 0.2″/yr'], [500, '> 0.5″/yr'], [1000, '> 1″/yr']].map(([v, l]) => h('option', { value: v, selected: v === 200 }, l)));
  const findOut = h('div', { class: 'grid' });

  root.append(
    h('h1', {}, 'Chase a moving star'),
    h('p', { class: 'muted prose' }, 'Nearby stars and brown dwarfs creep across the sky as they orbit the Galaxy. Pick one to watch it move between SPHEREx’s six-monthly surveys, or follow it so it stays centred while the background drifts. Motions come from the Gaia DR3 catalogue.'),
    h('div', { class: 'chase-grid' },
    h('section', {}, h('h2', {}, 'Challenge targets that move'), h('div', { class: 'chase-cards' }, list.map(card))),
    h('section', { class: 'card' },
    h('h2', {}, 'Follow any Gaia DR3 star'),
    h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      idOut.replaceChildren(h('p', { class: 'tiny' }, 'Looking up Gaia DR3…'));
      try {
        const id = idIn.value.replace(/\D/g, '');
        const f = fast?.stars?.find((s) => s.id === id);
        const r = f ? { kind: 'gaia', target: fastTarget(f), note: `Gaia DR3 star, G=${f.g?.toFixed(2)}; one of the fastest-moving stars in the catalogue (built-in list from IRSA)` }
          : await resolveTarget(`Gaia DR3 ${id}`);
        if (r.error) { idOut.replaceChildren(h('p', { class: 'notice warn' }, `${r.error}. ${r.hint}`)); return; }
        idOut.replaceChildren(card({ name: r.target.name, kind: r.note, pmra: r.target.pmra, pmdec: r.target.pmdec, parallax: r.target.plx, target: r.target }));
      } catch (err) { idOut.replaceChildren(h('p', { class: 'notice bad' }, `Gaia lookup unavailable right now (${err.message}).`)); }
    } }, idIn, fastList, h('button', { class: 'btn primary', type: 'submit' }, 'Look up')),
    idOut,
    h('h2', {}, 'Find fast movers near a position'),
    h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      const last = recent()[0];
      const p = posIn.value.trim() ? parsePosition(posIn.value) : last ? { ra: last.ra, dec: last.dec } : null;
      if (!p) { findOut.replaceChildren(h('p', { class: 'notice warn' }, 'Type a position such as 269.45 4.69, or open a field first.')); return; }
      findOut.replaceChildren(h('p', { class: 'tiny' }, `Searching Gaia DR3 around ${formatRA(p.ra)} ${formatDec(p.dec)}…`));
      try {
        const min = Number(minSel.value), rad = Number(radSel.value);
        const rows = await tap(IRSA_TAP, `SELECT TOP 40 source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ref_epoch FROM gaia_dr3_source
WHERE 1 = CONTAINS(POINT('ICRS', ra, dec), CIRCLE('ICRS', ${p.ra.toFixed(5)}, ${p.dec.toFixed(5)}, ${rad})) AND pmra * pmra + pmdec * pmdec > ${min * min}
ORDER BY phot_g_mean_mag`, { timeout: 60000 });
        if (!rows.length) { findOut.replaceChildren(h('p', { class: 'notice' }, 'No Gaia DR3 stars that fast in this area. Try a larger radius or a lower speed.')); return; }
        rows.sort((a, b) => Math.hypot(b.pmra, b.pmdec) - Math.hypot(a.pmra, a.pmdec));
        findOut.replaceChildren(h('p', { class: 'tiny' }, `${rows.length} stars from Gaia DR3 (IRSA), fastest first.`),
          h('div', { class: 'chase-cards' }, rows.slice(0, 12).map((g) => card({ name: `Gaia DR3 ${g.source_id}`, kind: `G = ${g.phot_g_mean_mag?.toFixed(1)}`, pmra: g.pmra, pmdec: g.pmdec, parallax: g.parallax > 0 ? g.parallax : null,
            target: { ra: g.ra, dec: g.dec, pmra: g.pmra, pmdec: g.pmdec, plx: g.parallax > 0 ? g.parallax : 0, refEpoch: g.ref_epoch || 2016, name: `Gaia DR3 ${g.source_id}`, id: String(g.source_id), source: 'gaia' } }))));
      } catch (err) { findOut.replaceChildren(h('p', { class: 'notice bad' }, `Gaia search unavailable right now (${err.message}).`)); }
    } }, posIn, radSel, minSel, h('button', { class: 'btn primary', type: 'submit' }, 'Find')),
    findOut)),
    fastSection(),
    movingSection());
  // Asteroids and comets: the user's own table of times and positions (no orbit service is called)
  function movingSection() {
    const ta = h('textarea', { rows: 5, placeholder: 'Paste a table of times and positions here, one line per time, e.g.\n2026-03-14 00:00  12 34 56.78 +12 34 56.7\n2026-03-15 00:00  12 36 00.00 +12 30 00.0', 'aria-label': 'Table of times and positions', style: { width: '100%', fontFamily: 'var(--mono)', fontSize: '.82rem' } });
    const fileIn = h('input', { type: 'file', accept: '.csv,.tsv,.txt,.dat,.xlsx,.ods,.json', 'aria-label': 'Table file' });
    const out = h('div');
    const read = async (name, buf) => {
      out.replaceChildren(h('p', { class: 'tiny' }, 'Reading the table…'));
      try {
        const { parseUpload } = await import('../lib/upload.js');
        const res = await parseUpload(name, buf);
        if (!res.ephemeris) { out.replaceChildren(h('p', { class: 'notice warn' }, 'No times with positions were recognised. Each line (or row) needs a date or JD/MJD, then RA and Dec; a CSV needs columns such as date, ra, dec.')); return; }
        out.replaceChildren(ephemerisCard(res.ephemeris, name.replace(/\.[^.]+$/, '').replace(/^pasted table$/, ''), go));
      } catch (err) { out.replaceChildren(h('p', { class: 'notice bad' }, `The table could not be read (${err.message}).`)); }
    };
    fileIn.addEventListener('change', async () => { const f = fileIn.files?.[0]; if (f) read(f.name, await f.arrayBuffer()); });
    return h('section', { class: 'card', style: { marginTop: '18px' } },
      h('h2', {}, 'Asteroids and comets'),
      h('p', { class: 'tiny muted' }, 'They move too fast to stay at one position. Give SkyShift a table of times and positions (an ephemeris: CSV, or the plain-text table an ephemeris service produces) and it follows the object through every SPHEREx image along its path. Positions come only from your table, which stays on this device.'),
      ta,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary', onclick: () => { if (ta.value.trim()) read('pasted table.txt', new TextEncoder().encode(ta.value).buffer); } }, 'Read the table'),
        h('label', { class: 'btn' }, 'Choose a file', h('span', { style: { display: 'none' } }, fileIn))),
      out);
  }
  return () => {};
}
