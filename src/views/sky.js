// Sky atlas: Aladin Lite (CDS) showing the SPHEREx DR1 all-sky HiPS served by IRSA,
// with the current field, Gaia DR3 and WISE overlays. Click to choose a new target.

import { h } from '../ui/dom.js';
import { normalise, fromParams, toParams } from '../state.js';
import { gaiaCone, catwiseCone } from '../lib/tap.js';
import { formatRA, formatDec } from '../lib/coords.js';
import { pushRecent } from './home.js';

export const title = 'Sky atlas';
export const SPHEREX_HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
// Aladin Lite has no teardown, so one map instance (and its WebGL context) is kept and re-used across visits.
let atlas = null; // { host, aladin, A }

let skyVisit = 0;
const prevCats = [];

export async function render(root, route, { go }) {
  const req = normalise(fromParams(route.params));
  const t = req.target || { ra: 133.786245, dec: -7.244372, name: 'WISE 0855−0714' };
  const host = atlas?.host || h('div', { class: 'aladin-host', id: 'aladin', role: 'application', 'aria-label': 'Interactive sky map' });
  const info = h('div', { class: 'tiny', 'aria-live': 'polite' }, 'Loading the sky map…');
  const picked = h('div', { class: 'row' });
  const props = h('p', { class: 'tiny' });
  const catBar = h('div', { class: 'row' });
  root.append(
    h('div', { class: 'row', style: { marginBottom: '10px' } },
      h('h1', { style: { margin: 0 } }, 'Sky atlas'), h('div', { class: 'spacer' }),
      req.target ? h('a', { class: 'btn', href: `#/view?${toParams(req)}` }, 'Back to the film of this field') : null),
    h('p', { class: 'muted' }, 'The whole sky as SPHEREx sees it: the DR1 all-sky spectral cube from IRSA, displayed with Aladin Lite from CDS Strasbourg. Drag to explore, scroll to zoom, click a spot to make it your next target.'),
    host, h('div', { class: 'row', style: { marginTop: '10px' } }, info, h('div', { class: 'spacer' }), catBar, picked), props);

  // The SPHEREx cube needs the service worker (it swaps the cube's blank middle channel for a valid one).
  if ('serviceWorker' in navigator && !navigator.serviceWorker.controller && location.protocol !== 'file:') {
    info.textContent = 'Preparing the sky map…';
    try {
      await Promise.race([navigator.serviceWorker.ready, new Promise((r) => setTimeout(r, 6000))]);
      if (!navigator.serviceWorker.controller && !sessionStorage.getItem('skyshift.skyReload')) { sessionStorage.setItem('skyshift.skyReload', '1'); location.reload(); return () => {}; }
    } catch { /* continue without */ }
  }
  if (!document.createElement('canvas').getContext('webgl2')) {
    host.replaceChildren(h('div', { class: 'empty' }, 'This device’s browser does not support WebGL2, which the sky map needs. Everything else in SkyShift works.'));
    info.textContent = '';
    return () => {};
  }
  let aladin;
  try {
    let A;
    if (atlas) {
      ({ A, aladin } = atlas);
      try { aladin.removeOverlays(); } catch { /* ignore */ }
      aladin.gotoRaDec(t.ra, t.dec);
      aladin.setFoV(Math.max(1.5, (req.fov / 60) * 6));
    } else {
      A = (await import('../../vendor/aladin.js')).default;
      await A.init;
      aladin = A.aladin(host, {
        survey: SPHEREX_HIPS, fov: Math.max(1.5, (req.fov / 60) * 6), target: `${t.ra} ${t.dec}`, cooFrame: 'ICRSd',
        showReticle: true, showLayersControl: false, showSimbadPointerControl: false, showShareControl: false, showSettingsControl: false,
        showProjectionControl: false, showContextMenu: false, showCooGridControl: true, showFullscreenControl: true, showFrame: true, showZoomControl: true,
        backgroundColor: 'rgb(5,6,26)', reticleColor: '#ffcf7a',
      });
      atlas = { host, aladin, A };
      aladin.on('click', (e) => atlas.onClick?.(e));
    }
    // field outline
    const ov = A.graphicOverlay({ color: '#ffcf7a', lineWidth: 2, name: 'Current field' });
    aladin.addOverlay(ov);
    const half = req.fov / 120, cosd = Math.cos((t.dec * Math.PI) / 180) || 1e-6;
    ov.add(A.polygon([[t.ra + half / cosd, t.dec - half], [t.ra - half / cosd, t.dec - half], [t.ra - half / cosd, t.dec + half], [t.ra + half / cosd, t.dec + half]]));
    info.textContent = `Centred on ${t.name || `${formatRA(t.ra)} ${formatDec(t.dec)}`}. Yellow box = the field shown in the Time Machine.`;
    // catalogues
    const rad = Math.min(0.5, Math.max(0.05, req.fov / 60));
    // catalogues: brightest sources only, so the SPHEREx sky stays visible; toggles below the map
    // catalogues belong to this visit: hide the previous visit's and ignore answers that arrive after leaving
    const visit = ++skyVisit;
    prevCats.forEach((c) => { try { c.hide(); } catch { /* already gone */ } }); prevCats.length = 0;
    const cats = {};
    const toggle = (key, label, on) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: on, onchange: (e) => { const c = cats[key]; if (c) (e.target.checked ? c.show() : c.hide()); } }), label);
    catBar.replaceChildren(h('span', { class: 'tiny' }, 'Catalogues:'), toggle('gaia', 'Gaia DR3 (brightest 300)', true), toggle('wise', 'CatWISE2020 (brightest 300)', false));
    gaiaCone(t.ra, t.dec, rad).then((r) => {
      if (visit !== skyVisit) return;
      const cat = A.catalog({ name: 'Gaia DR3', color: '#5ec8ff', sourceSize: 9 });
      aladin.addCatalog(cat); cats.gaia = cat; prevCats.push(cat);
      cat.addSources([...r.data.rows].sort((a, b) => (a.phot_g_mean_mag ?? 99) - (b.phot_g_mean_mag ?? 99)).slice(0, 300).map((s) => A.source(s.ra, s.dec, { name: `Gaia DR3 ${s.source_id}`, G: s.phot_g_mean_mag })));
    }).catch(() => {});
    catwiseCone(t.ra, t.dec, rad).then((r) => {
      if (visit !== skyVisit) return;
      const cat = A.catalog({ name: 'CatWISE2020', color: '#ffb547', sourceSize: 7, shape: 'square' });
      aladin.addCatalog(cat); cats.wise = cat; prevCats.push(cat);
      cat.addSources([...r.data.rows].sort((a, b) => (a.w1mpro ?? 99) - (b.w1mpro ?? 99)).slice(0, 300).map((s) => A.source(s.ra, s.dec, { name: s.source_name })));
      cat.hide();
    }).catch(() => {});
    atlas.onClick = (e) => {
      if (!e || e.ra == null) return;
      const ra = e.ra, dec = e.dec;
      picked.replaceChildren(h('span', { class: 'chip' }, `${formatRA(ra)} ${formatDec(dec)}`),
        h('button', { class: 'btn small primary', onclick: () => { const tt = { ra, dec, source: 'coords' }; pushRecent(tt); go(`#/view?${toParams(normalise({ ...req, target: tt, t: 0 }))}`); } }, 'Play this spot'));
    };
    fetch(`${SPHEREX_HIPS}/properties`).then((r) => r.text()).then((txt) => {
      const get = (k) => (txt.match(new RegExp(`^${k}\\s*=\\s*(.+)$`, 'm')) || [])[1]?.trim();
      props.textContent = `HiPS: ${get('obs_title') || 'SPHEREx'} · released ${get('hips_release_date') || '?'} · ${get('hips_cube_depth') || '?'} spectral frames · served by IRSA (${get('hips_copyright') || 'Caltech/IPAC'}). The HiPS PNG tiles are for visualisation only (fixed stretch). Aladin opens the cube’s middle channel, which IRSA leaves blank, so SkyShift shows the neighbouring channel (index 49, about 2.4 µm) instead; use the Time Machine for every wavelength.`;
    }).catch(() => {});
  } catch (e) {
    console.warn(e);
    host.replaceChildren(h('div', { class: 'empty' }, navigator.onLine ? `The sky map could not start (${e.message || e}).` : 'The sky map needs a connection the first time. The Time Machine works offline for saved fields.'));
    info.textContent = '';
  }
  return () => { skyVisit++; if (atlas) atlas.onClick = null; host.remove(); /* the map instance is kept for the next visit */ };
}
