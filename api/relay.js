// Vercel Edge Function: /api/relay
import { handle } from '../relay/core.mjs';
export const config = { runtime: 'edge' };
export default (request) => handle(request, { clientIp: request.headers.get('x-real-ip') || 'anon' });
