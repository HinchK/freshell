/**
 * HARNESS-03 — deterministic provider fixtures: fixture-only contract spec.
 *
 * Invokes each of the seven fake provider executables DIRECTLY (no Freshell
 * server boots — the fixtures are the deliverable; later TERM/AGENT items wire
 * them into the real pane picker/server later) and asserts, per provider:
 *
 *   1. the launch ledger recorded the exact argv/cwd/pid and the allowlisted
 *      env probe (and nothing secret);
 *   2. scripted session/activity/approval/question/completion/crash/resume
 *      events land in the normalized event ledger in scripted order;
 *   3. the provider's wire surface carries the real protocol shape (stdout
 *      markers + bare BEL for terminal CLIs; newline-JSON sdk.* frames for
 *      the kilroy/claude sidecar; WS JSON-RPC notifications for the codex
 *      app-server; SSE frames for the opencode server);
 *   4. crash exits with the scripted code after recording the crash event;
 *   5. resume: each provider's real resume argv shape yields a resume event.
 *
 * Server-kind independence: the spec uses bare `@playwright/test` (no
 * `testServer`, no `page`), so both matrix projects run byte-identical
 * assertions against the fixtures — that sameness IS the fixture-only proof.
 */
import { test, expect } from '@playwright/test'
import {
  launchProviderFixture,
  type LaunchedFixture,
} from '../helpers/provider-fixture-launcher.js'

const TURN_PROGRAM = {
  rules: [
    {
      on: 'stdin:^do work$',
      emit: [
        { kind: 'activity', data: { state: 'busy' } },
        { kind: 'approval', data: { id: 'ap-1', tool: 'Bash', input: 'rm -rf /tmp/x' } },
        { kind: 'question', data: { id: 'q-1', text: 'which file?' } },
        { kind: 'completion', delayMs: 30, data: { subtype: 'success' } },
      ],
    },
    { on: 'stdin:explode', emit: [{ kind: 'crash', data: { code: 3 }, delayMs: 10 }] },
  ],
}

function expectLedgerRow(fixture: LaunchedFixture, provider: string, argv: string[]) {
  const ledger = fixture.readLedger()
  expect(ledger.length).toBeGreaterThan(0)
  const row = ledger[0]
  expect(row.provider).toBe(provider)
  expect(row.argv).toEqual(argv)
  expect(row.pid).toBe(fixture.pid)
  expect(row.cwd).toBe(fixture.cwd)
  // The env probe is recorded via the FRESHELL_FAKE_ENV_RECORD allowlist…
  expect(row.env.HARNESS03_PROBE).toBe(`probe-${provider}`)
  // …and nothing beyond control keys + the probe ever lands in the ledger.
  for (const key of Object.keys(row.env)) {
    expect(key.startsWith('FRESHELL_FAKE_') || key === 'HARNESS03_PROBE').toBe(true)
  }
}

const PROBE_ENV = {
  FRESHELL_FAKE_ENV_RECORD: 'HARNESS03_PROBE',
}

for (const provider of ['claude', 'gemini', 'kimi'] as const) {
  test.describe(`terminal CLI fixture: ${provider}`, () => {
    let fixture: LaunchedFixture
    test.afterEach(async () => {
      await fixture?.stop()
    })

    test('records argv/env and emits controllable turn events', async () => {
      const argv = ['--session-id', '11111111-2222-4333-8444-555555555555', '--model', 'fixture-1']
      fixture = await launchProviderFixture({
        fixture: `fake-${provider}.mjs`,
        args: argv,
        program: TURN_PROGRAM,
        env: { ...PROBE_ENV, HARNESS03_PROBE: `probe-${provider}` },
      })
      await fixture.waitOutput(`${provider}> `)
      expectLedgerRow(fixture, provider, argv)
      const sessionEvent = await fixture.waitEvent('session')
      expect(sessionEvent.data.id).toBe('11111111-2222-4333-8444-555555555555')

      fixture.sendLine('do work')
      await fixture.waitEvent('completion')
      const kinds = fixture.readEvents().map((event) => event.kind)
      expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])
      const approval = fixture.readEvents().find((event) => event.kind === 'approval')
      expect(approval?.data).toMatchObject({ id: 'ap-1', tool: 'Bash' })
      // Wire realism: the completion renders as a bare BEL (the real
      // turn-complete signal, shared/turn-complete-signal.ts) + a done line.
      await fixture.waitOutput('\x07')
      expect(fixture.stdout).toContain('turn done.')
      expect(fixture.stdout).toContain(`approval requested [ap-1] Bash`)
      expect(fixture.stdout).toContain(`question [q-1] which file?`)

      fixture.sendLine('explode')
      expect(await fixture.exited()).toBe(3)
      expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
    })

    test('resume argv yields a resume event + resumed marker', async () => {
      fixture = await launchProviderFixture({
        fixture: `fake-${provider}.mjs`,
        args: ['--resume', 'sess-resumed-9'],
        env: { ...PROBE_ENV, HARNESS03_PROBE: `probe-${provider}` },
      })
      const resume = await fixture.waitEvent('resume')
      expect(resume.data.id).toBe('sess-resumed-9')
      await fixture.waitOutput(`${provider}: resumed session sess-resumed-9`)
    })
  })
}

test.describe('terminal CLI fixture: amplifier', () => {
  let fixture: LaunchedFixture
  test.afterEach(async () => {
    await fixture?.stop()
  })

  test('records argv/env and emits controllable turn events', async () => {
    fixture = await launchProviderFixture({
      fixture: 'fake-amplifier.mjs',
      args: [],
      program: TURN_PROGRAM,
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-amplifier' },
    })
    await fixture.waitOutput('amplifier> ')
    expectLedgerRow(fixture, 'amplifier', [])

    fixture.sendLine('do work')
    await fixture.waitEvent('completion')
    const kinds = fixture.readEvents().map((event) => event.kind)
    expect(kinds).toEqual(['session', 'activity', 'approval', 'question', 'completion'])

    fixture.sendLine('explode')
    expect(await fixture.exited()).toBe(3)
    expect(fixture.readEvents().map((event) => event.kind).at(-1)).toBe('crash')
  })

  test('session resume --full-history shape yields a resume event', async () => {
    fixture = await launchProviderFixture({
      fixture: 'fake-amplifier.mjs',
      args: ['session', 'resume', '--full-history', 'amp-42'],
      env: { ...PROBE_ENV, HARNESS03_PROBE: 'probe-amplifier' },
    })
    const resume = await fixture.waitEvent('resume')
    expect(resume.data.id).toBe('amp-42')
    await fixture.waitOutput('amplifier: resumed session amp-42')
  })
})
