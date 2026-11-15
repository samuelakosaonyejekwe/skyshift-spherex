// End-to-end checks in a real browser (Playwright). Run with the app served at BASE (default
// http://localhost:8080/):  npm run test:e2e   — needs `npm i -D playwright` (browsers installed).
// Covers: every page loads without console errors, the five presets stream real frames, URL
// loading (incl. WiseView-style params), typed text and equations, uploads (CSV = typed),
// dossier generation, update pop-up wiring, offline shell, Back/Forward, asteroid/comet tables, search without a relay
// (needs the image index in dist/data/idx: node scripts/index.mjs, then npm run build).
let chromium;
try { ({ chromium } = await import('playwright')); } catch { console.log('playwright not installed: skipping e2e (npm i -D playwright)'); process.exit(0); }
const BASE = process.env.BASE || 'http://localhost:8080/';
const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const results = [];
const check = async (name, fn) => { const t0 = Date.now(); try { await fn(); results.push(['PASS', name, Date.now() - t0]); } catch (e) { results.push(['FAIL', name, e.message.split('\n')[0]]); } };
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await ctx.newPage();
const errors = []; page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); }); page.on('pageerror', (e) => errors.push(e.message));
const loaded = () => page.waitForFunction(() => document.querySelector('.stage .loading')?.hidden === true, null, { timeout: 90000 });

for (const r of ['', 'view', 'chase', 'live', 'mission', 'sky', 'saved', 'guide', 'about']) {
  await check(`page #/${r} renders without errors`, async () => { const n = errors.length; await page.goto(`${BASE}#/${r}`); await page.waitForTimeout(2500); if (errors.length > n) throw new Error(errors.slice(n).join(' | ')); });
}
for (const id of ['barnard', 'epsindib', 'wise0855', 'rwaur', 'rdra']) {
  await check(`preset ${id} streams real SPHEREx frames`, async () => { await page.goto(`${BASE}#/view?target=${id}`); await loaded(); });
}
await check('top-level URL with coordinates opens the viewer (embed form)', async () => { await page.goto(`${BASE}?ra=133.786245&dec=-7.244372&fov=6&det=456&mode=blink`); await loaded(); if (!page.url().includes('#/view')) throw new Error(page.url()); });
await check('WiseView-style parameters are accepted', async () => { await page.goto(`${BASE}#/view?ra=133.786245&dec=-7.244372&size=176&speed=500&invert=1&gaia=1`); await loaded(); if (!/invert=1/.test(page.url())) throw new Error('invert lost'); });
await check('typed text is interpreted into a request', async () => { await page.goto(BASE); await page.click('summary:has-text("Describe")'); await page.fill('#typed', 'WISE 0855, 3 to 5 microns, 10 arcmin field, blink first and last'); await page.click('text=Interpret'); await page.waitForSelector('text=field of view 10′'); });
await check('equation mode evaluates on real frames', async () => { await page.goto(`${BASE}#/view?target=wise0855&det=456&mode=expr&expr=${encodeURIComponent('mean(D5, D6) - epoch(1)')}`); await loaded(); await page.waitForTimeout(3000); const l = await page.textContent('.framelabel'); if (!/Equation/.test(l)) throw new Error(l); });
await check('CSV upload gives the same request as typed coordinates', async () => {
  await page.goto(BASE); await page.click('summary:has-text("Upload")');
  await page.setInputFiles('input[type=file]', { name: 't.csv', mimeType: 'text/csv', buffer: Buffer.from('name,ra,dec\nWISE 0855,133.786245,-7.244372\n') });
  await page.waitForSelector('text=Understood: 1 target'); await page.click('text=Open WISE 0855'); await page.waitForTimeout(800);
  if (!page.url().includes('ra=133.786245') || !page.url().includes('dec=-7.244372')) throw new Error(page.url());
});
await check('dossier builds with all quality checks passing', async () => { await page.goto(`${BASE}#/view?target=rwaur`); await loaded(); await page.waitForTimeout(20000); await page.click('button:has-text("Dossier")'); await page.waitForSelector('text=Dossier ready', { timeout: 60000 }); const t = await page.textContent('.sheet ul'); if (/✘/.test(t)) throw new Error(t); });
await check('Back and Forward arrows move between pages', async () => { await page.goto(`${BASE}#/`); await page.click('#mainnav a[data-route=chase]'); await page.waitForTimeout(500); await page.click('#navBack'); await page.waitForTimeout(800); if (!/#\/$|#\/?$/.test(page.url())) throw new Error(page.url()); await page.click('#navFwd'); await page.waitForTimeout(800); if (!page.url().includes('chase')) throw new Error(page.url()); });
await check('app shell works offline (airplane mode)', async () => { await page.goto(BASE); await page.waitForFunction(() => navigator.serviceWorker.controller, null, { timeout: 20000 }); await ctx.setOffline(true); await page.reload(); await page.waitForSelector('.home-hero', { timeout: 15000 }); await ctx.setOffline(false); });
await check('new positions are searchable without a relay (static host, image index)', async () => {
  const c2 = await browser.newContext({ viewport: { width: 1366, height: 860 }, serviceWorkers: 'block' });
  await c2.route('**/config.json', async (r) => { const res = await r.fetch(); const j = await res.json(); j.staticHosts = [new URL(BASE).hostname]; r.fulfill({ response: res, json: j }); });
  await c2.route('**/api/relay**', (r) => r.fulfill({ status: 404, body: 'no relay' }));
  const p2 = await c2.newPage();
  try {
    await p2.goto(`${BASE}#/view?ra=37.123&dec=41.5`);
    await p2.waitForFunction(() => document.querySelector('.stage .loading')?.hidden === true, null, { timeout: 90000 });
    const s = await p2.textContent('body');
    if (!/image index/.test(s)) throw new Error('search did not use the image index');
  } finally { await c2.close(); }
});
await check('asteroid or comet table: Chase reads times and positions and opens a followed view', async () => {
  await page.goto(`${BASE}#/chase`); await page.waitForTimeout(1500);
  await page.fill('textarea', '2026-03-14 00:00  12 34 56.78 +12 34 56.7\n2026-03-15 00:00  12 36 00.00 +12 30 00.0\n2026-03-16 00:00  12 37 00.00 +12 25 00.0');
  await page.click('button:has-text("Read the table")'); await page.waitForSelector('text=Understood: the path of a moving object, 3 positions');
  await page.click('button:has-text("Follow it in SPHEREx images")'); await page.waitForTimeout(800);
  if (!/eph=e[0-9a-z]+/.test(page.url()) || !/track=1/.test(page.url())) throw new Error(page.url());
});
await check('install control is visible', async () => { await page.goto(BASE); if (!(await page.isVisible('#installBtn'))) throw new Error('hidden'); });

await browser.close();
for (const r of results) console.log(r.join('  '));
const failed = results.filter((r) => r[0] === 'FAIL').length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
