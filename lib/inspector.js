/**
 * Request inspector: an in-memory ring of recent turns, exposed to the web
 * console as native-request vs upstream-request pairs.
 *
 * Nothing here leaves the process: the buffer holds at most `limit` records,
 * payloads are truncated per record, and disabling the inspector keeps every
 * path working with a no-op recorder.
 *
 * @module lib/inspector.js
 */

const PAYLOAD_CAP = 256 * 1024
const STRING_FIELD_CAP = 64 * 1024

export class Inspector {
  constructor({ enabled = false, limit = 50 } = {}) {
    this.enabled = enabled
    this.limit = limit
    this.records = []
    this._nextId = 1
  }

  /** Toggle at runtime. Disabling drops the buffer: no request is recorded,
   * and the old records do not linger in memory. */
  setEnabled(enabled) {
    this.enabled = enabled === true
    if (!this.enabled) this.records = []
    return this.enabled
  }

  _cap(value, depth = 0) {
    if (typeof value === 'string') {
      return value.length <= STRING_FIELD_CAP ? value : value.slice(0, STRING_FIELD_CAP) + `…[+${value.length - STRING_FIELD_CAP} chars]`
    }
    if (value === null || typeof value !== 'object') return value
    if (depth > 6) return '[deep]'
    if (Array.isArray(value)) return value.slice(0, 200).map(item => this._cap(item, depth + 1))
    const out = {}
    for (const [key, item] of Object.entries(value)) out[key] = this._cap(item, depth + 1)
    return out
  }

  begin({ lane, model, nativeHeaders, nativeBody, source = 'api' }) {
    if (!this.enabled) return { id: 0, step: () => {}, end: () => {} }
    const id = this._nextId++
    const record = {
      id,
      startedAt: Date.now(),
      lane,
      model,
      source,
      status: 'running',
      native: { headers: this._cap(nativeHeaders ?? {}), body: this._cap(nativeBody ?? {}) },
      upstream: null,
      transform: { notes: [], injected: [], renamed: [], toolChoiceCleared: false },
      response: null,
      error: null,
    }
    this.records.unshift(record)
    if (this.records.length > this.limit) this.records.length = this.limit
    return {
      id,
      step(fields) {
        Object.assign(record, fields)
      },
      end: (fields = {}) => {
        Object.assign(record, fields, { endedAt: Date.now(), durationMs: Date.now() - record.startedAt, status: fields.error ? 'error' : 'ok' })
      },
    }
  }

  list({ limit = 50 } = {}) {
    return this.records.slice(0, limit).map(record => ({
      id: record.id,
      startedAt: record.startedAt,
      durationMs: record.durationMs,
      lane: record.lane,
      model: record.model,
      source: record.source ?? 'api',
      status: record.status,
      transform: {
        injected: record.transform.injected,
        renamed: record.transform.renamed,
        toolChoiceCleared: record.transform.toolChoiceCleared,
        notesCount: record.transform.notes.length,
      },
      response: record.response
        ? {
            ttftMs: record.response.ttftMs,
            usage: record.response.usage,
            stopReason: record.response.stopReason,
            textChars: record.response.textChars,
            toolCalls: record.response.toolCalls,
            suppressed: record.response.suppressed ?? 0,
          }
        : null,
      error: record.error ? { code: record.error.code, message: record.error.message } : null,
    }))
  }

  get(id) {
    return this.records.find(record => record.id === Number(id)) ?? null
  }
}
