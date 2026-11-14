// Builds icons/../assets/allsky.png: the real SPHEREx sky (DR1 all-sky spectral cube, IRSA HiPS)
// as a false-colour Mollweide map in galactic coordinates. Three cube channels are read from the
// HiPS "Allsky" previews (order 3) and combined as blue / green / red. No dependencies.
//
// HiPS layout (IVOA HiPS 1.0): an order-3 Allsky image holds the 768 order-3 tiles, 27 per row,
// each downsampled to tile_width / 8 pixels; tile pixel (x, y) maps to the nested HEALPix index
// tile * w^2 + interleave(x, y) with y counted from the bottom of the tile.

import { inflateSync, deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';

const HIPS = 'https://irsa.ipac.caltech.edu/data/hips/SPHEREx/spherex_allsky_cube';
// cube frame index (0-based): 17 channels per detector (IRSA cube tutorial); 50/51 are blank
const CHANNELS = { b: 8, g: 42, r: 95 }; // ≈0.9 µm (D1), ≈2.0 µm (D3), ≈4.6 µm (D6)
const OUT_W = Number(process.env.ALLSKY_W || 1200), OUT_H = OUT_W / 2;
const VARIANT = Number(process.env.ALLSKY_VARIANT ?? 5); // in-tile pixel convention (verified by scripts/allsky.mjs --pick)

// ------------------------------------------------------------------ PNG decode / encode
function decodePNG(buf) {
  let p = 8, w, h, bitDepth, colorType, idat = [], palette = null;
  while (p < buf.length) {
    const len = buf.readUInt32BE(p), type = buf.toString('ascii', p + 4, p + 8), data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bitDepth = data[8]; colorType = data[9]; }
    else if (type === 'PLTE') palette = data;
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    p += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  const ch = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch, out = Buffer.alloc(w * h * ch);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)], line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0, b = y ? out[(y - 1) * stride + x] : 0, c = x >= ch && y ? out[(y - 1) * stride + x - ch] : 0;
      let v = line[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out[y * stride + x] = v & 255;
    }
  }
  // grey value per pixel (first channel, or palette lookup)
  const g = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = colorType === 3 ? palette[out[i] * 3] : out[i * ch];
  const alpha = colorType === 6 || colorType === 4 ? Uint8Array.from({ length: w * h }, (_, i) => out[i * ch + ch - 1]) : null;
  return { w, h, g, alpha };
}
function crc32(b) { let c, crc = ~0; for (let n = 0; n < b.length; n++) { c = (crc ^ b[n]) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; }
function encodePNG(w, h, rgba) {
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc32(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

// ------------------------------------------------------------------ HEALPix (nested) ang2pix
const JRLL = [2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4], JPLL = [1, 3, 5, 7, 0, 2, 4, 6, 1, 3, 5, 7];
function spread(v) { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >> i) & 1) << (2 * i); return r >>> 0; }
function ang2pixNest(order, theta, phi) {
  const nside = 1 << order, z = Math.cos(theta), za = Math.abs(z);
  let tt = (phi / (Math.PI / 2)) % 4; if (tt < 0) tt += 4;
  let face, ix, iy;
  if (za <= 2 / 3) {
    const temp1 = nside * (0.5 + tt), temp2 = nside * (z * 0.75);
    const jp = Math.floor(temp1 - temp2), jm = Math.floor(temp1 + temp2);
    const ifp = Math.floor(jp / nside), ifm = Math.floor(jm / nside);
    face = ifp === ifm ? (ifp | 4) : ifp < ifm ? ifp : ifm + 8;
    ix = jm & (nside - 1); iy = nside - (jp & (nside - 1)) - 1;
  } else {
    const ntt = Math.min(3, Math.floor(tt)), tp = tt - ntt;
    const tmp = nside * Math.sqrt(3 * (1 - za));
    let jp = Math.floor(tp * tmp), jm = Math.floor((1 - tp) * tmp);
    jp = Math.min(jp, nside - 1); jm = Math.min(jm, nside - 1);
    if (z >= 0) { face = ntt; ix = nside - jm - 1; iy = nside - jp - 1; } else { face = ntt + 8; ix = jp; iy = jm; }
  }
  return face * nside * nside + spread(ix) + 2 * spread(iy);
}

// galactic (l, b) -> ICRS (ra, dec), degrees
function galToEq(l, b) {
  const D = Math.PI / 180;
  const M = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
  const x = Math.cos(b * D) * Math.cos(l * D), y = Math.cos(b * D) * Math.sin(l * D), z = Math.sin(b * D);
  const ex = M[0][0] * x + M[1][0] * y + M[2][0] * z, ey = M[0][1] * x + M[1][1] * y + M[2][1] * z, ez = M[0][2] * x + M[1][2] * y + M[2][2] * z;
  let ra = Math.atan2(ey, ex) / D; if (ra < 0) ra += 360;
  return [ra, Math.asin(Math.max(-1, Math.min(1, ez))) / D];
}

async function fetchAllsky(frame) {
  const url = `${HIPS}/Norder3/Allsky${frame ? `_${frame}` : ''}.png`;
  const r = await fetch(url, { headers: { 'User-Agent': 'SkyShift-build/1.0' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return decodePNG(Buffer.from(await r.arrayBuffer()));
}

const props = await (await fetch(`${HIPS}/properties`)).text();
const tileWidth = Number((props.match(/^hips_tile_width\s*=\s*(\d+)/m) || [])[1] || 512);
const imgs = {};
for (const [k, f] of Object.entries(CHANNELS)) imgs[k] = await fetchAllsky(f);
const tw = imgs.g.w / 27; // allsky tile width (27 tiles per row)
const sub = Math.log2(tw); // extra HEALPix orders inside a tile
if (!Number.isInteger(sub)) throw new Error(`unexpected Allsky width ${imgs.g.w}`);
const order = 3 + sub;
const unspread = (v) => { let r = 0; for (let i = 0; i < 16; i++) r |= ((v >> (2 * i)) & 1) << i; return r; };

function sample(img, ra, dec) {
  const theta = (90 - dec) * Math.PI / 180, phi = ra * Math.PI / 180;
  const ipix = ang2pixNest(order, theta, phi);
  const tile = Math.floor(ipix / (tw * tw)), inner = ipix % (tw * tw);
  let x = unspread(inner), y = unspread(inner >> 1);
  if (VARIANT & 1) [x, y] = [y, x];
  if (VARIANT & 2) x = tw - 1 - x;
  if (!(VARIANT & 4)) y = tw - 1 - y;
  const tx = (tile % 27) * tw, ty = Math.floor(tile / 27) * tw;
  const px = tx + x, py = ty + y;
  const k = py * img.w + px;
  return img.alpha && img.alpha[k] === 0 ? null : img.g[k];
}

const out = new Uint8ClampedArray(OUT_W * OUT_H * 4);
const ss = Number(process.env.ALLSKY_SS || 4); // supersampling (averages several HEALPix cells per output pixel)
for (let j = 0; j < OUT_H; j++) {
  for (let i = 0; i < OUT_W; i++) {
    let r = 0, g = 0, b = 0, n = 0;
    for (let sj = 0; sj < ss; sj++) for (let si = 0; si < ss; si++) {
      // Mollweide inverse: x in [-2√2, 2√2], y in [-√2, √2]
      const X = ((i + (si + 0.5) / ss) / OUT_W - 0.5) * 4 * Math.SQRT2, Y = (0.5 - (j + (sj + 0.5) / ss) / OUT_H) * 2 * Math.SQRT2;
      if ((X * X) / 8 + (Y * Y) / 2 > 1) continue;
      const th = Math.asin(Y / Math.SQRT2);
      const lat = Math.asin((2 * th + Math.sin(2 * th)) / Math.PI);
      const lon = -(Math.PI * X) / (2 * Math.SQRT2 * Math.cos(th)); // galactic longitude increases to the left
      const [ra, dec] = galToEq((lon * 180) / Math.PI, (lat * 180) / Math.PI);
      const vb = sample(imgs.b, ra, dec), vg = sample(imgs.g, ra, dec), vr = sample(imgs.r, ra, dec);
      if (vg == null) continue;
      r += vr ?? vg; g += vg; b += vb ?? vg; n++;
    }
    const o = (j * OUT_W + i) * 4;
    if (!n) { out[o + 3] = 0; continue; }
    // gentle asinh-like lift of the fixed 8-bit HiPS stretch, so faint sky shows without clipping
    const lift = (v) => 255 * Math.asinh((v / n / 255) * 3) / Math.asinh(3);
    out[o] = lift(r); out[o + 1] = lift(g); out[o + 2] = lift(b); out[o + 3] = 255;
  }
}
let rough = 0;
for (let j = 1; j < OUT_H; j++) for (let i = 1; i < OUT_W; i++) { const o = (j * OUT_W + i) * 4; if (out[o + 3] && out[o - 4 + 3] && out[o - OUT_W * 4 + 3]) rough += Math.abs(out[o + 1] - out[o - 4 + 1]) + Math.abs(out[o + 1] - out[o - OUT_W * 4 + 1]); }
console.log('variant', VARIANT, 'roughness', rough);
if (process.env.ALLSKY_DRY) process.exit(0);
mkdirSync('assets', { recursive: true });
writeFileSync(`assets/allsky-${OUT_W}.png`, encodePNG(OUT_W, OUT_H, out));
writeFileSync('assets/allsky.json', JSON.stringify({
  source: `${HIPS} (SPHEREx DR1 all-sky spectral cube, IRSA HiPS, ${(props.match(/^hips_release_date\s*=\s*(.+)$/m) || [])[1]?.trim()})`,
  channels: CHANNELS, wavelengthsApproxUm: { b: 0.9, g: 2.0, r: 4.6 }, projection: 'Mollweide, galactic coordinates, l=0 at centre', tileWidth, order, built: new Date().toISOString(),
}, null, 2));
console.log(`assets/allsky-${OUT_W}.png ${OUT_W}x${OUT_H} from HiPS order 3 Allsky (tile ${tw}px, HEALPix order ${order})`);
