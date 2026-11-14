// Interface text lookup. English first; other languages plug in as extra files.
import en from './en.js';
import el from './el.js';
import es from './es.js';
import fr from './fr.js';
export const LANGS = {
  en: { name: 'English', strings: en },
  el: { name: 'Ελληνικά (Greek, interface menus)', strings: el },
  es: { name: 'Español (Spanish, interface menus)', strings: es },
  fr: { name: 'Français (French, interface menus)', strings: fr },
};
let current = en;
// The page stays marked as English (most of its text is), so browsers offer a correct full-page translation from
// English; SkyShift's own translated labels are marked with their language where they appear (src/i18n/apply.js).
export function setLang(code) { current = LANGS[code]?.strings || en; document.documentElement.lang = 'en'; document.documentElement.dataset.uiLang = LANGS[code] ? code : 'en'; }
export const t = (key) => current[key] ?? en[key] ?? key;
