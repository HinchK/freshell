#!/usr/bin/env node
// freshell-claude-sidecar — session-names helper (unified-agent-names Task 3).
// ---------------------------------------------------------------------------
// A BOUNDED, one-shot SDK metadata command: one JSON line in on stdin, ONE
// structured JSON line out on stdout, then exit. Rust (the server's Claude
// native-name adapter) owns the process timeout and the kill/wait cleanup of
// this dedicated helper child — this file never runs a model conversation,
// never starts the sidecar server, and never performs an auth bootstrap.
//
//   Rust → helper (stdin, one JSON line):
//     { op: 'read',   sessionId, dir }                     — the session's native metadata
//     { op: 'rename', sessionId, title, dir }              — set the native custom title
//
//   helper → Rust (stdout, ONE structured JSON line):
//     { ok: true,  op: 'read',   customTitle, summary, firstPrompt, lastModified }
//     { ok: true,  op: 'rename' }
//     { ok: false, class: 'not-found' | 'ambiguous' | 'invalid' , message? }
//     { ok: false, class: 'error', message }               — an SDK failure (ambiguous
//                                                            to the caller: the mutation
//                                                            may or may not have applied)
//
// `dir` is the session's ORIGINAL project directory (required — the
// filesystem path uses ONLY `dir`, never the alpha sessionStore option, a
// grouped gitroot, a query, or an auth bootstrap). Rust supplies a
// child-only absolute `CLAUDE_CONFIG_DIR` (the selected config root) and
// deliberately sets/unsets `CLAUDE_CODE_PROJECT_DIR_NAME` per the selected
// location's effective project-key override; the SDK import is env-injectable
// for tests exactly like index.mjs's query seam.
//
// AMBIGUOUS COPIES ARE NOT WRITABLE: before a rename, the targeted (dir-bound)
// lookup is cross-checked against the store-wide lookup for the same session
// id. If the same id resolves under a different project directory with a
// different file signature, the rename refuses with class 'ambiguous' — the
// SDK's own associated-worktree search must never silently pick a copy.

import { createInterface } from 'node:readline'

const sdkModule = await import(
  process.env.FRESHELL_CLAUDE_SDK_SESSION_NAMES_MODULE || '@anthropic-ai/claude-agent-sdk'
)
const { getSessionInfo, renameSession } = sdkModule

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function refuse(kind, message) {
  emit({ ok: false, class: kind, ...(message ? { message } : {}) })
  process.exit(0)
}

async function readOneLine() {
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: process.stdin })
    let got = false
    lines.once('line', (line) => {
      got = true
      // Resolve BEFORE closing: `close()` emits 'close' synchronously, and a
      // pending-promise reject there would win over this line's resolve.
      resolve(line)
      lines.close()
    })
    lines.once('close', () => {
      if (!got) {
        reject(new Error('stdin closed before a request line arrived'))
      }
    })
  })
}

async function main() {
  const raw = await readOneLine()
  let request
  try {
    request = JSON.parse(raw)
  } catch {
    refuse('invalid', 'the request line is not JSON')
    return
  }
  const { op, sessionId, title, dir } = request ?? {}
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    refuse('invalid', 'sessionId is required')
    return
  }
  if (typeof dir !== 'string' || dir.trim() === '') {
    refuse('invalid', 'dir (the original project directory) is required')
    return
  }
  if (op !== 'read' && op !== 'rename') {
    refuse('invalid', "op must be 'read' or 'rename'")
    return
  }

  if (op === 'read') {
    const info = await getSessionInfo(sessionId, { dir })
    if (!info) {
      refuse('not-found', 'the session file is not under the selected project directory')
      return
    }
    emit({
      ok: true,
      op: 'read',
      customTitle: info.customTitle ?? null,
      summary: info.summary ?? null,
      firstPrompt: info.firstPrompt ?? null,
      lastModified: info.lastModified ?? null,
    })
    return
  }

  // rename: non-empty title required.
  if (typeof title !== 'string' || title.trim() === '') {
    refuse('invalid', 'a rename requires a non-empty title')
    return
  }
  // Selected transcript/project evidence FIRST: the dir-bound lookup proves
  // the session lives under the selected project before any write.
  const targeted = await getSessionInfo(sessionId, { dir })
  if (!targeted) {
    refuse('not-found', 'the session file is not under the selected project directory')
    return
  }
  // Ambiguous copies are not writable: the store-wide lookup finds the SAME
  // file (identical signature) or refuses. Best-effort — a store-wide probe
  // that errors does not block a rename the targeted lookup already proved.
  try {
    const broad = await getSessionInfo(sessionId)
    if (
      broad &&
      (broad.lastModified !== targeted.lastModified || broad.fileSize !== targeted.fileSize)
    ) {
      refuse(
        'ambiguous',
        'the session id resolves under multiple project directories; ambiguous copies are not writable',
      )
      return
    }
  } catch {
    // The ambiguity probe is evidence, not a gate on probe errors.
  }
  await renameSession(sessionId, title, { dir })
  emit({ ok: true, op: 'rename' })
}

main().catch((error) => {
  emit({
    ok: false,
    class: 'error',
    message: error instanceof Error ? error.message : String(error),
  })
  process.exit(0)
})
