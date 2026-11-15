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

// Every English sentence or label written in the page code must have a translation (or match a value rule),
// so a new text cannot reach the interface in English only. Key names, code examples and log text are exempt.
test('every interface text in the code is translated', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { UI } = await import('../src/i18n/ui.js');
  const en = (await import('../src/i18n/en.js')).default;
  const exempt = new Set(['Enter', 'Escape', 'Tab', 'Gaia at MAST', 'List saved', 'Exposure skipped:', 'Viridis', // Viridis: proper name of a colour map
    // typed-request and equation examples: the request parser and the equation language read English, so they stay as typed
    "Barnard's star, 4 arcmin field, track motion, with gaia", 'R Draconis per survey, color', 'WISE 0855\nmean(D5, D6) - epoch(1)\nwhere flag == 0', 'Gaia DR3 <source id>', '(D5 + D6)/2 - epoch(1)\nwhere t > 2025-06-01 and flag == 0']);
  const files = ['src/app.js', 'src/targets.js', 'src/state.js', ...readdirSync('src/views').map((f) => 'src/views/' + f), ...readdirSync('src/ui').map((f) => 'src/ui/' + f)];
  for (const [code, pages] of Object.entries({ el, es, fr })) {
    const known = new Set([...Object.keys(pages), ...Object.keys(UI[code].phrases), ...Object.values(en)].map((k) => k.trim()));
    const rules = rulesFor(code), pats = UI[code].patterns;
    const miss = [];
    for (const f of files) for (const raw of jsStrings(readFileSync(f, 'utf8'))) {
      const t = raw.trim();
      if (!/^[A-Z“"(]/.test(t) || (!/[a-z]{2,} [a-z]{2,}/.test(t) && !/^[A-Z][a-z]+(…)?$/.test(t))) continue;
      if (/^(SELECT|https?:|[A-Z_]+$)|\.(js|json|png|fits)$|\$\{|\\n|^Gaia DR3$|^Show WISE 0855/.test(t) || exempt.has(t) || known.has(t)) continue;
      // a whole-sentence translation is needed: a rule that only renames a word inside an English sentence does not count
      const whole = R.some((r, i) => r[0].startsWith('^') && r[0].endsWith('$') && rules[i][0].test(t));
      if (!whole && !pats.some(([re]) => re.test(t))) miss.push(`${f}: ${t}`);
    }
    assert.deepEqual(miss, [], `${code}: untranslated texts`);
  }
});

// quoted string literals ('…' and "…") of a source file; template literals, regular expressions and comments are skipped.
// (A regular expression pairing quote marks loses step after any apostrophe inside "…" or `…`.)
function jsStrings(src) {
  const out = []; let i = 0;
  const unesc = (x) => x.replace(/\\(.)/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); if (i < 0) break; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2; if (i < 2) break; continue; }
    if (c === '/') {
      // a regular expression literal starts where an operand is expected (after ( , = : [ ! & | ? { } ; or return)
      const before = src.slice(0, i).trimEnd();
      if (!before || /[(,=:[!&|?{};]$/.test(before) || /\breturn$/.test(before)) {
        let j = i + 1, inClass = false;
        while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue; } if (d === '[') inClass = true; else if (d === ']') inClass = false; else if (d === '/' && !inClass) break; j++; }
        i = j + 1; continue;
      }
    }
    if (c === "'" || c === '"') {
      let j = i + 1, buf = '';
      while (j < src.length && src[j] !== c && src[j] !== '\n') { if (src[j] === '\\') { buf += src.slice(j, j + 2); j += 2; } else buf += src[j++]; }
      out.push(unesc(buf)); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1, buf = '';
      while (j < src.length && src[j] !== '`') {
        if (src[j] === '\\') { buf += src.slice(j, j + 2); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') { buf = ''; let d = 1; j += 2; while (j < src.length && d) { if (src[j] === '{') d++; else if (src[j] === '}') d--; j++; } continue; }
        buf += src[j++];
      }
      i = j + 1; continue; // template literals: pieces are joined at run time, value rules handle them
    }
    i++;
  }
  return out.filter((x) => x.length >= 3);
}
