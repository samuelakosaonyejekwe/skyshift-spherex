// Frame worker: streams SPHEREx pixels straight from the public IRSA S3 bucket with
// HTTP range requests, reprojects onto the common grid and returns frames as they finish.

import { SpherexImage } from './lib/spherex.js';
import { renderExposure, photAt } from './lib/engine.js';
import { cache } from './lib/store.js';
import { setGatherRelays } from './lib/fits.js';

let current = null; // { id, ctl }
const images = new Map(); // small LRU of SpherexImage objects (keeps parsed headers in memory)
let bytes = 0;

// One image object per job kind, so a click-spectrum job never takes over (or cancels) the
// abort signal of a frame job; parsed headers are shared through the IndexedDB cache.
function getImage(uri, signal, kind = 'frames') {
  const key = `${kind}|${uri}`;
  let img = images.get(key);
  if (!img) {
    img = new SpherexImage(uri, { cache, onBytes: (n) => { bytes += n; } });
    images.set(key, img);
    if (images.size > 1200) images.delete(images.keys().next().value);
  }
  img.src.signal = signal;
  return img;
}
let currentPhot = null;

async function pool(items, limit, fn, signal, { first = limit } = {}) {
  let i = 0;
  let release; const ramp = new Promise((r) => { release = r; });
  signal.addEventListener('abort', () => release(), { once: true }); // a cancelled job never leaves workers waiting
  const run = async () => {
    while (i < items.length && !signal.aborted) {
      const k = i++;
      await fn(items[k], k);
      release(); // after the first item finishes, the remaining workers start
    }
  };
  // a few workers first, so the first frame is not slowed by many exposures sharing the connection; then all of them
  const start = Math.min(first, limit, items.length);
  const runners = Array.from({ length: start }, run);
  if (limit > start) runners.push(ramp.then(() => Promise.all(Array.from({ length: Math.min(limit, items.length) - start }, run))));
  await Promise.all(runners);
}

self.onmessage = async (e) => {
  const msg = e.data;
  if (msg.type === 'abort') { current?.ctl.abort(); currentPhot?.abort(); return; }

  if (msg.type === 'frames') {
    current?.ctl.abort();
    const ctl = new AbortController();
    current = { id: msg.id, ctl };
    const { items, grid, opts } = msg;
    setGatherRelays(opts.gather);
    let done = 0;
    const t0 = performance.now();
    bytes = 0;
    await pool(items, opts.concurrency || 6, async (rec, k) => {
      try {
        const img = getImage(rec.uri, ctl.signal);
        // 'auto': the first few exposures as whole rows (appear fastest), the rest column-precise (far less data)
        // with a gathering relay, column-precise reads cost one request each: use them throughout (far less data)
        const readMode = opts.readMode === 'fast' ? 'fast' : opts.readMode === 'saver' || opts.gather?.length ? 'saver' : (k < 6 ? 'fast' : 'saver');
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
    }, ctl.signal, { first: 2 });
    if (!ctl.signal.aborted) self.postMessage({ type: 'done', id: msg.id, bytes, ms: performance.now() - t0 });
    return;
  }

  if (msg.type === 'phot') {
    currentPhot?.abort();
    const ctl = new AbortController();
    currentPhot = ctl;
    const out = [];
    let done = 0;
    await pool(msg.items, 6, async (rec) => {
      try {
        const p = await photAt(getImage(rec.uri, ctl.signal, 'phot'), msg.ra, msg.dec, true);
        if (p) out.push({ ...p, uri: rec.uri });
      } catch { /* skip */ }
      done++;
      if (done % 4 === 0) self.postMessage({ type: 'photProgress', id: msg.id, done, total: msg.items.length });
    }, ctl.signal);
    if (!ctl.signal.aborted) self.postMessage({ type: 'photDone', id: msg.id, points: out });
  }
};
