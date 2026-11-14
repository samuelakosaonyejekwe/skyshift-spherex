// Build: copy the static app into dist/, generate the versioned service worker,
// version.json and host header files, and enforce the size budget and the
// project's attribution rule. No bundler needed: the app is plain ES modules.

import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync, statSync, copyFileSync, existsSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';

const OUT = 'dist';
const INCLUDE = ['index.html', 'styles.css', 'manifest.webmanifest', 'config.json', 'src', 'vendor', 'icons', 'data', 'assets'];
const LAZY = ['vendor/aladin.js', 'assets/allsky-1200.png']; // fetched on first use, then cached; not precached
const BUDGET_SHELL_GZ = 140 * 1024; // first-load shell (HTML + CSS + JS needed for Home), gzip

function walk(p) {
  const st = statSync(p);
  if (st.isDirectory()) return readdirSync(p).flatMap((f) => walk(join(p, f)));
  return [p];
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const files = INCLUDE.flatMap((p) => walk(p)).filter((f) => !/(^|\/)\.|\.map$|README\.txt$/.test(f));
const hash = createHash('sha256');
for (const f of files) {
  const dest = join(OUT, f);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(f, dest);
  hash.update(f).update(readFileSync(f));
}
const version = `${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${hash.digest('hex').slice(0, 10)}`;

// Precache everything except lazily loaded heavy modules.
const precache = ['./', ...files.filter((f) => !LAZY.includes(f)).map((f) => `./${f}`)];
const sw = readFileSync('scripts/sw.template.js', 'utf8').replace('__VERSION__', version).replace('__PRECACHE__', JSON.stringify(precache, null, 0));
writeFileSync(join(OUT, 'sw.js'), sw);
writeFileSync(join(OUT, 'version.json'), JSON.stringify({ version, built: new Date().toISOString() }));

// Security headers for hosts that support them (Cloudflare Pages / Netlify _headers; local server).
const csp = (readFileSync('index.html', 'utf8').match(/http-equiv="Content-Security-Policy" content="([^"]+)"/) || [])[1];
const headers = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  ...(csp ? { 'Content-Security-Policy': csp } : {}),
};
writeFileSync(join(OUT, 'security-headers.json'), JSON.stringify(headers, null, 2));
writeFileSync(join(OUT, '_headers'), `/*\n${Object.entries(headers).map(([k, v]) => `  ${k}: ${v}`).join('\n')}\n/sw.js\n  Cache-Control: no-cache\n/index.html\n  Cache-Control: no-cache\n/version.json\n  Cache-Control: no-cache\n/config.json\n  Cache-Control: no-cache\n`);
writeFileSync(join(OUT, '.nojekyll'), '');
writeFileSync(join(OUT, '404.html'), readFileSync('index.html', 'utf8'));
// Relay alongside the static files for hosts with functions (Cloudflare Pages).
for (const f of ['relay/core.mjs', 'functions/api/relay.js']) {
  if (existsSync(f)) { mkdirSync(dirname(join(OUT, f)), { recursive: true }); copyFileSync(f, join(OUT, f)); }
}

// ---- every JavaScript module must parse (catches a broken page before it ships)
import('node:child_process').then(() => {});
const { execFileSync } = await import('node:child_process');
for (const f of files.filter((x) => /\.m?js$/.test(x) && !LAZY.includes(x))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { console.error(`Syntax error in ${f}:\n${String(e.stderr).split('\n').slice(0, 6).join('\n')}`); process.exit(1); }
}

// ---- size budget (first load of the Home page)
const shell = ['index.html', 'styles.css', 'src/app.js', 'src/state.js', 'src/lib/coords.js', 'src/ui/dom.js', 'src/lib/net.js', 'src/views/home.js', 'src/targets.js', 'src/lib/tap.js', 'src/lib/store.js', 'src/lib/spherex.js', 'src/lib/fits.js', 'src/lib/wcs.js'];
const gz = shell.reduce((a, f) => a + gzipSync(readFileSync(f), { level: 9 }).length, 0);
console.log(`Shell (gzip): ${(gz / 1024).toFixed(1)} kB of ${(BUDGET_SHELL_GZ / 1024).toFixed(0)} kB budget`);
if (gz > BUDGET_SHELL_GZ) { console.error('Size budget exceeded'); process.exit(1); }

// ---- attribution rule: no assistant/bot attribution anywhere in shipped or source files
const banned = [/\bclaude\b/i, /anthropic/i, /chatgpt/i, /openai/i, /copilot/i, /co-authored-by/i, /generated (by|with) (an )?ai\b/i, /\bai[- ]generated\b/i, /\bai[- ]assisted\b/i];
const scan = [...files, 'README.md', 'package.json', 'server.mjs', 'relay/core.mjs', ...walk('docs').filter((f) => f.endsWith('.md')), ...walk('scripts'), ...walk('test')].filter((f) => existsSync(f) && !LAZY.includes(f));
const hits = [];
for (const f of scan) {
  const txt = readFileSync(f, 'utf8');
  for (const re of banned) if (re.test(txt)) hits.push(`${f}: ${re}`);
}
// the rule list above contains the patterns themselves
const real = hits.filter((h) => !h.startsWith('scripts/build.mjs'));
if (real.length) { console.error('Attribution check failed:\n' + real.join('\n')); process.exit(1); }

console.log(`Built ${files.length} files into ${OUT}/ · version ${version} · ${precache.length} precached`);
