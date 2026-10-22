/**
 * Client-fingerprint layer for the OpenCode free lane (v2 shape, 2026-10-16).
 *
 * Ported from dsh-our-free-model src/upstream.js. Every string and rule below
 * was verified against the live gateway by that project; the v2 gate compares
 * request bytes against the official OpenCode CLI, and any rewording is a 403.
 *
 * Rules this module implements (each one was measured as a standalone 403):
 *  1. `read` and `shell` must be declared, with description and parameter
 *     schema byte-identical to the official v2.0.26 CLI definitions.
 *  2. A caller tool that happens to be named `read`/`shell` but carries a
 *     different definition is renamed to `<name>_client[N]`; history tool
 *     calls and `tool_choice` are retargeted to the alias, and the response
 *     side restores the caller's spelling.
 *  3. Duplicate declarations of the same gate name keep the first.
 *  4. `tool_choice: 'none'` is never emitted — v2 answers it with 403.
 *  5. Injected tools get a placeholder note in the system area so the model
 *     does not actually dial them.
 *
 * Session ids must carry the descending encoding `~(ts_ms << 12 | counter)`
 * with counter 1–63 (low 12 bits 0xfc0–0xfff). Ascending ids, sha256 digests
 * or any other random hex answer 403 even when every other byte is right.
 *
 * @module lib/fingerprint.js
 */

import crypto from 'node:crypto'

export const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
export const FINGERPRINT_TOOLS = ['read', 'shell']
export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/

/** The descending time layout the gate accepts: low 12 bits inside 0xfc0–0xfff. */
export const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/

/**
 * The two tools the v2 gate requires, verbatim from OpenCode v2.0.26 CLI.
 *
 * ⚠️ Do not reword, reformat, trim or "improve" these strings. The gate
 * compares the definitions themselves; v1's stub-with-placeholder trick died
 * with v1. Keep byte-identical with src/upstream.js FINGERPRINT_TOOL_DEFINITIONS.
 */
export const FINGERPRINT_TOOL_DEFINITIONS = {
  read: {
    description: 'Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File or directory to read' },
        offset: { type: 'integer', minimum: 0, description: 'The line or directory entry to start reading from (1-based)' },
        limit: { type: 'integer', minimum: 0, description: 'The maximum number of lines or directory entries to read (defaults to and capped at 2000)' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  shell: {
    description: 'Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command string to execute' },
        workdir: { type: 'string', description: 'Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead.' },
        timeout: { type: 'integer', minimum: 0, description: 'Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default.' },
        background: { type: 'boolean', description: "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion." },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
}

/** The exact UA the v2 gate fingerprints. Must be sent alone, no prefix/suffix. */
export const CLIENT_UA = 'opencode/latest/2.0.26/cli'

// ---------------------------------------------------------------- sessions

export function isCanonicalSession(id) {
  return typeof id === 'string' && SESSION_RE.test(id.trim()) && SESSION_DESCENDING_RE.test(id.trim().slice(4, 16))
}

/**
 * Mint a gateway-shaped session id: `~(ts_ms * 0x1000 + counter)` over 48 bits,
 * counter 1–63 so the low 12 bits land inside the accepted 0xfc0–0xfff window.
 * The counter resets every millisecond so a burst of mints stays in-window.
 */
export function mintSessionId(timestamp = Date.now()) {
  const seq = ++mintSessionId._seq
  if (timestamp !== mintSessionId._stamp) { mintSessionId._stamp = timestamp; mintSessionId._seq = 1 }
  const value = ~(BigInt(timestamp) * 0x1000n + BigInt(mintSessionId._seq)) & 0xffffffffffffn
  const hex = value.toString(16).padStart(12, '0')
  let tail = ''
  const bytes = crypto.randomBytes(14)
  for (const byte of bytes) tail += BASE62[byte % 62]
  return `ses_${hex}${tail}`
}

/**
 * Deterministically re-encode a conversation seed into an accepted session id,
 * so one conversation always maps to one upstream session without a store read.
 */
export function canonicalizeSession(signal) {
  const digest = crypto.createHash('sha256').update(`ses\0${signal}`).digest()
  const current = ((BigInt(digest[0]) << 28n | BigInt(digest[1]) << 20n | BigInt(digest[2]) << 12n |
    BigInt(digest[3]) << 4n | BigInt(digest[4]) >> 4n) << 12n) | 1n
  const inverted = ~current & 0xffffffffffffn
  const timeHex = inverted.toString(16).padStart(12, '0')
  let n = 0n
  for (let i = 6; i < 16; i += 1) n = (n << 8n) | BigInt(digest[i])
  let tail = ''
  for (let i = 0; i < 14; i += 1) { tail = BASE62[Number(n % 62n)] + tail; n /= 62n }
  return `ses_${timeHex}${tail}`
}

// ---------------------------------------------------------------- tool wiring

export function toolNameOf(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return ''
  if (typeof tool.name === 'string' && tool.name.trim()) return tool.name.trim()
  const fn = tool.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string' && fn.name.trim()) return fn.name.trim()
  return ''
}

/**
 * The gate name when the tool's name is *exactly* one of the two; '' otherwise.
 * Case variants (`Read`/`Shell`) are NOT gate tools and pass through untouched:
 * upstream accepts them beside the injected lowercase tools, and folding them
 * would collide with the byte-identical-definition rule.
 */
export function fingerprintKey(name) {
  const trimmed = String(name ?? '').trim()
  return FINGERPRINT_TOOLS.includes(trimmed) ? trimmed : ''
}

function functionOf(tool) {
  return tool.function && typeof tool.function === 'object' && !Array.isArray(tool.function) ? tool.function : null
}

function definitionOf(tool) {
  const wrapper = functionOf(tool) ?? (typeof tool.name === 'string' ? tool : null)
  if (!wrapper) return null
  return { description: wrapper.description, schema: wrapper.parameters }
}

/** Does this tool already carry OpenCode's own definition for `name`? */
function carriesFingerprintDefinition(tool, name) {
  const own = definitionOf(tool)
  if (own === null) return false
  const want = FINGERPRINT_TOOL_DEFINITIONS[name]
  return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters)
}

function withToolName(tool, name) {
  const fn = functionOf(tool)
  return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name }
}

function fingerprintTool(name) {
  const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name]
  return { type: 'function', function: { name, description, parameters } }
}

/** The note appended to the system area when a fingerprint tool had to be injected. */
export function placeholderNote(names) {
  const list = names.map(name => `\`${name}\``).join(' or ')
  return names.length > 1
    ? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
    : `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`
}

function aliasesByOriginal(map) {
  return new Map([...map].map(([alias, original]) => [original, alias]))
}

/** Point an explicit `tool_choice` at the alias of a renamed tool. */
function retargetToolChoice(body, map) {
  if (!body || typeof body !== 'object' || map.size === 0) return
  const choice = body.tool_choice
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return
  const aliases = aliasesByOriginal(map)
  if (typeof choice.name === 'string') {
    const alias = aliases.get(choice.name.trim())
    if (alias !== undefined) body.tool_choice = { ...choice, name: alias }
    return
  }
  const fn = choice.function
  if (fn && typeof fn === 'object' && !Array.isArray(fn) && typeof fn.name === 'string') {
    const alias = aliases.get(fn.name.trim())
    if (alias !== undefined) body.tool_choice = { ...choice, function: { ...fn, name: alias } }
  }
}

/**
 * Rename prior-turn calls to a renamed tool in the history being sent.
 * Without this the model reads its own earlier `read` calls as calls to
 * OpenCode's injected tool of that name, and the two definitions disagree.
 */
function aliasHistoryToolCalls(body, map) {
  if (!body || typeof body !== 'object' || map.size === 0) return
  const aliases = aliasesByOriginal(map)
  const rename = name => (typeof name === 'string' && aliases.has(name) ? aliases.get(name) : name)

  if (Array.isArray(body.messages)) {
    body.messages = body.messages.map(message => {
      if (message === null || typeof message !== 'object') return message
      if (Array.isArray(message.content)) {
        const content = message.content.map(block => block?.type === 'tool_use' && aliases.has(block.name)
          ? { ...block, name: aliases.get(block.name) }
          : block)
        return { ...message, content }
      }
      if (!Array.isArray(message.tool_calls)) return message
      return {
        ...message,
        tool_calls: message.tool_calls.map(call => aliases.has(call?.function?.name)
          ? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
          : call),
      }
    })
  }
}

function noteInjectedTools(body, names) {
  const note = placeholderNote(names)
  const messages = Array.isArray(body.messages) ? body.messages : []
  const first = messages[0]
  if (first?.role === 'system' && typeof first.content === 'string') {
    body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)]
    return
  }
  body.messages = [{ role: 'system', content: note }, ...messages]
}

/**
 * Satisfy the v2 free-tier fingerprint gate on `body.tools` (Chat shape).
 * Mutates `body` in place. Returns:
 *   { aliases: Map<sentName, callerName>, injected: string[], renamed: string[] }
 *
 * The response side uses `aliases` to restore the caller's spelling and to
 * tell decoy calls (a model dialing an injected placeholder) from real ones.
 */
export function applyFingerprint(body) {
  const map = new Map()
  const tools = Array.isArray(body.tools) ? body.tools : []
  const taken = new Set(tools.map(toolNameOf).filter(name => name !== ''))
  // `seen` dedupes same-name declarations (upstream rejects duplicates);
  // `present` records gate names that truly carry the official definition —
  // the injection check must look at the latter, or a caller `read` that was
  // renamed to `read_client` would suppress the real injection and 403.
  const seen = new Set()
  const present = new Set()
  const out = []
  const renamed = []

  for (const tool of tools) {
    const name = toolNameOf(tool)
    const key = fingerprintKey(name)
    if (key === '') { out.push(tool); continue }
    if (seen.has(key)) continue
    seen.add(key)
    if (carriesFingerprintDefinition(tool, key)) {
      out.push(tool)
      present.add(key)
      continue
    }
    let alias = `${key}_client`
    for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`
    taken.add(alias)
    map.set(alias, name)
    renamed.push(name)
    out.push(withToolName(tool, alias))
  }

  const injected = []
  for (const name of FINGERPRINT_TOOLS) {
    if (present.has(name)) continue
    out.push(fingerprintTool(name))
    injected.push(name)
  }

  body.tools = out
  retargetToolChoice(body, map)
  aliasHistoryToolCalls(body, map)
  if (injected.length > 0) noteInjectedTools(body, injected)
  // v2 answers `tool_choice: 'none'` with 403. Sweep it unconditionally.
  if (body.tool_choice === 'none'
    || (body.tool_choice !== null && typeof body.tool_choice === 'object' && body.tool_choice.type === 'none')) {
    delete body.tool_choice
  }
  if (!body.tool_choice) body.tool_choice = 'auto'
  return { aliases: map, injected, renamed }
}

/** Restore the caller's tool spelling in a streaming delta or final payload. */
export function restoreToolName(name, map) {
  if (!map || map.size === 0) return name
  return map.get(name) ?? name
}

/** The caller's own tool names, before fingerprinting. */
export function declaredToolNames(body) {
  const names = new Set()
  for (const tool of Array.isArray(body?.tools) ? body.tools : []) {
    const n = toolNameOf(tool)
    if (n) names.add(n)
  }
  return names
}
