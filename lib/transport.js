/**
 * Outbound transport with optional user-configured proxy.
 *
 * Both upstreams are HTTPS, so a proxy is used as an HTTP `CONNECT` tunnel:
 * TCP (or TLS, for an `https://` proxy) to the proxy, `CONNECT host:443`, then
 * TLS to the real host **inside** that tunnel. Node's own `https.Agent` is
 * subclassed so chunked decoding, streaming, keep-alive semantics and header
 * handling stay Node's job — only the socket is ours.
 *
 * Direct requests keep using `fetch`, which is what the lanes were verified
 * against. The proxy path returns the same shape (`status`, `Headers`,
 * `ReadableStream` body), so lane code does not care which one ran.
 *
 * Supported proxy schemes: `http://` and `https://`, with optional
 * `user:pass@`. SOCKS is not implemented, and saying so beats a silent
 * half-working tunnel. The switch is all-or-nothing: there is no per-host
 * bypass list.
 *
 * @module lib/transport.js
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { Readable } from 'node:stream'
import { CODE, UpstreamError, transportCause } from './errors.js'

const TUNNEL_TIMEOUT_MS = 20000

/** Validate and normalize the stored proxy settings. Throws on unusable input. */
export function normalizeProxy(input) {
  if (!input || input.enabled !== true) return { enabled: false, url: '' }
  const urlText = String(input.url ?? '').trim()
  if (urlText === '') throw new Error('proxy URL is required when the proxy is enabled')
  let parsed
  try { parsed = new URL(urlText) } catch { throw new Error('proxy URL is not a valid URL') }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`unsupported proxy scheme ${parsed.protocol.replace(':', '')} — only http:// and https:// proxies are implemented`)
  }
  if (parsed.hostname === '') throw new Error('proxy URL has no host')
  return { enabled: true, url: urlText }
}

/** `host:port` plus decoded basic-auth for one proxy URL. */
function proxyTarget(proxyUrl) {
  const url = new URL(proxyUrl)
  return {
    protocol: url.protocol,
    host: url.hostname,
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    auth: url.username !== '' ? `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}` : undefined,
  }
}

function dialTcp(host, port, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const done = error => {
      socket.setTimeout(0)
      socket.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      if (error) { socket.destroy(); reject(error) } else resolve(socket)
    }
    const onError = error => done(new UpstreamError(`proxy connection failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport))
    const onAbort = () => done(new UpstreamError('request aborted', CODE.aborted))
    socket.setTimeout(TUNNEL_TIMEOUT_MS, () => done(new UpstreamError('proxy connection timed out', CODE.timeout)))
    socket.once('error', onError)
    signal?.addEventListener('abort', onAbort, { once: true })
    socket.once('connect', () => done(null))
  })
}

function startTls(socket, servername, signal, { ca, rejectUnauthorized } = {}) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername,
      ...(ca !== undefined ? { ca } : {}),
      ...(rejectUnauthorized !== undefined ? { rejectUnauthorized } : {}),
    })
    const onError = error => reject(new UpstreamError(`proxy TLS failed: ${error?.message ?? error}`, CODE.transport))
    const onAbort = () => { secure.destroy(); reject(new UpstreamError('request aborted', CODE.aborted)) }
    signal?.addEventListener('abort', onAbort, { once: true })
    secure.once('error', onError)
    secure.once('secureConnect', () => {
      secure.removeListener('error', onError)
      signal?.removeEventListener('abort', onAbort)
      resolve(secure)
    })
  })
}

/** Read proxy reply headers; returns the status line and leaves the rest queued. */
function readConnectReply(socket) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const onData = chunk => {
      buffer += chunk.toString('latin1')
      const end = buffer.indexOf('\r\n\r\n')
      if (end === -1) {
        if (buffer.length > 16 * 1024) { cleanup(); reject(new UpstreamError('proxy sent an oversized CONNECT reply', CODE.transport)) }
        return
      }
      const head = buffer.slice(0, end)
      const rest = buffer.slice(end + 4)
      cleanup()
      // Bytes after the reply belong to the tunnel: hand them back to the socket.
      if (rest !== '') socket.unshift(Buffer.from(rest, 'latin1'))
      resolve(head.split('\r\n')[0] ?? '')
    }
    const onError = error => { cleanup(); reject(new UpstreamError(`proxy CONNECT failed: ${error?.message ?? error}`, CODE.transport)) }
    const onClose = () => { cleanup(); reject(new UpstreamError('proxy closed the connection before answering CONNECT', CODE.transport)) }
    function cleanup() {
      socket.removeListener('data', onData)
      socket.removeListener('error', onError)
      socket.removeListener('close', onClose)
    }
    socket.on('data', onData)
    socket.once('error', onError)
    socket.once('close', onClose)
  })
}

/** Establish a tunnel to `targetHost:targetPort`, optionally TLS to the target. */
async function openTunnel(proxy, targetHost, targetPort, { secureTarget, signal, tls }) {
  let socket = await dialTcp(proxy.host, proxy.port, signal)
  if (proxy.protocol === 'https:') socket = await startTls(socket, proxy.host, signal, tls)

  const authorization = proxy.auth
    ? `Proxy-Authorization: Basic ${Buffer.from(proxy.auth).toString('base64')}\r\n`
    : ''
  socket.write(
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    authorization +
    'Proxy-Connection: keep-alive\r\n\r\n',
  )

  const statusLine = await readConnectReply(socket)
  const status = Number(statusLine.split(/\s+/)[1])
  if (status !== 200) {
    socket.destroy()
    const code = status === 407 ? CODE.credential : CODE.transport
    throw new UpstreamError(`proxy refused the tunnel: ${statusLine.trim()}`, code, { status })
  }
  if (!secureTarget) return socket
  return startTls(socket, targetHost, signal, tls)
}

function makeAgent(proxy, secureTarget, tls) {
  const Base = secureTarget ? https.Agent : http.Agent
  class TunnelAgent extends Base {
    constructor() {
      super({ keepAlive: false })
      this.proxy = proxy
      this.secureTarget = secureTarget
      this.tls = tls
    }
    createConnection(options, callback) {
      const port = Number(options.port) || (secureTarget ? 443 : 80)
      openTunnel(this.proxy, options.host, port, { secureTarget, signal: options.signal, tls: this.tls })
        .then(socket => callback(null, socket))
        .catch(error => callback(error))
    }
  }
  return new TunnelAgent()
}

function toHeaders(raw) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (value === undefined) continue
    if (Array.isArray(value)) for (const item of value) headers.append(key, String(item))
    else headers.set(key, String(value))
  }
  return headers
}

/** Wrap one ReadableStream body with a `text()` convenience. */
function presentResponse({ status, headers, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    body: body ?? null,
    async text() {
      if (body === null) return ''
      const chunks = []
      let size = 0
      for await (const chunk of body) {
        const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk)
        size += bytes.byteLength
        if (size > 32 * 1024 * 1024) throw new UpstreamError('upstream body exceeded the 32 MB read cap', CODE.server)
        chunks.push(bytes)
      }
      return Buffer.concat(chunks).toString('utf8')
    },
  }
}

export class Transport {
  constructor({ proxy, tls } = {}) {
    this.proxy = normalizeProxy(proxy)
    this.tls = tls
    this.lastError = null
  }

  /** Hot-reconfigure: the next request uses the new proxy, in-flight ones keep theirs. */
  configure(proxy) {
    this.proxy = normalizeProxy(proxy)
    this.lastError = null
    return this.proxy
  }

  get active() {
    return this.proxy.enabled ? this.proxy : null
  }

  /** Which path a URL would take right now (shown in the console). */
  routeFor(host) {
    const proxy = this.active
    if (!proxy) return { via: 'direct' }
    return { via: 'proxy', proxy: proxy.url }
  }

  async request({ url, method = 'GET', headers = {}, body, signal, timeoutMs = 300000 }) {
    const parsed = new URL(url)
    const proxy = this.active
    if (!proxy) {
      return this._direct({ url, method, headers, body, signal })
    }
    return this._tunneled({ parsed, proxy, method, headers, body, signal, timeoutMs })
  }

  async _direct({ url, method, headers, body, signal }) {
    const response = await fetch(url, { method, headers, body, redirect: 'error', signal })
    return presentResponse({ status: response.status, headers: toHeaders(Object.fromEntries(response.headers)), body: response.body })
  }

  _tunneled({ parsed, proxy, method, headers, body, signal, timeoutMs }) {
    const secureTarget = parsed.protocol === 'https:'
    const port = Number(parsed.port) || (secureTarget ? 443 : 80)
    const agent = makeAgent(proxyTarget(proxy.url), secureTarget, this.tls)
    const transport = secureTarget ? https : http

    return new Promise((resolve, reject) => {
      const requestHeaders = { ...headers }
      if (body !== undefined) requestHeaders['content-length'] = String(Buffer.byteLength(body))
      // Node does not add accept-encoding itself; ask for identity so no
      // upstream gzip has to be decoded by hand on this path.
      if (requestHeaders['accept-encoding'] === undefined) requestHeaders['accept-encoding'] = 'identity'

      const req = transport.request({
        host: parsed.hostname,
        port,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: requestHeaders,
        agent,
        signal,
      })

      const onAbort = () => req.destroy(new UpstreamError('request aborted', CODE.aborted))
      signal?.addEventListener('abort', onAbort, { once: true })
      req.setTimeout(timeoutMs, () => req.destroy(new UpstreamError('upstream request timed out', CODE.timeout)))

      req.once('error', error => {
        signal?.removeEventListener('abort', onAbort)
        this.lastError = String(error?.message ?? error)
        if (error instanceof UpstreamError) { reject(error); return }
        if (signal?.aborted === true) { reject(new UpstreamError('request aborted', CODE.aborted)); return }
        reject(new UpstreamError(`proxy request failed: ${error?.message ?? error}${transportCause(error)}`, CODE.transport))
      })

      req.once('response', res => {
        signal?.removeEventListener('abort', onAbort)
        clearTimeout?.()
        // `agent: false` semantics: one tunnel per request, closed with it.
        res.once('end', () => req.destroy())
        resolve(presentResponse({
          status: res.statusCode ?? 0,
          headers: toHeaders(res.headers),
          body: Readable.toWeb(res),
        }))
      })

      if (body !== undefined) req.write(body)
      req.end()
    })
  }
}
