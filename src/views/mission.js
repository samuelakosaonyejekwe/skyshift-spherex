// Mission: SPHEREx survey statistics from IRSA (prebuilt by scripts/mission.mjs from TAP
// aggregates, plus the live newest-exposure date), and data freshness of every source.

import { h } from '../ui/dom.js';
import { niceDate } from '../lib/coords.js';
import { DETECTORS } from '../lib/spherex.js';
import * as sources from './sources.js';

export const title = 'Mission';

function bars(values, { color = (i) => 'var(--accent-2)', label = (i) => '', tip = (i) => '', height = 160 }) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 900, H = height, n = values.length, max = Math.max(1, ...values);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H + 22}`); svg.setAttribute('class', 'chart'); svg.setAttribute('role', 'img');
  const bw = W / n;
  values.forEach((v, i) => {
    const r = document.createElementNS(NS, 'rect');
    const hh = (v / max) * H;
    r.setAttribute('x', String(i * bw + bw * 0.08)); r.setAttribute('y', String(H - hh)); r.setAttribute('width', String(Math.max(1, bw * 0.84))); r.setAttribute('height', String(hh));
    r.setAttribute('fill', color(i)); r.setAttribute('rx', String(Math.min(3, bw / 4)));
    const t = document.createElementNS(NS, 'title'); t.textContent = tip(i); r.appendChild(t);
    svg.appendChild(r);
    const l = label(i);
    if (l) { const tx = document.createElementNS(NS, 'text'); tx.setAttribute('x', String(Math.max(2, Math.min(W - 2, i * bw + bw / 2)))); tx.setAttribute('y', String(H + 16)); const cx = i * bw + bw / 2; tx.setAttribute('text-anchor', cx < 40 ? 'start' : cx > W - 40 ? 'end' : 'middle'); /* edge labels stay inside the chart */ tx.setAttribute('class', 'chart-tick'); tx.textContent = l; svg.appendChild(tx); }
  });
  return svg;
}

export async function render(root, route, ctx) {
  let m = null;
  try { m = await (await fetch('./data/mission.json', { cache: 'no-cache' })).json(); } catch { /* not built yet or offline */ }
  const stat = (v, l) => h('div', { class: 'stat card' }, h('b', {}, v), h('span', { class: 'tiny' }, l));
  const fresh = h('div');
  root.append(
    h('h1', {}, 'The SPHEREx mission in numbers'),
    h('p', { class: 'muted prose' }, 'SPHEREx maps the entire sky every six months in 102 infrared colours from 0.75 to 5 µm. These numbers come from IRSA’s archive of SPHEREx spectral images (all releases currently served).'),
    m ? h('div', {},
      h('div', { class: 'stat-grid' },
        stat(m.images.toLocaleString(), 'spectral images in the archive (one per detector per exposure)'),
        stat(`${(m.skyFraction * 100).toFixed(1)}%`, 'of the sky imaged'),
        stat(m.days.toLocaleString(), 'days with observations'),
        stat(niceDate(m.firstMjd), 'first survey image'),
        stat(niceDate(m.lastMjd), 'latest image in these statistics'),
        stat('102', 'infrared colours (0.75–5 µm, 6 detector arrays × 17 channels)')),
      h('section', { class: 'card', style: { marginBottom: '14px' } },
        h('h2', {}, 'Images taken per day'),
        bars(m.perDay.map((x) => x[1]), {
          tip: (i) => `${niceDate(m.perDay[i][0])}: ${m.perDay[i][1].toLocaleString()} images`,
          label: (i) => (i % Math.ceil(m.perDay.length / 8) === 0 ? niceDate(m.perDay[i][0], true) : ''),
        })),
      h('section', { class: 'card', style: { marginBottom: '14px' } },
        h('h2', {}, '102 colours of infrared, in 6 detector arrays'),
        bars(m.perBand.filter((x) => /D[1-6]$/.test(x[0])).map((x) => x[1]), {
          color: (i) => `var(--d${i + 1})`, height: 120,
          label: (i) => `D${i + 1} · ${DETECTORS[i]?.range.join('–')} µm`,
          tip: (i) => `D${i + 1} (${DETECTORS[i]?.range.join('–')} µm, R=${DETECTORS[i]?.R}): ${m.perBand.filter((x) => /D[1-6]$/.test(x[0]))[i][1].toLocaleString()} images`,
        })),
      h('p', { class: 'tiny' }, `Statistics built ${new Date(m.built).toLocaleString()} from ${m.source}. They refresh on a schedule; the newest-image date on Live and on the Explore page is always read live.`))
      : h('p', { class: 'notice' }, 'Mission statistics have not been built yet on this copy of SkyShift (run scripts/mission.mjs). Live data still works everywhere else.'),
    h('h2', { id: 'freshness' }, 'Data freshness — the eight challenge resources, checked live'),
    fresh);
  const dispose = await sources.render(fresh, route, ctx, { embedded: true });
  return dispose;
}
