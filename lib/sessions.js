/**
 * Sticky upstream sessions.
 *
 * Free-tier quota is accounted per session: a fresh id per request exhausts it
 * and surfaces as 429 with growing Retry-After (measured by dsh-our-free-model
 * and reproduced by our own python demo). One downstream conversation must map
 * to one stable upstream session id.
 *
 * The OpenAI wire has no conversation id, so the seed is derived from the
 * request itself: model id + first user message. A multi-turn chat keeps the
 * same first user message (history accumulates after it), so the seed — and
 * therefore the session — stays put across turns of one conversation.
 *
 * The map persists to data/sessions.json; the ids themselves are minted with
 * the gate's descending encoding (lib/fingerprint.js).
 *
 * @module lib/sessions.js
 */

import fs from 'node:fs'
import path from 'node:path'
import { canonicalizeSession, isCanonicalSession, mintSessionId } from './fingerprint.js'

const MAX_SEEDS = 4096

export class SessionStore {
  constructor(filePath, { log = () => {} } = {}) {
    this.filePath = filePath
    this.log = log
    this.map = new Map()
    this._load()
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      for (const [seed, id] of Object.entries(parsed?.sessions ?? {})) {
        if (typeof id === 'string' && isCanonicalSession(id)) this.map.set(seed, id)
      }
    } catch { /* first run or unreadable store: start empty */ }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const temp = `${this.filePath}.tmp`
      fs.writeFileSync(temp, JSON.stringify({ version: 1, at: Date.now(), sessions: Object.fromEntries(this.map) }, undefined, 2))
      fs.renameSync(temp, this.filePath)
    } catch (error) {
      this.log(`session store save failed: ${error?.message ?? error}`)
    }
  }

  /**
   * The stable upstream session for one conversation seed. A remembered id is
   * reused as-is; anything else is minted fresh, remembered, and persisted.
   */
  sessionFor(seed) {
    const remembered = this.map.get(seed)
    if (remembered !== undefined && isCanonicalSession(remembered)) {
      return { session: remembered, reused: true }
    }
    const minted = mintSessionId()
    this.map.set(seed, minted)
    if (this.map.size > MAX_SEEDS) {
      const oldest = this.map.keys().next().value
      this.map.delete(oldest)
    }
    this._save()
    return { session: minted, reused: false }
  }

  /** Drop one seed (e.g. the console's "new session" button). */
  forget(seed) {
    if (this.map.delete(seed)) this._save()
  }

  get size() {
    return this.map.size
  }
}

/** The conversation seed for one chat-completions request. */
export function seedForRequest(body) {
  const model = String(body?.model ?? '')
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const firstUser = messages.find(message => message?.role === 'user')
  const content = firstUser?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map(block => (typeof block?.text === 'string' ? block.text : '')).join('\n')
      : ''
  return `${model}\u0000${text.slice(0, 512)}`
}
