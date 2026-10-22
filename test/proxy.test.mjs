import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { Transport, normalizeProxy } from '../lib/transport.js'
import { createServer as createHttpServer } from 'node:http'
import fsSync from 'node:fs'

/**
 * A real HTTP CONNECT proxy: records every tunnel it was asked to open and
 * pumps bytes both ways. TLS to the target happens inside the tunnel, so this
 * stands in for the user's proxy without needing a certificate authority.
 */
function startConnectProxy({ requireAuth, respondWith } = {}) {
  const tunnels = []
  const server = http.createServer((req, res) => {
    res.writeHead(405)
    res.end()
  })

  server.on('connect', (req, clientSocket, head) => {
    const authOk = !requireAuth || req.headers['proxy-authorization'] === `Basic ${Buffer.from(requireAuth).toString('base64')}`
    if (respondWith !== undefined) {
      clientSocket.write(respondWith)
      clientSocket.destroy()
      return
    }
    if (!authOk) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Agent: fake\r\n\r\n')
      clientSocket.destroy()
      return
    }
    const [host, portText] = req.url.split(':')
    const port = Number(portText) || 443
    tunnels.push({ host, port, url: req.url })
    const upstream = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head?.length) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    server,
    tunnels,
    url: `http://127.0.0.1:${server.address().port}`,
  })))
}

/** A tiny HTTPS upstream so the tunnel actually carries TLS. */
async function startTlsUpstream() {
  const { execFileSync } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-tls-'))
  const keyFile = path.join(dir, 'key.pem')
  const certFile = path.join(dir, 'cert.pem')
  // Self-signed for 127.0.0.1; the test trusts it via NODE_EXTRA_CA_CERTS below.
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', keyFile, '-out', certFile, '-days', '1',
    '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1',
  ], { stdio: 'ignore' })

  const server = createHttpServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, path: req.url, body: Buffer.concat(chunks).toString('utf8') }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  // Re-wrap as TLS on the same port.
  const tlsServer = tls.createServer({ key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }, socket => {
    const inner = createHttpServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, path: req.url, body: Buffer.concat(chunks).toString('utf8') }))
      })
    })
    inner.emit('connection', socket)
  })
  server.close()
  await new Promise(resolve => tlsServer.listen(port, '127.0.0.1', resolve))
  return { server: tlsServer, port, ca: certFile, dir }
}

// ---------------------------------------------------------------- units

test('normalizeProxy validates schemes and requires a URL when enabled', () => {
  assert.deepEqual(normalizeProxy(undefined), { enabled: false, url: '' })
  assert.deepEqual(normalizeProxy({ enabled: false, url: 'http://x:1' }), { enabled: false, url: '' })
  assert.throws(() => normalizeProxy({ enabled: true, url: '' }), /proxy URL is required/)
  assert.throws(() => normalizeProxy({ enabled: true, url: 'not a url' }), /not a valid URL/)
  assert.throws(() => normalizeProxy({ enabled: true, url: 'socks5://127.0.0.1:1080' }), /only http:\/\/ and https:\/\/ proxies/)
  assert.deepEqual(
    normalizeProxy({ enabled: true, url: ' http://127.0.0.1:7890 ' }),
    { enabled: true, url: 'http://127.0.0.1:7890' },
  )
})

test('the proxy is all-or-nothing: no per-host bypass is carried', () => {
  // A stale `noProxy` in settings.json is dropped rather than silently honoured.
  assert.deepEqual(
    normalizeProxy({ enabled: true, url: 'http://127.0.0.1:7890', noProxy: 'opencode.ai' }),
    { enabled: true, url: 'http://127.0.0.1:7890' },
  )
})

test('routeFor reports the path a URL would take', () => {
  const direct = new Transport({ proxy: { enabled: false, url: 'http://127.0.0.1:1' } })
  assert.deepEqual(direct.routeFor('opencode.ai'), { via: 'direct' })

  const proxied = new Transport({ proxy: { enabled: true, url: 'http://127.0.0.1:7890' } })
  assert.deepEqual(proxied.routeFor('opencode.ai'), { via: 'proxy', proxy: 'http://127.0.0.1:7890' })
  // Every host takes the proxy: there is no bypass list to consult.
  assert.deepEqual(proxied.routeFor('api.kilo.ai'), { via: 'proxy', proxy: 'http://127.0.0.1:7890' })
})

// ---------------------------------------------------------------- live tunnel

test('a real request runs through the CONNECT tunnel', async t => {
  const upstream = await startTlsUpstream()
  t.after(() => { upstream.server.close() })

  // Trust the self-signed cert for this process only.
    const proxy = await startConnectProxy()
  t.after(() => proxy.server.close())

  const transport = new Transport({ proxy: { enabled: true, url: proxy.url }, tls: { ca: fsSync.readFileSync(upstream.ca) } })
  const response = await transport.request({
    url: `https://127.0.0.1:${upstream.port}/probe?x=1`,
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hello: 'tunnel' }),
    timeoutMs: 15000,
  })
  assert.equal(response.status, 200)
  const payload = JSON.parse(await response.text())
  assert.equal(payload.ok, true)
  assert.equal(payload.path, '/probe?x=1')
  assert.equal(payload.body, '{"hello":"tunnel"}')

  // The tunnel was opened to the right host:port — proof the request went via the proxy.
  assert.equal(proxy.tunnels.length, 1)
  assert.equal(proxy.tunnels[0].host, '127.0.0.1')
  assert.equal(proxy.tunnels[0].port, upstream.port)
})

test('proxy auth is sent as basic credentials', async t => {
  const upstream = await startTlsUpstream()
  t.after(() => upstream.server.close())
  
  const proxy = await startConnectProxy({ requireAuth: 'user:secret' })
  t.after(() => proxy.server.close())

  const url = new URL(proxy.url)
  const withCreds = `http://user:secret@${url.host}`
  const transport = new Transport({ proxy: { enabled: true, url: withCreds }, tls: { ca: fsSync.readFileSync(upstream.ca) } })
  const response = await transport.request({ url: `https://127.0.0.1:${upstream.port}/auth`, timeoutMs: 15000 })
  assert.equal(response.status, 200)
  assert.equal(proxy.tunnels.length, 1)
})

test('a refused tunnel surfaces as a classified error', async t => {
  const proxy = await startConnectProxy({ requireAuth: 'user:secret' })
  t.after(() => proxy.server.close())

  const transport = new Transport({ proxy: { enabled: true, url: proxy.url } })
  await assert.rejects(
    () => transport.request({ url: 'https://opencode.ai/inference/v1/models', timeoutMs: 10000 }),
    error => {
      assert.match(error.message, /proxy refused the tunnel: HTTP\/1\.1 407/)
      assert.equal(error.code, 'INVALID_CREDENTIAL')
      return true
    },
  )
})

test('an unreachable proxy fails as transport, not as an upstream verdict', async () => {
  const transport = new Transport({ proxy: { enabled: true, url: 'http://127.0.0.1:1' } })
  await assert.rejects(
    () => transport.request({ url: 'https://opencode.ai/inference/v1/models', timeoutMs: 5000 }),
    error => {
      assert.equal(error.code, 'TRANSPORT')
      assert.match(error.message, /proxy connection failed/)
      return true
    },
  )
})

test('a disabled proxy keeps every request direct', () => {
  const transport = new Transport({ proxy: { enabled: false, url: 'http://127.0.0.1:1' } })
  assert.deepEqual(transport.routeFor('example.com'), { via: 'direct' })
  assert.equal(transport.active, null)
})


