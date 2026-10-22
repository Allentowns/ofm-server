/**
 * Build a single-file Windows x64 executable with Node SEA.
 *
 * Steps, each verified before the next:
 *   1. write sea-config.json (entry = server.mjs, assets = public/*)
 *   2. `node --experimental-sea-config` -> the blob
 *   3. copy the running node.exe to dist/ofm-server.exe
 *   4. `postject` injects the blob into that copy
 *   5. run the result and require /health to answer
 *
 * Why SEA and not pkg: this project has no dependencies, SEA is the official
 * mechanism, and it honours embedded assets — which is what lets the console
 * ship inside the executable instead of a sidecar `public/` folder.
 *
 * Usage: node scripts/build-exe.mjs [--skip-verify]
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DIST = path.join(ROOT, 'dist')
const BUNDLE = path.join(DIST, 'ofm-server.bundle.cjs')
const BLOB = path.join(DIST, 'ofm-server.blob')
const EXE = path.join(DIST, 'ofm-server.exe')
const CONFIG = path.join(DIST, 'sea-config.json')
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
const ASSET_NAMES = ['index.html', 'app.js', 'style.css']

const log = (...parts) => console.log(...parts)
const fail = message => { console.error(`build failed: ${message}`); process.exit(1) }

function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(' ')}`)
  return execFileSync(command, args, { cwd: ROOT, stdio: 'inherit', ...options })
}

// ---------------------------------------------------------------- 0. preflight

if (process.platform !== 'win32' || process.arch !== 'x64') {
  fail(`this build targets Windows x64; running on ${process.platform}/${process.arch}`)
}
const [major] = process.versions.node.split('.').map(Number)
if (major < 20) fail(`Node 20+ is required for SEA (found ${process.version})`)

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
log(`building ofm-server ${pkg.version} for win32-x64 with Node ${process.versions.node}`)
fs.mkdirSync(DIST, { recursive: true })

// ---------------------------------------------------------------- 1. bundle

// SEA runs its entry point as CommonJS (`embedderRunCjs`), so the ESM sources
// are bundled into one CJS file first. esbuild is a build-time dependency only.
run('npx', ['--yes', 'esbuild@0.25.0', 'server.mjs',
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node22',
  `--outfile=${path.relative(ROOT, BUNDLE)}`,
  '--log-level=warning',
], process.platform === 'win32' ? { shell: true } : {})
if (!fs.existsSync(BUNDLE)) fail('esbuild did not produce the bundle')
log(`bundle: ${(fs.statSync(BUNDLE).size / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------- 2. config

/** Relative asset paths, as SEA requires them in the config. */
const assets = {}
for (const name of ASSET_NAMES) {
  const file = path.join(ROOT, 'public', name)
  if (!fs.existsSync(file)) fail(`missing console asset: public/${name}`)
  assets[name] = `public/${name}`
}

const config = {
  main: path.relative(ROOT, BUNDLE),
  output: 'dist/ofm-server.blob',
  disableExperimentalSEAWarning: true,
  useSnapshot: false,
  useCodeCache: false,
  assets,
}
fs.writeFileSync(CONFIG, JSON.stringify(config, undefined, 2))
log(`wrote ${path.relative(ROOT, CONFIG)} (${Object.keys(assets).length} embedded assets)`)

// ---------------------------------------------------------------- 3. blob

run(process.execPath, ['--experimental-sea-config', path.relative(ROOT, CONFIG)])
if (!fs.existsSync(BLOB)) fail('the SEA blob was not produced')
log(`blob: ${(fs.statSync(BLOB).size / 1024).toFixed(1)} KB`)

// ---------------------------------------------------------------- 4. node.exe copy

fs.copyFileSync(process.execPath, EXE)
log(`copied the Node runtime -> ${path.relative(ROOT, EXE)}`)

// ---------------------------------------------------------------- 5. inject

// `postject` is a build-time tool only; it never ships inside the executable.
const postjectArgs = [
  '--yes', 'postject@1.0.0-alpha.6', EXE, 'NODE_SEA_BLOB', BLOB,
  '--sentinel-fuse', FUSE,
]
try {
  // Windows resolves `npx` only through the shell (a .cmd shim); on POSIX the
  // binary is invoked directly.
  run('npx', postjectArgs, process.platform === 'win32' ? { shell: true } : {})
} catch (error) {
  fail(`postject injection failed: ${error?.message ?? error}`)
}

// The Node signature block is invalidated by injection; that warning is
// expected and the binary still runs.
log('injected the SEA blob')

// ---------------------------------------------------------------- 6. verify

if (process.argv.includes('--skip-verify')) {
  log('\nskipped verification')
  process.exit(0)
}

const report = await verify(EXE)
log('\n--- verify ---')
for (const line of report) log(`  ${line}`)
log(`\nbuilt ${path.relative(ROOT, EXE)} (${(fs.statSync(EXE).size / 1024 / 1024).toFixed(1)} MB)`)

/**
 * Launch the built executable in a throwaway data directory and require:
 * version output, a listening port, a served console page, a 401 on an
 * unauthenticated API call, and a model listing with the printed key. That set
 * is the packaging contract: assets embedded, auth gate intact, routes wired.
 */
async function verify(exePath) {
  const report = []
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofm-exe-'))
  const port = 18991

  const version = execFileSync(exePath, ['--version'], { encoding: 'utf8' }).trim()
  if (version !== pkg.version) fail(`--version printed "${version}", expected "${pkg.version}"`)
  report.push(`--version -> ${version}`)

  const child = spawn(exePath, ['--port', String(port), '--data-dir', dataDir, '--no-probe'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  try {
    await waitFor(
      () => stdout.includes('listening') || stderr.includes('listening'),
      20000,
      `the executable never reported "listening" (stdout: ${stdout.slice(0, 200)}; stderr: ${stderr.slice(0, 200)})`,
    )
    report.push('started and reported listening')

    const base = `http://127.0.0.1:${port}`
    const key = readKey(stdout)
    if (key === null) fail('the executable did not print its local key')

    const page = await probe(`${base}/`)
    if (page.status !== 200 || !page.body.includes('<title>ofm-server')) {
      fail(`the console page was not served from the executable (status ${page.status})`)
    }
    report.push(`served / (${page.body.length} bytes, title present)`)

    const js = await probe(`${base}/app.js`)
    if (js.status !== 200 || !js.body.includes('renderModelRows')) fail('app.js was not served from the executable')
    report.push(`served /app.js (${js.body.length} bytes)`)

    const unauth = await probe(`${base}/api/settings`)
    if (unauth.status !== 401) fail(`/api/settings without a key answered ${unauth.status}, expected 401`)
    report.push('/api/settings without a key -> 401')

    const models = await probe(`${base}/v1/models`, { authorization: `Bearer ${key}` })
    if (models.status !== 200) fail(`/v1/models with the key answered ${models.status}`)
    const count = JSON.parse(models.body).data?.length ?? -1
    report.push(`/v1/models with the key -> 200, ${count} model(s)`)
  } finally {
    child.kill()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
  return report
}

/** One HTTP GET against the freshly built binary. */
async function probe(url, headers = {}) {
  const response = await fetch(url, { headers })
  return { status: response.status, body: await response.text() }
}

function readKey(text) {
  const match = /local key:\s*(\S+)/.exec(text)
  return match === null ? null : match[1]
}

async function waitFor(predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  fail(message)
}
