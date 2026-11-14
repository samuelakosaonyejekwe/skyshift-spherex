// Network layer. Browsers call CORS-enabled sources directly (IRSA S3 bucket,
// IRSA HiPS, GitHub API). Services that do not send CORS headers (IRSA TAP/SIA,
// MAST API, CADC TAP, mission web pages) are reached through a stateless,
// allow-listed relay. Several relays can be configured; the first healthy one wins
// and is remembered, so no single host (or this developer's machine) is required.

const DIRECT_HOSTS = [
  'nasa-irsa-spherex.s3.us-east-1.amazonaws.com',
  'api.github.com',
  'raw.githubusercontent.com',
];
const DIRECT_PREFIXES = ['https://irsa.ipac.caltech.edu/data/hips/'];

let config = { relays: ['/api/relay'] };
let preferred = null;
const listeners = new Set();
export const netStatus = { relay: null, lastError: null, online: typeof navigator === 'undefined' ? true : navigator.onLine };

export function onNetStatus(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit() { for (const fn of listeners) fn(netStatus); }

export async function loadConfig() {
  try {
    const r = await fetch('./config.json', { cache: 'no-cache' });
    if (r.ok) config = { ...config, ...(await r.json()) };
  } catch { /* offline: keep defaults */ }
  try {
    const extra = JSON.parse(localStorage.getItem('skyshift.relays') || '[]');
    if (Array.isArray(extra) && extra.length) config.relays = [...new Set([...extra, ...config.relays])];
  } catch { /* ignore */ }
  preferred = (typeof localStorage !== 'undefined' && localStorage.getItem('skyshift.relay')) || null;
  // Static hosts (e.g. GitHub Pages) cannot run the same-origin relay: drop it there so the app does not
  // make doomed requests; external relays listed in config.json are still used.
  const staticHosts = config.staticHosts || ['github.io'];
  if (typeof location !== 'undefined' && staticHosts.some((h) => location.hostname.endsWith(h))) {
    config.relays = config.relays.filter((r) => /^https?:/i.test(r));
    if (preferred && !/^https?:/i.test(preferred)) preferred = null;
  }
  return config;
}
export const getConfig = () => config;

export function isDirect(url) {
  try {
    const u = new URL(url);
    return DIRECT_HOSTS.includes(u.host) || DIRECT_PREFIXES.some((p) => url.startsWith(p));
  } catch { return false; }
}

function withTimeout(ms, outer) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(new DOMException('Timed out', 'TimeoutError')), ms);
  if (outer) outer.addEventListener('abort', () => ctl.abort(outer.reason), { once: true });
  return { signal: ctl.signal, done: () => clearTimeout(t) };
}

/**
 * Fetch any allow-listed URL: direct when CORS allows, otherwise via the relay chain.
 * opts: { method, body, headers, timeout, signal }
 */
export async function smartFetch(url, opts = {}) {
  const { timeout = 45000, signal, ...init } = opts;
  if (isDirect(url)) {
    const t = withTimeout(timeout, signal);
    try { return await fetch(url, { ...init, signal: t.signal }); } finally { t.done(); }
  }
  const relays = [...new Set([preferred, ...config.relays].filter(Boolean))];
  let lastErr = new Error('no archive relay is available on this host');
  if (!relays.length) { netStatus.relay = null; netStatus.lastError = lastErr.message; emit(); throw lastErr; }
  for (const relay of relays) {
    const t = withTimeout(timeout, signal);
    try {
      const target = `${relay}${relay.includes('?') ? '&' : '?'}url=${encodeURIComponent(url)}`;
      const res = await fetch(target, { ...init, signal: t.signal });
      if (res.status === 502 || res.status === 503 || res.status === 504 || res.status === 404) {
        lastErr = new Error(`Relay ${relay} answered ${res.status}`);
        continue;
      }
      if (res.headers.get('x-relay-error')) {
        let detail = '';
        try { detail = (await res.clone().json()).detail || ''; } catch { /* ignore */ }
        lastErr = new Error(`${new URL(url).hostname} is unreachable${detail ? ` (${detail})` : ''}`);
        continue;
      }
      if (relay !== preferred) {
        preferred = relay;
        try { localStorage.setItem('skyshift.relay', relay); } catch { /* ignore */ }
      }
      netStatus.relay = relay; netStatus.lastError = null; emit();
      return res;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    } finally { t.done(); }
  }
  netStatus.relay = null; netStatus.lastError = String(lastErr.message || lastErr); emit();
  throw lastErr;
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', () => { netStatus.online = true; emit(); });
  window.addEventListener('offline', () => { netStatus.online = false; emit(); });
}
