import test from 'node:test';
import assert from 'node:assert/strict';
import { precessFromJ2000, abMag } from '../src/lib/coords.js';

test('precession to the equinox of date matches Meeus example 21.b (θ Persei, 2028 Nov 13.19 TD)', () => {
  const p = precessFromJ2000(41.054063, 49.227750, 2462088.69);
  assert.ok(Math.abs(p.ra - 41.547214) < 2e-6, `RA ${p.ra}`);
  assert.ok(Math.abs(p.dec - 49.348483) < 2e-6, `Dec ${p.dec}`);
  const same = precessFromJ2000(10, 20, 2451545.0);
  assert.ok(Math.abs(same.ra - 10) < 1e-9 && Math.abs(same.dec - 20) < 1e-9);
});

test('AB magnitudes: 3631 Jy is 0, 1 µJy is 23.9, errors scale as 1.0857 σ/F, no magnitude for non-positive flux', () => {
  assert.ok(Math.abs(abMag(3631e6).mag) < 1e-3);
  const m = abMag(1, 0.1);
  assert.ok(Math.abs(m.mag - 23.9) < 1e-12);
  assert.ok(Math.abs(m.err - 0.10857) < 1e-9);
  assert.equal(abMag(0), null);
  assert.equal(abMag(-5, 1), null);
});
