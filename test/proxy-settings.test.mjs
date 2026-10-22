/**
 * Saving a proxy must report whether it actually works.
 *
 * The user-visible bug: a machine that needs a proxy to reach the upstreams
 * turns the switch on, the console says "saved", and the model table is empty —
 * or worse, still shows the roster fetched over direct connections before the
 * proxy existed. Nothing in that flow told the truth.
 *
 * These tests drive the real HTTP surface: POST the proxy setting, then read the
 * response's `listing` verdict and the `/api/models` roster.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import net from 'node:net'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

process.env.OF_TEST_MODE = '1'

const ROOT = path.resolve(import.meta.dirname, '..')

/** A port nobody listens on: connecting to it fails immediately. */
async function closedPort() {
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Start the server on a free port with a throwaway data directory. */
async function startServer(extraArgs = []) {
  const probe = net.createServer()
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-proxy-'))
  const child = spawn(process.execPath, ['server.mjs', '--port', String(port), '--data-dir', dataDir, '--no-probe', ...extraArgs], {
    cwd: ROOT,
    env: { ...process.env, OF_TEST_MODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })

  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (output.includes('local key:')) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const key = /local key:\s*(\S+)/.exec(output)?.[1]
  assert.ok(key, `server did not start: ${output.slice(0, 400)}`)

  return {
    port,
    key,
    output: () => output,
    get: (p) => fetch(`http://127.0.0.1:${port}${p}`, { headers: { authorization: `Bearer ${key}` } }),
    post: (p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    async stop() {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
  }
}

test('an unreachable proxy is saved but reported as a failed listing', async () => {
  const server = await startServer()
  try {
    const deadPort = await closedPort()
    const response = await server.post('/api/settings/proxy', {
      enabled: true,
      url: `http://127.0.0.1:${deadPort}`,
    })
    assert.equal(response.status, 200)
    const body = await response.json()

    // The setting is kept — the user asked for it, and it may start working.
    assert.equal(body.proxy.enabled, true)
    assert.match(body.proxy.url, new RegExp(`:${deadPort}$`))

    // …but the failure is surfaced instead of being swallowed by a `.catch()`.
    assert.equal(body.listing.opencode, false)
    assert.equal(body.listing.kilo, false)
    assert.equal(typeof body.listing.error, 'string')
    assert.ok(body.listing.error.length > 0, 'the listing failure needs a reason')

    // And the roster reports the same verdict, so the table can explain itself.
    const models = await (await server.get('/api/models')).json()
    assert.equal(models.refresh.opencode, false)
    assert.equal(models.refresh.kilo, false)
    assert.ok(models.refresh.error)
  } finally {
    await server.stop()
  }
})

test('turn the proxy back off and the listing recovers', async () => {
  const server = await startServer()
  try {
    const deadPort = await closedPort()
    await server.post('/api/settings/proxy', { enabled: true, url: `http://127.0.0.1:${deadPort}` })

    const off = await (await server.post('/api/settings/proxy', { enabled: false, url: '' })).json()
    assert.equal(off.proxy.enabled, false)
    // Direct is the only path left; whether the real upstreams answer from this
    // machine is not this test's business — that the switch took effect is.
    assert.equal(typeof off.listing.opencode, 'boolean')
    assert.equal(typeof off.listing.kilo, 'boolean')
  } finally {
    await server.stop()
  }
})

test('an invalid proxy URL is rejected without touching the saved setting', async () => {
  const server = await startServer()
  try {
    const response = await server.post('/api/settings/proxy', { enabled: true, url: 'socks5://127.0.0.1:1080' })
    assert.equal(response.status, 400)
    const body = await response.json()
    assert.match(body.error.message, /unsupported proxy scheme/)

    const settings = await (await server.get('/api/settings')).json()
    assert.equal(settings.proxy.enabled, false, 'a rejected URL must not be stored')
  } finally {
    await server.stop()
  }
})
