/**
 * Request translation and response-side repair.
 *
 * Request side:
 * - `reasoning_effort` (low/medium/high) -> max_tokens budget on the OpenCode
 *   lane. The upstream accepts reasoning fields and ignores all of them
 *   (verified 2026-09-24 by dsh-our-free-model); max_tokens is the one control
 *   it enforces, and reasoning volume tracks it. On the Kilo lane the same
 *   levels map to the gateway's unified `reasoning` parameter.
 * - The caller's explicit `max_tokens` always wins over the effort default.
 *
 * Response side (ported from dsh-our-free-model src/forward.js):
 * - tool_calls[].index renumbered from 0 (upstream block indices are shared
 *   with thinking blocks; index-accumulating clients would otherwise see
 *   sparse arrays and merge or drop arguments);
 * - tool calls aimed at the injected fingerprint decoys are suppressed —
 *   the gate forced us to declare `read`/`shell`, but the caller never
 *   registered them, so handing the call over is a client-side error;
 * - aliases (`read_client` -> caller's `read`) restored to caller spelling.
 *
 * The tool wire is the ONLY component that classifies tool-call deltas, and
 * each delta passes through it exactly once (see lib/chat.js onData).
 *
 * @module lib/transform.js
 */

import { FINGERPRINT_TOOLS } from './fingerprint.js'

/** max_tokens budget per effort level, OpenCode lane. `high` leaves it unset. */
export const EFFORT_CEILINGS = { low: 2048, medium: 8192, high: undefined }

/** Effort -> Kilo's unified `reasoning` parameter.
 *
 * The gateway's schema (probed 2026-10-22, before any quota check):
 *   reasoning: { effort: "max"|"xhigh"|"high"|"medium"|"low"|"minimal"|"none" }
 * A bare string (our first mapping) is rejected with
 * "expected object, received string"; "off" is not in the enum (use "none");
 * and `enabled: false` is refused outright by thinking-mandatory endpoints
 * (minimax here; the plugin measured the same on stepfun/liquid).
 *
 * Note: the gateway ALSO accepts OpenAI's native `reasoning_effort` string
 * directly (verified: "high" -> 25 reasoning tokens). We still map into the
 * object form so unknown caller spellings ("banana") fail at OUR boundary
 * with a readable message instead of passing through and 400-ing upstream.
 */
export const KILO_REASONING = { low: 'low', medium: 'medium', high: 'high' }

export function applyRequestTransform(body, lane) {
  const notes = []
  const effort = typeof body.reasoning_effort === 'string' ? body.reasoning_effort.toLowerCase() : undefined
  if (effort !== undefined) delete body.reasoning_effort

  if (lane === 'opencode') {
    if (effort !== undefined && body.max_tokens === undefined && effort in EFFORT_CEILINGS) {
      const ceiling = EFFORT_CEILINGS[effort]
      if (ceiling !== undefined) {
        body.max_tokens = ceiling
        notes.push(`reasoning_effort:${effort} -> max_tokens:${ceiling} (upstream ignores effort fields; max_tokens is the enforced control)`)
      } else {
        notes.push(`reasoning_effort:${effort} -> no max_tokens cap (model's full output capacity)`)
      }
    } else if (effort !== undefined && body.max_tokens !== undefined) {
      notes.push(`reasoning_effort:${effort} ignored; caller's max_tokens=${body.max_tokens} takes precedence`)
    } else if (effort !== undefined) {
      notes.push(`reasoning_effort:${effort} is not a recognized level; dropped`)
    }
  } else if (lane === 'kilo') {
    if (effort !== undefined && effort in KILO_REASONING) {
      body.reasoning = { effort: KILO_REASONING[effort] }
      notes.push(`reasoning_effort:${effort} -> reasoning.effort:${KILO_REASONING[effort]} (Kilo gateway object parameter)`)
    } else if (effort !== undefined) {
      notes.push(`reasoning_effort:${effort} is not a recognized level; dropped`)
    }
  }
  return notes
}

/**
 * Per-request tool-wire state: classify tool-call deltas, renumber indices,
 * suppress decoy calls, restore aliases.
 */
export function createToolWire({ declared, aliases }) {
  const declaredNames = declared instanceof Set ? declared : new Set(declared ?? [])
  const slots = new Map()
  let nextIndex = 0
  const classified = new Map() // upstream block index -> boolean (executable?)
  const held = new Map()       // block index -> { id?, args: string[] }
  const suppressedNames = new Set()

  const executable = name => !(FINGERPRINT_TOOLS.includes(name) && !declaredNames.has(name))

  return {
    get suppressedCount() {
      return suppressedNames.size
    },
    get suppressedNames() {
      return [...suppressedNames]
    },
    /** Is this (restored) tool name one the caller can actually execute? */
    isExecutable: executable,
    /** Sequential per-request OpenAI index for an upstream block index. */
    indexOf(blockIndex) {
      let assigned = slots.get(blockIndex)
      if (assigned === undefined) { assigned = nextIndex++; slots.set(blockIndex, assigned) }
      return assigned
    },
    /**
     * Route one tool_call delta. Returns
     *   { kind:'forward', openAiIndex, first, id?, name?, args } | { kind:'drop' }
     */
    admit(chunk) {
      const blockIndex = chunk.index
      const verdict = classified.get(blockIndex)
      if (verdict === false) return { kind: 'drop' }
      const rawName = typeof chunk.name === 'string' && chunk.name !== '' ? chunk.name : undefined
      const name = rawName !== undefined ? restoreAlias(rawName) : undefined
      if (verdict === true) {
        return { kind: 'forward', openAiIndex: this.indexOf(blockIndex), first: false, args: chunk.argumentsDelta ?? '' }
      }
      if (name !== undefined) {
        const keep = executable(name)
        classified.set(blockIndex, keep)
        if (!keep) {
          suppressedNames.add(name)
          return { kind: 'drop' }
        }
        const parked = held.get(blockIndex)
        held.delete(blockIndex)
        return {
          kind: 'forward', openAiIndex: this.indexOf(blockIndex), first: true,
          id: chunk.id ?? parked?.id, name,
          args: [...parked?.args ?? [], chunk.argumentsDelta ?? ''].join(''),
        }
      }
      const parked = held.get(blockIndex) ?? { args: [] }
      if (chunk.id !== undefined && chunk.id !== '') parked.id = chunk.id
      if (chunk.argumentsDelta) parked.args.push(chunk.argumentsDelta)
      held.set(blockIndex, parked)
      return { kind: 'drop' }
    },
    /**
     * The whole turn answered only with decoy calls (no text, no real tools,
     * no truncation). Reported as a 502 with an actionable message instead of
     * an empty 200, mirroring the plugin's suppressedOnlyNote.
     */
    suppressedOnlyNote(outcome) {
      if (suppressedNames.size === 0) return null
      const calls = Array.isArray(outcome?.toolCalls) ? outcome.toolCalls : []
      if (calls.length > 0) return null
      if (outcome?.truncated === true) return null
      if (typeof outcome?.text === 'string' && outcome.text !== '') return null
      const names = [...suppressedNames]
      return `the model answered by calling ${names.length > 0 ? names.join(', ') : 'a tool'} instead of writing an answer, and this request declared no such tool — re-send it with that tool declared`
    },
  }

  function restoreAlias(name) {
    if (!aliases || aliases.size === 0) return name
    return aliases.get(name) ?? name
  }
}

/**
 * Accumulate one turn's normalized pieces into a final OpenAI-shaped object.
 * Pieces arrive already routed through the tool wire (renumbered, decoys
 * dropped, aliases restored), so this component never sees raw upstream calls.
 */
export function createAccumulator({ model }) {
  const text = []
  const reasoning = []
  const callsByIndex = new Map()
  let finishReason
  let usage
  let id
  let created
  let truncated = false

  return {
    get outcome() {
      // `thinking` is the Anthropic-side spelling of the same buffer; the
      // OpenAI path reads it through `finalize()` as `reasoning_content`.
      return { text: text.join(''), thinking: reasoning.join(''), toolCalls: [...callsByIndex.values()], truncated, usage }
    },
    noteChunkMeta(chunk) {
      if (chunk?.id && id === undefined) id = chunk.id
      if (chunk?.created && created === undefined) created = chunk.created
      if (chunk?.usage) usage = chunk.usage
      // Non-stream bodies arrive as one object; fold their reasoning spellings
      // (Kilo: `reasoning` / `reasoning_details`) into the same buffer.
      const message = chunk?.choices?.[0]?.message
      if (message && typeof message === 'object') {
        if (typeof message.reasoning === 'string') reasoning.push(message.reasoning)
        if (Array.isArray(message.reasoning_details)) {
          for (const piece of message.reasoning_details) {
            if (typeof piece?.text === 'string') reasoning.push(piece.text)
          }
        }
      }
    },
    noteText(value) {
      if (typeof value === 'string' && value !== '') text.push(value)
    },
    noteReasoning(value) {
      if (typeof value === 'string' && value !== '') reasoning.push(value)
    },
    noteFinish(reason) {
      if (reason) finishReason = reason
      if (reason === 'length') truncated = true
    },
    noteForwardedCall(verdict) {
      const slot = callsByIndex.get(verdict.openAiIndex) ?? { index: verdict.openAiIndex, id: undefined, name: undefined, args: [] }
      if (verdict.id !== undefined) slot.id = verdict.id
      if (verdict.name !== undefined) slot.name = verdict.name
      if (verdict.args) slot.args.push(verdict.args)
      callsByIndex.set(verdict.openAiIndex, slot)
    },
    finalize() {
      const toolCalls = [...callsByIndex.values()]
        .sort((a, b) => a.index - b.index)
        .map(call => ({
          id: call.id ?? `call_${call.index}`,
          type: 'function',
          function: { name: call.name ?? '', arguments: call.args.join('') || '{}' },
        }))
      const message = { role: 'assistant', content: text.join('') || null }
      if (reasoning.length > 0) message.reasoning_content = reasoning.join('')
      if (toolCalls.length > 0) message.tool_calls = toolCalls
      return {
        id: id ?? 'chatcmpl-ofm',
        object: 'chat.completion',
        created: created ?? Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          message,
          finish_reason: finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
        }],
        usage: usage ?? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }
    },
  }
}
