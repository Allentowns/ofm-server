import test from 'node:test'
import assert from 'node:assert/strict'
import {
  AnthropicStream, anthropicMessage, countTokens, effortForTopic,
  flattenSystem, fromAnthropicRequest,
} from '../lib/anthropic.js'

// ---------------------------------------------------------------- request conversion

test('system is hoisted and message roles map to the chat wire', () => {
  const { body, effort } = fromAnthropicRequest({
    model: 'deepseek-v4.1-flash-free',
    system: [{ type: 'text', text: 'be terse' }, { type: 'text', text: 'be kind' }],
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      { role: 'user', content: 'again' },
    ],
    max_tokens: 100,
    thinking: { type: 'enabled', budget_tokens: 9000 },
  })
  assert.equal(body.messages[0].role, 'system')
  assert.equal(body.messages[0].content, 'be terse\n\nbe kind')
  assert.deepEqual(body.messages.slice(1).map(m => m.role), ['user', 'assistant', 'user'])
  assert.equal(body.messages[1].content, 'hi', 'a single text part is a plain string')
  assert.equal(body.max_tokens, 100)
  assert.equal(effort, 'high', 'budget 9000 falls in the high band')
})

test('tool definitions and tool_result blocks are converted', () => {
  const { body } = fromAnthropicRequest({
    model: 'm',
    messages: [
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Tokyo' } }],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'sunny' }] },
    ],
    tools: [{ name: 'get_weather', description: 'x', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
  })
  assert.equal(body.tools[0].type, 'function')
  assert.equal(body.tools[0].function.name, 'get_weather')
  assert.equal(body.tools[0].function.parameters.properties.city.type, 'string')

  const assistant = body.messages.find(m => m.role === 'assistant')
  assert.equal(assistant.tool_calls[0].id, 'toolu_1')
  assert.equal(assistant.tool_calls[0].function.name, 'get_weather')
  assert.equal(assistant.tool_calls[0].function.arguments, '{"city":"Tokyo"}')

  const tool = body.messages.find(m => m.role === 'tool')
  assert.equal(tool.tool_call_id, 'toolu_1')
  assert.equal(tool.content, 'sunny')
})

test('images become image_url parts', () => {
  const { body } = fromAnthropicRequest({
    model: 'm',
    messages: [{ role: 'user', content: [
      { type: 'text', text: 'what is this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
    ] }],
  })
  const user = body.messages[0]
  assert.ok(Array.isArray(user.content))
  assert.equal(user.content[1].type, 'image_url')
  assert.match(user.content[1].image_url.url, /^data:image\/png;base64,AAA$/)
})

test('invalid requests are refused with a usable message', () => {
  assert.match(fromAnthropicRequest(null).error, /JSON object/)
  assert.match(fromAnthropicRequest({ messages: [] }).error, /`model` is required/)
  assert.match(fromAnthropicRequest({ model: 'm', messages: [] }).error, /non-empty/)
  assert.match(fromAnthropicRequest({ model: 'm', messages: [{ role: 'user', content: [] }] }).error, /no convertible content/)
})

test('thinking levels map onto effort bands', () => {
  assert.equal(effortForTopic({ type: 'disabled' }), 'low')
  assert.equal(effortForTopic({ type: 'enabled', budget_tokens: 1024 }), 'low')
  assert.equal(effortForTopic({ type: 'enabled', budget_tokens: 4096 }), 'medium')
  assert.equal(effortForTopic({ type: 'enabled', budget_tokens: 32768 }), 'high')
  assert.equal(effortForTopic(undefined), undefined)
})

test('flattenSystem accepts a bare string and block arrays', () => {
  assert.equal(flattenSystem('a'), 'a')
  assert.equal(flattenSystem([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\n\nb')
  assert.equal(flattenSystem(undefined), '')
})

// ---------------------------------------------------------------- streaming frames

const parseFrames = text => text.split('\n\n').filter(Boolean).map(block => {
  const lines = block.split('\n')
  const event = lines.find(line => line.startsWith('event: '))?.slice(7)
  const data = lines.find(line => line.startsWith('data: '))?.slice(6)
  return { event, data: data ? JSON.parse(data) : null }
})

test('stream frames follow the Anthropic block discipline', () => {
  const renderer = new AnthropicStream({ model: 'm', messageId: 'msg_1', inputTokens: 7 })
  const out = []
  renderer.start(out)
  renderer.thinking(out, 'hmm')
  renderer.text(out, 'Hel')
  renderer.text(out, 'lo')
  renderer.toolDelta(out, { index: 0, args: '{"ci' })
  renderer.toolDelta(out, { index: 0, id: 'toolu_1', name: 'get_weather' })
  renderer.toolDelta(out, { index: 0, args: 'ty":1}' })
  renderer.noteUsage(out, { prompt_tokens: 12, completion_tokens: 5 })
  renderer.finish(out, { truncated: false })

  const frames = parseFrames(out.join(''))
  const types = frames.map(f => f.event)
  assert.equal(types[0], 'message_start')
  assert.equal(types[types.length - 1], 'message_stop')
  assert.ok(types.includes('content_block_start'))
  assert.ok(types.includes('content_block_delta'))
  assert.ok(types.includes('content_block_stop'))
  assert.equal(types.filter(t => t === 'message_start').length, 1)
  assert.equal(types.filter(t => t === 'message_stop').length, 1)

  // message_start carries the seeded input count
  assert.equal(frames[0].data.message.usage.input_tokens, 7)

  // block indices start at 0 and increase
  const starts = frames.filter(f => f.event === 'content_block_start')
  assert.deepEqual(starts.map(f => f.data.index), [0, 1, 2])
  assert.deepEqual(starts.map(f => f.data.content_block.type), ['thinking', 'text', 'tool_use'])

  // the tool block is announced only once its name is known, and the held
  // argument prefix goes out before the later fragment
  const toolBlock = starts[2].data
  assert.equal(toolBlock.content_block.name, 'get_weather')
  const jsonDeltas = frames
    .filter(f => f.event === 'content_block_delta' && f.data.delta.type === 'input_json_delta')
    .map(f => f.data.delta.partial_json)
  assert.deepEqual(jsonDeltas, ['{"ci', 'ty":1}'])

  // terminal delta reports tool_use and the real usage
  const delta = frames.find(f => f.event === 'message_delta')
  assert.equal(delta.data.delta.stop_reason, 'tool_use')
  assert.equal(delta.data.usage.input_tokens, 12)
  assert.equal(delta.data.usage.output_tokens, 5)
})

test('a truncated turn reports max_tokens even with tool blocks open', () => {
  const renderer = new AnthropicStream({ model: 'm', messageId: 'msg_2' })
  const out = []
  renderer.start(out)
  renderer.text(out, 'partial')
  renderer.finish(out, { truncated: true })
  const delta = parseFrames(out.join('')).find(f => f.event === 'message_delta')
  assert.equal(delta.data.delta.stop_reason, 'max_tokens')
})

test('a nameless tool call is never announced', () => {
  const renderer = new AnthropicStream({ model: 'm', messageId: 'msg_3' })
  const out = []
  renderer.start(out)
  renderer.toolDelta(out, { index: 0, args: '{"a":1}' })
  renderer.finish(out, { truncated: false })
  const frames = parseFrames(out.join(''))
  assert.equal(frames.filter(f => f.event === 'content_block_start').length, 0)
  assert.equal(frames.find(f => f.event === 'message_delta').data.delta.stop_reason, 'end_turn')
})

test('a failed turn emits error then message_stop and no stop_reason', () => {
  const renderer = new AnthropicStream({ model: 'm', messageId: 'msg_4' })
  const out = []
  renderer.start(out)
  renderer.fail(out, 'upstream exploded')
  const frames = parseFrames(out.join(''))
  assert.deepEqual(frames.map(f => f.event), ['message_start', 'error', 'message_stop'])
  assert.equal(frames[1].data.error.message, 'upstream exploded')
  assert.equal(renderer.stopReason, null)
})

// ---------------------------------------------------------------- non-streaming

test('the message object orders thinking, text, then tool_use', () => {
  const message = anthropicMessage({
    text: 'answer',
    thinking: 'reasoning',
    toolCalls: [{ id: 'toolu_1', name: 'get_weather', arguments: '{"city":"Tokyo"}' }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
    model: 'm',
    id: 'msg_5',
  })
  assert.deepEqual(message.content.map(b => b.type), ['thinking', 'text', 'tool_use'])
  assert.deepEqual(message.content[2].input, { city: 'Tokyo' })
  assert.equal(message.stop_reason, 'tool_use')
  assert.deepEqual(message.usage, { input_tokens: 10, output_tokens: 4 })
})

test('unparseable tool arguments degrade to an empty input object', () => {
  const message = anthropicMessage({
    toolCalls: [{ id: 'toolu_1', name: 'f', arguments: '{"broken' }],
    model: 'm', id: 'msg_6',
  })
  assert.deepEqual(message.content[0].input, {})
})

test('a truncated turn reports max_tokens, not tool_use', () => {
  const message = anthropicMessage({
    toolCalls: [{ id: 'toolu_1', name: 'f', arguments: '{}' }],
    truncated: true,
    model: 'm', id: 'msg_7',
  })
  assert.equal(message.stop_reason, 'max_tokens')
})

// ---------------------------------------------------------------- count_tokens

test('countTokens estimates from text, images and tools', () => {
  const small = countTokens({ messages: [{ role: 'user', content: 'hi' }] })
  assert.ok(small.input_tokens >= 16)

  const bigger = countTokens({ messages: [{ role: 'user', content: 'x'.repeat(400) }] })
  assert.ok(bigger.input_tokens > small.input_tokens)

  const withImage = countTokens({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'a' } }] }] })
  assert.ok(withImage.input_tokens >= 1024)

  const withTool = countTokens({
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }],
  })
  assert.ok(withTool.input_tokens > small.input_tokens)
})
