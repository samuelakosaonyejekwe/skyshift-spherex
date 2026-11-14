// Applies the interface phrases of src/i18n/ui.js on screen: exact phrases in text nodes (and input
// placeholders) are swapped, including content added later, so page code stays in English. Text inside code,
// textareas and elements marked data-no-tr is left alone; anything not in the list stays in English.
import { UI } from './ui.js';

let phrases = null, patterns = [], observer = null;

function tr(text) {
  const k = text.trim();
  if (!k) return null;
  let v = phrases[k];
  if (v == null) for (const [re, rep] of patterns) if (re.test(k)) { v = k.replace(re, rep); break; }
  return v == null || v === k ? null : text.replace(k, v);
}

const skip = (el) => !el || el.closest('script, style, textarea, code, pre, [data-no-tr]');

function translateNode(n) {
  if (n.nodeType === 3) { if (!skip(n.parentElement)) { const v = tr(n.nodeValue); if (v != null) n.nodeValue = v; } return; }
  if (n.nodeType !== 1 || skip(n)) return;
  const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
  const texts = []; while (w.nextNode()) texts.push(w.currentNode);
  for (const t of texts) if (!skip(t.parentElement)) { const v = tr(t.nodeValue); if (v != null) t.nodeValue = v; }
  for (const el of [n, ...n.querySelectorAll('[placeholder]')]) if (el.placeholder) { const v = tr(el.placeholder); if (v != null) el.placeholder = v; }
}

/** Start translating the page into `code` (en = none). Call once at start-up; a language change reloads. */
export function applyUiLanguage(code) {
  observer?.disconnect(); observer = null;
  const set = UI[code];
  if (!set) { phrases = null; return; }
  phrases = set.phrases; patterns = set.patterns || [];
  translateNode(document.body);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'characterData') translateNode(m.target);
      else m.addedNodes.forEach(translateNode);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}
