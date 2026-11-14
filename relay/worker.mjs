// Cloudflare Worker / Deno Deploy entry: deploy this file on its own to get an extra relay.
import { handle } from './core.mjs';
export default {
  fetch(request) {
    return handle(request, { clientIp: request.headers.get('cf-connecting-ip') || 'anon' });
  },
  // Cron trigger (wrangler.toml): ask Cloudflare Pages to rebuild via a deploy hook, so data
  // refreshes on a second, independent scheduler. Set the secret PAGES_DEPLOY_HOOK to enable.
  async scheduled(_event, env) {
    if (env.PAGES_DEPLOY_HOOK) await fetch(env.PAGES_DEPLOY_HOOK, { method: 'POST' });
  },
};
