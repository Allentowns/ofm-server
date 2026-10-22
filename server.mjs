/**
 * ofm-server: a local OpenAI-compatible endpoint over the OpenCode / Kilo
 * free model lanes, with a request-inspection web console.
 *
 * Routes:
 *   GET  /health                      alive probe (no auth, no detail)
 *   GET  /v1/models                   merged catalog (auth)
 *   POST /v1/chat/completions         OpenAI Chat Completions (auth)
 *   POST /v1/messages                 Anthropic Messages, stream + not (auth)
 *   POST /v1/messages/count_tokens    local token estimate (auth)
 *   GET  /api/models                  catalog + metadata (auth)
 *   POST /api/models/test             one real minimal turn (auth)
 *   GET  /api/requests                inspection list (auth)
 *   GET  /api/requests/:id            one full inspection record (auth)
 *   GET  /api/settings                key + settings (auth)
 *   POST /api/settings/inspector      toggle the request inspector (auth)
 *   POST /api/settings/proxy          proxy configuration (auth)
 *   GET  /*                           static web console (public; the
 *                                     console itself prompts for the key)
 *
 * @module server.mjs
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Auth } from './lib/auth.js'
import { Catalog, KILO_PREFIX } from './lib/catalog.js'
import { handleAnthropicMessages, handleChatCompletion, handleCountTokens, laneOf } from './lib/chat.js'
import { probeAll, probeModel } from './lib/probe.js'
import { Inspector } from './lib/inspector.js'
import { SessionStore } from './lib/sessions.js'
import { Transport, normalizeProxy } from './lib/transport.js'
import { createAssets } from './lib/assets.js'
import { postTurn as postOpencodeTurn } from './lib/lane-opencode.js'
import { postTurn as postKiloTurn } from './lib/lane-kilo.js'
import { applyRequestTransform, createAccumulator, createToolWire } from './lib/transform.js'
import { applyFingerprint, declaredToolNames } from './lib/fingerprint.js'
import { seedForRequest } from './lib/sessions.js'

/**
 * Where this program lives on disk.
 *
 * ESM source mode resolves `import.meta.url`. A SEA build bundles everything to
 * CommonJS, where `import.meta` is empty and `__dirname` is already the
 * executable's directory — so both spellings are handled.
 */
function resolveHere() {
  try {
    const url = import.meta?.url
    if (typeof url === 'string' && url !== '') return path.dirname(fileURLToPath(url))
  } catch { /* CJS bundle: import.meta is empty */ }
  if (typeof __dirname === 'string' && __dirname !== '') return __dirname
  return process.cwd()
}

const __here = resolveHere()

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const hasFlag = name => args.includes(name)

/*
 * Where state lives.
 *
 * Source mode keeps it beside the code. A packaged executable sits wherever the
 * user put it — often a read-only location — so `--data-dir` / `OF_DATA_DIR`
 * allow an override, while the default stays "next to the executable" because
 * that is what a portable build should do.
 */
const DATA_DIR = path.resolve(
  argOf('--data-dir', process.env.OF_DATA_DIR ?? path.join(__here, 'data')),
)
const PUBLIC_DIR = path.join(__here, 'public')

const PORT = Number(argOf('--port', process.env.OF_PORT ?? 18900))
const HOST = hasFlag('--lan') ? '0.0.0.0' : '127.0.0.1'
const REFRESH_MINUTES = Number(argOf('--refresh-minutes', 15))
const INSPECTOR_LIMIT = Number(argOf('--inspector-limit', 50))

/**
 * Version string. Kept as a literal so a packaged build needs no file read;
 * `npm run version:check` (test) asserts it matches package.json.
 */
const PACKAGE_VERSION = '0.1.0'
const log = (...parts) => console.log(new Date().toISOString(), ...parts)

if (hasFlag('--version') || hasFlag('-v')) {
  console.log(PACKAGE_VERSION)
  process.exit(0)
}
if (hasFlag('--help') || hasFlag('-h')) {
  console.log(`ofm-server ${PACKAGE_VERSION}

Usage: ofm-server [options]

  --port <n>            listen port (default 18900, or OF_PORT)
  --lan                 bind 0.0.0.0 instead of 127.0.0.1
  --data-dir <path>     where settings.json / sessions.json live
  --inspector           force the request inspector on for this run
  --no-probe            skip the startup availability sweep
  --refresh-minutes <n> catalog refresh interval (default 15)
  --version, -v         print the version
  --help, -h            print this message`)
  process.exit(0)
}

fs.mkdirSync(DATA_DIR, { recursive: true })

const auth = new Auth(path.join(DATA_DIR, 'settings.json'), { log })
const sessions = new SessionStore(path.join(DATA_DIR, 'sessions.json'), { log })
// The inspector is a developer option: off unless the user turns it on. Its
// state persists in settings.json; --inspector forces it on for a session.
const inspector = new Inspector({ enabled: hasFlag('--inspector') || readStoredInspector(), limit: INSPECTOR_LIMIT })
const transport = new Transport({ proxy: readStoredProxy() })
const catalog = new Catalog({ transport, refreshMinutes: REFRESH_MINUTES, log })

const assets = createAssets(PUBLIC_DIR)
if (!assets.has('index.html')) {
  log('fatal: console assets missing — expected public/index.html beside the server, or assets embedded in a packaged build')
  process.exit(1)
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

/** The proxy block from settings.json, guarded so a broken edit cannot block startup. */
function readStoredProxy() {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
    return parsed?.proxy ?? { enabled: false, url: '' }
  } catch {
    return { enabled: false, url: '' }
  }
}

/**
 * Whether the inspector starts enabled.
 *
 * Off unless the user turned it on — and the console's own toggle is the only
 * writer of that flag. `OF_INSPECTOR=1` / `--inspector` force it on for one run.
 */
function readStoredInspector() {
  if (process.env.OF_INSPECTOR === '1') return true
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'settings.json'), 'utf8'))
    return parsed?.inspector?.enabled === true
  } catch {
    return false
  }
}

/** Persist one settings.json block without touching the fields others own. */
function writeSettingsBlock(patch) {
  const file = path.join(DATA_DIR, 'settings.json')
  let parsed = {}
  try { parsed = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { /* first write */ }
  Object.assign(parsed, patch)
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(parsed, undefined, 2), { mode: 0o600 })
}

function writeStoredProxy(proxy) {
  writeSettingsBlock({ proxy })
}

function sendError(res, status, message, code = 'invalid_request_error') {
  sendJson(res, status, { error: { message, code } })
}

async function readBody(req, limitBytes = 8 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limitBytes) throw new Error('request body too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { throw new Error('request body is not valid JSON') }
}

let refreshInFlight = null
/** Millisecond delay before another listing attempt after a failure. */
let refreshBackoffMs = 0
/** Earliest time the next automatic listing attempt may run. */
let nextRefreshAt = 0

/**
 * Make sure the roster has been fetched at least once.
 *
 * The gate is "has a refresh ever succeeded", not "are there models in memory".
 * A roster restored from an earlier process, or left over from a direct
 * connection before the user configured the proxy they actually need, would
 * otherwise be served forever without ever retrying the listing.
 *
 * Retrying a listing that cannot succeed must not be free: the console polls
 * `/api/models` every two seconds, so an unconditional retry turns one broken
 * proxy into an endless stream of failed connections and log lines. After a
 * failure the next attempt waits, doubling up to a minute; a successful refresh
 * resets the clock, and saving a new proxy clears it so the user's own action is
 * never delayed by a backoff they did not cause.
 */
async function ensureCatalog() {
  if (catalog.lastResult?.error === undefined && catalog.lastRefreshAt > 0 && catalog.list().length > 0) {
    return catalog.lastResult
  }
  if (refreshInFlight) return refreshInFlight
  if (nextRefreshAt - Date.now() > 0) return catalog.lastResult

  refreshInFlight = catalog.refresh()
    .then(result => {
      if (result.opencode && result.kilo) {
        refreshBackoffMs = 0
        nextRefreshAt = 0
      } else {
        refreshBackoffMs = refreshBackoffMs === 0 ? 5000 : Math.min(refreshBackoffMs * 2, 60000)
        nextRefreshAt = Date.now() + refreshBackoffMs
      }
      return result
    })
    .finally(() => { refreshInFlight = null })
  return refreshInFlight
}

/** Cleared when the proxy changes, so a user-initiated retry runs immediately. */
function resetRefreshBackoff() {
  refreshBackoffMs = 0
  nextRefreshAt = 0
}

/** Probe dependencies, shared by the startup sweep and the console buttons. */
function probeDeps() {
  return { catalog, sessions, transport, inspector }
}

/** One model probe, for the console's per-row icon button. */
async function testModel({ model, prompt, effort }) {
  return probeModel({ model, prompt, effort, source: 'test', deps: probeDeps() })
}

/** Every model in the catalog, used at startup and by the toolbar button. */
let probeAllInFlight = null
async function sweepAll({ source = 'startup' } = {}) {
  if (probeAllInFlight) return probeAllInFlight
  probeAllInFlight = probeAll({ deps: probeDeps(), source })
    .finally(() => { probeAllInFlight = null })
  return probeAllInFlight
}
/** Reachability probe for a candidate proxy, run without saving it. */
async function probeProxy(candidate) {
  let normalized
  try {
    normalized = normalizeProxy({ ...candidate, enabled: true })
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
  const probe = new Transport({ proxy: normalized })
  const startedAt = Date.now()
  const checks = []
  for (const [lane, url] of [
    ['opencode', 'https://opencode.ai/inference/v1/models'],
    ['kilo', 'https://api.kilo.ai/api/gateway/models'],
  ]) {
    const at = Date.now()
    try {
      const response = await probe.request({
        url,
        headers: { accept: 'application/json', 'user-agent': 'opencode/latest/2.0.26/cli', authorization: 'Bearer public' },
        timeoutMs: 20000,
      })
      checks.push({ lane, ok: response.ok, status: response.status, durationMs: Date.now() - at })
    } catch (error) {
      checks.push({ lane, ok: false, code: error?.code ?? 'TRANSPORT', error: String(error?.message ?? error).slice(0, 300), durationMs: Date.now() - at })
    }
  }
  return { ok: checks.every(check => check.ok), proxy: normalized, durationMs: Date.now() - startedAt, checks }
}

const server = http.createServer(async (req, res) => {
  let pathname = '/'
  try {
    pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
  } catch { /* keep '/' */ }
  pathname = pathname.replace(/\/+$/, '') || '/'

  try {
    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
      return
    }

    // The console's own files are public: they contain no secret, and the
    // browser cannot send a bearer token when loading a page. Every API and
    // /v1 route below still requires the key.
    if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) {
      const name = pathname === '/' ? 'index.html' : pathname.slice(1)
      if (assets.has(name)) {
        const bytes = assets.read(name)
        if (bytes !== null) {
          res.writeHead(200, { 'content-type': assets.contentType(name), 'content-length': bytes.byteLength })
          res.end(bytes)
          return
        }
      }
    }

    // Everything from here requires the local key.
    if (!auth.matches(Auth.bearerOf(req))) {
      res.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      res.end(JSON.stringify({ error: { message: 'missing or invalid local key (Authorization: Bearer <key from the console>)', code: 'unauthorized' } }))
      return
    }

    if (req.method === 'GET' && pathname === '/v1/models') {
      await ensureCatalog()
      const now = Math.floor(Date.now() / 1000)
      sendJson(res, 200, {
        object: 'list',
        data: catalog.list().map(entry => ({
          id: entry.id,
          object: 'model',
          created: now,
          owned_by: `ofm-server:${entry.lane}`,
        })),
      })
      return
    }

    if (req.method === 'POST' && pathname === '/v1/chat/completions') {
      let body
      try { body = await readBody(req) } catch (error) {
        sendError(res, 400, error.message)
        return
      }
      await ensureCatalog()
      await handleChatCompletion({ req, res, body, catalog, sessions, inspector, transport })
      return
    }

    if (req.method === 'POST' && (pathname === '/v1/messages' || pathname === '/messages')) {
      let body
      try { body = await readBody(req) } catch (error) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: error.message } }))
        return
      }
      await ensureCatalog()
      await handleAnthropicMessages({ req, res, body, catalog, sessions, inspector, transport })
      return
    }

    if (req.method === 'POST' && (pathname === '/v1/messages/count_tokens' || pathname === '/messages/count_tokens')) {
      const body = await readBody(req).catch(() => ({}))
      handleCountTokens({ res, body })
      return
    }

    // ---- console API ---------------------------------------------------------
    if (req.method === 'GET' && pathname === '/api/models') {
      const result = await ensureCatalog()
      sendJson(res, 200, {
        models: catalog.list(),
        lastRefreshAt: catalog.lastRefreshAt,
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        routes: catalog.routes(),
        // An empty or partial roster is a fact the console must be able to
        // explain: usually a proxy that is required but not configured yet.
        refresh: result ?? { opencode: null, kilo: null, error: null },
      })
      return
    }

    if (req.method === 'POST' && pathname === '/api/models/test') {
      const body = await readBody(req).catch(() => ({}))
      if (typeof body?.model !== 'string' || body.model === '') {
        sendError(res, 400, '`model` is required')
        return
      }
      const result = await testModel({ model: body.model, prompt: body.prompt, effort: body.effort })
      sendJson(res, 200, result)
      return
    }

    if (req.method === 'POST' && pathname === '/api/models/test-all') {
      const body = await readBody(req).catch(() => ({}))
      const concurrency = Number.isFinite(body?.concurrency) ? Math.min(6, Math.max(1, body.concurrency)) : 3
      // Fire and forget: the console polls /api/models for progress, so this
      // request must not stay open for the length of a 28-model sweep.
      sweepAll({ source: 'test' }).catch(error => log(`test-all failed: ${error?.message ?? error}`))
      sendJson(res, 202, { started: true, concurrency })
      return
    }

    if (req.method === 'GET' && pathname === '/api/requests') {
      sendJson(res, 200, { requests: inspector.list() })
      return
    }
    const requestMatch = pathname.match(/^\/api\/requests\/(\d+)$/)
    if (req.method === 'GET' && requestMatch) {
      const record = inspector.get(requestMatch[1])
      if (record === null) { sendError(res, 404, 'no such record'); return }
      sendJson(res, 200, record)
      return
    }

    if (req.method === 'GET' && pathname === '/api/settings') {
      sendJson(res, 200, {
        port: PORT,
        host: HOST,
        localKey: auth.key,
        baseUrl: `http://127.0.0.1:${PORT}/v1`,
        inspectorEnabled: inspector.enabled,
        inspectorLimit: inspector.limit,
        sessionCount: sessions.size,
        refreshMinutes: REFRESH_MINUTES,
        proxy: transport.proxy,
        routes: catalog.routes(),
      })
      return
    }
    if (req.method === 'POST' && pathname === '/api/settings/proxy') {
      const body = await readBody(req).catch(() => ({}))
      if (typeof body?.test === 'object' && body.test !== null) {
        // Dry run against a candidate proxy without persisting it.
        const result = await probeProxy(body.test)
        sendJson(res, 200, result)
        return
      }
      let normalized
      try {
        normalized = normalizeProxy(body)
      } catch (error) {
        sendError(res, 400, String(error?.message ?? error))
        return
      }
      transport.configure(normalized)
      writeStoredProxy(normalized)
      log(`proxy ${normalized.enabled ? `enabled: ${normalized.url}` : 'disabled'}`)
      // Re-list through the new path and wait for it: the console's next move
      // depends on whether the setting actually works, not on whether the file
      // was written. A failure here is reported, not swallowed.
      resetRefreshBackoff()
      const listing = await catalog.refresh().catch(error => ({
        opencode: false, kilo: false, error: String(error?.message ?? error),
      }))
      log(`proxy re-list: opencode=${listing.opencode ? 'ok' : 'failed'} kilo=${listing.kilo ? 'ok' : 'failed'} models=${catalog.list().length}`)
      sendJson(res, 200, {
        proxy: transport.proxy,
        routes: catalog.routes(),
        listing: { opencode: listing.opencode, kilo: listing.kilo, error: listing.error ?? null },
        models: catalog.list().length,
      })
      return
    }
    if (req.method === 'POST' && pathname === '/api/settings/inspector') {
      const body = await readBody(req).catch(() => ({}))
      const enabled = body?.enabled === true
      inspector.setEnabled(enabled)
      writeSettingsBlock({ inspector: { enabled } })
      log(`inspector ${enabled ? 'enabled' : 'disabled (records cleared)'}`)
      sendJson(res, 200, { inspectorEnabled: inspector.enabled })
      return
    }
    // ---- static console fallback (anything the block above did not serve) ---
    if (req.method === 'GET' && !pathname.startsWith('/api/') && !pathname.startsWith('/v1/')) {
      sendError(res, 404, 'not found')
      return
    }

    sendError(res, 405, 'method not allowed')
  } catch (error) {
    if (!res.headersSent) sendError(res, 500, String(error?.message ?? error), 'internal_error')
    else res.end()
    log('request failed:', error?.stack ?? error)
  }
})

server.listen(PORT, HOST, () => {
  log(`ofm-server ${PACKAGE_VERSION} listening on http://${HOST}:${PORT}`)
  log(`  base URL : http://127.0.0.1:${PORT}/v1`)
  log(`  local key: ${auth.key}`)
  log(`  console  : http://127.0.0.1:${PORT}/`)
  log(`  data dir : ${DATA_DIR}`)
  log(`  assets   : ${assets.mode}`)
  if (HOST === '0.0.0.0') log('  ⚠️ bound to all interfaces (--lan): the key is the only gate; prefer a firewall rule')
  catalog.refresh().then(result => {
    log(`catalog refreshed: opencode=${result.opencode ? 'ok' : 'failed'} kilo=${result.kilo ? 'ok' : 'failed'} models=${catalog.list().length}`)
    catalog.startTimer()
    // One availability sweep at startup: the model page's status column is
    // meaningless until every model has actually answered (or refused) once.
    // Tests disable it (OF_TEST_MODE) so their fake upstream only sees the
    // requests the test itself makes.
    if (!hasFlag('--no-probe') && process.env.OF_TEST_MODE !== '1') {
      log('probing every model (status column fills in as results arrive)…')
      sweepAll({ source: 'startup' })
        .then(summary => log(`probe sweep done: ${summary.total - summary.failed}/${summary.total} usable`))
        .catch(error => log(`probe sweep failed: ${error?.message ?? error}`))
    }
  }).catch(() => {})
})

for (const signalName of ['SIGINT', 'SIGTERM']) {
  process.on(signalName, () => {
    catalog.stopTimer()
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1500).unref?.()
  })
}

// Exported for the offline test suite (it drives the real routes in-process).
export { auth, catalog, inspector, sessions, server }


