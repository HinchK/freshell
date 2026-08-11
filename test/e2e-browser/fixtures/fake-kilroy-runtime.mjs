#!/usr/bin/env node
// HARNESS-06 fake Kilroy runtime — the harness-level "full Kilroy runtime"
// fixture (NOT the production Kilroy). Speaks the REAL claude-sidecar
// newline-JSON protocol verbatim (crates/freshell-claude-sidecar/index.mjs,
// doc comment lines 9-29) with kilroy flavour, so any harness that can drive a
// fresh-agent claude/kilroy sidecar can drive this one deterministically:
//
//   in : {"type":"create",requestId,cwd,model,permissionMode,effort,resumeSessionId}
//        {"type":"send",sessionId,text} {"type":"interrupt",sessionId} {"type":"shutdown"}
//   out: {"type":"created","requestId","sessionId"} FIRST (bare nanoid placeholder,
//        read_created discards any earlier sdk.* line), then:
//        sdk.session.init {sessionId,cliSessionId,model,cwd,tools:[]}
//        sdk.session.snapshot {sessionId,messages}   (resume only)
//        sdk.status {sessionId,status}               (running|idle)
//        sdk.turn.waiting {sessionId,at}             (approval edge; before assistant)
//        sdk.assistant {sessionId,content:[<blocks>],model}
//        sdk.result {sessionId,result:<subtype>,durationMs,costUsd,usage}
//        sdk.turn.complete {sessionId,at}            ONLY when result==='success'
//        sdk.exit {sessionId}                        (interrupt: aborted stream end)
//
// Every inbound request is appended to FAKE_KILROY_LOG as JSONL
// ({pid,t,msg}) BEFORE handling — "records Kilroy invocations".
//
// Knobs (env):
//   FAKE_KILROY_LOG                 JSONL request ledger path
//   FAKE_KILROY_CLI_SESSION_ID      fixed durable UUID (default: per-process random)
//   FAKE_KILROY_HOLD_TURN=1         send starts running and never completes
//   FAKE_KILROY_APPROVAL=1          send surfaces sdk.turn.waiting first, then
//                                   auto-allows after FAKE_KILROY_APPROVAL_DELAY_MS
//                                   (default 250) — the real sidecar's waiting-edge
//                                   shape ("surfaced, then allowed")
//   FAKE_KILROY_FAIL_RESULT=1       result subtype 'error' — NO turn.complete
//   FAKE_KILROY_CRASH_ON_SEND=1     process.exit(3) mid-turn — no completion ever
//
// Turn semantics mirror the real sidecar exactly: sdk.result carries the
// subtype in `result`; sdk.turn.complete fires ONLY on 'success'; interrupt
// aborts the stream -> sdk.exit (no result, no completion, session dropped).
// `at` clocks are per-session monotonic (never go backwards).

import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'

const LOG = process.env.FAKE_KILROY_LOG
const HOLD_TURN = process.env.FAKE_KILROY_HOLD_TURN === '1'
const APPROVAL = process.env.FAKE_KILROY_APPROVAL === '1'
const APPROVAL_DELAY_MS = Number(process.env.FAKE_KILROY_APPROVAL_DELAY_MS ?? 250)
const FAIL_RESULT = process.env.FAKE_KILROY_FAIL_RESULT === '1'
const CRASH_ON_SEND = process.env.FAKE_KILROY_CRASH_ON_SEND === '1'
const CLI_SESSION_ID = process.env.FAKE_KILROY_CLI_SESSION_ID ?? randomUUID()

const NANOID_ALPHABET = 'useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict'
function nanoid(size = 21) {
  const bytes = randomBytes(size)
  let id = ''
  for (let i = 0; i < size; i++) id += NANOID_ALPHABET[bytes[i] & 63]
  return id
}

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function logRequest(msg) {
  if (!LOG) return
  fs.mkdirSync(path.dirname(LOG), { recursive: true })
  fs.appendFileSync(LOG, `${JSON.stringify({ pid: process.pid, t: Date.now(), msg })}\n`)
}

// sessionId -> { cliSessionId, cwd, lastTurnCompleteAt?, lastWaitingAt? }
const sessions = new Map()

function nextMonotonic(last, now) {
  return last != null && now <= last ? last + 1 : now
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  logRequest(msg)
  void handle(msg)
})

async function handle(msg) {
  if (msg.type === 'create') {
    const sessionId = nanoid()
    const cliSessionId = msg.resumeSessionId ?? CLI_SESSION_ID
    const cwd = msg.cwd ?? process.cwd()
    sessions.set(sessionId, { cliSessionId, cwd })
    // `created` MUST be the first line written for this request.
    emit({ type: 'created', requestId: msg.requestId, sessionId })
    emit({
      type: 'sdk.session.init',
      sessionId,
      cliSessionId,
      model: msg.model ?? 'claude-opus-4-6',
      cwd,
      tools: [],
    })
    if (msg.resumeSessionId) {
      emit({ type: 'sdk.session.snapshot', sessionId, messages: [] })
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
    return
  }

  if (msg.type === 'send') {
    const st = sessions.get(msg.sessionId) ?? { cliSessionId: CLI_SESSION_ID, cwd: process.cwd() }
    sessions.set(msg.sessionId, st)
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'running' })
    if (CRASH_ON_SEND) {
      process.stderr.write('[fake-kilroy] FAKE_KILROY_CRASH_ON_SEND: exiting 3 mid-turn\n')
      process.exit(3)
    }
    if (HOLD_TURN) return // wedged mid-turn; interrupt/kill are the only exits

    if (APPROVAL) {
      const at = nextMonotonic(st.lastWaitingAt, Date.now())
      st.lastWaitingAt = at
      emit({ type: 'sdk.turn.waiting', sessionId: msg.sessionId, at })
      await new Promise((r) => setTimeout(r, APPROVAL_DELAY_MS))
    }

    emit({
      type: 'sdk.assistant',
      sessionId: msg.sessionId,
      content: [{ type: 'text', text: `kilroy fixture reply: ${msg.text}` }],
      model: 'claude-opus-4-6',
    })
    const subtype = FAIL_RESULT ? 'error' : 'success'
    emit({
      type: 'sdk.result',
      sessionId: msg.sessionId,
      result: subtype,
      durationMs: 1,
      costUsd: 0,
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    if (subtype === 'success') {
      const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
      st.lastTurnCompleteAt = at
      emit({ type: 'sdk.turn.complete', sessionId: msg.sessionId, at })
    }
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' })
    return
  }

  if (msg.type === 'interrupt') {
    // Mirror the real sidecar's aborted-stream tail: sdk.exit, no result, no
    // turn.complete, and the session is dropped.
    if (sessions.has(msg.sessionId)) {
      sessions.delete(msg.sessionId)
      emit({ type: 'sdk.exit', sessionId: msg.sessionId })
    }
    return
  }

  if (msg.type === 'shutdown') {
    process.exit(0)
  }
}

process.on('uncaughtException', (err) => {
  process.stderr.write(`[fake-kilroy] uncaught: ${err}\n`)
  process.exit(4)
})
