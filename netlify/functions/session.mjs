import { guard, json, fail, configured, authenticated, requireSetup, readJSON, equal, sessionCookie } from '../../server/security.mjs';
export default async function handler(request) {
  try {
    guard(request, '/api/session', ['GET', 'POST', 'DELETE']);
    if (request.method === 'GET') return json({ authenticated: authenticated(request), configured: configured() });
    if (request.method === 'DELETE') return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, true) });
    requireSetup();
    const body = await readJSON(request, 2048);
    if (typeof body?.password !== 'string' || !equal(body.password, process.env.APP_PASSWORD)) return json({ error: 'Пароль не подошёл.' }, 401);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request) });
  } catch (error) { return fail(error); }
}
export const config = { path: '/api/session', rateLimit: { windowLimit: 15, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
