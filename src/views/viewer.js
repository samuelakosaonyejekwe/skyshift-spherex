// Explore: the time-series viewer. Movie, Blink, Difference, Stack and false-colour
// modes over SPHEREx exposures aligned on the sky; spectra and light curves on the fly;
// Gaia / WISE / NEOSSat context; metadata and contamination flags.

import { h, icon, toast, sheet, copyText, download, fmtBytes, fmtDur, downlinkMbps } from '../ui/dom.js';
import { normalise, fromParams, toParams, MODES, GROUPS, FOV_STEPS } from '../state.js';
import { loadPack } from '../lib/packs.js';
import { relayUrls, smartFetch } from '../lib/net.js';
import { getEphemeris, interpEph } from '../lib/ephem.js';
import { searchSpherex, searchAlongPath, quickSpherex, gaiaCone, catwiseCone, allwiseCone, neossatCone } from '../lib/tap.js';
import { makeGrid, gridToWorld, worldToGrid, estimateBytesPerExposure, NATIVE_SCALE, photometry } from '../lib/engine.js';
import { groupExposures, perDetector, detectorBalanced, matchedDifference, meanOfMaps, limits, paint, paintDiff, paintRGB, coadd, clippedCoadd, upsampleRGBA, tintName, SURVEY_GAP_DAYS, orderForLoading } from '../lib/render.js';
import { DETECTORS, FLAG_BITS, BAD_MASK, decodeFlags, uriToS3, uriToIbe } from '../lib/spherex.js';
import { formatRA, formatDec, propagate, apparent, mjdToYear, yearToMjd, mjdToISO, niceDate, niceDateTime, separation, toGalactic, precessFromJ2000, abMag } from '../lib/coords.js';
import { presetById, presetToTarget, suggestFor } from '../targets.js';
import { scatterChart, svgString } from '../ui/charts.js';
import { pushRecent } from './home.js';
import { saveCandidate, isWatched, toggleWatch, getQueue, clearQueue } from './saved.js';
import { findMovers, findVariables, epochBrightness, questionable } from '../lib/discover.js';
import { getSettings, effectiveReadMode } from '../settings.js';
import { parse as parseExpr, evalScalar, evalImage, splitStatements } from '../lib/expr.js';

export const title = 'Time Machine';

// Spectral lines with wavelengths stated in the approved sources (IRSA SPHEREx docs,
// Explanatory Supplement and tutorials). See docs/DATA_SOURCES.md.
export const LINES = [
  { x: 1.083, label: 'He 1.083', color: '#ff9db0', title: 'Helium 1.083 µm: atmospheric airglow line that contaminates detectors D1–D2 (Explanatory Supplement)' },
  { x: 1.88, label: 'Pa α', color: '#9fd8ff', title: 'Hydrogen Paschen α, 1.88 µm (IRSA SPHEREx all-sky cube tutorial)' },
  { x: 3.3, label: 'PAH 3.3', color: '#ffd27a', title: 'Polycyclic aromatic hydrocarbon (carbon-rich molecules) feature, 3.3 µm (IRSA SPHEREx mosaic tutorial)' },
  { x: 4.052, label: 'Br α', color: '#9fd8ff', title: 'Hydrogen Brackett α, 4.052 µm (Explanatory Supplement)' },
];
const EPOCH_COLORS = ['#56b4e9', '#e69f00', '#009e73', '#f0e442', '#cc79a7', '#d55e00', '#0072b2', '#ffffff'];
const WISEVIEW = 'http://byw.tools/wiseview';

let worker = null;
function getWorker() {
  if (!worker) worker = new Worker(new URL('../worker.js', import.meta.url), { type: 'module' });
  return worker;
}

// Session memory so Back/Forward never loses loaded frames.
const session = new Map(); // key -> { exposures: Map(uri -> frame), search }

export async function render(root, route, { go }) {
  let req = normalise(fromParams(route.params));
  if (route.params.get('target') || fromParams(route.params).preset) {
    const t = await presetById(route.params.get('target') || fromParams(route.params).preset);
    if (t) req = normalise({ ...req, target: presetToTarget(t) });
  }
  if (!req.target) return renderEmpty(root, go);
  const preset = req.target.id ? await presetById(req.target.id) : null;
  pushRecent(req.target);

  // ------------------------------------------------------------------ state
  const S = {
    search: null, exposures: [], frames: new Map(), grid: null, display: null, frame: Math.min(req.t, 999),
    playing: false, timer: 0, blinkPhase: 0, userMode: 'off', userPhase: true, userTimer: 0, loadId: 0, jobId: 0, bytes: 0, t0: 0, skipped: 0,
    view: { s: 1, tx: 0, ty: 0 }, hover: null, tool: null, ruler: null, selected: null,
    cats: { gaia: null, wise: null, neossat: null }, rawPixels: localStorage.getItem('skyshift.rawPixels') === '1', movers: null, variables: null, clickSpec: null,
  };
  const n = () => S.grid.n;

  // ------------------------------------------------------------------ DOM
  const name = req.target.name || `${formatRA(req.target.ra)} ${formatDec(req.target.dec)}`;
  const imgCanvas = h('canvas', { 'aria-hidden': 'true' });
  const ovCanvas = h('canvas', { 'aria-hidden': 'true' });
  const hud = h('div', { class: 'hud' });
  const readout = h('div', { class: 'readout', hidden: true });
  const loading = h('div', { class: 'loading' }, h('div', {}, h('div', { class: 'boot-orbit', style: { margin: '0 auto 12px' } }, h('span')), h('p', { id: 'loadmsg' }, 'Finding every SPHEREx image of this patch…'), h('div', { class: 'progress', style: { width: '240px', margin: '0 auto' } }, h('i', { id: 'loadbar' }))));
  const stage = h('div', { class: 'stage', tabindex: '0', role: 'img', 'aria-label': `SPHEREx images around ${name}` }, imgCanvas, ovCanvas, readout, loading);
  const playBtn = h('button', { class: 'btn primary play', type: 'button', 'aria-label': 'Play', title: 'Play / pause (Space)' }, icon('play'));
  const slider = h('input', { type: 'range', min: 0, max: 0, value: 0, 'aria-label': 'Frame' });
  const ticks = h('div', { class: 'ticks', 'aria-hidden': 'true' });
  const frameLabel = h('div', { class: 'framelabel', 'aria-live': 'polite' });
  const speedSel = h('select', { 'aria-label': 'Playback speed', title: 'Time per frame' }, [[1200, 'Slow'], [600, 'Normal'], [300, 'Fast'], [120, 'Very fast']].map(([v, l]) => h('option', { value: v, selected: Math.abs(req.speed - v) < 50 }, l)));
  const progressBar = h('i');
  const statusLine = h('div', { class: 'tiny', 'aria-live': 'polite' });
  const modeSeg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Display mode' });
  // Inverted view (WiseView, DS9 and JS9 call it "invert"): dark objects on a white sky; black and white, except
  // Colour, which shows complementary colours
  const setNegative = (on) => {
    if (on) { S.cmapBeforeNeg = req.cmap; commit({ invert: true, cmap: req.mode === 'color' ? req.cmap : 'gray' }); }
    else commit({ invert: false, cmap: S.cmapBeforeNeg && S.cmapBeforeNeg !== 'gray' ? S.cmapBeforeNeg : 'auto' });
  };
  // your own image of the same field (sent from the image inspector): off → shown → blinking with the SPHEREx frame
  const userBtn = h('button', { type: 'button', class: 'btn small user-btn', hidden: true, 'aria-pressed': 'false', onclick: () => setUserMode(S.userMode === 'off' ? 'show' : S.userMode === 'show' ? 'blink' : 'off') }, 'Your image');
  const negBtn = h('button', { type: 'button', class: 'btn small neg-btn', 'aria-pressed': 'false', onclick: () => setNegative(!req.invert) },
    h('span', { class: 'neg-ico', 'aria-hidden': 'true' }), h('span', { class: 'neg-lbl' }, 'Invert'));
  const suggestionBox = h('div');
  const explainBox = h('div', { class: 'notice', hidden: true });
  const tabsBar = h('div', { class: 'tabs', role: 'tablist' });
  const tabBody = h('div');
  const vside = h('aside', { class: 'vside' }, h('div', { class: 'card' }, tabsBar, tabBody));

  const shareBtn = h('button', { class: 'btn small', type: 'button', onclick: () => shareDialog(), 'aria-label': 'Share or embed' }, icon('share'), h('span', { class: 'lbl' }, 'Share / embed'));
  const watchBtn = h('button', { class: 'btn small hide-embed', type: 'button', onclick: () => { const on = toggleWatch(req); watchBtn.querySelector('.lbl').textContent = on ? 'Saved' : 'Save'; toast({ title: on ? 'Field saved' : 'Removed from saved fields', text: on ? 'It works offline, and you will be told when new SPHEREx data covers it.' : '', glyph: '🔖', timeout: 3500 }); }, 'aria-label': 'Save this field' }, icon('bookmark'), h('span', { class: 'lbl' }, isWatched(req) ? 'Saved' : 'Save'));
  const wiseLink = h('a', { class: 'btn small', target: '_blank', rel: 'noopener noreferrer', title: 'Compare with WISE/NEOWISE in WiseView (opens byw.tools)',
    href: `${WISEVIEW}#ra=${req.target.ra.toFixed(6)}&dec=${req.target.dec.toFixed(6)}&size=${Math.round(Math.min(req.fov, 30) * 60 / 2.75)}&band=2&speed=${req.speed}&minbright=-50.0000&maxbright=500.0000&window=0.5&diff_window=1&linear=1&color=&zoom=9&border=0&gaia=0&invert=1`, 'aria-label': 'Open in WiseView' }, icon('video'), h('span', { class: 'lbl' }, 'WiseView'));
  // WiseView is an outside site: it is checked through the relay first; when it does not answer, the same field is
  // shown in NASA's WISE images (IRSA Finder Chart) inside SkyShift instead of leading to an error page
  const guardWise = (a) => { a.addEventListener('click', (e) => { e.preventDefault(); openWiseView(a.href); }); return a; };
  guardWise(wiseLink);
  const skyLink = h('a', { class: 'btn small hide-embed', href: `#/sky?${toParams(req)}`, 'aria-label': 'Sky atlas' }, icon('sky'), h('span', { class: 'lbl' }, 'Sky atlas'));
  const explainBtn = h('button', { class: 'btn small', type: 'button', 'aria-expanded': 'false', onclick: () => { explainBox.hidden = !explainBox.hidden; explainBtn.setAttribute('aria-expanded', String(!explainBox.hidden)); explain(); }, 'aria-label': 'Explain this view' }, icon('help'), h('span', { class: 'lbl' }, 'Explain this view'));
  const dossierBtn = h('button', { class: 'btn small hide-embed', type: 'button', title: 'Generate a reproducible report with figures, tables and FITS cutouts', onclick: () => makeDossier(), 'aria-label': 'Generate dossier' }, icon('download'), h('span', { class: 'lbl' }, 'Dossier'));
  const tourBtn = h('button', { class: 'btn small ghost hide-embed', type: 'button', onclick: () => tour() }, 'Tour');
  const openFull = req.embed ? h('a', { class: 'btn small primary', href: location.href.replace(/([?&])embed=1&?/, '$1'), target: '_blank', rel: 'noopener' }, 'Open in SkyShift') : null;

  const g = toGalactic(req.target.ra, req.target.dec);
  root.append(h('div', { class: 'viewer' },
    h('section', { 'aria-label': 'Image viewer' },
      h('div', { class: 'vhead' },
        h('div', {},
          h('h1', {}, name),
          h('div', { class: 'tiny' }, `RA ${formatRA(req.target.ra)}  Dec ${formatDec(req.target.dec)}`, h('span', { class: 'lbl' }, `  ·  ${req.target.ra.toFixed(5)}°, ${req.target.dec.toFixed(5)}°  ·  l=${g.l.toFixed(2)}° b=${g.b.toFixed(2)}°  ·  ICRS${req.target.refEpoch ? `, epoch ${req.target.refEpoch}` : ''}`))),
        h('div', { class: 'spacer' }),
        h('div', { class: 'row' }, explainBtn, shareBtn, watchBtn, dossierBtn, skyLink, wiseLink, tourBtn, openFull)),
      queueBar(), suggestionBox, explainBox,
      // frame details sit in a strip above the image, never on top of it
      h('div', { class: 'stage-wrap' }, hud, stage),
      h('div', { class: 'progress', 'aria-hidden': 'true' }, progressBar),
      h('div', { class: 'transport' },
        h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Previous frame', title: 'Previous frame (←)', onclick: () => step(-1) }, icon('prev')),
        playBtn,
        h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Next frame', title: 'Next frame (→)', onclick: () => step(1) }, icon('next')),
        h('div', { class: 'timeline' }, slider, ticks), speedSel),
      frameLabel,
      h('div', { class: 'row', style: { marginTop: '8px' } }, modeSeg, negBtn, userBtn, h('div', { class: 'spacer' }),
        h('button', { class: 'btn small', type: 'button', title: 'Zoom in (+)', 'aria-label': 'Zoom in', onclick: () => zoom(1.4) }, '+'),
        h('button', { class: 'btn small', type: 'button', title: 'Zoom out (−)', 'aria-label': 'Zoom out', onclick: () => zoom(1 / 1.4) }, '−'),
        h('button', { class: 'btn small', type: 'button', title: 'Reset view (R)', onclick: () => { S.view = { s: 1, tx: 0, ty: 0 }; draw(); } }, 'Reset'),
        h('button', { class: 'btn small', type: 'button', 'aria-pressed': 'false', title: 'Ruler: drag to measure angular distance', onclick: (e) => { S.tool = S.tool === 'ruler' ? null : 'ruler'; e.currentTarget.setAttribute('aria-pressed', String(S.tool === 'ruler')); stage.style.cursor = S.tool ? 'crosshair' : ''; } }, icon('ruler'), 'Ruler'),
        h('button', { class: 'btn small', type: 'button', 'aria-pressed': String(localStorage.getItem('skyshift.rawPixels') === '1'), title: 'Show the exact SPHEREx pixels (6.15″ squares) instead of the smooth view', onclick: (e) => { S.rawPixels = !S.rawPixels; localStorage.setItem('skyshift.rawPixels', S.rawPixels ? '1' : '0'); e.currentTarget.setAttribute('aria-pressed', String(S.rawPixels)); draw(); } }, 'Raw pixels'),
        h('button', { class: 'btn small', type: 'button', title: 'Download this frame as PNG', onclick: () => exportPNG() }, icon('download'), 'PNG'),
        h('button', { class: 'btn small', type: 'button', title: 'Save the animation as an animated GIF', onclick: () => exportGIF() }, icon('download'), 'GIF'),
        h('button', { class: 'btn small', type: 'button', title: 'Record the animation as a video file', onclick: () => exportVideo() }, icon('video'), 'Video')),
      statusLine),
    vside));

  function queueBar() {
    const q = getQueue();
    if (!q?.items?.length) return null;
    const near = (hsh) => { const p = new URLSearchParams(hsh.split('?')[1] || ''); return Math.abs(Number(p.get('ra')) - req.target.ra) < 1e-5 && Math.abs(Number(p.get('dec')) - req.target.dec) < 1e-5; };
    const i = q.items.findIndex((it) => near(it.hash));
    if (i < 0) return null;
    return h('div', { class: 'suggestion', style: { marginBottom: '10px' } }, h('span', { 'aria-hidden': 'true' }, '🗂'),
      h('span', { style: { flex: 1 } }, `Queue: field ${i + 1} of ${q.items.length}${q.items[i].name ? ` — ${q.items[i].name}` : ''}`),
      h('button', { class: 'btn small', disabled: i === 0, onclick: () => go(q.items[i - 1].hash) }, 'Previous'),
      h('button', { class: 'btn small primary', disabled: i === q.items.length - 1, onclick: () => go(q.items[i + 1].hash) }, 'Next field'),
      h('button', { class: 'btn small ghost', onclick: (e) => { clearQueue(); e.currentTarget.parentElement.remove(); } }, 'End queue'));
  }

  // ------------------------------------------------------------------ URL sync
  function commit(patch, { reload = false, push = false } = {}) {
    const prevKey = loadKey();
    const nextReq = normalise({ ...req, ...patch });
    const hash = `#/view?${toParams(nextReq)}`;
    if (push) { go(hash); return; }
    req = nextReq;
    history.replaceState(history.state, '', hash);
    renderModes();
    if (S.search) renderSuggestion(); // a "Try …" button disappears once its mode is on
    if (reload || loadKey() !== prevKey) load();
    else { rebuild(); renderSide(); }
  }
  const loadKey = () => `${req.target.ra.toFixed(6)},${req.target.dec.toFixed(6)},${req.fov},${req.track ? 1 : 0},${req.ov.includes('flags') ? 'F' : ''}${req.target.eph ? ',' + req.target.eph : ''}`;

  // ------------------------------------------------------------------ mode buttons
  const MODE_INFO = {
    movie: ['Movie', 'Play every frame in time order, like a little film'],
    blink: ['Blink', 'Flip between two epochs, the way Pluto was discovered'],
    diff: ['Difference', 'Subtract a reference epoch: movers show as black/white pairs, changing objects as spots'],
    stack: ['Stack', 'Add epochs together to reveal faint objects'],
    color: ['Colour', 'False colour: blue = 0.75–1.6 µm (D1–D2), green = 1.6–3.8 µm (D3–D4), red = 3.8–5 µm (D5–D6)'],
    expr: ['Equation', 'Your own image arithmetic, e.g. (D5 + D6)/2 − epoch(1)'],
  };
  function setUserMode(m) {
    S.userMode = S.userLayer ? m : 'off';
    clearInterval(S.userTimer); S.userPhase = true;
    if (S.userMode === 'blink') S.userTimer = setInterval(() => { S.userPhase = !S.userPhase; draw(); }, Math.max(300, req.speed));
    userBtn.hidden = !S.userLayer;
    userBtn.setAttribute('aria-pressed', String(S.userMode !== 'off'));
    userBtn.textContent = S.userMode === 'show' ? 'Your image: shown' : S.userMode === 'blink' ? 'Blinking with your image' : 'Your image';
    userBtn.title = 'Your own image of this field, resampled onto the same grid: click to show it, again to blink it with the SPHEREx frame, again to hide it';
    draw();
  }
  const userShown = () => S.userLayer && S.userLayer.n === n() && (S.userMode === 'show' || (S.userMode === 'blink' && S.userPhase));

  function renderModes() {
    modeSeg.replaceChildren(...MODES.filter((m) => m !== 'expr' || req.expr).map((m, i) => h('button', { type: 'button', 'aria-pressed': String(req.mode === m), title: `${MODE_INFO[m][1]} (key ${i + 1})`, onclick: () => commit({ mode: m }) }, MODE_INFO[m][0])));
    // Inverted: black and white, dark objects on a white sky, where faint tails, comas and moving objects show best
    const neg = !!req.invert;
    negBtn.setAttribute('aria-pressed', String(neg));
    negBtn.querySelector('.neg-lbl').textContent = neg ? 'Inverted' : 'Invert';
    negBtn.title = neg ? 'Back to the normal view (key i)' : 'Invert: black and white, dark objects on a white sky; faint tails, comas and moving objects show best (key i)';
  }

  // ------------------------------------------------------------------ loading
  async function load() {
    const id = ++S.loadId;
    stopPlay();
    S.grid = makeGrid(req.target.ra, req.target.dec, req.fov);
    S.userLayer = !req.track ? globalThis.__skyshiftUserLayers?.get(`${req.target.ra.toFixed(6)},${req.target.dec.toFixed(6)},${req.fov}`) || null : null;
    if (S.userLayer) S.userLims = limits([S.userLayer.data], 0.5, 99.5);
    setUserMode(S.userLayer ? (S.userMode && S.userMode !== 'off' ? S.userMode : 'blink') : 'off');
    const key = loadKey();
    if (!session.has(key)) session.set(key, { frames: new Map() });
    // keep only the 3 most recently used fields in memory (pixels stay cached on disk in IndexedDB)
    const entry = session.get(key); session.delete(key); session.set(key, entry);
    while (session.size > 3) session.delete(session.keys().next().value);
    S.frames = entry.frames;
    S.bytes = 0; S.t0 = performance.now(); S.skipped = 0;
    loading.hidden = false;
    loading.querySelector('.boot-orbit').hidden = false;
    setLoad('Finding every SPHEREx image of this patch (IRSA archive)…', 0.03);
    if (req.target.eph) { loadMoving(id); return; }
    // 1) instant start from the saved or built-in image list (no network wait), and the pre-cut frame pack
    // when this view has one (challenge targets and the fastest Gaia stars): those frames show at once
    let shown = 0;
    const onPack = (batch) => {
      if (id !== S.loadId) return;
      for (const f of batch) if (!S.frames.has(f.rec.uri)) S.frames.set(f.rec.uri, f);
      // show frames while the pack is still arriving (first after 2 frames, then about every 700 ms)
      const now = performance.now();
      if (S.frames.size >= 2 && (!shown || now - shown > 700)) { shown = now; loading.hidden = true; rebuild(); autoplay(); }
    };
    // each selected detector gets about its share of the image budget (the loading order alternates detectors);
    // detectors that already have that many frames in memory are not fetched again
    const budget = S.extraImages === Infinity ? Infinity : (getSettings().maxImages || 120) + (S.extraImages || 0);
    const per = Math.ceil(budget / req.dets.length) + 4;
    const have = (d) => [...S.frames.values()].filter((f) => f.meta.detector === d).length;
    const saved = await quickSpherex(req.target.ra, req.target.dec); // IndexedDB or built-in list: no network
    if (id !== S.loadId) return;
    // with a known image list, exactly the frames this view will show are read from each detector's file
    const need = saved?.data?.length ? new Set(orderForLoading(saved.data.filter((e) => req.dets.includes(e.det))).slice(0, budget).filter((e) => !S.frames.has(e.uri)).map((e) => e.uri)) : null;
    const packs = need && !need.size ? [] : await Promise.all(req.dets.filter((d) => need || have(d) < per).map((d) => loadPack(key, d, per, onPack, need)));
    if (id !== S.loadId) return;
    const pack = packs.some(Boolean) ? { built: packs.find(Boolean).built, frames: packs.filter(Boolean).flatMap((p) => p.frames) } : null;
    const quick = saved?.data?.length ? saved : pack ? { data: [...S.frames.values()].map((f) => f.rec), source: 'pack', ts: Date.parse(pack.built) || null } : null;
    if (quick?.data?.length) { S.search = quick; S.exposures = quick.data; renderSuggestion(); stream(id); if (pack) autoplay(); }
    // 2) live search (always): adds anything newer than the quick list
    let live;
    try {
      live = await searchSpherex(req.target.ra, req.target.dec);
    } catch (e) {
      if (id !== S.loadId) return;
      if (quick?.data?.length) {
        toast({ title: 'Showing the saved image list', text: `The live archive search did not answer (${e.message}). ${quick.ts ? 'List saved ' + niceDateTime(quick.ts) + '.' : 'Built-in list.'}`, glyph: '📦', timeout: 7000 });
        return;
      }
      setLoad(navigator.onLine ? `The image search did not answer (${e.message}). The five challenge targets, saved fields and every field you have opened before still work; try again shortly.` : 'You are offline and this field is not saved on this device yet.', 0);
      loading.querySelector('.boot-orbit').hidden = true;
      loading.firstChild.append(h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => load() }, 'Retry'));
      return;
    }
    if (id !== S.loadId) return;
    if (live.source !== 'live' && !quick?.data?.length) toast({ title: live.source === 'cache' ? 'Showing the saved image list' : 'Showing the built-in image list', text: `The live archive search did not answer (${live.error?.message || 'offline'}).`, glyph: '📦', timeout: 7000 });
    const known = new Set((S.exposures || []).map((e) => e.uri));
    const added = live.data.filter((e) => !known.has(e.uri));
    S.search = live; S.exposures = live.data;
    renderSuggestion();
    if (!S.exposures.length) {
      setLoad('SPHEREx has no images covering this position yet. New data arrive every week: save the field to be told when they do.', 0);
      loading.querySelector('.boot-orbit').hidden = true;
      return;
    }
    if (!quick?.data?.length || added.length) {
      if (quick?.data?.length && quick.source !== 'pack' && added.length) toast({ title: `${added.length} newer SPHEREx exposure${added.length > 1 ? 's' : ''} found`, text: 'Adding them to the film now.', glyph: '🛰', timeout: 4000 });
      stream(id);
    } else {
      const n = S.exposures.filter((e) => req.dets.includes(e.det)).length, cap = getSettings().maxImages || n;
      S.moreAvailable = Math.max(0, n - cap - (S.extraImages === Infinity ? n : S.extraImages || 0));
      updateStatus(Math.min(S.frames.size, n), Math.min(n, cap + (S.extraImages === Infinity ? n : S.extraImages || 0)), null, true);
    }
  }

  /** A Solar System object followed along the user's table of positions: images along its path, then streaming. */
  async function loadMoving(id) {
    const e = getEphemeris(req.target.eph);
    const stop = (text) => { setLoad(text, 0); loading.querySelector('.boot-orbit').hidden = true; };
    if (!e) { stop('This object’s table of positions is not on this device (tables stay on the device they were uploaded on). Upload it again on the Chase page.'); return; }
    S.eph = e.points; S.ephSource = e.source || 'your table';
    setLoad(`Searching for SPHEREx images along the object’s path (${e.points.length} positions)…`, 0.03);
    let r;
    try {
      r = await searchAlongPath(e.points, { onProgress: (d, n) => { if (id === S.loadId) setLoad(`Searching for SPHEREx images along the object’s path… ${d}/${n}`, 0.03 + (0.3 * d) / n); } });
    } catch (err) {
      if (id !== S.loadId) return;
      stop(`The image search did not answer (${err.message}). Please try again shortly.`);
      loading.firstChild.append(h('button', { class: 'btn primary', style: { marginTop: '10px' }, onclick: () => load() }, 'Retry'));
      return;
    }
    if (id !== S.loadId) return;
    S.search = r; S.exposures = r.data;
    renderSuggestion();
    if (!r.data.length) { stop('SPHEREx has no images along this path during the times your table covers. SPHEREx images begin in May 2025: check that the table covers dates since then.'); return; }
    stream(id);
  }

  /** Stream every wanted exposure that is not loaded yet (restarts the worker job). */
  function stream(id) {
    const ordered = orderForLoading(S.exposures.filter((e) => req.dets.includes(e.det)));
    // images per target: the round-robin order spreads the budget across epochs and detectors
    const cap = S.extraImages === Infinity ? 0 : (getSettings().maxImages || 0) + (S.extraImages || 0);
    const wanted = cap ? ordered.slice(0, cap) : ordered;
    S.moreAvailable = ordered.length - wanted.length;
    const todo = wanted.filter((e) => !S.frames.has(e.uri));
    updateStatus(wanted.length - todo.length, wanted.length);
    rebuild();
    if (!todo.length) { loading.hidden = true; renderSide(); return; }
    if (!S.frames.size) setLoad(`Streaming ${todo.length} exposures straight from the IRSA cloud archive…`, 0.05);
    const pm = req.target.eph && S.eph ? { eph: S.eph } : req.target.pmra || req.target.pmdec || req.target.plx ? { pmra: req.target.pmra || 0, pmdec: req.target.pmdec || 0, plx: req.target.plx || 0, refYear: req.target.refEpoch || 2016 } : null;
    const w = getWorker();
    const gather = relayUrls(); // relays read each exposure's rows in one request (see relay/core.mjs gather)
    let lastBuild = 0;
    const done0 = wanted.length - todo.length;
    const job = ++S.jobId;
    if (S.streamListener) w.removeEventListener('message', S.streamListener);
    S.streamListener = (ev) => {
      const m = ev.data;
      if (m.id !== job || id !== S.loadId) return;
      if (m.type === 'frame') {
        S.frames.set(todo[m.index].uri, { data: m.data, flags: m.flags, meta: m.meta, phot: m.phot, rec: todo[m.index] });
        loading.hidden = true;
        autoplay();
        const now = performance.now();
        // rebuild at most every 0.7 s, and less often when a rebuild is slow (large fields), so the page stays responsive
        if (now - lastBuild > Math.max(700, (S.rebuildMs || 0) * 4)) { lastBuild = now; const t0r = performance.now(); rebuild(); S.rebuildMs = performance.now() - t0r; if (['spectrum', 'lightcurve'].includes(S.tab) && !S.clickSpec) renderSide(); }
      } else if (m.type === 'skip') {
        S.skipped++;
        if (m.reason !== 'outside') console.warn('Exposure skipped:', todo[m.index]?.uri, m.reason);
      } else if (m.type === 'progress') {
        S.bytes = m.bytes;
        progressBar.style.width = `${((done0 + m.done) / wanted.length) * 100}%`;
        updateStatus(done0 + m.done, wanted.length, m);
        if (!loading.hidden) setLoad(`Streaming exposures from the IRSA cloud archive… ${m.done}/${m.total}`, m.done / m.total);
      } else if (m.type === 'done') {
        progressBar.style.width = '100%';
        rebuild(); renderSide();
        if (S.afterStream) { const f = S.afterStream; S.afterStream = null; f(); }
        updateStatus(wanted.length, wanted.length, m, true);
        if (!S.frames.size) { loading.hidden = false; loading.querySelector('.boot-orbit').hidden = true; setLoad('None of the images could be read. The archive may be busy; please retry.', 0); }
      }
    };
    w.addEventListener('message', S.streamListener);
    w.postMessage({ type: 'frames', id: job, items: todo, grid: S.grid, opts: { withFlags: flagMode(), track: req.track ? pm : null, photTrack: pm, concurrency: gather.length ? 24 : 12, readMode: effectiveReadMode(), gather } });
    renderSide();
  }
  /** Start playing once a movie exists (first load only; never with reduced motion or when embedded). */
  function autoplay() {
    if (!S.autoplayed && S.display?.frames.length >= 2 && !getSettings().reduceMotion && !matchMedia('(prefers-reduced-motion: reduce)').matches && !req.embed) { S.autoplayed = true; play(); }
  }
  const flagMode = () => (req.ov.includes('flags') ? 'field' : getSettings().mask ? 'target' : false);

  function setLoad(text, f) {
    const m = loading.querySelector('#loadmsg'); if (m) m.textContent = text;
    const b = loading.querySelector('#loadbar'); if (b) b.style.width = `${Math.round(f * 100)}%`;
  }
  function updateStatus(done, total, m, final) {
    const per = estimateBytesPerExposure(req.fov, flagMode(), effectiveReadMode());
    const ms = m?.ms || performance.now() - S.t0;
    const rate = S.bytes && ms ? S.bytes / (ms / 1000) : null;
    const remaining = Math.max(0, total - done);
    const eta = rate ? (remaining * per) / rate * 1000 : null;
    statusLine.replaceChildren();
    if (final && S.moreAvailable > 0) statusLine.append(h('button', { class: 'btn small', style: { marginRight: '8px' }, onclick: () => { S.extraImages = (S.extraImages || 0) + Math.max(60, getSettings().maxImages || 60); stream(S.loadId); } }, `Load ${Math.min(S.moreAvailable, Math.max(60, getSettings().maxImages || 60))} more images`), h('button', { class: 'btn small ghost', style: { marginRight: '8px' }, onclick: () => { S.extraImages = Infinity; stream(S.loadId); } }, `all ${S.moreAvailable + total}`));
    statusLine.append(`${done}/${total} exposures loaded${S.moreAvailable > 0 ? ` (of ${S.moreAvailable + total} available)` : ''}${S.skipped ? ` (${S.skipped} skipped: outside field or unreadable)` : ''} · ${fmtBytes(S.bytes)} transferred${rate ? ` at ${fmtBytes(rate)}/s` : ''}${!final && eta ? ` · about ${fmtDur(eta)} left` : ''} · source: ${S.search?.source === 'pack' ? `pre-cut SPHEREx frames (made ${niceDateTime(new Date(S.search.ts))})` : S.search?.source === 'live' ? (S.search.via === 'index' ? `IRSA image index (${S.search.indexBuilt ? `updated ${niceDateTime(S.search.indexBuilt)}` : 'pre-built'})` : 'IRSA live') : S.search?.source || '…'}${S.search?.source === 'live' || S.search?.source === 'pack' ? '' : ' (not live)'}`);
  }

  // ------------------------------------------------------------------ display building
  function selectedFrames() {
    const list = [];
    let whereAst = null;
    S.whereError = null;
    if (req.where) { try { whereAst = parseExpr(req.where); } catch (e) { S.whereError = e.message; } }
    for (const f of S.frames.values()) {
      if (!req.dets.includes(f.meta.detector)) continue;
      if (req.wl && f.meta.wavelength != null && (f.meta.wavelength < req.wl[0] || f.meta.wavelength > req.wl[1])) continue;
      if (whereAst) {
        try { if (!evalScalar(whereAst, exposureEnv(f))) continue; } catch (e) { S.whereError = e.message; whereAst = null; }
      }
      list.push(f);
    }
    return list;
  }
  /** Names usable in "where" selections. */
  function exposureEnv(f) {
    const p = f.phot;
    return {
      t: f.meta.mjd, mjd: f.meta.mjd, year: mjdToYear(f.meta.mjd), wl: f.meta.wavelength ?? NaN, det: f.meta.detector,
      release: String(f.meta.release || '').toLowerCase(), qa: f.meta.header?.L2DQAFLG || '',
      flag: p ? p.flags & BAD_MASK : 0, bad: p && p.nap ? p.nbad / p.nap : 0, saturated: f.meta.saturated ? 1 : 0,
      flux: p ? p.flux : NaN, snr: p && p.err ? p.flux / p.err : NaN,
    };
  }

  function rebuild() {
    if (!S.grid) return;
    const N = n();
    const exps = selectedFrames();
    const groups = groupExposures(exps, req.group);
    const frames = [];
    if (!groups.length) { S.display = { frames: [], groups: [], lims: [0, 1] }; draw(); updateTimeline(); return; }
    const dmaps = groups.map((gr) => perDetector(gr, N));
    if (req.mode === 'expr' && req.expr) {
      S.exprError = null;
      let ast = null;
      try { ast = parseExpr(req.expr); } catch (e) { S.exprError = e.message; }
      const exprFrames = [];
      if (ast) {
        for (let i = 0; i < groups.length; i++) {
          try {
            const r = evalImage(ast, {
              n: N, vars: { pi: Math.PI },
              D: (d) => dmaps[i].get(d) || null,
              epoch: (k) => (k >= 1 && k <= groups.length ? detectorBalanced(dmaps[k - 1], N) : null),
              wl: (a, b) => { const sel = groups[i].filter((e) => e.meta.wavelength >= Math.min(a, b) && e.meta.wavelength <= Math.max(a, b)); return sel.length ? coadd(sel, N) : null; },
              all: () => detectorBalanced(dmaps[i], N),
            });
            exprFrames.push({ data: r.data, group: groups[i], note: `= ${req.expr}${r.missing ? ` (no data for ${r.missing} in this epoch)` : ''}` });
          } catch (e) { S.exprError = e.message; break; }
        }
      }
      if (exprFrames.length) {
        const vals = []; for (const f of exprFrames) for (let k = 0; k < f.data.length; k += 7) if (Number.isFinite(f.data[k])) vals.push(f.data[k]);
        vals.sort((a, b) => a - b);
        const signed = vals.length && vals[Math.floor(vals.length * 0.02)] < -0.25 * Math.abs(vals[Math.floor(vals.length * 0.98)]);
        S.display = { frames: exprFrames, groups, lims: limits(exprFrames.map((f) => f.data), req.lo, req.hi, signed), kind: signed ? 'diff' : 'mono', dmaps };
        if (S.frame >= exprFrames.length) S.frame = exprFrames.length - 1;
        updateTimeline(); draw();
        return;
      }
    }
    if (req.mode === 'color') {
      for (let i = 0; i < groups.length; i++) {
        frames.push({ rgb: [detectorBalanced(dmaps[i], N, [5, 6]), detectorBalanced(dmaps[i], N, [3, 4]), detectorBalanced(dmaps[i], N, [1, 2])], group: groups[i] });
      }
      const lims = [0, 1, 2].map((c) => limits(frames.map((f) => f.rgb[c]), req.lo, req.hi));
      S.display = { frames, groups, lims, kind: 'rgb' };
    } else if (req.mode === 'diff') {
      for (let i = 0; i < groups.length; i++) {
        let ref, label;
        if (req.diff === 'first') { ref = dmaps[0]; label = 'minus first epoch'; }
        else if (req.diff === 'prev') { ref = dmaps[Math.max(0, i - 1)]; label = 'minus previous epoch'; }
        else { const others = dmaps.filter((_, k) => k !== i); ref = others.length ? (groups.length > 40 ? meanOfMaps(dmaps, N) : meanOfMaps(others, N)) : dmaps[i]; label = 'minus mean of the other epochs'; }
        const d = matchedDifference(dmaps[i], ref, N);
        frames.push({ data: d.data, group: groups[i], note: `${label} (wavelength-matched over ${d.dets.map((x) => 'D' + x).join(', ') || 'no common detectors'})` });
      }
      S.display = { frames, groups, lims: limits(frames.map((f) => f.data), req.lo, req.hi, true), kind: 'diff' };
    } else if (req.mode === 'stack' && req.target.eph) {
      // shift-and-stack of a followed object: every exposure is centred on it; a robust (clipped) average per
      // detector rejects the trails of background stars, which cross any pixel in only a few exposures
      const stackMaps = []; const sofar = [];
      for (let i = 0; i < groups.length; i++) {
        sofar.push(...groups[i]);
        const by = new Map();
        for (const e of sofar) { if (!by.has(e.meta.detector)) by.set(e.meta.detector, []); by.get(e.meta.detector).push(e); }
        const dm = new Map(); for (const [det, list] of by) dm.set(det, clippedCoadd(list, N));
        frames.push({ data: detectorBalanced(dm, N), group: groups[i], note: `shift-and-stack of epochs 1–${i + 1} (${sofar.length} exposures, star trails rejected)`, stackCount: sofar.length });
        stackMaps.push(dm);
      }
      S.display = { frames, groups, lims: limits([frames[frames.length - 1].data], req.lo, req.hi), kind: 'mono', stackMaps };
    } else if (req.mode === 'stack') {
      // running weighted sums per detector: each exposure is added once (the result equals perDetector(all so far))
      const run = new Map(); let count = 0; const stackMaps = [];
      for (let i = 0; i < groups.length; i++) {
        for (const e of groups[i]) {
          const det = e.meta.detector;
          if (!run.has(det)) run.set(det, { sum: new Float64Array(N * N), w: new Float64Array(N * N) });
          const r = run.get(det), wt = 1 / Math.max(1e-12, e.meta.sigma) ** 2, bg = e.meta.bg || 0, d = e.data;
          for (let k = 0; k < d.length; k++) { const v = d[k]; if (Number.isFinite(v)) { r.sum[k] += (v - bg) * wt; r.w[k] += wt; } }
          count++;
        }
        const dm = new Map();
        for (const [det, r] of run) { const o = new Float32Array(N * N); for (let k = 0; k < o.length; k++) o[k] = r.w[k] ? r.sum[k] / r.w[k] : NaN; dm.set(det, o); }
        frames.push({ data: detectorBalanced(dm, N), group: groups[i], note: `stack of epochs 1–${i + 1} (${count} exposures)`, stackCount: count });
        stackMaps.push(dm);
      }
      S.display = { frames, groups, lims: limits([frames[frames.length - 1].data], req.lo, req.hi), kind: 'mono', stackMaps };
    } else {
      for (let i = 0; i < groups.length; i++) frames.push({ data: detectorBalanced(dmaps[i], N), group: groups[i] });
      S.display = { frames, groups, lims: limits(frames.map((f) => f.data), req.lo, req.hi), kind: 'mono' };
    }
    S.display.dmaps = dmaps;
    if (S.frame >= frames.length) S.frame = frames.length - 1;
    if (req.mode === 'blink') {
      const [a, b] = req.blink && req.blink[0] < frames.length && req.blink[1] < frames.length ? req.blink : [0, frames.length - 1];
      S.display.blink = [a, b];
    }
    updateTimeline();
    draw();
  }

  // ------------------------------------------------------------------ drawing
  const off = document.createElement('canvas');
  function currentIndex() {
    const D = S.display;
    if (!D?.frames.length) return -1;
    if (req.mode === 'blink' && D.blink) return D.blink[S.blinkPhase % 2];
    return Math.max(0, Math.min(D.frames.length - 1, S.frame));
  }
  let stageWidth = 0; // measured on resize only: reading layout on every frame is slow on phones
  function sizeCanvases() {
    if (!stageWidth) stageWidth = stage.getBoundingClientRect().width;
    const r = { width: stageWidth };
    const dpr = Math.min(3, devicePixelRatio || 1);
    const W = Math.max(50, Math.round(r.width * dpr));
    for (const c of [imgCanvas, ovCanvas]) if (c.width !== W) { c.width = W; c.height = W; }
    return W;
  }
  function draw() {
    const W = sizeCanvases();
    const ctx = imgCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, W, W);
    const D = S.display, i = currentIndex();
    if (!D || i < 0) { drawOverlay(); updateHud(); return; }
    const N = n();
    const octx = off.getContext('2d');
    const im = new ImageData(N, N);
    const fr = D.frames[i];
    if (userShown()) paint(S.userLayer.data, im.data, S.userLims, { stretch: req.stretch, cmap: 'gray', invert: req.invert });
    else if (D.kind === 'rgb') paintRGB(fr.rgb, im.data, D.lims, { stretch: req.stretch, invert: req.invert });
    else if (D.kind === 'diff') paintDiff(fr.data, im.data, D.lims, { invert: req.invert });
    else paint(fr.data, im.data, D.lims, { stretch: req.stretch, cmap: cmapFor(fr), invert: req.invert });
    if (req.ov.includes('flags')) tintFlags(fr.group, im.data, N);
    const k = W / N;
    if (S.rawPixels) {
      if (off.width !== N) { off.width = N; off.height = N; }
      octx.putImageData(im, 0, 0);
      ctx.imageSmoothingEnabled = false;
      ctx.setTransform(k * S.view.s, 0, 0, k * S.view.s, S.view.tx * W, S.view.ty * W);
      ctx.drawImage(off, 0, 0);
    } else {
      // natural look: bicubic upsampling for display only (measurements use original pixels)
      const f = Math.max(1, Math.min(4, Math.round(Math.min(720, W * S.view.s) / N)));
      const up = upsampleRGBA(im.data, N, f);
      if (off.width !== up.size) { off.width = up.size; off.height = up.size; }
      octx.putImageData(new ImageData(up.data, up.size, up.size), 0, 0);
      ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
      ctx.setTransform((k * S.view.s) / f, 0, 0, (k * S.view.s) / f, S.view.tx * W, S.view.ty * W);
      ctx.drawImage(off, 0, 0);
    }
    drawOverlay();
    updateHud();
    updateLabel();
  }
  /** 'auto' colour map: tint each frame by the detector arrays (wavelengths) it contains. */
  function cmapFor(fr) {
    if (req.cmap !== 'auto') return req.cmap;
    return tintName(fr?.group ? [...new Set(fr.group.map((e) => e.meta.detector))] : req.dets);
  }
  function tintFlags(group, px, N) {
    const or = new Int32Array(N * N);
    for (const e of group) if (e.flags) for (let k = 0; k < or.length; k++) or[k] |= e.flags[k];
    for (let k = 0; k < or.length; k++) {
      if (or[k] & BAD_MASK) { px[k * 4] = Math.min(255, px[k * 4] * 0.5 + 140); px[k * 4 + 1] *= 0.5; px[k * 4 + 2] *= 0.5; }
    }
  }
  // grid coords -> canvas pixels
  const toCanvas = (gi, gj, W) => { const k = W / n(); return [(gi + 0.5) * k * S.view.s + S.view.tx * W, (gj + 0.5) * k * S.view.s + S.view.ty * W]; };
  const toGrid = (cx, cy, W) => { const k = W / n(); return [(cx - S.view.tx * W) / (k * S.view.s) - 0.5, (cy - S.view.ty * W) / (k * S.view.s) - 0.5]; };
  function frameMjd(i = currentIndex()) {
    const fr = S.display?.frames[i];
    if (!fr) return null;
    const ms = fr.group.map((e) => e.meta.mjd);
    return ms.reduce((a, b) => a + b, 0) / ms.length;
  }
  function frameCenter(i = currentIndex()) {
    if (req.target.eph && S.eph) { const p = interpEph(S.eph, frameMjd(i)); return p ? [p.ra, p.dec] : [req.target.ra, req.target.dec]; }
    if (!req.track || !(req.target.pmra || req.target.pmdec || req.target.plx)) return [req.target.ra, req.target.dec];
    const p = apparent(req.target.ra, req.target.dec, req.target.pmra, req.target.pmdec, req.target.plx, req.target.refEpoch || 2016, frameMjd(i));
    return [p.ra, p.dec];
  }
  function drawOverlay() {
    // on a negative (white) background the overlays use darker versions of the same colours
    const ink = (light, dark) => (req.invert ? dark : light);
    const W = ovCanvas.width;
    const ctx = ovCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, W);
    if (!S.grid) return;
    const dpr = Math.min(3, devicePixelRatio || 1);
    const [cra, cdec] = frameCenter();
    const G = (ra, dec) => { const [gi, gj] = worldToGrid(S.grid, ra, dec, cra, cdec); return toCanvas(gi, gj, W); };
    const mjd = frameMjd();
    const yr = mjd ? mjdToYear(mjd) : 2026;
    ctx.lineWidth = 1.5 * dpr;
    // Gaia DR3 (propagated to the frame epoch)
    if (req.ov.includes('gaia') && S.cats.gaia) {
      // only the brightest stars in view (more as you zoom in), drawn thin so the SPHEREx image stays visible
      const limit = Math.round(60 * S.view.s);
      const visible = [];
      for (const s of S.cats.gaia.rows) {
        const p = apparent(s.ra, s.dec, s.pmra || 0, s.pmdec || 0, s.parallax > 0 ? s.parallax : 0, s.ref_epoch || 2016, mjd || 61000);
        const [x, y] = G(p.ra, p.dec);
        if (x < 0 || y < 0 || x > W || y > W) continue;
        visible.push({ s, p, x, y, important: !!s.label || Math.hypot(s.pmra || 0, s.pmdec || 0) > 300 });
      }
      visible.sort((a, b) => (b.important - a.important) || ((a.s.phot_g_mean_mag ?? 99) - (b.s.phot_g_mean_mag ?? 99)));
      ctx.lineWidth = 1 * dpr;
      for (const { s, p, x, y, important } of visible.slice(0, limit)) {
        ctx.strokeStyle = important ? ink('#5ec8ff', '#0069a8') : ink('#5ec8ff66', '#0069a8b0'); ctx.fillStyle = ink('#9fe0ff', '#00517f');
        const r = Math.max(2.5, 8 - (s.phot_g_mean_mag || 18) * 0.32) * dpr * Math.sqrt(S.view.s);
        ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.stroke();
        const pm = Math.hypot(s.pmra || 0, s.pmdec || 0);
        if (pm > 100) { // draw the motion over 5 years as an arrow
          const q = propagate(p.ra, p.dec, s.pmra, s.pmdec, yr, yr + 5);
          const [x2, y2] = G(q.ra, q.dec);
          arrow(ctx, x, y, x2, y2, ink('#5ec8ff', '#0069a8'), dpr);
        }
        if (s.label) { ctx.font = `${11 * dpr}px system-ui`; ctx.fillText(s.label, x + r + 3 * dpr, y - r); }
      }
    }
    if (req.ov.includes('wise') && S.cats.wise) {
      ctx.strokeStyle = ink('#ffb547cc', '#b85500cc');
      for (const s of S.cats.wise.rows) {
        const ep = s.meanobsmjd ? mjdToYear(s.meanobsmjd) : 2010.5;
        const p = propagate(s.ra, s.dec, (s.pmra || 0) * (s.meanobsmjd ? 1000 : 1), (s.pmdec || 0) * (s.meanobsmjd ? 1000 : 1), ep, yr);
        const [x, y] = G(p.ra, p.dec);
        if (x < -10 || y < -10 || x > W + 10 || y > W + 10) continue;
        const r = 4.5 * dpr * Math.sqrt(S.view.s);
        ctx.strokeRect(x - r, y - r, 2 * r, 2 * r);
      }
    }
    // predicted target track from its proper motion
    if (req.ov.includes('track') && (req.target.pmra || req.target.pmdec || req.target.plx) && S.display?.frames.length) {
      const ms = S.display.frames.map((_, i) => frameMjd(i)).filter(Boolean);
      const t0 = Math.min(...ms), t1 = Math.max(...ms);
      const P = (m) => apparent(req.target.ra, req.target.dec, req.target.pmra, req.target.pmdec, req.target.plx, req.target.refEpoch || 2016, m);
      ctx.strokeStyle = ink('#ffcf7a', '#a86b00'); ctx.setLineDash([5 * dpr, 4 * dpr]);
      ctx.beginPath();
      for (let k = 0; k <= 20; k++) { const p = P(t0 + ((t1 - t0) * k) / 20); const [x, y] = G(p.ra, p.dec); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
      ctx.stroke(); ctx.setLineDash([]);
      for (const m of ms) { const p = P(m); const [x, y] = G(p.ra, p.dec); ctx.fillStyle = ink('#ffcf7a66', '#a86b0066'); ctx.beginPath(); ctx.arc(x, y, 2.2 * dpr, 0, 7); ctx.fill(); }
      const p = P(mjd); const [x, y] = G(p.ra, p.dec);
      crosshair(ctx, x, y, 9 * dpr * Math.sqrt(S.view.s), ink('#ffcf7a', '#a86b00'), dpr);
    } else {
      const [x, y] = G(req.target.ra, req.target.dec);
      crosshair(ctx, x, y, 9 * dpr * Math.sqrt(S.view.s), ink('#ffcf7a', '#a86b00'), dpr);
    }
    // mover candidates
    if (S.movers?.length) {
      for (const m of S.movers) {
        const [x1, y1] = toCanvas(m.a[0], m.a[1], W), [x2, y2] = toCanvas(m.b[0], m.b[1], W);
        arrow(ctx, x1, y1, x2, y2, ink('#ff6fb1', '#b3005e'), dpr);
      }
    }
    if (S.variables?.length) {
      ctx.strokeStyle = ink('#3ddc97', '#0f7a4c');
      for (const v of S.variables) { const [x, y] = toCanvas(v.at[0], v.at[1], W); ctx.beginPath(); ctx.arc(x, y, 12 * dpr, 0, 7); ctx.stroke(); }
    }
    if (S.selected) {
      const [x, y] = G(S.selected.ra, S.selected.dec);
      ctx.strokeStyle = ink('#ffffff', '#111111'); ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.arc(x, y, 14 * dpr, 0, 7); ctx.stroke();
    }
    // ruler
    if (S.ruler) {
      const { a, b } = S.ruler;
      const [x1, y1] = toCanvas(a[0], a[1], W), [x2, y2] = toCanvas(b[0], b[1], W);
      ctx.strokeStyle = ink('#ffffff', '#111111'); ctx.lineWidth = 2 * dpr; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      const wa = gridToWorld(S.grid, a[0], a[1], cra, cdec), wb = gridToWorld(S.grid, b[0], b[1], cra, cdec);
      const d = separation(wa[0], wa[1], wb[0], wb[1]) * 3600;
      ctx.font = `600 ${13 * dpr}px system-ui`; ctx.fillStyle = ink('#fff', '#111');
      ctx.fillText(d >= 120 ? `${(d / 60).toFixed(2)}′` : `${d.toFixed(1)}″`, (x1 + x2) / 2 + 6 * dpr, (y1 + y2) / 2 - 6 * dpr);
    }
    // compass + scale bar
    if (req.ov.includes('compass')) {
      const x0 = W - 52 * dpr, y0 = W - 52 * dpr, L = 30 * dpr;
      ctx.strokeStyle = ink('#fff', '#111'); ctx.fillStyle = ink('#fff', '#111'); ctx.lineWidth = 2 * dpr;
      arrow(ctx, x0, y0, x0, y0 - L, ink('#ffffff', '#111111'), dpr); arrow(ctx, x0, y0, x0 - L, y0, ink('#ffffff', '#111111'), dpr);
      ctx.font = `600 ${12 * dpr}px system-ui`; ctx.fillText('N', x0 - 4 * dpr, y0 - L - 6 * dpr); ctx.fillText('E', x0 - L - 14 * dpr, y0 + 4 * dpr);
      const arcsecPerPx = S.grid.scale / ((W / n()) * S.view.s);
      const targetArcsec = [10, 30, 60, 120, 300, 600, 1200].find((a) => a / arcsecPerPx > 50 * dpr) || 1200;
      const len = targetArcsec / arcsecPerPx;
      ctx.fillRect(16 * dpr, W - 22 * dpr, len, 3 * dpr);
      ctx.fillText(targetArcsec >= 60 ? `${targetArcsec / 60}′` : `${targetArcsec}″`, 16 * dpr, W - 28 * dpr);
    }
  }
  function crosshair(ctx, x, y, r, c, dpr) {
    ctx.strokeStyle = c; ctx.lineWidth = 2 * dpr;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { ctx.beginPath(); ctx.moveTo(x + dx * r * 0.6, y + dy * r * 0.6); ctx.lineTo(x + dx * r * 1.6, y + dy * r * 1.6); ctx.stroke(); }
  }
  function arrow(ctx, x1, y1, x2, y2, c, dpr) {
    ctx.strokeStyle = c; ctx.fillStyle = c; ctx.lineWidth = 1.8 * dpr;
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    const a = Math.atan2(y2 - y1, x2 - x1), s = 6 * dpr;
    ctx.beginPath(); ctx.moveTo(x2, y2); ctx.lineTo(x2 - s * Math.cos(a - 0.45), y2 - s * Math.sin(a - 0.45)); ctx.lineTo(x2 - s * Math.cos(a + 0.45), y2 - s * Math.sin(a + 0.45)); ctx.fill();
  }

  function updateHud() {
    const D = S.display, i = currentIndex();
    hud.replaceChildren();
    if (userShown()) {
      hud.append(h('span', { class: 'chip good' }, 'Your image'), h('span', { class: 'chip' }, S.userLayer.label), S.userLayer.mjd ? h('span', { class: 'chip' }, niceDate(S.userLayer.mjd)) : null, h('span', { class: 'chip' }, 'not SPHEREx data'));
      return;
    }
    if (!D || i < 0) return;
    const fr = D.frames[i];
    const dets = [...new Set(fr.group.map((e) => e.meta.detector))].sort();
    const wls = fr.group.map((e) => e.meta.wavelength).filter(Number.isFinite);
    hud.append(
      h('span', { class: 'chip' }, req.mode === 'blink' ? (S.blinkPhase % 2 ? 'B · later' : 'A · earlier') : `Frame ${i + 1}/${D.frames.length}`),
      h('span', { class: 'chip' }, (req.group === 'exposure' ? niceDateTime(frameMjd(i)) : niceDate(frameMjd(i)))),
      h('span', { class: 'chip' }, dets.map((d) => 'D' + d).join(' ')),
      wls.length ? h('span', { class: 'chip' }, wls.length === 1 ? `λ ${wls[0].toFixed(3)} µm` : `λ ${Math.min(...wls).toFixed(2)}–${Math.max(...wls).toFixed(2)} µm`) : null,
      h('span', { class: 'chip' }, `${fr.group.length} exp.`),
      fr.group.some((e) => e.meta.saturated) ? h('span', { class: 'chip warn', title: 'The target core is saturated (no valid pixels): shown in dark purple' }, 'saturated core') : null,
      fr.group.some((e) => e.meta.header?.L2DQAFLG && e.meta.header.L2DQAFLG !== 'Pass') ? h('span', { class: 'chip bad' }, 'quality check failed') : null,
    );
  }
  function updateLabel() {
    const D = S.display, i = currentIndex();
    if (!D || i < 0) { frameLabel.textContent = ''; return; }
    const fr = D.frames[i];
    const ms = fr.group.map((e) => e.meta.mjd);
    const rel = [...new Set(fr.group.map((e) => e.meta.release.toUpperCase()))].join(', ');
    frameLabel.textContent = `${MODE_INFO[req.mode][0]} · ${req.group === 'survey' ? 'six-month survey co-add' : req.group === 'day' ? 'one-day co-add' : 'single exposure'} · ${niceDate(Math.min(...ms))}${ms.length > 1 ? ` to ${niceDate(Math.max(...ms))}` : ''} (MJD ${Math.min(...ms).toFixed(2)}) · ${rel}${fr.note ? ' · ' + fr.note : ''}`;
  }
  function updateTimeline() {
    const D = S.display;
    const N = D?.frames.length || 0;
    slider.max = Math.max(0, N - 1);
    slider.value = S.frame;
    slider.disabled = N < 2 || req.mode === 'blink';
    ticks.replaceChildren();
    if (!N) return;
    const ms = D.frames.map((_, i) => frameMjd(i));
    const t0 = Math.min(...ms), t1 = Math.max(...ms);
    ms.forEach((m, i) => ticks.append(h('i', { class: i === S.frame ? 'cur' : '', style: { left: `${t1 > t0 ? ((m - t0) / (t1 - t0)) * 100 : 50}%` }, title: niceDate(m) })));
  }

  // ------------------------------------------------------------------ playback
  function step(d) {
    const N = S.display?.frames.length || 0;
    if (!N) return;
    if (req.mode === 'blink') S.blinkPhase++;
    else S.frame = (S.frame + d + N) % N;
    slider.value = S.frame;
    [...ticks.children].forEach((t, i) => t.classList.toggle('cur', i === S.frame));
    draw();
    if (S.tab === 'frame') renderSide();
  }
  function play() {
    if (S.playing) return;
    S.playing = true; playBtn.replaceChildren(icon('pause')); playBtn.setAttribute('aria-label', 'Pause');
    const tick = () => { step(1); S.timer = setTimeout(tick, req.speed); };
    S.timer = setTimeout(tick, req.speed);
  }
  function stopPlay() { S.playing = false; clearTimeout(S.timer); playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', 'Play'); }
  playBtn.addEventListener('click', () => (S.playing ? stopPlay() : play()));
  slider.addEventListener('input', () => { S.frame = Number(slider.value); draw(); [...ticks.children].forEach((t, i) => t.classList.toggle('cur', i === S.frame)); });
  slider.addEventListener('change', () => { history.replaceState(history.state, '', `#/view?${toParams(normalise({ ...req, t: S.frame }))}`); if (S.tab === 'frame') renderSide(); });
  speedSel.addEventListener('change', () => commit({ speed: Number(speedSel.value) }));

  // ------------------------------------------------------------------ pointer: hover, click, pan, zoom, ruler
  const pointers = new Map();
  let drag = null, pinch = null;
  function zoom(f, cx = 0.5, cy = 0.5) {
    const s0 = S.view.s, s1 = Math.min(12, Math.max(1, s0 * f));
    S.view.tx = cx - ((cx - S.view.tx) * s1) / s0; S.view.ty = cy - ((cy - S.view.ty) * s1) / s0; S.view.s = s1;
    if (s1 === 1) { S.view.tx = 0; S.view.ty = 0; }
    draw();
  }
  stage.addEventListener('wheel', (e) => { e.preventDefault(); const r = stage.getBoundingClientRect(); zoom(e.deltaY < 0 ? 1.18 : 1 / 1.18, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }, { passive: false });
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const r = stage.getBoundingClientRect();
    if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: S.view.s }; drag = null; return; }
    const W = ovCanvas.width, k = W / r.width;
    const gpt = toGrid((e.clientX - r.left) * k, (e.clientY - r.top) * k, W);
    if (S.tool === 'ruler') { S.ruler = { a: gpt, b: gpt }; drag = { ruler: true }; return; }
    drag = { x: e.clientX, y: e.clientY, tx: S.view.tx, ty: S.view.ty, moved: false, gpt };
  });
  stage.addEventListener('pointermove', (e) => {
    const r = stage.getBoundingClientRect();
    if (pointers.has(e.pointerId)) pointers.set(e.pointerId, [e.clientX, e.clientY]);
    if (pinch && pointers.size === 2) { const [a, b] = [...pointers.values()]; const d = Math.hypot(a[0] - b[0], a[1] - b[1]); zoom((pinch.s * d) / pinch.d / S.view.s); return; }
    const W = ovCanvas.width, k = W / r.width;
    const gpt = toGrid((e.clientX - r.left) * k, (e.clientY - r.top) * k, W);
    if (drag?.ruler) { S.ruler.b = gpt; drawOverlay(); return; }
    if (drag) {
      const dx = (e.clientX - drag.x) / r.width, dy = (e.clientY - drag.y) / r.height;
      if (Math.abs(dx) + Math.abs(dy) > 0.01) drag.moved = true;
      if (drag.moved && S.view.s > 1) { S.view.tx = drag.tx + dx; S.view.ty = drag.ty + dy; draw(); }
    }
    showReadout(gpt);
  });
  const endPtr = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (drag && !drag.moved && !drag.ruler && e.type === 'pointerup') onClick(drag.gpt);
    drag = null;
  };
  stage.addEventListener('pointerup', endPtr);
  stage.addEventListener('pointercancel', endPtr);
  stage.addEventListener('pointerleave', () => { readout.hidden = true; });
  stage.addEventListener('dblclick', () => { S.view = { s: 1, tx: 0, ty: 0 }; draw(); });

  function showReadout([gi, gj]) {
    if (!S.grid || !S.display?.frames.length) return;
    const N = n(), i = currentIndex();
    const [cra, cdec] = frameCenter();
    const [ra, dec] = gridToWorld(S.grid, gi, gj, cra, cdec);
    const ii = Math.round(gi), jj = Math.round(gj);
    let val = '', fl = '';
    if (ii >= 0 && jj >= 0 && ii < N && jj < N) {
      const fr = S.display.frames[i];
      const v = fr.data ? fr.data[jj * N + ii] : null;
      if (v != null) val = Number.isFinite(v) ? `${v.toFixed(3)} MJy/sr` : 'no valid data (saturated or masked)';
      if (fr.rgb) val = fr.rgb.map((c, k) => `${'RGB'[k]} ${Number.isFinite(c[jj * N + ii]) ? c[jj * N + ii].toFixed(2) : '–'}`).join('  ');
      let or = 0; for (const e of fr.group) if (e.flags) or |= e.flags[jj * N + ii];
      fl = or ? `  flags: ${decodeFlags(or).join(', ')}` : '';
    }
    readout.hidden = false;
    const best = S.display.dmaps?.[i] ? bandsAt(ra, dec).filter((b) => b.ab && !b.bad && b.ab.err != null && b.ab.err < 0.3) : [];
    const mag = best.length ? `  ${best.map((b) => `D${b.det} ${b.ab.mag.toFixed(1)}`).join(' ')} AB` : '';
    readout.textContent = `${formatRA(ra)} ${formatDec(dec)} (J2000.0)  ${val}${mag}${fl}`;
  }

  function onClick([gi, gj]) {
    if (!S.grid) return;
    stopPlay(); // the measurements in the Object tab describe the frame on screen, so it stays there
    const [cra, cdec] = frameCenter();
    const [ra, dec] = gridToWorld(S.grid, gi, gj, cra, cdec);
    // nearest catalogue object within 2 grid px
    let best = null;
    const yr = mjdToYear(frameMjd() || 61000);
    const consider = (s, cat) => {
      const m = frameMjd() || 61000;
      const p = cat === 'gaia'
        ? apparent(s.ra, s.dec, s.pmra || 0, s.pmdec || 0, s.parallax > 0 ? s.parallax : 0, s.ref_epoch || 2016, m)
        : propagate(s.ra, s.dec, (s.pmra || 0) * (s.meanobsmjd ? 1000 : 1), (s.pmdec || 0) * (s.meanobsmjd ? 1000 : 1), s.meanobsmjd ? mjdToYear(s.meanobsmjd) : 2010.5, mjdToYear(m));
      const d = separation(ra, dec, p.ra, p.dec) * 3600;
      if (d < 2.2 * S.grid.scale && (!best || d < best.d)) best = { d, s, cat, ra: p.ra, dec: p.dec };
    };
    // known fast movers and labelled objects near the click win over faint neighbours
    const yr2 = mjdToYear(frameMjd() || 61000);
    let notable = null;
    for (const s of S.cats.gaia?.rows || []) {
      if (!(s.label || Math.hypot(s.pmra || 0, s.pmdec || 0) > 300)) continue;
      const p = apparent(s.ra, s.dec, s.pmra || 0, s.pmdec || 0, s.parallax > 0 ? s.parallax : 0, s.ref_epoch || 2016, frameMjd() || 61000);
      const d = separation(ra, dec, p.ra, p.dec) * 3600;
      if (d < 3.5 * S.grid.scale && (!notable || d < notable.d)) notable = { d, s, cat: 'gaia', ra: p.ra, dec: p.dec };
    }
    if (notable) best = notable;
    if (!best && req.ov.includes('gaia')) S.cats.gaia?.rows.forEach((s) => consider(s, 'gaia'));
    if (!best && req.ov.includes('wise')) S.cats.wise?.rows.forEach((s) => consider(s, 'wise'));
    S.selected = best ? { ra: best.ra, dec: best.dec, obj: best.s, cat: best.cat } : { ra, dec };
    drawOverlay();
    S.tab = 'object'; renderTabs(); renderSide();
  }

  // ------------------------------------------------------------------ keyboard
  const onKey = (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    // shortcuts apply only when focus is on the page or the image, never on a control or inside a dialog
    const t = e.target;
    if (t.closest?.('input, textarea, select, button, a, summary, [role=button], [role=tab], [contenteditable], .sheet, .tour, [role=dialog]') && !t.closest?.('.stage')) return;
    if (getSettings().noShortcuts) return;
    const k = e.key;
    if (k === ' ') { e.preventDefault(); S.playing ? stopPlay() : play(); }
    else if (k === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (k === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (/^[1-6]$/.test(k) && (MODES[Number(k) - 1] !== 'expr' || req.expr)) commit({ mode: MODES[Number(k) - 1] });
    else if (k === 'f') toggleOv('flags');
    else if (k === 'g') toggleOv('gaia');
    else if (k === 'w') toggleOv('wise');
    else if (k === 'i') negBtn.click();
    else if (k === '+' || k === '=') zoom(1.4);
    else if (k === '-') zoom(1 / 1.4);
    else if (k === 'r') { S.view = { s: 1, tx: 0, ty: 0 }; draw(); }
    else if (k === '?') explainBtn.click();
  };
  document.addEventListener('keydown', onKey);
  function toggleOv(o) {
    const on = !req.ov.includes(o);
    commit({ ov: on ? [...req.ov, o] : req.ov.filter((x) => x !== o) });
    if (on) ensureCats();
  }

  // ------------------------------------------------------------------ catalogues
  async function ensureCats() {
    const rad = (req.fov / 60) * 0.75;
    if (!S.cats.gaia) {
      gaiaCone(req.target.ra, req.target.dec, Math.min(rad, 0.6)).then((r) => {
        const labels = preset?.labels || {};
        r.data.rows.forEach((s) => { if (labels[String(s.source_id)]) s.label = labels[String(s.source_id)]; });
        S.cats.gaia = { ...r.data, source: r.source, ts: r.ts };
        drawOverlay(); if (['object', 'context'].includes(S.tab)) renderSide();
      }).catch((e) => { S.cats.gaia = { rows: [], error: e.message }; if (S.tab === 'context') renderSide(); });
    }
    if (req.ov.includes('wise') && !S.cats.wise) {
      catwiseCone(req.target.ra, req.target.dec, Math.min(rad, 0.6)).catch(() => allwiseCone(req.target.ra, req.target.dec, Math.min(rad, 0.6))).then((r) => {
        S.cats.wise = { ...r.data, source: r.source, ts: r.ts }; drawOverlay(); if (S.tab === 'context') renderSide();
      }).catch((e) => { S.cats.wise = { rows: [], error: e.message }; if (S.tab === 'context') renderSide(); });
    }
  }

  // ------------------------------------------------------------------ side panel
  const TABS = [['display', 'Display'], ['spectrum', 'Spectrum'], ['lightcurve', 'Light curve'], ['frames', 'Frames'], ['frame', 'Flags'], ['context', 'Catalogues'], ['object', 'Object'], ['discover', 'Discover']];
  S.tab = 'display';
  function renderTabs() {
    tabsBar.replaceChildren(...TABS.map(([id, label]) => h('button', { role: 'tab', 'aria-selected': String(S.tab === id), id: `tab-${id}`, onclick: () => { S.tab = id; renderTabs(); renderSide(); } }, label)));
  }
  function renderSide() {
    // panels re-render as exposures stream in: keep open fold-outs open and the scroll position where the reader left it
    const open = new Set([...tabBody.querySelectorAll('details[open] > summary')].map((x) => x.textContent));
    const scroll = tabBody.scrollTop, sameTab = tabBody.dataset.tab === S.tab;
    // while someone is typing or choosing in this panel, refresh it only once they leave the field
    const act = document.activeElement;
    if (sameTab && act && tabBody.contains(act) && act.matches('input:not([type=button]):not([type=checkbox]):not([type=radio]), textarea, select')) {
      if (!tabBody.dataset.pending) { tabBody.dataset.pending = '1'; act.addEventListener('blur', () => { delete tabBody.dataset.pending; setTimeout(renderSide, 0); }, { once: true }); }
      return;
    }
    const keyOf = (f) => f.getAttribute('aria-label') || f.name || f.placeholder;
    const drafts = new Map([...tabBody.querySelectorAll('input[type=text], input[type=number], input:not([type]), textarea')].filter((f) => keyOf(f) && f.value !== f.defaultValue).map((f) => [keyOf(f), f.value]));
    tabBody.dataset.tab = S.tab;
    tabBody.replaceChildren();
    tabBody.setAttribute('role', 'tabpanel');
    tabBody.setAttribute('aria-labelledby', `tab-${S.tab}`);
    ({ display: sideDisplay, frames: sideFrames, spectrum: sideSpectrum, lightcurve: sideLight, frame: sideFrame, context: sideContext, object: sideObject, discover: sideDiscover }[S.tab])();
    if (sameTab) {
      tabBody.querySelectorAll('details > summary').forEach((x) => { if (open.has(x.textContent)) x.parentElement.open = true; });
      tabBody.querySelectorAll('input, textarea').forEach((f) => { const k = keyOf(f); if (k && drafts.has(k)) f.value = drafts.get(k); });
      tabBody.scrollTop = scroll;
    }
  }

  function sideDisplay() {
    const counts = {}; S.exposures.forEach((e) => { counts[e.det] = (counts[e.det] || 0) + 1; });
    const perExp = estimateBytesPerExposure(req.fov, flagMode(), effectiveReadMode());
    const nSel = S.exposures.filter((e) => req.dets.includes(e.det)).length;
    const mbps = downlinkMbps();
    const fovSel = h('select', { 'aria-label': 'Field of view', onchange: (e) => commit({ fov: Number(e.target.value) }) },
      FOV_STEPS.map((f) => {
        const total = estimateBytesPerExposure(f, flagMode(), effectiveReadMode()) * nSel;
        return h('option', { value: f, selected: Math.abs(req.fov - f) < 0.01 }, `${f >= 60 ? '1°' : f + '′'} · ≈${fmtBytes(total)}${mbps ? ` · ~${fmtDur((total * 8) / (mbps * 1e6) * 1000)}` : ''}`);
      }));
    if (!FOV_STEPS.includes(req.fov)) fovSel.prepend(h('option', { value: req.fov, selected: true }, `${+req.fov.toFixed(2)}′ (custom)`));
    tabBody.append(
      h('div', { class: 'panel' }, h('b', {}, 'Detector arrays (102 bands in 6 groups)'),
        h('p', { class: 'tiny' }, 'Each array covers a range of wavelengths; each exposure records one wavelength per position. Selecting several adds them together for a cleaner image.'),
        h('div', { class: 'dets' }, DETECTORS.map((d) => h('button', {
          class: 'det', type: 'button', style: { '--c': `var(--d${d.id})` }, 'aria-pressed': String(req.dets.includes(d.id)),
          title: `D${d.id}: ${d.range[0]}–${d.range[1]} µm, resolving power R=${d.R}. ${counts[d.id] || 0} exposures here.`,
          onclick: () => { const on = req.dets.includes(d.id); const nd = on ? req.dets.filter((x) => x !== d.id) : [...req.dets, d.id]; if (nd.length) commit({ dets: nd }, { reload: !on }); },
        }, `D${d.id}`, h('small', {}, `${d.range[0]}–${d.range[1]}`), h('small', {}, `${counts[d.id] || 0}`)))),
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', { class: 'btn small', onclick: () => commit({ dets: [1, 2, 3, 4, 5, 6], wl: null }, { reload: true }) }, 'All'),
          h('button', { class: 'btn small', title: 'Hydrogen and stellar light; atmospheric helium line at 1.083 µm', onclick: () => commit({ dets: [1, 2], wl: null }, { reload: true }) }, 'Short 0.75–1.6'),
          h('button', { class: 'btn small', title: 'Hydrogen Pa α (1.88 µm), PAH (3.3 µm)', onclick: () => commit({ dets: [3, 4], wl: null }, { reload: true }) }, 'Middle 1.6–3.8'),
          h('button', { class: 'btn small', title: 'Cold brown dwarfs are brightest here; hydrogen Br α (4.05 µm)', onclick: () => commit({ dets: [5, 6], wl: null }, { reload: true }) }, 'Long 3.8–5'))),
      h('label', { class: 'field' }, 'Wavelength window (µm, optional — keeps only exposures whose target wavelength falls inside)',
        h('div', { class: 'row' },
          h('input', { type: 'number', step: '0.01', min: 0.7, max: 5, value: req.wl?.[0] ?? '', placeholder: 'from', 'aria-label': 'From wavelength', style: { width: '90px' }, onchange: (e) => setWl(e.target.value, null) }),
          h('input', { type: 'number', step: '0.01', min: 0.7, max: 5, value: req.wl?.[1] ?? '', placeholder: 'to', 'aria-label': 'To wavelength', style: { width: '90px' }, onchange: (e) => setWl(null, e.target.value) }),
          LINES.map((l) => h('button', { class: 'btn small ghost', title: `Show only exposures within ±0.05 µm of ${l.title}`, onclick: () => commit({ wl: [+(l.x - 0.05).toFixed(3), +(l.x + 0.05).toFixed(3)], dets: DETECTORS.filter((d) => d.range[1] >= l.x - 0.05 && d.range[0] <= l.x + 0.05).map((d) => d.id) }, { reload: true }) }, l.label)))),
      h('label', { class: 'field' }, 'Frames', segment(GROUPS.map((g2) => [g2, { exposure: 'Every exposure', day: 'Per day', survey: 'Per survey (6 mo)' }[g2]]), req.group, (v) => commit({ group: v }))),
      req.mode === 'diff' ? h('label', { class: 'field' }, 'Subtract', segment([['mean', 'Mean of others'], ['first', 'First epoch'], ['prev', 'Previous']], req.diff, (v) => commit({ diff: v }))) : null,
      req.mode === 'blink' && S.display?.frames.length > 1 ? h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Blink A', blinkSel(0)), h('label', { class: 'field' }, 'Blink B', blinkSel(1))) : null,
      equationPanel(),
      h('label', { class: 'field' }, `Field of view — larger fields catch faster movers but transfer more data (${nSel} exposures, ≈${fmtBytes(perExp)} each)`, fovSel),
      h('label', { class: 'field' }, 'Stretch', segment([['asinh', 'Asinh'], ['log', 'Log'], ['sqrt', 'Sqrt'], ['linear', 'Linear']], req.stretch, (v) => commit({ stretch: v }))),
      h('div', { class: 'row' },
        slider2('lo', 'Black point', 0, 30, 0.5), slider2('hi', 'White point', 80, 100, 0.1)),
      h('div', { class: 'row' },
        h('label', { class: 'field' }, 'Colours', h('select', { onchange: (e) => commit({ cmap: e.target.value }) }, [['auto', 'By wavelength (tint of the detectors shown)'], ['gray', 'Grey (classic blink look)'], ['viridis', 'Viridis (colour-blind safe)'], ['heat', 'Heat'], ['ice', 'Ice']].map(([v, l]) => h('option', { value: v, selected: req.cmap === v }, l)))),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: req.invert, onchange: (e) => setNegative(e.target.checked) }), 'Invert (black stars on white)')),
      h('div', { class: 'panel' }, h('b', {}, 'Overlays'),
        h('div', { class: 'row' }, [['gaia', 'Gaia DR3 stars', 'Positions moved to each frame’s date using Gaia proper motions'], ['wise', 'WISE (CatWISE2020)', 'Infrared sources from WISE'], ['flags', 'Contamination flags', 'Tint pixels flagged as bad'], ['track', 'Predicted track', 'Where the target should be at each date'], ['compass', 'Compass & scale', 'North/East arrows and a scale bar']]
          .map(([o, l, t]) => h('label', { class: 'check', title: t }, h('input', { type: 'checkbox', checked: req.ov.includes(o), onchange: () => toggleOv(o) }), l)))),
      req.target.pmra || req.target.pmdec ? h('label', { class: 'check', title: 'Shift every frame along the proper motion so the target stays centred; background stars then move instead (synthetic tracking).' },
        h('input', { type: 'checkbox', checked: req.track, onchange: (e) => commit({ track: e.target.checked }) }),
        `Follow the target’s motion (${(Math.hypot(req.target.pmra, req.target.pmdec) / 1000).toFixed(2)}″/yr)`) : null,
    );
  }
  function equationPanel() {
    const ta = h('textarea', { 'aria-label': 'Equations and selections', rows: 3, placeholder: '(D5 + D6)/2 - epoch(1)\nwhere t > 2025-06-01 and flag == 0' },
      [req.expr, req.where ? `where ${req.where}` : ''].filter(Boolean).join('\n'));
    const msg = h('div', { class: 'tiny', 'aria-live': 'polite' });
    if (S.exprError || S.whereError) msg.append(h('div', { class: 'notice bad' }, S.exprError || S.whereError));
    const apply = () => {
      const st = splitStatements(ta.value);
      if (st.errors.length) { msg.replaceChildren(...st.errors.map((e) => h('pre', { class: 'notice bad mono', style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, `${e.message}\n${e.pointer}`))); return; }
      const patch = { expr: st.image || '', where: st.where || '', mode: st.image ? 'expr' : (req.mode === 'expr' ? 'movie' : req.mode) };
      const a = st.assign;
      if (a.pmra != null || a.pmdec != null || a.epoch != null) patch.target = { ...req.target, pmra: a.pmra ?? req.target.pmra ?? 0, pmdec: a.pmdec ?? req.target.pmdec ?? 0, refEpoch: a.epoch ?? req.target.refEpoch ?? 2016 };
      if (a.fov != null) patch.fov = a.fov;
      if (a.speed != null) patch.speed = a.speed;
      commit(patch, { reload: patch.target != null || patch.fov != null });
      renderModes();
    };
    return h('details', { class: 'panel', open: !!(req.expr || req.where) },
      h('summary', {}, 'Equations & selections'),
      h('div', { class: 'body' },
        h('p', { class: 'tiny' }, 'Image maths per frame: D1–D6 (that epoch’s co-add of an array), frame (all selected arrays), epoch(k) (co-add of epoch k), wl(a,b) (exposures between a and b µm), numbers, + − × ÷ ^, abs, sqrt, log10, min, max, mean, clip. Selections start with “where” and can use t (date or MJD), year, wl, det, release, qa, flag, bad, saturated, flux, snr. Motion: pmra = …; pmdec = …; epoch = … . Nothing is executed as code.'),
        ta,
        h('div', { class: 'row' }, h('button', { class: 'btn small primary', onclick: apply }, 'Apply'),
          [['Long minus short', 'mean(D5, D6) - mean(D1, D2)'], ['Latest minus first', 'frame - epoch(1)'], ['Clean only', 'where flag == 0 and saturated == 0'], ['3–4 µm', 'wl(3, 4)']].map(([l, ex]) =>
            h('button', { class: 'btn small ghost', onclick: () => { ta.value = ex; apply(); } }, l)),
          req.expr || req.where ? h('button', { class: 'btn small ghost', onclick: () => commit({ expr: '', where: '', mode: req.mode === 'expr' ? 'movie' : req.mode }) || renderModes() }, 'Clear') : null),
        msg));
  }

  /** Range control that previews while dragging (no panel rebuild) and commits when released. */
  function slider2(key, label, min, max, step) {
    const lab = h('span', {}, `${label} ${req[key]}%`);
    const inp = h('input', { type: 'range', min, max, step, value: req[key], 'aria-label': label });
    inp.addEventListener('input', () => { const v = Number(inp.value); lab.textContent = `${label} ${v}%`; req = normalise({ ...req, [key]: v }); rebuild(); });
    inp.addEventListener('change', () => { history.replaceState(history.state, '', `#/view?${toParams(req)}`); });
    return h('label', { class: 'field', style: { flex: 1 } }, lab, inp);
  }

  function setWl(a, b) {
    const cur = req.wl || [0.75, 5.0];
    const lo = a != null ? Number(a) : cur[0], hi = b != null ? Number(b) : cur[1];
    if (!a && !b) return;
    commit({ wl: Number.isFinite(lo) && Number.isFinite(hi) && lo < hi ? [lo, hi] : null });
  }
  function blinkSel(k) {
    const D = S.display;
    const cur = D.blink || [0, D.frames.length - 1];
    return h('select', { onchange: (e) => { const b = [...cur]; b[k] = Number(e.target.value); commit({ blink: b }); } },
      D.frames.map((_, i) => h('option', { value: i, selected: cur[k] === i }, `${i + 1}: ${niceDate(frameMjd(i))}`)));
  }
  function segment(opts, value, on) {
    return h('div', { class: 'seg', role: 'group' }, opts.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(value === v), onclick: () => on(v) }, l)));
  }

  // ----- photometry collection (target position, every loaded exposure)
  function photPoints() {
    const pts = [];
    for (const f of S.frames.values()) if (f.phot && Number.isFinite(f.meta.wavelength)) pts.push({ ...f.phot, wavelength: f.meta.wavelength, bandwidth: f.meta.bandwidth, mjd: f.meta.mjd, det: f.meta.detector, uri: f.meta.uri, release: f.meta.release, saturated: f.meta.saturated });
    return pts.sort((a, b) => a.mjd - b.mjd);
  }
  function epochIndex(pts) {
    const ms = [...new Set(pts.map((p) => p.mjd))].sort((a, b) => a - b);
    const ep = new Map(); let e = 0, last = null;
    for (const m of ms) { if (last != null && m - last > SURVEY_GAP_DAYS) e++; ep.set(m, e); last = m; }
    return ep;
  }

  function sideSpectrum() {
    const usingClick = !!S.clickSpec;
    const pts = usingClick ? S.clickSpec.points : photPoints();
    const ep = epochIndex(pts);
    const host = h('div', { class: 'chart-host' });
    const nEp = new Set(ep.values()).size;
    const blend = blendInfo();
    tabBody.append(
      h('p', { class: 'tiny' }, usingClick ? `Spectrum at ${formatRA(S.clickSpec.ra)} ${formatDec(S.clickSpec.dec)} (clicked position).` : `Spectrum of the target at its predicted position in every loaded exposure. Each exposure samples a different wavelength, so together they form a ${pts.length}-point spectrum.`,
        ' Hollow points are questionable: saturated core, or more than 20% of the aperture masked by contamination flags. Aperture 2.5 px (15″) radius, background from a 5–8 px annulus.'),
      blend ? h('div', { class: 'notice warn' }, blend) : null,
      host,
      h('div', { class: 'row' },
        usingClick ? h('button', { class: 'btn small', onclick: () => { S.clickSpec = null; renderSide(); } }, 'Back to target spectrum') : null,
        h('button', { class: 'btn small', onclick: () => enlarge(() => specCfg(pts, ep, nEp), 'Spectrum') }, 'Enlarge'),
        h('button', { class: 'btn small', onclick: () => download(`skyshift-spectrum-${fileStem()}.csv`, photCSV(pts), 'text/csv') }, icon('download'), 'CSV'),
        h('button', { class: 'btn small', onclick: () => { const s = host.querySelector('svg'); if (s) download(`skyshift-spectrum-${fileStem()}.svg`, svgString(s), 'image/svg+xml'); } }, icon('download'), 'SVG')),
      h('details', { class: 'panel' }, h('summary', {}, 'Molecule & line guide'),
        h('div', { class: 'body tiny' },
          h('p', {}, 'SPHEREx is built to see hydrogen, water, carbon dioxide, carbon monoxide and other molecules. Lines marked on the chart come with wavelengths stated in the IRSA SPHEREx documentation and tutorials:'),
          h('ul', {}, LINES.map((l) => h('li', {}, h('b', {}, l.label), ' — ', l.title, ' ', h('button', { class: 'btn small ghost', onclick: () => commit({ wl: [+(l.x - 0.05).toFixed(3), +(l.x + 0.05).toFixed(3)], dets: DETECTORS.filter((d) => d.range[1] >= l.x - 0.05 && d.range[0] <= l.x + 0.05).map((d) => d.id) }, { reload: true }) }, 'Image this band')))),
          h('p', {}, 'Exact wavelengths for water, CO₂ and CO ice bands were not found in the approved sources read for this version, so they are not marked (see docs/DATA_SOURCES.md). Cold brown dwarfs are faint at short wavelengths and brightest near 4–5 µm because molecules in their atmospheres absorb light at other wavelengths.'))),
    );
    scatterChart(host, specCfg(pts, ep, nEp));
  }
  function specCfg(pts, ep = epochIndex(pts), nEp = new Set(ep.values()).size) {
    return {
      title: 'Spectrum', xLabel: 'Wavelength (µm)', yLabel: 'Flux density (µJy)',
      empty: S.frames.size ? 'No valid measurements (target saturated, outside the images or masked)' : 'Spectrum appears as exposures load…',
      points: pts.map((p) => ({ x: p.wavelength, y: p.flux, err: p.err, color: EPOCH_COLORS[(ep.get(p.mjd) || 0) % EPOCH_COLORS.length], hollow: questionable(p),
        tip: `λ ${p.wavelength.toFixed(3)} µm (D${p.det})\n${p.flux.toFixed(0)} ± ${p.err.toFixed(0)} µJy\n${niceDateTime(p.mjd)}\nMJD ${p.mjd.toFixed(3)} · ${String(p.release).toUpperCase()}${p.flags ? '\nflags: ' + decodeFlags(p.flags).join(', ') : ''}`, ref: p })),
      markers: LINES,
      bands: DETECTORS.map((d) => ({ x0: d.range[0], x1: d.range[1], color: getComputedStyle(document.documentElement).getPropertyValue(`--d${d.id}`) || '#888', label: `D${d.id}`, short: `D${d.id}` })),
      xRange: [0.72, 5.03],
      legend: [...new Set(ep.values())].sort().map((e) => ({ color: EPOCH_COLORS[e % EPOCH_COLORS.length], label: `Survey pass ${e + 1}` })).concat(pts.some(questionable) ? [{ color: '#aaa', label: 'questionable', hollow: true }] : []),
      onPoint: (pt) => focusExposure(pt.ref.uri),
    };
  }
  function lcCfg(ptsR, rel) {
    return {
      title: 'Light curve', xLabel: 'Date', yLabel: rel ? 'Relative brightness' : 'Flux density (µJy)',
      xFormat: (v) => niceDate(yearToMjd(v), true), // named months, like every other date in the app
      empty: 'Light curve appears as exposures load…',
      points: ptsR.map((p) => ({ x: mjdToYear(p.mjd), y: rel ? p.rel : p.flux, err: rel ? p.relErr : p.err, color: getComputedStyle(document.documentElement).getPropertyValue(`--d${p.det}`).trim() || '#ccc', hollow: questionable(p),
        tip: `${niceDateTime(p.mjd)} (MJD ${p.mjd.toFixed(3)})\nD${p.det} λ ${p.wavelength.toFixed(3)} µm\n${p.flux.toFixed(0)} ± ${p.err.toFixed(0)} µJy${rel ? `\nrelative ${p.rel.toFixed(3)}` : ''}`, ref: p })),
      legend: DETECTORS.filter((d) => ptsR.some((p) => p.det === d.id)).map((d) => ({ color: getComputedStyle(document.documentElement).getPropertyValue(`--d${d.id}`).trim(), label: `D${d.id}` })).concat(ptsR.some(questionable) ? [{ color: '#aaa', label: 'questionable', hollow: true }] : []),
      onPoint: (pt) => focusExposure(pt.ref.uri),
    };
  }

  async function makeDossier() {
    if (!S.display?.frames.length) { toast({ title: 'Nothing to put in a dossier yet', text: 'Wait for at least one epoch to load.', glyph: '📄', timeout: 3000 }); return; }
    const t = toast({ title: 'Building the dossier…', text: 'Figures, tables and FITS cutouts are made on this device.', glyph: '📄', timeout: 0 });
    try {
      const { buildDossier, zip } = await import('../lib/dossier.js');
      const pts = photPoints();
      const tmp = h('div');
      scatterChart(tmp, specCfg(pts)); const specSvg = pts.length ? svgString(tmp.querySelector('svg')) : null;
      const eb = epochBrightness(pts);
      scatterChart(tmp, lcCfg(eb.points, true)); const lcSvg = pts.length ? svgString(tmp.querySelector('svg')) : null;
      let version = 'dev';
      try { version = (await (await fetch('./version.json', { cache: 'no-cache' })).json()).version; } catch { /* offline */ }
      const cands = (JSON.parse(localStorage.getItem('skyshift.candidates') || '[]')).filter((c) => separation(c.ra, c.dec, req.target.ra, req.target.dec) * 60 < req.fov);
      const d = await buildDossier({ req, grid: S.grid, display: S.display, frames: selectedFrames(), phot: pts, cats: S.cats, movers: S.movers, variables: S.variables,
        version, specSvg, lcSvg, inputs: { url: location.href, source: req.target.source || 'unknown' }, candidates: cands, imageList: S.search?.via === 'index' ? 'index' : S.search?.source || 'live' });
      t();
      const stem = `skyshift-dossier-${fileStem()}-${d.id}`;
      const openHtml = () => { const w = window.open(URL.createObjectURL(new Blob([d.html], { type: 'text/html' })), '_blank'); if (!w) download(`${stem}.html`, d.html, 'text/html'); else w.opener = null; };
      const close = sheet(h('div', { class: 'grid' },
        h('h2', {}, 'Dossier ready'),
        h('p', { class: 'muted' }, `ID ${d.id} — the same request on the same data release gives the same ID; any change gives a new one.`),
        h('ul', { class: 'tiny' }, d.checks.map(([txt, ok]) => h('li', { style: { color: ok ? 'var(--good)' : 'var(--bad)' } }, `${ok ? '✔' : '✘'} ${txt}`))),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', onclick: openHtml }, 'Open (print to PDF, A4 or Letter)'),
          h('button', { class: 'btn', onclick: () => download(`${stem}.html`, d.html, 'text/html') }, icon('download'), 'HTML'),
          h('button', { class: 'btn', onclick: async () => download(`${stem}.zip`, await zip(d.files)) }, icon('download'), `ZIP (${d.files.length} files)`)),
        h('p', { class: 'tiny' }, 'The ZIP holds the HTML, figures (PNG, SVG, animated PNG), photometry and exposure tables (CSV, VOTable), FITS cutouts of every epoch and the difference image, and request.json.'),
        h('button', { class: 'btn ghost', onclick: () => close() }, 'Close')), { label: 'Dossier' });
      await (await import('../lib/store.js')).cache.set(`dossier:${d.id}`, { id: d.id, name: d.name, html: d.html, created: Date.now() });
    } catch (e) {
      t(); console.error(e);
      toast({ title: 'The dossier could not be built', text: String(e.message || e), glyph: '⚠', timeout: 6000 });
    }
  }

  function blendInfo() {
    const gaia = S.cats.gaia?.rows;
    if (!gaia?.length) return null;
    const yr = 2026;
    const tp = req.target;
    const near = gaia.filter((s) => {
      const p = propagate(s.ra, s.dec, s.pmra || 0, s.pmdec || 0, s.ref_epoch || 2016, yr);
      const t = propagate(tp.ra, tp.dec, tp.pmra || 0, tp.pmdec || 0, tp.refEpoch || 2016, yr);
      const d = separation(p.ra, p.dec, t.ra, t.dec) * 3600;
      return d > 1.5 && d < 2.5 * NATIVE_SCALE + 6;
    });
    if (!near.length) return null;
    return `Possible blend: ${near.length} Gaia source${near.length > 1 ? 's' : ''} lie within ${(2.5 * NATIVE_SCALE + 6).toFixed(0)}″ of the target, the 15″ aperture plus the image blur (brightest G=${Math.min(...near.map((s) => s.phot_g_mean_mag || 99)).toFixed(1)}). SPHEREx pixels are 6.15″, so their light can mix with the target’s.`;
  }

  function sideLight() {
    const pts = S.clickSpec ? S.clickSpec.points : photPoints();
    const host = h('div', { class: 'chart-host' });
    const rel = S.relLC !== false;
    const eb = epochBrightness(pts);
    const ptsR = eb.points;
    tabBody.append(
      h('p', { class: 'tiny' }, 'Brightness of the target against time. Because each exposure is at a different wavelength, “relative to the average spectrum” divides each point by the mean spectrum at its wavelength, so real brightening or fading stands out.'),
      segment([['rel', 'Relative to average spectrum'], ['abs', 'Flux (µJy)']], rel ? 'rel' : 'abs', (v) => { S.relLC = v === 'rel'; renderSide(); }),
      host,
      eb.epochs.length > 1 ? h('table', { class: 'table' }, h('tr', {}, h('th', {}, 'Survey pass'), h('th', {}, 'Dates'), h('th', {}, 'Mean relative brightness'), h('th', {}, 'N')),
        eb.epochs.map((e, i) => h('tr', {}, h('td', {}, i + 1), h('td', {}, `${niceDate(e.t0)} – ${niceDate(e.t1)}`), h('td', {}, `${((e.mean - 1) * 100).toFixed(1)}% ± ${(e.err * 100).toFixed(1)}%`), h('td', {}, e.n)))) : null,
      eb.change ? h('div', { class: eb.change.sig >= 3 ? 'notice warn' : 'notice' }, eb.change.sig >= 3
        ? `Brightness-change candidate: ${(eb.change.delta * 100).toFixed(1)}% ± ${(eb.change.err * 100).toFixed(1)}% between survey passes (${eb.change.sig.toFixed(1)}σ). Check flags and neighbours before trusting it.`
        : `No significant change between survey passes (${(eb.change.delta * 100).toFixed(1)}% ± ${(eb.change.err * 100).toFixed(1)}%, ${eb.change.sig.toFixed(1)}σ).`) : null,
      h('div', { class: 'row' }, h('button', { class: 'btn small', onclick: () => enlarge(() => lcCfg(ptsR, rel), 'Light curve') }, 'Enlarge'),
        h('button', { class: 'btn small', onclick: () => download(`skyshift-lightcurve-${fileStem()}.csv`, photCSV(pts), 'text/csv') }, icon('download'), 'CSV')),
    );
    scatterChart(host, lcCfg(ptsR, rel));
  }

  // The enlarged chart is drawn afresh (not copied), so its axes, legend and point details all work, and it is sized
  // to fit the screen in both directions so the axis numbers and labels are never cut off.
  function enlarge(cfgFn, label) {
    const fit = `min(1100px, 94vw, calc((100dvh - 240px) * 1.5))`;
    const big = h('div', { class: 'chart-host', style: { width: fit, margin: '0 auto' } });
    const close = sheet(h('div', {}, h('h2', {}, label), big, h('button', { class: 'btn', onclick: () => close() }, 'Close')), { label });
    const el = document.querySelector('.sheet'); if (el) el.style.width = 'min(1140px, 100vw)';
    scatterChart(big, cfgFn());
  }

  function focusExposure(uri) {
    const D = S.display; if (!D) return;
    const i = D.frames.findIndex((f) => f.group.some((e) => e.meta.uri === uri));
    if (i >= 0) { stopPlay(); S.frame = i; slider.value = i; draw(); S.tab = 'frame'; renderTabs(); renderSide(); }
  }

  function sideFrames() {
    const D = S.display;
    if (!D?.frames.length) { tabBody.append(h('p', { class: 'empty' }, 'Frames appear as images load.')); return; }
    const N = n();
    const grid = h('div', { class: 'thumbs' });
    D.frames.slice(0, 400).forEach((fr, i) => {
      const c = h('canvas', { width: N, height: N, class: 'thumb' + (i === currentIndex() ? ' cur' : ''), title: `${i + 1}: ${niceDate(frameMjd(i))}`, tabindex: 0, role: 'button', 'aria-label': `Frame ${i + 1}, ${niceDate(frameMjd(i))}` });
      const im = new ImageData(N, N);
      if (D.kind === 'rgb') paintRGB(fr.rgb, im.data, D.lims, { stretch: req.stretch, invert: req.invert });
      else if (D.kind === 'diff') paintDiff(fr.data, im.data, D.lims, { invert: req.invert });
      else paint(fr.data, im.data, D.lims, { stretch: req.stretch, cmap: cmapFor(fr), invert: req.invert });
      c.getContext('2d').putImageData(im, 0, 0);
      const pick = () => { stopPlay(); if (req.mode === 'blink') commit({ mode: 'movie' }); S.frame = i; slider.value = i; draw(); renderSide(); };
      c.addEventListener('click', pick); c.addEventListener('keydown', (e) => { if (e.key === 'Enter') pick(); });
      grid.append(h('figure', { class: 'thumb-fig' }, c, h('figcaption', { class: 'tiny' }, `${i + 1} · ${niceDate(frameMjd(i))}`)));
    });
    tabBody.append(h('p', { class: 'tiny' }, `${D.frames.length} frames with the shared stretch. Click one to show it.`), grid);
  }

  function sideFrame() {
    const D = S.display, i = currentIndex();
    if (!D || i < 0) { tabBody.append(h('p', { class: 'empty' }, 'Frame details appear once images load.')); return; }
    const fr = D.frames[i];
    const counts = {};
    for (const e of fr.group) for (const [b, c] of Object.entries(e.meta.flagCounts || {})) counts[b] = (counts[b] || 0) + c;
    const fieldFlags = fr.group.some((e) => e.meta.flagCounts);
    const total = n() * n() * fr.group.length;
    const first = fr.group[0].meta;
    const [cra, cdec] = frameCenter(i);
    tabBody.append(
      h('h3', {}, `Frame ${i + 1}: ${fr.group.length} exposure${fr.group.length > 1 ? 's' : ''}`),
      h('p', { class: 'tiny' }, 'Contamination and quality flags inside this field (share of pixels, summed over the exposures in this frame). Hover a flag for its meaning. Turn on “Contamination flags” in Display to see where they are.'),
      !fieldFlags ? h('div', { class: 'notice' }, 'Flags are read only around the target to save data (they still clean the photometry). ',
        h('button', { class: 'btn small', onclick: () => toggleOv('flags') }, 'Map flags across the whole field')) : null,
      fieldFlags ? h('div', { class: 'flaglist' }, Object.keys(counts).length ? Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([b, c]) => {
        const def = FLAG_BITS.find(([bb]) => bb === Number(b));
        const bad = BAD_MASK & (1 << Number(b));
        return h('span', { class: `chip ${bad ? 'bad' : 'info'}`, title: `bit ${b}: ${def?.[2] || ''}` }, `${def?.[1] || 'bit ' + b} ${((c / total) * 100).toFixed(1)}%`);
      }) : h('span', { class: 'chip good' }, 'no flags in this field')) : null,
      h('div', { class: 'explist', style: { marginTop: '10px' } }, h('table', {},
        h('tr', {}, ['Date (UTC)', 'Det', 'λ µm', 'Release', 'QA', 'Files'].map((x) => h('th', {}, x))),
        fr.group.map((e) => h('tr', {},
          h('td', {}, niceDateTime(e.meta.mjd)), h('td', {}, `D${e.meta.detector}`), h('td', {}, e.meta.wavelength?.toFixed(3) ?? '–'),
          h('td', {}, String(e.meta.release).toUpperCase()), h('td', {}, e.meta.header?.L2DQAFLG || '–'),
          h('td', {}, h('a', { href: `${uriToIbe(e.meta.uri)}?center=${cra.toFixed(6)},${cdec.toFixed(6)}d&size=${(req.fov / 60).toFixed(4)}`, target: '_blank', rel: 'noopener', title: 'FITS cutout from the IRSA cutout service' }, 'cutout'), ' · ',
            h('a', { href: uriToS3(e.meta.uri), target: '_blank', rel: 'noopener', title: 'Full spectral image (about 65 MB)' }, 'full')))))),
      h('details', { class: 'panel' }, h('summary', {}, 'Header metadata (first exposure)'),
        h('dl', { class: 'kv' }, Object.entries({ OBSID: first.obsid, file: first.uri.split('/').pop(), ...first.header }).map(([k, v]) => [h('dt', {}, k), h('dd', {}, String(v))]))),
      h('p', { class: 'tiny' }, `Background ${first.bg?.toFixed(3)} MJy/sr subtracted per exposure (median of the field). Noise ≈ ${first.sigma?.toFixed(3)} MJy/sr. Images resampled onto a north-up grid of ${S.grid.scale.toFixed(2)}″ pixels using each file’s TAN-SIP WCS.`),
    );
  }

  function sideContext() {
    ensureCats();
    const gaia = S.cats.gaia, wise = S.cats.wise;
    const neo = h('div', {}, h('p', { class: 'tiny' }, 'Looking for NEOSSat observations near this position (CADC)…'));
    tabBody.append(
      h('h3', {}, h('span', { class: 'legend-dot', style: { '--c': '#5ec8ff' } }), 'Gaia DR3'),
      gaia ? (gaia.error ? h('p', { class: 'notice bad' }, `Gaia unavailable: ${gaia.error}`) : h('p', { class: 'tiny' }, `${gaia.rows.length} stars within ${(Math.min((req.fov / 60) * 0.75, 0.6) * 60).toFixed(1)}′ via ${gaia.via}${gaia.source === 'cache' ? ' (saved copy)' : ''}. Circles are drawn at each star’s position on the frame date (Gaia proper motion); arrows show 5 years of motion for fast movers.`)) : h('p', { class: 'tiny' }, 'Loading…'),
      gaia?.rows?.length ? h('div', { class: 'explist' }, h('table', {}, h('tr', {}, ['Gaia DR3', 'G', 'pm ″/yr', 'ϖ mas'].map((x) => h('th', {}, x))),
        gaia.rows.slice(0, 60).map((s) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { S.selected = { ra: s.ra, dec: s.dec, obj: s, cat: 'gaia' }; S.tab = 'object'; renderTabs(); renderSide(); drawOverlay(); } },
          h('td', {}, s.label ? `${s.label}` : String(s.source_id)), h('td', {}, s.phot_g_mean_mag?.toFixed(2) ?? '–'), h('td', {}, s.pmra != null ? (Math.hypot(s.pmra, s.pmdec) / 1000).toFixed(3) : '–'), h('td', {}, s.parallax?.toFixed(1) ?? '–'))))) : null,
      h('h3', { style: { marginTop: '12px' } }, h('span', { class: 'legend-dot', style: { '--c': '#ffb547' } }), 'WISE'),
      req.ov.includes('wise') ? (wise ? (wise.error ? h('p', { class: 'notice bad' }, `WISE catalogue unavailable: ${wise.error}`) : h('p', { class: 'tiny' }, `${wise.rows.length} sources via ${wise.via}. Squares mark WISE positions moved to the frame date with CatWISE2020 motions.`)) : h('p', { class: 'tiny' }, 'Loading…'))
        : h('button', { class: 'btn small', onclick: () => toggleOv('wise') }, 'Show WISE sources'),
      h('p', { class: 'tiny' }, 'For a then-and-now comparison with WISE/NEOWISE images, ', guardWise(wiseLink.cloneNode(true)), ' opens this field in WiseView.', h('button', { class: 'btn small', type: 'button', style: { marginLeft: '6px' }, onclick: () => wiseCompare() }, 'NASA WISE images of this field')),
      h('h3', { style: { marginTop: '12px' } }, 'NEOSSat (Canadian Space Agency)'), neo,
    );
    neossatCone(req.target.ra, req.target.dec, 0.5).then((r) => {
      const rows = r.data.rows;
      neo.replaceChildren(
        h('p', { class: 'tiny' }, rows.length ? `${rows.length} NEOSSat observations within 0.5° (CADC archive, ${r.data.via}${r.source !== 'live' ? ', saved copy' : ''}). NEOSSat is an optical microsatellite (15-cm telescope, 3″ pixels); its images are separate from SPHEREx and are not mixed into the movie.` : 'NEOSSat has not observed within 0.5° of this position (its fields are sparse).'),
        rows.length ? h('div', { class: 'explist' }, h('table', {}, h('tr', {}, ['Date (UTC)', 'Target', 'Exp. s', 'Data'].map((x) => h('th', {}, x))),
          rows.slice(0, 80).map((o) => h('tr', {}, h('td', {}, niceDateTime(o.t_min)), h('td', {}, String(o.target_name ?? '')), h('td', {}, o.t_exptime ?? '–'),
            h('td', {}, /^https:\/\/ws\.cadc-ccda\.hia-iha\.nrc-cnrc\.gc\.ca\//.test(o.access_url) ? h('a', { href: o.access_url, target: '_blank', rel: 'noopener' }, 'CADC') : '–'))))) : null);
    }).catch((e) => neo.replaceChildren(h('p', { class: 'notice bad' }, `NEOSSat search unavailable right now (${e.message}).`)));
  }

  /** Aperture photometry at (ra, dec) in each detector's co-add of the frame on screen: flux (µJy), AB magnitude
   * and the wavelengths the exposures saw at that spot. Same aperture as the light curves (2.5 native pixels). */
  function bandsAt(ra, dec, { empirical = false } = {}) {
    const D = S.display, i = currentIndex();
    // in Stack mode, measure the cumulative stack on screen (every exposure up to this pass)
    const dm = D?.stackMaps?.[i] || D?.dmaps?.[i];
    if (!dm) return [];
    const N = n(), [cra, cdec] = frameCenter(i), k = NATIVE_SCALE / S.grid.scale;
    const [x, y] = worldToGrid(S.grid, ra, dec, cra, cdec);
    const out = [];
    for (const det of [...dm.keys()].sort()) {
      const img = { y0: 1, x0: 1, width: N, data: dm.get(det) }, opt = { rAp: 2.5 * k, rIn: 5 * k, rOut: 8 * k };
      const p = photometry(img, null, x + 1, y + 1, S.grid.scale ** 2, opt);
      // comparison apertures: the same measurement at 16 places around the object (12 native pixels away, inside the
      // image); their scatter is the real noise of this image, including faint stars and trails in crowded fields
      let emp = null;
      if (empirical && p) {
        const f = [];
        for (let a = 0; a < 16; a++) {
          const r = 12 * k, xx = x + r * Math.cos((a * Math.PI) / 8), yy = y + r * Math.sin((a * Math.PI) / 8);
          if (xx < 8 * k || yy < 8 * k || xx > N - 1 - 8 * k || yy > N - 1 - 8 * k) continue;
          const q = photometry(img, null, xx + 1, yy + 1, S.grid.scale ** 2, opt);
          if (q && Number.isFinite(q.flux)) f.push(q.flux);
        }
        if (f.length >= 6) { const m = f.slice().sort((u, v) => u - v)[f.length >> 1]; emp = 1.4826 * f.map((v) => Math.abs(v - m)).sort((u, v) => u - v)[f.length >> 1]; }
      }
      const err = p ? Math.max(p.err, emp || 0) : null;
      // shift-and-stack of a followed object: measure each six-month pass on its own as well; a real object shows in
      // every pass, a chance blend in a crowded field usually in one
      let passes = null;
      if (empirical && p && D.stackMaps && req.target.eph && i > 0) {
        passes = D.groups.slice(0, i + 1).map((g) => {
          const list = g.filter((e) => e.meta.detector === det);
          if (list.length < 2) return null;
          const q = photometry({ y0: 1, x0: 1, width: N, data: clippedCoadd(list, N) }, null, x + 1, y + 1, S.grid.scale ** 2, opt);
          return q ? q.flux / Math.max(q.err, 1e-12) : null;
        }).filter((v) => v != null);
        // the per-pass noise is scaled like the whole stack's (comparison apertures), so S/N stays comparable
        if (emp && p.err) passes = passes.map((snr) => snr * p.err / emp);
      }
      const wl = (D.stackMaps ? D.groups.slice(0, i + 1).flat() : D.groups[i]).filter((e) => e.meta.detector === det).map((e) => e.meta.wavelength).filter(Number.isFinite);
      out.push({ det, wl: wl.length ? [Math.min(...wl), Math.max(...wl)] : null, flux: p?.flux, err, ab: p ? abMag(p.flux, err) : null, bad: p ? p.nbad : 0, nap: p ? p.nap : 0, empirical: emp != null && emp > p.err, passes });
    }
    return out;
  }

  function sideObject() {
    const sel = S.selected;
    if (!sel) { tabBody.append(h('p', { class: 'empty' }, 'Click anything in the image to inspect it: catalogue details, its spectrum, and tools to mark it as a candidate.')); return; }
    const o = sel.obj;
    const specBtn = h('button', { class: 'btn primary small', onclick: () => spectrumAt(sel.ra, sel.dec) }, 'Spectrum & light curve here');
    tabBody.append(
      h('h3', {}, o ? (sel.cat === 'gaia' ? (o.label || `Gaia DR3 ${o.source_id}`) : (o.source_name || o.designation)) : 'Selected position'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'RA, Dec'), h('dd', {}, `${formatRA(sel.ra)} ${formatDec(sel.dec)}`),
        h('dt', {}, 'Decimal'), h('dd', {}, `${sel.ra.toFixed(6)}, ${sel.dec.toFixed(6)}`),
        req.target.eph ? null : [h('dt', {}, 'From target'), h('dd', {}, `${(separation(sel.ra, sel.dec, req.target.ra, req.target.dec) * 3600).toFixed(1)}″`)],
        ...positionRows(sel, o),
        o && sel.cat === 'gaia' ? [h('dt', {}, 'G mag'), h('dd', {}, o.phot_g_mean_mag?.toFixed(3) ?? '–'), h('dt', {}, 'BP−RP'), h('dd', {}, o.bp_rp?.toFixed(3) ?? '–'),
          h('dt', {}, 'Proper motion'), h('dd', {}, o.pmra != null ? `${o.pmra.toFixed(1)}, ${o.pmdec.toFixed(1)} mas/yr (${(Math.hypot(o.pmra, o.pmdec) / 1000).toFixed(3)}″/yr)` : '–'),
          h('dt', {}, 'Parallax'), h('dd', {}, o.parallax != null ? `${o.parallax.toFixed(3)} mas${o.parallax > 0 ? ` → ~${(1000 / o.parallax).toFixed(1)} pc (${(3261.56 / o.parallax).toFixed(1)} light-years)` : ''}` : '–')] : null,
        o && sel.cat === 'wise' ? [h('dt', {}, 'W1, W2'), h('dd', {}, `${o.w1mpro ?? '–'}, ${o.w2mpro ?? '–'} mag`), h('dt', {}, 'W1−W2'), h('dd', {}, o.w1mpro != null && o.w2mpro != null ? (o.w1mpro - o.w2mpro).toFixed(2) : '–')] : null),
      brightnessTable(sel),
      o && sel.cat === 'wise' && o.w1mpro - o.w2mpro > 1.5 ? h('p', { class: 'notice warn' }, 'Very red in WISE (W1−W2 > 1.5): typical of cold brown dwarfs or dusty objects.') : null,
      h('div', { class: 'row' }, specBtn,
        o && sel.cat === 'gaia' && (o.pmra || o.pmdec) ? h('button', { class: 'btn small', onclick: () => { commit({ target: { ra: o.ra, dec: o.dec, pmra: o.pmra, pmdec: o.pmdec, plx: o.parallax > 0 ? o.parallax : 0, refEpoch: o.ref_epoch || 2016, name: o.label || `Gaia DR3 ${o.source_id}`, id: String(o.source_id), source: 'gaia' }, track: false }, { reload: true, push: true }); } }, 'Make this the target') : null,
        h('button', { class: 'btn small', title: 'Measure the light-weighted centre of the object in the current frame', onclick: (e) => {
          const c = centroidAt(sel.ra, sel.dec);
          const out = e.currentTarget.parentElement.nextElementSibling;
          if (!c) { out.textContent = 'No clear object to centroid here in this frame.'; return; }
          S.selected = { ...sel, ra: c.ra, dec: c.dec }; drawOverlay();
          out.textContent = `Centroid: ${formatRA(c.ra)} ${formatDec(c.dec)} (${c.ra.toFixed(6)}, ${c.dec.toFixed(6)}); moved ${c.shift.toFixed(2)}″ from the click; peak S/N ${c.snr.toFixed(1)}; typical precision ±${c.err.toFixed(1)}″.`;
        } }, icon('target'), 'Centroid'),
        h('button', { class: 'btn small', onclick: () => markCandidate(sel) }, icon('star'), 'Mark candidate'),
        h('a', { class: 'btn small', href: `#/view?${toParams(normalise({ ...req, target: { ra: sel.ra, dec: sel.dec, source: 'coords' }, t: 0 }))}` }, 'Centre here')),
      h('p', { class: 'tiny', 'aria-live': 'polite' }),
    );
  }

  /** Coordinates for reporting: as measured on the frame's date (ICRS, J2000.0 equinox), at epoch J2000.0 when the
   * motion is known, and precessed to the mean equinox of the frame's date. */
  function positionRows(sel, o) {
    const mjd = frameMjd();
    if (!mjd) return [];
    const fmt = (p) => [h('span', { class: 'coord' }, formatRA(p.ra)), ' ', h('span', { class: 'coord' }, formatDec(p.dec)), h('br'), `${p.ra.toFixed(6)}, ${p.dec.toFixed(6)}`];
    const moving = o && sel.cat === 'gaia' && (o.pmra || o.pmdec);
    const j2000 = moving ? propagate(o.ra, o.dec, o.pmra || 0, o.pmdec || 0, o.ref_epoch || 2016, 2000.0) : null;
    return [
      h('dt', {}, `On ${niceDate(mjd)}`), h('dd', {}, fmt(sel), h('span', { class: 'note' }, 'ICRS, J2000.0 equinox (the frame on screen)')),
      h('dt', {}, 'Epoch J2000.0'), h('dd', {}, j2000 ? [fmt(j2000), h('span', { class: 'note' }, 'Gaia DR3 motion applied')] : h('span', { class: 'note' }, 'not computable without a known motion; the position above is the one to report with its date')),
      h('dt', {}, 'Equinox of date'), h('dd', {}, fmt(precessFromJ2000(sel.ra, sel.dec, mjd + 2400000.5)), h('span', { class: 'note' }, `mean equinox of ${niceDate(mjd)}`)),
    ];
  }

  /** Brightness per detector band at the selected spot in the frame on screen. */
  function brightnessTable(sel) {
    const rows = bandsAt(sel.ra, sel.dec, { empirical: true });
    if (!rows.length) return null;
    return h('div', {},
      h('h4', {}, S.display?.stackMaps ? `Brightness in the stack of ${S.display.frames[currentIndex()]?.stackCount ?? ''} exposures up to ${niceDate(frameMjd())}` : `Brightness on ${niceDate(frameMjd())}`),
      h('table', { class: 'table' }, h('thead', {}, h('tr', {}, ['Band', 'λ (µm)', 'AB mag', 'Flux (µJy)'].map((t) => h('th', { style: { whiteSpace: 'nowrap' } }, t)))),
        h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, `D${r.det}`), h('td', {}, r.wl ? (r.wl[1] - r.wl[0] < 0.005 ? r.wl[0].toFixed(3) : `${r.wl[0].toFixed(2)}–${r.wl[1].toFixed(2)}`) : '–'),
          h('td', {}, r.ab && r.bad ? `≤ ${r.ab.mag.toFixed(2)} (${r.bad} of ${r.nap} pixels saturated or masked: brighter than this)` : r.flux != null && r.err > 0 && r.flux < 3 * r.err ? `not detected (S/N ${(r.flux / r.err).toFixed(1)}): fainter than ${abMag(3 * r.err).mag.toFixed(2)} (3σ)` : r.ab && r.passes?.length >= 2 && r.passes.filter((v) => v >= 1).length < r.passes.length ? `not confirmed: ${r.ab.mag.toFixed(2)} in the stack but seen in only ${r.passes.filter((v) => v >= 1).length} of ${r.passes.length} passes` : r.ab && r.passes?.length >= 2 ? `${r.ab.mag.toFixed(2)} ± ${r.ab.err == null ? '–' : r.ab.err < 0.005 ? '<0.01' : r.ab.err.toFixed(2)} (seen in all ${r.passes.length} passes)` : r.ab ? `${r.ab.mag.toFixed(2)} ± ${r.ab.err == null ? '–' : r.ab.err < 0.005 ? '<0.01' : r.ab.err.toFixed(2)}` : r.flux != null ? `fainter than ${abMag(Math.max(3 * r.err, 1e-3))?.mag.toFixed(1) ?? '–'} (3σ)` : '–'),
          h('td', {}, r.flux != null ? `${r.flux.toFixed(1)} ± ${r.err.toFixed(1)}${r.empirical ? '*' : ''}` : 'no clean measurement'))))),
      h('p', { class: 'tiny muted' }, 'Aperture of 2.5 SPHEREx pixels (15″) on each detector’s stack of this epoch, background from a ring at 5–8 pixels; light outside the aperture is not added back. Each detector spans a range of wavelengths across its field: for one exact wavelength per exposure use “Spectrum & light curve here”.'),
      rows.some((r) => r.empirical) ? h('p', { class: 'tiny muted' }, 'Errors marked * come from 16 comparison apertures around the object, which scatter more than the pixel noise alone (faint stars or trails in a crowded field). A detection needs at least 3 times that error.') : null);
  }

  /** Iterative Gaussian-weighted centroid in the current frame near (ra, dec). */
  function centroidAt(ra, dec) {
    const D = S.display, i = currentIndex();
    if (!D || i < 0) return null;
    const fr = D.frames[i]; const img = fr.data || (fr.rgb && detectorBalanced(D.dmaps[i], n()));
    if (!img) return null;
    const N = n(), [cra, cdec] = frameCenter(i);
    let [x, y] = worldToGrid(S.grid, ra, dec, cra, cdec);
    const ring = [];
    for (let j = Math.round(y) - 9; j <= Math.round(y) + 9; j++) for (let k = Math.round(x) - 9; k <= Math.round(x) + 9; k++) { if (k < 0 || j < 0 || k >= N || j >= N) continue; const d = Math.hypot(k - x, j - y), v = img[j * N + k]; if (d > 5 && d < 9 && Number.isFinite(v)) ring.push(v); }
    if (ring.length < 10) return null;
    ring.sort((a, b) => a - b);
    const bg = ring[ring.length >> 1], noise = 1.4826 * ring.map((v) => Math.abs(v - bg)).sort((a, b) => a - b)[ring.length >> 1] || 1e-6;
    const sig = 1.2 * (NATIVE_SCALE / S.grid.scale);
    let peak = 0;
    for (let it = 0; it < 10; it++) {
      let sx = 0, sy = 0, sw = 0; peak = 0;
      for (let j = Math.round(y) - 4; j <= Math.round(y) + 4; j++) for (let k = Math.round(x) - 4; k <= Math.round(x) + 4; k++) {
        if (k < 0 || j < 0 || k >= N || j >= N) continue;
        const v = img[j * N + k]; if (!Number.isFinite(v)) continue;
        const w = Math.exp(-((k - x) ** 2 + (j - y) ** 2) / (2 * sig * sig)) * Math.max(0, v - bg);
        peak = Math.max(peak, v - bg); sx += w * k; sy += w * j; sw += w;
      }
      if (sw <= 0) return null;
      const nx = sx / sw, ny = sy / sw;
      if (Math.hypot(nx - x, ny - y) < 1e-3) { x = nx; y = ny; break; }
      x = nx; y = ny;
    }
    const snr = peak / noise;
    if (snr < 3) return null;
    const [r2, d2] = gridToWorld(S.grid, x, y, cra, cdec);
    return { ra: r2, dec: d2, snr, shift: separation(ra, dec, r2, d2) * 3600, err: Math.max(0.3, (sig * 1.2 * S.grid.scale) / snr) };
  }

  function spectrumAt(ra, dec) {
    const items = [...S.frames.values()].map((f) => ({ uri: f.meta.uri }));
    const id = Date.now();
    const w = getWorker();
    toast({ title: 'Measuring every exposure at this position…', glyph: '🌈', timeout: 2500 });
    // only one position is measured at a time: a new click replaces the previous listener
    if (S.specHandler) w.removeEventListener('message', S.specHandler);
    const handler = (ev) => {
      const m = ev.data;
      if (m.id !== `p${id}`) return;
      if (m.type === 'photDone') {
        w.removeEventListener('message', handler); S.specHandler = null;
        S.clickSpec = { ra, dec, points: m.points.filter((p) => Number.isFinite(p.wavelength)).map((p) => ({ ...p, det: p.detector, release: '' })) };
        S.tab = 'spectrum'; renderTabs(); renderSide();
      }
    };
    S.specHandler = handler;
    w.addEventListener('message', handler);
    w.postMessage({ type: 'phot', id: `p${id}`, items, ra, dec });
  }

  function markCandidate(sel) {
    const types = [['mover', 'Moving object'], ['variable', 'Brightness change'], ['red', 'Very red / cold'], ['other', 'Something else']];
    const note = h('textarea', { placeholder: 'What did you notice? (kept on this device)' });
    let type = 'mover';
    const seg = h('div', { class: 'seg' }, types.map(([v, l]) => h('button', { type: 'button', 'aria-pressed': String(v === type), onclick: (e) => { type = v; [...seg.children].forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); } }, l)));
    const close = sheet(h('div', { class: 'grid' },
      h('h2', {}, 'Mark a candidate'),
      h('p', { class: 'muted' }, `${formatRA(sel.ra)} ${formatDec(sel.dec)} — saved with the full view settings so anyone can check it. This is a candidate for your own vetting, not a discovery.`),
      seg, note,
      h('button', { class: 'btn primary', onclick: () => {
        saveCandidate({ ra: sel.ra, dec: sel.dec, type, note: note.value.slice(0, 2000), catalog: sel.obj ? (sel.cat === 'gaia' ? `Gaia DR3 ${sel.obj.source_id}` : sel.obj.source_name || sel.obj.designation) : null,
          url: location.href, request: req, frameDate: frameMjd(), exposures: S.display?.frames[currentIndex()]?.group.map((e) => e.meta.uri) || [] });
        close(); toast({ title: 'Candidate saved', text: 'See it under Saved, where you can export CSV/JSON.', glyph: '⭐', timeout: 3500 });
      } }, 'Save candidate')), { label: 'Mark a candidate' });
  }

  function sideDiscover() {
    const D = S.display;
    tabBody.append(
      h('p', {}, 'Automated helpers that point your eyes at things worth checking. They can miss objects and raise false alarms: everything they find is a ', h('b', {}, 'candidate'), ' for you to inspect.'),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary small', disabled: !D || D.groups.length < 2, onclick: () => { S.movers = findMovers(S.display, n(), S.grid, req, frameCenter(S.display.frames.length - 1)); drawOverlay(); renderSide(); } }, 'Spot the movers'),
        h('button', { class: 'btn small', disabled: !D || D.groups.length < 2, onclick: () => { S.variables = findVariables(S.display, n(), S.grid, frameCenter(S.display.frames.length - 1)); drawOverlay(); renderSide(); } }, 'Find brightness changes'),
        S.movers || S.variables ? h('button', { class: 'btn small ghost', onclick: () => { S.movers = null; S.variables = null; drawOverlay(); renderSide(); } }, 'Clear') : null),
      !D || D.groups.length < 2 ? h('p', { class: 'tiny' }, 'Needs at least two epochs. Use “Per survey” frames for the cleanest comparison.') : null,
      S.movers ? h('div', {}, h('h3', {}, `${S.movers.length} motion candidate${S.movers.length === 1 ? '' : 's'}`),
        S.movers.length ? h('div', { class: 'explist' }, h('table', {}, h('tr', {}, ['#', 'Shift', 'Rate', 'Direction', 'S/N'].map((x) => h('th', {}, x))),
          S.movers.map((m, k) => h('tr', { style: { cursor: 'pointer' }, onclick: () => { S.selected = { ra: m.ra, dec: m.dec }; S.tab = 'object'; renderTabs(); renderSide(); drawOverlay(); } },
            h('td', {}, k + 1), h('td', {}, `${m.shift.toFixed(1)}″`), h('td', {}, `${m.rate.toFixed(2)}″/yr`), h('td', {}, `${m.pa.toFixed(0)}° E of N`), h('td', {}, m.snr.toFixed(1)))))) : h('p', { class: 'tiny' }, 'No pairs passed the checks (flags, cosmic rays, single-epoch spikes).'),
        h('p', { class: 'tiny' }, 'Method: sources found in the first and last epoch co-adds (≥5σ peaks, flagged pixels rejected) are matched; pairs that shifted by more than half a pixel with similar brightness, and with no stationary counterpart, are listed. Pink arrows mark them.')) : null,
      S.variables ? h('div', {}, h('h3', {}, `${S.variables.length} brightness-change candidate${S.variables.length === 1 ? '' : 's'}`),
        S.variables.map((v) => h('p', { class: 'tiny' }, `${formatRA(v.ra)} ${formatDec(v.dec)}: ${v.sign > 0 ? 'brighter' : 'fainter'} in the latest epoch by ${v.snr.toFixed(1)}σ`)),
        h('p', { class: 'tiny' }, 'Method: stationary peaks in the wavelength-matched difference between the first and last epoch co-adds, ≥5σ, rejecting flagged pixels. Green circles mark them.')) : null,
    );
  }

  // ------------------------------------------------------------------ suggestions, explain, share, tour
  function renderSuggestion() {
    suggestionBox.replaceChildren();
    const sg = suggestFor(req.target);
    const tip = req.target.eph && S.eph ? (S.ephSource === 'NASA JPL Horizons'
      ? `Followed along ${S.eph.length} daily positions from NASA JPL Horizons (${niceDate(S.eph[0][0])} to ${niceDate(S.eph[S.eph.length - 1][0])}): every exposure is centred on the object at its own time, so the object stays still while the stars stream past.`
      : `Followed along your table of ${S.eph.length} positions (${niceDate(S.eph[0][0])} to ${niceDate(S.eph[S.eph.length - 1][0])}): every exposure is centred on the object at its own time, so the object stays still while the stars stream past. Positions come from your table, not from SkyShift.`) : preset?.tip;
    const text = [tip, sg?.text].filter(Boolean).join(' ');
    if (!text) return;
    const btns = [];
    // a Solar System object: add every exposure along its path (shift-and-stack) and measure it at the centre
    if (req.target.eph && S.eph) btns.push(h('button', { class: 'btn small primary', title: 'Every exposure is already centred on the object, so adding them all builds up its faint light while the stars smear out (shift-and-stack).', onclick: () => shiftAndStack() }, 'Shift-and-stack all exposures and measure'));
    if (sg && (req.mode !== sg.mode || req.group !== 'survey')) btns.push(h('button', { class: 'btn small primary', onclick: () => { commit({ mode: sg.mode, group: 'survey' }); if (sg.mode === 'blink') { S.blinkPhase = 0; draw(); play(); } } }, `Try ${MODE_INFO[sg.mode][0]}`));
    if (preset?.id === 'epsindib' && req.fov < 15) btns.push(h('button', { class: 'btn small', onclick: () => commit({ fov: 15, ov: [...new Set([...req.ov, 'gaia'])] }) }, 'Show the host star (15′ field)'));
    if ((preset?.id === 'rwaur' || preset?.id === 'rdra') && S.tab !== 'lightcurve') btns.push(h('button', { class: 'btn small', onclick: () => { S.tab = 'lightcurve'; renderTabs(); renderSide(); } }, 'Open light curve'));
    suggestionBox.append(h('div', { class: 'suggestion', style: { marginBottom: '10px' } }, h('span', { 'aria-hidden': 'true' }, '💡'), h('span', { style: { flex: 1 } }, text), btns));
  }
  /** Shift-and-stack for a followed object: load every exposure, stack them all, select the object, measure it. */
  function shiftAndStack() {
    stopPlay();
    const measure = () => {
      const N = S.display?.frames.length || 0;
      if (!N) return;
      S.frame = N - 1; slider.value = S.frame; draw();
      const [ra, dec] = frameCenter(N - 1);
      S.selected = { ra, dec }; S.tab = 'object'; renderTabs(); renderSide(); drawOverlay();
    };
    S.afterStream = measure; // runs again once the remaining exposures have arrived
    commit({ mode: 'stack' });
    if (S.moreAvailable > 0) { S.extraImages = Infinity; stream(S.loadId); toast({ title: 'Loading every exposure along the path', text: 'The stack and the measurement update when they have arrived.', glyph: '🌠', timeout: 4000 }); }
    measure();
  }

  /** Open WiseView if it answers; otherwise show NASA's WISE images of the field and say why. */
  async function openWiseView(url) {
    const w = window.open('', '_blank'); // opened now, inside the click, so pop-up blockers allow it
    let up = true;
    try {
      const r = await smartFetch('http://byw.tools/wiseview', { timeout: 6000 });
      const st = Number(r.headers.get('x-relay-upstream-status') || r.status);
      up = st > 0 && st < 500 && !r.headers.get('x-relay-error');
    } catch (e) { up = /no archive relay/.test(String(e.message)); } // no relay to ask: open it directly; any other failure: down
    if (up && w) { w.opener = null; w.location.href = url; return; }
    if (up) { window.open(url, '_blank', 'noopener'); return; }
    w?.close();
    wiseCompare('WiseView (byw.tools) is not answering right now, so here is the same field in NASA’s WISE images from IRSA.');
  }

  /** NASA WISE (AllWISE) images of the field from IRSA Finder Chart, beside the SPHEREx view. */
  function wiseCompare(note) {
    const size = Math.min(Math.max(req.fov, 1), 30).toFixed(1);
    const img = (band) => `https://irsa.ipac.caltech.edu/applications/finderchart/servlet/api?mode=getImage&RA=${req.target.ra.toFixed(6)}&DEC=${req.target.dec.toFixed(6)}&subsetsize=${size}&thumbnail_size=large&survey=wise&wise_bands=${band}&type=jpgurl`;
    const fig = (band, label) => h('figure', { style: { margin: 0, flex: '1 1 220px' } },
      h('img', { src: img(band), alt: `WISE ${label} image of this field`, loading: 'lazy', style: { width: '100%', aspectRatio: '1', objectFit: 'cover', background: '#05061a', borderRadius: '8px' }, onerror: (e) => { e.currentTarget.replaceWith(h('p', { class: 'notice warn tiny' }, 'IRSA did not return this image right now.')); } }),
      h('figcaption', { class: 'tiny' }, `WISE ${label} (AllWISE, 2010), ${size}′ field`));
    sheet(h('div', { class: 'grid' },
      h('h2', {}, 'This field in NASA’s WISE images'),
      note ? h('p', { class: 'notice warn' }, note) : null,
      h('p', { class: 'tiny muted' }, 'WISE mapped the whole sky at 3.4 and 4.6 µm in 2010, about 15 years before SPHEREx. Compare positions to see what has moved; north is up and east left in both.'),
      h('div', { class: 'row', style: { gap: '10px', alignItems: 'flex-start' } }, fig(1, 'W1 3.4 µm'), fig(2, 'W2 4.6 µm')),
      h('div', { class: 'row' },
        h('a', { class: 'btn small', target: '_blank', rel: 'noopener noreferrer', href: `https://irsa.ipac.caltech.edu/applications/finderchart/servlet/api?mode=getResult&UserTargetWorldPt=${req.target.ra.toFixed(6)};${req.target.dec.toFixed(6)};EQ_J2000&subsize=${(size / 60).toFixed(3)}&survey=WISE` }, 'Open in IRSA Finder Chart'),
        h('a', { class: 'btn small', target: '_blank', rel: 'noopener noreferrer', href: wiseLink.href }, 'Try WiseView anyway')),
      h('p', { class: 'tiny muted' }, 'Images: NASA/JPL-Caltech/UCLA (WISE), served by IRSA Finder Chart.')), { label: 'NASA WISE images of this field' });
  }

  function explain() {
    if (explainBox.hidden) return;
    const D = S.display;
    const dets = req.dets.map((d) => `D${d}`).join(', ');
    explainBox.replaceChildren(
      h('b', {}, 'What you are seeing: '),
      `${D?.frames.length || 0} frames of ${req.fov}′ × ${req.fov}′ of sky centred on ${name}, north up and east left. `,
      req.group === 'survey' ? 'Each frame adds together every exposure from one six-month pass of the sky (SPHEREx maps the whole sky twice a year). ' : req.group === 'day' ? 'Each frame adds the exposures taken within one day. ' : 'Each frame is a single SPHEREx exposure at one wavelength. ',
      `Detectors used: ${dets}. `,
      { expr: `Each frame is your equation “${req.expr}” evaluated on that epoch’s images. `, movie: 'Play it: things that move between passes, like nearby stars, brown dwarfs and asteroids, shift position. ', blink: 'Two epochs flip back and forth; a moving object jumps while everything else stays still — the method used to discover Pluto. ', diff: 'A reference epoch is subtracted using the same detector arrays: still stars cancel to grey, a moving object leaves a dark/bright pair, and a brightening object leaves a bright spot. ', stack: 'Epochs are added cumulatively, so the noise drops and faint objects appear as more data are stacked. ', color: 'Short wavelengths are blue, middle green, long red: very cold objects such as brown dwarfs look red, hot stars blue. ' }[req.mode],
      `Brightness uses one ${req.stretch} stretch shared by all frames, so brightness changes are honest. `,
      req.track ? 'Frames are shifted along the target’s proper motion, so the target stays still and background stars drift. ' : '',
      'The yellow crosshair marks the target; the dashed line is its predicted track from its proper motion.');
  }
  function shareDialog() {
    const url = new URL(location.href);
    const qs = toParams(normalise({ ...req, t: S.frame }));
    const page = `${url.origin}${url.pathname}`;
    const link = `${page}?${qs}`;
    const embedQs = new URLSearchParams(qs); embedQs.set('embed', '1');
    const iframe = `<iframe src="${page}?${embedQs}" width="640" height="720" style="border:0;border-radius:12px" loading="lazy" title="SkyShift: SPHEREx view of ${name.replace(/"/g, '')}" allow="fullscreen" referrerpolicy="strict-origin-when-cross-origin"></iframe>`;
    const box = (label, text) => {
      const ta = h('textarea', { readonly: true, rows: 3, 'aria-label': label }, text);
      return h('label', { class: 'field' }, label, ta, h('button', { class: 'btn small', onclick: async () => { const ok = await copyText(text); toast({ title: ok ? 'Copied' : 'Copy failed — select and copy manually', timeout: 2000, glyph: '📋' }); } }, 'Copy'));
    };
    sheet(h('div', { class: 'grid' }, h('h2', {}, 'Share or embed this view'),
      h('p', { class: 'muted' }, 'The link holds the whole view (position, field, detectors, mode, stretch, overlays and frame), so others see exactly what you see.'),
      box('Link', link), box('Embed code (iframe)', iframe),
      h('p', { class: 'tiny' }, 'URL parameters: ra, dec (degrees or sexagesimal), fov (arcmin), det (e.g. 456), wl (e.g. 3-4), group (exposure|day|survey), mode (movie|blink|diff|stack|color), stretch, lo, hi, invert, cmap, speed (ms), track, ov, t, embed. WiseView-style size, speed, invert, diff, linear, gaia, window, pmra, pmdec are accepted too. Full list on the Learn page.'),
      navigator.share ? h('button', { class: 'btn primary', onclick: () => navigator.share({ title: `SkyShift: ${name}`, url: link }).catch(() => {}) }, 'Share…') : null), { label: 'Share or embed' });
  }
  function tour() {
    const steps = [[stage, 'This is the sky around your target. Drag to pan when zoomed, scroll or pinch to zoom, click anything to inspect it.'],
      [playBtn, 'Press Play to watch the images like a film. ← and → step through frames.'], [modeSeg, 'Switch between Movie, Blink, Difference, Stack and false Colour.'],
      [tabsBar, 'Change detectors, field of view and overlays, and open the spectrum, light curve, flags and discovery helpers here.'], [shareBtn, 'Share a link or embed this exact view in another website.']];
    let k = 0;
    const ring = h('div', { class: 'tour-ring' });
    const box = h('div', { class: 'tour', role: 'dialog', 'aria-label': 'Guided tour' });
    document.body.append(ring, box);
    const end = () => { ring.remove(); box.remove(); localStorage.setItem('skyshift.toured', '1'); S.endTour = null; };
    S.endTour = end;
    const show = () => {
      if (k >= steps.length) return end();
      const [el, text] = steps[k];
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setTimeout(() => {
        const r = el.getBoundingClientRect();
        Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
        box.replaceChildren(h('p', {}, text), h('div', { class: 'row' }, h('span', { class: 'tiny' }, `${k + 1}/${steps.length}`), h('div', { class: 'spacer' }),
          h('button', { class: 'btn small ghost', onclick: end }, 'Skip'), h('button', { class: 'btn small primary', onclick: () => { k++; show(); } }, k === steps.length - 1 ? 'Done' : 'Next')));
        const top = r.bottom + 12 + 160 < innerHeight ? r.bottom + 12 : Math.max(12, r.top - 172);
        Object.assign(box.style, { left: `${Math.min(innerWidth - 352, Math.max(12, r.left))}px`, top: `${top}px` });
        box.querySelector('.primary').focus();
      }, 250);
    };
    show();
  }

  // ------------------------------------------------------------------ exports
  const fileStem = () => (req.target.name || `${req.target.ra.toFixed(4)}_${req.target.dec.toFixed(4)}`).replace(/[^\w.-]+/g, '_');
  function photCSV(pts) {
    const head = 'mjd,utc,detector,wavelength_um,bandwidth_um,flux_uJy,err_uJy,n_bad_pixels,flags,release,file\n';
    return head + pts.map((p) => [p.mjd?.toFixed(6), mjdToISO(p.mjd), p.det ?? p.detector, p.wavelength?.toFixed(5), p.bandwidth?.toFixed(5), p.flux?.toFixed(2), p.err?.toFixed(2), p.nbad, decodeFlags(p.flags || 0).join('|'), p.release, p.uri?.split('/').pop()].join(',')).join('\n');
  }
  function composite() {
    const W = imgCanvas.width;
    const c = document.createElement('canvas'); c.width = W; c.height = W + 60 * (devicePixelRatio || 1);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#05061a'; ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(imgCanvas, 0, 0); ctx.drawImage(ovCanvas, 0, 0);
    const d = devicePixelRatio || 1;
    ctx.fillStyle = '#eef0ff'; ctx.font = `${14 * d}px system-ui`;
    ctx.fillText(`${name} · ${frameLabel.textContent}`.slice(0, 120), 10 * d, W + 22 * d);
    ctx.fillStyle = '#9aa0d0'; ctx.font = `${12 * d}px system-ui`;
    ctx.fillText('SPHEREx data: NASA/IPAC IRSA · made with SkyShift', 10 * d, W + 44 * d);
    return c;
  }
  function exportPNG() { composite().toBlob((b) => b && download(`skyshift-${fileStem()}-frame${currentIndex() + 1}.png`, b, 'image/png')); }
  async function exportGIF() {
    const D = S.display;
    if (!D?.frames.length) return;
    stopPlay();
    const { encodeGIF } = await import('../lib/gif.js');
    const keep = S.frame, phase = S.blinkPhase;
    const N = req.mode === 'blink' ? 2 : Math.min(D.frames.length, 60);
    const shots = [];
    for (let k = 0; k < N; k++) {
      if (req.mode === 'blink') S.blinkPhase = k; else S.frame = k;
      draw();
      const c = composite();
      const small = document.createElement('canvas');
      const sc = Math.min(1, 520 / c.width);
      small.width = Math.round(c.width * sc); small.height = Math.round(c.height * sc);
      small.getContext('2d').drawImage(c, 0, 0, small.width, small.height);
      shots.push(small);
    }
    S.frame = keep; S.blinkPhase = phase; draw();
    download(`skyshift-${fileStem()}.gif`, encodeGIF(shots, req.speed));
  }

  async function exportVideo() {
    const D = S.display;
    if (!D?.frames.length || !window.MediaRecorder) { toast({ title: 'Video export is not supported in this browser', glyph: '🎞', timeout: 3000 }); return; }
    stopPlay();
    const c = composite();
    const stream = c.captureStream(30);
    const type = ['video/webm;codecs=vp9', 'video/webm', 'video/mp4'].find((t) => MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    rec.onstop = () => download(`skyshift-${fileStem()}.${(type || 'video/webm').includes('mp4') ? 'mp4' : 'webm'}`, new Blob(chunks, { type: type || 'video/webm' }));
    rec.start();
    toast({ title: 'Recording the animation…', glyph: '🎬', timeout: 2500 });
    const N = req.mode === 'blink' ? 6 : D.frames.length;
    for (let k = 0; k < N; k++) {
      step(1);
      const fresh = composite();
      c.getContext('2d').drawImage(fresh, 0, 0);
      await new Promise((r) => setTimeout(r, req.speed));
    }
    rec.stop();
  }

  // ------------------------------------------------------------------ lifecycle
  const ro = new ResizeObserver(() => { stageWidth = stage.getBoundingClientRect().width; draw(); });
  ro.observe(stage);
  const onNewData = () => { if (S.search) { S.search = null; load(); } };
  window.addEventListener('skyshift:newdata', onNewData);
  window.addEventListener('skyshift:online', onNewData);
  renderModes(); renderTabs(); renderSide();
  ensureCats();
  load();
  if (!localStorage.getItem('skyshift.toured') && !req.embed) S.tourTimer = setTimeout(() => toast({ title: 'New here?', text: 'Take a 20-second tour of the viewer.', glyph: '🧭', actions: [{ label: 'Start tour', primary: true, onClick: tour }, { label: 'No thanks', onClick: () => localStorage.setItem('skyshift.toured', '1') }], timeout: 9000 }), 1500);

  // When only view parameters change (e.g. Back/Forward), update in place and keep the loaded frames.
  live.update = (r) => {
    const next = normalise(fromParams(r.params));
    if (!next.target) return false;
    const sameTarget = Math.abs(next.target.ra - req.target.ra) < 1e-7 && Math.abs(next.target.dec - req.target.dec) < 1e-7;
    if (!sameTarget) return false;
    const prevKey = loadKey();
    req = { ...next, target: { ...req.target, ...next.target } };
    renderModes(); renderTabs(); renderSide();
    if (loadKey() !== prevKey) load(); else rebuild();
    return true;
  };

  return () => {
    // results still on their way (searches, frames) belong to a page that is gone: make every check against the
    // current load or job fail, so nothing starts streaming after leaving
    S.loadId++; S.jobId++;
    stopPlay(); ro.disconnect(); clearInterval(S.userTimer);
    clearTimeout(S.tourTimer); S.endTour?.();
    if (worker && S.streamListener) worker.removeEventListener('message', S.streamListener);
    if (worker && S.specHandler) worker.removeEventListener('message', S.specHandler);
    document.removeEventListener('keydown', onKey);
    window.removeEventListener('skyshift:newdata', onNewData);
    window.removeEventListener('skyshift:online', onNewData);
    worker?.postMessage({ type: 'abort' });
    live.update = null;
  };
}

const live = { update: null };
/** Called by the router when only the URL parameters of this page changed. Returns false to request a full render. */
export function update(r) {
  return live.update ? live.update(r) : false;
}

function renderEmpty(root, go) {
  root.append(h('div', { class: 'card empty' },
    h('h1', {}, 'Choose a patch of sky'),
    h('p', {}, 'Open a challenge target from the home page, type coordinates, or add ?ra=…&dec=… to the address.'),
    h('div', { class: 'row', style: { justifyContent: 'center' } },
      h('a', { class: 'btn primary', href: '#/' }, 'Go to search'),
      h('a', { class: 'btn', href: '#/view?ra=133.786245&dec=-7.244372&name=WISE%200855%E2%88%920714&id=wise0855&det=456&mode=blink' }, 'Try WISE 0855'))));
  return () => {};
}
