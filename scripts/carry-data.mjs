// Carries refreshed data and the image index between GitHub Actions runs through the Actions
// cache (directory .data-cache), so nothing generated is committed and a push never deploys
// older data than the last scheduled refresh.
//   restore: copy each cached file over the committed one when the cached copy is newer
//   save:    store the current files in .data-cache when anything changed (sets changed=true)
import { existsSync, readFileSync, writeFileSync, mkdirSync, cpSync, rmSync, appendFileSync, copyFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const C = '.data-cache';
const JSONS = { 'data/mission.json': 'built', 'data/coverage.json': 'built', 'data/targets.json': 'generated' };
const IMAGES = ['assets/allsky-1000.jpg', 'assets/allsky-1600.jpg']; // rebuilt in the same refresh as mission.json
const IDX = 'data/idx';
const stampOf = (f, key) => { try { return Date.parse(JSON.parse(readFileSync(f, 'utf8'))[key]) || 0; } catch { return 0; } };
const copy = (from, to) => { mkdirSync(dirname(to), { recursive: true }); copyFileSync(from, to); };
const mode = process.argv[2];

if (mode === 'restore') {
  if (!existsSync(join(C, 'stamp.json'))) { console.log('no cached data: using the committed files'); process.exit(0); }
  for (const [f, key] of Object.entries(JSONS)) {
    const cached = join(C, f);
    if (existsSync(cached) && stampOf(cached, key) > stampOf(f, key)) {
      copy(cached, f); console.log('restored newer', f);
      if (f === 'data/mission.json') for (const img of IMAGES) if (existsSync(join(C, img))) { copy(join(C, img), img); console.log('restored', img); }
    }
  }
  if (existsSync(join(C, IDX, 'meta.json')) && stampOf(join(C, IDX, 'meta.json'), 'built') > stampOf(join(IDX, 'meta.json'), 'built')) {
    rmSync(IDX, { recursive: true, force: true }); cpSync(join(C, IDX), IDX, { recursive: true }); console.log('restored image index');
  }
} else if (mode === 'save') {
  const now = { idx: stampOf(join(IDX, 'meta.json'), 'built') };
  for (const [f, key] of Object.entries(JSONS)) now[f] = stampOf(f, key);
  let prev = {}; try { prev = JSON.parse(readFileSync(join(C, 'stamp.json'), 'utf8')); } catch { /* none */ }
  const changed = Object.keys(now).some((k) => now[k] > (prev[k] || 0));
  if (changed) {
    rmSync(C, { recursive: true, force: true });
    for (const f of [...Object.keys(JSONS), ...IMAGES]) if (existsSync(f)) copy(f, join(C, f));
    if (now.idx) cpSync(IDX, join(C, IDX), { recursive: true });
    writeFileSync(join(C, 'stamp.json'), JSON.stringify(now));
  }
  console.log(changed ? 'data changed: cache will be saved' : 'nothing new to cache');
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`);
} else { console.error('usage: node scripts/carry-data.mjs restore|save'); process.exit(2); }
