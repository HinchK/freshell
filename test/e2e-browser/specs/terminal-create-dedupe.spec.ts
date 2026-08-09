/**
 * TERM-04 — deduplicate `terminal.create` by `createRequestId`.
 * (`docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md`, P0 terminal section)
 *
 * Checklist validation (verbatim): "Intercept/delay the first `terminal.created`,
 * force reconnect, and issue the same create request from two pages; assert one
 * PTY PID, one terminal ID, one pane owner, and one fixture launch record."
 *
 * The dedupe is a SERVER-side contract with byte-identical semantics on both
 * implementations (legacy parity source: `server/ws-handler.ts` global
 * `createdTerminalByRequestId` settled cache :575/:891-936 + per-connection
 * `REPAIR_PENDING_SENTINEL` :2329-:2704 + create lock :2218; rust answer:
 * `crates/freshell-ws/src/create_dedupe.rs` + the dispatch arm at
 * `crates/freshell-ws/src/terminal.rs:564-624`). This spec therefore runs in
 * BOTH matrix projects — rust-chromium is the PW-RUST proof leg,
 * legacy-chromium is a true parity control.
 *
 * Fixture launcher: HARNESS-03's `fake-claude.mjs` wired in via the
 * established `CLAUDE_CMD` server-env seam (same pattern as
 * `truly-idle-alerting.spec.ts`, matrix-green). Every provider spawn appends
 * one JSONL row to `FRESHELL_FAKE_LEDGER` — "one fixture launch record" is
 * `rows === 1`, and the row's `pid` is THE PTY PID.
 *
 * Three legs, one describe, one server per test:
 *   A. delayed/lost first `terminal.created` + forced reconnect of the asker:
 *      raw client aborts before reading the reply; a new connection resends
 *      the IDENTICAL frame → answered once, one launch, one terminal.
 *   B. two clients issue the same create concurrently → both answered with
 *      the SAME terminalId (settled-replay or in-flight waiter — either
 *      window satisfies the contract), one launch, one terminal.
 *   C. two real pages: page A owns a picker-created claude pane; after a
 *      forced browser WS disconnect/reconnect the pane re-attaches to the
 *      SAME terminal without a second launch; a second page then issues the
 *      same createRequestId through its real WS connection → still one
 *      launch, one terminal, one pane owner.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { test } from '../helpers/fixtures.js'
import { createE2eServerHandle, type E2eServerHandle } from '../helpers/external-target.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { RawWsClient, rawHttpRequest } from '../helpers/raw-clients.js'
import { TestHarness } from '../helpers/test-harness.js'
import { PROVIDER_FIXTURE_DIR } from '../helpers/provider-fixture-launcher.js'

type LedgerRow = { t: number; pid: number; provider: string; argv: string[]; cwd: string }

/** Install the executable shim the servers spawn as the "claude" binary. */
async function installFakeClaudeCli(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const shim = path.join(binDir, 'fake-claude-shim.sh')
  const target = path.join(PROVIDER_FIXTURE_DIR, 'fake-claude.mjs')
  await fs.writeFile(
    shim,
    `#!/bin/sh\nexec node ${JSON.stringify(target)} "$@"\n`,
    'utf8',
  )
  await fs.chmod(shim, 0o755)
  return shim
}

async function readLedger(ledgerPath: string): Promise<LedgerRow[]> {
  try {
    const raw = await fs.readFile(ledgerPath, 'utf8')
    return raw
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as LedgerRow)
  } catch {
    return [] // not yet written
  }
}

async function waitForLedgerRows(ledgerPath: string, count: number, timeoutMs = 15_000): Promise<LedgerRow[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const rows = await readLedger(ledgerPath)
    if (rows.length >= count) return rows
    if (Date.now() > deadline) {
      throw new Error(`ledger never reached ${count} rows (saw ${rows.length})`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
}

/** Running-terminal inventory via the shared REST surface (x-auth-token authed). */
async function runningTerminalIds(info: TestServerInfo): Promise<string[]> {
  const res = await rawHttpRequest(info.baseUrl, {
    path: '/api/terminals',
    headers: { 'x-auth-token': info.token },
  })
  expect(res.status, `/api/terminals status ${res.status}: ${res.body.toString('utf8').slice(0, 400)}`).toBe(200)
  const rows = res.json() as Array<{ terminalId?: string; status?: string }>
  expect(Array.isArray(rows)).toBe(true)
  return rows.filter((r) => r.status === 'running').map((r) => String(r.terminalId))
}

function findTerminalLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'terminal') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findTerminalLeaf(child)
      if (found) return found
    }
  }
  return null
}

/** The plain create frame — byte-identical on every send, exactly what the
 * frozen client mints and resends (TerminalView.tsx); mode claude rides the
 * same dispatch arm as shell and reaches the fake CLI on both servers. */
function plainCreateFrame(requestId: string, cwd: string) {
  return { type: 'terminal.create', requestId, mode: 'claude', shell: 'system', cwd }
}

test.describe('TERM-04 terminal.create requestId dedupe', () => {
  test.setTimeout(120_000)

  let root: string
  let ledgerPath: string
  let cwdDir: string
  let server: E2eServerHandle | undefined
  let info: TestServerInfo

  test.beforeEach(async ({ e2eServerKind }) => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-term04-'))
    ledgerPath = path.join(root, 'ledger.jsonl')
    cwdDir = path.join(root, 'cwd')
    await fs.mkdir(cwdDir, { recursive: true })
    const fakeClaude = await installFakeClaudeCli(path.join(root, 'bin'))
    server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: {
          CLAUDE_CMD: fakeClaude,
          FRESHELL_FAKE_LEDGER: ledgerPath,
          FRESHELL_FAKE_PROGRAM: JSON.stringify({ rules: [] }),
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(
            path.join(freshellDir, 'config.json'),
            JSON.stringify(
              { version: 1, settings: { codingCli: { enabledProviders: ['claude'] } } },
              null,
              2,
            ),
          )
        },
      },
    })
    info = await server.start()
  })

  test.afterEach(async () => {
    await server?.stop()
    server = undefined
  })

  test('A: lost first terminal.created, reconnect resends the same create — one launch, one terminal', async () => {
    const requestId = `term04-a-${Date.now()}`

    // Intercept/delay the first terminal.created: the asking connection
    // vanishes before the reply can be consumed (abrupt socket destroy —
    // the reply is lost no matter which side of settle it lands on).
    const asking = await RawWsClient.connect(info.wsUrl)
    asking.hello(info.token)
    await asking.nextJsonMessage('ready', 10_000)
    asking.sendJson(plainCreateFrame(requestId, cwdDir))
    asking.abort()
    await asking.dispose()

    // Forced reconnect of the asker: a fresh connection resends the
    // IDENTICAL frame (the frozen client's inFlightCreates redrive).
    const reconnected = await RawWsClient.connect(info.wsUrl)
    reconnected.hello(info.token)
    await reconnected.nextJsonMessage('ready', 10_000)
    reconnected.sendJson(plainCreateFrame(requestId, cwdDir))
    const created = await reconnected.nextJsonMessage<any>('terminal.created', 15_000)

    expect(created.requestId).toBe(requestId)
    expect(typeof created.terminalId).toBe('string')
    expect(created.terminalId.length).toBeGreaterThan(0)

    // One fixture launch record — its pid is the one PTY PID.
    const rows = await waitForLedgerRows(ledgerPath, 1)
    expect(rows).toHaveLength(1)
    expect(rows[0].pid).toBeGreaterThan(0)

    // One terminal ID in the server inventory, and it is the replied one.
    await expect
      .poll(() => runningTerminalIds(info), { timeout: 10_000 })
      .toEqual([created.terminalId])

    await reconnected.dispose()
  })

  test('B: two clients issue the same create concurrently — both answered, one PTY', async () => {
    const requestId = `term04-b-${Date.now()}`

    const c1 = await RawWsClient.connect(info.wsUrl)
    const c2 = await RawWsClient.connect(info.wsUrl)
    c1.hello(info.token)
    c2.hello(info.token)
    await c1.nextJsonMessage('ready', 10_000)
    await c2.nextJsonMessage('ready', 10_000)

    // Back-to-back: deliberately unawaited pair — whichever window the first
    // create is in (in-flight waiter vs settled replay), the contract is
    // "both answered with the same terminalId, one spawn".
    c1.sendJson(plainCreateFrame(requestId, cwdDir))
    c2.sendJson(plainCreateFrame(requestId, cwdDir))

    const [r1, r2] = await Promise.all([
      c1.nextJsonMessage<any>('terminal.created', 15_000),
      c2.nextJsonMessage<any>('terminal.created', 15_000),
    ])
    expect(r1.requestId).toBe(requestId)
    expect(r2.requestId).toBe(requestId)
    expect(r2.terminalId).toBe(r1.terminalId)

    const rows = await waitForLedgerRows(ledgerPath, 1)
    expect(rows).toHaveLength(1)

    await expect
      .poll(() => runningTerminalIds(info), { timeout: 10_000 })
      .toEqual([r1.terminalId])

    await c1.dispose()
    await c2.dispose()
  })

  test('C: two pages — pane owner survives forced reconnect; a second page re-issuing the create spawns nothing', async ({ browser }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    const harnessA = new TestHarness(pageA)
    await pageA.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    await harnessA.waitForHarness()
    await harnessA.waitForConnection()

    // Page A creates the pane through the real picker (mints createRequestId K).
    await pageA.getByRole('button', { name: /^Claude CLI$/i }).click({ timeout: 15_000 })
    const cwdBox = pageA.getByRole('combobox', { name: /starting directory for claude cli/i })
    await expect(cwdBox).toBeVisible({ timeout: 10_000 })
    await cwdBox.fill(cwdDir)
    await cwdBox.press('Enter')

    // The fake CLI banner proves the PTY is up (its text arrives over WS).
    await expect
      .poll(async () => {
        const tabId = await harnessA.getActiveTabId()
        if (!tabId) return null
        const leaf = findTerminalLeaf(await harnessA.getPaneLayout(tabId))
        return leaf?.content?.terminalId ?? null
      }, { timeout: 20_000 })
      .not.toBeNull()

    const tabIdA = (await harnessA.getActiveTabId())!
    const leafA = findTerminalLeaf(await harnessA.getPaneLayout(tabIdA))
    const requestId: string = leafA.content.createRequestId
    const terminalId: string = leafA.content.terminalId
    expect(typeof requestId).toBe('string')
    expect(requestId.length).toBeGreaterThan(0)
    expect(typeof terminalId).toBe('string')

    const launched = await waitForLedgerRows(ledgerPath, 1)
    expect(launched).toHaveLength(1)

    // Forced reconnect of the whole page (browser-level WS drop; the frozen
    // client re-handshakes and re-attaches/re-drives with the same keys).
    await harnessA.forceDisconnect()
    await harnessA.waitForConnection()

    // One pane owner for the SAME terminal after the reconnect; no relaunch.
    await expect
      .poll(async () => {
        const leaf = findTerminalLeaf(await harnessA.getPaneLayout(tabIdA))
        return leaf?.content?.terminalId ?? null
      }, { timeout: 20_000 })
      .toBe(terminalId)
    expect(await readLedger(ledgerPath)).toHaveLength(1)

    // Second real page: issue the SAME create request over its own real WS
    // connection (sendWsMessage goes out the app's live socket).
    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    const harnessB = new TestHarness(pageB)
    await pageB.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
    await harnessB.waitForHarness()
    await harnessB.waitForConnection()
    await pageB.evaluate((frame) => {
      window.__FRESHELL_TEST_HARNESS__?.sendWsMessage(frame)
    }, plainCreateFrame(requestId, cwdDir))

    // Give the duplicate a real window to do damage, then assert the
    // checklist invariants: one PTY PID, one terminal ID, one pane owner.
    await pageB.waitForTimeout(1_000)
    expect(await readLedger(ledgerPath)).toHaveLength(1)
    expect(await runningTerminalIds(info)).toEqual([terminalId])
    const leafAfter = findTerminalLeaf(await harnessA.getPaneLayout(tabIdA))
    expect(leafAfter.content.terminalId).toBe(terminalId)
    expect(leafAfter.content.createRequestId).toBe(requestId)
    // Page B stays healthy (its ignored unicast reply must not wedge it).
    expect(await harnessB.getConnectionStatus()).toBe('ready')

    await contextB.close()
    await contextA.close()
  })
})
