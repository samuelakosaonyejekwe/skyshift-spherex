// Preset targets and target resolution. Presets come from data/targets.json (Gaia DR3
// astrometry from IRSA, refreshed by scripts/prebake.mjs and by scheduled jobs).
// Names resolve only to presets, Gaia DR3 source IDs (looked up live in Gaia DR3 at
// IRSA/MAST) or coordinates: no other name resolver is reachable from the approved sources.

import { loadBundled, tap, IRSA_TAP } from './lib/tap.js';
import { findPreset, parseText } from './state.js';
import { parsePosition, toGalactic } from './lib/coords.js';

export async function presets() {
  const b = await loadBundled();
  return b.targets || [];
}

export async function presetById(id) {
  return (await presets()).find((t) => t.id === id) || null;
}

/** Galactic (l, b) -> ICRS (inverse of coords.toGalactic rotation). */
export function fromGalactic(l, b) {
  const D = Math.PI / 180;
  const M = [[-0.0548755604, -0.8734370902, -0.4838350155], [0.4941094279, -0.4448296300, 0.7469822445], [-0.8676661490, -0.1980763734, 0.4559837762]];
  const x = Math.cos(b * D) * Math.cos(l * D), y = Math.cos(b * D) * Math.sin(l * D), z = Math.sin(b * D);
  const ex = M[0][0] * x + M[1][0] * y + M[2][0] * z, ey = M[0][1] * x + M[1][1] * y + M[2][1] * z, ez = M[0][2] * x + M[1][2] * y + M[2][2] * z;
  let ra = Math.atan2(ey, ex) / D; if (ra < 0) ra += 360;
  return { ra, dec: Math.asin(ez) / D };
}

/**
 * Resolve the target box text. Returns
 * { target, preset?, kind: 'preset'|'coords'|'galactic'|'gaia'|'text', note } or { error, hint }.
 */
export async function resolveTarget(text) {
  const s = String(text || '').trim();
  if (!s) return { error: 'Type a target name or coordinates', hint: 'Example: WISE 0855, or 08h55m10.8s −07d14m42s' };
  const pre = findPreset(s);
  if (pre && s.toLowerCase().replace(/\s+/g, ' ').length <= pre.match.length + 3) {
    const t = await presetById(pre.id);
    if (t) return { kind: 'preset', preset: t, target: presetToTarget(t), note: t.posNote };
  }
  const gal = s.match(/^\s*(?:gal(?:actic)?\s*:?\s*)?l\s*=?\s*(\d{1,3}(?:\.\d+)?)\s*[, ]\s*b\s*=?\s*([+-]?\d{1,2}(?:\.\d+)?)\s*$/i);
  if (gal) {
    const p = fromGalactic(Number(gal[1]), Number(gal[2]));
    return { kind: 'galactic', target: { ...p, source: 'coords', name: `l=${gal[1]}°, b=${gal[2]}°` }, note: 'Galactic coordinates converted to ICRS' };
  }
  const gaia = s.match(/^\s*gaia\s*(?:dr3)?\s*(\d{6,20})\s*$/i);
  if (gaia) {
    const rows = await tap(IRSA_TAP, `SELECT source_id, ra, dec, pmra, pmdec, parallax, phot_g_mean_mag, ref_epoch FROM gaia_dr3_source WHERE source_id = ${gaia[1]}`);
    if (!rows.length) return { error: `Gaia DR3 ${gaia[1]} was not found`, hint: 'Check the source ID (19 digits for most stars).' };
    const g = rows[0];
    return { kind: 'gaia', target: { ra: g.ra, dec: g.dec, pmra: g.pmra || 0, pmdec: g.pmdec || 0, refEpoch: g.ref_epoch, name: `Gaia DR3 ${g.source_id}`, id: String(g.source_id), source: 'gaia' }, note: `Gaia DR3 (IRSA) position at epoch ${g.ref_epoch}, G=${g.phot_g_mean_mag?.toFixed(2)}` };
  }
  const pos = parsePosition(s);
  if (pos) return { kind: 'coords', target: { ...pos, source: 'coords' }, note: 'ICRS coordinates' };
  if (pre) {
    const t = await presetById(pre.id);
    if (t) return { kind: 'preset', preset: t, target: presetToTarget(t), note: t.posNote };
  }
  const pt = parseText(s);
  if (pt.partial.target || pt.partial.preset || pt.partial.galactic) return { kind: 'text', parsed: pt };
  return {
    error: `"${s.slice(0, 40)}" is not a known target or coordinate`,
    hint: 'Use RA/Dec (e.g. 133.786 −7.244 or 08:55:10.8 −07:14:42), galactic (l=30 b=2), "Gaia DR3 <id>", or a preset name.',
  };
}

export function presetToTarget(t) {
  return { ra: t.ra, dec: t.dec, name: t.name, id: t.id, pmra: t.pmra || 0, pmdec: t.pmdec || 0, refEpoch: t.pmra || t.pmdec ? 2026.0 : undefined, source: 'preset' };
}

/** Suggested field of view / mode for a target (the "smart next step"). */
export function suggestFor(t) {
  const pm = Math.hypot(t.pmra || 0, t.pmdec || 0) / 1000; // arcsec/yr
  if (pm > 3) return { fov: 6, mode: 'blink', track: false, text: `This object moves ${pm.toFixed(1)}″ per year, about ${(pm / 6.15).toFixed(1)} SPHEREx pixels: one frame per six-month survey and Blink (first vs last) show it best.` };
  if (pm > 0.5) return { fov: 6, mode: 'movie', text: `Moves ${pm.toFixed(2)}″/yr. Try Difference mode to bring out the motion.` };
  return null;
}

export function describePosition(ra, dec) {
  const g = toGalactic(ra, dec);
  return `l=${g.l.toFixed(2)}°, b=${g.b.toFixed(2)}°`;
}
