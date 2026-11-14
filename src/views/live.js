// Live: what is arriving in the SPHEREx archive right now, read from the user's browser
// straight from IRSA's public cloud bucket (listing is CORS-enabled), plus the newest
// exposure date from IRSA TAP. "Develop" makes a quick-look picture of any new frame.

import { h, icon, toast } from '../ui/dom.js';
import { SpherexImage, describeUri } from '../lib/spherex.js';
import { mjdToISO } from '../lib/coords.js';
import { normalise, toParams } from '../state.js';
import { paint, limits, upsampleRGBA } from '../lib/render.js';
import { robustStats } from '../lib/engine.js';
import { cache } from '../lib/store.js';

export const title = 'Live';
const BUCKET = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';

async function list(prefix, { delimiter = '/', startAfter = '', max = 1000 } = {}) {
  const u = `${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}${delimiter ? `&delimiter=${delimiter}` : ''}${startAfter ? `&start-after=${encodeURIComponent(startAfter)}` : ''}&max-keys=${max}`;
  const r = await fetch(u, { cache: 'no-store' });
  if (!r.ok) throw new Error(`Archive listing HTTP ${r.status}`);
  const x = await r.text();
  return {
    prefixes: [...x.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix),
    keys: [...x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({ key: (m[1].match(/<Key>([^<]+)/) || [])[1], modified: (m[1].match(/<LastModified>([^<]+)/) || [])[1], size: Number((m[1].match(/<Size>(\d+)/) || [])[1] || 0) })),
    truncated: /<IsTruncated>true/.test(x),
  };
}

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
    h('h2', {}, 'Latest frames'), h('p', { class: 'tiny' }, 'Detector 3 (1.63–2.41 µm) frames from the newest planning period; each frame is one 3.5° × 3.5° patch of sky.'), frames);

  let last = 0, disposed = false;
  async function run(force) {
    if (!force && Date.now() - last < 5 * 60 * 1000) return;
    last = Date.now();
    status.textContent = 'Reading the IRSA archive…';
    try {
      const releases = ['qr3', 'dr1'];
      const all = [];
      for (const rel of releases) {
        const l = await list(`${rel}/level2/`);
        for (const p of l.prefixes) all.push({ rel, prefix: p, period: p.split('/')[2] });
      }
      all.sort((a, b) => (a.period < b.period ? 1 : -1));
      const newest = all.slice(0, 5);
      // newest period: its newest version folder, then detector-3 files
      const top = newest[0];
      const versions = (await list(top.prefix)).prefixes.sort();
      const ver = versions[versions.length - 1];
      let keys = [], startAfter = '';
      for (let page = 0; page < 3; page++) {
        const l = await list(`${ver}3/`, { delimiter: '', startAfter });
        keys = keys.concat(l.keys.filter((k) => k.key.endsWith('.fits')));
        if (!l.truncated) break;
        startAfter = l.keys[l.keys.length - 1].key;
      }
      keys.sort((a, b) => (a.key < b.key ? -1 : 1));
      const newestFile = keys.reduce((m, k) => (k.modified > m ? k.modified : m), '');
      let newestObs = Number(localStorage.getItem('skyshift.newestMjd') || 0);
      try { const { latestSpherex } = await import('../lib/tap.js'); const r = await latestSpherex(); if (r.data) newestObs = r.data; } catch { /* keep */ }
      stats.replaceChildren(
        stat(top.period, `newest SPHEREx planning period in the IRSA archive (${top.rel.toUpperCase()})`),
        stat(newestFile ? newestFile.slice(0, 10) : '–', `newest SPHEREx files reached the IRSA archive${newestFile ? ` (${ago(newestFile)})` : ''}`),
        stat(newestObs ? mjdToISO(newestObs, false) : '–', 'date of the newest SPHEREx exposure searchable at IRSA'),
        stat(String(all.length), 'SPHEREx planning periods served by IRSA now (DR1 + QR3)'));
      periods.className = 'period-grid';
      periods.replaceChildren(...newest.map((p, i) => h('div', { class: 'card row' }, h('span', { class: `chip ${p.rel === 'qr3' ? 'good' : 'info'}` }, p.rel.toUpperCase()), h('b', {}, `Planning period ${p.period}`), h('span', { class: 'tiny' }, `${weekLabel(p.period)}${i === 0 ? ' · newest' : ''}`))));
      const latest = keys.slice(-8).reverse();
      const cardsEls = latest.map((k) => frameCard(k));
      frames.replaceChildren(...cardsEls);
      // develop the newest frames automatically, one after another (about 0.3 MB each)
      (async () => { for (const c of cardsEls) { if (disposed || !c.isConnected) return; const b = c.querySelector('button'); if (b && b.textContent === 'Develop') { b.click(); await new Promise((r) => setTimeout(r, 400)); while (b.isConnected && b.disabled) await new Promise((r) => setTimeout(r, 300)); } } })();
      status.textContent = `${keys.length} detector-3 frames listed in ${top.period}. Archive checked just now (${new Date().toLocaleTimeString()}).`;
      await cache.set('live:last', { at: Date.now(), top, keys: latest });
    } catch (e) {
      const prev = await cache.get('live:last');
      status.textContent = `The archive could not be read now (${e.message}).${prev ? ` Showing the list from ${new Date(prev.at).toLocaleString()}.` : ''}`;
      if (prev) frames.replaceChildren(...prev.keys.map((k) => frameCard(k)));
    }
  }
  function stat(v, l) { return h('div', { class: 'stat card' }, h('b', {}, v), h('span', { class: 'tiny' }, l)); }
  function frameCard(k) {
    const d = describeUri(k.key);
    const canvas = h('canvas', { width: 192, height: 192, class: 'live-thumb', 'aria-label': 'Quick-look picture' });
    const info = h('p', { class: 'tiny' }, `${d.obsid || ''} D${d.detector || '?'} · reached IRSA ${k.modified?.slice(0, 10)} · ${(k.size / 1048576).toFixed(0)} MB`);
    const btn = h('button', { class: 'btn small primary' }, 'Develop');
    const card = h('div', { class: 'card live-card' }, canvas, info, btn);
    btn.addEventListener('click', async () => {
      btn.disabled = true; btn.textContent = 'Developing…';
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
        info.textContent = `${ra.toFixed(3)}°, ${dec >= 0 ? '+' : ''}${dec.toFixed(3)}° · ${String(m.header['DATE-AVG'] || '').slice(0, 16).replace('T', ' ')} UTC · D${m.header.DETECTOR} · centre of the frame (not mirrored: north is not necessarily up)`;
        btn.replaceWith(h('button', { class: 'btn small', onclick: () => go(`#/view?${toParams(normalise({ target: { ra: +ra.toFixed(5), dec: +dec.toFixed(5), source: 'coords', name: `New frame ${d.obsid || ''}` } }))}`) }, 'Open this spot'));
        const pts = JSON.parse(localStorage.getItem('skyshift.livePts') || '[]').filter((p) => Math.abs(p.ra - ra) > 1e-3);
        pts.unshift({ ra, dec, date: m.header['DATE-AVG'] }); localStorage.setItem('skyshift.livePts', JSON.stringify(pts.slice(0, 30)));
      } catch (e) { btn.disabled = false; btn.textContent = 'Retry'; toast({ title: 'Could not develop this frame', text: e.message, glyph: '⚠', timeout: 4000 }); }
    });
    return card;
  }
  run(true);
  const t = setInterval(() => run(false), 60 * 1000);
  return () => { disposed = true; clearInterval(t); };
}
