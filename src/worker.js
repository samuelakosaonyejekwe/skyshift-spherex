// Frame worker: streams SPHEREx pixels straight from the public IRSA S3 bucket with
// HTTP range requests, reprojects onto the common grid and returns frames as they finish.

import { SpherexImage } from './lib/spherex.js';
import { renderExposure, photAt } from './lib/engine.js';
import { cache } from './lib/store.js';

let current = null; // { id, ctl }
const images = new Map(); // small LRU of SpherexImage objects (keeps parsed headers in memory)
let bytes = 0;

function getImage(uri, signal) {
  let img = images.get(uri);
  if (!img) {
    img = new SpherexImage(uri, { cache, onBytes: (n) => { bytes += n; } });
    images.set(uri, img);
    if (images.size > 800) images.delete(images.keys().next().value);
  }
  img.src.signal = signal;
  return img;
}

async function pool(items, limit, fn, signal) {
  let i = 0;
  const run = async () => {
    while (i < items.length && !signal.aborted) {
      const k = i++;
      await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'abort') { current?.ctl.abort(); return; }

  if (msg.type === 'frames') {
    current?.ctl.abort();
    const ctl = new AbortController();
    current = { id: msg.id, ctl };
    const { items, grid, opts } = msg;
    let done = 0;
    const t0 = performance.now();
    bytes = 0;
    await pool(items, opts.concurrency || 6, async (rec, k) => {
      try {
        const img = getImage(rec.uri, ctl.signal);
        // 'auto': the first few exposures as whole rows (appear fastest), the rest column-precise (far less data)
        const readMode = opts.readMode === 'fast' ? 'fast' : opts.readMode === 'saver' ? 'saver' : (k < 6 ? 'fast' : 'saver');
        const r = await renderExposure(img, grid, rec, { ...opts, readMode });
        if (ctl.signal.aborted) return;
        if (!r) { self.postMessage({ type: 'skip', id: msg.id, index: k, reason: 'outside' }); return; }
        const transfer = [r.data.buffer];
        if (r.flags) transfer.push(r.flags.buffer);
        self.postMessage({ type: 'frame', id: msg.id, index: k, data: r.data, flags: r.flags, meta: r.meta, phot: r.phot }, transfer);
      } catch (err) {
        if (ctl.signal.aborted) return;
        self.postMessage({ type: 'skip', id: msg.id, index: k, reason: String(err.message || err) });
      } finally {
        done++;
        if (!ctl.signal.aborted) self.postMessage({ type: 'progress', id: msg.id, done, total: items.length, bytes, ms: performance.now() - t0 });
      }
    }, ctl.signal);
    if (!ctl.signal.aborted) self.postMessage({ type: 'done', id: msg.id, bytes, ms: performance.now() - t0 });
    return;
  }

  if (msg.type === 'phot') {
    const ctl = new AbortController();
    const out = [];
    let done = 0;
    await pool(msg.items, 6, async (rec) => {
      try {
        const p = await photAt(getImage(rec.uri, ctl.signal), msg.ra, msg.dec, true);
        if (p) out.push({ ...p, uri: rec.uri });
      } catch { /* skip */ }
      done++;
      if (done % 4 === 0) self.postMessage({ type: 'photProgress', id: msg.id, done, total: msg.items.length });
    }, ctl.signal);
    self.postMessage({ type: 'photDone', id: msg.id, points: out });
  }
};
