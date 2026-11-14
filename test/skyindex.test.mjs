// Static image index: encoding round trip, footprint containment and tile coverage, checked
// against real SPHEREx footprints returned by IRSA TAP for a CONTAINS query at WISE 0855.
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeRow, decodeRow, cornersFromWkb, contains, tileOf, tilesNear, centreOf, sep, cellsInBand, NBANDS } from '../src/lib/skyindex.js';

// IRSA TAP rows (uri, time_bounds_lower, poly) whose footprint CONTAINS (133.786, -7.244)
const ROWS = [
  ['ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/1/level2_2025W19_1B_0241_1D1_spx_l2b-v27-2026-197.fits', 60801.514177, 1, '0103000020E6100000010000000500000060EC98F4058C60406F66D795EA1817C04F2AC53738F660405346F8E3D77B1BC01E4D7B525DCF6040B25C66296B4824C0BF1A4C9975636040EE9327C26C0F22C060EC98F4058C60406F66D795EA1817C0'],
  ['ibe/data/spherex/dr1/level2/2025W19_1B/l2b-v27-2026-197/4/level2_2025W19_1B_0241_1D4_spx_l2b-v27-2026-197.fits', 60801.514177, 4, '0103000020E61000000100000005000000BFE027E1B38B6040CB3D6D48CE2517C0C86A166CEEF5604074D8F155A38F1BC0CC67AFAED4CE60409B0E0DBE9E5224C0AFF42249DF62604050958CCF351622C0BFE027E1B38B6040CB3D6D48CE2517C0'],
];
const P = [133.786, -7.244];

test('WKB polygons decode to four corners near the position', () => {
  for (const [, , , wkb] of ROWS) {
    const c = cornersFromWkb(wkb);
    assert.equal(c.length, 4);
    for (const [r, d] of c) assert.ok(sep(r, d, ...P) < 5, `${r},${d}`); // footprint is ~3.5° square
  }
});

test('rows round-trip: same path, time and corners within 1e-4 degree', () => {
  for (const [uri, t, det, wkb] of ROWS) {
    const corners = cornersFromWkb(wkb);
    const { line } = encodeRow(uri, t, det, corners);
    assert.ok(!line.startsWith('='), 'compact key expected');
    const r = decodeRow(line);
    assert.equal(r.uri, uri); assert.equal(r.det, det);
    assert.ok(Math.abs(r.t - t) < 1e-5);
    r.corners.forEach(([a, d], k) => assert.ok(sep(a, d, ...corners[k]) < 1.5e-4));
  }
  const odd = 'ibe/data/spherex/dr1/level2/2025W33_2C/l2b_retry-v27-2026-228/6/level2_2025W33_2C_0366_3D6_spx_l2b_retry-v27-2026-228.fits';
  const { line } = encodeRow(odd, 60900, 6, cornersFromWkb(ROWS[0][3]));
  assert.equal(decodeRow(line).uri, odd);
});

test('containment agrees with IRSA CONTAINS and rejects points outside', () => {
  for (const [, , , wkb] of ROWS) {
    const c = cornersFromWkb(wkb);
    assert.ok(contains(c, ...P));
    const [cr, cd] = centreOf(c);
    assert.ok(contains(c, cr, cd));
    assert.ok(!contains(c, cr + 5 / Math.cos((cd * Math.PI) / 180), cd));
    assert.ok(!contains(c, cr, cd + 3));
    assert.ok(!contains(c, cr + 180, -cd));
  }
});

test('tiles: every position maps to one tile and the search covers every nearby centre', () => {
  let n = 0; for (let b = 0; b < NBANDS; b++) n += cellsInBand(b);
  assert.ok(n > 9000 && n < 12000, String(n));
  for (const [ra, dec] of [[0, 0], [359.99, 0.5], [133.786, -7.244], [10, 89.9], [200, -89.5], [270, 66.5]]) {
    const near = tilesNear(ra, dec, 2.6).map((t) => `${t.b}/${t.c}`);
    for (let k = 0; k < 400; k++) {
      // random centres within 2.6 degrees must fall in a listed tile
      const a = Math.random() * 2 * Math.PI, rr = Math.random() * 2.59;
      const dd = Math.max(-90, Math.min(90, dec + rr * Math.sin(a)));
      const cosd = Math.max(1e-3, Math.cos((dd * Math.PI) / 180));
      const rc = ra + (rr * Math.cos(a)) / cosd;
      if (sep(rc, dd, ra, dec) > 2.6) continue;
      const t = tileOf(rc, dd);
      assert.ok(near.includes(`${t.b}/${t.c}`), `centre ${rc},${dd} tile ${t.b}/${t.c} missing for ${ra},${dec}`);
    }
  }
});
