/**
 * The chat-completions orchestration: native body in, upstream turn out,
 * OpenAI-shaped stream (or object) back.
 *
 * Flow per request:
 *   1. classify the model -> lane (kilo/ prefix vs OpenCode roster)
 *   2. record the native request in the inspector
 *   3. OpenCode lane: sticky session, applyFingerprint, effort->max_tokens
 *      Kilo lane: effort->reasoning, no fingerprinting
 *   4. post the turn; every upstream delta is routed through the tool wire
 *      ONCE (renumber / suppress decoys / restore aliases), then handed to the
 *      caller's sink
 *   5. non-streaming callers get the accumulated object; a turn that answered
 *      only with suppressed decoys becomes a 502 with an actionable message
 *
 * `runTurn` is the protocol-neutral core; `handleChatCompletion` (OpenAI) and
 * `handleAnthropicMessages` (Anthropic Messages) are the two front doors.
 *
 * @module lib/chat.js
 */

import crypto from 'node:crypto'
import { UpstreamError } from './errors.js'
import { KILO_PREFIX } from './catalog.js'
import { applyFingerprint, declaredToolNames } from './fingerprint.js'
import { postTurn as postOpencodeTurn } from './lane-opencode.js'
import { postTurn as postKiloTurn } from './lane-kilo.js'
import { applyRequestTransform, createAccumulator, createToolWire } from './transform.js'
import { seedForRequest } from './sessions.js'
import { AnthropicStream, anthropicMessage, countTokens, fromAnthropicRequest } from './anthropic.js'

const SSE_HEARTBEAT_MS = 15000

function openAiErrorPayload(message, type) {
  return { error: { message, type, code: type } }
}

function statusFor(code) {
  if (code === 'RATE_LIMIT') return 429
  if (code === 'REGION_BLOCKED' || code === 'FINGERPRINT_REJECTED' || code === 'INVALID_CREDENTIAL') return 403
  if (code === 'UPSTREAM_CLIENT_ERROR') return 400
  return 502
}

/** Anthropic's error envelope uses a small fixed vocabulary of types. */
function anthropicErrorType(code) {
  if (code === 'RATE_LIMIT') return 'rate_limit_error'
  if (code === 'INVALID_CREDENTIAL') return 'authentication_error'
  if (code === 'REGION_BLOCKED' || code === 'FINGERPRINT_REJECTED') return 'permission_error'
  if (code === 'UPSTREAM_CLIENT_ERROR') return 'invalid_request_error'
  return 'api_error'
}

export function laneOf(modelId, catalog) {
  if (typeof modelId === 'string' && modelId.startsWith(KILO_PREFIX)) return 'kilo'
  const entry = catalog.get(String(modelId ?? ''))
  if (entry?.lane === 'kilo') return 'kilo'
  return 'opencode'
}

/**
 * Run one turn. The caller supplies the already-validated body (OpenAI shape,
 * post-conversion), the seed used for session stickiness, and a `sink` that
 * receives routed deltas:
 *
 *   sink.text(value)                              visible answer
 *   sink.reasoning(value)                         thinking
 *   sink.toolDelta({index,id,name,args})          a forwarded tool-call fragment
 *   sink.toolEnd({index,id,name,args})            a suppressed-only turn notices decoys
 *   sink.usage(rawUsage)                          upstream usage object
 *   sink.finish({truncated})                      terminal signal
 *
 * Returns `{ ok, lane, model, outcome, suppressed, error }`; `outcome` is the
 * accumulated text/toolCalls/usage/truncated record.
 */
async function runTurn({ body, seed, deps, sink, traceSource = 'api' }) {
  const { catalog, sessions, transport, inspector } = deps
  const modelId = String(body.model ?? '')
  const lane = laneOf(modelId, catalog)
  const upstreamModel = lane === 'kilo' ? modelId.slice(KILO_PREFIX.length) : modelId

  const trace = inspector.begin({
    lane,
    model: modelId,
    source: traceSource,
    nativeHeaders: { origin: `ofm-server ${traceSource}` },
    nativeBody: body,
  })

  const wireBody = { ...body, model: upstreamModel, stream: true }
  delete wireBody.user
  delete wireBody.stream_options

  const transformNotes = []
  let session = null
  let sessionReused
  let upstreamUrl
  let upstreamHeaders
  let fingerprint = null

  if (lane === 'opencode') {
    const slot = sessions.sessionFor(seed)
    session = slot.session
    sessionReused = slot.reused
    fingerprint = applyFingerprint(wireBody)
    transformNotes.push(...applyRequestTransform(wireBody, lane))
    upstreamUrl = 'https://opencode.ai/inference/v1/chat/completions'
    upstreamHeaders = {
      'content-type': 'application/json',
      'authorization': 'Bearer public',
      'user-agent': 'opencode/latest/2.0.26/cli',
      'x-opencode-client': 'cli',
      'x-opencode-session': session,
      'x-opencode-session-id': session,
      'x-session-affinity': session,
      'x-session-id': session,
      'x-opencode-project': 'global',
      'accept': 'text/event-stream',
    }
  } else {
    transformNotes.push(...applyRequestTransform(wireBody, lane))
    upstreamUrl = 'https://api.kilo.ai/api/gateway/chat/completions'
    upstreamHeaders = {
      'content-type': 'application/json',
      'accept': 'text/event-stream',
      'user-agent': 'ofm-server',
    }
  }

  trace.step({
    upstream: {
      url: upstreamUrl,
      headers: upstreamHeaders,
      body: wireBody,
      ...(sessionReused !== undefined ? { sessionReused } : {}),
    },
    transform: {
      notes: transformNotes,
      injected: fingerprint?.injected ?? [],
      renamed: fingerprint?.renamed ?? [],
      aliases: fingerprint && fingerprint.aliases.size > 0 ? Object.fromEntries(fingerprint.aliases) : undefined,
      route: transport.routeFor(lane === 'kilo' ? 'api.kilo.ai' : 'opencode.ai'),
    },
  })

  const wire = createToolWire({ declared: declaredToolNames(body), aliases: fingerprint?.aliases ?? new Map() })
  const acc = createAccumulator({ model: modelId })
  const startedAt = Date.now()
  let ttftMs

  const onData = payload => {
    if (ttftMs === undefined) ttftMs = Date.now() - startedAt
    let chunk
    try { chunk = JSON.parse(payload) } catch { return }
    acc.noteChunkMeta(chunk)

    const choices = Array.isArray(chunk?.choices) ? chunk.choices : []
    for (const choice of choices) {
      acc.noteFinish(choice?.finish_reason)
      const delta = choice?.delta ?? {}

      // Content and thinking reach the sink as they are; the caller decides how
      // its protocol spells them.
      if (typeof delta.content === 'string' && delta.content !== '') {
        acc.noteText(delta.content)
        sink.text(delta.content)
      }
      const reasoning = typeof delta.reasoning_content === 'string' && delta.reasoning_content !== ''
        ? delta.reasoning_content
        : typeof delta.reasoning === 'string' && delta.reasoning !== ''
          ? delta.reasoning
          : Array.isArray(delta.reasoning_details)
            ? delta.reasoning_details.map(piece => piece?.text ?? '').join('')
            : ''
      if (reasoning !== '') {
        acc.noteReasoning(reasoning)
        sink.reasoning(reasoning)
      }

      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const verdict = wire.admit({
          index: call?.index ?? 0,
          id: typeof call?.id === 'string' && call.id !== '' ? call.id : undefined,
          name: typeof call?.function?.name === 'string' && call.function.name !== '' ? call.function.name : undefined,
          argumentsDelta: typeof call?.function?.arguments === 'string' ? call.function.arguments : undefined,
        })
        if (verdict.kind === 'drop') continue
        acc.noteForwardedCall(verdict)
        sink.toolDelta({
          index: verdict.openAiIndex,
          id: verdict.id,
          name: verdict.name,
          args: verdict.args,
        })
      }
    }
    if (chunk?.usage) {
      acc.noteChunkMeta({ usage: chunk.usage })
      sink.usage(chunk.usage)
    }
  }

  let upstreamError = null
  try {
    const post = lane === 'opencode'
      ? options => postOpencodeTurn({ ...options, session, transport })
      : options => postKiloTurn({ ...options, transport })
    await post({ body: wireBody, signal: undefined, onData })
  } catch (error) {
    upstreamError = error instanceof UpstreamError ? error : new UpstreamError(String(error?.message ?? error), 'TRANSPORT')
  }

  const outcome = acc.outcome
  const suppressedNote = upstreamError === null ? wire.suppressedOnlyNote(outcome) : null
  if (upstreamError !== null) catalog.markUnavailable(modelId, upstreamError)
  const failure = upstreamError ?? (suppressedNote !== null
    ? new UpstreamError(suppressedNote, 'UPSTREAM_CLIENT_ERROR', { status: 502 })
    : null)

  if (failure === null) sink.finish({ truncated: outcome.truncated })

  trace.end({
    ...(failure !== null ? { error: { code: failure.code, message: failure.message } } : {}),
    response: {
      ttftMs,
      usage: outcome.usage,
      stopReason: failure !== null ? 'error' : outcome.truncated ? 'length' : 'stop',
      textChars: outcome.text.length,
      toolCalls: outcome.toolCalls.length,
      suppressed: wire.suppressedCount,
      suppressedNames: wire.suppressedNames,
    },
  })

  return {
    ok: failure === null,
    lane,
    model: modelId,
    outcome,
    // The OpenAI-shaped object, assembled by the accumulator — the only place
    // where tool slots become `tool_calls[]` with joined argument strings.
    completion: failure === null ? acc.finalize() : null,
    suppressed: wire.suppressedCount,
    error: failure,
    ttftMs,
    startedAt,
  }
}

// ---------------------------------------------------------------- OpenAI front door

export async function handleChatCompletion({ req, res, body, catalog, sessions, inspector, transport }) {
  const modelId = String(body?.model ?? '')
  if (modelId === '') {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify(openAiErrorPayload('`model` is required', 'invalid_request_error')))
    return
  }
  const wantStream = body?.stream === true
  const deps = { catalog, sessions, inspector, transport }

  let headersSent = false
  let heartbeat = null
  const stream = {
    text: value => {
      if (!wantStream || res.writableEnded) return
      res.write(`data: ${JSON.stringify(chunkOf(modelId, { content: value }))}\n\n`)
    },
    reasoning: value => {
      if (!wantStream || res.writableEnded) return
      res.write(`data: ${JSON.stringify(chunkOf(modelId, { reasoning_content: value }))}\n\n`)
    },
    toolDelta: ({ index, id, name, args }) => {
      if (!wantStream || res.writableEnded) return
      res.write(`data: ${JSON.stringify(chunkOf(modelId, {
        tool_calls: [{
          index,
          ...(id !== undefined ? { id } : {}),
          type: 'function',
          function: { ...(name !== undefined ? { name } : {}), ...(args ? { arguments: args } : {}) },
        }],
      }))}\n\n`)
    },
    toolEnd: () => {},
    usage: usage => {
      if (!wantStream || res.writableEnded) return
      res.write(`data: ${JSON.stringify({ id: 'chatcmpl-ofm', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [], usage })}\n\n`)
    },
    finish: () => {},
  }

  if (wantStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    headersSent = true
    heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return }
      try { res.write(': ofm-server keep-alive\n\n') } catch { clearInterval(heartbeat) }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const result = await runTurn({ body, seed: seedForRequest(body), deps, sink: stream })
  if (heartbeat) clearInterval(heartbeat)

  if (!result.ok) {
    const failure = result.error
    if (headersSent) {
      res.write(`data: ${JSON.stringify(openAiErrorPayload(failure.message, failure.code))}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(statusFor(failure.code), { 'content-type': 'application/json' })
      res.end(JSON.stringify(openAiErrorPayload(failure.message, failure.code)))
    }
    return
  }

  if (wantStream) {
    res.write(`data: ${JSON.stringify({ id: 'chatcmpl-ofm-final', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: modelId, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
    return
  }

  // Non-streaming: the accumulator already assembled the object the streaming
  // path would have produced.
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(result.completion))
}

function chunkOf(model, delta) {
  return {
    id: 'chatcmpl-ofm',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: null }],
  }
}

// ---------------------------------------------------------------- Anthropic front door

export async function handleAnthropicMessages({ req, res, body: raw, catalog, sessions, inspector, transport }) {
  const converted = fromAnthropicRequest(raw)
  if (converted.error) {
    res.writeHead(400, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: converted.error } }))
    return
  }

  const { body, stream: wantStream, effort, model } = converted
  if (effort !== undefined) body.reasoning_effort = effort

  const deps = { catalog, sessions, inspector, transport }
  const messageId = `msg_${crypto.randomBytes(12).toString('hex')}`
  const renderer = new AnthropicStream({ model, messageId })

  let headersSent = false
  let heartbeat = null
  const out = []
  const flush = () => {
    if (out.length === 0) return
    if (res.writableEnded) { out.length = 0; return }
    res.write(out.join(''))
    out.length = 0
  }

  const sink = {
    text: value => { renderer.text(out, value); if (wantStream) flush() },
    reasoning: value => { renderer.thinking(out, value); if (wantStream) flush() },
    toolDelta: delta => { renderer.toolDelta(out, delta); if (wantStream) flush() },
    toolEnd: delta => { renderer.toolEnd(out, delta); if (wantStream) flush() },
    usage: usage => { renderer.noteUsage(out, usage); if (wantStream) flush() },
    finish: ({ truncated }) => { renderer.finish(out, { truncated }); if (wantStream) flush() },
  }

  if (wantStream) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    headersSent = true
    renderer.start(out)
    flush()
    heartbeat = setInterval(() => {
      if (res.writableEnded) { clearInterval(heartbeat); return }
      try { res.write(': ofm-server keep-alive\n\n') } catch { clearInterval(heartbeat) }
    }, SSE_HEARTBEAT_MS)
    heartbeat.unref?.()
  }

  const result = await runTurn({ body, seed: seedForRequest(body), deps, sink })
  if (heartbeat) clearInterval(heartbeat)

  if (!result.ok) {
    const failure = result.error
    if (headersSent) {
      renderer.fail(out, failure.message, anthropicErrorType(failure.code))
      flush()
      res.end()
    } else {
      res.writeHead(statusFor(failure.code), { 'content-type': 'application/json' })
      res.end(JSON.stringify({ type: 'error', error: { type: anthropicErrorType(failure.code), message: failure.message } }))
    }
    return
  }

  if (wantStream) {
    flush()
    res.end()
    return
  }

  const message = anthropicMessage({
    text: result.outcome.text,
    thinking: result.outcome.thinking ?? '',
    // `outcome.toolCalls` holds the accumulator's slots, whose `args` is a list
    // of streamed fragments (the OpenAI assemble step joins them).
    toolCalls: result.outcome.toolCalls.map(call => ({
      id: call.id,
      name: call.name,
      arguments: Array.isArray(call.args) ? call.args.join('') : String(call.arguments ?? ''),
    })),
    usage: result.outcome.usage,
    truncated: result.outcome.truncated,
    model,
    id: messageId,
  })
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(message))
}

/** `POST /v1/messages/count_tokens` — local estimate, no upstream call. */
export function handleCountTokens({ res, body }) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(countTokens(body)))
}

