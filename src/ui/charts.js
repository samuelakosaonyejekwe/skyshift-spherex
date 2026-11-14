// Lightweight SVG charts (vector, crisp at any size, exportable). No dependencies.

const NS = 'http://www.w3.org/2000/svg';
const el = (name, attrs = {}, parent) => {
  const e = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (parent) parent.appendChild(e);
  return e;
};

function niceTicks(a, b, n = 5) {
  if (!(b > a)) { b = a + 1; }
  const span = b - a, step0 = span / n;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(a / step) * step; v <= b + 1e-9 * span; v += step) out.push(+v.toPrecision(12));
  return out;
}

const fmt = (v) => {
  const a = Math.abs(v);
  if (a >= 1e5 || (a > 0 && a < 1e-2)) return v.toExponential(1);
  return +v.toPrecision(4) + '';
};

/**
 * @param {HTMLElement} host
 * @param {{points: Array<{x:number,y:number,err?:number,color:string,hollow?:boolean,tip:string,ref?:any}>,
 *   xLabel:string, yLabel:string, markers?:Array<{x:number,label:string,color?:string,title?:string}>,
 *   bands?:Array<{x0:number,x1:number,color:string,label:string}>, xFormat?:(v:number)=>string,
 *   onPoint?:(p:any)=>void, title?:string, legend?:Array<{color:string,label:string,hollow?:boolean}>}} cfg
 */
export function scatterChart(host, cfg) {
  host.replaceChildren();
  const W = 480, H = 320, m = { l: 62, r: 12, t: 14, b: 46 };
  // legend laid out in as many rows as it needs, so no entry falls off the right edge
  const legendRows = [[]];
  { let lx = 0; const avail = W - 62 - m.r;
    for (const it of cfg.legend || []) {
      const w = 24 + it.label.length * 6.4;
      if (lx + w > avail && legendRows.at(-1).length) { legendRows.push([]); lx = 0; }
      legendRows.at(-1).push({ ...it, dx: lx }); lx += w;
    } }
  if (cfg.legend?.length) m.t = 14 + 18 * legendRows.length;
  const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': cfg.title || cfg.yLabel });
  host.appendChild(svg);
  const pts = cfg.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
  if (!pts.length) {
    const t = el('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'chart-empty' }, svg);
    t.textContent = cfg.empty || 'No measurements yet';
    return svg;
  }
  let x0 = Math.min(...pts.map((p) => p.x)), x1 = Math.max(...pts.map((p) => p.x));
  if (cfg.xRange) [x0, x1] = cfg.xRange;
  const ys = pts.flatMap((p) => [p.y - (p.err || 0), p.y + (p.err || 0)]);
  let y0 = Math.min(...ys), y1 = Math.max(...ys);
  const px = (x1 - x0) * 0.04 || 1, py = (y1 - y0) * 0.08 || Math.abs(y1) * 0.1 || 1;
  x0 -= px; x1 += px; y0 -= py; y1 += py;
  // Left margin sized to the widest y tick label (11px font ≈ 6.6 units a character) so the axis title never overlaps it
  const yTicks = niceTicks(y0, y1, 5);
  m.l = Math.max(48, 30 + 6.6 * Math.max(...yTicks.map((v) => fmt(v).length)));
  const X = (v) => m.l + ((v - x0) / (x1 - x0)) * (W - m.l - m.r);
  const Y = (v) => H - m.b - ((v - y0) / (y1 - y0)) * (H - m.t - m.b);
  const g = el('g', {}, svg);
  for (const b of cfg.bands || []) {
    if (b.x1 < x0 || b.x0 > x1) continue;
    const r = el('rect', { x: X(Math.max(x0, b.x0)), y: m.t, width: Math.max(0, X(Math.min(x1, b.x1)) - X(Math.max(x0, b.x0))), height: H - m.t - m.b, fill: b.color, opacity: 0.09 }, g);
    const t = el('title', {}, r); t.textContent = b.label;
    const tx = el('text', { x: (X(Math.max(x0, b.x0)) + X(Math.min(x1, b.x1))) / 2, y: H - m.b - 4, 'text-anchor': 'middle', class: 'chart-band' }, g);
    tx.textContent = b.short || '';
  }
  // grid + axes
  const xf = cfg.xFormat || fmt;
  for (const v of niceTicks(x0, x1, 6)) {
    el('line', { x1: X(v), x2: X(v), y1: m.t, y2: H - m.b, class: 'chart-grid' }, g);
    const t = el('text', { x: X(v), y: H - m.b + 16, 'text-anchor': 'middle', class: 'chart-tick' }, g); t.textContent = xf(v);
  }
  for (const v of yTicks) {
    el('line', { x1: m.l, x2: W - m.r, y1: Y(v), y2: Y(v), class: 'chart-grid' }, g);
    const t = el('text', { x: m.l - 6, y: Y(v) + 4, 'text-anchor': 'end', class: 'chart-tick' }, g); t.textContent = fmt(v);
  }
  if (y0 < 0 && y1 > 0) el('line', { x1: m.l, x2: W - m.r, y1: Y(0), y2: Y(0), class: 'chart-zero' }, g);
  el('rect', { x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, class: 'chart-frame' }, g);
  const xl = el('text', { x: (m.l + W - m.r) / 2, y: H - 8, 'text-anchor': 'middle', class: 'chart-label' }, g); xl.textContent = cfg.xLabel;
  const yl = el('text', { x: 14, y: (m.t + H - m.b) / 2, 'text-anchor': 'middle', transform: `rotate(-90 14 ${(m.t + H - m.b) / 2})`, class: 'chart-label' }, g); yl.textContent = cfg.yLabel;
  for (const mk of cfg.markers || []) {
    if (mk.x < x0 || mk.x > x1) continue;
    const l = el('line', { x1: X(mk.x), x2: X(mk.x), y1: m.t, y2: H - m.b, stroke: mk.color || '#c9a7ff', 'stroke-dasharray': '4 3', 'stroke-width': 1.2 }, g);
    const tt = el('title', {}, l); tt.textContent = mk.title || mk.label;
    const t = el('text', { x: X(mk.x) + 3, y: m.t + 11, class: 'chart-marker', fill: mk.color || '#c9a7ff' }, g); t.textContent = mk.label;
  }
  // legend
  legendRows.forEach((row, r) => row.forEach((it) => {
    const cy = 16 + 18 * r;
    el('circle', { cx: m.l + it.dx + 6, cy, r: 5, fill: it.color, stroke: it.color, 'stroke-width': 2, class: it.hollow ? 'chart-hollow' : '' }, svg);
    const t = el('text', { x: m.l + it.dx + 15, y: cy + 4, class: 'chart-legend' }, svg); t.textContent = it.label;
  }));
  // points
  const tip = document.createElement('div');
  tip.className = 'chart-tip'; tip.hidden = true;
  host.appendChild(tip);
  const pg = el('g', {}, svg);
  for (const p of pts) {
    const cx = X(p.x), cy = Y(p.y);
    if (p.err) el('line', { x1: cx, x2: cx, y1: Y(p.y - p.err), y2: Y(p.y + p.err), stroke: p.color, 'stroke-width': 1.2, opacity: 0.7 }, pg);
    const c = el('circle', { cx, cy, r: 4.2, fill: p.color, stroke: p.color, 'stroke-width': 1.6, tabindex: 0, class: p.hollow ? 'chart-pt chart-hollow' : 'chart-pt' }, pg);
    const show = () => {
      tip.textContent = p.tip; tip.hidden = false;
      const hb = host.getBoundingClientRect(), sb = svg.getBoundingClientRect();
      const sx = sb.width / W;
      tip.style.left = `${Math.min(hb.width - 180, Math.max(0, cx * sx - 80))}px`;
      tip.style.top = `${Math.max(0, cy * sx - 58)}px`;
    };
    c.addEventListener('pointerenter', show);
    c.addEventListener('focus', show);
    c.addEventListener('pointerleave', () => { tip.hidden = true; });
    c.addEventListener('blur', () => { tip.hidden = true; });
    if (cfg.onPoint) c.addEventListener('click', () => cfg.onPoint(p));
  }
  return svg;
}

/** Serialise an SVG element to a standalone file string. */
export function svgString(svg) {
  const clone = svg.cloneNode(true);
  clone.setAttribute('xmlns', NS);
  const style = document.createElementNS(NS, 'style');
  style.textContent = `text{font:12px system-ui,sans-serif;fill:#dfe3ff}.chart-grid{stroke:#ffffff18}.chart-frame{fill:none;stroke:#ffffff40}.chart-zero{stroke:#ffffff60}.chart-tick{fill:#aab0d6;font-size:11px}.chart-label{font-size:13px}.chart-band{font-size:10px;fill:#aab0d6}.chart-marker{font-size:10px}.chart-legend{font-size:11px;fill:#aab0d6}.chart-hollow{fill:#0b0e24}`;
  clone.insertBefore(style, clone.firstChild);
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', '100%'); bg.setAttribute('height', '100%'); bg.setAttribute('fill', '#0b0e24');
  clone.insertBefore(bg, style.nextSibling);
  return new XMLSerializer().serializeToString(clone);
}
