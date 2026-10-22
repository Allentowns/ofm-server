/**
 * Local key management: generated once, persisted, compared in constant time.
 * Modeled on the plugin's forward listener (crypto.randomBytes + timingSafeEqual,
 * 0600 file, never logged).
 *
 * @module lib/auth.js
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export class Auth {
  constructor(filePath, { log = () => {} } = {}) {
    this.filePath = filePath
    this.log = log
    this.key = null
    this._loadOrCreate()
  }

  _loadOrCreate() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      if (typeof parsed?.localKey === 'string' && parsed.localKey.length >= 24) {
        this.key = parsed.localKey
        return
      }
    } catch { /* first run */ }
    this.key = `ofm-${crypto.randomBytes(24).toString('base64url')}`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify({ localKey: this.key, createdAt: Date.now() }, undefined, 2), { mode: 0o600 })
    } catch (error) {
      this.log(`key store write failed: ${error?.message ?? error}`)
    }
  }

  /** Constant-time bearer comparison. */
  matches(bearer) {
    if (typeof bearer !== 'string' || bearer.length === 0 || typeof this.key !== 'string') return false
    const a = Buffer.from(bearer)
    const b = Buffer.from(this.key)
    return a.byteLength === b.byteLength && crypto.timingSafeEqual(a, b)
  }

  /** Extract the bearer token from a request's headers. */
  static bearerOf(req) {
    const header = String(req.headers.authorization ?? '')
    if (header.toLowerCase().startsWith('bearer ')) return header.slice(7).trim()
    const alt = req.headers['x-api-key']
    return typeof alt === 'string' ? alt.trim() : ''
  }
}
