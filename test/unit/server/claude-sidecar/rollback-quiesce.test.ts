// test/unit/server/claude-sidecar/rollback-quiesce.test.ts
//
// Process-level contract for the ep4-r3 rollback quiesce protocol in
// crates/freshell-claude-sidecar/index.mjs — the SDK's queued-input surface
// cannot cancel never-started items (UUID-less compact messages), so
// rollback's cancellation authority lives in the sidecar's OWN input queue:
//
// 1. `/compact` sends that were never handed to an awaiting SDK consumer are
//    DROPPED at `rollback.quiesce` and counted as `cancelledQueue`;
// 2. a compact that crossed the same-tick handoff (pushed while the SDK
//    consumer was awaiting) is un-cancellable — the answer's
//    `handedCompactLikely` forces rollback to refuse;
// 3. the flags clear on the compact run's OWN terminal SDK frames (evidence
//    stream order), so a later quiesce is all-clear again;
// 4. an open turn flags `inFlightTurn` (a handle_mirrored busy fold alone
//    cannot see an open-but-unproduced turn at probe time);
// 5. the answer echoes `probeId` verbatim (request/receipt correlation — a
//    stale receipt can never close a later live probe).
//
// Harness mirrors permission-channel.test.ts's spawnSidecar seam
// (FRESHELL_CLAUDE_SDK_QUERY_MODULE=fake-query-module.mjs).

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '../../../..')
const SIDECAR_INDEX = path.join(REPO_ROOT, 'crates', 'freshell-claude-sidecar', 'index.mjs')
const FAKE_QUERY_MODULE = path.join(__dirname, 'fixtures', 'fake-query-module.mjs')

type Frame = Record<string, any>

const children = new Set<ChildProcess>()
function trackChild(c: ChildProcess) {
  children.add(c)
  return c
}
afterEach(async () => {
  for (const c of children) c.kill('SIGKILL')
  children.clear()
})

function spawnSidecar(env: Record<string, string> = {}) {
  const child = trackChild(
    spawn(process.execPath, [SIDECAR_INDEX], {
      env: { ...process.env, FRESHELL_CLAUDE_SDK_QUERY_MODULE: FAKE_QUERY_MODULE, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    }),
  )
  const frames: Frame[] = []
  let stdoutBuf = ''
  let stderrOut = ''
  child.stdout!.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8')
    let idx: number
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim()
      stdoutBuf = stdoutBuf.slice(idx + 1)
      if (!line) continue
      try {
        frames.push(JSON.parse(line))
      } catch {
        /* non-JSON line: ignore */
      }
    }
  })
  child.stderr!.on('data', (chunk: Buffer) => {
    stderrOut += chunk.toString('utf8')
  })
  const send = (msg: Frame) => child.stdin!.write(`${JSON.stringify(msg)}\n`)
  const waitFor = (pred: (f: Frame) => boolean, label: string, timeoutMs = 10_000) =>
    new Promise<Frame>((resolve, reject) => {
      const started = Date.now()
      const poll = () => {
        const hit = frames.find(pred)
        if (hit) {
          resolve(hit)
          return
        }
        if (Date.now() - started > timeoutMs) {
          reject(
            new Error(
              `timed out waiting for ${label}; frames=${JSON.stringify(frames)}; stderr=${stderrOut.slice(-800)}`,
            ),
          )
          return
        }
        setTimeout(poll, 10)
      }
      poll()
    })
  return { child, frames, send, waitFor, stderr: () => stderrOut }
}

async function bootSession(h: ReturnType<typeof spawnSidecar>): Promise<string> {
  h.send({ type: 'create', requestId: 'q-create' })
  const created = await h.waitFor((f) => f.type === 'created', 'created')
  return created.sessionId as string
}

const isQuiescedFor = (sid: string, probeId: string) => (f: Frame) =>
  f.type === 'sdk.rollback.quiesced' && f.sessionId === sid && f.probeId === probeId

describe('rollback quiesce protocol (ep4-r3)', () => {
  it('drains never-handed queued compacts and reports the count (all-clear verdict)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    // Park the module INSIDE its message handler so its consumer is provably
    // NOT awaiting next(): both /compact sends land in the sidecar's queue.
    h.send({ type: 'send', sessionId: sid, text: '__park_500__' })
    await new Promise((r) => setTimeout(r, 60)) // the park owns the loop
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    h.send({ type: 'send', sessionId: sid, text: '/compact focus X' })
    await new Promise((r) => setTimeout(r, 40))
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-drain-1' })
    const answer = await h.waitFor(isQuiescedFor(sid, 'probe-drain-1'), 'quiesced drained')
    expect(answer.cancelledQueue).toBe(2)
    expect(answer.inFlightTurn).toBe(false)
    expect(answer.handedCompactLikely).toBe(false)
  })

  it('flags handedCompactLikely when a compact crossed the same-tick handoff, then clears it at the run result (cases 2+3)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    // The module idles on next() between prompts — a /compact pushed now is
    // handed over synchronously (un-cancellable).
    await new Promise((r) => setTimeout(r, 80))
    h.send({ type: 'send', sessionId: sid, text: '/compact' })
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-handed-1' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-handed-1'), 'quiesced handed busy')
    expect(busy.handedCompactLikely).toBe(true)
    expect(busy.cancelledQueue).toBe(0)

    // The compact RUN provably happened (its own result frame): both flags
    // discharge into the evidence stream — the next probe is all-clear again.
    await h.waitFor((f) => f.type === 'sdk.result', 'compact run result')
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-handed-2' })
    const clear = await h.waitFor(isQuiescedFor(sid, 'probe-handed-2'), 'quiesced after result')
    expect(clear.handedCompactLikely).toBe(false)
    expect(clear.inFlightTurn).toBe(false)
  })

  it('flags inFlightTurn while a turn is open (its result never landed)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    h.send({ type: 'send', sessionId: sid, text: '__open_turn__' })
    await h.waitFor((f) => f.type === 'sdk.assistant' || (f.type === 'sdk.assistant'), 'assistant frame')
    // give the sidecar's bookkeeping a beat (the frame already ordered in)
    await new Promise((r) => setTimeout(r, 40))
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-inflight-1' })
    const busy = await h.waitFor(isQuiescedFor(sid, 'probe-inflight-1'), 'quiesced inflight busy')
    expect(busy.inFlightTurn).toBe(true)
  })

  it('echoes only the requesting probeId (an unrelated probeId is its own answer)', async () => {
    const h = spawnSidecar()
    const sid = await bootSession(h)
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-correlation-a' })
    h.send({ type: 'rollback.quiesce', sessionId: sid, probeId: 'probe-correlation-b' })
    const a = await h.waitFor(isQuiescedFor(sid, 'probe-correlation-a'), 'quiesced probe A')
    const b = await h.waitFor(isQuiescedFor(sid, 'probe-correlation-b'), 'quiesced probe B')
    expect(a.probeId).toBe('probe-correlation-a')
    expect(b.probeId).toBe('probe-correlation-b')
  })
})
