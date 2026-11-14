// Translation tables: every rule has all three languages, keeps every live value, and the page texts
// cover the same English keys in every language.
import test from 'node:test';
import assert from 'node:assert/strict';
import { R, rulesFor } from '../src/i18n/patterns.js';
import el from '../src/i18n/pages/el.js';
import es from '../src/i18n/pages/es.js';
import fr from '../src/i18n/pages/fr.js';

test('every value rule is complete and keeps its values', () => {
  for (const r of R) {
    assert.equal(r.length, 4, r[0]);
    const n = (r[0].match(/\{n?\}/g) || []).length;
    for (const t of r.slice(1)) for (let i = 1; i <= n; i++) assert.ok(t.includes('$' + i), `${r[0]} → ${t} lacks $${i}`);
  }
  for (const l of ['el', 'es', 'fr']) assert.equal(rulesFor(l).length, R.length);
});

test('rules translate a live status line', () => {
  let s = '12/120 exposures loaded (of 358 available) · 6.5 MB transferred at 1.0 MB/s · source: IRSA live';
  for (const [re, rep] of rulesFor('fr')) s = s.replace(re, rep);
  assert.equal(s, '12/120 poses chargées (sur 358 disponibles) · 6.5 MB transférés à 1.0 MB/s · source : IRSA en direct');
});

test('page texts exist in every language', () => {
  const keys = (o) => new Set(Object.keys(o));
  const all = new Set([...keys(el), ...keys(es), ...keys(fr)]);
  for (const [name, o] of Object.entries({ el, es, fr })) for (const k of all) assert.ok(k in o || k === o[k], `${name} lacks “${k}”`);
});
