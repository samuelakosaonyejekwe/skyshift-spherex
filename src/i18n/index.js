// Interface text lookup. English first; other languages plug in as extra files.
import en from './en.js';
export const LANGS = { en: { name: 'English', strings: en } };
let current = en;
export function setLang(code) { current = LANGS[code]?.strings || en; document.documentElement.lang = LANGS[code] ? code : 'en'; }
export const t = (key) => current[key] ?? en[key] ?? key;
