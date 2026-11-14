import test from 'node:test';
import assert from 'node:assert/strict';
import { SpherexImage, decodeFlags } from '../src/lib/spherex.js';
import { parsePosition, propagate, formatRA, formatDec } from '../src/lib/coords.js';

// Test vector published in the IRSA "Introduction to SPHEREx Spectral Images" tutorial.
const URI = 'ibe/data/spherex/dr1/level2/2025W18_1B/l2b-v27-2026-196/1/level2_2025W18_1B_0074_2D1_spx_l2b-v27-2026-196.fits';
// The tutorial evaluates the image's reference point (CRVAL1, CRVAL2).
const RA = 303.877766184, DEC = 40.5489585415;

test('coordinate parsing', () => {
  const p = parsePosition('08h55m10.831s -7d14m42.53s');
  assert.ok(Math.abs(p.ra - 133.795129) < 1e-5 && Math.abs(p.dec + 7.245147) < 1e-5);
  const q = parsePosition('17:57:48.5, +04:41:36');
  assert.ok(Math.abs(q.ra - 269.452083) < 1e-5 && Math.abs(q.dec - 4.693333) < 1e-5);
  assert.deepEqual(parsePosition('269.452 4.6933'), { ra: 269.452, dec: 4.6933 });
  assert.equal(parsePosition('abc'), null);
  assert.equal(formatRA(133.795129), '08h55m10.831s');
  assert.equal(formatDec(-7.245147), '-07°14′42.53″');
  const b = propagate(269.44850252544, 4.73942005111, -801.551, 10362.394, 2016, 2026);
  assert.ok(Math.abs(b.dec - (4.73942005111 + 10.362394 * 10 / 3600)) < 1e-9);
});

test('WCS, wavelength table and flags against IRSA tutorial values', { timeout: 120000 }, async () => {
  const img = new SpherexImage(URI);
  const m = await img.meta();
  assert.equal(m.header.NAXIS1, 2040);
  const [x, y] = img.wcs.worldToPix(RA, DEC);
  // tutorial (0-based astropy): x=1019.0880637763953, y=1020.746373505631
  assert.ok(Math.abs(x - 1 - 1019.0880637763953) < 0.01, `x=${x - 1}`);
  assert.ok(Math.abs(y - 1 - 1020.746373505631) < 0.01, `y=${y - 1}`);
  const [r2, d2] = img.wcs.pixToWorld(x, y);
  assert.ok(Math.abs(r2 - RA) < 1e-7 && Math.abs(d2 - DEC) < 1e-7);
  const w = await img.wave();
  const s = w.at(x, y);
  assert.ok(Math.abs(s.wavelength - 0.90416686) < 2e-4, `wl=${s.wavelength}`);
  assert.ok(Math.abs(s.bandwidth - 0.02298403) < 2e-4, `bw=${s.bandwidth}`);
  assert.ok(Math.abs(w.at(1, 1).wavelength - 1.12616599) < 1e-6);
  const rows = await img.rows(1015, 1025);
  assert.equal(rows.data.length, 11 * 2040);
  assert.ok(rows.data.some((v) => Number.isFinite(v) && v !== 0));
  const fl = await img.flagRows(1015, 1025);
  assert.equal(fl.data.length, 11 * 2040);
  assert.equal(fl.bits[21], 'SOURCE');
  const nonzero = fl.data.filter((v) => v !== 0).length;
  assert.ok(nonzero > 0 && nonzero < fl.data.length, `flags nonzero=${nonzero}`);
  assert.ok(fl.data.every((v) => (v & ~((1 << 29) - 1)) === 0), 'only bits 0-28 used');
  console.log('pixel', x - 1, y - 1, 'wl', s.wavelength, 'bw', s.bandwidth, 'flags sample', decodeFlags(fl.data[5 * 2040 + 1019]));
});

// Annual parallax: displacement of Barnard's Star (ϖ = 547 mas) against Astropy's ICRS→GCRS transform
// (finite distance vs infinite distance), at three dates; the low-precision Sun formula allows a few mas.
test('parallax displacement matches Astropy', async () => {
  const { apparent } = await import('../src/lib/coords.js');
  const ref = [[61000, -276, -216], [61091, 477, -122], [61182, 269, 229]];
  for (const [mjd, ex, ey] of ref) {
    const a = apparent(269.452, 4.693, 0, 0, 547, 2026, mjd), b = apparent(269.452, 4.693, 0, 0, 0, 2026, mjd);
    const dx = (a.ra - b.ra) * 3.6e6 * Math.cos((4.693 * Math.PI) / 180), dy = (a.dec - b.dec) * 3.6e6;
    assert.ok(Math.abs(dx - ex) < 8 && Math.abs(dy - ey) < 8, `MJD ${mjd}: ${dx.toFixed(0)}, ${dy.toFixed(0)} vs ${ex}, ${ey}`);
  }
});
