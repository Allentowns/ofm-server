/**
 * Upstream error classification.
 *
 * Ported from dsh-our-free-model src/http.js, reduced to the two lanes this
 * server drives. Every failure gets a stable code so the caller-facing HTTP
 * status and the web console can name the cause without re-parsing messages.
 *
 * @module lib/errors.js
 */

export const CODE = {
  region: 'REGION_BLOCKED',
  quota: 'RATE_LIMIT',
  credential: 'INVALID_CREDENTIAL',
  fingerprint: 'FINGERPRINT_REJECTED',
  client: 'UPSTREAM_CLIENT_ERROR',
  server: 'UPSTREAM_SERVER_ERROR',
  transport: 'TRANSPORT',
  timeout: 'TIMEOUT',
  aborted: 'ABORTED',
  empty: 'EMPTY_RESPONSE',
}

export class UpstreamError extends Error {
  constructor(message, code, details = {}) {
    super(message)
    this.name = 'UpstreamError'
    this.code = code
    Object.assign(this, details)
  }
}

/** Parse `Retry-After` (seconds) into milliseconds, when numeric. */
export function retryAfterMs(header) {
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined
}

function transportCause(error) {
  const causes = []
  let cursor = error
  while (cursor?.cause && causes.length < 3) {
    cursor = cursor.cause
    const bits = [cursor?.code, cursor?.message].filter(Boolean)
    if (bits.length > 0) causes.push(bits.join(' '))
  }
  return causes.length > 0 ? ` (${causes.join(' <- ')})` : ''
}

/**
 * Classify one failed upstream response.
 *
 * Codes that matter on this lane:
 * - 403 FreeTierError  -> CODE.fingerprint (the client gate; the wire changed)
 * - 403 RegionError    -> CODE.region
 * - 429 FreeUsageLimit -> CODE.quota (per-session free quota; sticky sessions)
 * - 401                -> CODE.credential (should not happen: `Bearer public`)
 */
export function classifyFailure(status, payload, setRetry) {
  const error = payload?.error ?? payload ?? {}
  const type = typeof error.type === 'string' ? error.type : ''
  const raw = typeof error.message === 'string' ? error.message : `upstream HTTP ${status}`
  const flat = raw.toLowerCase()
  if (type === 'RegionError' || /not available in your country|region/i.test(flat)) {
    return new UpstreamError(raw, CODE.region, { status, type, retryAfterMs: setRetry })
  }
  if (type === 'FreeTierError' || /free tier|fingerprint/i.test(flat)) {
    return new UpstreamError(raw, CODE.fingerprint, { status, type })
  }
  if (status === 429 || type === 'FreeUsageLimitError' || /usage limit|rate limit/i.test(flat)) {
    return new UpstreamError(raw, CODE.quota, { status, type, retryAfterMs: setRetry })
  }
  if (status === 401 || status === 403) {
    return new UpstreamError(raw, CODE.credential, { status, type })
  }
  if (status >= 400 && status < 500 && status !== 408 && status !== 425) {
    return new UpstreamError(raw, CODE.client, { status, type })
  }
  return new UpstreamError(raw, CODE.server, { status, type })
}

/** Normalize anything a stream read can throw. Aborts must never read as retryable transport noise. */
export function classifyStreamFailure(error, signal) {
  if (error instanceof UpstreamError) return error
  if (signal?.aborted === true || error?.name === 'AbortError') return new UpstreamError('request aborted', CODE.aborted)
  return new UpstreamError(`upstream stream read failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport)
}

export { transportCause }
