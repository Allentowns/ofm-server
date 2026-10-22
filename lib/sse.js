/**
 * Wire hygiene for upstream responses.
 *
 * Ported from dsh-our-free-model src/http.js. The central rule: the 2xx body's
 * shape is decided by its first bytes, never by Content-Type — the gateway
 * answers 200 with `application/json` while carrying a full SSE frame sequence
 * under load. Sniffed bytes are replayed in front of the reader so nothing is
 * buffered or dropped.
 *
 * @module lib/sse.js
 */

import { CODE, UpstreamError, classifyStreamFailure } from './errors.js'

const SNIFF_BYTES = 4096

/** Classify the beginning of a response body by shape. */
export function sniffBody(text) {
  const head = String(text ?? '').replace(/^\uFEFF/, '').trimStart()
  if (head === '') return 'empty'
  if (head.startsWith(':') || /^(?:data|event|id|retry)[ \t]*:/m.test(head.slice(0, 64))) return 'sse'
  if (head.startsWith('{') || head.startsWith('[')) return 'json'
  return 'unknown'
}

/**
 * Read the first `limit` bytes without losing the rest. Stops as soon as the
 * head says "sse": a short answer over an open connection would otherwise sit
 * here until the deadline, and cancelling would discard a complete turn.
 */
export async function readHead(stream, limit, { signal, timeoutMs }) {
  const reader = stream.getReader()
  const chunks = []
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let done = false
  try {
    while (size < limit) {
      const row = await headRead(reader, signal, Date.now() + timeoutMs)
      if (row.done) { done = true; break }
      if (row.value === undefined) continue
      chunks.push(row.value)
      size += row.value.byteLength ?? 0
      text += decoder.decode(row.value, { stream: true })
      if (sniffBody(text) === 'sse') break
    }
  } catch (error) {
    await reader.cancel().catch(() => {})
    try { reader.releaseLock?.() } catch { /* mid-teardown */ }
    throw classifyStreamFailure(error, signal)
  }
  return { reader, chunks, done, text, decoder }
}

/** One bounded read off the body before any watchdog exists. */
async function headRead(reader, signal, deadline) {
  if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
  let timer
  let onAbort
  const pending = reader.read()
  const halted = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new UpstreamError('upstream sent no bytes before its deadline', CODE.timeout)),
      Math.max(0, deadline - Date.now()))
    timer.unref?.()
    onAbort = () => {
      void reader.cancel().catch(() => {})
      reject(new UpstreamError('request aborted', CODE.aborted))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([pending, halted])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    pending.catch(() => {})
  }
}

/** Turn an already-read head plus its live reader back into one byte stream. */
export function replayStream(head) {
  async function* generate() {
    for (const chunk of head.chunks) yield chunk
    if (head.done) return
    while (true) {
      const row = await head.reader.read()
      if (row.done) break
      if (row.value !== undefined) yield row.value
    }
  }
  return generate()
}

export async function readRemainder(head, signal) {
  let text = head.text
  try {
    while (!head.done) {
      const row = await head.reader.read()
      if (row.done) { head.done = true; break }
      if (row.value !== undefined) {
        text += head.decoder.decode(row.value, { stream: true })
        if (text.length > 32 * 1024 * 1024) throw new UpstreamError('upstream body exceeded the 32 MB read cap', CODE.server)
      }
    }
  } catch (error) {
    await head.reader.cancel().catch(() => {})
    throw classifyStreamFailure(error, signal)
  }
  return text + head.decoder.decode()
}

/**
 * Split an SSE byte stream into `data:` payload strings; comment lines and
 * blank separators are skipped. Accepts a ReadableStream or an async iterable
 * of byte chunks (which is how a sniffed head replays).
 *
 * Also folds bare-JSON error objects that appear inside the stream
 * (`payload.error` / `{type:'error'}`) into classified UpstreamErrors.
 */
export async function readSse(source, onData, signal, timeoutMs = 300000) {
  const reader = typeof source?.getReader === 'function' ? source.getReader() : null
  const iterator = reader === null && typeof source?.[Symbol.asyncIterator] === 'function' ? source[Symbol.asyncIterator]() : null
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  let rawJson = ''
  let deadline = Date.now() + timeoutMs
  let stopped = false
  const stop = () => {
    if (stopped) return
    stopped = true
    try {
      const pending = reader !== null ? reader.cancel() : iterator?.cancel?.()
      void Promise.resolve(pending).catch(() => {})
    } catch { /* already closed */ }
  }
  const next = async () => {
    if (signal?.aborted) throw new UpstreamError('request aborted', CODE.aborted)
    let onAbort
    let timer
    const halted = new Promise((_, reject) => {
      onAbort = () => {
        stop()
        reject(new UpstreamError('request aborted', CODE.aborted))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      timer = setTimeout(() => {
        stop()
        reject(new UpstreamError('upstream stream idle past its deadline', CODE.timeout))
      }, Math.max(0, deadline - Date.now()))
    })
    const pending = Promise.resolve().then(() => reader !== null ? reader.read() : iterator.next())
    try {
      return await Promise.race([pending, halted])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      clearTimeout(timer)
      pending.catch(() => {})
    }
  }
  const dispatch = () => {
    const payload = data.join('\n')
    data = []
    if (payload.trim() === '[DONE]') return true
    if (payload !== '') onData(payload)
    return false
  }
  const completeData = () => {
    if (!data.length) return false
    if (data.join('\n').trim() === '[DONE]') return true
    try { JSON.parse(data.join('\n')); return true } catch { return false }
  }
  const line = value => {
    const text = value.replace(/\r$/, '').replace(/^\uFEFF/, '')
    if (rawJson || text.trimStart().startsWith('{')) {
      if (!rawJson && dispatch()) return true
      rawJson += (rawJson ? '\n' : '') + text
      let payload
      try { payload = JSON.parse(rawJson) } catch { return false }
      rawJson = ''
      if (payload?.error || payload?.type === 'error') {
        const err = payload.error ?? payload
        throw new UpstreamError(
          typeof err.message === 'string' ? err.message : 'upstream stream error',
          CODE.server, { type: err.type })
      }
      onData(JSON.stringify(payload))
      return false
    }
    if (text === '') return dispatch()
    if (text.startsWith(':')) return false
    const colon = text.indexOf(':')
    const field = colon < 0 ? text : text.slice(0, colon)
    const valueText = colon < 0 ? '' : text.slice(colon + 1).replace(/^ /, '')
    if (field === 'data') {
      if (completeData() && dispatch()) return true
      if (valueText.trim() === '[DONE]') { dispatch(); return true }
      data.push(valueText)
    }
    return false
  }
  try {
    while (true) {
      const { value, done } = await next()
      if (done) break
      if (Date.now() > deadline) throw new UpstreamError('upstream stream idle past its deadline', CODE.timeout)
      if (value !== undefined) buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const row = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (line(row)) return
        newline = buffer.indexOf('\n')
      }
      deadline = Date.now() + timeoutMs
    }
    buffer += decoder.decode()
    if (buffer && line(buffer)) return
    if (rawJson) throw new UpstreamError('upstream returned an incomplete JSON document inside its event stream', CODE.transport)
    dispatch()
  } catch (error) {
    throw classifyStreamFailure(error, signal)
  } finally {
    stop()
    if (reader !== null) {
      try { reader.releaseLock?.() } catch { /* pending read is still unwinding */ }
    }
  }
}
