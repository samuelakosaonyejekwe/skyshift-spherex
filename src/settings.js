// User settings (kept on this device).
const KEY = 'skyshift.settings';
export const DEFAULT_SETTINGS = Object.freeze({
  fov: 6, // default field of view (arcmin)
  maxImages: 120, // images per target (spread across epochs and detectors); 0 = all
  readMode: 'auto', // auto | saver | fast
  mask: true, // remove bad pixels using SPHEREx quality flags in photometry
  reduceMotion: false, // no auto-play
  theme: null, // 'dark' | 'light' | null (follow system)
});
export function getSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; }
}
export function setSettings(patch) {
  const s = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(s));
  window.dispatchEvent(new CustomEvent('skyshift:settings', { detail: s }));
  return s;
}
/** Effective read mode: Auto switches to data saver on Save-Data or slow connections. */
export function effectiveReadMode() {
  const s = getSettings();
  if (s.readMode !== 'auto') return s.readMode;
  const c = navigator.connection;
  if (c && (c.saveData || /(^|-)2g|3g/.test(c.effectiveType || ''))) return 'saver';
  return 'auto';
}
export function applyTheme() {
  const t = getSettings().theme || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  document.documentElement.dataset.theme = t;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', t === 'light' ? '#f4f6ff' : '#0b0e24');
  return t;
}
