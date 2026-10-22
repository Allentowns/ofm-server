import test from 'node:test'
import assert from 'node:assert/strict'
import {
  applyFingerprint, restoreToolName, mintSessionId, canonicalizeSession,
  isCanonicalSession, SESSION_RE, SESSION_DESCENDING_RE, declaredToolNames,
} from '../lib/fingerprint.js'
import { FINGERPRINT_TOOL_DEFINITIONS } from '../lib/fingerprint.js'
import { createToolWire, createAccumulator, applyRequestTransform } from '../lib/transform.js'
import { seedForRequest } from '../lib/sessions.js'

const read = FINGERPRINT_TOOL_DEFINITIONS.read
const shell = FINGERPRINT_TOOL_DEFINITIONS.shell

const officialRead = { type: 'function', function: { name: 'read', description: read.description, parameters: read.parameters } }
const officialShell = { type: 'function', function: { name: 'shell', description: shell.description, parameters: shell.parameters } }

// ---------------------------------------------------------------- sessions

test('minted session ids carry the descending encoding', () => {
  for (let i = 0; i < 200; i += 1) {
    const id = mintSessionId(1_700_000_000_000 + i)
    assert.match(id, SESSION_RE, id)
    assert.match(id.slice(4, 16), SESSION_DESCENDING_RE, id)
    assert.ok(isCanonicalSession(id), id)
  }
})

test('canonicalizeSession is deterministic and in-window', () => {
  const a = canonicalizeSession('conv-1')
  const b = canonicalizeSession('conv-1')
  assert.equal(a, b)
  assert.ok(isCanonicalSession(a))
  const c = canonicalizeSession('conv-2')
  assert.notEqual(a, c)
})

// ---------------------------------------------------------------- fingerprint

test('injects both gate tools when the caller declares none', () => {
  const body = { messages: [{ role: 'user', content: 'hi' }] }
  const result = applyFingerprint(body)
  assert.deepEqual(result.injected.sort(), ['read', 'shell'])
  assert.equal(result.aliases.size, 0)
  const names = body.tools.map(t => t.function.name)
  assert.ok(names.includes('read') && names.includes('shell'))
  // placeholder note is present as a system message
  const first = body.messages[0]
  assert.equal(first.role, 'system')
  assert.match(first.content, /placeholders that do nothing/)
})

test('keeps the caller tools untouched and appends gate tools', () => {
  const caller = { type: 'function', function: { name: 'my_tool', description: 'x', parameters: { type: 'object', properties: {} } } }
  const body = { messages: [], tools: [caller] }
  const result = applyFingerprint(body)
  assert.equal(result.injected.length, 2)
  assert.equal(body.tools.filter(t => t.function.name === 'my_tool').length, 1)
  assert.deepEqual(JSON.parse(JSON.stringify(body.tools[0])), caller)
})

test('a caller tool named read with a different definition is aliased', () => {
  const callerRead = { type: 'function', function: { name: 'read', description: 'different', parameters: { type: 'object', properties: {} } } }
  const body = {
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"p":1}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'out' },
    ],
    tools: [callerRead],
    tool_choice: { type: 'function', function: { name: 'read' } },
  }
  const result = applyFingerprint(body)
  assert.deepEqual(result.renamed, ['read'])
  assert.equal(result.aliases.get('read_client'), 'read')
  // injected official read must exist beside the alias
  const names = body.tools.map(t => t.function.name)
  assert.ok(names.includes('read'))
  assert.ok(names.includes('read_client'))
  // history retargeted (a system note is prepended, so find the assistant turn)
  const assistant = body.messages.find(m => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].function.name, 'read_client')
  // tool_choice retargeted
  assert.equal(body.tool_choice.function.name, 'read_client')
  // restore works
  assert.equal(restoreToolName('read_client', result.aliases), 'read')
  assert.equal(restoreToolName('shell', result.aliases), 'shell')
})

test('a caller tool carrying the exact official definition is kept as-is', () => {
  const body = { messages: [], tools: [JSON.parse(JSON.stringify(officialRead))] }
  const result = applyFingerprint(body)
  assert.deepEqual(result.injected, ['shell'])
  assert.equal(result.renamed.length, 0)
  assert.equal(body.tools.filter(t => t.function.name === 'read').length, 1)
})

test('duplicate gate declarations keep the first', () => {
  const body = { messages: [], tools: [officialRead, { type: 'function', function: { name: 'read', description: 'other', parameters: {} } }] }
  applyFingerprint(body)
  const reads = body.tools.filter(t => t.function.name === 'read')
  assert.equal(reads.length, 1)
  assert.equal(reads[0].function.description, read.description)
})

test('tool_choice none is removed; missing choice becomes auto', () => {
  const a = { messages: [], tool_choice: 'none' }
  applyFingerprint(a)
  assert.equal(a.tool_choice, 'auto')

  const b = { messages: [], tool_choice: { type: 'none' } }
  applyFingerprint(b)
  assert.equal(b.tool_choice, 'auto')

  const c = { messages: [] }
  applyFingerprint(c)
  assert.equal(c.tool_choice, 'auto')

  const d = { messages: [], tool_choice: 'required' }
  applyFingerprint(d)
  assert.equal(d.tool_choice, 'required')
})

test('case variants pass through without aliasing', () => {
  const upper = { type: 'function', function: { name: 'Read', description: 'totally different', parameters: {} } }
  const body = { messages: [], tools: [upper] }
  const result = applyFingerprint(body)
  assert.equal(result.renamed.length, 0)
  assert.equal(body.tools[0].function.name, 'Read')
})

test('declaredToolNames reads both shapes', () => {
  const names = [...declaredToolNames({ tools: [officialRead, { name: 'flat' }] })].sort()
  assert.deepEqual(names, ['flat', 'read'])
})

// ---------------------------------------------------------------- transform

test('effort maps to max_tokens on opencode; explicit max_tokens wins', () => {
  const a = { messages: [], reasoning_effort: 'low' }
  applyRequestTransform(a, 'opencode')
  assert.equal(a.max_tokens, 2048)
  assert.equal(a.reasoning_effort, undefined)

  const b = { messages: [], reasoning_effort: 'high', max_tokens: 100 }
  applyRequestTransform(b, 'opencode')
  assert.equal(b.max_tokens, 100)

  const c = { messages: [], reasoning_effort: 'high' }
  applyRequestTransform(c, 'opencode')
  assert.equal(c.max_tokens, undefined)
})

test('effort maps to the reasoning object on kilo', () => {
  const a = { messages: [], reasoning_effort: 'medium' }
  applyRequestTransform(a, 'kilo')
  assert.deepEqual(a.reasoning, { effort: 'medium' })
  assert.equal(a.reasoning_effort, undefined)

  const b = { messages: [], reasoning_effort: 'high' }
  applyRequestTransform(b, 'kilo')
  assert.deepEqual(b.reasoning, { effort: 'high' })
})

test('a bare reasoning string is never sent on kilo (the gateway rejects it)', () => {
  const a = { messages: [], reasoning_effort: 'low' }
  applyRequestTransform(a, 'kilo')
  assert.equal(typeof a.reasoning, 'object')
  assert.notEqual(a.reasoning, null)
})

test('kilo reasoning spellings normalize to reasoning_content', () => {
  const acc = createAccumulator({ model: 'm' })
  acc.noteChunkMeta({ id: 'x', created: 1, choices: [{ index: 0, message: { role: 'assistant', content: 'ok', reasoning: 'thought-a' } }] })
  const final = acc.finalize()
  assert.equal(final.choices[0].message.reasoning_content, 'thought-a')
})

test('tool wire suppresses decoy calls and renumbers indices', () => {
  const wire = createToolWire({ declared: new Set(['my_tool']), aliases: new Map() })
  // upstream block index 2 (shared with thinking blocks)
  const v1 = wire.admit({ index: 2, id: 'c1', name: 'my_tool', argumentsDelta: '{"a"' })
  assert.equal(v1.kind, 'forward')
  assert.equal(v1.openAiIndex, 0)
  assert.equal(v1.first, true)
  const v2 = wire.admit({ index: 2, argumentsDelta: ':1}' })
  assert.equal(v2.kind, 'forward')
  assert.equal(v2.openAiIndex, 0)
  assert.equal(v2.args, ':1}')
  // decoy: model dials the injected `read`
  const v3 = wire.admit({ index: 3, id: 'c2', name: 'read', argumentsDelta: '{"path"' })
  assert.equal(v3.kind, 'drop')
  assert.equal(wire.suppressedCount, 1)
  const v4 = wire.admit({ index: 3, argumentsDelta: ':1}' })
  assert.equal(v4.kind, 'drop')
  // arguments held before the name arrives are released to a real tool
  const v5 = wire.admit({ index: 4, argumentsDelta: '{"x"' })
  assert.equal(v5.kind, 'drop')
  const v6 = wire.admit({ index: 4, id: 'c3', name: 'my_tool', argumentsDelta: ':2}' })
  assert.equal(v6.kind, 'forward')
  assert.equal(v6.openAiIndex, 1)
  assert.equal(v6.args, '{"x":2}')
  assert.equal(v6.first, true)
})

test('suppressedOnlyNote fires only for pure-decoy turns', () => {
  const wire = createToolWire({ declared: new Set(), aliases: new Map() })
  wire.admit({ index: 1, id: 'c1', name: 'read', argumentsDelta: '{}' })
  assert.match(wire.suppressedOnlyNote({ text: '', toolCalls: [], truncated: false }), /re-send it with that tool declared/)
  assert.equal(wire.suppressedOnlyNote({ text: 'answer', toolCalls: [], truncated: false }), null)
  assert.equal(wire.suppressedOnlyNote({ text: '', toolCalls: [{ name: 'my_tool' }], truncated: false }), null)
  assert.equal(wire.suppressedOnlyNote({ text: '', toolCalls: [], truncated: true }), null)
})

test('accumulator finalizes a complete OpenAI object', () => {
  const acc = createAccumulator({ model: 'm' })
  acc.noteChunkMeta({ id: 'x', created: 1, usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 } })
  acc.noteText('Hel')
  acc.noteText('lo')
  acc.noteReasoning('thin')
  acc.noteFinish('stop')
  acc.noteForwardedCall({ openAiIndex: 0, id: 'c1', name: 'my_tool', args: '{"a":1}' })
  const final = acc.finalize()
  assert.equal(final.id, 'x')
  assert.equal(final.choices[0].message.content, 'Hello')
  assert.equal(final.choices[0].message.reasoning_content, 'thin')
  assert.equal(final.choices[0].message.tool_calls[0].function.name, 'my_tool')
  assert.equal(final.choices[0].message.tool_calls[0].function.arguments, '{"a":1}')
  assert.equal(final.usage.total_tokens, 7)
})

// ---------------------------------------------------------------- seeds

test('seed is stable across turns of one conversation', () => {
  const turn1 = { model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hello world' }] }
  const turn2 = {
    model: 'deepseek-v4.1-flash-free',
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello world' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'more' },
    ],
  }
  assert.equal(seedForRequest(turn1), seedForRequest(turn2))
  const other = { model: 'kilo/x', messages: [{ role: 'user', content: 'hello world' }] }
  assert.notEqual(seedForRequest(turn1), seedForRequest(other))
})
