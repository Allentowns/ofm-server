/**
 * Whether one OpenCode listing id belongs to the free lane.
 *
 * Ported from dsh-our-free-model src/catalog.js `isFreeLane`: the `-free` family
 * suffix plus the ids the lane serves free without carrying it (`big-pickle` is
 * its long-standing free id). Everything else on that gateway is a paid Zen id
 * and answers 401/402 to the public pooled credential — listing it here would
 * hand the picker a model that cannot answer.
 */
export const ALWAYS_FREE = new Set(['union-alpha', 'space-bunny-free', 'big-pickle'])

export function isFreeLane(modelId) {
  if (typeof modelId !== 'string' || modelId === '') return false
  if (ALWAYS_FREE.has(modelId)) return true
  return /(?:^|[-_])free(?:$|[-_.])/.test(modelId)
}

/**
 * Model catalog: merge both lanes, track availability, refresh on a timer.
 *
 * Only free models are kept: the OpenCode free lane (`isFreeLane`) and the Kilo
 * free pool (`isFree: true`). Kilo ids are namespaced with `kilo/` so both lanes
 * can coexist in one `/v1/models` document without collisions.
 *
 * @module lib/catalog.js
 */

import { fetchListing as fetchOpencodeListing } from './lane-opencode.js'
import { fetchListing as fetchKiloListing } from './lane-kilo.js'

export const KILO_PREFIX = 'kilo/'

export class Catalog {
  constructor({ transport, refreshMinutes = 15, log = () => {} } = {}) {
    this.transport = transport
    this.refreshMinutes = refreshMinutes
    this.log = log
    this.models = new Map() // id -> { id, lane, contextWindow?, status, checkedAt, error? }
    /** id -> { state:'checking'|'ok'|'error', code?, message?, ttftMs?, at } */
    this.probes = new Map()
    this.lastRefreshAt = 0
    /** Outcome of the last refresh, so callers can report it without re-fetching. */
    this.lastResult = null
    this.lastRoutes = null
    this._timer = null
  }

  /**
   * Record the outcome of one availability probe.
   *
   * The catalog's own `status` only tracks whether the upstream *listing*
   * declares the model; a probe answers the question users actually ask — does
   * it answer right now, from this machine.
   */
  setProbe(id, probe) {
    this.probes.set(id, { ...probe, at: Date.now() })
  }

  probeOf(id) {
    return this.probes.get(id) ?? null
  }

  /** Which path each lane would take right now (direct or through the proxy). */
  routes() {
    const opencode = new URL('https://opencode.ai')
    const kilo = new URL('https://api.kilo.ai')
    return {
      opencode: this.transport.routeFor(opencode.hostname),
      kilo: this.transport.routeFor(kilo.hostname),
    }
  }

  /**
   * Merge one refresh into the map.
   *
   * Deletion is scoped to the lanes that actually answered. A listing request
   * can fail for reasons that say nothing about the models it carries — most
   * commonly a machine that needs a proxy which is not configured yet, or is
   * configured and unreachable. Treating "the request failed" as "these models
   * are gone" would wipe half the roster the moment a proxy went bad, and would
   * then serve the stale half as though it were current.
   *
   * So: a failed lane keeps its previous entries untouched, and the failure is
   * reported back to the caller instead of being swallowed.
   */
  async refresh({ signal } = {}) {
    this.lastRoutes = this.routes()
    const results = await Promise.allSettled([
      fetchOpencodeListing({ transport: this.transport, signal }),
      fetchKiloListing({ transport: this.transport, signal }),
    ])

    const seen = new Set()
    const [opencodeResult, kiloResult] = results
    /** Lanes whose listing answered; only these may delete entries. */
    const answered = new Set()
    const errors = []

    if (opencodeResult.status === 'fulfilled') {
      answered.add('opencode')
      for (const id of opencodeResult.value) {
        if (!isFreeLane(id)) continue
        seen.add(id)
        const prev = this.models.get(id)
        // Lane-wide verdicts (fingerprint/region/429) do not condemn a model.
        this.models.set(id, {
          id, lane: 'opencode',
          status: prev?.status === 'rejected-route' ? 'rejected-route' : 'available',
          checkedAt: Date.now(),
        })
      }
    } else {
      const reason = opencodeResult.reason
      errors.push(`opencode: ${reason?.message ?? reason}`)
      this.log(`opencode listing failed: ${reason?.message ?? reason}`)
    }

    if (kiloResult.status === 'fulfilled') {
      answered.add('kilo')
      for (const entry of kiloResult.value) {
        const id = KILO_PREFIX + entry.id
        seen.add(id)
        const prev = this.models.get(id)
        this.models.set(id, {
          id, lane: 'kilo',
          contextWindow: entry.contextWindow,
          status: prev?.status === 'rejected-route' ? 'rejected-route' : 'available',
          checkedAt: Date.now(),
        })
      }
    } else {
      const reason = kiloResult.reason
      errors.push(`kilo: ${reason?.message ?? reason}`)
      this.log(`kilo listing failed: ${reason?.message ?? reason}`)
    }

    // Entries an *answering* lane dropped are gone for good; entries belonging
    // to a silent lane stay until that lane can speak for itself.
    for (const id of [...this.models.keys()]) {
      const lane = this.models.get(id)?.lane
      if (!answered.has(lane)) continue
      if (!seen.has(id)) this.models.delete(id)
    }

    this.lastRefreshAt = Date.now()
    const result = {
      opencode: opencodeResult.status === 'fulfilled',
      kilo: kiloResult.status === 'fulfilled',
      /** Present only when at least one lane failed; the first reason seen. */
      error: errors.length > 0 ? errors.join('; ') : undefined,
    }
    this.lastResult = result
    return result
  }

  markUnavailable(id, error) {
    const entry = this.models.get(id)
    if (entry && (error?.code === 'UPSTREAM_CLIENT_ERROR' || /unavailable|not found/i.test(String(error?.message)))) {
      entry.status = 'rejected-route'
      entry.error = String(error?.message ?? '').slice(0, 200)
      entry.checkedAt = Date.now()
    }
  }

  get(id) {
    return this.models.get(id)
  }

  list() {
    return [...this.models.values()]
      .map(entry => ({ ...entry, probe: this.probes.get(entry.id) ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id))
  }

  startTimer() {
    if (this._timer) return
    this._timer = setInterval(() => {
      this.refresh().catch(() => {})
    }, Math.max(1, this.refreshMinutes) * 60 * 1000)
    this._timer.unref?.()
  }

  stopTimer() {
    if (this._timer) { clearInterval(this._timer); this._timer = null }
  }
}
