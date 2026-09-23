// @vitest-environment node

// Real-sidecar behavioral pin for the unified attention gate's ARM condition
// (task-004 review F-I1), driven through the production index.mjs process via
// the FRESHELL_CLAUDE_SDK_QUERY_MODULE seam: the interrupt mark is armed ONLY
// while a turn is plausibly awaiting a terminal frame (pendingResults > 0).
// The SDK contract documents RESOLUTION — not rejection — for interrupting
// with nothing in flight (sdk.d.ts:2384-2394), so an idle-session interrupt
// (a late Stop click racing the busy-clear, or a double-click second Stop)
// must arm NOTHING: the settle lands ok:true with no result to consume, and
// the NEXT unrelated turn ring survives. An interrupt while a turn IS pending
// still suppresses exactly the interrupted turn own result.

import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'

const children = new Set<ChildProcess>()
afterEach(() => {
  for (const child of children) child.kill()
  children.clear()
})

function sidecar() {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../../crates/freshell-claude-sidecar/index.mjs', import.meta.url))], {
    env: {
      ...process.env,
      FRESHELL_CLAUDE_SDK_QUERY_MODULE: fileURLToPath(new URL('./fixtures/interrupt-gate-query-module.mjs', import.meta.url)),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.add(child)
  const frames: Record<string, any>[] = []
  const lines = createInterface({ input: child.stdout! })
  lines.on('line', (line) => frames.push(JSON.parse(line)))
  const send = (message: object) => child.stdin!.write(`${JSON.stringify(message)}\n`)
  const waitFor = async (type: string) => {
    await expect.poll(() => frames.find((frame) => frame.type === type), { timeout: 5_000 }).toBeTruthy()
    return frames.find((frame) => frame.type === type)!
  }
  return { send, waitFor, frames }
}

async function createSession(bridge: ReturnType<typeof sidecar>) {
  bridge.send({ type: 'create', requestId: 'create', model: 'opus' })
  const { sessionId } = await bridge.waitFor('created')
  await bridge.waitFor('sdk.session.init')
  return sessionId as string
}

describe('Claude sidecar interrupt gate arming (unified attention edge)', () => {
  it('an interrupt on an idle session settles ok:true and the next unrelated turn ring survives', async () => {
    const bridge = sidecar()
    const sessionId = await createSession(bridge)

    // Idle-session interrupt: nothing awaits a terminal frame. The scripted
    // SDK RESOLVES interrupt() (the documented nothing-in-flight contract),
    // so the settle lands ok:true — and NO mark may be armed. Pre-fix, the
    // unconditional arm here left a stray mark that consumed exactly the
    // next result ring, silently suppressing an attention edge the user
    // never witnessed.
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })

    // The NEXT unrelated turn result must still ring.
    bridge.send({ type: 'send', sessionId, text: 'next unrelated turn' })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'success' })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
  })

  it('an interrupt while a turn is pending suppresses exactly that turn result; the next turn rings again', async () => {
    const bridge = sidecar()
    const sessionId = await createSession(bridge)

    // A turn whose result is HELD until the interrupt fires: the
    // interrupted turn own terminal frame lands AFTER the settle receipt
    // (the SDK ordering the gate depends on, sdk.d.ts:3765).
    bridge.send({ type: 'send', sessionId, text: '__hold__' })
    bridge.send({ type: 'interrupt', sessionId })
    expect(await bridge.waitFor('sdk.interrupt_settled')).toMatchObject({ sessionId, ok: true })
    expect(await bridge.waitFor('sdk.result')).toMatchObject({ sessionId, result: 'error_during_execution' })

    // The next turn rings again — and by then exactly ONE edge has landed:
    // the interrupted turn own ring was consumed by the armed mark.
    bridge.send({ type: 'send', sessionId, text: 'after interrupt' })
    expect(await bridge.waitFor('sdk.turn.complete')).toMatchObject({ sessionId })
    expect(bridge.frames.filter((frame) => frame.type === 'sdk.turn.complete')).toHaveLength(1)
  })
})
