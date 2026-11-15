import test from 'node:test';
import assert from 'node:assert/strict';
import { handle, parseGather } from '../relay/core.mjs';

const FILE = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/qr3/level2/2026W40_1A/l2b-v20-2026-279/1/level2_2026W40_1A_0001_1D1_spx_l2b-v20-2026-279.fits';

test('gather accepts only SPHEREx files of the public bucket and bounded ranges', () => {
  assert.ok(parseGather(FILE, '0-9,100-199').spans.length === 1);
  assert.match(parseGather('https://example.com/x.fits', '0-1').error, /only for SPHEREx/);
  assert.match(parseGather(FILE.replace('.fits', '.txt'), '0-1').error, /only for SPHEREx/);
  assert.match(parseGather(FILE, '5-1').error, /start-end/);
  assert.match(parseGather(FILE, Array.from({ length: 601 }, (_, i) => `${i * 10}-${i * 10 + 1}`).join(',')).error, /ranges/);
  assert.match(parseGather(FILE, `0-${7 * 1024 * 1024}`).error, /too many bytes/);
  assert.match(parseGather(FILE, Array.from({ length: 9 }, (_, i) => `${i * 10e6}-${i * 10e6 + 9}`).join(',')).error, /spread out/);
});

test('gather returns exactly the requested bytes, in the order asked (fake archive)', async () => {
  const file = new Uint8Array(100000).map((_, i) => i % 251);
  const fake = async (url, init) => {
    const [, a, b] = init.headers.Range.match(/bytes=(\d+)-(\d+)/).map(Number);
    return new Response(file.slice(a, b + 1), { status: 206, headers: { 'content-range': `bytes ${a}-${b}/${file.length}` } });
  };
  const ranges = [[9000, 9009], [10, 19], [50000, 50003]];
  const res = await handle(new Request(`https://relay.test/api/relay?gather=${encodeURIComponent(FILE)}&r=${ranges.map((r) => r.join('-')).join(',')}`), { fetchImpl: fake });
  assert.equal(res.status, 200);
  const got = new Uint8Array(await res.arrayBuffer());
  const want = new Uint8Array(ranges.flatMap(([a, b]) => [...file.slice(a, b + 1)]));
  assert.deepEqual([...got], [...want]);
});
