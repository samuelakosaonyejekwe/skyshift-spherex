// Applies the interface phrases of src/i18n/ui.js on screen: exact phrases in text nodes (and input
// placeholders) are swapped, including content added later, so page code stays in English. Text inside code,
// textareas and elements marked data-no-tr is left alone; anything not in the list stays in English.
import { UI } from './ui.js';
import { rulesFor } from './patterns.js';
import { LANGS } from './index.js';
import en from './en.js';

let phrases = null, patterns = [], rules = [], observer = null, lang = 'en';

// texts this module wrote: never translated again, so a rule can never act on its own output
const done = new Set();

function tr(text) {
  const k = text.trim();
  if (!k || done.has(k)) return null;
  let v = phrases[k];
  if (v == null) for (const [re, rep] of patterns) if (re.test(k)) { v = k.replace(re, rep); break; }
  if (v == null) { let r = k; for (const [re, rep] of rules) r = r.replace(re, rep); if (r !== k) v = r; }
  if (v == null || v === k) return null;
  if (done.size > 20000) done.clear();
  done.add(v);
  return text.replace(k, v);
}

const ATTRS = ['placeholder', 'title', 'aria-label', 'label'];
const skip = (el) => !el || el.closest('script, style, textarea, code, pre, [data-no-tr]');

// a translated label carries its language, so browser translators leave it alone and screen readers pronounce it right
const mark = (el) => { if (el && el.lang !== lang) el.lang = lang; };

function translateNode(n) {
  if (n.nodeType === 3) { if (!skip(n.parentElement)) { const v = tr(n.nodeValue); if (v != null) { n.nodeValue = v; mark(n.parentElement); } } return; }
  if (n.nodeType !== 1 || skip(n)) return;
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
  const texts = []; while (w.nextNode()) texts.push(w.currentNode);
  for (const t of texts) if (!skip(t.parentElement)) { const v = tr(t.nodeValue); if (v != null) { t.nodeValue = v; mark(t.parentElement); } }
  for (const el of [n, ...n.querySelectorAll('[placeholder], [title], [aria-label], option[label]')]) for (const a of ATTRS) {
    const cur = el.getAttribute(a); if (cur) { const v = tr(cur); if (v != null) el.setAttribute(a, v); }
  }
}

/** Start translating the page into `code` (en = none). Call once at start-up; a language change reloads. */
export async function applyUiLanguage(code) {
  observer?.disconnect(); observer = null;
  const set = UI[code];
  if (!set) { phrases = null; return; }
  // page texts live in one file per language, so only the chosen language is downloaded
  let pages = {};
  try { pages = (await import(`./pages/${code}.js`)).default; } catch { /* menus and buttons still translate */ }
  // the short labels of src/i18n/<lang>.js too, wherever the same English text appears on a page
  const own = LANGS[code]?.strings || {};
  const short = Object.fromEntries(Object.entries(en).filter(([k]) => own[k]).map(([k, v]) => [v, own[k]]));
  // keys are matched on trimmed text, so a phrase written with a trailing space still matches
  phrases = Object.fromEntries(Object.entries({ ...short, ...pages, ...set.phrases }).map(([k, v]) => [k.trim(), v.trim()])); patterns = set.patterns || []; rules = rulesFor(code); lang = code;
  // labels translated through src/i18n/<lang>.js (menu bar, status pill, install button)
  document.querySelectorAll('#mainnav, #netpill, #installBtn, .footer').forEach(mark);
  translateNode(document.body);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { if (!skip(m.target)) { const cur = m.target.getAttribute(m.attributeName); const v = cur && tr(cur); if (v != null) m.target.setAttribute(m.attributeName, v); } }
      else if (m.type === 'characterData') translateNode(m.target);
      else m.addedNodes.forEach(translateNode);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
}
