import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, ephemerisFromText, ephemerisFromTable, interpEph, pathSamples } from '../src/lib/ephem.js';
import { parseUpload } from '../src/lib/upload.js';

const enc = (t) => new TextEncoder().encode(t).buffer;

test('times: ISO, month names, JD and MJD give the same MJD', () => {
  const ref = 61113.229166666664; // 2026-03-14 05:30 UTC
  for (const s of ['2026-03-14T05:30:00', '2026-03-14 05:30', '2026-Mar-14 05:30', '14 Mar 2026 05:30', 'JD 2461113.7291666667', '2461113.7291666667', 'MJD 61113.2291666667', '61113.2291666667']) {
    assert.ok(Math.abs(parseTime(s) - ref) < 1e-6, `${s} → ${parseTime(s)}`);
  }
  assert.ok(Number.isNaN(parseTime('yesterday')));
});

test('plain-text ephemeris: $$SOE block, status flags, sexagesimal with negative declination', () => {
  const e = ephemerisFromText('header 2026-Jan-01 99 99\n$$SOE\n 2026-Mar-14 00:00 *m  12 34 56.78 +12 34 56.7  6.1\n 2026-Mar-15 00:00 C   12 36 00.00 -00 30 00.0 n.a.\n$$EOE\nfooter');
  assert.equal(e.points.length, 2);
  assert.ok(Math.abs(e.points[0][1] - 188.7365833) < 1e-6 && Math.abs(e.points[0][2] - 12.5824167) < 1e-6);
  assert.ok(Math.abs(e.points[1][2] + 0.5) < 1e-9);
});

test('table ephemeris and uploads: CSV with date/ra/dec, an ephemeris-service CSV, and a star list stays a star list', async () => {
  const t = ephemerisFromTable([['2026-03-14', '188.7', '12.5'], ['2026-03-15', '12:36:00', '+12:30:00'], ['bad', '1', '2']], { time: 0, ra: 1, dec: 2 });
  assert.equal(t.points.length, 2); assert.equal(t.bad.length, 1); assert.ok(Math.abs(t.points[1][1] - 189) < 1e-9);
  const csv = await parseUpload('e.csv', enc('date,ra,dec\n2026-03-14,188.7,12.5\n2026-03-15,189,12.3\n2026-03-16,189.3,12.1\n'));
  assert.equal(csv.ephemeris.points.length, 3);
  const svc = await parseUpload('s.csv', enc(' Date__(UT)__HR:MN, , , R.A._____(ICRF)_____DEC, APmag\n$$SOE\n 2026-Mar-14 00:00, , , 12 34 56.78 +12 34 56.7, 6.1\n 2026-Mar-15 00:00,*,m, 12 36 00.00 +12 30 00.0, 6.1\n 2026-Mar-16 00:00, , , 12 37 00.00 -00 25 00.0, 6.1\n$$EOE\n'));
  assert.equal(svc.ephemeris.points.length, 3);
  const stars = await parseUpload('stars.csv', enc('name,ra,dec\nA,10,20\nB,11,21\nC,12,22\n'));
  assert.equal(stars.ephemeris, undefined); assert.equal(stars.targets.length, 3);
});

test('interpolation is linear, wraps RA across 0/360°, and is null outside the table', () => {
  const pts = [[0, 359.9, 10], [1, 0.1, 10.2], [3, 1.1, 10.6]];
  const a = interpEph(pts, 0.5); assert.ok(Math.abs(a.ra - 0) < 1e-9 && Math.abs(a.dec - 10.1) < 1e-9);
  const b = interpEph(pts, 2); assert.ok(Math.abs(b.ra - 0.6) < 1e-9 && Math.abs(b.dec - 10.4) < 1e-9);
  assert.equal(interpEph(pts, -0.1), null); assert.equal(interpEph(pts, 3.1), null);
});

test('path samples cover the whole table in time, at most 240 points', () => {
  const pts = Array.from({ length: 1000 }, (_, i) => [60800 + i, (i * 0.2) % 360, 0]);
  const s = pathSamples(pts);
  assert.ok(s.length <= 241);
  assert.ok(s[0].t0 <= 60800 && s[s.length - 1].t1 >= 61799);
  for (let k = 1; k < s.length; k++) assert.ok(s[k].t0 <= s[k - 1].t1, 'windows overlap, no time is missed');
});

test('shift-and-stack: the clipped co-add rejects a star trail crossing a pixel once and keeps a source present in every frame', async () => {
  const { clippedCoadd } = await import('../src/lib/render.js');
  const frames = Array.from({ length: 20 }, (_, i) => ({ meta: { bg: 0 }, data: Float32Array.from([1, 1 + (i % 2 ? 0.1 : -0.1), 1, 1, 5, 1, 1, 1, 1].map((v, k) => v + (i === 3 && k === 0 ? 1000 : 0))) }));
  const out = clippedCoadd(frames, 3);
  assert.ok(Math.abs(out[0] - 1) < 1e-9, `trail rejected: ${out[0]}`);
  assert.ok(Math.abs(out[4] - 5) < 1e-9, 'source kept');
  assert.ok(Math.abs(out[1] - 1) < 1e-9, 'noise averaged');
});
