/**
 * Kilo lane: the OpenAI-compatible free pool at api.kilo.ai.
 *
 * Ported from dsh-our-free-model src/kilo.js. This gateway's free pool
 * (`isFree: true` entries) answers with no credential at all — no key, no
 * login, no fingerprint gate. The trade, stated on the gateway's own model
 * cards: free-pool prompts may be logged by the upstream provider and used to
 * improve its services.
 *
 * @module lib/lane-kilo.js
 */

import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, retryAfterMs, transportCause } from './errors.js'
import { readHead, readRemainder, readSse, replayStream, sniffBody } from './sse.js'

export const KILO_BASE = (process.env.OF_KILO_BASE ?? 'https://api.kilo.ai/api/gateway').replace(/\/+$/, '')
const LIST_TIMEOUT_MS = 15000
const TURN_TIMEOUT_MS = 300000

const LISTING_HEADERS = { accept: 'application/json', 'user-agent': 'ofm-server' }

export async function fetchListing({ transport, signal, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await transport.request({ url: `${KILO_BASE}/models`, headers: LISTING_HEADERS, signal: controller.signal })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    const rows = Array.isArray(payload?.data) ? payload.data : []
    return rows
      .filter(entry => entry?.isFree === true && typeof entry?.id === 'string' && entry.id !== '')
      .map(entry => ({ id: entry.id, contextWindow: Number.isFinite(entry?.context_length) ? entry.context_length : undefined }))
  } catch (error) {
    if (error instanceof UpstreamError) throw error
    if (callerAborted || signal?.aborted === true) throw new UpstreamError('request aborted', CODE.aborted)
    if (error?.name === 'AbortError') throw new UpstreamError('model listing timed out', CODE.timeout)
    throw new UpstreamError(`model listing failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onCallerAbort)
  }
}

/**
 * POST one turn and feed decoded SSE `data:` payloads to `onData`.
 * Same sniff-first discipline as the OpenCode lane; the gateway also emits
 * `: KILO PROCESSING` comment lines while scheduling, which readSse skips.
 */
export async function postTurn({ body, transport, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  let response
  try {
    response = await transport.request({
      url: `${KILO_BASE}/chat/completions`,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'user-agent': 'ofm-server' },
      body: JSON.stringify(body),
      signal,
      timeoutMs,
    })
  } catch (error) {
    if (signal?.aborted === true || error?.name === 'AbortError') throw new UpstreamError('request aborted', CODE.aborted)
    throw new UpstreamError(`upstream request failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
  }

  const setRetry = retryAfterMs(response.headers.get('retry-after'))
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    throw classifyFailure(response.status, payload, setRetry)
  }
  if (response.body === null) throw new UpstreamError('upstream returned no body', CODE.empty)

  const head = await readHead(response.body, 4096, { signal, timeoutMs })
  const shape = sniffBody(head.text)
  if (shape === 'empty') throw new UpstreamError('upstream returned no body', CODE.empty)
  if (shape === 'sse') {
    await readSse(replayStream(head), onData, signal, timeoutMs)
    return { status: response.status }
  }
  const text = head.done ? head.text : await readRemainder(head, signal)
  if (shape !== 'json') {
    throw new UpstreamError(`unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  let payload
  try { payload = JSON.parse(text) } catch {
    throw new UpstreamError(`unexpected non-SSE response: ${text.slice(0, 200)}`, CODE.server, { status: response.status })
  }
  if (payload.error) throw classifyFailure(response.status, payload, setRetry)
  onData(JSON.stringify(payload))
  return { status: response.status }
}

export { classifyStreamFailure }
