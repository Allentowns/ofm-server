/**
 * Anthropic Messages support: `POST /v1/messages` and
 * `POST /v1/messages/count_tokens`.
 *
 * The lanes speak OpenAI Chat Completions, so this module is a two-way
 * translator — modeled on dsh-our-free-model's src/anthropic.js, reduced to the
 * field set this server can actually honour:
 *
 *   request  : Anthropic Messages  -> chat-completions body (+ effort)
 *   stream   : OpenAI delta chunks -> `event: …\ndata: …\n\n` frames
 *   response : assembled outcome   -> one Anthropic Message object
 *   counting : local estimate      -> { input_tokens }
 *
 * Consequences worth stating up front:
 * - Anthropic's `system` is hoisted into an OpenAI `system` message; `tools`
 *   `input_schema` becomes OpenAI `function.parameters`; `tool_result` blocks
 *   become `role:"tool"` messages.
 * - A `thinking` block is carried out as `{type:'thinking', thinking}` with no
 *   `signature`. No valid signature exists on this side, and an empty string
 *   would be a claim a replaying client cannot verify.
 * - `count_tokens` is an estimate (one token per four characters, flat 1024 per
 *   image). No tokenizer ships with this service.
 *
 * @module lib/anthropic.js
 */

const CHARS_PER_TOKEN = 4
const IMAGE_TOKENS = 1024
const TOOL_FRAME_TOKENS = 8
const BASE_TOKENS = 16

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const number = value => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)
const string = value => (typeof value === 'string' ? value : '')

/** Flatten Anthropic's `system` (string | text blocks) into one string. */
export function flattenSystem(system) {
  if (typeof system === 'string') return system
  if (!Array.isArray(system)) return ''
  return system
    .map(block => (typeof block === 'string' ? block : block?.type === 'text' ? string(block.text) : ''))
    .filter(part => part !== '')
    .join('\n\n')
}

/** An Anthropic image source -> an OpenAI `image_url` content part. */
function imagePart(source) {
  if (!isObject(source)) return undefined
  if (source.type === 'base64' && typeof source.data === 'string') {
    const media = typeof source.media_type === 'string' ? source.media_type : 'image/png'
    return { type: 'image_url', image_url: { url: `data:${media};base64,${source.data}` } }
  }
  if (source.type === 'url' && typeof source.url === 'string') {
    return { type: 'image_url', image_url: { url: source.url } }
  }
  return undefined
}

/** Tool-result content -> OpenAI `tool` message content. */
function toolResultContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block?.type === 'text') parts.push(string(block.text))
    else if (block?.type === 'image') {
      const image = imagePart(block.source)
      // OpenAI's `tool` role cannot carry an image part on the lanes we drive;
      // naming it keeps the model from being told a picture silently vanished.
      parts.push(image ? '[image omitted: this endpoint cannot carry images in a tool result]' : '')
    }
  }
  return parts.filter(part => part !== '').join('\n\n')
}

/** Assistant blocks -> OpenAI assistant message content + tool_calls. */
function assistantTurn(blocks) {
  const content = []
  const toolCalls = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') content.push(block.text)
    else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: string(block.id) || `call_${toolCalls.length}`,
        type: 'function',
        function: { name: string(block.name), arguments: JSON.stringify(isObject(block.input) ? block.input : {}) },
      })
    }
    // `thinking` / `redacted_thinking` blocks are dropped: they carry no
    // verifiable signature on this side, and the lanes do not accept them back.
  }
  const message = { role: 'assistant', content: content.join('\n\n') === '' ? null : content.join('\n\n') }
  if (toolCalls.length > 0) message.tool_calls = toolCalls
  return content.length > 0 || toolCalls.length > 0 ? message : null
}

/** Anthropic `thinking` config -> the effort level this server understands. */
export function effortForTopic(thinking) {
  if (!isObject(thinking)) return undefined
  if (thinking.type === 'disabled') return 'low'
  const budget = number(thinking.budget_tokens)
  if (budget === undefined) return 'medium'
  if (budget <= 2048) return 'low'
  if (budget <= 8192) return 'medium'
  return 'high'
}

/**
 * Convert one Anthropic Messages request into this server's internal body.
 * Returns `{ body, stream, effort, model }` or `{ error }`.
 */
export function fromAnthropicRequest(raw) {
  if (!isObject(raw)) return { error: 'the request body must be a JSON object' }
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (model === '') return { error: '`model` is required' }
  if (!Array.isArray(raw.messages) || raw.messages.length === 0) return { error: '`messages` must be a non-empty array' }

  let system = flattenSystem(raw.system)
  const messages = []

  for (const row of raw.messages) {
    if (!isObject(row)) continue
    const blocks = Array.isArray(row.content)
      ? row.content
      : typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : []

    // Anthropic has no system role inside `messages`; hoist it rather than 400.
    if (row.role === 'system' || row.role === 'developer') {
      const text = blocks
        .map(block => (typeof block === 'string' ? block : block?.type === 'text' ? string(block.text) : ''))
        .filter(part => part !== '')
        .join('\n\n')
      if (text !== '') system = system === '' ? text : `${system}\n\n${text}`
      continue
    }

    if (row.role === 'assistant') {
      const message = assistantTurn(blocks)
      if (message !== null) messages.push(message)
      continue
    }

    // user (and anything unrecognized): text/image blocks become one user turn,
    // tool_result blocks become their own `tool` rows.
    const content = []
    for (const block of blocks) {
      if (block?.type === 'tool_result') {
        messages.push({
          role: 'tool',
          tool_call_id: string(block.tool_use_id),
          content: toolResultContent(block.content),
        })
        continue
      }
      if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') {
        content.push({ type: 'text', text: block.text })
        continue
      }
      if (block?.type === 'image') {
        const image = imagePart(block.source)
        if (image !== undefined) content.push(image)
      }
    }
    if (content.length > 0) {
      // A single text part is sent as a plain string: the lanes accept both, and
      // the string form keeps prompts readable in the inspector.
      messages.push({
        role: 'user',
        content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
      })
    }
  }

  if (messages.length === 0) return { error: 'the request carried no convertible content' }

  const tools = []
  for (const tool of Array.isArray(raw.tools) ? raw.tools : []) {
    if (!isObject(tool)) continue
    const name = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (name === '') continue
    tools.push({
      type: 'function',
      function: {
        name,
        description: string(tool.description),
        parameters: isObject(tool.input_schema) ? tool.input_schema : { type: 'object', properties: {} },
      },
    })
  }

  if (system !== '') messages.unshift({ role: 'system', content: system })

  const body = { model, messages, stream: true }
  const maxTokens = number(raw.max_tokens)
  if (maxTokens !== undefined && maxTokens > 0) body.max_tokens = maxTokens
  const temperature = number(raw.temperature)
  if (temperature !== undefined) body.temperature = temperature
  if (tools.length > 0) body.tools = tools

  return {
    body,
    model,
    stream: raw.stream === true,
    effort: effortForTopic(raw.thinking),
  }
}

/** One complete Anthropic SSE frame. */
function frame(event, payload) {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
}

/**
 * Streaming renderer: turns the routed OpenAI deltas of one turn into the
 * Anthropic event sequence.
 *
 * Block discipline (what index-keyed clients rely on):
 * - one text block and one thinking block at a time, closed before the other
 *   opens; tool_use blocks are independent, so parallel calls stream at once;
 * - a tool_use block is announced only once its name is known — arguments that
 *   arrive before the name are held, because a block cannot be opened without
 *   a name and the client could not execute it;
 * - usage is reported in `message_start` (input) and `message_delta` (output).
 */
export class AnthropicStream {
  constructor({ model, messageId, inputTokens = 0 }) {
    this.model = model
    this.messageId = messageId
    this.started = false
    this.blockIndex = 0
    this.openKind = null
    this.openIndex = null
    this.toolSlots = new Map()
    this.inputTokens = inputTokens
    this.outputTokens = 0
    this.stopReason = null
    this.finished = false
  }

  _closeStreaming(out) {
    if (this.openKind !== 'text' && this.openKind !== 'thinking') return
    out.push(frame('content_block_stop', { type: 'content_block_stop', index: this.openIndex }))
    this.openKind = null
    this.openIndex = null
  }

  _openStreaming(out, kind) {
    if (this.openKind === kind) return
    this._closeStreaming(out)
    const index = this.blockIndex++
    this.openIndex = index
    this.openKind = kind
    out.push(frame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: kind === 'text' ? { type: 'text', text: '' } : { type: 'thinking', thinking: '' },
    }))
  }

  _slot(index) {
    let slot = this.toolSlots.get(index)
    if (slot === undefined) {
      slot = { block: null, open: false, id: '', name: '', held: '' }
      this.toolSlots.set(index, slot)
    }
    return slot
  }

  _openTool(out, slot) {
    this._closeStreaming(out)
    const index = this.blockIndex++
    slot.block = index
    slot.open = true
    this.openKind = 'tool_use'
    out.push(frame('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id: slot.id || `toolu_${index}`, name: slot.name, input: {} },
    }))
    if (slot.held !== '') {
      out.push(frame('content_block_delta', {
        type: 'content_block_delta',
        index,
        delta: { type: 'input_json_delta', partial_json: slot.held },
      }))
      slot.held = ''
    }
  }

  _closeTool(out, slot) {
    if (slot.open !== true) return
    out.push(frame('content_block_stop', { type: 'content_block_stop', index: slot.block }))
    slot.open = false
    if (![...this.toolSlots.values()].some(other => other.open === true) && this.openKind === 'tool_use') {
      this.openKind = null
    }
  }

  _closeAll(out) {
    this._closeStreaming(out)
    for (const slot of this.toolSlots.values()) this._closeTool(out, slot)
  }

  get hasToolBlock() {
    for (const slot of this.toolSlots.values()) if (slot.block !== null) return true
    return false
  }

  /** Feed one parsed routing result. */
  text(out, value) {
    if (typeof value !== 'string' || value === '') return
    this._openStreaming(out, 'text')
    out.push(frame('content_block_delta', { type: 'content_block_delta', index: this.openIndex, delta: { type: 'text_delta', text: value } }))
  }

  thinking(out, value) {
    if (typeof value !== 'string' || value === '') return
    this._openStreaming(out, 'thinking')
    out.push(frame('content_block_delta', { type: 'content_block_delta', index: this.openIndex, delta: { type: 'thinking_delta', thinking: value } }))
  }

  toolDelta(out, { index, id, name, args }) {
    const slot = this._slot(index)
    const fragment = typeof args === 'string' ? args : ''
    if (slot.open === true) {
      if (fragment !== '') {
        out.push(frame('content_block_delta', { type: 'content_block_delta', index: slot.block, delta: { type: 'input_json_delta', partial_json: fragment } }))
      }
      return
    }
    if (slot.name === '' && typeof name === 'string' && name !== '') slot.name = name
    if (slot.id === '' && typeof id === 'string' && id !== '') slot.id = id
    if (slot.name === '') { slot.held += fragment; return }
    this._openTool(out, slot)
    if (fragment !== '') {
      out.push(frame('content_block_delta', { type: 'content_block_delta', index: slot.block, delta: { type: 'input_json_delta', partial_json: fragment } }))
    }
  }

  /** Close a tool block whose final arguments arrived with the block end. */
  toolEnd(out, { index, id, name, args }) {
    const slot = this._slot(index)
    if (slot.open === true) { this._closeTool(out, slot); return }
    if (slot.name === '' && typeof name === 'string') slot.name = name
    if (slot.id === '' && typeof id === 'string') slot.id = id
    if (typeof args === 'string') slot.held = args
    if (slot.name === '') { slot.held = ''; return }
    this._openTool(out, slot)
    this._closeTool(out, slot)
  }

  noteUsage(out, usage) {
    if (!isObject(usage)) return
    const input = number(usage.prompt_tokens) ?? number(usage.input_tokens)
    const output = number(usage.completion_tokens) ?? number(usage.output_tokens)
    if (input !== undefined) this.inputTokens = input
    if (output !== undefined) this.outputTokens = output
  }

  /** Start the message. Called once, before any content frame. */
  start(out) {
    if (this.started) return
    this.started = true
    out.push(frame('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
      },
    }))
  }

  /** Terminal frames: message_delta + message_stop. */
  finish(out, { truncated = false } = {}) {
    this.started = true
    this.finished = true
    this._closeAll(out)
    const stopReason = truncated ? 'max_tokens' : this.hasToolBlock ? 'tool_use' : 'end_turn'
    this.stopReason = stopReason
    out.push(frame('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: this.inputTokens > 0
        ? { input_tokens: this.inputTokens, output_tokens: this.outputTokens }
        : { output_tokens: this.outputTokens },
    }))
    out.push(frame('message_stop', { type: 'message_stop' }))
  }

  /** Terminal frames for a failed turn: error + message_stop, no stop_reason. */
  fail(out, message, type = 'api_error') {
    this.started = true
    this.finished = true
    this._closeAll(out)
    this.stopReason = null
    out.push(frame('error', { type: 'error', error: { type, message } }))
    out.push(frame('message_stop', { type: 'message_stop' }))
  }
}

/** Tool arguments -> the `input` object of a `tool_use` block. */
function parseInput(argumentsText) {
  if (typeof argumentsText !== 'string' || argumentsText.trim() === '') return {}
  try {
    const parsed = JSON.parse(argumentsText)
    return isObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * Non-streaming: fold one turn's routed outcome into an Anthropic Message.
 * Content order is thinking, text, then one tool_use block per call.
 */
export function anthropicMessage({ text = '', thinking = '', toolCalls = [], usage, truncated = false, model, id }) {
  const content = []
  if (thinking !== '') content.push({ type: 'thinking', thinking })
  if (text !== '') content.push({ type: 'text', text })
  for (const call of toolCalls) {
    if (typeof call?.name !== 'string' || call.name === '') continue
    content.push({
      type: 'tool_use',
      id: String(call.id ?? ''),
      name: call.name,
      input: parseInput(call.arguments),
    })
  }
  const input = number(usage?.input_tokens) ?? number(usage?.prompt_tokens) ?? 0
  const output = number(usage?.output_tokens) ?? number(usage?.completion_tokens) ?? 0
  return {
    id: String(id ?? ''),
    type: 'message',
    role: 'assistant',
    model: String(model ?? ''),
    content,
    // A ceiling cut wins over a tool call: a call whose JSON the ceiling cut
    // mid-string is not executable, and reporting tool_use is how a client ends
    // up running a truncated call.
    stop_reason: truncated ? 'max_tokens' : content.some(block => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: input, output_tokens: output },
  }
}

/**
 * Local token estimate for `count_tokens`. One token per four characters, a
 * flat 1024 per image, 8 tokens of framing per tool, 16 tokens of overhead.
 */
export function countTokens(body) {
  let textChars = flattenSystem(body?.system).length
  let images = 0
  for (const row of Array.isArray(body?.messages) ? body.messages : []) {
    const blocks = Array.isArray(row?.content)
      ? row.content
      : typeof row?.content === 'string' ? [{ type: 'text', text: row.content }] : []
    for (const block of blocks) {
      if (block?.type === 'text') textChars += string(block.text).length
      else if (block?.type === 'image') images += 1
      else if (block?.type === 'tool_use') textChars += string(block.name).length + JSON.stringify(block.input ?? {}).length
      else if (block?.type === 'tool_result') {
        if (typeof block.content === 'string') textChars += block.content.length
        else if (Array.isArray(block.content)) {
          for (const inner of block.content) {
            if (inner?.type === 'text') textChars += string(inner.text).length
            else if (inner?.type === 'image') images += 1
          }
        }
      } else if (block?.type === 'thinking') textChars += string(block.thinking).length
      else if (block?.type === 'redacted_thinking') textChars += string(block.data).length
    }
  }
  let toolChars = 0
  let toolCount = 0
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    if (!isObject(tool)) continue
    toolCount += 1
    toolChars += string(tool.name).length + string(tool.description).length + JSON.stringify(tool.input_schema ?? {}).length
  }
  const toolTokens = toolCount === 0 ? 0 : Math.ceil(toolChars / CHARS_PER_TOKEN) + toolCount * TOOL_FRAME_TOKENS
  return { input_tokens: BASE_TOKENS + Math.ceil(textChars / CHARS_PER_TOKEN) + images * IMAGE_TOKENS + toolTokens }
}
