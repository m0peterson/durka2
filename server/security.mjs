import { createHmac, createHash, timingSafeEqual, randomBytes } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers } });
}
export function fail(error) {
  return json({ error: error instanceof HttpError ? error.message : 'Внутренняя ошибка сервера. Попробуй ещё раз.' }, error instanceof HttpError ? error.status : 500);
}
export function configured() {
  return (process.env.APP_PASSWORD?.length ?? 0) >= 16 && (process.env.SESSION_SECRET?.length ?? 0) >= 32;
}
export function requireSetup() {
  if (!configured()) throw new HttpError(503, 'В Netlify нужно задать APP_PASSWORD (от 16 символов) и SESSION_SECRET (от 32 символов), затем выполнить новый deploy.');
}
export function equal(a, b) {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function sign(payload) {
  return createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}:${process.env.APP_PASSWORD}`).digest('base64url');
}
export function cookieName(request) { return new URL(request.url).protocol === 'https:' ? '__Host-durka_session' : 'durka_dev_session'; }
export function sessionCookie(request, logout = false) {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() + 8 * 3600_000, nonce: randomBytes(16).toString('hex') })).toString('base64url');
  const token = logout ? '' : `${payload}.${sign(payload)}`;
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${logout ? 0 : 28800}${secure}`;
}
export function authenticated(request) {
  if (!configured()) return false;
  try {
    const value = request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith(`${cookieName(request)}=`))?.split('=')[1];
    const [payload, signature, extra] = (value || '').split('.');
    if (!payload || !signature || extra || value.length > 1024 || !equal(sign(payload), signature)) return false;
    const { exp } = JSON.parse(Buffer.from(payload, 'base64url'));
    return Number.isFinite(exp) && exp > Date.now() && exp <= Date.now() + 8 * 3600_000;
  } catch { return false; }
}
export function requireAuth(request) {
  requireSetup();
  if (!authenticated(request)) throw new HttpError(401, 'Войди с паролем доступа.');
}
export function guard(request, path, methods) {
  // Do not expose Netlify's alternate function URL, which could bypass path limits.
  if (new URL(request.url).pathname !== path) throw new HttpError(404, 'Не найдено.');
  if (!methods.includes(request.method)) throw new HttpError(405, 'Метод не поддерживается.');
  if (request.method !== 'GET') {
    const origin = request.headers.get('origin');
    if (origin !== new URL(request.url).origin || request.headers.get('sec-fetch-site') === 'cross-site') throw new HttpError(403, 'Запрос должен приходить с этого сайта.');
    if (!request.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'Нужен JSON.');
  }
}
export async function readJSON(request, limit) {
  if (Number(request.headers.get('content-length')) > limit) throw new HttpError(413, 'Слишком большой запрос. Уменьши скриншоты.');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'Пустой запрос.');
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Слишком большой запрос. Уменьши скриншоты.'); }
    chunks.push(value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'Некорректный JSON.'); }
}
