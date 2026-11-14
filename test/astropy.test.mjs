import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpherexImage } from '../src/lib/spherex.js';

// Reference values produced by test/validate_astropy.py with astropy.wcs on the same files.
const ref = JSON.parse(readFileSync(new URL('./fixtures/astropy-reference.json', import.meta.url)));
const TOL = { worldArcsec: 0.01, pixel: 0.001, wavelengthUm: 1e-5 };

test(`browser WCS and wavelengths match Astropy ${ref.astropy} (tolerances ${JSON.stringify(TOL)})`, { timeout: 180000 }, async () => {
  let worst = { world: 0, pix: 0, wl: 0, bw: 0 };
  for (const f of ref.files) {
    const img = new SpherexImage('ibe/data/spherex/' + f.key);
    await img.meta();
    const w = await img.wave();
    for (const p of f.points) {
      const [ra, dec] = img.wcs.pixToWorld(p.x0 + 1, p.y0 + 1);
      const dra = (((ra - p.ra + 540) % 360) - 180) * Math.cos((p.dec * Math.PI) / 180) * 3600, ddec = (dec - p.dec) * 3600;
      worst.world = Math.max(worst.world, Math.hypot(dra, ddec));
      const [x, y] = img.wcs.worldToPix(p.ra, p.dec);
      worst.pix = Math.max(worst.pix, Math.hypot(x - 1 - p.x0, y - 1 - p.y0));
      const s = w.at(p.x0 + 1, p.y0 + 1);
      worst.wl = Math.max(worst.wl, Math.abs(s.wavelength - p.wl));
      worst.bw = Math.max(worst.bw, Math.abs(s.bandwidth - p.bw));
    }
  }
  console.log('worst differences vs astropy:', JSON.stringify(worst));
  assert.ok(worst.world < TOL.worldArcsec, `world ${worst.world}″`);
  assert.ok(worst.pix < TOL.pixel, `pixel ${worst.pix}`);
  assert.ok(worst.wl < TOL.wavelengthUm && worst.bw < TOL.wavelengthUm, `wavelength ${worst.wl}, bandwidth ${worst.bw}`);
});
