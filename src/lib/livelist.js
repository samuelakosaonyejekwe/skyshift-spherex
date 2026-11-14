// Newest contents of IRSA's public SPHEREx bucket (seed 1): planning periods of the current releases and the
// detector-3 files of the newest period. Shared by the Live page (in the browser; the listing is CORS-enabled)
// and scripts/live.mjs, which publishes the same snapshot as data/live.json every 6 hours so the page can show
// it instantly. Every request has a time limit, so a slow bucket can delay an update but never block the page.

export const BUCKET = 'https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/';
const LIST_TIMEOUT_MS = 15000;

export async function list(prefix, { delimiter = '/', startAfter = '', max = 1000 } = {}) {
  const u = `${BUCKET}?list-type=2&prefix=${encodeURIComponent(prefix)}${delimiter ? `&delimiter=${delimiter}` : ''}${startAfter ? `&start-after=${encodeURIComponent(startAfter)}` : ''}&max-keys=${max}`;
  const r = await fetch(u, { cache: 'no-store', signal: AbortSignal.timeout(LIST_TIMEOUT_MS) });
  if (!r.ok) throw new Error(`Archive listing HTTP ${r.status}`);
  const x = await r.text();
  return {
    prefixes: [...x.matchAll(/<Prefix>([^<]+)<\/Prefix>/g)].map((m) => m[1]).filter((p) => p !== prefix),
    keys: [...x.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)].map((m) => ({ key: (m[1].match(/<Key>([^<]+)/) || [])[1], modified: (m[1].match(/<LastModified>([^<]+)/) || [])[1], size: Number((m[1].match(/<Size>(\d+)/) || [])[1] || 0) })),
    truncated: /<IsTruncated>true/.test(x),
  };
}

/** { checked, periods: [{rel, prefix, period}] newest first, total, top, keys: newest detector-3 files (≤ 40) } */
export async function snapshot(releases = ['qr3', 'dr1']) {
  const lists = await Promise.all(releases.map((rel) => list(`${rel}/level2/`).then((l) => l.prefixes.map((p) => ({ rel, prefix: p, period: p.split('/')[2] })))));
  const all = lists.flat().sort((a, b) => (a.period < b.period ? 1 : -1));
  if (!all.length) throw new Error('the archive listing is empty');
  const top = all[0];
  const versions = (await list(top.prefix)).prefixes.sort();
  const ver = versions[versions.length - 1];
  let keys = [], startAfter = '';
  // file names sort by observation, so the newest are last: page through the whole period (capped at 20 pages)
  for (let page = 0; page < 20; page++) {
    const l = await list(`${ver}3/`, { delimiter: '', startAfter });
    keys = keys.concat(l.keys.filter((k) => k.key.endsWith('.fits')));
    if (!l.truncated) break;
    startAfter = l.keys[l.keys.length - 1].key;
  }
  keys.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { checked: new Date().toISOString(), periods: all.slice(0, 24), total: all.length, top, keys: keys.slice(-40) };
}
