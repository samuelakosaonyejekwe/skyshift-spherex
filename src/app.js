// SkyShift application shell: router with history-aware Back/Forward arrows, install
// flow for every platform, service-worker updates, connection status and data freshness.

import { closeSheets, h, toast, sheet } from './ui/dom.js';
import { loadConfig, onNetStatus, netStatus } from './lib/net.js';
import { fromParams } from './state.js';
import { getSettings, setSettings, applyTheme } from './settings.js';
import { t, setLang, LANGS } from './i18n/index.js';
import { applyUiLanguage } from './i18n/apply.js';

const ROUTES = {
  home: () => import('./views/home.js'),
  view: () => import('./views/viewer.js'),
  sky: () => import('./views/sky.js'),
  saved: () => import('./views/saved.js'),
  sources: () => import('./views/sources.js'),
  chase: () => import('./views/chase.js'),
  live: () => import('./views/live.js'),
  mission: () => import('./views/mission.js'),
  guide: () => import('./views/guide.js'),
  about: () => import('./views/about.js'),
};

const main = document.getElementById('main');
let current = null; // { name, mod, dispose }
let renderSeq = 0;

// ---------------- history index (drives the arrow buttons) ----------------
const navBack = document.getElementById('navBack');
const navFwd = document.getElementById('navFwd');
let maxIdx = Number(sessionStorage.getItem('skyshift.maxIdx') || 0);
function idx() { return history.state?.idx ?? 0; }
function syncArrows() {
  navBack.disabled = idx() <= 0;
  navFwd.disabled = idx() >= maxIdx;
}
if (history.state?.idx == null) history.replaceState({ idx: 0 }, '');

/** Navigate to a hash route. replace=true updates the URL without a new history entry. */
function go(hash, { replace = false } = {}) {
  if (!hash.startsWith('#')) hash = '#' + hash;
  if (location.hash === hash) return;
  if (replace) history.replaceState({ idx: idx() }, '', hash);
  else {
    const n = idx() + 1;
    history.pushState({ idx: n }, '', hash);
    maxIdx = n; sessionStorage.setItem('skyshift.maxIdx', String(maxIdx));
  }
  route();
}
window.addEventListener('popstate', () => { route(); });
window.addEventListener('hashchange', () => { if (history.state?.idx == null) route(); });
navBack.addEventListener('click', () => history.back());
navFwd.addEventListener('click', () => history.forward());
document.addEventListener('keydown', (e) => {
  if (e.altKey && e.key === 'ArrowLeft' && !navBack.disabled) { e.preventDefault(); history.back(); }
  if (e.altKey && e.key === 'ArrowRight' && !navFwd.disabled) { e.preventDefault(); history.forward(); }
});
// edge swipe on touch screens: from the left edge = back, from the right edge = forward
let sx = null, sy = null, edge = null;
window.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  edge = t.clientX < 24 ? 'l' : t.clientX > innerWidth - 24 ? 'r' : null;
  sx = t.clientX; sy = t.clientY;
}, { passive: true });
window.addEventListener('touchend', (e) => {
  if (!edge || sx == null) return;
  const t = e.changedTouches[0], dx = t.clientX - sx, dy = Math.abs(t.clientY - sy);
  if (dy < 60 && edge === 'l' && dx > 80 && !navBack.disabled) history.back();
  if (dy < 60 && edge === 'r' && dx < -80 && !navFwd.disabled) history.forward();
  edge = null;
}, { passive: true });

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const ALIAS = { tm: 'view', explore: 'home', learn: 'guide' };
  const first = path.split('/')[0] || 'home';
  const name = ALIAS[first] || first;
  return { name: ROUTES[name] ? name : 'home', sub: path.split('/').slice(1), params: new URLSearchParams(qs) };
}

let lastIdx = history.state?.idx ?? 0;
async function route() {
  // entries created by plain links (<a href="#/…">) have no index yet: give them the next one
  if (history.state?.idx == null) {
    const n = lastIdx + 1;
    history.replaceState({ idx: n }, '');
    maxIdx = n; sessionStorage.setItem('skyshift.maxIdx', String(maxIdx));
  }
  lastIdx = idx();
  syncArrows();
  // dialogs belong to the page that opened them: close any that are still open
  closeSheets();
  document.querySelectorAll('.tour, .tour-ring').forEach((el) => el.remove());
  const backdrop = document.getElementById('sheetBackdrop'); if (backdrop) backdrop.hidden = true;
  if (applyPendingUpdate()) return; // reloads into the new version at the requested page
  const seq = ++renderSeq;
  const r = parseHash();
  document.querySelectorAll('#mainnav a').forEach((a) => { if (a.dataset.route !== r.name) a.removeAttribute('aria-current'); else a.setAttribute('aria-current', 'page'); });
  closeMenu();
  // Same view, only parameters changed: let the view update itself (keeps loaded data).
  if (current && current.name === r.name && current.mod.update && current.mod.update(r) !== false) return;
  try {
    const mod = await ROUTES[r.name]();
    if (seq !== renderSeq) return;
    current?.dispose?.();
    // each page renders into its own container: a slow page that finishes after the user has
    // moved on writes into a detached container and can never leak into the next page
    const view = h('div', { class: 'view', 'data-view': r.name });
    main.replaceChildren(view);
    const dispose = await mod.render(view, r, { go });
    if (seq !== renderSeq) { try { dispose?.(); } catch { /* ignore */ } return; }
    current = { name: r.name, mod, dispose };
    const title = mod.title ? `${mod.title} · SkyShift` : 'SkyShift: A Time Machine for the SPHEREx Sky';
    document.title = title;
    sessionStorage.removeItem('skyshift.recovered');
    if (!r.params.toString()) main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (e) {
    console.error(e);
    // A module that fails to load is almost always a stale offline copy: refresh it once automatically.
    if (!sessionStorage.getItem('skyshift.recovered') && navigator.onLine) {
      sessionStorage.setItem('skyshift.recovered', '1');
      try {
        // a clean reinstall: unregister the worker and drop its caches; the reload installs and precaches afresh
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.unregister();
        if (window.caches) for (const k of await caches.keys()) if (k.startsWith('skyshift-shell-') || k === 'skyshift-runtime-v1') await caches.delete(k);
      } catch { /* ignore */ }
      location.reload();
      return;
    }
    main.replaceChildren(h('div', { class: 'card notice bad' },
      h('h2', {}, 'This page could not be loaded'),
      h('p', {}, navigator.onLine ? 'Something went wrong while opening this page. Reloading usually fixes it.' : 'You are offline and this page has not been saved on this device yet.'),
      h('button', { class: 'btn primary', onclick: () => location.reload() }, 'Reload')));
  }
}

// ---------------- menu ----------------
const menuBtn = document.getElementById('menuBtn');
const nav = document.getElementById('mainnav');
function closeMenu() { nav.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); }
menuBtn.addEventListener('click', () => {
  const open = !nav.classList.contains('open');
  nav.classList.toggle('open', open); menuBtn.setAttribute('aria-expanded', String(open));
});
document.addEventListener('click', (e) => { if (!nav.contains(e.target) && !menuBtn.contains(e.target)) closeMenu(); });
// compact menu when the screen is narrow or the menu bar does not fit on one line (measured in the full layout)
function fitNav() {
  const root = document.documentElement;
  if (window.innerWidth <= 900) { root.classList.add('nav-compact'); return; }
  root.classList.remove('nav-compact');
  // the bar is centred, so overflow spills past both edges: compare the first and last links with the bar's box
  const box = nav.getBoundingClientRect(), links = nav.querySelectorAll('a');
  const first = links[0]?.getBoundingClientRect(), last = links[links.length - 1]?.getBoundingClientRect();
  if (first && last && (first.left < box.left - 1 || last.right > box.right + 1 || last.right > window.innerWidth)) root.classList.add('nav-compact');
  else closeMenu();
}
let fitT = 0;
window.addEventListener('resize', () => { clearTimeout(fitT); fitT = setTimeout(fitNav, 100); });

// ---------------- connection pill ----------------
const pill = document.getElementById('netpill');
function syncNet(s = netStatus) {
  const on = navigator.onLine;
  pill.classList.toggle('off', !on);
  pill.textContent = on ? (s.relay === null && s.lastError ? t('net.relayDown') : t('net.online')) : t('net.offline');
  pill.title = on ? 'Fresh data is fetched live from the archives' : 'No connection: showing data saved on this device';
}
onNetStatus(syncNet);
window.addEventListener('online', () => { syncNet(); toast({ title: t('toast.online.title'), text: t('toast.online.text'), glyph: '🛰', timeout: 4000 }); window.dispatchEvent(new CustomEvent('skyshift:online')); });
window.addEventListener('offline', () => { syncNet(); toast({ title: t('toast.offline.title'), text: t('toast.offline.text'), glyph: '✈', timeout: 6000 }); });

// ---------------- install (all platforms) ----------------
const installBtn = document.getElementById('installBtn');
let deferredPrompt = null;
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (!standalone()) installBtn.hidden = false;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false; });
window.addEventListener('appinstalled', () => {
  installBtn.hidden = true; deferredPrompt = null;
  toast({ title: 'SkyShift is installed', text: 'Open it from your home screen or app list. It works offline too.', glyph: '🚀' });
});
installBtn.addEventListener('click', async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice.catch(() => ({}));
    if (outcome === 'accepted') installBtn.hidden = true;
    deferredPrompt = null;
    return;
  }
  showInstallSheet();
});
function showInstallSheet() {
  const glyph = (d) => {
    const NS = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(NS, 'svg'); s.setAttribute('viewBox', '0 0 24 24');
    const p = document.createElementNS(NS, 'path'); p.setAttribute('d', d); s.appendChild(p);
    return h('span', { class: 'glyph', 'aria-hidden': 'true' }, s);
  };
  const SHARE = 'M12 3v12M8 7l4-4 4 4M5 12v8h14v-8';
  const PLUS = 'M4 4h16v16H4zM12 8v8M8 12h8';
  const DOTS = 'M12 5h.01M12 12h.01M12 19h.01';
  let steps;
  if (isIOS) {
    steps = [[glyph(SHARE), 'Tap the Share button in Safari (bottom bar on iPhone, top bar on iPad).'],
      [glyph(PLUS), 'Scroll and choose "Add to Home Screen".'],
      [glyph('M5 12l4 4 10-10'), 'Tap "Add". SkyShift opens full-screen and works offline.']];
  } else if (/firefox/i.test(navigator.userAgent) && !/android/i.test(navigator.userAgent)) {
    steps = [[glyph(DOTS), 'Firefox on computers does not install web apps. Bookmark SkyShift, or open it in Chrome, Edge or Safari to install.'],
      [glyph('M5 12l4 4 10-10'), 'Every page you open is still saved for offline use.']];
  } else {
    steps = [[glyph(DOTS), 'Open your browser menu (⋮ or …).'],
      [glyph(PLUS), 'Choose "Install app", "Install SkyShift" or "Add to Home screen".'],
      [glyph('M5 12l4 4 10-10'), 'Confirm. SkyShift gets its own icon and works offline.']];
  }
  const close = sheet(h('div', {},
    h('div', { class: 'row' }, h('img', { src: 'icons/icon-192.png', width: 56, height: 56, alt: '' }),
      h('div', {}, h('h2', { style: { margin: 0 } }, 'Install SkyShift'), h('p', { class: 'muted', style: { margin: 0 } }, 'Free, no account, about 2 MB with its offline files. Works in airplane mode.'))),
    h('ol', { class: 'install-steps' }, steps.map(([g, t]) => h('li', {}, g, h('span', {}, t)))),
    h('button', { class: 'btn primary', style: { width: '100%' }, onclick: () => close() }, 'Got it')), { label: 'How to install SkyShift' });
}

// ---------------- service worker: offline + update pop-up ----------------
let pendingWorker = null, updateRequested = false;
/** Activate a waiting version and reload into it (view state lives in the URL, so nothing is lost). */
function doUpdate(worker) {
  updateRequested = true;
  pendingWorker = null;
  try { worker?.postMessage({ type: 'SKIP_WAITING' }); } catch { /* ignore */ }
  setTimeout(() => location.reload(), 2500); // fallback if the browser is slow to switch
}
function applyPendingUpdate() { if (pendingWorker) { doUpdate(pendingWorker); return true; } return false; }
async function setupSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    if (!reg) return; // registration refused (private mode, some embedded browsers): the app still runs online
    const promptUpdate = (worker) => {
      pendingWorker = worker; // also applied automatically at the next page change (the view lives in the URL)
      toast({
        kind: 'update', glyph: '✨', timeout: 0,
        title: t('update.title'),
        text: t('update.text'),
        actions: [{ label: t('update.now'), primary: true, onClick: () => doUpdate(worker) }, { label: t('update.later') }],
      });
    };
    if (reg.waiting && navigator.serviceWorker.controller) promptUpdate(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) promptUpdate(w);
      });
    });
    let reloading = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || (!hadController && !updateRequested)) return; // first install: nothing to refresh
      reloading = true;
      sessionStorage.setItem('skyshift.scroll', String(scrollY));
      location.reload(); // URL holds the full view state, so nothing is lost
    });
    const check = () => reg.update().catch(() => {});
    setInterval(check, 30 * 60 * 1000);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') check(); });
  } catch (e) { console.warn('Service worker unavailable', e); }
}

// ---------------- new SPHEREx data detection ----------------
async function checkNewData() {
  try {
    const { latestSpherex } = await import('./lib/tap.js');
    const { mjdToISO } = await import('./lib/coords.js');
    const r = await latestSpherex();
    if (r.source !== 'live' || !r.data) return;
    const seen = Number(localStorage.getItem('skyshift.newestSeen') || 0);
    localStorage.setItem('skyshift.newestMjd', String(r.data));
    if (seen && r.data > seen + 0.5) {
      toast({
        kind: 'update', glyph: '🛰', timeout: 0,
        title: 'New SPHEREx data is available',
        text: `IRSA now holds exposures up to ${mjdToISO(r.data, false)}. Reload the current field to include them.`,
        actions: [{ label: 'Update now', primary: true, onClick: () => { localStorage.setItem('skyshift.newestSeen', String(r.data)); window.dispatchEvent(new CustomEvent('skyshift:newdata')); } },
          { label: 'Later', onClick: () => localStorage.setItem('skyshift.newestSeen', String(r.data)) }],
      });
    } else if (!seen) localStorage.setItem('skyshift.newestSeen', String(r.data));
    const { checkWatchlist } = await import('./views/saved.js');
    checkWatchlist(r.data);
  } catch { /* offline or archive down: silently retry later */ }
}

// ---------------- language (interface text from src/i18n) ----------------
setLang(getSettings().lang || 'en');
{
  const keys = { home: 'nav.explore', view: 'nav.tm', chase: 'nav.chase', live: 'nav.live', mission: 'nav.mission', sky: 'nav.sky', saved: 'nav.saved', guide: 'nav.learn', about: 'nav.about' };
  document.querySelectorAll('#mainnav a').forEach((a) => { const sp = a.querySelector('span'); if (sp && keys[a.dataset.route]) sp.textContent = t(keys[a.dataset.route]); });
  document.querySelector('#installBtn span').textContent = t('top.install');
  navBack.setAttribute('aria-label', t('top.back')); navFwd.setAttribute('aria-label', t('top.forward'));
  document.getElementById('themeBtn').title = t('top.theme'); document.getElementById('settingsBtn').title = t('top.settings');
  applyUiLanguage(getSettings().lang || 'en'); // headings, buttons, tabs and labels on the pages
  fitNav(); // labels changed length
  document.fonts?.ready?.then(fitNav);
}

// ---------------- theme + settings ----------------
applyTheme();
document.getElementById('themeBtn').addEventListener('click', () => { const cur = document.documentElement.dataset.theme; setSettings({ theme: cur === 'light' ? 'dark' : 'light' }); applyTheme(); });
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', () => { if (!getSettings().theme) applyTheme(); });
document.getElementById('settingsBtn').addEventListener('click', () => {
  const s0 = getSettings();
  const sel = (key, opts) => h('select', { onchange: (e) => { setSettings({ [key]: isNaN(Number(e.target.value)) ? e.target.value : Number(e.target.value) }); if (key === 'lang') location.reload(); /* the address keeps the view */ } }, opts.map(([v, l]) => h('option', { value: v, selected: String(s0[key]) === String(v) }, l)));
  const chk = (key, label) => h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: !!s0[key], onchange: (e) => setSettings({ [key]: e.target.checked }) }), label);
  const close = sheet(h('div', { class: 'grid' },
    h('h2', {}, 'Settings'),
    h('label', { class: 'field' }, 'Default field of view for new targets', sel('fov', [[4, '4′ (small, fastest)'], [6, '6′ (default)'], [10, '10′'], [15, '15′'], [30, '30′ (large, more data)']])),
    h('label', { class: 'field' }, 'Images per target (spread across all epochs and detectors)', sel('maxImages', [[60, '60'], [120, '120 (default)'], [240, '240'], [480, '480'], [0, 'All']])),
    h('label', { class: 'field' }, 'Download mode', sel('readMode', [['auto', 'Auto: first images fastest, then data saver (switches to saver on slow or Save-Data connections)'], ['saver', 'Data saver: only the pixels needed (≈0.1 MB per image)'], ['fast', 'Fast: whole image rows (≈0.6 MB per image)']])),
    h('label', { class: 'field' }, 'Language (all pages and tabs)', sel('lang', Object.entries(LANGS).map(([k, v]) => [k, v.name]))),
    chk('mask', 'Remove bad pixels from measurements using SPHEREx quality flags'),
    chk('reduceMotion', 'Reduce motion (no automatic playback)'),
    chk('noShortcuts', 'Turn off single-key keyboard shortcuts (for screen-reader and switch users)'),
    h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => { close(); toast({ title: 'Settings saved', text: 'They apply to the next target you open.', glyph: '⚙', timeout: 2500 }); } }, 'Done'),
      h('button', { class: 'btn ghost', onclick: () => { localStorage.removeItem('skyshift.settings'); applyTheme(); close(); toast({ title: 'Settings reset', glyph: '⚙', timeout: 2000 }); } }, 'Reset to defaults'))), { label: 'Settings' });
});
// "/" focuses the search box (on Explore) from anywhere
document.addEventListener('keydown', (e) => {
  if (e.key !== '/' || e.target.matches('input, textarea, select') || getSettings().noShortcuts) return;
  e.preventDefault();
  const q = document.getElementById('q');
  if (q) q.focus(); else { go('#/'); setTimeout(() => document.getElementById('q')?.focus(), 400); }
});

// ---------------- boot ----------------
(async function boot() {
  // Top-level query (?ra=..&dec=..) is the embeddable form: open it in the viewer.
  const qp = new URLSearchParams(location.search);
  if ((qp.has('ra') && qp.has('dec')) || qp.has('target')) {
    const hash = `#/view?${qp.toString()}`;
    history.replaceState({ idx: 0 }, '', location.pathname + hash);
  }
  const embed = fromParams(parseHash().params).embed;
  document.documentElement.classList.toggle('embedded', !!embed);
  document.body.classList.toggle('embedded', !!embed);
  // the current page's code downloads while the configuration loads (phones: saves a round of requests)
  ROUTES[parseHash().name]?.().catch(() => {});
  await loadConfig();
  syncNet();
  if (history.state?.idx == null) history.replaceState({ idx: 0 }, '');
  lastIdx = idx();
  route();
  setupSW();
  setTimeout(checkNewData, 4000);
  // warm up the other pages in the background so switching is instant
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  idle(() => Object.values(ROUTES).forEach((load) => load().catch(() => {})));
  setInterval(checkNewData, 60 * 60 * 1000);
  window.addEventListener('skyshift:online', checkNewData);
})();

