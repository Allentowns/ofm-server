/**
 * OpenCode free lane: listing + streaming turns.
 *
 * Ported from dsh-our-free-model src/upstream.js / src/http.js. The lane's
 * credential is the public constant `Bearer public`; the gate is client
 * fingerprinting, and every header here is load-bearing.
 *
 * @module lib/lane-opencode.js
 */

import { CODE, UpstreamError, classifyFailure, classifyStreamFailure, retryAfterMs, transportCause } from './errors.js'
import { CLIENT_UA, FINGERPRINT_TOOLS, FINGERPRINT_TOOL_DEFINITIONS, restoreToolName } from './fingerprint.js'
import { readHead, readRemainder, readSse, replayStream, sniffBody } from './sse.js'

export const OPENCODE_BASE = (process.env.OF_BASE ?? 'https://opencode.ai').replace(/\/+$/, '')
const LIST_TIMEOUT_MS = 15000
const TURN_TIMEOUT_MS = 300000

export function gatewayHeaders({ session, stream, accept }) {
  return {
    'content-type': 'application/json',
    'authorization': 'Bearer public',
    'user-agent': CLIENT_UA,
    'x-opencode-client': 'cli',
    'x-opencode-session': session,
    'x-opencode-session-id': session,
    'x-session-affinity': session,
    'x-session-id': session,
    'x-opencode-project': 'global',
    'accept': accept ?? (stream ? 'text/event-stream' : '*/*'),
  }
}

export async function fetchListing({ transport, signal, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  timer.unref?.()
  let callerAborted = false
  const onCallerAbort = () => { callerAborted = true; controller.abort() }
  signal?.addEventListener('abort', onCallerAbort, { once: true })
  try {
    const response = await transport.request({
      url: `${OPENCODE_BASE}/inference/v1/models`,
      headers: gatewayHeaders({ session: 'ses_00000000000000000000000000', stream: false, accept: 'application/json' }),
      signal: controller.signal,
    })
    const text = await response.text()
    let payload
    try { payload = JSON.parse(text) } catch { payload = { error: { message: text.slice(0, 300) || `HTTP ${response.status}` } } }
    if (!response.ok) throw classifyFailure(response.status, payload)
    const ids = Array.isArray(payload?.data) ? payload.data.map(entry => entry?.id).filter(id => typeof id === 'string' && id !== '') : []
    return [...new Set(ids)]
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
 * Body shape is sniffed before Content-Type is believed; head bytes replay.
 */
export async function postTurn({ body, session, transport, signal, onData, timeoutMs = TURN_TIMEOUT_MS }) {
  const headers = gatewayHeaders({ session, stream: true })
  let response
  try {
    response = await transport.request({
      url: `${OPENCODE_BASE}/inference/v1/chat/completions`,
      method: 'POST',
      headers,
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
    if (/^\s*<(!doctype|html[\s>])/i.test(text)) {
      throw new UpstreamError("the gateway's front proxy answered with an HTML error page — usually a WAF or body-size limit, not your credentials", CODE.client, { status: response.status })
    }
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

export { restoreToolName, FINGERPRINT_TOOLS, FINGERPRINT_TOOL_DEFINITIONS, classifyStreamFailure }
