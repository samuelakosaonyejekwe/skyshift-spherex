// Minimal animated GIF encoder (GIF89a, fixed 256-colour palette: 6x7x6 colour cube + greys, LZW).
function palette() {
  const p = [];
  for (let r = 0; r < 6; r++) for (let g = 0; g < 7; g++) for (let b = 0; b < 6; b++) p.push([Math.round(r * 51), Math.round(g * 42.5), Math.round(b * 51)]);
  while (p.length < 256) { const v = Math.round(((p.length - 252) / 3) * 255); p.push([v, v, v]); }
  return p;
}
const PAL = palette();
function index(r, g, b) {
  if (Math.abs(r - g) < 6 && Math.abs(g - b) < 6) { // greys: use the cube's grey axis or the extra greys
    const v = (r + g + b) / 3;
    let best = 0, bd = 1e9;
    for (const k of [0, 43, 86, 129, 172, 215, 251, 252, 253, 254, 255]) { const c = PAL[k]; const d = Math.abs(c[0] - v) + Math.abs(c[1] - v) + Math.abs(c[2] - v); if (d < bd) { bd = d; best = k; } }
    return best;
  }
  return Math.round(r / 51) * 42 + Math.round(g / 42.5) * 6 + Math.round(b / 51);
}
function lzw(pixels, minCode = 8) {
  const out = [];
  let cur = 0, bits = 0;
  const clear = 1 << minCode, eoi = clear + 1;
  let size = minCode + 1, dict = new Map(), next = eoi + 1;
  const emit = (code) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>= 8; bits -= 8; } };
  emit(clear);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const k = pixels[i], key = prefix * 256 + k;
    if (dict.has(key)) { prefix = dict.get(key); continue; }
    emit(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { emit(clear); dict = new Map(); next = eoi + 1; size = minCode + 1; }
    prefix = k;
  }
  emit(prefix); emit(eoi);
  if (bits > 0) out.push(cur & 255);
  return out;
}
/** canvases: same-size frames; delayMs per frame. Returns a Blob. */
export function encodeGIF(canvases, delayMs = 500) {
  const W = canvases[0].width, H = canvases[0].height;
  const bytes = [];
  const w16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  bytes.push(...'GIF89a'.split('').map((c) => c.charCodeAt(0)));
  w16(W); w16(H); bytes.push(0xf7, 0, 0);
  for (const [r, g, b] of PAL) bytes.push(r, g, b);
  bytes.push(0x21, 0xff, 0x0b, ...'NETSCAPE2.0'.split('').map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  for (const c of canvases) {
    const px = c.getContext('2d').getImageData(0, 0, W, H).data;
    const idx = new Uint8Array(W * H);
    for (let i = 0; i < idx.length; i++) idx[i] = index(px[i * 4], px[i * 4 + 1], px[i * 4 + 2]);
    bytes.push(0x21, 0xf9, 4, 0); w16(Math.round(delayMs / 10)); bytes.push(0, 0);
    bytes.push(0x2c); w16(0); w16(0); w16(W); w16(H); bytes.push(0);
    bytes.push(8);
    const data = lzw(idx, 8);
    for (let i = 0; i < data.length; i += 255) { const chunk = data.slice(i, i + 255); bytes.push(chunk.length, ...chunk); }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}
