import { guard, requireAuth, readJSON, json, fail, HttpError } from '../../server/security.mjs';
import { models, connection } from '../../server/models.mjs';
import { validateInput, buildPayload, parseResult } from '../../server/analysis.mjs';

export default async function handler(request) {
  try {
    guard(request, '/api/analyze', ['POST']);
    requireAuth(request);
    const input = validateInput(await readJSON(request, 4_000_000));
    const { models: list } = await models();
    const model = list.find(m => m.key === input.modelKey);
    if (!model) throw new HttpError(400, 'Модель недоступна. Обнови список или настрой ключ провайдера в Netlify.');
    const payload = buildPayload(input, model);
    const { url, key } = connection(model.provider);
    const started = Date.now();
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(48_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      const errors = { 401: 'Провайдер отклонил API-ключ. Проверь его в Netlify.', 402: 'У провайдера закончился баланс или достигнут лимит расходов.', 403: 'Провайдер запретил доступ к модели.', 404: 'Модель не найдена у провайдера. Обнови серверный список моделей.', 429: 'Провайдер ограничил частоту запросов. Подожди или выбери другой источник.' };
      throw new HttpError(502, errors[response.status] || `Провайдер не выполнил запрос (HTTP ${response.status}). Попробуй другую модель или режим.`);
    }
    const data = await response.json();
    if (data.choices?.[0]?.finish_reason === 'length') throw new HttpError(502, 'Модель исчерпала лимит токенов. Выбери меньший effort: потраченные токены могут быть оплачены.');
    const result = parseResult(data.choices?.[0]?.message?.content);
    return json({ result, model: model.name, source: model.source, elapsedMs: Date.now() - started,
      usage: { promptTokens: finite(data.usage?.prompt_tokens), completionTokens: finite(data.usage?.completion_tokens), cost: finite(data.usage?.cost) } });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return fail(new HttpError(504, 'Модель не успела ответить за 48 секунд. Попробуй low или другую модель. Провайдер мог списать токены; автоматического повторного запроса нет.'));
    return fail(error);
  }
}
function finite(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null; }
export const config = { path: '/api/analyze', rateLimit: { windowLimit: 6, windowSize: 60, aggregateBy: ['ip', 'domain'] } };
