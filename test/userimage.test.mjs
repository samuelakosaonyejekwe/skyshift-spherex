import test from 'node:test';
import assert from 'node:assert/strict';
import { readFitsImage, pixelToSky, skyToPixel, centroid, aperture, calibrate, imageMjd, headerZeroPoint } from '../src/lib/userimage.js';

// A synthetic 200×200 FITS image (BITPIX -32) with a TAN WCS, Gaussian stars (FWHM 3 px) and a known zero point.
function makeFits({ stars, zp = 25, bg = 100, noise = 0 }) {
  const W = 200, H = 200;
  const cards = { SIMPLE: 'T', BITPIX: -32, NAXIS: 2, NAXIS1: W, NAXIS2: H, CTYPE1: "'RA---TAN'", CTYPE2: "'DEC--TAN'", CRPIX1: 100.5, CRPIX2: 100.5,
    CRVAL1: 150, CRVAL2: 2, CD1_1: -1 / 3600, CD1_2: 0, CD2_1: 0, CD2_2: 1 / 3600, 'DATE-OBS': "'2026-03-14T05:30:00'", MAGZP: 24.9 };
  let hdr = '';
  for (const [k, v] of Object.entries(cards)) hdr += `${k.padEnd(8)}= ${String(v).padStart(20)}`.padEnd(80);
  hdr += 'END'.padEnd(80);
  while (hdr.length % 2880) hdr += ' ';
  const data = new Float32Array(W * H).fill(bg);
  let seed = 1; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (const s of stars) {
    const flux = 10 ** ((zp - s.mag) / 2.5), sig = 3 / 2.3548;
    for (let y = Math.floor(s.y - 12); y <= s.y + 12; y++) for (let x = Math.floor(s.x - 12); x <= s.x + 12; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      data[y * W + x] += (flux / (2 * Math.PI * sig * sig)) * Math.exp(-((x - s.x) ** 2 + (y - s.y) ** 2) / (2 * sig * sig));
    }
  }
  if (noise) for (let i = 0; i < data.length; i++) data[i] += noise * (rnd() + rnd() + rnd() - 1.5) * 2;
  const body = new Uint8Array(Math.ceil((W * H * 4) / 2880) * 2880);
  const dv = new DataView(body.buffer);
  data.forEach((v, i) => dv.setFloat32(i * 4, v, false));
  const out = new Uint8Array(hdr.length + body.length);
  out.set(new TextEncoder().encode(hdr), 0); out.set(body, hdr.length);
  return out;
}

const field = Array.from({ length: 24 }, (_, i) => ({ x: 25 + (i % 6) * 30 + (i % 3), y: 25 + Math.floor(i / 6) * 40 + (i % 2), mag: 13 + (i % 8) * 0.5 }));

test('user FITS image: pixels, WCS coordinates and date are read', () => {
  const img = readFitsImage(makeFits({ stars: field }));
  assert.equal(img.width, 200); assert.equal(img.height, 200);
  const c = pixelToSky(img, 99.5, 99.5); // CRPIX is 1-based 100.5
  assert.ok(Math.abs(c.ra - 150) < 1e-9 && Math.abs(c.dec - 2) < 1e-9);
  const p = skyToPixel(img, c.ra, c.dec);
  assert.ok(Math.abs(p.x - 99.5) < 1e-6 && Math.abs(p.y - 99.5) < 1e-6);
  assert.ok(Math.abs(imageMjd(img.header) - 61113.229166666664) < 1e-6);
  assert.deepEqual(headerZeroPoint(img.header), { zp: 24.9, key: 'MAGZP' });
});

test('centroid finds a star to a few hundredths of a pixel, aperture flux matches the input', () => {
  const img = readFitsImage(makeFits({ stars: [{ x: 80.3, y: 120.7, mag: 14 }] }));
  const c = centroid(img, 82, 119, 4);
  assert.ok(Math.hypot(c.x - 80.3, c.y - 120.7) < 0.05, `${c.x}, ${c.y}`);
  const a = aperture(img, c.x, c.y, 6, 9, 14);
  const want = 10 ** ((25 - 14) / 2.5);
  assert.ok(Math.abs(a.flux / want - 1) < 0.02, `flux ${a.flux} vs ${want}`);
});

test('calibration on catalogue stars recovers the zero point; magnitudes follow', () => {
  const img = readFitsImage(makeFits({ stars: field, noise: 2 }));
  const gaia = field.map((s, i) => { const q = pixelToSky(img, s.x, s.y); return { source_id: String(i), ra: q.ra, dec: q.dec, pmra: 0, pmdec: 0, ref_epoch: 2016, phot_g_mean_mag: s.mag }; });
  const cal = calibrate(img, gaia, imageMjd(img.header));
  assert.ok(cal.ok, JSON.stringify(cal));
  assert.ok(cal.n >= 10, `n ${cal.n}`);
  // aperture of 1.5 FWHM holds about 96% of the light: the zero point absorbs that, as in real calibrations
  assert.ok(Math.abs(cal.zp - (25 - 2.5 * Math.log10(0.96))) < 0.08, `zp ${cal.zp}`);
  assert.ok(Math.abs(cal.fwhm - 3) < 0.6, `fwhm ${cal.fwhm}`);
});

test('older WCS spellings (PC001001…, CROTA2) give the same sky solution as PCi_j / CD', async () => {
  const { normaliseWcs } = await import('../src/lib/userimage.js');
  const a = normaliseWcs({ PC001001: -1, PC001002: 0, PC002001: 0, PC002002: 1, CDELT1: 1e-4 });
  assert.equal(a.PC1_1, -1); assert.equal(a.PC2_2, 1);
  const b = normaliseWcs({ CDELT1: -2e-4, CDELT2: 2e-4, CROTA2: 90 });
  assert.ok(Math.abs(b.CD1_1) < 1e-12 && Math.abs(b.CD1_2 + 2e-4) < 1e-12 && Math.abs(b.CD2_1 + 2e-4) < 1e-12);
});
