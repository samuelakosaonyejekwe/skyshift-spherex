import test from 'node:test';
import assert from 'node:assert/strict';
import { SpherexImage } from '../src/lib/spherex.js';
import { makeGrid, renderExposure, worldToGrid, gridToWorld } from '../src/lib/engine.js';
import { propagate } from '../src/lib/coords.js';

test('grid round trip', () => {
  const g = makeGrid(269.45, 4.69, 3);
  const [ra, dec] = gridToWorld(g, 3.2, 20.7);
  const [i, j] = worldToGrid(g, ra, dec);
  assert.ok(Math.abs(i - 3.2) < 1e-6 && Math.abs(j - 20.7) < 1e-6);
  const [r2] = gridToWorld(g, 0, (g.n - 1) / 2);
  assert.ok(r2 > 269.45, 'east is left (column 0 has larger RA)');
});

test('render Barnard\'s Star exposure', { timeout: 120000 }, async () => {
  const uri = 'ibe/data/spherex/dr1/level2/2025W33_2C/l2b-v27-2026-228/3/level2_2025W33_2C_0321_1D3_spx_l2b-v27-2026-228.fits';
  const p = propagate(269.44850252544, 4.73942005111, -801.551, 10362.394, 2016, 2025.62);
  const g = makeGrid(p.ra, p.dec, 3);
  let bytes = 0;
  const img = new SpherexImage(uri, { onBytes: (n) => (bytes += n) });
  const t = Date.now();
  const r = await renderExposure(img, g, { uri }, { withFlags: true });
  assert.ok(r, 'rendered');
  const c = (g.n - 1) / 2;
  const centre = r.data[c * g.n + c];
  console.log('n', g.n, 'bytes', bytes, 'ms', Date.now() - t, 'wl', r.meta.wavelength?.toFixed(4), 'bg', r.meta.bg.toFixed(3),
    'centre', centre.toFixed(2), 'phot', r.phot && r.phot.flux.toFixed(0), '+-', r.phot && r.phot.err.toFixed(0), 'uJy flags', JSON.stringify(r.meta.flagCounts));
  // Barnard's Star saturates SPHEREx: core is NaN and OVERFLOW/BLOOM flags are set.
  assert.ok(r.meta.saturated || centre > r.meta.bg + 10 * r.meta.sigma, 'saturated or bright at centre');
  // neighbour Gaia DR3 4472832165289153024 (G=11.45) must be measurable
  const { photAt } = await import('../src/lib/engine.js');
  const ph = await photAt(img, 269.46646068714, 4.70557281066);
  console.log('neighbour', ph && ph.flux.toFixed(0), '+-', ph && ph.err.toFixed(0), 'uJy at', ph && ph.wavelength.toFixed(3));
  assert.ok(ph && ph.flux > 5 * ph.err, 'neighbour detected');
});
