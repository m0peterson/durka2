import { guard, requireAuth, json, fail } from '../../server/security.mjs';
import { models } from '../../server/models.mjs';
export default async function handler(request) {
  try { guard(request, '/api/models', ['GET']); requireAuth(request); return json(await models()); }
  catch (error) { return fail(error); }
}
export const config = { path: '/api/models', rateLimit: { windowLimit: 30, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
