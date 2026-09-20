#!/usr/bin/env node
// native-session-names.mjs — the required native session-names contract runner
// (unified-agent-names plan, Task 8).
//
// Runs INSIDE the disposable freshell-sandbox container (never on the host,
// never against a live target) and proves the three REAL provider metadata
// contracts against the prepared Freshell runtime:
//
//   1. Claude  — the staged production `session-names.mjs` helper with the
//      locked SDK 0.3.237 (read / rename / read, a fresh helper-process
//      readback), plus the Rust rename route's canonical manual name and
//      own-echo protection, selected-root targeting with a non-target copy
//      untouched, and the short generated-title value accepted without
//      changing the transcript metadata shape.
//   2. Codex   — the real `codex app-server` JSON-RPC surface: root-matched
//      initialize, `thread/read` includeTurns:false, production
//      `thread/name/set` and read; a fresh management process readback; a
//      held loaded execution handle that metadata work never steals;
//      wrong-root isolation; and a zero-turn prospective start/restart with
//      a pending Freshell rename (no model turn anywhere).
//   3. OpenCode — the real `opencode serve` HTTP surface with isolated
//      scratch storage: zero-message POST /session `{}`, production
//      GET/PATCH/GET, the writer event stream's `info.id`, SQLite
//      read-only readback, an owned serve restart, a second same-database
//      management connection, and a deliberate database mismatch diagnosed
//      without losing the Freshell name.
//
// Exit codes: 0 only when ALL THREE provider contracts ran and passed;
// 1 for a contract failure (including a missing/skipped provider result —
// there is no skip/opt-in success state); 2 for a missing prerequisite
// (input/runtime/image), reported before any provider work.
//
// Containment: every child process this runner spawns is recorded and
// stopped by exactly that PID; no broad kill patterns; no npm install,
// package discovery, or dependency upgrade ever happens here; no corpus,
// credentials, or operator home is read. All writes stay under the
// explicit scratch and receipt directories the wrapper mounts.

import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import readline from 'node:readline'

const RUNNER_VERSION = 1

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argValue(name) {
  const argv = process.argv.slice(2)
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return undefined
  return argv[index + 1]
}

function parseArgs() {
  const args = {
    claudeRoot: argValue('--claude-root'),
    codexRoot: argValue('--codex-root'),
    opencodeRoot: argValue('--opencode-root'),
    runtimeRoot: argValue('--runtime-root'),
    scratch: argValue('--scratch'),
    receipt: argValue('--receipt'),
  }
  const missing = Object.entries(args).filter(([, value]) => !value).map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(`missing required arguments: ${missing.join(', ')}`)
  }
  for (const key of ['claudeRoot', 'codexRoot', 'opencodeRoot', 'runtimeRoot', 'scratch']) {
    args[key] = path.resolve(args[key])
  }
  return args
}

// ---------------------------------------------------------------------------
// Receipt plumbing (structured, mandatory fields per provider)
// ---------------------------------------------------------------------------

class Receipt {
  constructor(receiptPath) {
    this.receiptPath = receiptPath
    this.startedAt = new Date().toISOString()
    this.operations = []
    this.providers = {}
    this.overall = 'pending'
  }

  operation(provider, name, detail) {
    this.operations.push({ provider, name, ...detail })
  }

  fail(provider, message) {
    if (!this.providers[provider]) this.providers[provider] = {}
    this.providers[provider].outcome = 'fail'
    this.providers[provider].failure = message
    this.overall = 'fail'
  }

  write(extra = {}) {
    const document = {
      version: 1,
      runnerVersion: RUNNER_VERSION,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      overall: this.overall,
      operations: this.operations,
      providers: this.providers,
      ...extra,
    }
    fs.mkdirSync(path.dirname(this.receiptPath), { recursive: true })
    fs.writeFileSync(this.receiptPath, `${JSON.stringify(document, null, 2)}\n`)
    return document
  }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

// ---------------------------------------------------------------------------
// Owned-process plumbing
// ---------------------------------------------------------------------------

/** Every child PID this runner spawned, for owned cleanup. */
const ownedPids = new Set()

function recordOwnedProcess(child) {
  if (child.pid) ownedPids.add(child.pid)
  return child
}

function stopOwnedProcesses() {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
  const deadline = Date.now() + 5000
  for (const pid of ownedPids) {
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch {
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  ownedPids.clear()
}

process.once('SIGTERM', () => {
  stopOwnedProcesses()
  process.exit(1)
})
process.once('SIGINT', () => {
  stopOwnedProcesses()
  process.exit(1)
})
process.once('exit', () => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
})

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

async function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(() => resolve(port))
    })
    server.on('error', reject)
  })
}

function withTimeout(promise, ms, what) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms)),
  ])
}

async function pollUntil(describe, fn, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${describe}; last value: ${JSON.stringify(last) ?? 'none'}`)
}

async function fetchJson(url, options = {}, timeoutMs = 20_000) {
  const response = await withTimeout(fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...options }), timeoutMs + 1_000, `fetch ${url}`)
  const body = await response.json().catch(() => null)
  return { status: response.status, ok: response.ok, body }
}

/** Read a package.json version, or null. */
function readPackageVersion(dir, filename = 'package.json') {
  try {
    const raw = fs.readFileSync(path.join(dir, filename), 'utf8')
    return JSON.parse(raw).version ?? null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The JSON-RPC app-server client (codex, over stdio)
// ---------------------------------------------------------------------------

class CodexAppServer {
  constructor(binary, env, label) {
    this.binary = binary
    this.env = env
    this.label = label
    this.nextId = 1
    this.pending = new Map()
    this.notifications = []
    this.buffer = ''
  }

  async start() {
    this.child = recordOwnedProcess(spawn(this.binary, ['app-server'], {
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    }))
    this.child.stdout.on('data', (chunk) => this.onData(chunk))
    // The real CLI's stderr is the only honest diagnostic for a boot
    // failure (its existence checks, auth/config bootstrap errors), and a
    // timeout against a dead process is otherwise unattributable.
    const stderrTail = []
    this.child.stderr.on('data', (chunk) => {
      if (stderrTail.length < 40) stderrTail.push(String(chunk))
      if (process.env.FRESHELL_NATIVE_SMOKE_VERBOSE) {
        process.stderr.write(`[native-session-names] ${this.label} stderr: ${String(chunk).slice(0, 400)}`)
      }
    })
    this.stderrTail = stderrTail
    this.exited = new Promise((resolve) => this.child.once('exit', resolve))
    // The initialize window must cover the REAL CLI's cold boot inside
    // the no-network container (config/telemetry attempts stall to their
    // own timeouts before the handshake answers — observed >20s on the
    // first spawn; warm processes answer in well under a second).
    try {
      this.initializeResult = await this.request(
        'initialize',
        {
          clientInfo: { name: 'freshell-native-contract', version: String(RUNNER_VERSION) },
          capabilities: { experimentalApi: true },
        },
        90_000,
      )
    } catch (error) {
      const tail = (this.stderrTail ?? []).join('').slice(-1_200)
      const exit = await Promise.race([
        this.exited.then((code) => `exit ${code}`),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 2_000)),
      ])
      throw new Error(`${error.message}${tail ? ` (CLI stderr: ${tail})` : ''} (CLI process: ${exit})`)
    }
    this.notify('initialized')
    return this.initializeResult
  }

  onData(chunk) {
    this.buffer += String(chunk)
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) {
          reject(new Error(`JSON-RPC error ${message.error.code}: ${message.error.message}`))
        } else {
          resolve(message.result)
        }
      } else if (message.method !== undefined) {
        this.notifications.push(message)
      }
    }
  }

  request(method, params, timeoutMs = 20_000) {
    const id = this.nextId++
    return withTimeout(new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }), timeoutMs, `${this.label} ${method}`)
  }

  notify(method) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method })}\n`)
  }

  /** Best-effort graceful stop of this OWNED process (never a broad kill). */
  stop() {
    try {
      this.child.stdin.end()
    } catch {
      // already closed
    }
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
}

// ---------------------------------------------------------------------------
// The staged Freshell Rust server
// ---------------------------------------------------------------------------

class RustServer {
  constructor(runtimeRoot, scratch, receipt) {
    this.binary = path.join(runtimeRoot, 'bin', 'freshell-server')
    this.scratch = scratch
    this.receipt = receipt
  }

  async start(opts = {}) {
    const port = await pickFreePort()
    const token = `native-contract-${randomUUID()}`
    const home = opts.home ?? path.join(this.scratch, 'server-home')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(path.join(home, '.freshell'), { recursive: true })
    const logsDir = path.join(home, '.freshell', 'logs')
    fs.mkdirSync(logsDir, { recursive: true })
    this.home = home
    this.port = port
    this.token = token
    this.baseUrl = `http://127.0.0.1:${port}`
    // The provider-child environment is built from an ALLOWLIST — scratch
    // HOME/config/data roots and the fixed tool paths; no inherited model
    // credentials or operator config ever reach the server or its children.
    this.env = {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: home,
      FRESHELL_HOME: home,
      PORT: String(port),
      FRESHELL_BIND_HOST: '127.0.0.1',
      AUTH_TOKEN: token,
      FRESHELL_CLIENT_DIR: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'client'),
      FRESHELL_LOG_DIR: logsDir,
      HIDE_STARTUP_TOKEN: 'true',
      NODE_ENV: 'production',
      CLAUDE_CONFIG_DIR: claudeConfigRootPath(this.scratch),
      // The session INDEX resolves the claude root as CLAUDE_HOME else
      // <HOME>/.claude and deliberately NEVER searches CLAUDE_CONFIG_DIR
      // (Node-parity, documented on resolve_claude_exact_id_fallback).
      // Point CLAUDE_HOME at the same config root so the synthetic
      // transcript is both SDK-addressable AND index-visible.
      CLAUDE_HOME: claudeConfigRootPath(this.scratch),
      CODEX_HOME: codexHomePath(),
      CODEX_CMD: this.scratchCodexCmd ?? '/opt/freshell-native/codex/bin/codex',
      ...Object.fromEntries([
        ['XDG_DATA_HOME', opencodeXdgRoots().data],
        ['XDG_CONFIG_HOME', opencodeXdgRoots().configGlobal],
        ['XDG_CACHE_HOME', opencodeXdgRoots().cache],
        ['XDG_STATE_HOME', opencodeXdgRoots().state],
        ['TMPDIR', opencodeXdgRoots().tmp],
      ]),
      OPENCODE_CMD: '/opt/freshell-native/opencode/bin/opencode',
      OPENCODE_LOG_LEVEL: 'WARN',
      FRESHELL_CLAUDE_NODE: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'node', 'bin', 'node'),
      FRESHELL_CLAUDE_SIDECAR: path.join(this.runtimeRoot ?? '/opt/freshell-runtime', 'claude-sidecar', 'index.mjs'),
      ...opts.env,
    }
    this.logFile = path.join(logsDir, `native-contract-${port}.log`)
    const logStream = fs.openSync(this.logFile, 'a')
    this.child = recordOwnedProcess(spawn(this.binary, [], {
      env: this.env,
      stdio: ['ignore', logStream, logStream],
      detached: false,
    }))
    await withTimeout(pollUntil(
      'server health',
      async () => {
        try {
          const { ok, body } = await fetchJson(`${this.baseUrl}/api/health`, {}, 3_000)
          return ok && body?.ok === true
        } catch {
          return false
        }
      },
      60_000,
      200,
    ), 70_000, 'server health')
    return this
  }

  /** Owned stop: exactly this process (its own children are reaped by its
   * graceful shutdown, backstopped by the runner's owned-PID sweep). */
  stop() {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      try {
        process.kill(this.child.pid, 0)
      } catch {
        break
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    try {
      this.child.kill('SIGKILL')
    } catch {
      // already gone
    }
  }

  authHeaders() {
    return { 'x-auth-token': this.token, 'content-type': 'application/json' }
  }

  async renameCanonical(target, name, nameIntent) {
    return fetchJson(`${this.baseUrl}/api/session-names`, {
      method: 'PATCH',
      headers: this.authHeaders(),
      body: JSON.stringify({ target, name, ...(nameIntent ? { nameIntent } : {}) }),
    })
  }

  async readNames(refs) {
    const result = await fetchJson(`${this.baseUrl}/api/session-names/read`, {
      method: 'POST',
      headers: this.authHeaders(),
      body: JSON.stringify({ refs }),
    })
    if (!result.ok) throw new Error(`session-names read failed: ${result.status} ${JSON.stringify(result.body)}`)
    return result.body.names ?? []
  }

  async readOne(target) {
    const names = await this.readNames([target])
    return names.find((update) => sameRef(update.record.ref, target) || redirectsTo(update, target)) ?? null
  }

  /** The pane content's naming identity from the server's layout snapshot
   * (the authoritative `nameRef`, falling back to the pre-durable
   * `namingHandle`). */
  async paneNamingRef(tabId, paneId) {
    const { ok, body } = await fetchJson(`${this.baseUrl}/api/layout/snapshot?tabId=${encodeURIComponent(tabId)}`, { headers: this.authHeaders() })
    if (!ok) return null
    const findContent = (node) => {
      if (!node || typeof node !== 'object') return null
      if (node.id === paneId && node.content && typeof node.content === 'object') return node.content
      for (const child of node.children ?? []) {
        const found = findContent(child)
        if (found) return found
      }
      return null
    }
    for (const layout of Object.values(body?.data?.layouts ?? {})) {
      const content = findContent(layout)
      if (content) {
        if (content.nameRef && typeof content.nameRef === 'object') return content.nameRef
        if (typeof content.namingHandle === 'string') return { kind: 'pending', id: content.namingHandle }
      }
    }
    return null
  }

  /** Wait until the record for `target` reports the wanted nativeSync status. */
  async waitForNativeSync(target, statuses, timeoutMs = 60_000) {
    return pollUntil(
      `nativeSync ${statuses.join('|')} for ${JSON.stringify(target)}`,
      async () => {
        const update = await this.readOne(target)
        if (!update) return null
        if (statuses.includes(update.nativeSync?.status)) return update
        return null
      },
      timeoutMs,
      250,
    )
  }

  /** A raw WS client for the freshAgent.create lane (Node 22's global WebSocket). */
  async wsHello() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws`)
    await withTimeout(new Promise((resolve, reject) => {
      ws.once?.('open', resolve)
      ws.addEventListener('open', resolve)
      ws.addEventListener('error', reject)
    }), 15_000, 'ws open')
    const frames = []
    ws.addEventListener('message', (event) => {
      try {
        frames.push(JSON.parse(String(event.data)))
      } catch {
        // ignore non-JSON frames
      }
    })
    ws.send(JSON.stringify({ type: 'hello', token: this.token, protocolVersion: 10 }))
    await withTimeout(new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('ready frame timeout')), 15_000)
      const check = () => {
        if (frames.some((frame) => frame.type === 'ready')) {
          clearTimeout(deadline)
          resolve()
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    }), 20_000, 'ws ready')
    return { ws, frames }
  }

  async waitForFrame(frames, type, timeoutMs = 30_000) {
    return withTimeout(new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`frame ${type} timeout`)), timeoutMs)
      const check = () => {
        const match = frames.find((frame) => frame.type === type)
        if (match) {
          clearTimeout(deadline)
          resolve(match)
        } else {
          setTimeout(check, 100)
        }
      }
      check()
    }), timeoutMs + 1_000, `frame ${type}`)
  }
}

function sameRef(a, b) {
  return JSON.stringify(refKeyParts(a)) === JSON.stringify(refKeyParts(b))
}

function refKeyParts(ref) {
  if (!ref || typeof ref !== 'object') return null
  if (ref.kind === 'pending') return ['pending', ref.id]
  if (ref.kind === 'session') return ['session', ref.provider, ref.sessionId]
  return null
}

function redirectsTo(update, target) {
  return (update.redirects ?? []).some((redirect) => sameRef(redirect.from, target))
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function preflight(args) {
  const problems = []
  const required = [
    ['claude distribution', path.join(args.claudeRoot, 'bin'), (p) => fs.existsSync(p)],
    ['codex metadata core', path.join(args.codexRoot, 'bin', 'codex'), (p) => fs.existsSync(p)],
    ['codex layout manifest', path.join(args.codexRoot, 'codex-package.json'), (p) => fs.existsSync(p)],
    ['opencode distribution', path.join(args.opencodeRoot, 'bin', 'opencode'), (p) => fs.existsSync(p)],
    ['staged rust server', path.join(args.runtimeRoot, 'bin', 'freshell-server'), (p) => fs.existsSync(p)],
    ['staged client', path.join(args.runtimeRoot, 'client', 'index.html'), (p) => fs.existsSync(p)],
    ['staged node', path.join(args.runtimeRoot, 'node', 'bin', 'node'), (p) => fs.existsSync(p)],
    ['staged claude helper', path.join(args.runtimeRoot, 'claude-sidecar', 'session-names.mjs'), (p) => fs.existsSync(p)],
    ['staged claude SDK', path.join(args.runtimeRoot, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), (p) => fs.existsSync(p)],
  ]
  const observed = {}
  for (const [name, target, exists] of required) {
    if (!exists(target)) {
      problems.push(`missing ${name}: ${target}`)
    }
  }
  const versions = {
    installedClaudeCli: readPackageVersion(args.claudeRoot),
    // The staged codex input carries its version in the vendor tree's
    // `codex-package.json` (the wrapper's declared versionFile) — the
    // vendored musl dir ships no `package.json`.
    codex: readPackageVersion(args.codexRoot, 'codex-package.json'),
    opencode: readPackageVersion(args.opencodeRoot),
    stagedClaudeSdk: (() => {
      try {
        return JSON.parse(fs.readFileSync(path.join(args.runtimeRoot, 'claude-sidecar', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version ?? null
      } catch {
        return null
      }
    })(),
  }
  for (const [key, value] of Object.entries(versions)) {
    if (value === null) problems.push(`could not read version: ${key}`)
  }
  observed.versions = versions
  const hashes = {}
  for (const [name, file] of [
    ['codexBinary', path.join(args.codexRoot, 'bin', 'codex')],
    ['opencodeBinary', path.join(args.opencodeRoot, 'bin', 'opencode')],
    ['stagedServer', path.join(args.runtimeRoot, 'bin', 'freshell-server')],
  ]) {
    try {
      hashes[name] = sha256File(file)
    } catch {
      problems.push(`could not hash ${name}`)
    }
  }
  observed.hashes = hashes
  return { problems, observed }
}

// ---------------------------------------------------------------------------
// Claude contract
// ---------------------------------------------------------------------------

function mangleClaudeProject(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9]/g, '-')
}

/** The claude config root, on the CONTAINER's own filesystem (never the
 * 9p scratch bind): the server's session watcher indexes new transcripts
 * through inotify, and inotify does not fire across the bind — a root on
 * the bind means the 'claude session indexed' poll can never succeed. */
function claudeConfigRootPath(scratch) {
  return path.join('/tmp', 'native-claude-config-root')
}

/** The codex CODEX_HOME, on the CONTAINER's own filesystem: the real CLI
 * is a static musl binary whose filesystem probes against the 9p scratch
 * bind fail (its boot check answers "path does not exist" even when the
 * node-spawned runner just created it), so its home — and the server's
 * matching CODEX_HOME — must live on overlayfs. */
function codexHomePath() {
  // Under the CONTAINER USER's home (overlayfs — the static-musl CLI's
  // probes can see it) and NOT under /tmp: the CLI refuses to create its
  // helper binaries under a temporary dir ("Refusing to create helper
  // binaries under temporary dir /tmp"), so /tmp homes are rejected by
  // its own policy.
  return path.join('/home/sandbox', '.native-smoke', 'codex-home')
}

/** The opencode XDG roots, same rationale as [`codexHomePath`]. */
function opencodeXdgRoots() {
  const base = path.join('/home/sandbox', '.native-smoke', 'opencode')
  return {
    data: path.join(base, 'data'),
    configGlobal: path.join(base, 'config-global'),
    cache: path.join(base, 'cache'),
    state: path.join(base, 'state'),
    tmp: path.join(base, 'tmp'),
  }
}

async function runClaudeHelper(args, request, claudeConfigRoot) {
  const helper = path.join(args.runtimeRoot, 'claude-sidecar', 'session-names.mjs')
  const node = path.join(args.runtimeRoot, 'node', 'bin', 'node')
  const child = recordOwnedProcess(spawn(node, [helper], {
    env: {
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: path.join(args.scratch, 'claude', 'home'),
      CLAUDE_CONFIG_DIR: claudeConfigRoot,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }))
  // A wedged helper is diagnosable from its kernel wait channel: a silent
  // timeout with zero stdout AND zero stderr must still answer WHERE the
  // process sits (uninterruptible 9p I/O, a lock wait, a stopped state),
  // or the failure is unattributable.
  const procStateOf = () => {
    if (!child.pid) return '(no pid)'
    try {
      const state = fs.readFileSync(`/proc/${child.pid}/status`, 'utf8')
      const wchan = fs.readFileSync(`/proc/${child.pid}/wchan`, 'utf8').trim()
      const stateLine = state.split('\n').find((l) => l.startsWith('State:')) ?? ''
      const threads = state.split('\n').find((l) => l.startsWith('Threads:')) ?? ''
      return `state=${stateLine} wchan=${wchan} ${threads}`
    } catch (error) {
      return `(unreadable: ${error.code ?? error.message})`
    }
  }
  const stdout = []
  const stderrTail = []
  child.stdout.on('data', (chunk) => stdout.push(String(chunk)))
  child.stderr.on('data', (chunk) => {
    if (stderrTail.length < 40) stderrTail.push(String(chunk))
    if (process.env.FRESHELL_NATIVE_SMOKE_VERBOSE) {
      process.stderr.write(`[native-session-names] helper stderr: ${String(chunk).slice(0, 400)}`)
    }
  })
  // The answer window must cover the container's COLD first-import of the
  // staged node binary + the Claude SDK tree over the read-only 9p mount
  // (observed >25s under host load on the first-ever exec; warm runs answer
  // in milliseconds). 90s leaves real headroom without masking a genuine
  // helper wedge (the ops that follow still fail loudly on their own).
  // Register the answer listeners FIRST, WRITE THE REQUEST, and only then
  // await: awaiting before the write is a self-deadlock (the helper idles
  // in ep_poll waiting for stdin while the runner waits for stdout — the
  // request would only be written after the answer window expired). This
  // path was never exercised end-to-end until the container prerequisites
  // passed (the glibc-2.38 image rebase), and the first real run exposed
  // the inversion (state=S wchan=ep_poll at the 90s timeout).
  const answerPromise = new Promise((resolve, reject) => {
    let buffer = ''
    child.stdout.on('data', (chunk) => {
      buffer += String(chunk)
      const newline = buffer.indexOf('\n')
      if (newline !== -1) {
        resolve(buffer.slice(0, newline))
      }
    })
    child.once('exit', () => reject(new Error(`helper exited before answering: ${buffer}`)))
    child.once('error', reject)
  })
  try {
    child.stdin.write(`${JSON.stringify(request)}\n`)
  } catch (error) {
    throw new Error(`helper stdin write failed: ${error.message}`)
  }
  const answer = await withTimeout(answerPromise, 90_000, 'claude helper answer')
    .catch((error) => {
      // An answer failure must carry the helper's own stderr + its
      // kernel wait state — the only honest way to distinguish a wedged
      // import (uninterruptible 9p I/O, a lock wait, a stopped state)
      // from an environment failure inside the staged sidecar. This
      // outer catch sees BOTH the timeout rejection and the inner
      // failure path.
      const tail = stderrTail.join('').slice(-1_200)
      throw new Error(`${error.message}${tail ? ` (helper stderr: ${tail})` : ''} (helper proc: ${procStateOf()})`)
    })
  const parsed = JSON.parse(answer)
  try {
    child.stdin.end()
    child.kill('SIGTERM')
  } catch {
    // already gone
  }
  return parsed
}

async function claudeContract(args, server, receipt, observed) {
  const provider = 'claude'
  const result = {
    persistence: 'fail',
    freshReadback: 'fail',
    sourceProtection: 'fail',
    liveRedraw: 'not_measured',
    outcome: 'fail',
    versions: {},
    route: null,
    operations: [],
  }
  receipt.providers[provider] = result
  try {
    const claudeScratch = path.join(args.scratch, 'claude')
    const configRoot = claudeConfigRootPath(args.scratch)
    const projectDir = path.join(claudeScratch, 'proj')
    fs.mkdirSync(projectDir, { recursive: true })
    const sessionId = randomUUID()
    const messageUuid = randomUUID()
    const transcriptRel = path.join('projects', mangleClaudeProject(projectDir), `${sessionId}.jsonl`)
    const transcriptPath = path.join(configRoot, transcriptRel)
    fs.mkdirSync(path.dirname(transcriptPath), { recursive: true })
    const firstMessage = 'Probe the sardine factory'
    // TWO user-authored records: the session directory's parity filter
    // hides a single-turn transcript (`user_message_count <= 1` is
    // non-interactive) — the same rule the e2e journeys model with a
    // second turn. Without the second record the 'indexed' poll below
    // can never see the session.
    fs.writeFileSync(transcriptPath, `${JSON.stringify({
      parentUuid: null,
      isSidechain: false,
      type: 'user',
      uuid: messageUuid,
      sessionId,
      timestamp: '2026-09-18T07:00:00.000Z',
      cwd: projectDir,
      message: { role: 'user', content: firstMessage },
    })}\n${JSON.stringify({
      parentUuid: messageUuid,
      isSidechain: false,
      type: 'user',
      uuid: randomUUID(),
      sessionId,
      timestamp: '2026-09-18T07:00:01.000Z',
      cwd: projectDir,
      message: { role: 'user', content: 'The sardine factory ran all night' },
    })}\n`)
    result.route = {
      configRoot,
      project: projectDir,
      transcript: `${configRoot}/${transcriptRel.split(path.sep).join('/')}`,
      sessionId,
    }
    result.versions = {
      installedClaudeCli: observed.versions.installedClaudeCli,
      stagedClaudeSdk: observed.versions.stagedClaudeSdk,
    }

    // (1) Direct helper read: the synthetic ordinary user record is readable
    // by the real SDK, with no custom title yet.
    const read1 = await runClaudeHelper(args, { op: 'read', sessionId, dir: projectDir }, configRoot)
    if (!read1.ok) throw new Error(`helper read failed: ${JSON.stringify(read1)}`)
    if (read1.customTitle !== null) throw new Error(`expected no customTitle, got ${read1.customTitle}`)
    if (read1.firstPrompt !== firstMessage) throw new Error(`firstPrompt mismatch: ${read1.firstPrompt}`)
    result.operations.push('helper:read')

    // (2) Direct helper rename + fresh-process readback (real SDK).
    const rename1 = await runClaudeHelper(args, { op: 'rename', sessionId, title: 'Claude native probe name', dir: projectDir }, configRoot)
    if (!rename1.ok) throw new Error(`helper rename failed: ${JSON.stringify(rename1)}`)
    result.operations.push('helper:rename')
    const read2 = await runClaudeHelper(args, { op: 'read', sessionId, dir: projectDir }, configRoot)
    if (!read2.ok || read2.customTitle !== 'Claude native probe name') {
      throw new Error(`fresh helper readback mismatch: ${JSON.stringify(read2)}`)
    }
    result.freshReadback = 'pass'
    result.persistence = 'pass'
    result.operations.push('helper:freshReadback')

    // (3) Non-target session under a second project: a byte-identical
    // duplicate of the PRE-rename content carrying a DIFFERENT session id
    // (a genuinely other session). Selected-root targeting must leave it
    // untouched. A same-id copy here would trip the native lane's own
    // ambiguity guard (correctly, by step (9)'s own standard) and make
    // the writeback in (4) permanently `unsupported` — the original
    // same-id design was self-contradictory.
    const otherProject = path.join(claudeScratch, 'other-proj')
    fs.mkdirSync(otherProject, { recursive: true })
    const nonTargetSessionId = randomUUID()
    const nonTargetPath = path.join(configRoot, 'projects', mangleClaudeProject(otherProject), `${nonTargetSessionId}.jsonl`)
    fs.mkdirSync(path.dirname(nonTargetPath), { recursive: true })
    fs.writeFileSync(nonTargetPath, fs.readFileSync(transcriptPath, 'utf8').replaceAll(sessionId, nonTargetSessionId))
    const nonTargetBefore = sha256File(nonTargetPath)

    // (4) Through the Rust rename route: the server's index adopts the
    // transcript, the canonical rename lands with user intent, and the
    // native worker writes back through the same staged helper.
    const target = { kind: 'session', provider: 'claude', sessionId }
    try {
      await pollUntil(
        'claude session indexed',
        async () => {
          const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
          return (body?.items ?? []).some((item) => item.provider === 'claude' && item.sessionId === sessionId)
        },
        // The scratch is a 9p bind — inotify does not fire on it, so the
        // ONLY discovery path is the watcher's 60s rearm tick (its
        // watch-set replan scans the disk). The window must span at least
        // two ticks (a first tick can race the transcript's debounce).
        150_000,
      )
    } catch (error) {
      // Diagnose whether the server sees the transcript AT ALL (the raw
      // sessions list) versus only the directory's parity/priority filters
      // hiding it — the fix differs entirely between the two.
      let rawSees = 'unknown'
      let directoryUnfilteredSees = 'unknown'
      try {
        const { body } = await fetchJson(`${server.baseUrl}/api/sessions`, { headers: server.authHeaders() })
        rawSees = JSON.stringify(body).includes(sessionId)
      } catch { /* the raw list may be unavailable */ }
      try {
        const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?limit=200`, { headers: server.authHeaders() })
        directoryUnfilteredSees = (body?.items ?? []).some((item) => item.provider === 'claude' && item.sessionId === sessionId)
      } catch { /* the unfiltered directory may be unavailable */ }
      throw new Error(`${error.message}; raw /api/sessions contains the session: ${rawSees}; unfiltered session-directory contains it: ${directoryUnfilteredSees}`)
    }
    result.operations.push('server:indexAdopted')
    // The canonical rename needs the naming RECORD, and the record is
    // created by the auto-title sweep's hydration of the just-indexed
    // transcript (the authority never creates records from a rename) —
    // poll for the hydrated record first, or the rename 404s the race.
    await pollUntil(
      'claude naming record hydrated',
      async () => (await server.readOne(target)) !== null,
      150_000,
    )
    result.operations.push('server:namingRecordHydrated')
    const manualName = 'Native manual name'
    const renameRoute = await server.renameCanonical(target, manualName, 'user')
    if (!renameRoute.ok) throw new Error(`canonical rename failed: ${renameRoute.status} ${JSON.stringify(renameRoute.body)}`)
    if (renameRoute.body?.record?.name !== manualName || renameRoute.body?.record?.source !== 'manual') {
      throw new Error(`canonical rename answer mismatch: ${JSON.stringify(renameRoute.body)}`)
    }
    result.operations.push('server:rename:user')
    const synced = await server.waitForNativeSync(target, ['synced'], 90_000)
    result.operations.push('server:nativeWriteback:synced')
    if (synced.record.name !== manualName || synced.record.source !== 'manual') {
      throw new Error(`post-writeback canonical record mismatch: ${JSON.stringify(synced.record)}`)
    }
    result.sourceProtection = 'pass'
    result.nativeValue = synced.nativeSync

    // (5) Own-echo protection: the writeback appended a custom-title record;
    // the ingestion lane folds it as an automatic own-write echo and the
    // canonical record keeps the manual source and name. Give the ingestion
    // lane a bounded window, then assert.
    await new Promise((resolve) => setTimeout(resolve, 2_000))
    const echoRecord = await server.readOne(target)
    if (echoRecord.record.name !== manualName || echoRecord.record.source !== 'manual') {
      throw new Error(`own-echo protection failed: ${JSON.stringify(echoRecord.record)}`)
    }
    result.operations.push('server:ownEchoProtection')

    // (6) Fresh helper readback of the SERVER-written name.
    const read3 = await runClaudeHelper(args, { op: 'read', sessionId, dir: projectDir }, configRoot)
    if (!read3.ok || read3.customTitle !== manualName) {
      throw new Error(`server writeback helper readback mismatch: ${JSON.stringify(read3)}`)
    }
    result.operations.push('helper:serverWritebackReadback')

    // (7) The short generated-title value (Freshell AI style) is accepted
    // without changing the metadata shape: every transcript line still
    // parses as JSON, and the original records are intact.
    const shortName = 'Sardine fix'
    const renameRoute2 = await server.renameCanonical(target, shortName, 'automatic')
    if (!renameRoute2.ok) throw new Error(`automatic rename failed: ${renameRoute2.status}`)
    await server.waitForNativeSync(target, ['synced'], 90_000)
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((line) => line.trim().length > 0)
    for (const [index, line] of lines.entries()) {
      try {
        JSON.parse(line)
      } catch (error) {
        throw new Error(`transcript line ${index + 1} is no longer JSON after the short-name writeback: ${error.message}`)
      }
    }
    const firstLine = JSON.parse(lines[0])
    if (firstLine.type !== 'user' || firstLine.uuid !== messageUuid) {
      throw new Error(`the original user record was rewritten: ${lines[0]}`)
    }
    result.operations.push('server:shortNameWriteback:shapePreserved')

    // (8) Selected-root targeting: the non-target copy is untouched and no
    // duplicate canonical session was admitted.
    if (sha256File(nonTargetPath) !== nonTargetBefore) {
      throw new Error('the non-target duplicate copy was modified by a selected-root rename')
    }
    const directory = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
    const matching = (directory.body?.items ?? []).filter((item) => item.provider === 'claude' && item.sessionId === sessionId)
    if (matching.length > 1) {
      throw new Error(`duplicate canonical sessions admitted: ${matching.length} rows for ${sessionId}`)
    }
    result.operations.push('server:nonTargetUntouched')

    // (9) Ambiguous copies are not writable: a same-id copy with a
    // different signature must make the helper refuse the rename. The
    // copy must live at a FILENAME matching the session id (the SDK
    // resolves by file name, never by content) — its own path, never the
    // step-(3) non-target session's file.
    const ambiguousCopy = fs.readFileSync(transcriptPath, 'utf8') + `${JSON.stringify({ type: 'user', uuid: randomUUID(), parentUuid: messageUuid, sessionId, timestamp: '2026-09-18T07:05:00.000Z', cwd: otherProject, message: { role: 'user', content: 'divergent copy' } })}\n`
    const ambiguousPath = path.join(configRoot, 'projects', mangleClaudeProject(otherProject), `${sessionId}.jsonl`)
    fs.writeFileSync(ambiguousPath, ambiguousCopy)
    const ambiguous = await runClaudeHelper(args, { op: 'rename', sessionId, title: 'Must refuse', dir: projectDir }, configRoot)
    if (ambiguous.ok || ambiguous.class !== 'ambiguous') {
      throw new Error(`ambiguous copies must not be writable: ${JSON.stringify(ambiguous)}`)
    }
    result.operations.push('helper:ambiguousCopyRefused')

    result.outcome = 'pass'
    receipt.operation(provider, 'contract', { outcome: 'pass', nativeValue: result.nativeValue })
  } catch (error) {
    result.outcome = 'fail'
    result.failure = error.message
    receipt.operation(provider, 'contract', { outcome: 'fail', failure: error.message })
    throw error
  }
}

// ---------------------------------------------------------------------------
// Codex contract
// ---------------------------------------------------------------------------

function codexRolloutLines(input) {
  const { threadId, cwd, preview, timestamp, paginated } = input
  const meta = {
    session_id: threadId,
    id: threadId,
    timestamp,
    cwd,
    originator: 'codex',
    cli_version: '0.0.0',
    source: 'cli',
  }
  if (paginated) meta.history_mode = 'paginated'
  const lines = [
    { timestamp, type: 'session_meta', payload: meta },
    { timestamp, type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: preview }] } },
    { timestamp, type: 'event_msg', payload: { type: 'user_message', message: preview, kind: 'plain' } },
  ]
  return lines.map((line, ordinal) => (input.paginated ? JSON.stringify({ ...line, ordinal }) : JSON.stringify(line))).join('\n') + '\n'
}

function rolloutPath(codexHome, threadId) {
  return path.join(codexHome, 'sessions', '2026', '09', '18', `rollout-2026-09-18T08-00-00-${threadId}.jsonl`)
}

function codexChildEnv(codexHome, extra = {}) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(codexHome, '..'),
    CODEX_HOME: codexHome,
    ...extra,
  }
}

async function codexContract(args, server, receipt, observed) {
  const provider = 'codex'
  const result = {
    persistence: 'fail',
    freshReadback: 'fail',
    sourceProtection: 'pass',
    leaseSafety: 'fail',
    liveRedraw: 'not_measured',
    outcome: 'fail',
    versions: { codex: observed.versions.codex },
    route: null,
    operations: [],
  }
  receipt.providers[provider] = result
  let connectionA = null
  let connectionE = null
  let initE = null
  try {
    const codexScratch = path.join(args.scratch, 'codex')
    const home = codexHomePath()
    // The wrong-root twin lives under its OWN parent: codexChildEnv derives
    // HOME from the codex home's parent, and a shared parent means both
    // CLI instances collide on the same HOME-scoped state (the CLI's PATH
    // aliases/config bootstrap) — the second instance's initialize hangs
    // silently against the first's state.
    const homeB = path.join(path.dirname(codexHomePath()), 'b', path.basename(codexHomePath()))
    const projectDir = path.join(codexScratch, 'proj')
    // The real CLI REFUSES to boot when CODEX_HOME does not exist, and its
    // static-musl filesystem probes cannot see the 9p scratch bind anyway
    // — the container-local root is pre-created before the server boots
    // (main), and the wrong-root twin here for the lease-safety leg.
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(homeB, { recursive: true })
    fs.mkdirSync(projectDir, { recursive: true })
    const binary = path.join(args.codexRoot, 'bin', 'codex')

    const legacyId = '44444444-5555-4666-8777-888888888888'
    const paginatedId = '44444444-5555-4666-8777-999999999999'
    fs.mkdirSync(path.dirname(rolloutPath(home, legacyId)), { recursive: true })
    fs.writeFileSync(rolloutPath(home, legacyId), codexRolloutLines({ threadId: legacyId, cwd: projectDir, preview: 'Legacy layout probe', timestamp: '2026-09-18T08:00:00.000Z', paginated: false }))
    fs.writeFileSync(rolloutPath(home, paginatedId), codexRolloutLines({ threadId: paginatedId, cwd: projectDir, preview: 'Paginated layout probe', timestamp: '2026-09-18T08:00:00.000Z', paginated: true }))
    // Wrong-root isolation: the SAME thread id exists in a second scratch root.
    fs.mkdirSync(path.dirname(rolloutPath(homeB, legacyId)), { recursive: true })
    fs.writeFileSync(rolloutPath(homeB, legacyId), codexRolloutLines({ threadId: legacyId, cwd: projectDir, preview: 'Other root copy', timestamp: '2026-09-18T08:00:00.000Z', paginated: false }))
    const wrongRootBefore = sha256File(rolloutPath(homeB, legacyId))
    result.route = {
      codexHome: home,
      wrongRoot: homeB,
      legacyThread: legacyId,
      paginatedThread: paginatedId,
    }

    // (1) Root-matched initialize + thread/read + production name/set + read.
    connectionA = new CodexAppServer(binary, codexChildEnv(home), 'codex-A')
    const initialize = await connectionA.start()
    if (initialize.codexHome !== home) {
      throw new Error(`root-mismatch: initialize answered ${initialize.codexHome}, expected ${home}`)
    }
    result.initialize = { codexHome: initialize.codexHome, userAgent: initialize.userAgent }
    result.operations.push('appServer:initialize:rootMatched')

    // (5) The wrong-root connection BOOTS EARLY (right after the first):
    // booting it late — as the fifth live instance, after the lease legs —
    // reproducibly hangs its initialize in the no-network container
    // (observed: silent, process alive, >90s; the same CLI answers in
    // ~230ms when booted early or in isolation). The OBSERVATION still
    // happens at step (5), after A's renames.
    connectionE = new CodexAppServer(binary, codexChildEnv(homeB), 'codex-E')
    initE = await connectionE.start()
    if (initE.codexHome !== homeB) {
      throw new Error(`wrong-root connection initialized elsewhere: ${initE.codexHome}`)
    }

    const legacyRead1 = await connectionA.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (legacyRead1?.thread?.id !== legacyId || legacyRead1?.thread?.status?.type !== 'notLoaded') {
      throw new Error(`legacy thread/read mismatch: ${JSON.stringify(legacyRead1)}`)
    }
    if (legacyRead1?.thread?.preview !== 'Legacy layout probe') {
      throw new Error(`legacy preview mismatch: ${JSON.stringify(legacyRead1?.thread)}`)
    }
    result.operations.push('appServer:threadRead:legacy')

    const paginatedRead1 = await connectionA.request('thread/read', { threadId: paginatedId, includeTurns: false })
    if (paginatedRead1?.thread?.historyMode !== 'paginated') {
      throw new Error(`paginated thread/read mismatch: ${JSON.stringify(paginatedRead1?.thread)}`)
    }
    result.operations.push('appServer:threadRead:paginated')

    const nativeName = 'Native codex name'
    await connectionA.request('thread/name/set', { threadId: legacyId, name: nativeName })
    const legacyRead2 = await connectionA.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (legacyRead2?.thread?.name !== nativeName) {
      throw new Error(`name/set did not persist: ${JSON.stringify(legacyRead2?.thread)}`)
    }
    result.persistence = 'pass'
    result.operations.push('appServer:nameSet:persisted')
    await connectionA.request('thread/name/set', { threadId: paginatedId, name: 'Paginated native name' })
    const paginatedRead2 = await connectionA.request('thread/read', { threadId: paginatedId, includeTurns: false })
    if (paginatedRead2?.thread?.name !== 'Paginated native name') {
      throw new Error(`paginated name/set did not persist: ${JSON.stringify(paginatedRead2?.thread)}`)
    }
    result.operations.push('appServer:nameSet:paginated')

    // (2) Prospective start: thread/start's returned path must NOT exist on
    // disk (never treat a prospective start as closed persistence proof).
    const started = await connectionA.request('thread/start', { cwd: projectDir })
    const prospectiveId = started?.thread?.id
    const prospectivePath = started?.thread?.path
    if (!prospectiveId || !prospectivePath) {
      throw new Error(`thread/start did not return id/path: ${JSON.stringify(started)}`)
    }
    if (fs.existsSync(prospectivePath)) {
      throw new Error(`thread/start returned a path that already exists: ${prospectivePath}`)
    }
    result.prospectiveStart = { threadId: prospectiveId, path: prospectivePath, persistedAtStart: false }
    result.operations.push('appServer:threadStart:prospective')

    // (3) Close the management process; a FRESH process reads the name back.
    connectionA.stop()
    await connectionA.exited
    const connectionB = new CodexAppServer(binary, codexChildEnv(home), 'codex-B')
    const initB = await connectionB.start()
    if (initB.codexHome !== home) throw new Error('fresh process root mismatch')
    const freshRead = await connectionB.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (freshRead?.thread?.name !== nativeName) {
      throw new Error(`fresh management process lost the name: ${JSON.stringify(freshRead?.thread)}`)
    }
    result.freshReadback = 'pass'
    result.operations.push('appServer:freshProcessReadback')
    // B's role is done: stop it so the live-instance count stays low — a
    // fifth live CLI boot reproducibly hangs its initialize in the
    // no-network container (each stopped instance frees the budget).
    connectionB.stop()
    await connectionB.exited

    // (4) Execution-handle lease: resume the thread on connection C (owned
    // test setup, no turn); metadata work through connection D must never
    // steal or claim it.
    const connectionC = new CodexAppServer(binary, codexChildEnv(home), 'codex-C')
    await connectionC.start()
    await connectionC.request('thread/resume', { threadId: legacyId })
    const loadedOnC = await connectionC.request('thread/loaded/list', {})
    if (!(loadedOnC?.data ?? []).includes(legacyId)) {
      throw new Error(`thread/resume did not load the thread on connection C: ${JSON.stringify(loadedOnC)}`)
    }
    result.operations.push('appServer:resume:loadedHandle')
    const connectionD = new CodexAppServer(binary, codexChildEnv(home), 'codex-D')
    await connectionD.start()
    const leaseSafeName = 'Lease-safe rename'
    await connectionD.request('thread/name/set', { threadId: legacyId, name: leaseSafeName })
    const viaD = await connectionD.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (viaD?.thread?.name !== leaseSafeName) throw new Error('management rename via D did not persist')
    const loadedOnD = await connectionD.request('thread/loaded/list', {})
    if ((loadedOnD?.data ?? []).includes(legacyId)) {
      throw new Error(`management connection D loaded/resumed the thread: ${JSON.stringify(loadedOnD)}`)
    }
    const stillLoadedOnC = await connectionC.request('thread/loaded/list', {})
    if (!(stillLoadedOnC?.data ?? []).includes(legacyId)) {
      throw new Error('the original execution owner lost the loaded handle')
    }
    const readViaC = await connectionC.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (readViaC?.thread?.name !== leaseSafeName) throw new Error('the loaded handle did not observe the rename')
    result.leaseSafety = 'pass'
    result.operations.push('appServer:leaseSafety')

    // (5) Wrong-root isolation: renaming via root A leaves root B untouched.
    // (The connection booted early — see step (1); this is the observation.)
    const viaE = await connectionE.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (viaE?.thread?.name === leaseSafeName) {
      throw new Error('the wrong-root connection observed root A\'s name — roots are not isolated')
    }
    connectionE.stop()
    await connectionE.exited
    if (sha256File(rolloutPath(homeB, legacyId)) !== wrongRootBefore) {
      throw new Error('wrong-root rollout file was modified by root A\'s rename')
    }
    result.operations.push('appServer:wrongRootIsolation')

    // (6) Server-side writeback through a live root-matched freshcodex
    // connection: the runner speaks the real WS protocol to create a
    // freshcodex session, whose sidecar is a live app-server connection with
    // the matching initialized root. Stop the remaining CLI connections
    // FIRST: the server's own freshcodex sidecar is another live CLI
    // instance, and the container's fifth-live-boot hang (see step (1))
    // would otherwise hit the SERVER's created frame.
    connectionC.stop()
    await connectionC.exited
    connectionD.stop()
    await connectionD.exited
    const { ws, frames } = await server.wsHello()
    const requestId = randomUUID()
    ws.send(JSON.stringify({ type: 'freshAgent.create', requestId, sessionType: 'freshcodex', provider: 'codex', cwd: projectDir }))
    const createdFrame = await server.waitForFrame(frames, 'freshAgent.created', 60_000)
    result.freshCodexSession = createdFrame.sessionId
    const codexTarget = { kind: 'session', provider: 'codex', sessionId: legacyId }
    await pollUntil(
      'codex rollout indexed',
      async () => {
        const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
        return (body?.items ?? []).some((item) => item.provider === 'codex' && item.sessionId === legacyId)
      },
      45_000,
    )
    const serverName = 'Server-written codex name'
    const renameRoute = await server.renameCanonical(codexTarget, serverName, 'user')
    if (!renameRoute.ok) throw new Error(`server canonical rename failed: ${renameRoute.status} ${JSON.stringify(renameRoute.body)}`)
    const synced = await server.waitForNativeSync(codexTarget, ['synced'], 120_000)
    result.serverWriteback = synced.nativeSync
    const connectionF = new CodexAppServer(binary, codexChildEnv(home), 'codex-F')
    await connectionF.start()
    const serverWritten = await connectionF.request('thread/read', { threadId: legacyId, includeTurns: false })
    if (serverWritten?.thread?.name !== serverName) {
      throw new Error(`server writeback not visible to a fresh native read: ${JSON.stringify(serverWritten?.thread)}`)
    }
    connectionF.stop()
    result.operations.push('server:nativeWriteback:synced')
    try {
      ws.close()
    } catch {
      // already closed
    }

    // (7) Zero-turn prospective start/restart with a pending Freshell
    // rename (Task 2 exercise, no forced turn). The create response carries
    // tabId/paneId/terminalId only, so the pending naming identity is read
    // from the pane content in the layout snapshot (the server-side
    // authoritative `nameRef`/`namingHandle`).
    const createResponse = await fetchJson(`${server.baseUrl}/api/tabs`, {
      method: 'POST',
      headers: server.authHeaders(),
      body: JSON.stringify({ mode: 'codex', cwd: projectDir, name: 'Prospective zero-turn name' }),
    })
    if (!createResponse.ok) throw new Error(`codex REST create failed: ${createResponse.status} ${JSON.stringify(createResponse.body)}`)
    const paneData = createResponse.body?.data ?? {}
    const pendingTarget = await server.paneNamingRef(paneData.tabId, paneData.paneId)
    if (!pendingTarget) throw new Error(`codex REST create produced no pending naming identity: ${JSON.stringify(paneData)}`)
    const pendingName = 'Pending rename survives restart'
    const pendingRename = await server.renameCanonical(pendingTarget, pendingName, 'user')
    if (!pendingRename.ok) throw new Error(`pending rename failed: ${pendingRename.status}`)
    result.pendingHandle = pendingTarget
    result.pendingName = pendingName
    const pendingAfter = await server.readOne(pendingTarget)
    if (pendingAfter?.record?.name !== pendingName) throw new Error('pending rename did not land')
    result.operations.push('server:pendingRename')
    connectionC.stop()
    connectionD.stop()
    connectionB.stop()

    // Restart the OWNED server while the conversation is still zero-turn.
    const preRestartRevision = pendingAfter.record.revision
    server.stop()
    await server.start({ home: server.home })
    const pendingAfterRestart = await server.readOne(pendingTarget)
    if (pendingAfterRestart?.record?.name !== pendingName || pendingAfterRestart.record.revision < preRestartRevision) {
      throw new Error(`pending name did not survive the restart: ${JSON.stringify(pendingAfterRestart)}`)
    }
    result.pendingSurvivesRestart = true
    result.operations.push('server:zeroTurnRestart:pendingRetained')

    result.outcome = 'pass'
    receipt.operation(provider, 'contract', { outcome: 'pass' })
  } catch (error) {
    result.outcome = 'fail'
    result.failure = error.message
    receipt.operation(provider, 'contract', { outcome: 'fail', failure: error.message })
    throw error
  } finally {
    try {
      connectionA?.stop()
    } catch {
      // already stopped
    }
  }
}

// ---------------------------------------------------------------------------
// OpenCode contract
// ---------------------------------------------------------------------------

function opencodeChildEnv(opencodeScratch, extra = {}) {
  return {
    PATH: '/usr/local/bin:/usr/bin:/bin',
    HOME: path.join(opencodeScratch, 'home'),
    XDG_DATA_HOME: path.join(opencodeScratch, 'data'),
    XDG_CACHE_HOME: path.join(opencodeScratch, 'cache'),
    XDG_STATE_HOME: path.join(opencodeScratch, 'state'),
    XDG_CONFIG_HOME: path.join(opencodeScratch, 'config-global'),
    TMPDIR: path.join(opencodeScratch, 'tmp'),
    OPENCODE_TEST_MANAGED_CONFIG_DIR: path.join(opencodeScratch, 'managed-config'),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_PURE: '1',
    OPENCODE_DISABLE_DEFAULT_PLUGINS: '1',
    OPENCODE_DISABLE_MODELS_FETCH: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_LOG_LEVEL: 'WARN',
    OPENCODE_CONFIG_CONTENT: '{"snapshot":false}',
    ...extra,
  }
}

class OpencodeServe {
  constructor(opencodeBinary, scratch, label, extraEnv = {}) {
    this.binary = opencodeBinary
    this.scratch = scratch
    this.label = label
    this.extraEnv = extraEnv
    this.logChunks = []
  }

  async start() {
    this.port = await pickFreePort()
    const logStream = fs.openSync(path.join(this.scratch, `${this.label}.log`), 'a')
    this.child = recordOwnedProcess(spawn(this.binary, ['serve', '--hostname', '127.0.0.1', '--port', String(this.port)], {
      env: opencodeChildEnv(this.scratch, this.extraEnv),
      stdio: ['ignore', logStream, logStream],
    }))
    await withTimeout(pollUntil(
      `opencode serve ${this.label} health`,
      async () => {
        try {
          const { status } = await fetchJson(`http://127.0.0.1:${this.port}/global/health`, {}, 2_000)
          return status === 200
        } catch {
          return false
        }
      },
      60_000,
      200,
    ), 70_000, `opencode serve ${this.label} health`)
    return this
  }

  baseUrl() {
    return `http://127.0.0.1:${this.port}`
  }

  stop() {
    if (!this.child) return
    try {
      this.child.kill('SIGTERM')
    } catch {
      // already gone
    }
  }
}

async function opencodeContract(args, server, receipt, observed) {
  const provider = 'opencode'
  const result = {
    persistence: 'fail',
    freshReadback: 'fail',
    databaseMismatchDiagnosed: 'fail',
    liveRedraw: 'not_measured',
    outcome: 'fail',
    versions: { opencode: observed.versions.opencode },
    route: null,
    operations: [],
  }
  receipt.providers[provider] = result
  let serve1 = null
  let serve2 = null
  let serve3 = null
  let mismatchServer = null
  try {
    const opencodeScratch = path.join(args.scratch, 'opencode')
    for (const dir of ['home', 'data', 'cache', 'state', 'tmp', 'config-global/opencode', 'managed-config', 'proj', 'mismatch']) {
      fs.mkdirSync(path.join(opencodeScratch, dir), { recursive: true })
    }
    // The source-proven no-install path: preseed the global config's
    // .gitignore, then make the config tree READ-ONLY for the provider
    // child so opencode's npm-install early-return fires (a failed
    // background install would be a gate failure, not harmless noise).
    fs.writeFileSync(path.join(opencodeScratch, 'config-global', 'opencode', '.gitignore'), 'node_modules/\n')
    fs.rmSync(path.join(opencodeScratch, 'home', '.opencode'), { force: true, recursive: true })
    const binary = path.join(args.opencodeRoot, 'bin', 'opencode')
    const projectDir = path.join(opencodeScratch, 'proj')
    result.route = {
      dataHome: '/scratch/opencode/data',
      database: '/scratch/opencode/data/opencode/opencode.db',
      project: '/scratch/opencode/proj',
    }

    // (1) Zero-message POST /session {} on an owned scratch serve.
    serve1 = await new OpencodeServe(binary, opencodeScratch, 'serve1').start()
    const createResponse = await fetchJson(`${serve1.baseUrl()}/session?directory=${encodeURIComponent(projectDir)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    if (!createResponse.ok) throw new Error(`POST /session failed: ${createResponse.status}`)
    const session = createResponse.body
    if (typeof session?.id !== 'string' || !session.id.startsWith('ses_')) {
      throw new Error(`unexpected session row: ${JSON.stringify(session)}`)
    }
    if ((session?.cost ?? 0) !== 0 || (session?.tokens?.input ?? 0) !== 0) {
      throw new Error(`zero-message session must not cost tokens: ${JSON.stringify(session)}`)
    }
    result.sessionId = session.id
    result.createdTitle = session.title
    result.operations.push('serve:postSession:zeroMessage')

    // (2) Writer event stream: connect BEFORE the title write and record
    // the session.updated frame (properties.info.id must parse).
    const events = []
    const eventController = new AbortController()
    const eventReader = (async () => {
      try {
        const response = await fetch(`${serve1.baseUrl()}/event`, { signal: eventController.signal })
        const reader = response.body.getReader()
        let buffer = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += new TextDecoder().decode(value)
          let index
          while ((index = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, index)
            buffer = buffer.slice(index + 2)
            const dataLine = frame.split('\n').find((line) => line.startsWith('data: '))
            if (dataLine) {
              try {
                events.push(JSON.parse(dataLine.slice(6)))
              } catch {
                // ignore non-JSON frames
              }
            }
          }
        }
      } catch {
        // stream ended
      }
    })()

    // (3) Production GET/PATCH/GET through the runner-owned serve.
    const nativeTitle = 'Native opencode title'
    const patchResponse = await fetchJson(`${serve1.baseUrl()}/session/${session.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: nativeTitle }),
    })
    if (!patchResponse.ok || patchResponse.body?.title !== nativeTitle) {
      throw new Error(`PATCH /session/:id failed: ${patchResponse.status} ${JSON.stringify(patchResponse.body)}`)
    }
    result.operations.push('serve:patchTitle')
    const getResponse = await fetchJson(`${serve1.baseUrl()}/session/${session.id}`)
    if (getResponse.body?.title !== nativeTitle) {
      throw new Error(`GET after PATCH lost the title: ${JSON.stringify(getResponse.body)}`)
    }
    result.persistence = 'pass'
    result.operations.push('serve:getTitle')

    // (4) The writer event stream observed the update (bounded wait).
    const updatedEvent = await withTimeout(pollUntil(
      'session.updated event',
      async () => events.find((event) => event.type === 'session.updated' && (event.properties?.sessionID === session.id || event.properties?.info?.id === session.id)) ?? null,
      10_000,
      100,
    ), 12_000, 'session.updated event')
    result.eventShape = {
      type: updatedEvent.type,
      sessionID: updatedEvent.properties?.sessionID ?? null,
      infoId: updatedEvent.properties?.info?.id ?? null,
    }
    result.operations.push('serve:writerEventStream')

    // (5) SQLite stays read-only to Freshell and carries the row.
    const dbPath = path.join(opencodeScratch, 'data', 'opencode', 'opencode.db')
    const { execFile } = await import('node:child_process')
    const sqliteProbe = await new Promise((resolve) => {
      execFile('python3', ['-c', `
import sqlite3
conn = sqlite3.connect('file:${dbPath}?mode=ro', uri=True)
row = conn.execute('select id, title, directory from session where id = ?', ('${session.id}',)).fetchall()
messages = conn.execute("select count(*) from message where session_id = ?", ('${session.id}',)).fetchall()
print(row, messages[0][0])
`], (error, stdout) => resolve({ error, stdout: String(stdout) }))
    })
    if (sqliteProbe.error || !sqliteProbe.stdout.includes(nativeTitle)) {
      throw new Error(`SQLite readback mismatch: ${sqliteProbe.error?.message ?? sqliteProbe.stdout}`)
    }
    if (!/\[\], 0/.test(sqliteProbe.stdout) && !/\(\), 0\)/.test(sqliteProbe.stdout) && !sqliteProbe.stdout.includes(' 0')) {
      throw new Error(`message history must stay empty: ${sqliteProbe.stdout}`)
    }
    result.sqliteReadback = 'pass'
    result.operations.push('sqlite:readOnlyReadback:emptyHistory')

    // (6) Restart ONLY the owned scratch serve; the title persists.
    serve1.stop()
    serve2 = await new OpencodeServe(binary, opencodeScratch, 'serve2').start()
    const restartRead = await fetchJson(`${serve2.baseUrl()}/session/${session.id}`)
    if (restartRead.body?.title !== nativeTitle) {
      throw new Error(`serve restart lost the title: ${JSON.stringify(restartRead.body)}`)
    }
    result.freshReadback = 'pass'
    result.operations.push('serve:restartReadback')

    // (7) A second same-database management connection sees the row without
    // taking execution ownership.
    serve3 = await new OpencodeServe(binary, opencodeScratch, 'serve3').start()
    const secondConnectionRead = await fetchJson(`${serve3.baseUrl()}/session/${session.id}`)
    if (secondConnectionRead.body?.title !== nativeTitle) {
      throw new Error(`second management connection lost the title: ${JSON.stringify(secondConnectionRead.body)}`)
    }
    result.operations.push('serve:secondManagementConnection')

    // (8) Through the Rust rename route: the server's index adopts the row
    // and its managed serve writes back to the SAME effective database.
    const target = { kind: 'session', provider: 'opencode', sessionId: session.id }
    await pollUntil(
      'opencode session indexed',
      async () => {
        const { body } = await fetchJson(`${server.baseUrl}/api/session-directory?priority=visible&limit=50`, { headers: server.authHeaders() })
        return (body?.items ?? []).some((item) => item.provider === 'opencode' && item.sessionId === session.id)
      },
      60_000,
    )
    const serverName = 'Server-written opencode name'
    const renameRoute = await server.renameCanonical(target, serverName, 'user')
    if (!renameRoute.ok) throw new Error(`server canonical rename failed: ${renameRoute.status} ${JSON.stringify(renameRoute.body)}`)
    const synced = await server.waitForNativeSync(target, ['synced'], 180_000)
    result.serverWriteback = synced.nativeSync
    const viaServe2 = await fetchJson(`${serve2.baseUrl()}/session/${session.id}`)
    if (viaServe2.body?.title !== serverName) {
      throw new Error(`server writeback not visible to the native serve: ${JSON.stringify(viaServe2.body)}`)
    }
    result.operations.push('server:nativeWriteback:synced')

    // (9) Deliberate database mismatch: a second short-lived Rust server
    // whose OPENCODE_DB override points at a DIFFERENT scratch database must
    // diagnose the mismatch (native never syncs) without losing the Freshell
    // name in ITS canonical store.
    const mismatchDb = path.join(opencodeScratch, 'mismatch', 'other.db')
    mismatchServer = new RustServer(args.runtimeRoot, args.scratch, receipt)
    mismatchServer.runtimeRoot = args.runtimeRoot
    mismatchServer.scratchCodexCmd = path.join(args.codexRoot, 'bin', 'codex')
    await mismatchServer.start({
      home: path.join(args.scratch, 'server-home-mismatch'),
      env: { OPENCODE_DB: mismatchDb },
    })
    const mismatchName = 'Mismatch-server name'
    const mismatchRename = await mismatchServer.renameCanonical(target, mismatchName, 'user')
    if (!mismatchRename.ok) throw new Error(`mismatch-server rename failed: ${mismatchRename.status}`)
    await pollUntil(
      'mismatch-server nativeSync unsynced',
      async () => {
        const update = await mismatchServer.readOne(target)
        if (!update?.nativeSync) return null
        if (['unsynced', 'unsupported'].includes(update.nativeSync.status)) return update
        return null
      },
      120_000,
    )
    const mismatchRecord = await mismatchServer.readOne(target)
    if (mismatchRecord.record.name !== mismatchName) {
      throw new Error(`mismatch server lost the Freshell name: ${JSON.stringify(mismatchRecord.record)}`)
    }
    result.databaseMismatchDiagnosed = 'pass'
    result.mismatchNativeSync = mismatchRecord.nativeSync
    result.operations.push('server:databaseMismatch:diagnosed')
    mismatchServer.stop()
    mismatchServer = null

    // The REAL database row was never corrupted by the mismatch server.
    const realRead = await fetchJson(`${serve2.baseUrl()}/session/${session.id}`)
    if (realRead.body?.title !== serverName) {
      throw new Error(`mismatch server corrupted the real database row: ${JSON.stringify(realRead.body)}`)
    }
    result.operations.push('serve:realDatabaseUntouched')

    eventController.abort()
    result.outcome = 'pass'
    receipt.operation(provider, 'contract', { outcome: 'pass' })
  } catch (error) {
    result.outcome = 'fail'
    result.failure = error.message
    receipt.operation(provider, 'contract', { outcome: 'fail', failure: error.message })
    throw error
  } finally {
    for (const serve of [serve1, serve2, serve3]) {
      try {
        serve?.stop()
      } catch {
        // already stopped
      }
    }
    if (mismatchServer) mismatchServer.stop()
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs()
  fs.mkdirSync(args.scratch, { recursive: true })
  const receiptPath = args.receipt ?? path.join(args.scratch, 'receipt.json')
  const receipt = new Receipt(receiptPath)

  const { problems, observed } = preflight(args)
  const container = {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
  }
  if (problems.length > 0) {
    receipt.overall = 'prerequisite-missing'
    receipt.write({ prerequisites: { problems }, inputs: observed, container })
    process.stderr.write(`[native-session-names] missing prerequisites:\n${problems.map((problem) => `  - ${problem}`).join('\n')}\n`)
    stopOwnedProcesses()
    process.exit(2)
  }

  let server = null
  let failure = null
  try {
    // The claude config root must EXIST before the server boots: the
    // session watcher's late-root arming is bounded AT the provider home,
    // so an absent CLAUDE_HOME leaves nothing armed and the transcript's
    // later creation is never observed (observed end-to-end: the
    // 'indexed' poll never converged with a boot-time-absent root).
    fs.mkdirSync(path.join(claudeConfigRootPath(args.scratch), 'projects'), { recursive: true })
    fs.mkdirSync(codexHomePath(), { recursive: true })
    for (const root of Object.values(opencodeXdgRoots())) {
      fs.mkdirSync(root, { recursive: true })
    }
    server = new RustServer(args.runtimeRoot, args.scratch, receipt)
    server.runtimeRoot = args.runtimeRoot
    server.scratchCodexCmd = path.join(args.codexRoot, 'bin', 'codex')
    await server.start()

    receipt.operation('server', 'start', { port: server.port, home: server.home })
    await claudeContract(args, server, receipt, observed)
    await codexContract(args, server, receipt, observed)
    await opencodeContract(args, server, receipt, observed)
  } catch (error) {
    failure = error.message
    // The staged server's own log is the primary diagnostic for native
    // writeback/wedge failures, and the scratch bind is cleaned per-run —
    // carry its tail into the failure so the receipt answers WHY.
    try {
      const tail = fs.readFileSync(server?.logFile, 'utf8')
      failure += `\nserver log tail:\n${tail.slice(-4_000)}`
    } catch { /* the log may be absent */ }
    // The server's STRUCTURED logs are the JSONL files under its home
    // (its stdout stays near-silent) — carry the newest entries so a
    // sidecar/wedge failure is attributable.
    try {
      const logsDir = path.join(server?.home ?? '', '.freshell', 'logs')
      const files = fs.readdirSync(logsDir).filter((name) => name.endsWith('.jsonl')).sort()
      const newest = files.at(-1)
      if (newest) {
        const lines = fs.readFileSync(path.join(logsDir, newest), 'utf8').trim().split('\n')
        const interesting = lines.filter((line) => /codex|freshAgent|freshagent|sidecar|naming|native/i.test(line)).slice(-40)
        failure += `\nserver jsonl log tail (${newest}):\n${interesting.join('\n').slice(-6_000)}\n(last 8 raw):\n${lines.slice(-8).join('\n')}`
      }
    } catch { /* the logs dir may be absent */ }
    receipt.overall = 'fail'
  } finally {
    try {
      server?.stop()
    } catch {
      // already stopped
    }
    stopOwnedProcesses()
  }

  const providersPresent = ['claude', 'codex', 'opencode'].map((provider) => ({
    provider,
    ran: Boolean(receipt.providers[provider]),
    outcome: receipt.providers[provider]?.outcome ?? 'missing',
  }))
  const allPassed = providersPresent.every((entry) => entry.outcome === 'pass')
  const document = receipt.write({
    prerequisites: { problems: [] },
    inputs: observed,
    container,
    providersPresent,
    ...(failure ? { failure } : {}),
  })
  process.stdout.write(`${JSON.stringify({ overall: allPassed ? 'pass' : 'fail', providers: providersPresent }, null, 2)}\n`)
  process.stdout.write(`[native-session-names] receipt: ${receiptPath}\n`)
  process.exit(allPassed ? 0 : 1)
}

main().catch((error) => {
  process.stderr.write(`[native-session-names] unhandled failure: ${error?.stack ?? error}\n`)
  stopOwnedProcesses()
  process.exit(1)
})
