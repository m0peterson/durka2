import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import session, { config as sessionConfig } from '../netlify/functions/session.mjs';
import analyze, { config as analysisConfig } from '../netlify/functions/analyze.mjs';
import getModels from '../netlify/functions/models.mjs';
import { authenticated, sessionCookie, readJSON } from '../server/security.mjs';
import { validateInput, parseResult, buildPayload } from '../server/analysis.mjs';
import { models } from '../server/models.mjs';

const originalEnv = { ...process.env }, originalFetch = globalThis.fetch;
afterEach(() => { process.env = { ...originalEnv }; globalThis.fetch = originalFetch; });
function setup() { process.env.APP_PASSWORD = 'test-only-password-12345'; process.env.SESSION_SECRET = 'test-only-session-secret-123456789012345'; process.env.OPENROUTER_API_KEY = 'fake-api-key-do-not-send'; delete process.env.GEMINI_API_KEY; delete process.env.COMPATIBLE_API_KEY; delete process.env.OPENROUTER_MODELS; }
function req(path, { method = 'POST', body, cookie, origin = 'https://example.netlify.app' } = {}) {
  return new Request(`https://example.netlify.app${path}`, { method, headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}), ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
}
function cookie() { return sessionCookie(req('/api/session')).split(';')[0]; }
const validResult = { score: 58, title: 'Сроки из воздуха', summary: 'Срок обещан без согласования.', confidence: 'medium', evidence: [{ quote: 'Ну ты же профессионал', explanation: 'Давление вместо обсуждения ресурсов.' }], alternative: 'Возможно, клиенту обещали только черновик.', reply: 'Уточним объём и срок.', transcript: '', missingContext: '' };
const catalog = { data: [{ id: 'openai/gpt-6-luna', name: 'GPT-6 Luna', architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['reasoning'], reasoning: { supported_efforts: ['max', 'low', 'none'] }, pricing: { prompt: '0.0000001', completion: '0.0000005' } }] };
const input = { text: 'Ну ты же профессионал', images: [], tone: 'spicy', modelKey: 'openrouter:openai/gpt-6-luna', effort: 'max' };

test('unconfigured deployment fails closed; unauthenticated APIs never call a provider', async () => {
  delete process.env.APP_PASSWORD; delete process.env.SESSION_SECRET;
  let called = false; globalThis.fetch = async () => { called = true; throw new Error(); };
  assert.equal((await analyze(req('/api/analyze', { body: input }))).status, 503);
  setup(); assert.equal((await analyze(req('/api/analyze', { body: input }))).status, 401);
  assert.equal((await getModels(req('/api/models', { method: 'GET' }))).status, 401); assert.equal(called, false);
});
test('login, session cookie attributes, logout and wrong password', async () => {
  setup(); assert.equal((await session(req('/api/session', { body: { password: 'wrong' } }))).status, 401);
  const login = await session(req('/api/session', { body: { password: process.env.APP_PASSWORD } }));
  assert.equal(login.status, 200); const set = login.headers.get('set-cookie');
  for (const attribute of ['__Host-durka_session=', 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(set.includes(attribute));
  assert.ok(!set.includes(process.env.APP_PASSWORD));
  const check = await session(req('/api/session', { method: 'GET', cookie: set.split(';')[0] }));
  assert.equal((await check.json()).authenticated, true);
  const logout = await session(req('/api/session', { method: 'DELETE' })); assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
});
test('tampering, expiry and password rotation invalidate cookies', () => {
  setup(); const good = cookie(); assert.ok(authenticated(req('/api/models', { cookie: good })));
  assert.ok(!authenticated(req('/api/models', { cookie: `${good}x` })));
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() - 1000 })).toString('base64url');
  const sig = createHmac('sha256', process.env.SESSION_SECRET).update(`${payload}:${process.env.APP_PASSWORD}`).digest('base64url');
  assert.ok(!authenticated(req('/api/models', { cookie: `__Host-durka_session=${payload}.${sig}` })));
  process.env.APP_PASSWORD += 'changed'; assert.ok(!authenticated(req('/api/models', { cookie: good })));
});
test('cross-origin requests, missing origin and alternate function aliases are blocked', async () => {
  setup();
  assert.equal((await analyze(req('/api/analyze', { body: input, cookie: cookie(), origin: 'https://evil.example' }))).status, 403);
  assert.equal((await session(req('/api/session', { body: {}, origin: null }))).status, 403);
  assert.equal((await analyze(req('/.netlify/functions/analyze', { body: input, cookie: cookie() }))).status, 404);
  assert.equal((await analyze(req('/api/analyze', { method: 'GET', cookie: cookie() }))).status, 405);
});
test('bounded body reading does not trust Content-Length and rejects malformed JSON', async () => {
  await assert.rejects(() => readJSON(req('/api/analyze', { body: ' '.repeat(30) }), 20), { status: 413 });
  await assert.rejects(() => readJSON(req('/api/analyze', { body: '{' }), 20), { status: 400 });
});
test('input validation rejects remote URLs, fake images, excessive images and empty material', () => {
  assert.throws(() => validateInput({ ...input, text: '', images: [] }));
  assert.throws(() => validateInput({ ...input, text: 'a'.repeat(16001) }));
  assert.throws(() => validateInput({ ...input, images: ['https://internal.example/secret'] }));
  assert.throws(() => validateInput({ ...input, images: ['data:image/png;base64,YWJjZA=='] }));
  assert.throws(() => validateInput({ ...input, images: Array(5).fill('x') }));
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7l8AAAAASUVORK5CYII=';
  assert.equal(validateInput({ ...input, text: '', images: [png] }).images.length, 1);
});
test('catalog filters absent models, prices and unsupported efforts', async () => {
  setup(); const list = (await models(async () => Response.json(catalog))).models;
  assert.equal(list.length, 1); assert.ok(Math.abs(list[0].inputPrice - .1) < 1e-9); assert.deepEqual(list[0].efforts, ['max', 'low', 'none']);
  const omitted = structuredClone(catalog); delete omitted.data[0].reasoning.supported_efforts;
  assert.deepEqual((await models(async () => Response.json(omitted))).models[0].efforts, []);
});
test('server controls model, token budget and reasoning; images cannot go to text-only model', () => {
  const model = { provider: 'openrouter', model: 'openai/gpt-6-luna', vision: true, efforts: ['max', 'low'] };
  const payload = buildPayload(input, model); assert.equal(payload.max_tokens, 16000); assert.deepEqual(payload.reasoning, { effort: 'max', exclude: true });
  assert.equal(buildPayload({ ...input, effort: 'low' }, model).max_tokens, 4096);
  assert.throws(() => buildPayload({ ...input, effort: 'impossible' }, model));
  assert.throws(() => buildPayload({ ...input, images: ['a'] }, { ...model, vision: false }));
});
test('full authorized analysis sends server key and returns only safe result fields', async () => {
  setup(); let sent;
  globalThis.fetch = async (url, options) => {
    if (url.endsWith('/models')) return Response.json(catalog);
    sent = { url, ...options };
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(validResult), reasoning: 'private reasoning' } }], usage: { completion_tokens: 100, cost: .001 }, secret: process.env.OPENROUTER_API_KEY });
  };
  const result = await analyze(req('/api/analyze', { cookie: cookie(), body: { ...input, max_tokens: 999999, apiKey: 'attacker-key', baseUrl: 'https://evil.example' } }));
  assert.equal(result.status, 200); assert.equal(sent.headers.Authorization, 'Bearer fake-api-key-do-not-send');
  assert.equal(sent.url, 'https://openrouter.ai/api/v1/chat/completions'); assert.equal(JSON.parse(sent.body).max_tokens, 16000);
  const content = await result.text(); assert.ok(!content.includes('fake-api-key')); assert.ok(!content.includes('private reasoning')); assert.equal(JSON.parse(content).result.score, 58);
});
test('provider error bodies do not leak and requests never retry', async () => {
  setup(); let calls = 0;
  globalThis.fetch = async url => { if (url.endsWith('/models')) return Response.json(catalog); calls++; return new Response('secret: fake-api-key-do-not-send', { status: 402 }); };
  const result = await analyze(req('/api/analyze', { cookie: cookie(), body: input }));
  assert.equal(result.status, 502); assert.ok(!(await result.text()).includes('fake-api-key')); assert.equal(calls, 1);
});
test('invalid or truncated model results fail explicitly instead of inventing a score', () => {
  assert.deepEqual(parseResult(JSON.stringify(validResult)), validResult);
  assert.throws(() => parseResult(JSON.stringify({ ...validResult, score: 101 })));
  assert.throws(() => parseResult(JSON.stringify({ ...validResult, evidence: [null] })));
  assert.throws(() => parseResult('not json'));
  assert.equal(parseResult(JSON.stringify({ ...validResult, score: null })).score, null);
});
test('per-IP platform rate limits are attached to protected routes', () => {
  assert.equal(analysisConfig.path, '/api/analyze'); assert.equal(analysisConfig.rateLimit.windowLimit, 6);
  assert.deepEqual(sessionConfig.rateLimit.aggregateBy, ['ip', 'domain']);
});
