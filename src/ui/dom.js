// Conditional UI pieces are written as `cond ? el : null`; make append/replaceChildren skip
// null/false/undefined instead of printing them as text.
for (const name of ['append', 'replaceChildren', 'prepend']) {
  for (const proto of [Element.prototype, DocumentFragment.prototype]) {
    const orig = proto[name];
    proto[name] = function (...nodes) { return orig.apply(this, nodes.flat(Infinity).filter((n) => n != null && n !== false)); };
  }
}

// Safe DOM helpers: content is always set with textContent / attributes, never innerHTML
// from data, so text from archives, URLs or users cannot inject markup.

export function h(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(e.style, v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(e.dataset, v);
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    e.appendChild(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return e;
}

const ICONS = {
  play: 'M8 5v14l11-7z',
  pause: 'M7 5h4v14H7zM13 5h4v14h-4z',
  prev: 'M6 5v14M18 5l-9 7 9 7z',
  next: 'M18 5v14M6 5l9 7-9 7z',
  share: 'M4 12v7a1 1 0 001 1h14a1 1 0 001-1v-7M16 6l-4-4-4 4M12 2v14',
  download: 'M12 3v12m0 0l-5-5m5 5l5-5M5 21h14',
  star: 'M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z',
  info: 'M12 8h.01M11 12h1v5h1M12 3a9 9 0 100 18 9 9 0 000-18z',
  close: 'M6 6l12 12M18 6L6 18',
  refresh: 'M20 11a8 8 0 10-2.3 5.7M20 4v7h-7',
  ruler: 'M3 17L17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2',
  target: 'M12 2v4M12 18v4M2 12h4M18 12h4M12 8a4 4 0 100 8 4 4 0 000-8z',
  dice: 'M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2zM8 8h.01M16 16h.01M12 12h.01M16 8h.01M8 16h.01',
  sky: 'M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18',
  video: 'M3 6h12v12H3zM15 10l6-4v12l-6-4z',
  bookmark: 'M6 3h12v18l-6-4-6 4z',
  help: 'M9.1 9a3 3 0 015.8 1c0 2-3 3-3 3M12 17h.01M12 3a9 9 0 100 18 9 9 0 000-18z',
};
export function icon(name) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || ICONS.info);
  if (name === 'play' || name === 'pause') { p.setAttribute('fill', 'currentColor'); p.setAttribute('stroke', 'none'); }
  s.appendChild(p);
  return s;
}

/** Attractive toast. actions: [{label, primary?, onClick}] ; returns close(). */
export function toast({ title, text, glyph = '✦', actions = [], timeout = 6000, kind = '' }) {
  const host = document.getElementById('toasts');
  let t;
  const close = () => { clearTimeout(t); el.style.opacity = '0'; setTimeout(() => el.remove(), 200); };
  const el = h('div', { class: `toast ${kind}`, role: kind === 'update' ? 'alertdialog' : 'status', 'aria-label': title },
    h('div', { class: 'ti', 'aria-hidden': 'true' }, glyph),
    h('div', { class: 'tb' }, h('b', {}, title), text ? h('p', {}, text) : null,
      actions.length ? h('div', { class: 'row' }, actions.map((a) => h('button', {
        class: `btn small ${a.primary ? 'primary' : 'ghost'}`, type: 'button',
        onclick: () => { close(); a.onClick?.(); },
      }, a.label))) : null),
    h('button', { class: 'btn icon ghost small', type: 'button', 'aria-label': 'Dismiss', onclick: close }, icon('close')));
  host.appendChild(el);
  if (timeout) t = setTimeout(close, timeout);
  return close;
}

/** Bottom sheet dialog. Returns close(). */
export function sheet(content, { label = 'Dialog', onClose } = {}) {
  const back = document.getElementById('sheetBackdrop');
  const prevFocus = document.activeElement;
  const el = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': label, tabindex: '-1' }, h('div', { class: 'grab' }), content);
  const close = () => {
    el.remove(); back.hidden = true; document.removeEventListener('keydown', onKey);
    onClose?.(); prevFocus?.focus?.();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  back.hidden = false; back.onclick = close;
  document.body.appendChild(el);
  document.addEventListener('keydown', onKey);
  el.focus();
  return close;
}

export const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} kB` : `${(n / 1048576).toFixed(1)} MB`);
export const fmtDur = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s`);

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  const ta = h('textarea', {}, text); document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
  ta.remove(); return Promise.resolve(ok);
}

export function download(name, data, type = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const a = h('a', { href: URL.createObjectURL(blob), download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

/** Estimated downlink (Mbit/s) from the Network Information API, if exposed. */
export function downlinkMbps() {
  const c = navigator.connection;
  return c && c.downlink ? c.downlink : null;
}

/**
 * Turn a long article into balanced card columns: every <h2> and what follows it becomes one card,
 * and cards are placed in reading order into whichever column is currently shortest (masonry),
 * re-balanced when the width changes. No empty gaps under short columns.
 */
export function cardify(article, { keep = 0, minWidth = 380 } = {}) {
  const kids = [...article.childNodes];
  const head = [], groups = [];
  let cur = null;
  kids.forEach((n, i) => {
    if (n.nodeType === 1 && n.tagName === 'H2' && i >= keep) { cur = [n]; groups.push(cur); }
    else if (cur) cur.push(n); else head.push(n);
  });
  // long sections with sub-headings (h3) are split into one card per sub-heading
  const cards = [];
  for (const g of groups) {
    const h3s = g.filter((n) => n.nodeType === 1 && n.tagName === 'H3');
    if (h3s.length < 2) { cards.push(h('section', { class: 'card' }, g)); continue; }
    const title = g[0].textContent;
    let part = [], first = true;
    const flush = () => { if (part.length) { cards.push(h('section', { class: 'card' }, first ? [g[0], ...part] : [h('p', { class: 'tiny card-kicker' }, title), ...part])); first = false; part = []; } };
    for (const n of g.slice(1)) { if (n.nodeType === 1 && n.tagName === 'H3' && part.some((x) => x.nodeType === 1 && x.tagName === 'H3')) flush(); part.push(n); }
    flush();
  }
  cards.forEach((c, i) => { c.dataset.order = String(i); });
  const grid = h('div', { class: 'masonry' });
  article.replaceChildren(...head, grid);
  let lastCols = 0;
  const layout = () => {
    const width = grid.clientWidth || article.clientWidth || window.innerWidth;
    const cols = Math.max(1, Math.min(4, Math.floor((width + 14) / (minWidth + 14))));
    if (cols === lastCols && grid.children.length) {
      // heights may have changed (fonts, images): re-balance only if needed
    }
    lastCols = cols;
    const colEls = Array.from({ length: cols }, () => h('div', { class: 'masonry-col' }));
    grid.replaceChildren(...colEls);
    // measure, then place largest first into the shortest column (balanced), keeping reading order inside each column
    const meas = h('div', { style: { position: 'absolute', visibility: 'hidden', width: `${(width - 14 * (cols - 1)) / cols}px` } });
    document.body.appendChild(meas);
    const sized = cards.map((c) => { meas.appendChild(c); const hgt = c.offsetHeight; return { c, hgt }; });
    meas.remove();
    const heights = new Array(cols).fill(0), buckets = Array.from({ length: cols }, () => []);
    for (const it of [...sized].sort((a, b) => b.hgt - a.hgt)) {
      let k = 0; for (let j = 1; j < cols; j++) if (heights[j] < heights[k]) k = j;
      buckets[k].push(it.c); heights[k] += it.hgt + 14;
    }
    buckets.forEach((b, k) => b.sort((x, y) => x.dataset.order - y.dataset.order).forEach((c) => colEls[k].appendChild(c)));
  };
  requestAnimationFrame(layout);
  let t = 0;
  const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(layout, 120); });
  ro.observe(article);
  if (document.fonts?.ready) document.fonts.ready.then(layout);
  return article;
}

/** Balanced masonry for an existing set of card elements inside a container (re-balances on resize). */
export function masonry(container, cards, minWidth = 320) {
  const lay = () => {
    const width = container.clientWidth || window.innerWidth;
    const cols = Math.max(1, Math.min(4, Math.floor((width + 14) / (minWidth + 14))));
    const colEls = Array.from({ length: cols }, () => h('div', { class: 'masonry-col' }));
    const heights = new Array(cols).fill(0);
    cards.forEach((c, i) => { c.dataset.order = String(i); });
    const sized = cards.map((c) => ({ c, hgt: c.offsetHeight || 200 }));
    const buckets = Array.from({ length: cols }, () => []);
    for (const it of [...sized].sort((a, b) => b.hgt - a.hgt)) { let k = 0; for (let j = 1; j < cols; j++) if (heights[j] < heights[k]) k = j; buckets[k].push(it.c); heights[k] += it.hgt + 14; }
    buckets.forEach((b, k) => b.sort((x, y) => x.dataset.order - y.dataset.order).forEach((c) => colEls[k].appendChild(c)));
    container.classList.add('masonry');
    container.replaceChildren(...colEls);
  };
  lay();
  let t = 0; const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(lay, 150); }); ro.observe(container);
  return lay;
}
