import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUpload } from '../src/lib/upload.js';

const enc = (s) => new TextEncoder().encode(s).buffer;
const typedEquivalent = [
  { name: 'WISE 0855', ra: 133.786245, dec: -7.244372 },
  { name: 'RW Aur', ra: 76.95609, dec: 30.401128 },
];

test('CSV with header', async () => {
  const r = await parseUpload('t.csv', enc('name,ra,dec\nWISE 0855,133.786245,-7.244372\nRW Aur,76.95609,30.401128\n'));
  assert.equal(r.format, 'CSV');
  assert.deepEqual(r.targets.map(({ name, ra, dec }) => ({ name, ra, dec })), typedEquivalent);
});

test('TSV, sexagesimal and Windows line endings', async () => {
  const r = await parseUpload('t.tsv', enc('Object\tRAJ2000\tDEJ2000\r\nWISE 0855\t08:55:08.6988\t-07:14:39.74\r\n'));
  assert.equal(r.targets.length, 1);
  assert.ok(Math.abs(r.targets[0].ra - 133.786245) < 1e-4 && Math.abs(r.targets[0].dec + 7.244372) < 1e-4);
});

test('messy plain text with mixed formats and notes', async () => {
  const r = await parseUpload('list.txt', enc('# my list\nWISE 0855   133.786245 -7.244372  cold!\n05h07m49.46s +30d24m04.06s RW Aur\nnothing here\n'));
  assert.equal(r.targets.length, 2);
  assert.equal(r.errors.length, 1);
  assert.ok(Math.abs(r.targets[1].ra - 76.956083) < 1e-4);
});

test('JSON and GeoJSON', async () => {
  const r = await parseUpload('t.json', enc(JSON.stringify(typedEquivalent)));
  assert.equal(r.targets.length, 2);
  const g = await parseUpload('t.geojson', enc(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { name: 'x' }, geometry: { type: 'Point', coordinates: [133.786245, -7.244372] } }] })));
  assert.equal(g.targets[0].name, 'x');
});

test('VOTable TABLEDATA', async () => {
  const x = '<?xml version="1.0"?><VOTABLE><RESOURCE><TABLE><FIELD name="name"/><FIELD name="ra"/><FIELD name="dec"/><DATA><TABLEDATA><TR><TD>WISE 0855</TD><TD>133.786245</TD><TD>-7.244372</TD></TR></TABLEDATA></DATA></TABLE></RESOURCE></VOTABLE>';
  const r = await parseUpload('t.vot', enc(x));
  assert.equal(r.format, 'VOTable');
  assert.equal(r.targets[0].name, 'WISE 0855');
});

test('IPAC table and DS9 region', async () => {
  const ipac = '\\fixlen = T\n|  name   |     ra     |    dec    |\n|  char   |   double   |  double   |\n  W0855     133.786245   -7.244372\n';
  const r = await parseUpload('t.tbl', enc(ipac));
  assert.equal(r.format, 'IPAC table');
  assert.ok(Math.abs(r.targets[0].ra - 133.786245) < 1e-9);
  const d = await parseUpload('t.reg', enc('# Region file format: DS9\nfk5\ncircle(133.786245,-7.244372,10") # text={W0855}\n'));
  assert.equal(d.targets[0].name, 'W0855');
});

test('unknown columns ask for a mapping, and mapping is honoured', async () => {
  const csv = 'obj,x,y\nA,133.786245,-7.244372\n';
  const r = await parseUpload('t.csv', enc(csv));
  assert.ok(r.needsMapping);
  const r2 = await parseUpload('t.csv', enc(csv), { ra: 1, dec: 2, name: 0 });
  assert.equal(r2.targets[0].name, 'A');
});

test('malformed and binary files fail clearly', async () => {
  await assert.rejects(parseUpload('x.json', enc('{bad json')), /JSON could not be read/);
  await assert.rejects(parseUpload('x.bin', new Uint8Array([0, 1, 2, 3, 0, 0, 7, 8, 9]).buffer), /binary file/);
  await assert.rejects(parseUpload('x.pdf', enc('%PDF-1.7 ...')), /PDF files are not read yet/);
});
