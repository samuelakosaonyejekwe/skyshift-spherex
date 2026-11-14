// Home: target search with predictive input, typed requests, presets, how-it-works.

import { h, icon } from '../ui/dom.js';
import { presets, resolveTarget, presetToTarget, presetById, describePosition, fromGalactic } from '../targets.js';
import { parsePosition, formatRA, formatDec, niceDate, niceNum } from '../lib/coords.js';
import { normalise, toParams, parseText, DEFAULTS } from '../state.js';
import { searchSpherex } from '../lib/tap.js';
import { splitStatements } from '../lib/expr.js';
import { uploadPanel } from '../ui/upload-panel.js';
import { skyMap } from '../ui/skymap.js';

export const title = 'Explore';
const RECENT = 'skyshift.recent';

export function recent() { try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; } }
export function pushRecent(t) {
  if (!t) return;
  const list = recent().filter((r) => !(Math.abs(r.ra - t.ra) < 1e-4 && Math.abs(r.dec - t.dec) < 1e-4));
  list.unshift({ ra: t.ra, dec: t.dec, name: t.name || null, id: t.id || null, pmra: t.pmra || 0, pmdec: t.pmdec || 0, refEpoch: t.refEpoch, ts: Date.now() });
  localStorage.setItem(RECENT, JSON.stringify(list.slice(0, 12)));
}

export function viewHash(req) { return `#/view?${toParams(normalise(req)).toString()}`; }

export async function render(root, route, { go }) {
  const list = await presets();
  const input = h('input', { type: 'search', id: 'q', autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'go',
    placeholder: 'Star name or coordinates, e.g. WISE 0855 or 133.786 −7.244', 'aria-label': 'Target name or coordinates',
    'aria-describedby': 'parsed', role: 'combobox', 'aria-expanded': 'false', 'aria-controls': 'suggest', 'aria-autocomplete': 'list' });
  const parsed = h('div', { class: 'parsed', id: 'parsed', 'aria-live': 'polite' }, 'Decimal degrees, sexagesimal (h m s / d m s), galactic (l=… b=…) or "Gaia DR3 <id>".');
  const sugg = h('div', { class: 'suggest', id: 'suggest', role: 'listbox', hidden: true });
  let sel = -1, items = [], chosen = null; // chosen: the suggestion placed in the box, opened only by Play/Enter
  // A suggestion only fills the box; nothing opens until the user presses Play (or Enter)
  const choose = (it) => {
    if (it.fill) { it.fill(); return; }
    chosen = it; input.value = it.label;
    sugg.hidden = true; input.setAttribute('aria-expanded', 'false'); sel = -1;
    parsed.className = 'parsed ok'; parsed.textContent = `${it.label} selected. Press Play to open it.`;
  };

  const openTarget = (t, extra = {}) => {
    pushRecent(t);
    go(viewHash({ target: t, ...extra }));
  };
  const submit = async () => {
    const v = input.value.trim();
    if (chosen && v === chosen.label) { const c = chosen; chosen = null; c.pick(); return; }
    parsed.className = 'parsed'; parsed.textContent = 'Resolving…';
    try {
      const r = await resolveTarget(v);
      if (r.error) { parsed.className = 'parsed err'; parsed.textContent = `${r.error}. ${r.hint}`; return; }
      if (r.kind === 'text') { runTyped(v); return; }
      const extra = {};
      if (r.preset?.id === 'wise0855') Object.assign(extra, { dets: [4, 5, 6], mode: 'blink' });
      openTarget(r.target, extra);
    } catch (e) {
      parsed.className = 'parsed err';
      parsed.textContent = `Could not resolve right now (${e.message}). Coordinates always work offline.`;
    }
  };

  const updateSuggest = () => {
    const v = input.value.trim().toLowerCase();
    items = [];
    const pos = parsePosition(input.value);
    if (pos) {
      parsed.className = 'parsed ok';
      parsed.textContent = `Understood: RA ${formatRA(pos.ra)} (${pos.ra.toFixed(5)}°), Dec ${formatDec(pos.dec)} (${pos.dec.toFixed(5)}°) · ${describePosition(pos.ra, pos.dec)}`;
    } else if (/^\s*l\s*=?/i.test(input.value)) {
      const m = input.value.match(/l\s*=?\s*(\d+(?:\.\d+)?)\s*[, ]\s*b\s*=?\s*([+-]?\d+(?:\.\d+)?)/i);
      if (m) { const p = fromGalactic(+m[1], +m[2]); parsed.className = 'parsed ok'; parsed.textContent = `Galactic → RA ${formatRA(p.ra)}, Dec ${formatDec(p.dec)}`; }
    } else if (v) {
      parsed.className = 'parsed'; parsed.textContent = 'Press Enter to search. Names: the five challenge targets, or "Gaia DR3 <id>".';
    }
    for (const t of list) {
      const hay = `${t.name} ${t.id} ${t.kind}`.toLowerCase();
      if (!v || hay.includes(v) || v.split(/\s+/).every((w) => hay.includes(w))) items.push({ label: t.name, sub: 'Challenge target', pick: () => openTarget(presetToTarget(t), t.id === 'wise0855' ? { dets: [4, 5, 6], mode: 'blink' } : {}) });
    }
    // Positions from definitions only (no outside catalogue): the ecliptic poles, where SPHEREx's deep fields lie
    // (the most-imaged spots in the archive), and the Galactic centre (l = 0°, b = 0°).
    const gc = fromGalactic(0, 0), EP = 90 - 23.4392911;
    const extras = [
      { label: 'North ecliptic pole deep field', sub: 'Most-imaged spot', keys: 'deep field north ecliptic pole nep most imaged', icon: 'star', pick: () => openTarget({ ra: 270, dec: +EP.toFixed(5), name: 'North ecliptic pole deep field', source: 'coords' }) },
      { label: 'South ecliptic pole deep field', sub: 'Deep field', keys: 'deep field south ecliptic pole sep', icon: 'star', pick: () => openTarget({ ra: 90, dec: -EP.toFixed(5), name: 'South ecliptic pole deep field', source: 'coords' }) },
      { label: 'Galactic centre', sub: 'Milky Way core', keys: 'galactic centre center milky way core sgr', icon: 'star', pick: () => openTarget({ ra: +gc.ra.toFixed(5), dec: +gc.dec.toFixed(5), name: 'Galactic centre', source: 'coords' }) },
      { label: 'Random field', sub: 'Surprise me', keys: 'random field surprise any', icon: 'dice', pick: () => randomField() },
      { label: 'Gaia DR3 source ID…', sub: 'Type an ID', keys: 'gaia dr3 source id star', icon: 'info', fill: () => { chosen = null; input.value = 'Gaia DR3 '; input.focus(); updateSuggest(); } },
    ];
    for (const x of extras) if (!v || x.keys.includes(v) || v.split(/\s+/).every((w) => x.keys.includes(w))) items.push(x);
    for (const r of recent()) {
      const label = r.name || `${r.ra.toFixed(4)} ${r.dec >= 0 ? '+' : ''}${r.dec.toFixed(4)}`;
      if (!v || label.toLowerCase().includes(v)) items.push({ label, sub: 'Recent', icon: 'refresh', pick: () => openTarget(r) });
    }
    items = items.slice(0, 11);
    sel = -1;
    sugg.replaceChildren(...items.map((it, i) => h('button', { type: 'button', role: 'option', id: `sg${i}`, 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); choose(it); } },
      icon(it.icon || 'star'), h('span', {}, it.label), h('span', { class: 'k' }, it.sub))));
    const show = document.activeElement === input && items.length > 0 && !pos;
    sugg.hidden = !show; input.setAttribute('aria-expanded', String(show));
  };
  input.addEventListener('input', () => { if (chosen && input.value.trim() !== chosen.label) chosen = null; updateSuggest(); });
  input.addEventListener('focus', updateSuggest);
  input.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden) return;
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...sugg.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === sel)));
      input.setAttribute('aria-activedescendant', `sg${sel}`);
    } else if (e.key === 'Enter') { e.preventDefault(); if (!sugg.hidden && sel >= 0 && items[sel]) choose(items[sel]); else submit(); }
    else if (e.key === 'Escape') { sugg.hidden = true; sel = -1; }
  });

  // ----- typed request (text -> SkyRequest) -----
  const typed = h('textarea', { id: 'typed', 'aria-label': 'Describe what you want to see', placeholder: 'e.g. Show WISE 0855 over all epochs, 3 to 5 microns, 10 arcmin field, blink first and last' });
  const understood = h('div', { class: 'understood', 'aria-live': 'polite' });
  async function runTyped(text) {
    typed.value = text;
    // Lines that look like equations or selections go to the expression engine; the rest is plain words.
    const lines = String(text).split(/\n+/);
    const isEq = (l) => /^\s*(where\b|epochs?\s+where\b)|[=]|\bD[1-6]\b|epoch\(|wl\(/i.test(l) && !/\b(show|compare|play)\b/i.test(l);
    const eqText = lines.filter(isEq).join('\n');
    const st = eqText ? splitStatements(eqText) : null;
    // a trailing "… where …" inside a sentence is a selection too
    const inline = String(text).match(/\bwhere\s+(.+)$/i);
    const pt = parseText(lines.filter((l) => !isEq(l)).join(' ').replace(/\bwhere\s+.+$/i, ''));
    const partial = { ...pt.partial };
    if (st) {
      if (st.image) { partial.expr = st.image; partial.mode = 'expr'; pt.understood.push({ text: st.image, meaning: 'equation for every frame' }); }
      if (st.where) { partial.where = st.where; pt.understood.push({ text: `where ${st.where}`, meaning: 'only exposures matching this selection' }); }
      if (st.assign.pmra != null || st.assign.pmdec != null) pt.understood.push({ text: `pmra = ${st.assign.pmra ?? 0}; pmdec = ${st.assign.pmdec ?? 0}`, meaning: 'proper motion for the track (mas/yr)' });
      if (st.assign.fov != null) { partial.fov = st.assign.fov; pt.understood.push({ text: `fov = ${st.assign.fov}`, meaning: `field of view ${st.assign.fov}′` }); }
      for (const e of st.errors) pt.unparsed.push(`[${e.message}: ${e.line}]`);
    }
    if (inline && !st?.where) {
      const s2 = splitStatements(`where ${inline[1]}`);
      if (!s2.errors.length) { partial.where = s2.where; pt.understood.push({ text: `where ${s2.where}`, meaning: 'only exposures matching this selection' }); }
      else pt.unparsed.push(`[${s2.errors[0].message}: where ${inline[1]}]`);
    }
    let target = partial.target || null;
    if (partial.preset) { const t = await presetById(partial.preset); if (t) target = presetToTarget(t); }
    if (partial.galactic) target = { ...fromGalactic(...partial.galactic), source: 'text', name: `l=${partial.galactic[0]}, b=${partial.galactic[1]}` };
    delete partial.preset; delete partial.galactic;
    if (partial.blinkFirstLast) { partial.mode = partial.mode || 'blink'; delete partial.blinkFirstLast; }
    if (partial.wl && !partial.dets) partial.dets = detsForRange(partial.wl);
    if (st && (st.assign.pmra != null || st.assign.pmdec != null) && target) target = { ...target, pmra: st.assign.pmra ?? target.pmra ?? 0, pmdec: st.assign.pmdec ?? target.pmdec ?? 0, refEpoch: st.assign.epoch ?? target.refEpoch ?? 2016 };
    const req = normalise({ ...partial, target });
    understood.replaceChildren(
      h('div', { class: 'notice' + (target ? '' : ' warn') },
        h('b', {}, target ? 'Understood:' : 'Almost there — no target recognised yet.'),
        h('ul', {}, pt.understood.map((u) => h('li', {}, h('code', {}, u.text), ' → ', u.meaning))),
        pt.unparsed.length ? h('p', { class: 'tiny' }, `Not used: ${pt.unparsed.join(' ')}. Rephrase if they matter.`) : null,
        pt.conflicts.length ? h('p', { class: 'tiny' }, `Please choose: ${pt.conflicts.join('; ')} (the first was used).`) : null,
        h('div', { class: 'row' },
          h('button', { class: 'btn primary small', disabled: !target, onclick: () => { pushRecent(target); go(viewHash(req)); } }, 'Run'),
          h('button', { class: 'btn small', onclick: () => typed.focus() }, 'Edit'))));
  }

  // ----- the interactive sky map (real SPHEREx DR1 sky from IRSA's HiPS; built by scripts/allsky.mjs)
  const PRESET_EXTRA = { wise0855: { dets: [4, 5, 6], mode: 'blink' }, barnard: { mode: 'blink' }, epsindib: { fov: 15, ov: ['gaia', 'track', 'compass'] } };
  let coverage = null, mission = null;
  try { [coverage, mission] = await Promise.all([fetch('./data/coverage.json').then((r) => (r.ok ? r.json() : null)).catch(() => null), fetch('./data/mission.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)]); } catch { /* offline first run */ }
  const map = skyMap({
    coverage, livePts: (() => { try { return JSON.parse(localStorage.getItem('skyshift.livePts') || '[]'); } catch { return []; } })(), // a damaged saved value must not break Explore
    targets: list.map((t) => ({ id: t.id, name: t.name, ra: t.ra, dec: t.dec, kind: t.kind.split(/ [—(]/)[0] })),
    onPick: (ra, dec) => openTarget({ ra: +ra.toFixed(5), dec: +dec.toFixed(5), source: 'coords' }),
    onTarget: (t) => { const p = list.find((x) => x.id === t.id); openTarget(presetToTarget(p), PRESET_EXTRA[p.id] || {}); },
    count: async (ra, dec) => (await searchSpherex(ra, dec)).data.length,
  });

  const freshness = h('span', { class: 'chip info' }, 'Checking the newest SPHEREx data…');
  const newest = Number(localStorage.getItem('skyshift.newestMjd') || 0);
  if (newest) freshness.textContent = `Newest SPHEREx image in NASA’s archive was taken ${niceDate(newest)}`;
  else import('../lib/tap.js').then(async ({ latestSpherex }) => {
    try { const r = await latestSpherex(); if (r.data) freshness.textContent = `Newest SPHEREx image in NASA’s archive was taken ${niceDate(r.data)}${r.source !== 'live' ? ' (saved)' : ''}`; }
    catch { freshness.textContent = 'Archive check unavailable; saved data still works'; }
  });
  const randomField = () => {
    const u = Math.random(), v = Math.random();
    openTarget({ ra: +(360 * u).toFixed(5), dec: +((Math.asin(2 * v - 1) * 180) / Math.PI).toFixed(5), source: 'coords', name: 'Random field' });
  };

  root.append(
    // 1. what it is + search
    h('section', { class: 'home-hero' },
      h('h1', {}, 'SkyShift: ', h('span', { class: 'gradient' }, 'a time machine'), ' for the SPHEREx sky'),
      h('p', { class: 'lead' }, 'NASA’s SPHEREx telescope photographs the whole sky every six months in 102 infrared colours. Pick a spot, press Play, and watch it change: moving stars, brown dwarfs and asteroids jump out.'),
      h('form', { class: 'searchbox', role: 'search', onsubmit: (e) => { e.preventDefault(); submit(); } },
        (() => { const NS = 'http://www.w3.org/2000/svg'; const sv = document.createElementNS(NS, 'svg'); sv.setAttribute('class', 's-icon'); sv.setAttribute('viewBox', '0 0 24 24'); const pa = document.createElementNS(NS, 'path'); pa.setAttribute('d', 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3'); sv.appendChild(pa); return sv; })(),
        input, h('button', { class: 'btn primary go', type: 'submit' }, icon('play'), 'Play'), sugg),
      parsed,
      h('div', { class: 'row home-quick' },
        h('span', { class: 'tiny' }, 'Try:'),
        list.slice(0, 5).map((t) => h('button', { class: 'chip chip-btn', type: 'button', onclick: () => openTarget(presetToTarget(t), PRESET_EXTRA[t.id] || {}) }, t.name)),
        h('button', { class: 'chip chip-btn', type: 'button', title: 'Open a random patch of sky', onclick: randomField }, '🎲 Random field'))),

    // 2. the sky map
    h('section', { class: 'home-map', 'aria-labelledby': 'map-h' },
      h('div', { class: 'row', style: { alignItems: 'baseline' } },
        h('h2', { id: 'map-h', style: { margin: 0 } }, 'The whole sky, as SPHEREx sees it'), h('div', { class: 'spacer' }), freshness),
      mission ? h('div', { class: 'stat-grid compact' },
        h('div', { class: 'stat' }, h('b', {}, niceNum(mission.images)), h('span', { class: 'tiny' }, 'SPHEREx images in the archive')),
        h('div', { class: 'stat' }, h('b', {}, `${(mission.skyFraction * 100).toFixed(0)}%`), h('span', { class: 'tiny' }, 'of the sky covered')),
        h('div', { class: 'stat' }, h('b', {}, niceDate(mission.built)), h('span', { class: 'tiny' }, 'map refreshed from NASA’s archive')),
        h('div', { class: 'stat' }, h('b', {}, niceDate(mission.lastMjd)), h('span', { class: 'tiny' }, 'date NASA’s SPHEREx telescope took its newest image (NASA publishes images weeks later)'))) : null,
      h('p', { class: 'tiny', style: { margin: '4px 0 8px' } }, 'Hover to read coordinates and how many SPHEREx images cover that spot. Click anywhere to play it, or a ✦ star for a challenge target. Ctrl + scroll or pinch to zoom.'),
      map,
      h('p', { class: 'tiny map-cap' }, 'Real SPHEREx Data Release 1 all-sky map (IRSA), false colour from three of its 102 bands: blue 0.9 µm, green 2.0 µm, red 4.6 µm. Equatorial grid, RA 12h at the centre; dotted line: the ecliptic, where asteroids and comets travel. ', h('a', { href: '#/sky' }, 'Zoom in with the Sky atlas →'))),

    // 3. challenge targets
    h('section', { 'aria-labelledby': 'presets-h' },
      h('h2', { id: 'presets-h' }, 'Challenge targets'),
      h('div', { class: 'presets' }, list.map((t) => h('button', {
        class: 'preset', type: 'button',
        onmouseenter: () => searchSpherex(t.ra, t.dec).catch(() => {}),
        onclick: () => openTarget(presetToTarget(t), PRESET_EXTRA[t.id] || {}),
      },
      h('b', {}, t.name), h('small', {}, t.kind),
      h('div', { class: 'meta' },
        h('span', { class: 'chip' }, `${t.images?.length ?? '…'} images`),
        t.pmra || t.pmdec ? h('span', { class: 'chip warn' }, `moves ${(Math.hypot(t.pmra, t.pmdec) / 1000).toFixed(2)}″/yr`) : null))))),

    // 4. how it works
    h('section', { 'aria-labelledby': 'how-h' },
      h('h2', { id: 'how-h' }, 'How it works'),
      h('div', { class: 'steps' },
        [['Choose a spot', 'Type a name or coordinates, click the map, or open a challenge target.'], ['Watch it change', 'Each frame is a real SPHEREx image or a six-month stack, aligned on the sky.'],
          ['Blink, subtract, stack', 'Moving and changing objects stand out; stacks reveal faint ones.'], ['Read the spectrum', 'Click any object to see its infrared spectrum and light curve.']]
          .map(([a2, b2], i) => h('div', { class: 'card step' }, h('span', { class: 'n' }, i + 1), h('div', {}, h('b', {}, a2), h('p', { class: 'muted', style: { margin: 0 } }, b2)))))),

    // 5. more ways in (kept tidy)
    h('section', { 'aria-labelledby': 'more-h' },
      h('h2', { id: 'more-h' }, 'More ways to start'),
      h('details', { class: 'card more' },
        h('summary', {}, h('b', {}, 'Describe what you want in words or equations'), h('span', { class: 'tiny' }, ' — e.g. “WISE 0855, 3 to 5 microns, blink first and last”')),
        h('p', { class: 'muted' }, 'Plain words and simple equations are turned into exact settings you can check before running. Nothing is sent anywhere.'),
        typed,
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn primary', onclick: () => runTyped(typed.value) }, 'Interpret'),
          ['Show WISE 0855 over all epochs, 3 to 5 microns, blink first and last', "Barnard's star, 4 arcmin field, track motion, with gaia", 'R Draconis per survey, color', 'WISE 0855\nmean(D5, D6) - epoch(1)\nwhere flag == 0'].map((ex) =>
            h('button', { class: 'btn small ghost', onclick: () => runTyped(ex) }, ex.replace(/\n/g, ' · ')))),
        understood),
      h('details', { class: 'card more' },
        h('summary', {}, h('b', {}, 'Upload a target list or your own image'), h('span', { class: 'tiny' }, ' — CSV, Excel, FITS, VOTable and more, read on your device')),
        uploadPanel({ go }))));
  return () => {};
}

export function detsForRange([a, b]) {
  const R = [[1, 0.75, 1.09], [2, 1.10, 1.62], [3, 1.63, 2.41], [4, 2.42, 3.82], [5, 3.83, 4.41], [6, 4.42, 5.0]];
  const d = R.filter(([, lo, hi]) => hi >= a && lo <= b).map(([id]) => id);
  return d.length ? d : DEFAULTS.dets;
}
