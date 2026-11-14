// Checks the eight challenge resources from the build server (where browsers' CORS limits do not apply) with
// the same probes the Mission page runs, and writes data/sources.json. The page shows these results whenever it
// cannot check a resource live (e.g. GitHub Pages, which has no archive relay). Run by the scheduled workflow.
import { writeFileSync, readFileSync } from 'node:fs';
import { loadConfig } from '../src/lib/net.js';
import { SOURCES } from '../src/views/sources.js';

// relative app paths resolve to the repository; GitHub API calls use the workflow token when present (higher rate limit)
globalThis.fetch = ((f) => (u, o = {}) => {
  if (typeof u === 'string' && u.startsWith('./')) return f(new URL(u.slice(2), 'file://' + process.cwd() + '/'), o);
  if (process.env.GITHUB_TOKEN && String(u).startsWith('https://api.github.com/')) o = { ...o, headers: { ...(o.headers || {}), Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } };
  return f(u, o);
})(globalThis.fetch);
try { await loadConfig(); } catch { /* defaults */ }
const results = {};
// one resource at a time (some sites are slow and time out under parallel load), with one retry
for (const s of SOURCES) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const r = await s.probe();
      results[s.id] = { ok: r.ok !== false, ms: Date.now() - t0, extra: r.extra || null, lastModified: r.lastModified || null, lines: (r.lines || []).slice(0, 6), error: r.error || null };
    } catch (e) { results[s.id] = { ok: false, ms: Date.now() - t0, error: String(e.message || e) }; }
    if (results[s.id].ok) break;
  }
  console.log(s.n, s.id, results[s.id].ok ? `ok ${results[s.id].ms} ms` : `FAILED ${results[s.id].error}`);
}
let prev = {}; try { prev = JSON.parse(readFileSync('data/sources.json', 'utf8')); } catch { /* first run */ }
// keep the last good result for a resource that failed this time, marked as such
for (const [id, r] of Object.entries(results)) if (!r.ok && prev.results?.[id]?.ok) results[id] = { ...prev.results[id], stale: prev.checked, error: r.error };
writeFileSync('data/sources.json', JSON.stringify({ checked: new Date().toISOString(), results }, null, 1));
console.log('data/sources.json written');
