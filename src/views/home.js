// Home: target search with predictive input, typed requests, presets, how-it-works.

import { h, icon, toast } from '../ui/dom.js';
import { presets, resolveTarget, presetToTarget, presetById, describePosition, fromGalactic } from '../targets.js';
import { parsePosition, formatRA, formatDec, mjdToISO } from '../lib/coords.js';
import { normalise, toParams, parseText, DEFAULTS } from '../state.js';
import { searchSpherex } from '../lib/tap.js';

export const title = 'Home';
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
  let sel = -1, items = [];

  const openTarget = (t, extra = {}) => {
    pushRecent(t);
    go(viewHash({ target: t, ...extra }));
  };
  const submit = async () => {
    const v = input.value.trim();
    if (sel >= 0 && items[sel]) { items[sel].pick(); return; }
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
    for (const r of recent()) {
      const label = r.name || `${r.ra.toFixed(4)} ${r.dec >= 0 ? '+' : ''}${r.dec.toFixed(4)}`;
      if (!v || label.toLowerCase().includes(v)) items.push({ label, sub: 'Recent', pick: () => openTarget(r) });
    }
    items = items.slice(0, 8);
    sel = -1;
    sugg.replaceChildren(...items.map((it, i) => h('button', { type: 'button', role: 'option', id: `sg${i}`, 'aria-selected': 'false', onmousedown: (e) => { e.preventDefault(); it.pick(); } },
      icon(it.sub === 'Recent' ? 'refresh' : 'star'), h('span', {}, it.label), h('span', { class: 'k' }, it.sub))));
    const show = document.activeElement === input && items.length > 0 && !pos;
    sugg.hidden = !show; input.setAttribute('aria-expanded', String(show));
  };
  input.addEventListener('input', updateSuggest);
  input.addEventListener('focus', updateSuggest);
  input.addEventListener('blur', () => setTimeout(() => { sugg.hidden = true; input.setAttribute('aria-expanded', 'false'); }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (sugg.hidden) return;
      e.preventDefault();
      sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      [...sugg.children].forEach((b, i) => b.setAttribute('aria-selected', String(i === sel)));
      input.setAttribute('aria-activedescendant', `sg${sel}`);
    } else if (e.key === 'Enter') { e.preventDefault(); submit(); }
    else if (e.key === 'Escape') { sugg.hidden = true; sel = -1; }
  });

  // ----- typed request (text -> SkyRequest) -----
  const typed = h('textarea', { id: 'typed', 'aria-label': 'Describe what you want to see', placeholder: 'e.g. Show WISE 0855 over all epochs, 3 to 5 microns, 10 arcmin field, blink first and last' });
  const understood = h('div', { class: 'understood', 'aria-live': 'polite' });
  async function runTyped(text) {
    typed.value = text;
    const pt = parseText(text);
    const partial = { ...pt.partial };
    let target = partial.target || null;
    if (partial.preset) { const t = await presetById(partial.preset); if (t) target = presetToTarget(t); }
    if (partial.galactic) target = { ...fromGalactic(...partial.galactic), source: 'text', name: `l=${partial.galactic[0]}, b=${partial.galactic[1]}` };
    delete partial.preset; delete partial.galactic;
    if (partial.blinkFirstLast) { partial.mode = partial.mode || 'blink'; delete partial.blinkFirstLast; }
    if (partial.wl && !partial.dets) partial.dets = detsForRange(partial.wl);
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

  // ----- hero art: animated blink of a moving star (illustration, labelled as such) -----
  const art = h('canvas', { width: 460, height: 460, role: 'img', 'aria-label': 'Illustration: a star shifting position between two epochs' });
  let raf = 0;
  (function animate() {
    const ctx = art.getContext('2d');
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stars = Array.from({ length: 150 }, (_, i) => [((i * 97) % 460), ((i * 211) % 460), 0.4 + ((i * 7) % 10) / 10]);
    const t0 = performance.now();
    const draw = (now) => {
      const t = (now - t0) / 1000, phase = reduce ? 0 : Math.floor(t / 0.8) % 2;
      const g = ctx.createRadialGradient(150, 110, 20, 230, 230, 330);
      g.addColorStop(0, '#2c2390'); g.addColorStop(1, '#05061a');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 460, 460);
      for (const [x, y, s] of stars) { ctx.fillStyle = `rgba(220,230,255,${0.35 + s * 0.5})`; ctx.beginPath(); ctx.arc(x, y, s, 0, 7); ctx.fill(); }
      const x = phase ? 262 : 214, y = phase ? 202 : 250;
      const rg = ctx.createRadialGradient(x, y, 0, x, y, 30); rg.addColorStop(0, '#fff'); rg.addColorStop(0.25, '#ffcf7a'); rg.addColorStop(1, 'rgba(255,160,90,0)');
      ctx.fillStyle = rg; ctx.beginPath(); ctx.arc(x, y, 30, 0, 7); ctx.fill();
      ctx.strokeStyle = '#ffcf7a88'; ctx.setLineDash([4, 5]); ctx.beginPath(); ctx.moveTo(214, 250); ctx.lineTo(262, 202); ctx.stroke(); ctx.setLineDash([]);
      ctx.font = '600 15px system-ui'; ctx.fillStyle = '#dfe3ff'; ctx.fillText(phase ? 'Later' : 'Earlier', 28, 430);
      ctx.fillStyle = '#9aa0d0'; ctx.font = '12px system-ui'; ctx.fillText('Illustration', 380, 430);
      if (!reduce) raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
  })();

  const freshness = h('span', { class: 'chip info' }, 'Checking newest SPHEREx data…');
  const newest = Number(localStorage.getItem('skyshift.newestMjd') || 0);
  if (newest) freshness.textContent = `IRSA holds SPHEREx exposures up to ${mjdToISO(newest, false)}`;
  else import('../lib/tap.js').then(async ({ latestSpherex }) => {
    try { const r = await latestSpherex(); if (r.data) freshness.textContent = `IRSA holds SPHEREx exposures up to ${mjdToISO(r.data, false)}${r.source !== 'live' ? ' (saved)' : ''}`; }
    catch { freshness.textContent = 'Live archive check unavailable — saved data still works'; }
  });

  root.append(
    h('section', { class: 'hero' },
      h('div', {},
        h('span', { class: 'chip good' }, '102 infrared bands · whole sky every six months'),
        h('h1', {}, 'SkyShift: ', h('span', { class: 'gradient' }, 'a time machine'), ' for the SPHEREx sky'),
        h('p', { class: 'lead' }, 'Type a star or any coordinates, press Play, and watch NASA SPHEREx images of that patch of sky play like a little film. Moving brown dwarfs and asteroids jump out; click any object to see its infrared spectrum.'),
        h('form', { class: 'searchbox', role: 'search', onsubmit: (e) => { e.preventDefault(); submit(); } },
          (() => { const NS = 'http://www.w3.org/2000/svg'; const s = document.createElementNS(NS, 'svg'); s.setAttribute('class', 's-icon'); s.setAttribute('viewBox', '0 0 24 24'); const p = document.createElementNS(NS, 'path'); p.setAttribute('d', 'M11 4a7 7 0 100 14 7 7 0 000-14zM21 21l-4.3-4.3'); s.appendChild(p); return s; })(),
          input, h('button', { class: 'btn primary go', type: 'submit' }, icon('play'), 'Play'), sugg),
        parsed,
        h('div', { class: 'row', style: { marginTop: '8px' } }, freshness,
          h('button', { class: 'btn small', type: 'button', title: 'Open a random patch of sky', onclick: () => {
            const u = Math.random(), v = Math.random();
            const ra = 360 * u, dec = (Math.acos(2 * v - 1) * 180) / Math.PI - 90;
            openTarget({ ra: +ra.toFixed(5), dec: +(-dec).toFixed(5), source: 'coords', name: 'Random field' });
          } }, icon('dice'), 'Random field'))),
      h('div', { class: 'hero-art' }, art)),
    h('section', { 'aria-labelledby': 'presets-h' },
      h('h2', { id: 'presets-h' }, 'Start with a challenge target'),
      h('div', { class: 'presets' }, list.map((t) => h('button', {
        class: 'preset', type: 'button',
        onmouseenter: () => searchSpherex(t.ra, t.dec).catch(() => {}),
        onclick: () => openTarget(presetToTarget(t), t.id === 'wise0855' ? { dets: [4, 5, 6], mode: 'blink' } : t.id === 'barnard' ? { mode: 'blink' } : {}),
      },
      h('b', {}, t.name), h('small', {}, t.kind),
      h('div', { class: 'meta' },
        h('span', { class: 'chip' }, `${t.images?.length ?? '…'} images`),
        t.pmra || t.pmdec ? h('span', { class: 'chip warn' }, `${(Math.hypot(t.pmra, t.pmdec) / 1000).toFixed(2)}″/yr`) : null))))),
    h('section', { class: 'steps', 'aria-label': 'How it works' },
      [['Choose a patch of sky', 'A name, coordinates or a link with ?ra=…&dec=…'], ['Watch it change', 'Each frame is a real SPHEREx exposure or a six-month co-add, aligned on the sky.'],
        ['Blink, subtract, stack', 'Moving and changing objects stand out; co-adds lift faint ones.'], ['Read the spectrum', 'Every frame is a different wavelength: SkyShift turns them into spectra on the fly.']]
        .map(([a, b], i) => h('div', { class: 'card step' }, h('span', { class: 'n' }, i + 1), h('div', {}, h('b', {}, a), h('p', { class: 'muted', style: { margin: 0 } }, b))))),
    h('section', { class: 'card typed', 'aria-labelledby': 'typed-h' },
      h('h2', { id: 'typed-h' }, 'Or just describe it'),
      h('p', { class: 'muted' }, 'Plain words are turned into exact settings you can check before running. Nothing is sent anywhere.'),
      typed,
      h('div', { class: 'row', style: { marginTop: '8px' } },
        h('button', { class: 'btn primary', onclick: () => runTyped(typed.value) }, 'Interpret'),
        ['Show WISE 0855 over all epochs, 3 to 5 microns, blink first and last', "Barnard's star, 4 arcmin field, track motion, with gaia", 'R Draconis per survey, color'].map((ex) =>
          h('button', { class: 'btn small ghost', onclick: () => runTyped(ex) }, ex))),
      understood));
  return () => cancelAnimationFrame(raf);
}

export function detsForRange([a, b]) {
  const R = [[1, 0.75, 1.09], [2, 1.10, 1.62], [3, 1.63, 2.41], [4, 2.42, 3.82], [5, 3.83, 4.41], [6, 4.42, 5.0]];
  const d = R.filter(([, lo, hi]) => hi >= a && lo <= b).map(([id]) => id);
  return d.length ? d : DEFAULTS.dets;
}
