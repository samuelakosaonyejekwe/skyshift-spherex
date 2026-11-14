// SkyRequest: the single, versioned request schema. The target box, URLs (including
// WiseView-style parameters) and typed text all compile to this object, and every
// downstream component reads only this object.

import { parsePosition, parseAngle, wrap360 } from './lib/coords.js';

export const SCHEMA_VERSION = 1;

export const DEFAULTS = Object.freeze({
  v: SCHEMA_VERSION,
  target: null, // { name?, ra, dec, pmra?, pmdec?, refEpoch?, id?, source }
  fov: 6, // arcmin
  dets: [1, 2, 3, 4, 5, 6],
  wl: null, // [min, max] µm
  group: 'survey', // 'exposure' | 'day' | 'survey'
  mode: 'movie', // 'movie' | 'blink' | 'diff' | 'stack' | 'color'
  diff: 'mean', // 'mean' | 'first' | 'prev'
  blink: null, // [a, b] frame indices; null = first & last
  stretch: 'asinh', lo: 1, hi: 99.5, invert: false, cmap: 'auto', // 'auto' = tinted by wavelength
  speed: 600, // ms per frame
  track: false,
  ov: ['track', 'compass'], // overlays: gaia, wise, flags, track, compass, grid
  t: 0,
  embed: false,
  expr: '', // image arithmetic, e.g. (D5 + D6)/2 - epoch(1)
  where: '', // exposure selection, e.g. t > 2025-06-01 and flag == 0
});

export const MODES = ['movie', 'blink', 'diff', 'stack', 'color', 'expr'];
export const GROUPS = ['exposure', 'day', 'survey'];
export const STRETCHES = ['asinh', 'linear', 'log', 'sqrt'];
export const CMAPS = ['auto', 'gray', 'heat', 'ice', 'viridis'];
export const OVERLAYS = ['gaia', 'wise', 'flags', 'track', 'compass', 'grid'];
export const FOV_STEPS = [2, 4, 6, 10, 15, 20, 30, 45, 60];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/** Validate and normalise any partial request into a complete SkyRequest. */
export function normalise(partial = {}) {
  const r = { ...DEFAULTS, ...partial };
  r.v = SCHEMA_VERSION;
  if (r.target) {
    const t = r.target;
    if (!Number.isFinite(t.ra) || !Number.isFinite(t.dec) || t.dec < -90 || t.dec > 90) r.target = null;
    else r.target = { ...t, ra: wrap360(t.ra) };
  }
  r.fov = clamp(Number(r.fov) || DEFAULTS.fov, 1, 60);
  r.dets = [...new Set((r.dets || []).map(Number).filter((d) => d >= 1 && d <= 6))].sort();
  if (!r.dets.length) r.dets = [...DEFAULTS.dets];
  if (r.wl && !(Array.isArray(r.wl) && r.wl.length === 2 && r.wl.every(Number.isFinite) && r.wl[0] < r.wl[1])) r.wl = null;
  if (!GROUPS.includes(r.group)) r.group = DEFAULTS.group;
  if (!MODES.includes(r.mode)) r.mode = DEFAULTS.mode;
  if (!['mean', 'first', 'prev'].includes(r.diff)) r.diff = 'mean';
  if (!STRETCHES.includes(r.stretch)) r.stretch = DEFAULTS.stretch;
  if (!CMAPS.includes(r.cmap)) r.cmap = DEFAULTS.cmap;
  r.lo = clamp(Number(r.lo), 0, 50); r.hi = clamp(Number(r.hi), 50, 100);
  if (!(r.lo < r.hi)) { r.lo = DEFAULTS.lo; r.hi = DEFAULTS.hi; }
  r.speed = clamp(Math.round(Number(r.speed) || DEFAULTS.speed), 60, 5000);
  r.ov = [...new Set((r.ov || []).filter((o) => OVERLAYS.includes(o)))];
  r.t = Math.max(0, Math.floor(Number(r.t) || 0));
  if (r.blink && !(Array.isArray(r.blink) && r.blink.length === 2 && r.blink.every((x) => Number.isInteger(x) && x >= 0))) r.blink = null;
  r.invert = !!r.invert; r.track = !!r.track; r.embed = !!r.embed;
  r.expr = String(r.expr || '').slice(0, 500);
  r.where = String(r.where || '').slice(0, 500);
  if (r.mode === 'expr' && !r.expr) r.mode = 'movie';
  return r;
}

const truthy = (v) => v === '' || v === '1' || v === 'true' || v === 'yes' || v === 'on';

/** URL params (query or hash) -> partial request. Accepts WiseView-style parameters too. */
export function fromParams(params) {
  const p = (k) => params.get(k);
  const out = {};
  const ra = p('ra'), dec = p('dec');
  if (ra != null && dec != null) {
    const pos = { ra: parseAngle(ra, { hours: /[:h\s]/.test(String(ra).trim()) }), dec: parseAngle(dec) };
    if (Number.isFinite(pos.ra) && Number.isFinite(pos.dec)) {
      out.target = { ra: pos.ra, dec: pos.dec, source: 'url' };
      if (p('name')) out.target.name = String(p('name')).slice(0, 80);
      if (p('id')) out.target.id = String(p('id')).slice(0, 40);
      if (p('pmra') != null && p('pmra') !== '') out.target.pmra = Number(p('pmra')) || 0;
      if (p('pmdec') != null && p('pmdec') !== '') out.target.pmdec = Number(p('pmdec')) || 0;
      if (p('epoch')) out.target.refEpoch = Number(p('epoch'));
      if (p('plx')) out.target.plx = Number(p('plx')) || 0;
    }
  }
  if (p('target')) out.preset = String(p('target')).slice(0, 40);
  if (p('fov')) out.fov = Number(p('fov'));
  else if (p('size')) out.fov = (Number(p('size')) * 2.75) / 60; // WiseView size is in unWISE pixels (2.75″)
  if (p('det') || p('dets')) out.dets = String(p('det') || p('dets')).replace(/d/gi, '').split(/[,\s]+|(?=\d)/).filter(Boolean).map(Number);
  if (p('wl')) { const m = String(p('wl')).match(/([\d.]+)\s*[-–to]+\s*([\d.]+)/); if (m) out.wl = [Number(m[1]), Number(m[2])]; }
  if (p('group')) out.group = p('group');
  else if (p('window')) out.group = Number(p('window')) >= 0.25 ? 'survey' : 'day';
  if (p('mode')) out.mode = p('mode');
  if (p('diff') && MODES.includes(p('mode') || '') === false && truthy(p('diff'))) out.mode = 'diff';
  if (p('diffref')) out.diff = p('diffref');
  if (p('blink')) { const b = String(p('blink')).split(',').map(Number); if (b.length === 2) out.blink = b; }
  if (p('stretch')) out.stretch = p('stretch');
  if (p('linear') && truthy(p('linear')) && !p('stretch')) out.stretch = 'linear';
  if (p('lo')) out.lo = Number(p('lo'));
  if (p('hi')) out.hi = Number(p('hi'));
  if (p('invert') != null) out.invert = truthy(p('invert'));
  if (p('cmap')) out.cmap = p('cmap');
  if (p('speed')) out.speed = Number(p('speed'));
  if (p('track') != null) out.track = truthy(p('track'));
  if (p('ov') != null) out.ov = String(p('ov')).split(',').filter(Boolean);
  if (p('gaia') != null) {
    out.ov = out.ov || [...DEFAULTS.ov];
    if (truthy(p('gaia'))) out.ov.push('gaia'); else out.ov = out.ov.filter((o) => o !== 'gaia');
  }
  if (p('t')) out.t = Number(p('t'));
  if (p('embed') != null) out.embed = truthy(p('embed'));
  if (p('expr')) out.expr = String(p('expr'));
  if (p('where')) out.where = String(p('where'));
  return out;
}

/** SkyRequest -> compact URLSearchParams (only non-default values). */
export function toParams(r) {
  const q = new URLSearchParams();
  if (r.target) {
    q.set('ra', r.target.ra.toFixed(6));
    q.set('dec', r.target.dec.toFixed(6));
    if (r.target.name) q.set('name', r.target.name);
    if (r.target.id) q.set('id', r.target.id);
    if (r.target.pmra || r.target.pmdec) { q.set('pmra', String(r.target.pmra || 0)); q.set('pmdec', String(r.target.pmdec || 0)); }
    if (r.target.refEpoch) q.set('epoch', String(r.target.refEpoch));
    if (r.target.plx) q.set('plx', String(r.target.plx));
  }
  const d = DEFAULTS;
  if (r.fov !== d.fov) q.set('fov', String(+r.fov.toFixed(2)));
  if (r.dets.join() !== d.dets.join()) q.set('det', r.dets.join(''));
  if (r.wl) q.set('wl', `${r.wl[0]}-${r.wl[1]}`);
  if (r.group !== d.group) q.set('group', r.group);
  if (r.mode !== d.mode) q.set('mode', r.mode);
  if (r.diff !== d.diff) q.set('diffref', r.diff);
  if (r.blink) q.set('blink', r.blink.join(','));
  if (r.stretch !== d.stretch) q.set('stretch', r.stretch);
  if (r.lo !== d.lo) q.set('lo', String(r.lo));
  if (r.hi !== d.hi) q.set('hi', String(r.hi));
  if (r.invert) q.set('invert', '1');
  if (r.cmap !== d.cmap) q.set('cmap', r.cmap);
  if (r.speed !== d.speed) q.set('speed', String(r.speed));
  if (r.track) q.set('track', '1');
  if (r.ov.slice().sort().join() !== d.ov.slice().sort().join()) q.set('ov', r.ov.join(','));
  if (r.t) q.set('t', String(r.t));
  if (r.embed) q.set('embed', '1');
  if (r.expr) q.set('expr', r.expr);
  if (r.where) q.set('where', r.where);
  return q;
}

// ---------------------------------------------------------------------------
// Typed-text parser: deterministic mini-grammar (no eval, no external service).
// Returns { partial, understood: [{text, meaning}], unparsed: [text], conflicts: [] }.

export const ALIASES = {
  barnard: ['barnard', "barnard's star", 'barnards star', 'barnard star', 'gj 699', 'gaia dr3 4472832130942575872'],
  epsindib: ['epsilon indi b', 'eps indi b', 'ε indi b', 'epsilon indi', 'eps ind b', 'gaia dr3 6412596012146801152'],
  wise0855: ['wise 0855', 'wise0855', 'wise 0855-0714', 'wise j0855', 'wise j085510.83-071442.5', 'wise 0855−0714'],
  rwaur: ['rw aurigae', 'rw aur', 'gaia dr3 156430822114424576'],
  rdra: ['r draconis', 'r dra', 'gaia dr3 1648328016354496384'],
};

export function findPreset(text) {
  const s = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  let best = null;
  for (const [id, names] of Object.entries(ALIASES)) {
    for (const n of names) {
      const i = s.indexOf(n);
      if (i >= 0 && (!best || n.length > best.match.length)) best = { id, match: n, index: i };
    }
  }
  return best;
}

const UNIT = { arcsec: 1 / 60, '″': 1 / 60, '"': 1 / 60, arcmin: 1, "'": 1, '′': 1, deg: 60, degree: 60, degrees: 60, '°': 60 };

export function parseText(input) {
  const raw = String(input || '').slice(0, 2000);
  let s = ' ' + raw.replace(/[\u2212\u2013\u2014]/g, '-').replace(/\s+/g, ' ') + ' ';
  const understood = [], conflicts = [];
  const partial = {};
  const take = (re, fn) => {
    s = s.replace(re, (...m) => { const r = fn(...m); return r === false ? m[0] : ' '; });
  };
  const preset = findPreset(s);
  if (preset) {
    partial.preset = preset.id;
    understood.push({ text: preset.match, meaning: `target: preset ${preset.id}` });
    s = s.slice(0, preset.index + 1) + ' ' + s.slice(preset.index + 1 + preset.match.length);
  }
  // field of view: "10 arcmin field", "0.5 deg fov", "5' field"
  take(/(\d+(?:\.\d+)?)\s*(arcsec|arcmin|degrees?|deg|°|′|'|″|")\s*(?:wide\s*)?(?:field(?: of view)?|fov|patch|box|square)?/i, (m, n, u) => {
    const f = Number(n) * UNIT[u.toLowerCase()];
    if (!Number.isFinite(f)) return false;
    partial.fov = f;
    understood.push({ text: m.trim(), meaning: `field of view ${+f.toFixed(2)}′` });
  });
  // wavelength range: "3 to 4 microns", "3-4 µm", "between 1.1 and 1.6 um"
  take(/(?:between\s*)?(\d+(?:\.\d+)?)\s*(?:to|-|and)\s*(\d+(?:\.\d+)?)\s*(?:microns?|µm|um|μm)/i, (m, a, b) => {
    partial.wl = [Number(a), Number(b)].sort((x, y) => x - y);
    understood.push({ text: m.trim(), meaning: `wavelengths ${partial.wl[0]}–${partial.wl[1]} µm` });
  });
  // "bluest bands" / "reddest bands"
  take(/\b(bluest|shortest)\s+(?:bands?|wavelengths?)/i, (m) => { partial.dets = [1, 2]; understood.push({ text: m.trim(), meaning: 'detectors D1–D2 (0.75–1.62 µm)' }); });
  take(/\b(reddest|longest)\s+(?:bands?|wavelengths?)/i, (m) => { partial.dets = [5, 6]; understood.push({ text: m.trim(), meaning: 'detectors D5–D6 (3.83–5.00 µm)' }); });
  // detectors: "detectors 5 and 6", "D5-D6", "d1,d2"
  take(/\b(?:detectors?|arrays?|bands?)\s*((?:d?\d\s*(?:,|and|&|-|to)?\s*)+)/i, (m, list) => {
    const nums = parseDetList(list);
    if (!nums.length) return false;
    partial.dets = nums;
    understood.push({ text: m.trim(), meaning: `detectors ${nums.map((d) => 'D' + d).join(', ')}` });
  });
  take(/\b(d[1-6](?:\s*(?:,|-|to|and)\s*d[1-6])*)\b/i, (m, list) => {
    const nums = parseDetList(list);
    partial.dets = nums;
    understood.push({ text: m.trim(), meaning: `detectors ${nums.map((d) => 'D' + d).join(', ')}` });
  });
  // modes
  const modeWords = [[/\bblink(?:ing)?\b/i, 'blink'], [/\b(difference|subtract(?:ion)?|diff)\b/i, 'diff'], [/\b(stack|co-?add|add (?:them )?together|sum)\b/i, 'stack'],
    [/\b(false[- ]?colou?r|colou?r composite|colou?r)\b/i, 'color'], [/\b(movie|play|animate|video|flipbook)\b/i, 'movie']];
  for (const [re, mode] of modeWords) {
    take(re, (m) => {
      if (partial.mode && partial.mode !== mode) conflicts.push(`mode: "${partial.mode}" or "${mode}"?`);
      partial.mode = partial.mode || mode;
      understood.push({ text: m.trim(), meaning: `mode ${mode}` });
    });
  }
  take(/\bfirst\s+and\s+last\b/i, (m) => { partial.blink = null; partial.blinkFirstLast = true; understood.push({ text: m.trim(), meaning: 'compare first and last epoch' }); });
  take(/\b(this year|last year|over all epochs|all epochs|every epoch|per survey|each survey|six[- ]month)\b/i, (m) => { partial.group = 'survey'; understood.push({ text: m.trim(), meaning: 'one frame per six-month survey' }); });
  take(/\b(every|each|all|single)\s+exposures?\b/i, (m) => { partial.group = 'exposure'; understood.push({ text: m.trim(), meaning: 'one frame per exposure' }); });
  take(/\b(per|each|every)\s+(day|visit)\b|\bdaily\b/i, (m) => { partial.group = 'day'; understood.push({ text: m.trim(), meaning: 'one frame per day' }); });
  take(/\b(track|follow)(?:ing)?\s*(?:the\s*)?(?:motion|it|target|star)?\b/i, (m) => { partial.track = true; understood.push({ text: m.trim(), meaning: 'follow the target\'s proper motion' }); });
  for (const o of ['gaia', 'wise', 'flags']) {
    take(new RegExp(`\\b(?:with|show|overlay|plus|and)?\\s*${o}\\b(?:\\s*overlay)?`, 'i'), (m) => {
      partial.ov = [...new Set([...(partial.ov || DEFAULTS.ov), o])];
      understood.push({ text: m.trim(), meaning: `overlay ${o}` });
    });
  }
  take(/\binvert(?:ed)?\b/i, (m) => { partial.invert = true; understood.push({ text: m.trim(), meaning: 'inverted greyscale' }); });
  take(/\b(\d{2,4})\s*ms\b/i, (m, n) => { partial.speed = Number(n); understood.push({ text: m.trim(), meaning: `${n} ms per frame` }); });
  // coordinates (after other numbers are consumed)
  if (!partial.preset) {
    const coordRe = /(\d{1,2}[h:\s]\s*\d{1,2}[m:\s]\s*\d{1,2}(?:\.\d+)?s?|\d{1,3}(?:\.\d+)?)\s*,?\s*([+-]\s*\d{1,2}(?:[d°:\s]\s*\d{1,2}[m′':\s]\s*\d{1,2}(?:\.\d+)?[s″"]?|(?:\.\d+)?)|\d{1,2}(?:\.\d+)?)/i;
    const gal = s.match(/\b(?:l\s*=?\s*)(\d{1,3}(?:\.\d+)?)\s*,?\s*(?:b\s*=?\s*)([+-]?\d{1,2}(?:\.\d+)?)\b/i);
    if (gal) {
      partial.galactic = [Number(gal[1]), Number(gal[2])];
      understood.push({ text: gal[0].trim(), meaning: `galactic l=${gal[1]}°, b=${gal[2]}°` });
      s = s.replace(gal[0], ' ');
    } else {
      const m = s.match(coordRe);
      if (m) {
        const pos = parsePosition(`${m[1]} ${/^[+-]/.test(m[2].trim()) ? m[2].replace(/\s+/, '') : '+' + m[2]}`);
        if (pos) {
          partial.target = { ...pos, source: 'text' };
          understood.push({ text: m[0].trim(), meaning: `position RA ${pos.ra.toFixed(5)}°, Dec ${pos.dec.toFixed(5)}°` });
          s = s.replace(m[0], ' ');
        }
      }
    }
  }
  const STOP = /^(show|me|the|a|an|of|over|for|in|with|and|then|please|compare|against|at|on|to|from|using|use|look|images?|field|sky|patch|it|this|that|all|view|frames?|between|first|last|,|\.)$/i;
  const unparsed = s.split(/\s+/).filter((w) => w && !STOP.test(w));
  return { partial, understood, unparsed, conflicts };
}

function parseDetList(list) {
  const out = new Set();
  const s = list.toLowerCase().replace(/d/g, '');
  const range = s.match(/([1-6])\s*(?:-|to)\s*([1-6])/);
  if (range) for (let i = Number(range[1]); i <= Number(range[2]); i++) out.add(i);
  for (const m of s.matchAll(/[1-6]/g)) out.add(Number(m[0]));
  return [...out].sort();
}
