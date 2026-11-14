// Live: what is arriving in the SPHEREx archive right now, read from the user's browser
// straight from IRSA's public cloud bucket (listing is CORS-enabled), plus the newest
// exposure date from IRSA TAP. "Develop" makes a quick-look picture of any new frame.

import { h, icon, toast } from '../ui/dom.js';
import { SpherexImage, describeUri } from '../lib/spherex.js';
import { niceDate, niceDateTime, niceTime } from '../lib/coords.js';
import { normalise, toParams } from '../state.js';
import { paint, limits, upsampleRGBA } from '../lib/render.js';
import { robustStats } from '../lib/engine.js';
import { cache } from '../lib/store.js';

export const title = 'Live';
import { BUCKET, snapshot } from '../lib/livelist.js';


const ago = (d) => { const s = (Date.now() - new Date(d).getTime()) / 1000; return s < 3600 ? `${Math.round(s / 60)} min ago` : s < 172800 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`; };
const weekLabel = (p) => { const m = p.match(/(\d{4})W(\d\d)/); return m ? `week ${Number(m[2])} of ${m[1]}` : p; };

export async function render(root, route, { go }) {
  const stats = h('div', { class: 'stat-grid' });
  const periods = h('div', { class: 'grid' });
  const frames = h('div', { class: 'live-frames' });
  const status = h('p', { class: 'tiny', 'aria-live': 'polite' });
  root.append(
    h('div', { class: 'row' }, h('h1', { style: { margin: 0 } }, 'Live from SPHEREx'), h('div', { class: 'spacer' }), h('button', { class: 'btn small', onclick: () => run(true) }, icon('refresh'), 'Refresh')),
    h('p', { class: 'muted prose' }, 'New SPHEREx images reach the IRSA archive every week. This page reads the archive directly from your device, so it always shows what is there right now. Press Develop on any new frame for a quick look, then open that spot.'),
    stats, status,
    h('h2', {}, 'Newest observing periods in the archive'), periods,
    h('h2', {}, 'Latest frames'), h('p', { class: 'tiny' }, 'Detector 3 (1.63–2.41 µm) frames from the newest planning period. Each picture is the central 15′ of a 3.5° × 3.5° frame, shown as recorded (north is not necessarily up); the position given is its centre.'), frames);

  let last = 0, disposed = false;
  // Draw a snapshot (live, this device's last one, or the server's 6-hourly one) into the page.
  let drawnAt = 0;
  function draw(snap, note) {
    // show whole rows only: as many items as fill the grid's columns at this width (no half-empty last row)
    const colsFor = (el, minW) => Math.max(1, Math.floor(((el.clientWidth || root.clientWidth || 1000) + 12) / (minW + 12)));
    const narrow = (root.clientWidth || 1000) < 560;
    const pCols = colsFor(periods, 260); let fCols = colsFor(frames, narrow ? 150 : 210);
    periods.style.gridTemplateColumns = `repeat(${pCols}, minmax(0, 1fr))`;
    const newest = snap.periods.slice(0, pCols * Math.max(1, Math.ceil(4 / pCols)));
    const keys = snap.keys || [];
    const newestFile = keys.reduce((m, k) => (k.modified > m ? k.modified : m), '');
    stats.replaceChildren(
      stat(snap.top.period, `newest SPHEREx planning period in the IRSA archive (${snap.top.rel.toUpperCase()})`),
      stat(newestFile ? niceDate(newestFile) : '–', `newest SPHEREx files reached the IRSA archive${newestFile ? ` (${ago(newestFile)})` : ''}`),
      newestCard(),
      stat(String(snap.total), 'SPHEREx planning periods served by IRSA now (DR1 + QR3)'));
    periods.className = 'period-grid';
    periods.replaceChildren(...newest.map((p, i) => h('div', { class: 'card row' }, h('span', { class: `chip ${p.rel === 'qr3' ? 'good' : 'info'}` }, p.rel.toUpperCase()), h('b', {}, `Planning period ${p.period}`), h('span', { class: 'tiny' }, `${weekLabel(p.period)}${i === 0 ? ' · newest' : ''}`))));
    // whole rows of the frames that exist (a period may hold fewer frames than two full rows)
    let nShow = Math.min(keys.length, fCols * Math.max(1, Math.ceil(8 / fCols)));
    if (nShow < fCols) fCols = Math.max(1, nShow); else nShow = Math.floor(nShow / fCols) * fCols;
    frames.style.gridTemplateColumns = `repeat(${fCols}, minmax(0, 1fr))`;
    const latest = keys.slice(-nShow).reverse();
    const same = frames.dataset.keys === latest.map((k) => k.key).join(',');
    if (!same) {
      const cardsEls = latest.map((k) => frameCard(k));
      frames.replaceChildren(...cardsEls);
      frames.dataset.keys = latest.map((k) => k.key).join(',');
      // develop the newest frames automatically, one after another (about 0.3 MB each)
      (async () => { for (const c of cardsEls) { if (disposed || !c.isConnected) return; const b = c.querySelector('button'); if (b && b.dataset.act === 'develop') { b.click(); await new Promise((r) => setTimeout(r, 400)); while (b.isConnected && b.disabled) await new Promise((r) => setTimeout(r, 300)); } } })();
    }
    status.textContent = note;
    drawnAt = Date.parse(snap.checked) || Date.now();
  }
  // newest exposure: from the image index or the last value seen at once; the live query only updates this card
  let newestObs = Number(localStorage.getItem('skyshift.newestMjd') || 0);
  const newestCard = () => stat(newestObs ? niceDate(newestObs) : '–', 'date the newest SPHEREx image searchable at IRSA was taken');
  import('../lib/tap.js').then(async (t) => {
    if (!newestObs) { newestObs = (await t.indexMeta())?.newestMjd || 0; if (newestObs && stats.children[2]) stats.children[2].replaceWith(newestCard()); }
    t.latestSpherex().then((r) => { if (r.data && !disposed) { newestObs = r.data; stats.children[2]?.replaceWith(newestCard()); } }).catch(() => {});
  });

  async function run(force) {
    if (!force && Date.now() - last < 5 * 60 * 1000) return;
    last = Date.now();
    // 1) at once: the newest stored snapshot (this device's last listing or the server's 6-hourly one)
    if (!drawnAt) {
      const [mine, server] = await Promise.all([cache.get('live:snap'), fetch('./data/live.json', { cache: 'no-cache' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)]);
      const best = [mine, server].filter((x) => x?.periods?.length).sort((a, b) => Date.parse(b.checked) - Date.parse(a.checked))[0];
      if (best && !disposed) draw(best, `Showing the archive as of ${niceDateTime(best.checked)}; checking for newer files now…`);
    }
    if (!drawnAt) status.textContent = 'Reading the IRSA archive…';
    // 2) live listing straight from the bucket (each request time-limited); the page above stays usable meanwhile
    try {
      const snap = await snapshot();
      if (disposed) return;
      draw(snap, `${snap.keys.length} detector-3 frames listed in ${snap.top.period}. Archive checked just now (${niceTime()}).`);
      await cache.set('live:snap', snap);
    } catch (e) {
      if (disposed) return;
      status.textContent = drawnAt ? `The archive did not answer just now (${e.message}); showing the list from ${niceDateTime(new Date(drawnAt).toISOString())}.` : `The archive could not be read now (${e.message}). Try Refresh in a moment.`;
    }
  }
  function stat(v, l) { return h('div', { class: 'stat card' }, h('b', {}, v), h('span', { class: 'tiny' }, l)); }
  function frameCard(k) {
    const d = describeUri(k.key);
    const canvas = h('canvas', { width: 192, height: 192, class: 'live-thumb', 'aria-label': 'Quick-look picture' });
    const info = h('p', { class: 'tiny' }, `${d.obsid || ''} D${d.detector || '?'} · reached IRSA ${k.modified ? niceDate(k.modified) : '–'} · ${(k.size / 1048576).toFixed(0)} MB`);
    const btn = h('button', { class: 'btn small primary', 'data-act': 'develop' }, 'Develop'); // state in data-act (labels are translated)
    const card = h('div', { class: 'card live-card' }, canvas, info, btn);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.dataset.act = 'busy'; btn.textContent = 'Developing…';
      try {
        const img = new SpherexImage(BUCKET + k.key);
        const m = await img.meta();
        const W = m.header.NAXIS1, c = W / 2;
        const block = await img.block(c - 127, c + 128, c - 127, c + 128); // central 256 x 256 px (15′)
        const N = 64, f = 4, bin = new Float32Array(N * N);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
          let s = 0, n = 0;
          for (let y = 0; y < f; y++) for (let x = 0; x < f; x++) { const v = block.data[((255 - (j * f + y)) * 256) + i * f + x]; if (Number.isFinite(v)) { s += v; n++; } }
          bin[j * N + i] = n ? s / n : NaN;
        }
        const st = robustStats(bin);
        for (let q = 0; q < bin.length; q++) bin[q] -= st.median;
        const px = new Uint8ClampedArray(N * N * 4);
        paint(bin, px, limits([bin], 1, 99.7), { stretch: 'asinh', cmap: 'heat' });
        const up = upsampleRGBA(px, N, 3);
        const off = document.createElement('canvas'); off.width = up.size; off.height = up.size;
        off.getContext('2d').putImageData(new ImageData(up.data, up.size, up.size), 0, 0);
        const ctx = canvas.getContext('2d'); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(off, 0, 0, 192, 192);
        const [ra, dec] = img.wcs.pixToWorld(c + 0.5, c + 0.5);
        info.textContent = `${ra.toFixed(3)}°, ${dec >= 0 ? '+' : ''}${dec.toFixed(3)}° · ${m.header['DATE-AVG'] ? niceDateTime(m.header['DATE-AVG']) : '–'} · D${m.header.DETECTOR}`;
        btn.replaceWith(h('button', { class: 'btn small', onclick: () => go(`#/view?${toParams(normalise({ target: { ra: +ra.toFixed(5), dec: +dec.toFixed(5), source: 'coords', name: `New frame ${d.obsid || ''}` } }))}`) }, 'Open this spot'));
        const pts = JSON.parse(localStorage.getItem('skyshift.livePts') || '[]').filter((p) => Math.abs(p.ra - ra) > 1e-3);
        pts.unshift({ ra, dec, date: m.header['DATE-AVG'] }); localStorage.setItem('skyshift.livePts', JSON.stringify(pts.slice(0, 30)));
      } catch (e) { btn.disabled = false; btn.dataset.act = 'develop'; btn.textContent = 'Retry'; toast({ title: 'Could not develop this frame', text: e.message, glyph: '⚠', timeout: 4000 }); }
    });
    return card;
  }
  run(true);
  const t = setInterval(() => run(false), 60 * 1000);
  return () => { disposed = true; clearInterval(t); };
}
