#!/usr/bin/env node
// HARNESS-03 deterministic fake Claude-SDK bridge sidecar — covers the
// checklist's "Kilroy/Claude-SDK" entry with ONE executable: both kilroy and
// freshclaude ride the claude provider's sidecar protocol
// (crates/freshell-freshagent/src/claude.rs), differing only in the
// sessionType flavour — select it via FRESHELL_FAKE_PROVIDER (default
// 'kilroy').
//
// Wire protocol (mirrors crates/freshell-claude-sidecar/index.mjs and the
// realism notes in fixtures/fake-claude-sidecar.mjs):
//   in : {"type":"create",requestId,cwd,model,permissionMode,effort,resumeSessionId}
//        {"type":"send",sessionId,text} {"type":"interrupt",sessionId} {"type":"shutdown"}
//   out: {"type":"created",requestId,sessionId} FIRST (claude.rs read_created
//        discards any earlier line), then sdk.* frames:
//        sdk.session.init {cliSessionId: CANONICAL UUID}, sdk.status,
//        sdk.assistant (content MUST be an ARRAY), sdk.turn.complete (numeric
//        `at` + subtype), sdk.permission.request / sdk.question.request
//        (server sdk-bridge-types.ts shapes), sdk.turn.waiting (0→≥1 pending
//        edge), sdk.session.snapshot (resume).
//
// Turn semantics: `send` ALWAYS opens with sdk.status running (bookkeeping the
// real bridge performs unconditionally); a matching program rule then owns
// the turn; when no rule emitted completion/crash the canned
// assistant+turn.complete+idle success turn closes it.
//
// The process stays alive until `shutdown` (exit 0), a scripted `crash`
// (exit code), or kill — an early exit would stop the server-side consumer.
import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { appendLaunchLedger, FixtureEngine, keepAlive, loadProgram } from './fixture-core.mjs'

const provider = process.env.FRESHELL_FAKE_PROVIDER ?? 'kilroy'
const env = process.env
appendLaunchLedger({ provider, argv: process.argv.slice(2), env })
const program = loadProgram(env)

// bridge sessionId -> { cliSessionId, cwd, pending }
const sessions = new Map()
let activeSessionId = null
let createCounter = 0

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/** Waiting edge on the 0→>=1 pending transition (sdk-bridge.ts emitWaitingEdge). */
function waitingEdgeIfFirstPending(sessionId) {
  const st = sessions.get(sessionId)
  if (!st) return
  if (st.pending === 0) {
    emit({ type: 'sdk.turn.waiting', sessionId, at: Date.now() })
  }
  st.pending += 1
}

async function render(event) {
  const { kind, data } = event
  const sessionId = data.sessionId ?? activeSessionId
  switch (kind) {
    case 'session':
      emit({
        type: 'sdk.session.init',
        sessionId,
        cliSessionId: data.cliSessionId,
        model: data.model ?? 'fixture-model',
        cwd: data.cwd ?? process.cwd(),
        tools: [],
      })
      break
    case 'resume':
      emit({ type: 'sdk.session.snapshot', sessionId, messages: data.messages ?? [] })
      break
    case 'activity':
      emit({ type: 'sdk.status', sessionId, status: data.status ?? 'running' })
      break
    case 'approval': {
      waitingEdgeIfFirstPending(sessionId)
      const input = typeof data.input === 'object' && data.input !== null ? data.input : { command: data.input }
      emit({
        type: 'sdk.permission.request',
        sessionId,
        requestId: String(data.id ?? `perm-${randomUUID()}`),
        subtype: 'can_use_tool',
        tool: { name: data.tool ?? 'Bash', input },
      })
      break
    }
    case 'question': {
      waitingEdgeIfFirstPending(sessionId)
      const questions = Array.isArray(data.questions)
        ? data.questions
        : [{ question: data.text ?? '', header: 'Fixture', options: [], multiSelect: false }]
      emit({
        type: 'sdk.question.request',
        sessionId,
        requestId: String(data.id ?? `q-${randomUUID()}`),
        questions,
      })
      break
    }
    case 'completion':
      emit({
        type: 'sdk.assistant',
        sessionId,
        content: [{ type: 'text', text: data.text ?? 'Fixture turn' }],
        model: 'fixture-model',
      })
      emit({
        type: 'sdk.turn.complete',
        sessionId,
        subtype: data.subtype ?? 'success',
        at: Date.now(),
      })
      emit({ type: 'sdk.status', sessionId, status: 'idle' })
      break
    case 'marker':
      if (data.signal === 'interrupt') {
        emit({ type: 'sdk.exit', sessionId })
        emit({ type: 'sdk.status', sessionId, status: 'idle' })
      }
      break
    case 'crash':
      // A real crash screams no protocol frame; the ledger holds the record.
      break
    default:
      break
  }
}

const engine = new FixtureEngine({
  provider,
  program,
  env,
  write: (event) => render(event),
})

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  void handleInput(line).catch((err) => {
    emit({ type: 'sdk.error', sessionId: activeSessionId, message: String(err?.message ?? err) })
  })
})

async function handleInput(line) {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  if (msg.type === 'create') {
    createCounter += 1
    const sessionId = `${provider}-fake-${process.pid}-${createCounter}`
    activeSessionId = sessionId
    const cliSessionId = msg.resumeSessionId ?? program.sessionId ?? randomUUID()
    sessions.set(sessionId, { cliSessionId, cwd: msg.cwd ?? process.cwd(), pending: 0 })
    // created FIRST — a real consumer discards anything earlier.
    emit({ type: 'created', requestId: msg.requestId, sessionId })
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    if (!emitted.has('session')) {
      await engine.emitEvent(
        'session',
        { cliSessionId, model: msg.model ?? 'fixture-model', cwd: msg.cwd ?? process.cwd() },
        'msg:create:default',
      )
    }
    if (msg.resumeSessionId) {
      await engine.emitResume(cliSessionId)
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'send') {
    activeSessionId = msg.sessionId ?? activeSessionId
    // Turn-open bookkeeping is unconditional (the real bridge always goes busy).
    await engine.emitEvent('activity', { status: 'running' }, 'msg:send:open')
    const emitted = await engine.handleMessage(msg)
    if (emitted.has('crash')) return
    if (!emitted.has('completion')) {
      await engine.emitEvent('completion', { subtype: 'success' }, 'msg:send:default')
    }
  } else if (msg.type === 'interrupt') {
    activeSessionId = msg.sessionId ?? activeSessionId
    const st = sessions.get(msg.sessionId)
    if (st) st.pending = 0
    await engine.emitEvent('marker', { signal: 'interrupt' }, 'msg:interrupt')
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
}

keepAlive()
