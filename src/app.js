// SkyShift application shell: router with history-aware Back/Forward arrows, install
// flow for every platform, service-worker updates, connection status and data freshness.

import { h, toast, sheet, icon } from './ui/dom.js';
import { loadConfig, onNetStatus, netStatus } from './lib/net.js';
import { fromParams } from './state.js';

const ROUTES = {
  home: () => import('./views/home.js'),
  view: () => import('./views/viewer.js'),
  sky: () => import('./views/sky.js'),
  saved: () => import('./views/saved.js'),
  sources: () => import('./views/sources.js'),
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
export function go(hash, { replace = false } = {}) {
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

export function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, qs = ''] = raw.split('?');
  const name = path.split('/')[0] || 'home';
  return { name: ROUTES[name] ? name : 'home', sub: path.split('/').slice(1), params: new URLSearchParams(qs) };
}

async function route() {
  syncArrows();
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
    main.replaceChildren();
    const dispose = await mod.render(main, r, { go });
    current = { name: r.name, mod, dispose };
    const title = mod.title ? `${mod.title} · SkyShift` : 'SkyShift: A Time Machine for the SPHEREx Sky';
    document.title = title;
    if (!r.params.toString()) main.focus({ preventScroll: true });
    window.scrollTo({ top: 0 });
  } catch (e) {
    console.error(e);
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

// ---------------- connection pill ----------------
const pill = document.getElementById('netpill');
function syncNet(s = netStatus) {
  const on = navigator.onLine;
  pill.classList.toggle('off', !on);
  pill.textContent = on ? (s.relay === null && s.lastError ? 'Online · archive relay unavailable' : 'Online · live data') : 'Offline · saved data';
  pill.title = on ? 'Fresh data is fetched live from the archives' : 'No connection: showing data saved on this device';
}
onNetStatus(syncNet);
window.addEventListener('online', () => { syncNet(); toast({ title: 'Back online', text: 'Live SPHEREx data is available again. Views refresh automatically.', glyph: '🛰', timeout: 4000 }); window.dispatchEvent(new CustomEvent('skyshift:online')); });
window.addEventListener('offline', () => { syncNet(); toast({ title: 'You are offline', text: 'SkyShift keeps working with the fields and data saved on this device.', glyph: '✈', timeout: 6000 }); });

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
export function showInstallSheet() {
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
      h('div', {}, h('h2', { style: { margin: 0 } }, 'Install SkyShift'), h('p', { class: 'muted', style: { margin: 0 } }, 'Free, no account, about 1 MB. Works in airplane mode.'))),
    h('ol', { class: 'install-steps' }, steps.map(([g, t]) => h('li', {}, g, h('span', {}, t)))),
    h('button', { class: 'btn primary', style: { width: '100%' }, onclick: () => close() }, 'Got it')), { label: 'How to install SkyShift' });
}

// ---------------- service worker: offline + update pop-up ----------------
async function setupSW() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  try {
    const reg = await navigator.serviceWorker.register('./sw.js', { scope: './' });
    const promptUpdate = (worker) => {
      toast({
        kind: 'update', glyph: '✨', timeout: 0,
        title: 'A new version of SkyShift is ready',
        text: 'Update now to get the latest features. Your current view is kept.',
        actions: [{ label: 'Update now', primary: true, onClick: () => worker.postMessage({ type: 'SKIP_WAITING' }) }, { label: 'Later' }],
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
      if (reloading || !hadController) return; // first install: nothing to refresh
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
  await loadConfig();
  syncNet();
  route();
  setupSW();
  setTimeout(checkNewData, 4000);
  setInterval(checkNewData, 60 * 60 * 1000);
  window.addEventListener('skyshift:online', checkNewData);
})();

export { icon };
