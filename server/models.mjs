import { HttpError } from './security.mjs';

let cached;
const efforts = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const defaults = 'openai/gpt-6-luna,google/gemini-2.5-flash-lite';
export async function models(fetcher = fetch) {
  const result = [];
  let catalogUnavailable = false;
  if (process.env.OPENROUTER_API_KEY) {
    const ids = (process.env.OPENROUTER_MODELS || defaults).split(',').map(x => x.trim()).filter(Boolean).slice(0, 20);
    let catalog;
    try {
      if (fetcher === fetch && cached?.expires > Date.now()) catalog = cached.data;
      else {
        const response = await fetcher('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(4000), redirect: 'error' });
        if (!response.ok) throw new Error('catalog');
        catalog = (await response.json()).data;
        if (!Array.isArray(catalog)) throw new Error('catalog');
        if (fetcher === fetch) cached = { expires: Date.now() + 300_000, data: catalog };
      }
    } catch { catalogUnavailable = true; }
    for (const id of ids) {
      const model = catalog?.find(m => m.id === id);
      // When the catalog is reachable, never offer a model it does not list.
      if (catalog && !model) continue;
      const supportsReasoning = model ? model.supported_parameters?.includes('reasoning') : id === 'openai/gpt-6-luna';
      const supported = model?.reasoning?.supported_efforts;
      const selectableEffort = !model ? id === 'openai/gpt-6-luna' : model.reasoning && Object.hasOwn(model.reasoning, 'supported_efforts');
      const availableEfforts = supportsReasoning && selectableEffort ? efforts.filter(e => (!Array.isArray(supported) || supported.includes(e)) && !(model?.reasoning?.mandatory && e === 'none')) : [];
      result.push({
        key: `openrouter:${id}`, provider: 'openrouter', model: id,
        name: model?.name || id, source: 'OpenRouter',
        vision: model ? !!model.architecture?.input_modalities?.includes('image') : ['openai/gpt-6-luna', 'google/gemini-2.5-flash-lite'].includes(id),
        efforts: availableEfforts,
        inputPrice: price(model?.pricing?.prompt), outputPrice: price(model?.pricing?.completion),
      });
    }
  }
  if (process.env.GEMINI_API_KEY) result.push({ key: 'gemini:gemini-2.5-flash-lite', provider: 'gemini', model: 'gemini-2.5-flash-lite', name: 'Gemini 2.5 Flash-Lite', source: 'Google напрямую', vision: true, efforts: [], inputPrice: null, outputPrice: null });
  if (process.env.COMPATIBLE_API_KEY && process.env.COMPATIBLE_BASE_URL && process.env.COMPATIBLE_MODEL) {
    const url = new URL(process.env.COMPATIBLE_BASE_URL);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new HttpError(503, 'COMPATIBLE_BASE_URL должен быть HTTPS-адресом API без пароля, query и fragment.');
    result.push({ key: `compatible:${process.env.COMPATIBLE_MODEL}`, provider: 'compatible', model: process.env.COMPATIBLE_MODEL, name: process.env.COMPATIBLE_MODEL, source: 'Другой провайдер', vision: process.env.COMPATIBLE_VISION === 'true', efforts: [], inputPrice: null, outputPrice: null });
  }
  return { models: result, catalogUnavailable };
}
function price(value) { return value != null && Number.isFinite(Number(value)) ? Number(value) * 1_000_000 : null; }
export function connection(provider) {
  if (provider === 'openrouter') return { url: 'https://openrouter.ai/api/v1/chat/completions', key: process.env.OPENROUTER_API_KEY };
  if (provider === 'gemini') return { url: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', key: process.env.GEMINI_API_KEY };
  if (provider === 'compatible') return { url: `${process.env.COMPATIBLE_BASE_URL.replace(/\/+$/, '')}/chat/completions`, key: process.env.COMPATIBLE_API_KEY };
  throw new HttpError(400, 'Неизвестный провайдер.');
}
