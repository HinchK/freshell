#!/usr/bin/env node
// HARNESS-06 fake editor (executable payload; wrapped by helpers/harness-06/fake-editor.ts)
//
// Every invocation appends {pid, t, argv, cwd} as JSONL to FAKE_EDITOR_LOG so
// FILE-04-style specs can assert the EXACT argv the server-under-test built
// for each open (plain path, `+line:col`, `--goto path:line:col`, spaces/
// Unicode paths). Logging happens FIRST so even a crashing invocation is
// recorded ("simulate spawn failure" never loses the invocation row).
//
// Knobs (env):
//   FAKE_EDITOR_LOG        (required for ledgering; absent => skip logging)
//   FAKE_EDITOR_EXIT_CODE  exit with this code after logging (default 0)
//   FAKE_EDITOR_SLEEP_MS   stay alive this long before exiting (default 0)
// Arg knob:
//   --fixture-crash        abort() immediately after logging (non-zero death)

import fs from 'node:fs'
import path from 'node:path'

const logPath = process.env.FAKE_EDITOR_LOG
if (logPath) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ pid: process.pid, t: Date.now(), argv: process.argv.slice(2), cwd: process.cwd() })}\n`,
  )
}

const fatal = () => {
  // Deliberate nonzero death, plainly flagged on stderr for forensics.
  console.error('[fake-editor] --fixture-crash requested: aborting')
  process.abort()
}

const run = async () => {
  if (process.argv.slice(2).includes('--fixture-crash')) fatal()
  const sleep = Number(process.env.FAKE_EDITOR_SLEEP_MS || 0)
  if (sleep > 0) await new Promise((r) => setTimeout(r, sleep))
  process.exit(Number(process.env.FAKE_EDITOR_EXIT_CODE || 0))
}

void run()
