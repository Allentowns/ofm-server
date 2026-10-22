/**
 * Model availability probes.
 *
 * One probe is a real, minimal turn (`max_tokens: 64`, one-word prompt) against
 * the model's own lane. That is the only way to answer "is this model usable
 * from this machine right now": the catalog listing says what the upstream
 * *declares*, and the free lanes routinely declare ids they then refuse
 * (region policy, withdrawn routes, per-model quota).
 *
 * Probes are the same code path as the chat endpoint's request transform, so
 * what a probe reports is what a real turn would get — including the client
 * fingerprint on the OpenCode lane.
 *
 * @module lib/probe.js
 */

import { KILO_PREFIX } from './catalog.js'
import { applyFingerprint, declaredToolNames } from './fingerprint.js'
import { postTurn as postOpencodeTurn } from './lane-opencode.js'
import { postTurn as postKiloTurn } from './lane-kilo.js'
import { applyRequestTransform, createAccumulator, createToolWire } from './transform.js'

const DEFAULT_PROMPT = 'Reply with the single word: pong'

/**
 * Run one probe.
 *
 * @param {object} options
 * @param {string} options.model - catalog id (`kilo/...` or a bare OpenCode id)
 * @param {string} [options.prompt]
 * @param {string} [options.effort] - reasoning_effort to exercise
 * @param {object} options.deps - { catalog, sessions, transport, inspector }
 * @returns {Promise<object>} probe result, also stored on the catalog
 */
export async function probeModel({ model, prompt = DEFAULT_PROMPT, effort, source = 'test', deps }) {
  const { catalog, sessions, transport, inspector } = deps
  const lane = typeof model === 'string' && model.startsWith(KILO_PREFIX) ? 'kilo'
    : catalog.get(model)?.lane === 'kilo' ? 'kilo' : 'opencode'
  const upstreamModel = lane === 'kilo' ? model.slice(KILO_PREFIX.length) : model

  const body = {
    model: upstreamModel,
    messages: [{ role: 'user', content: prompt }],
    stream: true,
    max_tokens: 64,
    ...(effort ? { reasoning_effort: effort } : {}),
  }
  const wireBody = { ...body }
  const startedAt = Date.now()
  let ttftMs
  let headers = {}
  let url = ''
  let sessionReused
  let fingerprint = null

  // Probes are recorded in the inspector like any other turn when it is on,
  // marked by `source` so a batch run is distinguishable from agent traffic.
  const trace = inspector.begin({
    lane,
    model,
    source,
    nativeHeaders: { origin: `ofm-server ${source}` },
    nativeBody: body,
  })

  if (lane === 'opencode') {
    const slot = sessions.sessionFor(`probe\u0000${model}`)
    sessionReused = slot.reused
    fingerprint = applyFingerprint(wireBody)
    const notes = applyRequestTransform(wireBody, lane)
    url = 'https://opencode.ai/inference/v1/chat/completions'
    headers = {
      'authorization': 'Bearer public',
      'user-agent': 'opencode/latest/2.0.26/cli',
      'x-opencode-session': slot.session,
      'x-opencode-session-id': slot.session,
      'x-session-affinity': slot.session,
      'x-session-id': slot.session,
    }
    trace.step({
      upstream: { url, headers, body: wireBody, sessionReused },
      transform: {
        notes,
        injected: fingerprint.injected,
        renamed: fingerprint.renamed,
        route: transport.routeFor('opencode.ai'),
      },
    })
    var post = options => postOpencodeTurn({ ...options, session: slot.session, transport })
  } else {
    const notes = applyRequestTransform(wireBody, lane)
    url = 'https://api.kilo.ai/api/gateway/chat/completions'
    headers = { 'user-agent': 'ofm-server' }
    trace.step({
      upstream: { url, headers, body: wireBody },
      transform: { notes, injected: [], renamed: [], route: transport.routeFor('api.kilo.ai') },
    })
    var post = options => postKiloTurn({ ...options, transport })
  }

  const wire = createToolWire({ declared: declaredToolNames(body), aliases: fingerprint?.aliases ?? new Map() })
  const acc = createAccumulator({ model })
  const onData = payload => {
    if (ttftMs === undefined) ttftMs = Date.now() - startedAt
    let chunk
    try { chunk = JSON.parse(payload) } catch { return }
    acc.noteChunkMeta(chunk)
    for (const choice of Array.isArray(chunk?.choices) ? chunk.choices : []) {
      acc.noteFinish(choice?.finish_reason)
      const delta = choice?.delta ?? {}
      acc.noteText(delta.content)
      acc.noteReasoning(delta.reasoning_content)
      if (typeof delta.reasoning === 'string') acc.noteReasoning(delta.reasoning)
      for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
        const verdict = wire.admit({
          index: call?.index ?? 0,
          id: typeof call?.id === 'string' ? call.id : undefined,
          name: typeof call?.function?.name === 'string' ? call.function.name : undefined,
          argumentsDelta: typeof call?.function?.arguments === 'string' ? call.function.arguments : undefined,
        })
        if (verdict !== null && verdict.kind === 'forward') acc.noteForwardedCall(verdict)
      }
    }
  }

  try {
    await post({ body: wireBody, signal: undefined, onData })
  } catch (error) {
    const failure = {
      ok: false,
      model,
      lane,
      error: { code: error?.code ?? 'TRANSPORT', message: String(error?.message ?? error).slice(0, 400) },
      durationMs: Date.now() - startedAt,
    }
    catalog.setProbe(model, { state: 'error', code: failure.error.code, message: failure.error.message, durationMs: failure.durationMs })
    trace.end({
      error: failure.error,
      response: { ttftMs, stopReason: 'error', textChars: 0, toolCalls: 0, suppressed: 0 },
    })
    return failure
  }

  const outcome = acc.outcome
  const final = acc.finalize()
  const result = {
    ok: true,
    model,
    lane,
    ttftMs,
    durationMs: Date.now() - startedAt,
    stopReason: final.choices[0].finish_reason,
    usage: final.usage,
    text: outcome.text.slice(0, 400),
    reasoningChars: (final.choices[0].message.reasoning_content ?? '').length,
    suppressed: wire.suppressedCount,
  }
  catalog.setProbe(model, {
    state: 'ok',
    ttftMs: result.ttftMs,
    durationMs: result.durationMs,
    stopReason: result.stopReason,
  })
  trace.end({
    response: {
      ttftMs,
      usage: final.usage,
      stopReason: result.stopReason,
      textChars: outcome.text.length,
      toolCalls: outcome.toolCalls.length,
      suppressed: wire.suppressedCount,
    },
  })
  return result
}

/**
 * Probe every listed model, a few at a time.
 *
 * Concurrency stays small on purpose: each probe is a real upstream turn, and
 * both free lanes answer a burst of parallel sessions with 429 — which would
 * make the run report rate limits as if they were model problems.
 *
 * @param {object} options
 * @param {object} options.deps - { catalog, sessions, transport, inspector }
 * @param {number} [options.concurrency]
 * @param {number} [options.timeoutMs] - per-probe cap
 */
export async function probeAll({ deps, concurrency = 3, timeoutMs = 45000, source = 'test' } = {}) {
  const ids = deps.catalog.list().map(entry => entry.id)
  const queue = [...ids]
  for (const id of ids) deps.catalog.setProbe(id, { state: 'checking' })

  let done = 0
  let failed = 0
  const worker = async () => {
    while (queue.length > 0) {
      const model = queue.shift()
      let timer
      try {
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => reject(Object.assign(new Error('probe timed out'), { code: 'TIMEOUT' })), timeoutMs)
          timer.unref?.()
        })
        const result = await Promise.race([probeModel({ model, deps, source }), timeout])
        if (result.ok !== true) failed += 1
      } catch (error) {
        failed += 1
        deps.catalog.setProbe(model, { state: 'error', code: error?.code ?? 'TIMEOUT', message: String(error?.message ?? error) })
      } finally {
        clearTimeout(timer)
        done += 1
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker))
  return { total: ids.length, done, failed }
}
