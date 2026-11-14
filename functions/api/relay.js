// Cloudflare Pages Function: serves /api/relay next to the static app.
import { handle } from '../../relay/core.mjs';
export const onRequest = ({ request }) => handle(request, { clientIp: request.headers.get('cf-connecting-ip') || 'anon' });
