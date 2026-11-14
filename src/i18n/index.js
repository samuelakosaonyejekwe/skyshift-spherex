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
export function setLang(code) { current = LANGS[code]?.strings || en; document.documentElement.lang = LANGS[code] ? code : 'en'; }
export const t = (key) => current[key] ?? en[key] ?? key;
