// Procedural app icon (no image dependencies): deep-space disc, orbit arc and a
// star that has shifted position (ghost -> bright), the core idea of the tool.
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const mix = (a, b, t) => a + (b - a) * t;
function shade(u, v, maskable) {
  // u,v in [0,1]
  const cx = u - 0.5, cy = v - 0.5, r = Math.hypot(cx, cy);
  const R = maskable ? 0.5 * Math.SQRT2 : 0.47;
  if (!maskable && r > R) return [0, 0, 0, 0];
  // background gradient: indigo -> near-black
  const t = Math.min(1, Math.hypot(u - 0.3, v - 0.2) / 1.0);
  let col = [mix(52, 7, t), mix(38, 10, t), mix(140, 32, t)];
  const s = maskable ? 0.8 : 1; // safe zone scale
  const X = cx / s + 0.5, Y = cy / s + 0.5;
  // faint stars
  const stars = [[0.22, 0.30, 0.010], [0.74, 0.22, 0.008], [0.80, 0.70, 0.009], [0.30, 0.78, 0.007], [0.62, 0.84, 0.006], [0.15, 0.58, 0.006]];
  for (const [sx, sy, sr] of stars) { const d = Math.hypot(X - sx, Y - sy); if (d < sr * 2.2) { const a = Math.max(0, 1 - d / (sr * 2.2)); col = col.map((c) => mix(c, 230, a * a)); } }
  // orbit ellipse
  const ex = (X - 0.5) / 0.36, ey = (Y - 0.53) / 0.17;
  const e = Math.abs(Math.hypot(ex, ey) - 1) * 0.17;
  if (e < 0.012) { const a = 1 - e / 0.012; col = col.map((c, i) => mix(c, [120, 200, 255][i], a * 0.85)); }
  // motion trail between ghost and star
  const ax = 0.33, ay = 0.60, bx = 0.66, by = 0.40;
  const vx = bx - ax, vy = by - ay, L2 = vx * vx + vy * vy;
  const tt = Math.max(0, Math.min(1, ((X - ax) * vx + (Y - ay) * vy) / L2));
  const dl = Math.hypot(X - (ax + tt * vx), Y - (ay + tt * vy));
  if (dl < 0.022) { const a = (1 - dl / 0.022) * (0.25 + 0.6 * tt); col = col.map((c, i) => mix(c, [255, 140, 90][i], a)); }
  // ghost (earlier epoch)
  const dg = Math.hypot(X - ax, Y - ay);
  if (dg < 0.06) { const a = Math.max(0, 1 - dg / 0.06); col = col.map((c, i) => mix(c, [120, 170, 255][i], a * 0.7)); }
  // current star with glow
  const ds = Math.hypot(X - bx, Y - by);
  const glow = Math.exp(-((ds / 0.09) ** 2));
  col = col.map((c, i) => mix(c, [255, 214, 120][i], glow * 0.9));
  if (ds < 0.045) { const a = 1 - ds / 0.045; col = col.map((c) => mix(c, 255, Math.min(1, a * 1.6))); }
  // rim highlight
  if (!maskable && r > R - 0.012) { const a = (r - (R - 0.012)) / 0.012; col = col.map((c, i) => mix(c, [140, 120, 255][i], a * 0.6)); }
  return [...col, 255];
}
function render(size, maskable = false) {
  const ss = 4, buf = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const acc = [0, 0, 0, 0];
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) {
      const c = shade((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size, maskable);
      acc[0] += c[0] * c[3]; acc[1] += c[1] * c[3]; acc[2] += c[2] * c[3]; acc[3] += c[3];
    }
    const k = (y * size + x) * 4, a = acc[3] / (ss * ss);
    buf[k] = acc[3] ? acc[0] / acc[3] : 0; buf[k + 1] = acc[3] ? acc[1] / acc[3] : 0; buf[k + 2] = acc[3] ? acc[2] / acc[3] : 0; buf[k + 3] = a;
  }
  return png(size, size, buf);
}
mkdirSync('icons', { recursive: true });
for (const s of [32, 192, 512]) writeFileSync(`icons/icon-${s}.png`, render(s));
writeFileSync('icons/maskable-512.png', render(512, true));
writeFileSync('icons/apple-touch-icon.png', render(180, true));
console.log('icons written');
