#!/usr/bin/env node
// Fake codex TERMINAL CLI for the rollout-locator e2e specs (Lane B2).
// Mirrors fake-opencode-terminal.mjs's contract, on codex's substrate: the
// identity artifact is a rollout JSONL under CODEX_HOME/sessions whose FIRST
// line is the session_meta ownership record (payload.id — never the
// filename — is the identity; payload.cwd is the locator's disambiguator).
// - fresh: prints `codex> `; on the FIRST stdin chunk containing an Enter
//   (CR/LF) writes the rollout (gated by
//   FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH when set) and prints
//   `codex: session <uuid> started`. Enter-gating mirrors real codex
//   (Premise 7: the rollout materializes only at the first user prompt) and
//   keeps the fixture on the safe side of the server's first-submit
//   known_files re-snapshot, which completes before the Enter reaches this
//   process.
// - resume (`resume` ANYWHERE in argv — resumeArgs are appended LAST after
//   `-c` overrides): prints `codex: resumed session <id>`, writes nothing.
// - argv mirrored to FAKE_CODEX_TERMINAL_ARGV_LOG as JSONL.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

const argv = process.argv.slice(2)

function appendArgvLog() {
  const logPath = process.env.FAKE_CODEX_TERMINAL_ARGV_LOG
  if (!logPath) return
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, `${JSON.stringify({ pid: process.pid, t: Date.now(), argv })}\n`)
}
appendArgvLog()

function codexSessionsDir() {
  const home = process.env.CODEX_HOME && process.env.CODEX_HOME.length > 0
    ? process.env.CODEX_HOME
    : path.join(process.env.HOME ?? '', '.codex')
  const now = new Date()
  const yyyy = String(now.getUTCFullYear())
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return path.join(home, 'sessions', yyyy, mm, dd)
}

function writeRollout(threadId) {
  const now = new Date()
  const ts = now.toISOString().slice(0, 19).replace(/:/g, '-')
  const dir = codexSessionsDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `rollout-${ts}-${threadId}.jsonl`)
  const meta = {
    timestamp: now.toISOString(),
    type: 'session_meta',
    payload: { id: threadId, cwd: process.cwd() },
  }
  fs.writeFileSync(file, `${JSON.stringify(meta)}\n`)
}

const resumeIndex = argv.indexOf('resume')
if (resumeIndex !== -1) {
  const sessionId = argv[resumeIndex + 1] ?? ''
  process.stdout.write(`codex: resumed session ${sessionId}\r\n`)
} else {
  process.stdout.write('codex> \r\n')
  let wrote = false
  process.stdin.on('data', (chunk) => {
    if (wrote) return
    const s = String(chunk)
    // Enter-anchored, like real codex (Premise 7): typing alone must not
    // create the rollout — only the first Enter does.
    if (!s.includes('\r') && !s.includes('\n')) return
    wrote = true
    const threadId = crypto.randomUUID()
    const finish = () => {
      writeRollout(threadId)
      process.stdout.write(`codex: session ${threadId} started\r\n`)
    }
    const gate = process.env.FAKE_CODEX_TERMINAL_ROLLOUT_GATE_PATH
    if (gate) {
      const poll = setInterval(() => {
        if (fs.existsSync(gate)) {
          clearInterval(poll)
          finish()
        }
      }, 50)
    } else {
      finish()
    }
  })
}
process.stdin.resume()
