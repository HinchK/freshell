#!/usr/bin/env node
// HARNESS-03 deterministic fake `codex` APP-SERVER (the freshcodex sidecar),
// launched as `fake-codex-app-server.mjs --listen ws://host:port`.
//
// Wire surface mirrors test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
// (itself mirroring the real codex app-server + the consumers in
// crates/freshell-freshagent/src/codex.rs):
//   - every RPC before `initialize` is rejected ("initialize must complete
//     before other RPC methods");
//   - `initialize` -> { userAgent, codexHome, platformFamily, platformOs };
//   - `thread/start` -> { thread: { id, path, ephemeral }, cwd, model,
//     approvalPolicy: 'never', ... } AND writes the durable rollout file
//     (<CODEX_HOME>/sessions/yyyy/mm/dd/rollout-<ts>-<id>.jsonl) whose FIRST
//     line is the session_meta record (payload.id is the identity);
//   - `thread/resume` keeps params.threadId (durable identity);
//   - `turn/start` -> { turn } result, then notifications: turn/started
//     (activity) ... turn/completed with turn.status 'completed' (completion).
//
// Approval/question: freshcodex advertises approvals:false/questions:false
// (codex.rs) — the real bridge has no approval surface to mirror — so the
// controllable events render as fixture-namespaced notifications
// `freshell.fixture/approval` / `freshell.fixture/question` (params = data).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { appendLaunchLedger, FixtureEngine, keepAlive, loadProgram } from './fixture-core.mjs'

const provider = process.env.FRESHELL_FAKE_PROVIDER ?? 'codex-app-server'
const argv = process.argv.slice(2)
const env = process.env

function argValue(name) {
  const index = argv.indexOf(name)
  if (index === -1 || index === argv.length - 1) return undefined
  return argv[index + 1]
}

const listenRaw = argValue('--listen')
if (!listenRaw) {
  console.error('fake-codex-app-server: --listen ws://host:port is required')
  process.exit(64)
}
const listenUrl = new URL(listenRaw)
const host = listenUrl.hostname
const port = Number(listenUrl.port)

appendLaunchLedger({ provider, argv, env })
const program = loadProgram(env)

const sockets = new Set()
let activeThreadId = null
let activeTurnId = null

function broadcast(obj) {
  const frame = JSON.stringify(obj)
  for (const socket of sockets) {
    try {
      socket.send(frame)
    } catch {
      // sinking socket; the test will see the close
    }
  }
}

function render(event) {
  const { kind, data } = event
  const threadId = data.threadId ?? activeThreadId
  const turnId = data.turnId ?? activeTurnId
  switch (kind) {
    case 'activity':
      broadcast({
        method: 'turn/started',
        params: { threadId, turn: { id: turnId, status: 'inProgress' } },
      })
      break
    case 'approval':
      broadcast({ method: 'freshell.fixture/approval', params: { ...data, threadId } })
      break
    case 'question':
      broadcast({ method: 'freshell.fixture/question', params: { ...data, threadId } })
      break
    case 'completion':
      broadcast({
        method: 'turn/completed',
        params: {
          threadId,
          turn: { id: turnId, status: data.subtype === 'interrupted' ? 'interrupted' : 'completed' },
        },
      })
      break
    case 'marker':
      broadcast({ method: 'freshell.fixture/marker', params: { ...data, threadId } })
      break
    default:
      // session/resume/crash carry their meaning in results + the ledger.
      break
  }
}

const engine = new FixtureEngine({ provider, program, env, write: render })

function codexHome() {
  return env.CODEX_HOME && env.CODEX_HOME.length > 0
    ? env.CODEX_HOME
    : path.join(os.homedir(), '.codex')
}

/** Write the durable rollout file (session_meta first line) and return its path. */
function writeRollout(threadId) {
  const now = new Date()
  const dir = path.join(
    codexHome(),
    'sessions',
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  )
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${now.toISOString().slice(0, 19).replace(/:/g, '-')}-${threadId}.jsonl`)
  fs.writeFileSync(
    file,
    `${JSON.stringify({
      timestamp: now.toISOString(),
      type: 'session_meta',
      payload: { id: threadId, cwd: process.cwd(), createdAt: now.toISOString() },
    })}\n`,
  )
  return file
}

function threadResult(threadId, rolloutPath) {
  return {
    thread: { id: threadId, path: rolloutPath, ephemeral: false },
    cwd: process.cwd(),
    model: 'fixture-model',
    modelProvider: 'fixture',
    instructionSources: [],
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: 'danger-full-access',
  }
}

const wss = new WebSocketServer({ host, port })

wss.on('listening', () => {
  // Readiness line the launcher greps for.
  process.stdout.write(`fake codex app-server listening on ws://${host}:${port}\n`)
})

wss.on('connection', (socket) => {
  sockets.add(socket)
  let initialized = false
  socket.on('close', () => sockets.delete(socket))
  socket.on('message', (raw) => {
    void handleMessage(socket, raw).catch(() => {})
  })

  async function handleMessage(socket, raw) {
    let message
    try {
      message = JSON.parse(String(raw))
    } catch {
      return
    }
    if (message.id === undefined) return // client notifications (e.g. initialized)
    const respond = (result) => socket.send(JSON.stringify({ id: message.id, result }))
    const respondError = (msg) =>
      socket.send(JSON.stringify({ id: message.id, error: { code: -32600, message: msg } }))

    if (!initialized && message.method !== 'initialize') {
      respondError('initialize must complete before other RPC methods')
      return
    }

    switch (message.method) {
      case 'initialize': {
        initialized = true
        respond({
          userAgent: 'freshell-fake-codex/1.0.0',
          codexHome: codexHome(),
          platformFamily: 'unix',
          platformOs: process.platform,
        })
        break
      }
      case 'thread/start': {
        const emitted = await engine.handleRpc('thread/start', message.params)
        if (emitted.has('crash')) return
        const threadId = program.sessionId ?? `thread-${randomUUID()}`
        activeThreadId = threadId
        const rolloutPath = writeRollout(threadId)
        if (!emitted.has('session')) {
          await engine.emitEvent('session', { id: threadId }, 'rpc:thread/start:default')
        }
        respond(threadResult(threadId, rolloutPath))
        break
      }
      case 'thread/resume': {
        const emitted = await engine.handleRpc('thread/resume', message.params)
        if (emitted.has('crash')) return
        const threadId = message.params?.threadId ?? `thread-${randomUUID()}`
        activeThreadId = threadId
        const rolloutPath = writeRollout(threadId)
        await engine.emitResume(threadId)
        respond(threadResult(threadId, rolloutPath))
        break
      }
      case 'thread/read': {
        respond({ thread: { id: message.params?.threadId ?? activeThreadId, ephemeral: false } })
        break
      }
      case 'turn/start': {
        // Result first (the real server acks the RPC, turn lifecycle then
        // arrives as notifications), then the controllable turn flow.
        activeThreadId = message.params?.threadId ?? activeThreadId
        activeTurnId = `turn-${randomUUID()}`
        respond({ turn: { id: activeTurnId, status: 'inProgress' } })
        // Turn-open bookkeeping is unconditional (the real server always
        // broadcasts turn/started); a matching rule then owns the middle.
        await engine.emitEvent('activity', { state: 'busy' }, 'rpc:turn/start:open')
        const emitted = await engine.handleRpc('turn/start', message.params)
        if (emitted.has('crash')) return
        if (!emitted.has('completion')) {
          await engine.emitEvent('completion', { subtype: 'success' }, 'rpc:turn/start:default')
        }
        break
      }
      default:
        respond({})
    }
  }
})

keepAlive()
