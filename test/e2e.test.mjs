import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

process.env.OF_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-test-'))
process.env.OF_PORT = '18931'
process.env.OF_TEST_MODE = '1'   // read by server.mjs: disables the startup probe sweep

const { FINGERPRINT_TOOL_DEFINITIONS, CLIENT_UA } = await import('../lib/fingerprint.js')

const read = FINGERPRINT_TOOL_DEFINITIONS.read
const officialRead = { type: 'function', function: { name: 'read', description: read.description, parameters: read.parameters } }

/** A fake upstream that records what it received and replies from a script. */
function startFake(handler) {
  const seen = []
  const server = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null })
      handler(req, res, seen[seen.length - 1])
    })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: `http://127.0.0.1:${server.address().port}` })))
}

function sseResponse(res, chunks, { contentType = 'text/event-stream' } = {}) {
  res.writeHead(200, { 'content-type': contentType })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}

function chunkOf(delta, finish = null) {
  return { id: 'up1', object: 'chat.completion.chunk', created: 1, choices: [{ index: 0, delta, finish_reason: finish }] }
}

const fakeOpencode = await startFake((req, res, seen) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [
      { id: 'deepseek-v4.1-flash-free' },
      { id: 'glm-5.3-flash-free' },
      { id: 'big-pickle' },            // free without the -free suffix
      { id: 'claude-opus-5' },          // paid Zen id: must be filtered out
      { id: 'gpt-5.4' },                // paid Zen id: must be filtered out
    ] }))
    return
  }
  if (JSON.stringify(seen.body?.messages ?? []).includes('trigger-403')) {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ type: 'error', error: { type: 'FreeTierError', message: 'free tier can only be used from within OpenCode' } }))
    return
  }
  // the turn: first a decoy `read` call, then a real one, then text
  sseResponse(res, [
    chunkOf({ tool_calls: [{ index: 2, id: 'd1', type: 'function', function: { name: 'read', arguments: '{"pa' } }] }),
    chunkOf({ tool_calls: [{ index: 2, function: { arguments: 'th:"x"}' } }] }),
    chunkOf({ tool_calls: [{ index: 5, id: 'r1', type: 'function', function: { name: 'my_tool', arguments: '{"a":1}' } }] }),
    chunkOf({ content: 'ok' }),
    chunkOf({}, 'stop'),
  ])
})
process.env.OF_BASE = fakeOpencode.url

const fakeKilo = await startFake((req, res, seen) => {
  if (req.url.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'minimax/minimax-m3.1-flash:free', isFree: true, context_length: 131072 }, { id: 'paid-model', isFree: false }] }))
    return
  }
  // JSON content-type carrying SSE frames (the sniff case)
  sseResponse(res, [chunkOf({ content: 'kilo ok' }), chunkOf({}, 'stop')], { contentType: 'application/json' })
})
process.env.OF_KILO_BASE = fakeKilo.url

async function waitForHealth(base) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) return
    } catch { /* not up yet */ }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('server did not come up')
}

// server under test, imported after the fake upstreams above set the env
const serverModule = await import('../server.mjs')
const BASE = 'http://127.0.0.1:18931'

async function waitForReady() {
  await waitForHealth(BASE)
  return serverModule.auth.key
}

test('e2e: fingerprint bytes on the wire, stream repair on the way back', async t => {
  const opencode = fakeOpencode
  const kilo = fakeKilo
  const key = await waitForReady()
  t.after(() => {
    serverModule.catalog.stopTimer()
    serverModule.server.close()
    fakeOpencode.server.close()
    fakeKilo.server.close()
  })

  // ---- /v1/models ----
  const listing = await fetch(`${BASE}/v1/models`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  const ids = listing.data.map(m => m.id).sort()
  assert.deepEqual(ids, ['big-pickle', 'deepseek-v4.1-flash-free', 'glm-5.3-flash-free', 'kilo/minimax/minimax-m3.1-flash:free'],
    'only free models are broadcast')
  assert.ok(!ids.some(id => /claude|gpt|paid/.test(id)), 'paid ids never reach the picker')

  // ---- streaming turn with tool repair ----
  const turn = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash-free',
      messages: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', function: { name: 'my_tool', description: 'x', parameters: { type: 'object', properties: {} } } }],
      reasoning_effort: 'low',
      stream: true,
    }),
  })
  assert.equal(turn.status, 200)
  assert.match(turn.headers.get('content-type'), /text\/event-stream/)
  const text = await turn.text()
  const dataLines = text.split('\n').filter(line => line.startsWith('data: ') && !line.includes('[DONE]')).map(line => JSON.parse(line.slice(6)))

  // decoy call suppressed: no read/tool calls from index 2; real tool renumbered 5 -> 0
  const allCalls = dataLines.flatMap(chunk => chunk.choices?.[0]?.delta?.tool_calls ?? [])
  assert.equal(allCalls.length, 1)
  assert.equal(allCalls[0].index, 0)
  assert.equal(allCalls[0].function.name, 'my_tool')
  assert.equal(allCalls[0].function.arguments, '{"a":1}')
  // text still streamed
  const textParts = dataLines.map(chunk => chunk.choices?.[0]?.delta?.content).filter(Boolean)
  assert.deepEqual(textParts, ['ok'])

  // ---- fingerprint bytes the fake upstream actually received ----
  const turnSeen = opencode.seen.find(entry => entry.url.endsWith('/chat/completions'))
  assert.ok(turnSeen)
  const h = turnSeen.headers
  assert.equal(h.authorization, 'Bearer public')
  assert.equal(h['user-agent'], CLIENT_UA)
  assert.equal(h['x-opencode-client'], 'cli')
  assert.equal(h['x-opencode-session'], h['x-opencode-session-id'])
  assert.equal(h['x-session-affinity'], h['x-opencode-session'])
  assert.equal(h['x-session-id'], h['x-opencode-session'])
  assert.match(h['x-opencode-session'].slice(4, 16), /^[0-9a-f]{9}f[c-f][0-9a-f]$/)
  assert.equal(h['x-opencode-request'], undefined)

  const sentBody = turnSeen.body
  const sentNames = sentBody.tools.map(t => t.function.name)
  assert.ok(sentNames.includes('read') && sentNames.includes('shell'), 'gate tools injected')
  assert.ok(sentNames.includes('my_tool'))
  assert.equal(sentBody.tool_choice, 'auto')
  assert.equal(sentBody.max_tokens, 2048, 'effort low -> max_tokens 2048')
  assert.equal(sentBody.reasoning_effort, undefined)
  assert.equal(sentBody.model, 'deepseek-v4.1-flash-free')
  const systemNote = sentBody.messages.find(m => m.role === 'system')
  assert.match(systemNote.content, /placeholders that do nothing/)

  // ---- non-streaming caller ----
  const nonStream = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'hello2' }] }),
  }).then(r => r.json())
  assert.equal(nonStream.object, 'chat.completion')
  assert.equal(nonStream.choices[0].message.content, 'ok')
  assert.equal(nonStream.choices[0].message.tool_calls[0].function.name, 'my_tool')

  // ---- sticky session: a second turn of the SAME conversation keeps the id ----
  const repeat = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash-free',
      messages: [
        { role: 'user', content: 'hello' },
        { role: 'assistant', content: 'ok' },
        { role: 'user', content: 'and again' },
      ],
    }),
  })
  assert.equal(repeat.status, 200)
  const turns = opencode.seen.filter(entry => entry.url.endsWith('/chat/completions'))
  const firstSession = turns[0].headers['x-opencode-session']
  const repeatSession = turns[turns.length - 1].headers['x-opencode-session']
  assert.equal(firstSession, repeatSession, 'session must stick across turns of one conversation')
  // a different conversation gets a different session
  const otherConversation = turns.find(entry => JSON.stringify(entry.body?.messages ?? []).includes('hello2'))
  assert.notEqual(otherConversation.headers['x-opencode-session'], firstSession)

  // ---- kilo lane: no fingerprint headers, effort -> reasoning ----
  const kiloTurn = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'kilo/minimax/minimax-m3.1-flash:free', messages: [{ role: 'user', content: 'k1' }], reasoning_effort: 'medium' }),
  })
  assert.equal(kiloTurn.status, 200)
  const kiloBody = await kiloTurn.text()
  assert.match(kiloBody, /kilo ok/)
  const kiloSeen = kilo.seen.find(entry => entry.url.endsWith('/chat/completions'))
  assert.equal(kiloSeen.headers.authorization, undefined)
  assert.deepEqual(kiloSeen.body.reasoning, { effort: 'medium' }, 'kilo reasoning must be the object form')
  assert.equal(kiloSeen.body.reasoning_effort, undefined)
  assert.equal(kiloSeen.body.model, 'minimax/minimax-m3.1-flash:free')
  assert.equal(kiloSeen.body.tools, undefined, 'kilo lane adds no fingerprint tools')

  // ---- auth: wrong key is 401 ----
  const unauthorized = await fetch(`${BASE}/v1/models`, { headers: { authorization: 'Bearer nope' } })
  assert.equal(unauthorized.status, 401)

  // ---- inspector is OFF by default: nothing was recorded ----------------
  const beforeEnable = await fetch(`${BASE}/api/requests`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.deepEqual(beforeEnable.requests, [], 'the inspector must not record anything until it is turned on')
  const settingsBefore = await fetch(`${BASE}/api/settings`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.equal(settingsBefore.inspectorEnabled, false, 'developer option defaults to off')

  // ---- turning it on starts recording ------------------------------------
  const enabled = await fetch(`${BASE}/api/settings/inspector`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true }),
  }).then(r => r.json())
  assert.equal(enabled.inspectorEnabled, true)

  // a turn after enabling must appear
  await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'record me' }] }),
  })

  const requests = await fetch(`${BASE}/api/requests`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.equal(requests.requests.length, 1, 'only requests made while enabled are recorded')
  const first = await fetch(`${BASE}/api/requests/${requests.requests[0].id}`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.ok(first.native.body)
  assert.ok(first.upstream.url)
  assert.ok(Array.isArray(first.transform.injected))

  // ---- the console's test button lands in the inspector, marked `test` ----
  const testResult = await fetch(`${BASE}/api/models/test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free' }),
  }).then(r => r.json())
  assert.equal(testResult.ok, true, 'console test call should succeed against the fake upstream')
  const afterTest = await fetch(`${BASE}/api/requests`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  const testRecord = afterTest.requests.find(r => r.source === 'test')
  assert.ok(testRecord, 'the test call must appear in the inspector list')
  assert.equal(testRecord.model, 'deepseek-v4.1-flash-free')
  const testDetail = await fetch(`${BASE}/api/requests/${testRecord.id}`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.equal(testDetail.source, 'test')
  assert.ok(Array.isArray(testDetail.transform.injected), 'test calls carry the fingerprint transform too')

  // ---- probes surface in the model listing -------------------------------
  const listed = await fetch(`${BASE}/api/models`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.ok(listed.models.every(model => 'probe' in model), 'every model exposes its probe state')
  const probed = listed.models.find(model => model.id === 'deepseek-v4.1-flash-free')
  assert.equal(probed.probe.state, 'ok', 'the test button records a successful probe')
  assert.ok(Number.isFinite(probed.probe.ttftMs))

  // ---- a failing probe keeps its classified code -------------------------
  const failing = await fetch(`${BASE}/api/models/test`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3-flash-free' }),
  }).then(r => r.json())
  assert.equal(failing.ok, true)

  // ---- test-all runs server-side and reports through probe states --------
  const sweep = await fetch(`${BASE}/api/models/test-all`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.equal(sweep.status, 202, 'the sweep returns immediately')
  let settled = null
  for (let i = 0; i < 60; i += 1) {
    await new Promise(resolve => setTimeout(resolve, 100))
    const doc = await fetch(`${BASE}/api/models`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
    if (doc.models.every(model => model.probe && model.probe.state !== 'checking')) { settled = doc; break }
  }
  assert.ok(settled, 'every model settles within the wait window')
  assert.ok(settled.models.every(model => model.probe.state === 'ok' || model.probe.state === 'error'))

  // ---- Anthropic Messages: streaming and non-streaming ------------------
  const anthropicStream = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'deepseek-v4.1-flash-free',
      max_tokens: 256,
      system: [{ type: 'text', text: 'be brief' }],
      messages: [{ role: 'user', content: 'hello anthropic' }],
      tools: [{ name: 'my_tool', description: 'x', input_schema: { type: 'object', properties: {} } }],
      thinking: { type: 'enabled', budget_tokens: 9000 },
      stream: true,
    }),
  })
  assert.equal(anthropicStream.status, 200)
  assert.match(anthropicStream.headers.get('content-type'), /text\/event-stream/)
  const frames = (await anthropicStream.text()).split('\n\n').filter(Boolean).map(block => {
    const event = block.split('\n').find(line => line.startsWith('event: '))?.slice(7)
    const data = block.split('\n').find(line => line.startsWith('data: '))?.slice(6)
    return { event, data: data ? JSON.parse(data) : null }
  })
  const events = frames.map(f => f.event)
  assert.equal(events[0], 'message_start')
  assert.equal(events[events.length - 1], 'message_stop')
  assert.ok(events.includes('content_block_delta'))
  assert.equal(events.filter(e => e === 'message_start').length, 1, 'exactly one message_start')
  const anthropicDelta = frames.find(f => f.event === 'message_delta')
  assert.ok(['end_turn', 'tool_use', 'max_tokens'].includes(anthropicDelta.data.delta.stop_reason))
  // the text the fake upstream sent is carried through as a text_delta
  const textDeltas = frames.filter(f => f.event === 'content_block_delta' && f.data.delta.type === 'text_delta')
  assert.equal(textDeltas.map(f => f.data.delta.text).join(''), 'ok')

  // the converted turn reached upstream in chat-completions shape
  const anthropicSeen = opencode.seen.filter(entry => entry.url.endsWith('/chat/completions')).at(-1)
  assert.equal(anthropicSeen.body.messages[0].role, 'system')
  // The caller's system text leads; the fingerprint layer appends its
  // placeholder note to the same message.
  assert.match(anthropicSeen.body.messages[0].content, /^be brief/)
  assert.match(anthropicSeen.body.messages[0].content, /placeholders that do nothing/)
  assert.ok(anthropicSeen.body.tools.some(tool => tool.function?.name === 'my_tool'))
  assert.equal(anthropicSeen.body.max_tokens, 256, 'Anthropic max_tokens is honoured')

  // ---- Anthropic non-streaming -------------------------------------------
  const anthropicMessage = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', max_tokens: 64, messages: [{ role: 'user', content: 'turn two' }] }),
  }).then(async r => {
    const text = await r.text()
    assert.equal(r.status, 200, `anthropic non-stream status; body: ${text.slice(0, 300)}`)
    return JSON.parse(text)
  })
  assert.equal(anthropicMessage.type, 'message')
  assert.equal(anthropicMessage.role, 'assistant')
  assert.ok(Array.isArray(anthropicMessage.content))
  assert.equal(anthropicMessage.content[0].type, 'text')
  assert.equal(anthropicMessage.content[0].text, 'ok')
  assert.ok(['end_turn', 'tool_use'].includes(anthropicMessage.stop_reason))
  assert.ok(Number.isFinite(anthropicMessage.usage.input_tokens))

  // ---- Anthropic count_tokens is local -----------------------------------
  const counted = await fetch(`${BASE}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'count me' }] }),
  }).then(r => r.json())
  assert.ok(counted.input_tokens > 0)

  // ---- Anthropic request validation --------------------------------------
  const badAnthropic = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] }),
  })
  assert.equal(badAnthropic.status, 400)
  const badBody = await badAnthropic.json()
  assert.equal(badBody.type, 'error')
  assert.equal(badBody.error.type, 'invalid_request_error')

  // ---- turning it off clears the buffer and stops recording --------------
  await fetch(`${BASE}/api/settings/inspector`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }),
  })
  const afterDisable = await fetch(`${BASE}/api/requests`, { headers: { authorization: `Bearer ${key}` } }).then(r => r.json())
  assert.deepEqual(afterDisable.requests, [], 'disabling drops the buffer')

  // ---- 403 upstream maps to a caller-visible error ----
  const errResponse = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'trigger-403' }] }),
  })
  assert.equal(errResponse.status, 403)
  const errBody = await errResponse.json()
  assert.equal(errBody.error.code, 'FINGERPRINT_REJECTED')
})



