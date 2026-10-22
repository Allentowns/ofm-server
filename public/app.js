/* ofm-server console (vanilla JS, no build step) */
'use strict';

const $ = sel => document.querySelector(sel);
const fmtTime = ts => new Date(ts).toLocaleTimeString();
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---- key handling: the console asks once and keeps it in sessionStorage ----
function getKey() {
  return sessionStorage.getItem('ofm-key') ?? '';
}
async function api(path, options = {}) {
  const key = getKey();
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...(options.headers ?? {}) },
  });
  if (response.status === 401) {
    const input = prompt('输入本地 Key（控制台启动时打印，或高级配置查看）:');
    if (input === null) throw new Error('需要本地 Key');
    sessionStorage.setItem('ofm-key', input.trim());
    return api(path, options);
  }
  return response.json();
}

function maskKey(key) {
  if (key.length <= 10) return '•'.repeat(key.length);
  return key.slice(0, 6) + '•'.repeat(12) + key.slice(-4);
}
let keyVisible = false;
function renderKey() {
  const key = state.settings.localKey ?? '';
  // Display may be masked; the clipboard value never is.
  const node = $('#qs-key');
  if (node) {
    node.textContent = keyVisible ? key : maskKey(key);
    node.dataset.copyValue = key;
  }
  const eye = $('#toggle-key');
  if (eye) {
    // The eye carries state through its drawing (closed lid vs. struck-through),
    // not through text — the shape is the label.
    eye.classList.toggle('revealed', keyVisible);
    eye.title = keyVisible ? '隐藏 Key' : '显示 Key';
    eye.setAttribute('aria-label', eye.title);
    eye.setAttribute('aria-pressed', keyVisible ? 'true' : 'false');
  }
}

// ---- state ----
const state = {
  settings: {},
  models: [],
  // Last listing outcome from /api/models: which lanes answered, and why not.
  refresh: null,
  // The console re-reads settings every 2 seconds; while this is true the proxy
  // controls hold unsaved user edits and the poll must not overwrite them.
  pxDirty: false,
  testResults: new Map(),
  testing: new Map(),
  testAllRunning: false,
  // Sort key + direction for the model table: 'id' | 'lane' | 'status'.
  sort: { key: 'id', dir: 'asc' },
};

// ---- copy buttons ----
/**
 * The text a copy button should put on the clipboard.
 *
 * The key fields render masked text when hidden (`ofm-xB••••…99sU`), so reading
 * `textContent` would copy the mask. Sensitive fields therefore resolve through
 * a data attribute holding the real value, independent of what is displayed.
 */
function copySource(button) {
  const selector = button.dataset.copy;
  const target = document.querySelector(selector);
  if (!target) return '';
  if (target.dataset.copyValue !== undefined) return target.dataset.copyValue;
  return target.textContent;
}

document.querySelectorAll('.copy').forEach(button => {
  button.addEventListener('click', async () => {
    const ok = await copyText(copySource(button));
    button.textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { button.textContent = '复制'; }, 1200);
  });
});
$('#toggle-key').addEventListener('click', () => { keyVisible = !keyVisible; renderKey(); });
$('#rd-close').addEventListener('click', () => { $('#request-detail').classList.add('hidden'); state.detailId = null; });
state.detailId = null;

// Copy buttons inside the inspector panes: the panes are rebuilt on every poll,
// so the handler lives on the container. Delegated on document so it survives
// the request-detail card being shown/hidden.
document.addEventListener('click', async event => {
  const button = event.target.closest('button[data-copy-view]')
  if (!button) return
  const view = document.getElementById(button.dataset.copyView)
  if (!view) return
  const pre = view.querySelector('pre')
  const text = pre ? pre.textContent : view.textContent
  const ok = await copyText(text)
  button.textContent = ok ? '✓' : '✕'
  setTimeout(() => { button.textContent = '⧉' }, 1200)
})

// ---- copy helpers ----
/** Copy via the async clipboard API, falling back to a hidden textarea. */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to the legacy path */ }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

// ---- models ----
async function loadSettings() {
  state.settings = await api('/api/settings');
  $('#qs-baseurl').textContent = state.settings.baseUrl;
  // Anthropic SDKs append `/v1/messages` themselves, so their base URL must not
  // carry the `/v1` segment the OpenAI-compatible one ends with.
  const anthropicBase = String(state.settings.baseUrl ?? '').replace(/\/v1\/?$/, '');
  $('#qs-baseurl-anthropic').textContent = anthropicBase;
  renderKey();
  renderProxy();
  renderInspector();
}

async function loadModels() {
  const doc = await api('/api/models');
  state.models = doc.models ?? [];
  state.refresh = doc.refresh ?? null;
  $('#models-count').textContent = `${state.models.length} 个模型`;
  renderRefreshNotice();
  renderSortHeaders();
  renderModelRows();
}

/**
 * Explain a short roster instead of showing an empty table.
 *
 * An empty list almost always means the listing could not be fetched — a
 * required proxy that is off or unreachable — and the user needs that sentence,
 * not a blank page and a silently saved switch.
 */
function renderRefreshNotice() {
  const notice = $('#models-notice');
  const refresh = state.refresh;
  const failed = [];
  if (refresh?.opencode === false) failed.push('opencode');
  if (refresh?.kilo === false) failed.push('kilo');
  if (failed.length === 0) {
    notice.classList.add('hidden');
    notice.textContent = '';
    return;
  }
  notice.classList.remove('hidden');
  const reason = refresh.error ?? '未知原因';
  notice.textContent = state.models.length === 0
    ? `模型列表拉取失败（${failed.join(' 与 ')}）：${reason}。若本机需要代理才能访问上游，请在下方“代理”中配置后再保存。`
    : `${failed.join(' 与 ')} 列表拉取失败，当前显示的是上一次成功拉取的模型：${reason}。若本机需要代理才能访问上游，请在下方“代理”中检查配置。`;
}

/** Render the model table from in-memory state only — no network.
 * Used after every test result so rows update without re-fetching the roster. */
function renderModelRows() {
  const tbody = $('#models-table tbody');
  tbody.innerHTML = '';
  for (const model of sortedModels()) {
    const tr = document.createElement('tr');
    const probe = state.testResults.get(model.id) ?? model.probe ?? null;
    const running = state.testing.get(model.id) || model.probe?.state === 'checking';
    tr.innerHTML = `
      <td class="model-id"><code>${esc(model.id)}</code><button class="icon-btn" data-copy-id="${esc(model.id)}" title="复制模型 id" aria-label="复制模型 id">⧉</button></td>
      <td class="lane-${model.lane}">${esc(model.lane)}</td>
      <td class="col-status">${statusBadge(probe)}</td>
      <td class="col-toolbar"><button class="row-retest" data-test="${esc(model.id)}"${running ? ' disabled' : ''} title="重新测试这个模型" aria-label="重新测试这个模型">${running ? '…' : 'RETEST'}</button></td>`;
    tbody.appendChild(tr);
  }
}

/**
 * The status cell: the model's real usability, taken from its last probe.
 *
 * `checking` is a probe in flight; no probe at all means the startup sweep has
 * not reached this model yet. A failure keeps its classified code visible so
 * the cause needs no extra click.
 */
function statusBadge(probe) {
  if (!probe) return '<span class="badge" title="尚未测试">待测试</span>';
  if (probe.state === 'checking') return '<span class="badge" title="正在测试…">测试中…</span>';
  if (probe.ok === true || probe.state === 'ok') {
    const ms = probe.ttftMs ?? probe.durationMs ?? '?';
    return `<span class="badge ok" title="首字 ${ms}ms">可用 · ${ms}ms</span>`;
  }
  const code = probe.error?.code ?? probe.code ?? 'ERROR';
  const message = probe.error?.message ?? probe.message ?? '';
  return `<span class="badge err" title="${esc(message)}">不可用 · ${esc(code)}</span>`;
}

/**
 * Sort ordering for the table.
 *
 * - `id` and `lane` sort as text.
 * - `status` sorts by usability first (usable, then in-flight, then failed, then
 *   untested) and by latency inside the usable band — that is the order users
 *   scan when picking a model.
 */
function sortedModels() {
  const { key, dir } = state.sort;
  const rank = probe => {
    if (!probe) return 3
    if (probe.state === 'checking') return 1
    if (probe.ok === true || probe.state === 'ok') return 0
    return 2
  }
  const compare = (a, b) => {
    if (key === 'status') {
      const pa = state.testResults.get(a.id) ?? a.probe ?? null
      const pb = state.testResults.get(b.id) ?? b.probe ?? null
      const byRank = rank(pa) - rank(pb)
      if (byRank !== 0) return byRank
      const la = pa?.ttftMs ?? pa?.durationMs ?? Number.POSITIVE_INFINITY
      const lb = pb?.ttftMs ?? pb?.durationMs ?? Number.POSITIVE_INFINITY
      if (la !== lb) return la - lb
      return a.id.localeCompare(b.id)
    }
    const av = String(a[key] ?? '')
    const bv = String(b[key] ?? '')
    const byValue = av.localeCompare(bv)
    return byValue !== 0 ? byValue : a.id.localeCompare(b.id)
  }
  const models = [...state.models].sort(compare)
  // Reversing the whole list would put the slowest usable model first; reverse
  // only the primary comparison for the status band.
  if (dir === 'desc') models.reverse()
  return models
}

/** Reflect the active sort in the header (arrow + aria-sort). */
function renderSortHeaders() {
  for (const th of document.querySelectorAll('#models-table th.sortable')) {
    const active = th.dataset.sort === state.sort.key
    const mark = th.querySelector('.sort-mark')
    if (mark) mark.textContent = active ? (state.sort.dir === 'asc' ? ' ▲' : ' ▼') : ''
    th.classList.toggle('sorted', active)
    th.setAttribute('aria-sort', active ? (state.sort.dir === 'asc' ? 'ascending' : 'descending') : 'none')
  }
}

// Clicking a header cycles: ascending -> descending -> back to ascending on the
// next column. Only the three data columns are sortable.
for (const th of document.querySelectorAll('#models-table th.sortable')) {
  th.addEventListener('click', () => {
    const key = th.dataset.sort
    if (state.sort.key === key) {
      state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc'
    } else {
      state.sort = { key, dir: 'asc' }
    }
    renderSortHeaders()
    renderModelRows()
  })
}
// Row interactions live on the container: the table is re-rendered on every
// poll, so per-row listeners would be re-bound (and lost mid-flight) constantly.
$('#models-table tbody').addEventListener('click', async event => {
  const copyButton = event.target.closest('button[data-copy-id]')
  if (copyButton) {
    event.stopPropagation()
    const ok = await copyText(copyButton.dataset.copyId)
    copyButton.textContent = ok ? '✓' : '✕'
    setTimeout(() => { copyButton.textContent = '⧉' }, 1200)
    return
  }
  const testButton = event.target.closest('button[data-test]')
  if (testButton) runTest(testButton.dataset.test)
})

/** One model test, shared by the row icon and the toolbar sweep. */
async function runTest(modelId) {
  if (state.testing.get(modelId)) return
  state.testing.set(modelId, true)
  renderModelRows()
  try {
    const result = await api('/api/models/test', { method: 'POST', body: JSON.stringify({ model: modelId }) })
    state.testResults.set(modelId, result)
    $('#test-result-card').classList.remove('hidden')
    $('#test-model-name').textContent = modelId
    $('#test-result').textContent = JSON.stringify(result, null, 2)
  } catch (error) {
    state.testResults.set(modelId, { ok: false, model: modelId, error: { code: 'CLIENT', message: String(error?.message ?? error) } })
  } finally {
    state.testing.delete(modelId)
    await loadModels().catch(() => renderModelRows())
  }
}

/**
 * Ask the server to sweep every model, then follow progress by polling.
 *
 * The sweep runs server-side (this call returns 202 immediately), so closing
 * the tab does not cancel it. Progress is read from each model's probe state,
 * not from a client-side counter — that keeps the console honest when several
 * tabs (or a startup sweep) are watching the same run.
 */
async function testAll() {
  if (state.testAllRunning) return
  state.testAllRunning = true
  const button = $('#test-all')
  const progress = $('#test-all-progress')
  button.disabled = true
  button.textContent = '测试中…'
  progress.textContent = '正在测试全部模型…'
  try {
    await api('/api/models/test-all', { method: 'POST', body: JSON.stringify({}) })
    for (let i = 0; i < 900; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 2000))
      const doc = await api('/api/models')
      state.models = doc.models ?? []
      renderModelRows()
      const total = state.models.length
      const pending = state.models.filter(m => m.probe?.state === 'checking').length
      const failed = state.models.filter(m => m.probe?.state === 'error').length
      progress.textContent = pending > 0
        ? `${total - pending} / ${total}${failed > 0 ? ` · ${failed} 失败` : ''}`
        : `${total} 个模型：${total - failed} 可用${failed > 0 ? `，${failed} 失败` : ''}`
      if (pending === 0) break
    }
  } finally {
    state.testAllRunning = false
    button.disabled = false
    button.textContent = 'TEST ALL'
    setTimeout(() => { if (!state.testAllRunning) progress.textContent = '' }, 20000)
  }
}
$('#test-all').addEventListener('click', testAll)

// ---- requests (developer option) ----
async function loadRequests() {
  if (!state.settings.inspectorEnabled) return;
  const doc = await api('/api/requests');
  const requests = doc.requests ?? [];
  $('#requests-count').textContent = `${requests.length} 条`;
  const tbody = $('#requests-table tbody');
  tbody.innerHTML = '';
  for (const request of requests) {
    const tr = document.createElement('tr');
    tr.className = 'clickable';
    const chips = [];
    if (request.source === 'test') chips.push('<span class="chip">test</span>');
    if (request.transform?.injected?.length) chips.push(`<span class="chip">inject:${request.transform.injected.join('+')}</span>`);
    if (request.transform?.renamed?.length) chips.push(`<span class="chip">alias:${request.transform.renamed.join(',')}</span>`);
    if (request.response?.suppressed) chips.push(`<span class="chip">suppress:${request.response.suppressed}</span>`);
    if (request.response?.toolCalls) chips.push(`<span class="chip">tools:${request.response.toolCalls}</span>`);
    if (request.error) chips.push(`<span class="chip err">${esc(request.error.code)}</span>`);
    tr.innerHTML = `
      <td class="muted">${request.id}</td>
      <td>${fmtTime(request.startedAt)}</td>
      <td><code>${esc(request.model)}</code></td>
      <td class="lane-${request.lane}">${esc(request.lane)}</td>
      <td><span class="badge ${request.status === 'ok' ? 'ok' : 'err'}">${esc(request.status)}</span></td>
      <td class="muted">${request.durationMs ?? '—'}ms</td>
      <td class="muted">${request.response?.ttftMs != null ? request.response.ttftMs + 'ms' : '—'}</td>
      <td>${chips.join('') || '<span class="muted">—</span>'}</td>`;
    tr.addEventListener('click', () => showRequest(request.id));
    tbody.appendChild(tr);
  }
  if (state.detailId) await showRequest(state.detailId);
}

function jsonView(el, value) {
  el.innerHTML = '';
  const pre = document.createElement('pre');
  pre.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  el.appendChild(pre);
}

async function showRequest(id) {
  const record = await api(`/api/requests/${id}`);
  if (!record || !record.id) return;
  state.detailId = id;
  $('#request-detail').classList.remove('hidden');
  $('#rd-id').textContent = id;

  jsonView($('#rd-native'), record.native);

  const upstream = record.upstream ?? {};
  const upstreamBox = {};
  if (upstream.url) upstreamBox.url = upstream.url;
  if (upstream.sessionReused !== undefined) upstreamBox.sessionReused = upstream.sessionReused;
  if (upstream.headers) upstreamBox.headers = upstream.headers;
  if (upstream.body) upstreamBox.body = upstream.body;
  jsonView($('#rd-upstream'), upstreamBox);

  const transform = record.transform ?? {};
  const notes = [];
  for (const injected of transform.injected ?? []) notes.push(`<span class="transform-note inject">+ injected fingerprint tool: ${esc(injected)}</span>`);
  for (const renamed of transform.renamed ?? []) notes.push(`<span class="transform-note alias">renamed: ${esc(renamed)} → ${esc(renamed)}_client</span>`);
  if (transform.toolChoiceCleared) notes.push('<span class="transform-note">tool_choice none removed</span>');
  for (const note of transform.notes ?? []) notes.push(`<span class="transform-note">${esc(note)}</span>`);
  const aliases = transform.aliases ? Object.entries(transform.aliases).map(([sent, original]) => `<span class="transform-note alias">${esc(original)} → ${esc(sent)}</span>`) : [];
  if (transform.route) {
    const via = transform.route.via === 'proxy' ? `经代理 ${transform.route.proxy}` : '直连';
    notes.unshift(`<span class="transform-note route">路由: ${esc(via)}</span>`);
  }
  $('#rd-transform').innerHTML = notes.concat(aliases).join('') || '<span class="muted">无转换</span>';

  const response = record.response
    ? { ...record.response, error: record.error ?? undefined }
    : { status: record.status, error: record.error };
  jsonView($('#rd-response'), response);
}

// ---- inspector toggle (developer option) ----
function renderInspector() {
  const enabled = state.settings.inspectorEnabled === true;
  $('#insp-enabled').checked = enabled;
  $('#insp-body').classList.toggle('hidden', !enabled);
  if (!enabled) {
    $('#requests-count').textContent = '';
    $('#requests-table tbody').innerHTML = '';
    $('#request-detail').classList.add('hidden');
    state.detailId = null;
  }
}

$('#insp-enabled').addEventListener('change', async () => {
  const enabled = $('#insp-enabled').checked;
  await api('/api/settings/inspector', { method: 'POST', body: JSON.stringify({ enabled }) });
  state.settings.inspectorEnabled = enabled;
  renderInspector();
  if (enabled) await loadRequests();
});

// ---- proxy ----
function routeLabel(side) {
  if (!side) return '—';
  if (side.via === 'direct') return side.reason === 'noProxy' ? '直连 (noProxy)' : '直连';
  return `代理 ${side.proxy}`;
}

function renderProxy() {
  const proxy = state.settings.proxy ?? { enabled: false, url: '' };

  // The console polls settings every 2 seconds. That poll reports the *saved*
  // configuration, so writing it into the controls would undo whatever the user
  // is in the middle of doing — flip the switch and it snaps back before there
  // is any chance to type an address. While the form has unsaved edits, the
  // controls belong to the user; the routes line below still reports reality.
  if (!state.pxDirty) {
    $('#px-enabled').checked = proxy.enabled === true;
    if (document.activeElement !== $('#px-url')) $('#px-url').value = proxy.url ?? '';
  }
  // The address fields exist as an option while the switch is on.
  $('#px-body').classList.toggle('hidden', $('#px-enabled').checked !== true);

  const routes = state.settings.routes ?? {};
  $('#px-routes').textContent = `当前路由 — opencode: ${routeLabel(routes.opencode)} · kilo: ${routeLabel(routes.kilo)}`;
}

async function applyProxy(enabled) {
  const payload = { enabled, url: $('#px-url').value.trim() };
  const result = await api('/api/settings/proxy', { method: 'POST', body: JSON.stringify(payload) });
  const box = $('#px-result');
  box.classList.remove('hidden');
  if (result.error) {
    box.textContent = `保存失败：${result.error.message ?? JSON.stringify(result.error)}`;
    return false;
  }

  // The server has spoken: from here the saved state is authoritative again.
  state.pxDirty = false;

  // The setting is saved either way, but a proxy that cannot reach the
  // upstreams leaves no model list — say so instead of showing a saved state
  // over an empty table.
  const listing = result.listing ?? {};
  const failed = []
  if (listing.opencode === false) failed.push('opencode')
  if (listing.kilo === false) failed.push('kilo')

  await loadSettings();
  await loadModels();

  if (!result.proxy?.enabled) {
    box.textContent = '已关闭代理（全部直连）';
    return true;
  }
  if (failed.length > 0) {
    box.classList.add('warn');
    box.textContent = `已保存，但 ${failed.join(' 与 ')} 列表拉取失败：${listing.error ?? '未知原因'}。开关保持开启，请检查地址或改用可用代理。`;
    return true;
  }
  box.classList.remove('warn');
  box.textContent = `已应用：${result.proxy.url}（${result.models ?? 0} 个模型）`;
  return true;
}

/** The switch is the whole control: on saves the address, off falls back to direct. */
$('#px-enabled').addEventListener('change', async () => {
  const enabled = $('#px-enabled').checked;
  // Edited but not saved yet: keep the poll from reverting it.
  state.pxDirty = true;
  if (enabled && $('#px-url').value.trim() === '') {
    // Nothing to connect through yet: reveal the form and wait for an address.
    $('#px-body').classList.remove('hidden');
    $('#px-url').focus();
    return;
  }
  await applyProxy(enabled);
});

$('#px-url').addEventListener('input', () => { state.pxDirty = true; });

$('#px-save').addEventListener('click', async () => {
  if ($('#px-url').value.trim() === '') {
    $('#px-result').classList.remove('hidden');
    $('#px-result').textContent = '请先填写代理地址';
    return;
  }
  state.pxDirty = true;
  await applyProxy(true);
});

$('#px-test').addEventListener('click', async () => {
  const box = $('#px-result');
  box.classList.remove('hidden');
  box.textContent = '测试中…';
  const result = await api('/api/settings/proxy', {
    method: 'POST',
    body: JSON.stringify({ test: { url: $('#px-url').value.trim() } }),
  });
  box.textContent = JSON.stringify(result, null, 2);
});

// ---- polling ----
async function tick() {
  try {
    const health = await fetch('/health').then(r => r.json());
    $('#conn-badge').textContent = health.ok ? 'online' : 'offline';
    $('#conn-badge').className = `badge ${health.ok ? 'online' : 'offline'}`;
    if (!health.ok) return;
    await loadModels();
    await loadSettings();
    if (state.settings.inspectorEnabled && $('#auto-refresh').checked) await loadRequests();
  } catch {
    $('#conn-badge').textContent = 'offline';
    $('#conn-badge').className = 'badge offline';
  }
}

(async function init() {
  if (getKey() === '') {
    const input = prompt('输入本地 Key（控制台启动时打印，或高级配置查看）:');
    if (input !== null && input.trim() !== '') sessionStorage.setItem('ofm-key', input.trim());
  }
  await tick();
  setInterval(tick, 2000);
})();


