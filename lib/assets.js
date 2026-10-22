/**
 * Static console assets, from disk or from inside the executable.
 *
 * In source mode `public/` sits next to `server.mjs` and is read directly. In a
 * Node SEA build the same files are embedded as assets (`node --experimental-sea-config`
 * `assets` block) and read through `node:sea`'s `getAsset`, so shipping a single
 * `.exe` needs no sidecar folder.
 *
 * Only three files are served, all of them public by design: the console holds
 * no secret, and a browser cannot attach a bearer token to a page request. The
 * API and /v1 routes are gated elsewhere.
 *
 * @module lib/assets.js
 */

import fs from 'node:fs'
import path from 'node:path'
import * as sea from 'node:sea'

/** MIME table for the console's file types. */
export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
}

/** The three files the console needs; anything else is a 404. */
const ALLOWED = new Set(['index.html', 'app.js', 'style.css'])

/** Detect the SEA runtime. `node:sea` exists in every Node this server
 *  supports, and `isSea()` answers false outside a packaged binary. */
function loadSea() {
  if (process.env.OF_NO_SEA === '1') return null
  try {
    return typeof sea.isSea === 'function' && sea.isSea() ? sea : null
  } catch {
    return null
  }
}

/**
 * Build an asset resolver (synchronous: the server calls it at startup, and a
 * packaged entry point cannot use top-level await).
 *
 * @param {string} publicDir - the on-disk `public/` directory (source mode)
 */
export function createAssets(publicDir) {
  const sea = loadSea()

  const has = name => {
    if (!ALLOWED.has(name)) return false
    if (sea !== null) { try { return sea.getAsset(name) !== undefined } catch { return false } }
    try { return fs.statSync(path.join(publicDir, name)).isFile() } catch { return false }
  }

  const read = name => {
    if (!ALLOWED.has(name)) return null
    if (sea !== null) {
      try {
        const asset = sea.getAsset(name)
        return asset === undefined ? null : Buffer.from(asset)
      } catch { return null }
    }
    try { return fs.readFileSync(path.join(publicDir, name)) } catch { return null }
  }

  return {
    mode: sea !== null ? 'sea' : 'disk',
    has,
    read,
    contentType: name => MIME[path.extname(name)] ?? 'application/octet-stream',
  }
}
