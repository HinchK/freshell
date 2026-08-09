// Unit tests for the HARNESS-03 deterministic provider-fixture core engine
// (`test/e2e-browser/fixtures/providers/fixture-core.mjs`). Pure-node tests:
// the engine's exit seam is injected, ledgers go to per-test temp dirs; the
// process-level contract (real spawns, wire encodings) lives in
// `specs/harness-03-provider-fixtures.spec.ts`.
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  appendLaunchLedger,
  FixtureEngine,
  isSubset,
  loadProgram,
  recordedEnv,
  ENV_RECORD_ENV,
  EVENTS_ENV,
  LEDGER_ENV,
  PROGRAM_ENV,
  PROGRAM_FILE_ENV,
  PROVIDER_ENV,
} from '../fixtures/providers/fixture-core.mjs'
import fs from 'node:fs'

let tmp: string
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'harness03-core-'))
})
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function readJsonl(file: string): any[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line))
}

describe('loadProgram', () => {
  it('returns an empty program when no env is set', () => {
    expect(loadProgram({})).toEqual({ rules: [] })
  })

  it('parses inline JSON from FRESHELL_FAKE_PROGRAM', () => {
    const program = loadProgram({
      [PROGRAM_ENV]: JSON.stringify({ sessionId: 'sess-1', rules: [{ on: 'start', emit: [{ kind: 'session' }] }] }),
    })
    expect(program.sessionId).toBe('sess-1')
    expect(program.rules).toHaveLength(1)
  })

  it('falls back to FRESHELL_FAKE_PROGRAM_FILE when inline is unset', () => {
    const file = path.join(tmp, 'program.json')
    fs.writeFileSync(file, JSON.stringify({ rules: [{ on: 'stdin:^x$', emit: [{ kind: 'completion' }] }] }))
    const program = loadProgram({ [PROGRAM_FILE_ENV]: file })
    expect(program.rules?.[0]?.on).toBe('stdin:^x$')
  })

  it('inline JSON wins over the file', () => {
    const file = path.join(tmp, 'program.json')
    fs.writeFileSync(file, JSON.stringify({ sessionId: 'from-file' }))
    const program = loadProgram({
      [PROGRAM_ENV]: JSON.stringify({ sessionId: 'from-inline' }),
      [PROGRAM_FILE_ENV]: file,
    })
    expect(program.sessionId).toBe('from-inline')
  })

  it('throws a clear error on invalid inline JSON', () => {
    expect(() => loadProgram({ [PROGRAM_ENV]: '{not json' })).toThrow(/FRESHELL_FAKE_PROGRAM/)
  })
})

describe('recordedEnv', () => {
  it('records FRESHELL_FAKE_* keys and nothing else by default', () => {
    const env = {
      PATH: '/usr/bin',
      ANTHROPIC_API_KEY: 'secret',
      FRESHELL_FAKE_LEDGER: '/tmp/x',
      HOME: '/home/dan',
    }
    const recorded = recordedEnv(env)
    expect(recorded).toEqual({ FRESHELL_FAKE_LEDGER: '/tmp/x' })
    expect(JSON.stringify(recorded)).not.toContain('secret')
  })

  it('adds keys named in FRESHELL_FAKE_ENV_RECORD (set keys only)', () => {
    const env = {
      [ENV_RECORD_ENV]: 'MY_PROBE_VAR,MISSING_VAR',
      MY_PROBE_VAR: 'probe-value',
      ANTHROPIC_API_KEY: 'secret',
    }
    expect(recordedEnv(env)).toEqual({
      [ENV_RECORD_ENV]: 'MY_PROBE_VAR,MISSING_VAR',
      MY_PROBE_VAR: 'probe-value',
    })
  })
})

describe('appendLaunchLedger', () => {
  it('appends a JSONL launch record with argv/cwd/pid/allowlisted env, creating parents', () => {
    const ledgerPath = path.join(tmp, 'nested', 'ledger.jsonl')
    const env = {
      [LEDGER_ENV]: ledgerPath,
      [ENV_RECORD_ENV]: 'PROBE',
      PROBE: 'yes',
      SECRET_KEY: 'nope',
    }
    appendLaunchLedger({ provider: 'claude', argv: ['--session-id', 'x'], env, cwd: '/work' })
    appendLaunchLedger({ provider: 'kimi', argv: [], env, cwd: '/work' })
    const rows = readJsonl(ledgerPath)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ provider: 'claude', argv: ['--session-id', 'x'], cwd: '/work' })
    expect(rows[0].pid).toBe(process.pid)
    expect(typeof rows[0].t).toBe('number')
    expect(rows[0].env).toMatchObject({ PROBE: 'yes' })
    expect(JSON.stringify(rows[0].env)).not.toContain('nope')
    expect(rows[1].provider).toBe('kimi')
  })

  it('is a no-op when the ledger env is unset', () => {
    expect(() => appendLaunchLedger({ provider: 'claude', argv: [], env: {}, cwd: '/' })).not.toThrow()
  })
})

describe('isSubset', () => {
  it('matches shallow scalar subsets', () => {
    expect(isSubset({ type: 'send' }, { type: 'send', sessionId: 's' })).toBe(true)
    expect(isSubset({ type: 'create' }, { type: 'send' })).toBe(false)
  })

  it('recurses into plain objects', () => {
    expect(isSubset({ tool: { name: 'Bash' } }, { tool: { name: 'Bash', input: {} } })).toBe(true)
    expect(isSubset({ tool: { name: 'Read' } }, { tool: { name: 'Bash' } })).toBe(false)
  })

  it('treats arrays with strict deep equality', () => {
    expect(isSubset({ ids: ['a'] }, { ids: ['a'] })).toBe(true)
    expect(isSubset({ ids: ['a'] }, { ids: ['a', 'b'] })).toBe(false)
  })

  it('undefined match always matches', () => {
    expect(isSubset(undefined, { anything: 1 })).toBe(true)
  })
})

function makeEngine(opts: {
  program?: any
  env?: Record<string, string>
  write?: (event: any) => void
  exitFn?: (code: number) => void
}) {
  const eventsPath = path.join(tmp, 'events.jsonl')
  const env = { [EVENTS_ENV]: eventsPath, ...opts.env }
  const written: any[] = []
  const exits: number[] = []
  const engine = new FixtureEngine({
    provider: opts.env?.[PROVIDER_ENV] ?? 'test-provider',
    program: opts.program ?? { rules: [] },
    env,
    write: opts.write ?? ((event) => written.push(event)),
    exitFn: opts.exitFn ?? ((code) => exits.push(code)),
  })
  return { engine, eventsPath, written, exits }
}

describe('FixtureEngine triggers', () => {
  it('fires start rules exactly once on start()', async () => {
    const { engine, eventsPath } = makeEngine({
      program: { rules: [{ on: 'start', emit: [{ kind: 'session', data: { id: 's1' } }] }] },
    })
    await engine.start()
    await engine.start()
    const rows = readJsonl(eventsPath)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ kind: 'session', provider: 'test-provider', data: { id: 's1' }, trigger: 'start' })
  })

  it('matches stdin rules by regex on the line', async () => {
    const { engine, eventsPath } = makeEngine({
      program: {
        rules: [
          { on: 'stdin:^do work$', emit: [{ kind: 'activity', data: { state: 'busy' } }, { kind: 'completion' }] },
          { on: 'stdin:explode', emit: [{ kind: 'crash', data: { code: 3 } }] },
        ],
      },
    })
    await engine.handleStdinLine('do nothing')
    expect(readJsonl(eventsPath)).toHaveLength(0)
    await engine.handleStdinLine('do work')
    const rows = readJsonl(eventsPath)
    expect(rows.map((r) => r.kind)).toEqual(['activity', 'completion'])
    expect(rows[0].trigger).toBe('stdin:^do work$')
  })

  it('matches message rules by type plus match-subset', async () => {
    const { engine, eventsPath } = makeEngine({
      program: {
        rules: [
          {
            on: 'msg:send',
            match: { text: 'please ask' },
            emit: [{ kind: 'question', data: { id: 'q1' } }],
          },
        ],
      },
    })
    await engine.handleMessage({ type: 'send', text: 'just do it', sessionId: 's' })
    expect(readJsonl(eventsPath)).toHaveLength(0)
    await engine.handleMessage({ type: 'send', text: 'please ask', sessionId: 's' })
    expect(readJsonl(eventsPath)).toMatchObject([{ kind: 'question', data: { id: 'q1' } }])
  })

  it('matches rpc rules by method and http rules by method + path regex + body subset', async () => {
    const { engine, eventsPath } = makeEngine({
      program: {
        rules: [
          { on: 'rpc:turn/start', emit: [{ kind: 'activity', data: { state: 'busy' } }] },
          {
            on: 'http:POST /session/[^/]+/message',
            match: { parts: [{ type: 'text', text: 'hi' }] },
            emit: [{ kind: 'approval', data: { id: 'ap1' } }],
          },
        ],
      },
    })
    await engine.handleRpc('thread/start', {})
    expect(readJsonl(eventsPath)).toHaveLength(0)
    await engine.handleRpc('turn/start', { threadId: 't1' })
    await engine.handleHttp('GET', '/session/abc/message', {})
    await engine.handleHttp('POST', '/session/abc/message', { parts: [{ type: 'text', text: 'nope' }] })
    await engine.handleHttp('POST', '/session/abc/message', { parts: [{ type: 'text', text: 'hi' }] })
    expect(readJsonl(eventsPath).map((r) => r.kind)).toEqual(['activity', 'approval'])
  })

  it('honours once:true across repeated triggers', async () => {
    const { engine, eventsPath } = makeEngine({
      program: {
        rules: [
          { on: 'stdin:x', once: true, emit: [{ kind: 'marker', data: { n: 1 } }] },
          { on: 'stdin:x', emit: [{ kind: 'marker', data: { n: 2 } }] },
        ],
      },
    })
    await engine.handleStdinLine('x')
    await engine.handleStdinLine('x')
    const rows = readJsonl(eventsPath)
    expect(rows.map((r) => r.data.n)).toEqual([1, 2, 2])
  })

  it('calls the write renderer with normalized events', async () => {
    const { engine, written } = makeEngine({
      program: { rules: [{ on: 'start', emit: [{ kind: 'completion', data: { subtype: 'success' } }] }] },
    })
    await engine.start()
    expect(written).toEqual([
      { provider: 'test-provider', kind: 'completion', data: { subtype: 'success' }, trigger: 'start' },
    ])
  })

  it('orders emissions with per-emission delayMs', async () => {
    const { engine, eventsPath } = makeEngine({
      program: {
        rules: [
          {
            on: 'stdin:go',
            emit: [
              { kind: 'activity' },
              { kind: 'completion', delayMs: 25 },
            ],
          },
        ],
      },
    })
    const t0 = Date.now()
    await engine.handleStdinLine('go')
    expect(Date.now() - t0).toBeGreaterThanOrEqual(20)
    expect(readJsonl(eventsPath).map((r) => r.kind)).toEqual(['activity', 'completion'])
  })
})

describe('FixtureEngine crash + resume', () => {
  it('crash records the event then exits via the injected seam with the scripted code', async () => {
    const { engine, eventsPath, exits } = makeEngine({
      program: { rules: [{ on: 'stdin:boom', emit: [{ kind: 'crash', data: { code: 7 }, delayMs: 5 }] }] },
    })
    await engine.handleStdinLine('boom')
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(readJsonl(eventsPath)).toMatchObject([{ kind: 'crash', data: { code: 7 } }])
    expect(exits).toEqual([7])
  })

  it('crash defaults to exit code 1', async () => {
    const { engine, exits } = makeEngine({
      program: { rules: [{ on: 'stdin:boom', emit: [{ kind: 'crash' }] }] },
    })
    await engine.handleStdinLine('boom')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(exits).toEqual([1])
  })

  it('emitResume records a resume event with the given id', async () => {
    const { engine, eventsPath } = makeEngine({})
    await engine.emitResume('thread-99')
    expect(readJsonl(eventsPath)).toMatchObject([{ kind: 'resume', data: { id: 'thread-99' }, trigger: 'argv' }])
  })

  it('emitResume/emitSession let adapters override the recorded trigger', async () => {
    const { engine, eventsPath } = makeEngine({})
    await engine.emitResume('sess-1', 'http:GET /session/:id')
    await engine.emitSession('sess-2', 'http:POST /session')
    expect(readJsonl(eventsPath)).toMatchObject([
      { kind: 'resume', trigger: 'http:GET /session/:id' },
      { kind: 'session', trigger: 'http:POST /session' },
    ])
  })
})

describe('FixtureEngine emittedKinds + defaults cooperation', () => {
  it('tracks which kinds a trigger emitted so adapters can skip covered defaults', async () => {
    const { engine } = makeEngine({
      program: { rules: [{ on: 'msg:send', emit: [{ kind: 'completion' }] }] },
    })
    const emitted = await engine.handleMessage({ type: 'send', sessionId: 's' })
    expect(emitted.has('completion')).toBe(true)
    expect(emitted.has('session')).toBe(false)
    expect(emitted.has('crash')).toBe(false)
  })
})
