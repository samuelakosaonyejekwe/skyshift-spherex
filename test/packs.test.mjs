import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync, gunzipSync } from 'node:zlib';
import { encodePack, decodePack } from '../src/lib/packs.js';
import { orderForLoading } from '../src/lib/render.js';

test('frame packs round-trip pixels (NaN included), metadata and photometry', () => {
  const n = 5, a = new Float32Array(n * n).map((_, i) => i * 0.37 - 3), b = new Float32Array(n * n).fill(NaN);
  b[7] = 1.5e-3;
  const frames = [{ data: a, meta: { uri: 'u1', mjd: 60800.5 }, phot: { flux: 2 }, rec: { uri: 'u1', det: 1 } }, { data: b, meta: { uri: 'u2' }, phot: null, rec: { uri: 'u2', det: 6 } }];
  const out = decodePack(gunzipSync(gzipSync(encodePack({ key: 'k,1', built: '2026-11-15T00:00:00Z', n, frames }))));
  assert.equal(out.key, 'k,1');
  assert.equal(out.frames.length, 2);
  assert.deepEqual([...out.frames[0].data], [...a]);
  assert.ok(Number.isNaN(out.frames[1].data[0]));
  assert.equal(out.frames[1].data[7], b[7]);
  assert.deepEqual(out.frames[0].phot, { flux: 2 });
  assert.equal(out.frames[1].rec.det, 6);
});

test('loading order alternates survey epochs first', () => {
  const list = [{ mjd: 1, det: 1 }, { mjd: 2, det: 2 }, { mjd: 200, det: 1 }, { mjd: 201, det: 2 }];
  assert.deepEqual(orderForLoading(list).map((e) => e.mjd), [1, 200, 2, 201]);
});
