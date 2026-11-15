// Frame packs: the default view of the challenge targets and of the fastest Gaia DR3 stars, already cut out of
// the SPHEREx images on IRSA's S3 bucket by scripts/packs.mjs with the same code the browser uses
// (renderExposure). The viewer shows a pack at once and then streams only exposures the pack does not hold,
// so these fields open in about a second instead of streaming 120 exposures first.
//
// File layout (data/packs/<name>.bin, gzip-compressed): "SSPK", uint32 LE length of the JSON header, the
// JSON header ({ v, key, built, n, frames: [{ rec, meta, phot }] }), zero padding to a multiple of 4 bytes,
// then one n×n little-endian float32 image per frame, in header order.

export const PACK_MAGIC = 'SSPK';

/** Encode frames ({ data, meta, phot, rec }) into pack bytes (uncompressed). */
export function encodePack({ key, built, n, frames }) {
  const head = new TextEncoder().encode(JSON.stringify({ v: 1, key, built, n, frames: frames.map((f) => ({ rec: f.rec, meta: f.meta, phot: f.phot ?? null })) }));
  const start = Math.ceil((8 + head.length) / 4) * 4;
  const out = new Uint8Array(start + frames.length * n * n * 4);
  out.set(new TextEncoder().encode(PACK_MAGIC), 0);
  new DataView(out.buffer).setUint32(4, head.length, true);
  out.set(head, 8);
  const dv = new DataView(out.buffer);
  frames.forEach((f, k) => { const o = start + k * n * n * 4; for (let i = 0; i < n * n; i++) dv.setFloat32(o + i * 4, f.data[i], true); });
  return out;
}

/** Decode pack bytes (uncompressed) into { key, built, n, frames: [{ data, flags: null, meta, phot, rec }] }. */
export function decodePack(bytes) {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== PACK_MAGIC) throw new Error('not a frame pack');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = dv.getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + len)));
  const start = Math.ceil((8 + len) / 4) * 4, nn = head.n * head.n;
  const frames = head.frames.map((f, k) => {
    const data = new Float32Array(nn), o = start + k * nn * 4;
    for (let i = 0; i < nn; i++) data[i] = dv.getFloat32(o + i * 4, true);
    return { data, flags: null, meta: f.meta, phot: f.phot, rec: f.rec };
  });
  return { key: head.key, built: head.built, n: head.n, frames };
}

let index; // promise of data/packs/index.json ({ built, packs: { <view key>: { d1: <file>, …, d6: <file> } } }) or null
const packIndex = () => (index ||= fetch('./data/packs/index.json').then((r) => (r.ok ? r.json() : null)).catch(() => null));

/**
 * Frames of one detector for a view key (see viewer.js loadKey): the first `limit` of that detector's exposures in
 * the app's loading order, or null when there is no pack or it cannot be read. One file per detector, so a view of
 * any detector selection downloads only what it shows. onFrames(batch) receives frames while the file is still
 * arriving, so a slow phone connection shows the first frames after a small part of the file. need (a Set of
 * image paths), when given, reads just far enough to hold every needed frame the file has.
 */
export async function loadPack(key, det, limit = Infinity, onFrames = () => {}, need = null) {
  try {
    const file = (await packIndex())?.packs?.[key]?.[`d${det}`];
    if (!file) return null;
    const r = await fetch(`./data/packs/${file}`);
    if (!r.ok || !r.body) return null;
    // gzip unless the host already decoded it (some hosts send .bin files with Content-Encoding: gzip)
    const [probe, body] = r.body.tee();
    const pr = probe.getReader();
    const first = (await pr.read()).value || new Uint8Array();
    pr.cancel().catch(() => {});
    const gz = first[0] === 0x1f && first[1] === 0x8b;
    const reader = (gz ? body.pipeThrough(new DecompressionStream('gzip')) : body).getReader();
    let buf = new Uint8Array(1 << 20), len = 0, head = null, start = 0, nn = 0, done = 0;
    const frames = [];
    for (;;) {
      const { value, done: end } = await reader.read();
      if (value) {
        if (len + value.length > buf.length) { const b = new Uint8Array(Math.max(buf.length * 2, len + value.length)); b.set(buf.subarray(0, len)); buf = b; }
        buf.set(value, len); len += value.length;
      }
      if (!head && len >= 8) {
        if (new TextDecoder().decode(buf.subarray(0, 4)) !== PACK_MAGIC) throw new Error('not a frame pack');
        const hl = new DataView(buf.buffer).getUint32(4, true);
        if (len >= 8 + hl) {
          head = JSON.parse(new TextDecoder().decode(buf.subarray(8, 8 + hl)));
          if (head.key !== key) return null;
          start = Math.ceil((8 + hl) / 4) * 4; nn = head.n * head.n;
          if (need) { let last = -1; head.frames.forEach((f, k) => { if (need.has(f.rec.uri)) last = k; }); limit = last + 1; }
        }
      }
      if (head) {
        const batch = [];
        const dv = new DataView(buf.buffer);
        while (done < head.frames.length && done < limit && start + (done + 1) * nn * 4 <= len) {
          const data = new Float32Array(nn), o = start + done * nn * 4;
          for (let i = 0; i < nn; i++) data[i] = dv.getFloat32(o + i * 4, true);
          const f = head.frames[done];
          batch.push({ data, flags: null, meta: f.meta, phot: f.phot, rec: f.rec });
          done++;
        }
        if (batch.length) { frames.push(...batch); onFrames(batch); }
      }
      if (end) break;
      if (head && done >= Math.min(limit, head.frames.length)) { reader.cancel().catch(() => {}); break; } // the rest is not needed
    }
    if (!head) return null;
    return { key: head.key, built: head.built, n: head.n, frames };
  } catch (e) {
    console.warn('Frame pack unreadable, streaming instead:', e.message);
    return null;
  }
}

// asked for as soon as the viewer's code loads, so the index is there when the first field opens
if (typeof window !== 'undefined') packIndex();
