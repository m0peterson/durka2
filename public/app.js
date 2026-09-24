const $ = id => document.getElementById(id);
let modelList = [], images = [], tone = 'spicy', busy = false, uploading = false, currentResult = null, controller = null;
const effortNames = { max: 'Максимум · max', xhigh: 'Очень глубоко', high: 'Глубоко', medium: 'Сбалансированно', low: 'Быстро · low', minimal: 'Минимально', none: 'Без рассуждений' };

async function api(path, options = {}) {
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  let data; try { data = await response.json(); } catch { data = {}; }
  if (!response.ok) {
    if (response.status === 401 && path !== '/api/session') showLogin();
    throw new Error(data.error || (response.status === 429 ? 'Слишком много запросов. Подожди минуту.' : `Ошибка сервера (${response.status}). Попробуй ещё раз.`));
  }
  return data;
}
function showLogin() { $('workspace').hidden = true; $('login-panel').hidden = false; $('logout').hidden = true; $('boot').hidden = true; }
async function enter() {
  $('password').value = ''; $('login-panel').hidden = true; $('boot').hidden = true; $('workspace').hidden = false; $('logout').hidden = false;
  await loadModels();
}
async function loadModels() {
  $('analyze').disabled = true; $('model').replaceChildren(); $('error').textContent = ''; $('reload-models').hidden = true;
  try {
    const data = await api('/api/models'); modelList = data.models;
    for (const model of modelList) { const option = document.createElement('option'); option.value = model.key; option.textContent = `${model.name} · ${model.source}`; $('model').append(option); }
    if (!modelList.length) throw new Error('Нет доступных моделей. Добавь OPENROUTER_API_KEY или GEMINI_API_KEY в Netlify и выполни новый deploy.');
    updateModel();
    if (data.catalogUnavailable) $('error').textContent = 'Каталог OpenRouter временно недоступен. Показан серверный список; наличие моделей и цены сейчас не подтверждены.';
  } catch (error) { $('error').textContent = error.message; $('reload-models').hidden = false; }
  finally { $('analyze').disabled = !modelList.length || busy || uploading; }
}
function updateModel() {
  const model = modelList.find(m => m.key === $('model').value); $('effort').replaceChildren();
  if (!model) return;
  for (const effort of model.efforts.length ? model.efforts : ['']) { const option = document.createElement('option'); option.value = effort; option.textContent = effortNames[effort] || 'Стандартный'; $('effort').append(option); }
  $('effort').disabled = !model.efforts.length; updateModelNote();
}
function updateModelNote() {
  const model = modelList.find(m => m.key === $('model').value); if (!model) return;
  const cost = model.inputPrice !== null && model.outputPrice !== null ? `$${model.inputPrice.toFixed(2)} вход / $${model.outputPrice.toFixed(2)} выход за 1 млн токенов.` : 'Стоимость по тарифу провайдера.';
  const reasoning = ['max', 'xhigh', 'high'].includes($('effort').value) ? ' Глубокий режим медленнее и расходует больше токенов.' : '';
  $('model-note').textContent = `${model.vision ? 'Принимает скриншоты.' : 'Только текст.'} ${cost}${reasoning}`;
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-submit').disabled = true; $('login-error').textContent = '';
  try { await api('/api/session', { method: 'POST', body: JSON.stringify({ password: $('password').value }) }); await enter(); }
  catch (error) { $('login-error').textContent = error.message; }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', async () => {
  try { await api('/api/session', { method: 'DELETE' }); controller?.abort(); clear(); showLogin(); $('password').focus(); }
  catch (error) { $('error').textContent = error.message; }
});
$('reload-models').addEventListener('click', loadModels);
$('model').addEventListener('change', updateModel); $('effort').addEventListener('change', updateModelNote);
$('conversation').addEventListener('input', () => { $('char-count').textContent = `${$('conversation').value.length.toLocaleString('ru')} / 16 000`; });
document.querySelectorAll('[data-tone]').forEach(button => button.addEventListener('click', () => {
  tone = button.dataset.tone; document.querySelectorAll('[data-tone]').forEach(b => b.setAttribute('aria-pressed', String(b === button)));
}));
$('demo').addEventListener('click', () => {
  $('conversation').value = 'Я: Давай согласуем срок до того, как пообещаем клиенту.\nКоллега: Я уже пообещал завтра.\nЯ: Но на работу нужно три дня.\nКоллега: Ну ты же профессионал, придумай что-нибудь. И не надо создавать негатив.\n\nКонтекст: объём работы не менялся, о трёх днях предупреждал вчера. Как ответить без ссоры?';
  $('conversation').dispatchEvent(new Event('input')); $('conversation').focus();
});
function setBusy(value) {
  busy = value;
  for (const id of ['analyze', 'conversation', 'model', 'effort', 'demo', 'file-input', 'clear', 'reload-models']) $(id).disabled = value;
  document.querySelectorAll('[data-tone], .preview button').forEach(b => { b.disabled = value; });
  if (!value) { $('analyze').disabled = !modelList.length || uploading; $('effort').disabled = !modelList.find(m => m.key === $('model').value)?.efforts.length; }
  $('analyze').firstElementChild.textContent = value ? 'Изучаем материалы дела…' : 'Проверить на дичь';
}
async function convertImage(file) {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('Выбери PNG, JPEG или WebP.');
  if (file.size > 20 * 1024 * 1024) throw new Error('Исходный файл больше 20 МБ. Сначала уменьши его.');
  const bitmap = await createImageBitmap(file);
  try {
    if (bitmap.width * bitmap.height > 60_000_000) throw new Error('Изображение слишком большое. Раздели его на части.');
    const scale = Math.min(1, 2000 / bitmap.width, 8000 / bitmap.height, Math.sqrt(12_000_000 / (bitmap.width * bitmap.height)));
    const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height); context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    let data = canvas.toDataURL('image/png');
    if (data.length > 1_300_000) for (const quality of [.9, .78, .62]) { data = canvas.toDataURL('image/jpeg', quality); if (data.length <= 1_300_000) break; }
    if (data.length > 1_300_000) throw new Error('Скрин слишком тяжёлый даже после сжатия. Раздели его на части.');
    return { name: file.name || 'Скриншот из буфера', data, resized: scale < .7 };
  } finally { bitmap.close(); }
}
async function addFiles(files) {
  if (busy || uploading || $('workspace').hidden) return;
  uploading = true; $('analyze').disabled = true; $('error').textContent = '';
  const notices = [];
  try {
    for (const file of files) {
      if (images.length >= 4) { notices.push('Можно приложить до 4 изображений.'); break; }
      try {
        const image = await convertImage(file);
        if (images.reduce((sum, i) => sum + i.data.length, 0) + image.data.length > 3_700_000) throw new Error('Суммарный размер скриншотов слишком большой. Удали часть или раздели разбор.');
        // Logout can happen while the image is being decoded.
        if ($('workspace').hidden) break;
        images.push(image);
        if (image.resized) notices.push('Большой скрин уменьшен. Если текст стал мелким, раздели исходник на части.');
      } catch (error) { notices.push(error.message || 'Не удалось прочитать изображение.'); }
    }
    renderImages(); $('error').textContent = [...new Set(notices)].join(' ');
  } finally { uploading = false; $('analyze').disabled = busy || !modelList.length; $('file-input').value = ''; }
}
function renderImages() {
  $('image-list').replaceChildren();
  images.forEach((image, index) => {
    const wrapper = document.createElement('div'); wrapper.className = 'preview';
    const img = document.createElement('img'); img.src = image.data; img.alt = `Скриншот ${index + 1}`;
    const remove = document.createElement('button'); remove.textContent = '×'; remove.setAttribute('aria-label', `Удалить скриншот ${index + 1}`); remove.disabled = busy;
    remove.addEventListener('click', () => { images.splice(index, 1); renderImages(); });
    const name = document.createElement('small'); name.textContent = `${index + 1}. ${image.name}`;
    wrapper.append(img, remove, name); $('image-list').append(wrapper);
  });
}
$('dropzone').addEventListener('click', () => { if (!busy && !uploading) $('file-input').click(); });
$('dropzone').addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); if (!busy && !uploading) $('file-input').click(); } });
$('file-input').addEventListener('change', event => addFiles([...event.target.files]));
for (const eventName of ['dragover', 'dragenter']) $('dropzone').addEventListener(eventName, event => { event.preventDefault(); $('dropzone').classList.add('dragover'); });
$('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('dragover'));
$('dropzone').addEventListener('drop', event => { event.preventDefault(); $('dropzone').classList.remove('dragover'); addFiles([...event.dataTransfer.files]); });
document.addEventListener('paste', event => {
  if ($('workspace').hidden || busy || uploading) return;
  const files = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file').map(item => item.getAsFile()).filter(Boolean);
  if (files.length) { event.preventDefault(); addFiles(files); }
});
$('analyze').addEventListener('click', async () => {
  if (busy || uploading) return;
  $('error').textContent = '';
  if (!$('conversation').value.trim() && !images.length) { $('error').textContent = 'Добавь переписку или хотя бы один скриншот.'; $('conversation').focus(); return; }
  currentResult = null; $('result').hidden = true; $('empty-result').hidden = false;
  setBusy(true); $('progress').hidden = false; const started = Date.now();
  const tick = () => { const seconds = Math.floor((Date.now() - started) / 1000); $('progress').textContent = seconds < 12 ? `Читаем, сверяем контекст… ${seconds} с` : `Модель разбирается в ситуации… ${seconds} с. Глубокий режим требует времени.`; };
  tick(); const timer = setInterval(tick, 1000); controller = new AbortController();
  const timeout = setTimeout(() => controller?.abort(), 58_000);
  try {
    const data = await api('/api/analyze', { method: 'POST', signal: controller.signal, body: JSON.stringify({ text: $('conversation').value, images: images.map(i => i.data), modelKey: $('model').value, effort: $('effort').value, tone }) });
    currentResult = data; renderResult(data);
    if (window.innerWidth < 681) $('result-heading').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'start' });
  } catch (error) { $('error').textContent = error.name === 'AbortError' ? 'Ожидание прервано. Провайдер мог списать токены; автоматического повтора нет.' : error.message; }
  finally { clearInterval(timer); clearTimeout(timeout); controller = null; $('progress').hidden = true; setBusy(false); }
});
function renderResult(data) {
  const r = data.result; $('empty-result').hidden = true; $('result').hidden = false;
  $('score').textContent = r.score ?? '?'; $('score-outof').hidden = r.score === null; $('score-meter').hidden = r.score === null; $('score-meter').value = r.score ?? 0;
  $('confidence').textContent = `Уверенность: ${{ low: 'низкая', medium: 'средняя', high: 'высокая' }[r.confidence]}`;
  for (const [id, value] of Object.entries({ verdict: r.title, summary: r.summary, alternative: r.alternative, reply: r.reply, transcript: r.transcript })) $(id).textContent = value;
  $('missing').textContent = r.missingContext ? `Не хватает контекста: ${r.missingContext}` : ''; $('missing').hidden = !r.missingContext;
  $('transcript-details').hidden = !r.transcript; $('transcript-details').open = false;
  $('evidence').replaceChildren();
  for (const item of r.evidence) { const div = document.createElement('div'); div.className = 'evidence-item'; const quote = document.createElement('blockquote'); quote.textContent = `«${item.quote}»`; const p = document.createElement('p'); p.textContent = item.explanation; div.append(quote, p); $('evidence').append(div); }
  if (!r.evidence.length) { const p = document.createElement('p'); p.textContent = 'Достоверных цитат для вывода недостаточно.'; $('evidence').append(p); }
  const usage = data.usage; $('result-meta').textContent = `${data.model} · ${data.source} · ${(data.elapsedMs / 1000).toFixed(1)} с${usage.completionTokens !== null ? ` · ${usage.completionTokens} выходных токенов` : ''}${usage.cost !== null ? ` · $${usage.cost.toFixed(5)}` : ''}`;
}
$('copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(currentResult.result.reply); $('copy').textContent = 'Скопировано ✓'; setTimeout(() => { $('copy').textContent = 'Копировать ↗'; }, 1800); } catch { $('error').textContent = 'Не удалось скопировать. Выдели текст ответа вручную.'; } });
function clear() { $('conversation').value = ''; $('conversation').dispatchEvent(new Event('input')); images = []; renderImages(); currentResult = null; $('result').hidden = true; $('empty-result').hidden = false; $('error').textContent = ''; }
$('clear').addEventListener('click', clear);
(async () => { try { const session = await api('/api/session'); if (session.authenticated) await enter(); else { showLogin(); if (!session.configured) $('login-error').textContent = 'Сначала настрой APP_PASSWORD (от 16 символов), SESSION_SECRET (от 32) и ключ LLM в переменных окружения Netlify, затем выполни deploy.'; } } catch (error) { showLogin(); $('login-error').textContent = error.message; } })();
