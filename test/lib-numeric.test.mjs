import test from 'node:test';
import assert from 'node:assert/strict';
import { CelestialWCS } from '../src/lib/wcs.js';
import { parseTime } from '../src/lib/ephem.js';
import { riceDecode, riceDecodeReference } from '../src/lib/fits.js';
import { readFitsImage, imageMjd } from '../src/lib/userimage.js';
import { parseAngle, parsePosition } from '../src/lib/coords.js';
import { parse, evalScalar, splitStatements } from '../src/lib/expr.js';

// RICE_1 encoder written after CFITSIO's fits_rcomp / fits_rcomp_short / fits_rcomp_byte (MSB-first bit stream).
function riceEncode(a, nblock, bytepix) {
  const fsbits = bytepix === 1 ? 3 : bytepix === 2 ? 4 : 5, fsmax = bytepix === 1 ? 6 : bytepix === 2 ? 14 : 25, bbits = 8 * bytepix;
  const bits = [];
  const put = (v, n) => { for (let k = n - 1; k >= 0; k--) bits.push(Number((BigInt(v) >> BigInt(k)) & 1n)); };
  const mask = (1n << BigInt(bbits)) - 1n;
  const wrapT = (v) => (bytepix === 4 ? v | 0 : bytepix === 2 ? (v << 16) >> 16 : ((v & 0xff) << 24) >> 24);
  put(Number(BigInt(a[0]) & mask), bbits);
  let last = a[0];
  for (let i = 0; i < a.length; i += nblock) {
    const tb = Math.min(nblock, a.length - i), diff = [];
    let sum = 0;
    for (let j = 0; j < tb; j++) {
      const pd = wrapT(a[i + j] - last);
      const d = Number(BigInt(pd < 0 ? ~(pd * 2) : pd * 2) & mask);
      diff.push(d); sum += d; last = a[i + j];
    }
    let dpsum = (sum - Math.floor(tb / 2) - 1) / tb; if (dpsum < 0) dpsum = 0;
    let psum = Math.floor(dpsum) >>> 1, fs = 0;
    while (psum > 0) { fs++; psum >>>= 1; }
    if (fs >= fsmax) { put(fsmax + 1, fsbits); for (const d of diff) put(d, bbits); }
    else if (fs === 0 && sum === 0) put(0, fsbits);
    else {
      put(fs + 1, fsbits);
      for (const d of diff) { const top = Math.floor(d / 2 ** fs); for (let z = 0; z < top; z++) bits.push(0); bits.push(1); if (fs > 0) put(d % 2 ** fs, fs); }
    }
  }
  while (bits.length % 8) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  for (let i = 0; i < out.length; i++) { let v = 0; for (let k = 0; k < 8; k++) v = v * 2 + bits[i * 8 + k]; out[i] = v; }
  return out;
}

test('SIP distortion without inverse (AP/BP) coefficients: sky to pixel inverts pixel to sky', () => {
  const w = new CelestialWCS({ CTYPE1: 'RA---TAN-SIP', CTYPE2: 'DEC--TAN-SIP', CRPIX1: 100, CRPIX2: 100, CRVAL1: 10, CRVAL2: 20,
    CD1_1: -1e-3, CD1_2: 0, CD2_1: 0, CD2_2: 1e-3, A_ORDER: 2, A_2_0: 1e-4, A_0_2: 2e-4, B_ORDER: 2, B_1_1: 1.5e-4 });
  for (const [x, y] of [[300, 250], [1, 1], [100, 100], [180, 20]]) {
    const [ra, dec] = w.pixToWorld(x, y);
    const [x2, y2] = w.worldToPix(ra, dec);
    assert.ok(Math.hypot(x2 - x, y2 - y) < 1e-6, `(${x}, ${y}) -> (${x2}, ${y2})`);
  }
});

test('ephemeris times keep fractions of a second', () => {
  const d = (parseTime('2026-03-14T05:30:30.75') - parseTime('2026-03-14T05:30:30')) * 86400;
  assert.ok(Math.abs(d - 0.75) < 1e-5, `${d} s`);
});

test('RICE_1 decoders (1, 2 and 4 bytes per pixel) reproduce the encoded values', () => {
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const bytepix of [4, 2, 1]) for (let trial = 0; trial < 120; trial++) {
    const nx = 1 + Math.floor(rnd() * 150), scale = [0, 1, 10, 1000, 1e5, 2 ** 30, 2 ** 31][trial % 7];
    const a = Array.from({ length: nx }, (_, i) => {
      let v = Math.round((rnd() - 0.5) * 2 * scale) + (i > 20 && i < 60 && trial % 5 === 0 ? 0 : 5);
      if (trial % 5 === 0 && i > 20 && i < 60) v = 42; // a flat run: the low-entropy block code
      return bytepix === 4 ? v | 0 : bytepix === 2 ? (v << 16) >> 16 : v & 0xff;
    });
    const c = riceEncode(a, 32, bytepix);
    assert.deepEqual(Array.from(riceDecode(c, nx, 32, bytepix)), a, `bytepix ${bytepix} trial ${trial}`);
    assert.deepEqual(Array.from(riceDecodeReference(c, nx, 32, bytepix)), a, `reference, bytepix ${bytepix} trial ${trial}`);
  }
});

test('a tile-compressed data cube shows its first plane instead of failing', () => {
  const W = 4, H = 3, P = 2;
  const planes = Array.from({ length: P }, (_, p) => Array.from({ length: W * H }, (_, i) => 100 * (p + 1) + i));
  const tiles = [];
  for (let p = 0; p < P; p++) for (let y = 0; y < H; y++) tiles.push(riceEncode(planes[p].slice(y * W, (y + 1) * W), 32, 2));
  const heap = tiles.reduce((n, t) => n + t.length, 0);
  const prim = { SIMPLE: 'T', BITPIX: 8, NAXIS: 0, EXTEND: 'T' };
  const ext = { XTENSION: "'BINTABLE'", BITPIX: 8, NAXIS: 2, NAXIS1: 8, NAXIS2: tiles.length, PCOUNT: heap, GCOUNT: 1, TFIELDS: 1,
    TTYPE1: "'COMPRESSED_DATA'", TFORM1: "'1PB(64)'", ZIMAGE: 'T', ZCMPTYPE: "'RICE_1'", ZBITPIX: 16, ZNAXIS: 3, ZNAXIS1: W, ZNAXIS2: H, ZNAXIS3: P,
    ZTILE1: W, ZTILE2: 1, ZTILE3: 1, ZNAME1: "'BLOCKSIZE'", ZVAL1: 32, ZNAME2: "'BYTEPIX'", ZVAL2: 2,
    CTYPE1: "'RA---TAN'", CTYPE2: "'DEC--TAN'", CRPIX1: 2, CRPIX2: 2, CRVAL1: 10, CRVAL2: 20, CD1_1: -1e-3, CD1_2: 0, CD2_1: 0, CD2_2: 1e-3 };
  const hdr = (cards) => { let s = ''; for (const [k, v] of Object.entries(cards)) s += `${k.padEnd(8)}= ${String(v).padStart(20)}`.padEnd(80); s += 'END'.padEnd(80); while (s.length % 2880) s += ' '; return new TextEncoder().encode(s); };
  const h0 = hdr(prim), h1 = hdr(ext);
  const table = new Uint8Array(8 * tiles.length), dv = new DataView(table.buffer);
  let o = 0;
  tiles.forEach((t, k) => { dv.setInt32(k * 8, t.length, false); dv.setInt32(k * 8 + 4, o, false); o += t.length; });
  const dataLen = Math.ceil((table.length + heap) / 2880) * 2880;
  const bytes = new Uint8Array(h0.length + h1.length + dataLen);
  bytes.set(h0, 0); bytes.set(h1, h0.length); bytes.set(table, h0.length + h1.length);
  o = h0.length + h1.length + table.length;
  for (const t of tiles) { bytes.set(t, o); o += t.length; }
  const img = readFitsImage(bytes);
  assert.equal(img.width, W); assert.equal(img.height, H);
  assert.deepEqual(Array.from(img.data), planes[0]);
});

test('expressions accept only the listed functions (no object built-ins such as constructor)', () => {
  assert.throws(() => parse('constructor(1)'), /Unknown function/);
  assert.equal(evalScalar(parse('max(1, 3) + abs(-2)'), {}), 5);
  // the error pointer sits under the offending character of the whole line
  const e = splitStatements('where det >= $4').errors[0];
  assert.equal(e.pointer.split('\n')[1].length - 1, 'where det >= '.length);
});

test('a lone sign is not read as zero; a sign separated by a space still counts', () => {
  assert.ok(Number.isNaN(parseAngle('+')));
  assert.equal(parsePosition('10 -'), null);
  assert.equal(parseAngle('- 5'), -5);
  assert.deepEqual(parsePosition('10.5 - 5.2'), { ra: 10.5, dec: -5.2 });
});

test("pre-2000 DATE-OBS 'dd/mm/yy' is day/month/year", () => {
  assert.equal(imageMjd({ 'DATE-OBS': '02/01/99' }), 51180); // 1999-01-02
  assert.equal(imageMjd({ 'DATE-OBS': '25/12/98', 'TIME-OBS': '12:00:00' }), 51172.5);
});
