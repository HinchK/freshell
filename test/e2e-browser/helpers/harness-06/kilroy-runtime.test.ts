import { describe, it, expect, afterEach } from 'vitest'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnFakeKilroy, type KilroyRuntime } from './kilroy-runtime.js'

/**
 * HARNESS-06 kilroy-runtime coverage: the harness-level "full Kilroy runtime"
 * fake. It must speak the real claude-sidecar newline-JSON protocol
 * (crates/freshell-claude-sidecar/index.mjs doc comment) with kilroy flavour,
 * record every request to a JSONL ledger ("records Kilroy invocations"), and
 * expose controllable approval / failure / crash / resume edges.
 */

const runtimes: KilroyRuntime[] = []
const tmpDirs: string[] = []

async function make(env: NodeJS.ProcessEnv = {}): Promise<{ rt: KilroyRuntime; logPath: string }> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshell-h06-kilroy-'))
  tmpDirs.push(dir)
  const logPath = path.join(dir, 'requests.jsonl')
  const rt = await spawnFakeKilroy({ FAKE_KILROY_LOG: logPath, ...env })
  runtimes.push(rt)
  return { rt, logPath }
}

afterEach(async () => {
  while (runtimes.length) await runtimes.pop()!.kill()
  while (tmpDirs.length) await fsp.rm(tmpDirs.pop()!, { recursive: true, force: true })
})

async function readLedger(logPath: string): Promise<Array<Record<string, unknown>>> {
  try {
    const text = await fsp.readFile(logPath, 'utf8')
    return text.split('\n').filter(Boolean).map((l) => JSON.parse(l))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
}

describe('harness-06 fake kilroy runtime', () => {
  it('answers create with created-first, init, idle — and records the invocation', async () => {
    const { rt, logPath } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp/fixture-cwd', model: 'claude-opus-4-6' })

    const created = (await rt.nextEvent('created')) as { requestId: string; sessionId: string }
    expect(created.requestId).toBe('r-1')
    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{16,32}$/) // bare nanoid shape

    const init = (await rt.nextEvent('sdk.session.init', undefined, 5000)) as {
      sessionId: string; cliSessionId: string; model: string; cwd: string
    }
    expect(init.sessionId).toBe(created.sessionId)
    expect(init.cliSessionId).toMatch(/^[0-9a-f-]{36}$/) // canonical durable UUID
    expect(init.cwd).toBe('/tmp/fixture-cwd')

    const idle = (await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle', 5000))
    expect((idle as { sessionId: string }).sessionId).toBe(created.sessionId)

    // The FIRST stdout line must be `created` (read_created discards earlier sdk.*).
    expect((rt.events()[0] as { type: string }).type).toBe('created')

    const ledger = await readLedger(logPath)
    expect(ledger).toHaveLength(1)
    expect((ledger[0].msg as { type: string }).type).toBe('create')
    expect((ledger[0].msg as { cwd?: string }).cwd).toBe('/tmp/fixture-cwd')
  })

  it('runs a full send turn: running -> assistant -> result(success) -> turn.complete -> idle', async () => {
    const { rt, logPath } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'hello kilroy' })

    const running = (await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'running'))
    expect((running as { sessionId: string }).sessionId).toBe(created.sessionId)

    const assistant = (await rt.nextEvent('sdk.assistant')) as { content: Array<{ type: string; text?: string }> }
    expect(Array.isArray(assistant.content)).toBe(true)
    expect(assistant.content[0].type).toBe('text')
    expect(assistant.content[0].text).toContain('hello kilroy')

    const result = (await rt.nextEvent('sdk.result')) as { result: string }
    expect(result.result).toBe('success')

    const complete = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(typeof complete.at).toBe('number')
    expect(complete.at).toBeGreaterThan(0)

    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    // A second turn's `at` must exceed the first (monotonic completion clock).
    rt.send({ type: 'send', sessionId: created.sessionId, text: 'again' })
    const complete2 = (await rt.nextEvent('sdk.turn.complete')) as { at: number }
    expect(complete2.at).toBeGreaterThan(complete.at)

    const ledger = await readLedger(logPath)
    expect(ledger.map((row) => (row.msg as { type: string }).type)).toEqual(['create', 'send', 'send'])
  })

  it('approval knob surfaces sdk.turn.waiting before completing (0->=1 pending edge)', async () => {
    const { rt } = await make({ FAKE_KILROY_APPROVAL: '1', FAKE_KILROY_APPROVAL_DELAY_MS: '150' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'needs approval' })

    const waiting = (await rt.nextEvent('sdk.turn.waiting')) as { at: number; sessionId: string }
    expect(waiting.sessionId).toBe(created.sessionId)
    expect(typeof waiting.at).toBe('number')

    // Consume through the completion, THEN assert ordering in the full stream.
    await rt.nextEvent('sdk.assistant')
    await rt.nextEvent('sdk.turn.complete') // auto-allowed after the delay
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
    const types = rt.events().map((e) => (e as { type: string }).type)
    expect(types.indexOf('sdk.turn.waiting')).toBeLessThan(types.indexOf('sdk.assistant'))
    expect(types.indexOf('sdk.assistant')).toBeLessThan(types.indexOf('sdk.turn.complete'))
  })

  it('failure knob yields result(error) and NO turn.complete edge', async () => {
    const { rt } = await make({ FAKE_KILROY_FAIL_RESULT: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'fail me' })
    const result = (await rt.nextEvent('sdk.result')) as { result: string }
    expect(result.result).not.toBe('success')
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
    expect(rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete')).toBe(false)
  })

  it('interrupt surfaces sdk.exit (like an aborted SDK query) with NO completion', async () => {
    const { rt } = await make({ FAKE_KILROY_HOLD_TURN: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'hold' })
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'running')

    rt.send({ type: 'interrupt', sessionId: created.sessionId })
    const exit = (await rt.nextEvent('sdk.exit')) as { sessionId: string }
    expect(exit.sessionId).toBe(created.sessionId)
    expect(rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete')).toBe(false)
  })

  it('crash knob kills the process mid-turn with NO completion edge', async () => {
    const { rt } = await make({ FAKE_KILROY_CRASH_ON_SEND: '1' })
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp' })
    const created = (await rt.nextEvent('created')) as { sessionId: string }
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')

    rt.send({ type: 'send', sessionId: created.sessionId, text: 'boom' })
    const code = await new Promise<number | null>((resolve) => {
      rt.proc.once('exit', (c) => resolve(c))
    })
    expect(code).toBe(3)
    expect(rt.events().some((e) => (e as { type: string }).type === 'sdk.turn.complete')).toBe(false)
  })

  it('resume keeps the durable cliSessionId and replays a session snapshot', async () => {
    const durable = randomUUID()
    const { rt } = await make()
    rt.send({ type: 'create', requestId: 'r-1', cwd: '/tmp', resumeSessionId: durable })
    const init = (await rt.nextEvent('sdk.session.init')) as { cliSessionId: string }
    expect(init.cliSessionId).toBe(durable)
    const snapshot = (await rt.nextEvent('sdk.session.snapshot')) as { messages: unknown[] }
    expect(Array.isArray(snapshot.messages)).toBe(true)
    await rt.nextEvent('sdk.status', (e) => (e as { status?: string }).status === 'idle')
  })

  it('shutdown exits 0', async () => {
    const { rt } = await make()
    rt.send({ type: 'shutdown' })
    const code = await new Promise<number | null>((resolve) => rt.proc.once('exit', (c) => resolve(c)))
    expect(code).toBe(0)
    runtimes.pop() // already exited
  })
})
