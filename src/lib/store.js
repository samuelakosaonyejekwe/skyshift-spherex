// Tiny IndexedDB key-value cache with size-aware eviction. Works in window and worker scopes.
// Values may be structured-clonable objects or typed arrays.

const DB = 'skyshift', STORE = 'kv', VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(DB, VERSION);
    req.onupgradeneeded = () => {
      const s = req.result.createObjectStore(STORE);
      s.createIndex('ts', 'ts');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  }).catch((e) => { dbp = null; throw e; });
  return dbp;
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

const req2p = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

let writes = 0;

export const cache = {
  async get(key) {
    try {
      const rec = await tx('readonly', (s) => req2p(s.get(key)));
      return rec ? rec.v : undefined;
    } catch { return undefined; }
  },
  async set(key, v, { ttl = 0 } = {}) {
    try {
      const size = v?.byteLength ?? (v?.buffer?.byteLength) ?? 1024;
      await tx('readwrite', (s) => s.put({ v, ts: Date.now(), size, exp: ttl ? Date.now() + ttl : 0 }, key));
      if (++writes % 150 === 0) evict();
    } catch { /* quota or private mode: run uncached */ }
  },
  async getFresh(key) {
    try {
      const rec = await tx('readonly', (s) => req2p(s.get(key)));
      if (!rec) return undefined;
      return { v: rec.v, ts: rec.ts, stale: rec.exp && rec.exp < Date.now() };
    } catch { return undefined; }
  },
  async del(key) { try { await tx('readwrite', (s) => s.delete(key)); } catch { /* ignore */ } },
  async clear() { try { await tx('readwrite', (s) => s.clear()); } catch { /* ignore */ } },
  async usage() {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) return navigator.storage.estimate();
    return { usage: 0, quota: 0 };
  },
};

/** Drop the oldest quarter of entries when storage use passes 60% of quota (or 1.5 GB). */
async function evict() {
  try {
    const { usage = 0, quota = 0 } = await cache.usage();
    const limit = Math.min(quota * 0.6 || Infinity, 1.5e9);
    if (usage < limit) return;
    await tx('readwrite', (s) => new Promise((resolve) => {
      const countReq = s.count();
      countReq.onsuccess = () => {
        let toDrop = Math.floor(countReq.result / 4);
        const cur = s.index('ts').openCursor();
        cur.onsuccess = () => {
          const c = cur.result;
          if (!c || toDrop-- <= 0) return resolve();
          if (!String(c.primaryKey).startsWith('pin:')) c.delete();
          c.continue();
        };
      };
    }));
  } catch { /* ignore */ }
}
