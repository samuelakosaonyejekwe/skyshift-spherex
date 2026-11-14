// Chase: follow fast-moving stars and brown dwarfs. Motions come from Gaia DR3 (IRSA / MAST).
// "Follow" keeps the object centred (background stars drift); "Watch it move" keeps the sky
// fixed so the object crosses the frame. Solar-system objects are not included: no ephemeris
// service is reached from the challenge resources.

import { h, icon, toast } from '../ui/dom.js';
import { presets, presetToTarget, resolveTarget } from '../targets.js';
import { normalise, toParams } from '../state.js';
import { parsePosition, formatRA, formatDec } from '../lib/coords.js';
import { tap, IRSA_TAP } from '../lib/tap.js';
import { recent } from './home.js';

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
  const idIn = h('input', { type: 'text', placeholder: 'Gaia DR3 source ID, e.g. 4472832130942575872', 'aria-label': 'Gaia DR3 source ID' });
  const idOut = h('div');
  const posIn = h('input', { type: 'text', placeholder: 'Position, e.g. 269.45 4.69 (or leave empty for your last field)', 'aria-label': 'Search position' });
  const radSel = h('select', { 'aria-label': 'Search radius', style: { width: 'auto' } }, [[0.5, '0.5°'], [1, '1°'], [2, '2°']].map(([v, l]) => h('option', { value: v, selected: v === 1 }, l)));
  const minSel = h('select', { 'aria-label': 'Minimum motion', style: { width: 'auto' } }, [[200, '> 0.2″/yr'], [500, '> 0.5″/yr'], [1000, '> 1″/yr']].map(([v, l]) => h('option', { value: v, selected: v === 200 }, l)));
  const findOut = h('div', { class: 'grid' });

  root.append(
    h('h1', {}, 'Chase a moving star'),
    h('p', { class: 'muted prose' }, 'Nearby stars and brown dwarfs creep across the sky as they orbit the Galaxy. Pick one to watch it move between SPHEREx’s six-monthly surveys, or follow it so it stays centred while the background drifts. Motions come from the Gaia DR3 catalogue.'),
    h('h2', {}, 'Challenge targets that move'),
    h('div', { class: 'presets' }, list.map(card)),
    h('h2', {}, 'Follow any Gaia DR3 star'),
    h('form', { class: 'row', onsubmit: async (e) => {
      e.preventDefault();
      idOut.replaceChildren(h('p', { class: 'tiny' }, 'Looking up Gaia DR3…'));
      try {
        const r = await resolveTarget(`Gaia DR3 ${idIn.value.replace(/\D/g, '')}`);
        if (r.error) { idOut.replaceChildren(h('p', { class: 'notice warn' }, `${r.error}. ${r.hint}`)); return; }
        idOut.replaceChildren(card({ name: r.target.name, kind: r.note, pmra: r.target.pmra, pmdec: r.target.pmdec, target: r.target }));
      } catch (err) { idOut.replaceChildren(h('p', { class: 'notice bad' }, `Gaia lookup unavailable right now (${err.message}).`)); }
    } }, idIn, h('button', { class: 'btn primary', type: 'submit' }, 'Look up')),
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
          h('div', { class: 'presets' }, rows.slice(0, 12).map((g) => card({ name: `Gaia DR3 ${g.source_id}`, kind: `G = ${g.phot_g_mean_mag?.toFixed(1)}`, pmra: g.pmra, pmdec: g.pmdec, parallax: g.parallax > 0 ? g.parallax : null,
            target: { ra: g.ra, dec: g.dec, pmra: g.pmra, pmdec: g.pmdec, refEpoch: g.ref_epoch || 2016, name: `Gaia DR3 ${g.source_id}`, id: String(g.source_id), source: 'gaia' } }))));
      } catch (err) { findOut.replaceChildren(h('p', { class: 'notice bad' }, `Gaia search unavailable right now (${err.message}).`)); }
    } }, posIn, radSel, minSel, h('button', { class: 'btn primary', type: 'submit' }, 'Find')),
    findOut,
    h('p', { class: 'tiny', style: { marginTop: '16px' } }, 'Asteroids and comets are not listed here: their paths need an orbit service that is not part of the challenge’s resources. You can still spot them with Time Machine → Discover.'));
  return () => {};
}
