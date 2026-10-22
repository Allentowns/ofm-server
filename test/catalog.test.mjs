/**
 * A failed listing refresh must not damage the catalog.
 *
 * The scenario the users hit: the machine needs a proxy to reach the upstreams.
 * Before the proxy is configured the listing fails; after it is configured the
 * listing succeeds. Whatever the ordering, a refresh that fails on one lane may
 * not silently drop the models that lane owns, and the catalog has to be able to
 * say "this listing failed" instead of serving a stale roster as if it were
 * fresh.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Catalog } from '../lib/catalog.js'

/** A transport whose two listing responses are scripted per lane, per call. */
function scriptedTransport(steps) {
  // Each lane advances its own cursor: `Promise.allSettled` issues both listing
  // requests concurrently, so a shared counter would race and hand the second
  // lane the next step's script.
  const cursors = { opencode: 0, kilo: 0 }
  return {
    routeFor: () => ({ via: 'direct' }),
    async request({ url }) {
      const lane = url.includes('opencode.ai') ? 'opencode' : 'kilo'
      const step = steps[Math.min(cursors[lane], steps.length - 1)]
      cursors[lane] += 1
      const outcome = step[lane]
      if (outcome instanceof Error) throw outcome
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify(outcome),
        json: async () => outcome,
      }
    },
  }
}

const opencodeListing = { data: [{ id: 'big-pickle' }, { id: 'grok-code-fast-free' }, { id: 'paid-zen-model' }] }
const kiloListing = { data: [{ id: 'auto-free', isFree: true }, { id: 'paid-kilo', isFree: false }] }
const offline = new Error('connect ECONNREFUSED 127.0.0.1:7890')

test('a fully failed refresh keeps the previous roster', async () => {
  const transport = scriptedTransport([
    { opencode: opencodeListing, kilo: kiloListing },
    { opencode: offline, kilo: offline },
  ])
  const catalog = new Catalog({ transport })
  await catalog.refresh()
  const before = catalog.list().map(entry => entry.id)
  assert.deepEqual(before, ['big-pickle', 'grok-code-fast-free', 'kilo/auto-free'])

  const result = await catalog.refresh()
  assert.equal(result.opencode, false)
  assert.equal(result.kilo, false)
  assert.deepEqual(
    catalog.list().map(entry => entry.id),
    before,
    'a failed listing must not empty the roster',
  )
})

test('one failed lane keeps that lane\'s models while the other lane refreshes', async () => {
  const transport = scriptedTransport([
    { opencode: opencodeListing, kilo: kiloListing },
    { opencode: offline, kilo: { data: [{ id: 'auto-free', isFree: true }, { id: 'kilo-new-free', isFree: true }] } },
  ])
  const catalog = new Catalog({ transport })
  await catalog.refresh()
  const result = await catalog.refresh()

  assert.equal(result.opencode, false)
  assert.equal(result.kilo, true)
  const ids = catalog.list().map(entry => entry.id)
  assert.deepEqual(ids, ['big-pickle', 'grok-code-fast-free', 'kilo/auto-free', 'kilo/kilo-new-free'])
})

test('a successful refresh still drops models the upstream no longer lists', async () => {
  const transport = scriptedTransport([
    { opencode: opencodeListing, kilo: kiloListing },
    { opencode: { data: [{ id: 'big-pickle' }] }, kilo: { data: [{ id: 'auto-free', isFree: true }] } },
  ])
  const catalog = new Catalog({ transport })
  await catalog.refresh()
  await catalog.refresh()

  assert.deepEqual(catalog.list().map(entry => entry.id), ['big-pickle', 'kilo/auto-free'])
})

test('refresh reports which lanes failed so callers can warn instead of guessing', async () => {
  const transport = scriptedTransport([{ opencode: offline, kilo: offline }])
  const catalog = new Catalog({ transport })
  const result = await catalog.refresh()

  assert.equal(result.opencode, false)
  assert.equal(result.kilo, false)
  assert.equal(typeof result.error, 'string')
  assert.match(result.error, /ECONNREFUSED/)
  assert.equal(catalog.list().length, 0)
})

test('the last refresh outcome is retained for callers that do not re-fetch', async () => {
  const transport = scriptedTransport([{ opencode: opencodeListing, kilo: kiloListing }])
  const catalog = new Catalog({ transport })
  assert.equal(catalog.lastResult, null)

  const result = await catalog.refresh()
  assert.deepEqual(catalog.lastResult, result)
  assert.equal(catalog.lastResult.opencode, true)
})
