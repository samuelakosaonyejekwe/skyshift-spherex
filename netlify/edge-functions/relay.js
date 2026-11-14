// Netlify Edge Function mounted at /api/relay (see netlify.toml).
import { handle } from '../../relay/core.mjs';
export default (request, context) => handle(request, { clientIp: context?.ip || 'anon' });
export const config = { path: '/api/relay' };
