// Cloudflare Worker / Deno Deploy entry: deploy this file on its own to get an extra relay.
import { handle } from './core.mjs';
export default {
  fetch(request) {
    return handle(request, { clientIp: request.headers.get('cf-connecting-ip') || 'anon' });
  },
};
