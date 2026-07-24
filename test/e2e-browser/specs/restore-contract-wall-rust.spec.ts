/**
 * RESTORE CONTRACT WALL -- P0.1 "the ruler" from
 * docs/plans/2026-07-24-restart-resilience-architecture-analysis.md (§5).
 *
 * One spec that creates every pane type live against fake CLIs, SIGKILLs the
 * Rust server (RustServer.restartAbrupt()), restarts it on the same
 * home/port/token, reconnects, and asserts each pane's restore contract per
 * plan §2. Contracts that today's architecture cannot satisfy are pinned with
 * test.fail(<cond>, '<plan item>: <reason>') so the suite is CI-green while
 * the wall stays honest.
 *
 * FLIP INSTRUCTION for whoever lands a pinned plan item: Playwright turns an
 * unexpected PASS of a test.fail()-annotated test into a hard failure -- that
 * is the signal to DELETE the test.fail() line for your item and let the
 * assertion run as a normal (green) expectation. Never widen a pin; never
 * convert a pin to test.fixme (fixme'd tests produce no evidence).
 *
 * Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch, because
 * restartAbrupt() exists only on RustServer.
 *
 * Helpers are copied, not imported, per this suite's per-spec-ownership
 * convention (donors: compound-restart-rust.spec.ts,
 * opencode-terminal-restore-rust.spec.ts, restore-double-restart.spec.ts,
 * freshopencode-restart-recovery.spec.ts).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'
import type { Page } from '@playwright/test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ESM project ("type": "module" in package.json): __dirname does not exist in
// ESM modules, so derive it -- same convention as every fixture-referencing
// donor spec (e.g. compound-restart-rust.spec.ts:49-51).
const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')
const FAKE_OPENCODE_TERMINAL_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode-terminal.mjs')
const FAKE_OPENCODE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-opencode.cjs')
const FAKE_CLAUDE_CLI_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-cli.mjs')
const FAKE_CLAUDE_SIDECAR_SOURCE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')
const FAKE_CODEX_APP_SERVER_SOURCE = path.resolve(
  __dirname,
  '../../fixtures/coding-cli/codex-app-server/fake-app-server.mjs',
)

// ---------------------------------------------------------------------------
// Shared helpers (per-spec copies -- see file doc comment)
// ---------------------------------------------------------------------------

/** Copy a fixture into <binDir>/<binName> and make it executable. */
async function installFakeCli(source: string, binName: string, binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, binName)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

/** Read a fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/** True when argv contains the adjacent pair `resume <sessionId>` (codex shape). */
function hasResumePair(argv: string[], sessionId: string): boolean {
  const idx = argv.indexOf('resume')
  return idx >= 0 && argv[idx + 1] === sessionId
}

/** True when argv contains the adjacent pair `<flag> <value>` (claude --resume / opencode --session). */
function hasFlagPair(argv: string[], flag: string, value: string): boolean {
  const idx = argv.indexOf(flag)
  return idx >= 0 && argv[idx + 1] === value
}

/** Concatenated content of every server log file in the fixture's logs dir. */
async function readServerLogs(logsDir: string): Promise<string> {
  const names = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const name of names) {
    combined += await fs.readFile(path.join(logsDir, name), 'utf8').catch(() => '')
  }
  return combined
}

/** Dismiss the initial pane-type picker by choosing the first visible shell. */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
  const picker = page.getByRole('toolbar', { name: /pane type picker/i }).last()
  if (!(await picker.isVisible().catch(() => false))) return
  for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
    const option = picker.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
    if (await option.isVisible().catch(() => false)) {
      await option.click({ force: true })
      return
    }
  }
}

/** Poll the in-page harness until the WS transport reports 'ready'. */
async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
    )
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

/** Force the persistence middleware to write localStorage NOW (pre-reload). */
async function flushPersistence(page: Page): Promise<void> {
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
  })
}

async function reloadAndReconnect(page: Page, harness: TestHarness): Promise<void> {
  await page.reload({ waitUntil: 'domcontentloaded' })
  await harness.waitForHarness()
  await harness.waitForConnection()
}

/** Idempotent .freshell/config.json seed (setupHome re-runs on every boot). */
function seedWallConfig(input: {
  providers: string[]
  freshAgent?: boolean
}): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: {
            codingCli: { enabledProviders: input.providers },
            ...(input.freshAgent ? { freshAgent: { enabled: true } } : {}),
          },
        },
        null,
        2,
      ),
    )
  }
}

/** Boot an owned RustServer, navigate, and wait for harness + WS. */
async function bootWall(
  page: Page,
  options: {
    env?: Record<string, string>
    setupHome?: (homeDir: string) => Promise<void>
  } = {},
): Promise<{ server: RustServer; info: TestServerInfo; harness: TestHarness }> {
  const server = new RustServer({ env: options.env, setupHome: options.setupHome })
  const info = await server.start()
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { server, info, harness }
}

// --- layout tree walkers (donor: opencode-terminal-restore-rust.spec.ts) ---

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findLeavesByMode(layout: any, mode: string): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === mode)
}

function findFreshAgentLeaf(node: any): any {
  if (!node) return null
  if (node.type === 'leaf' && node.content?.kind === 'fresh-agent') return node
  if (node.type === 'split') {
    for (const child of node.children ?? []) {
      const found = findFreshAgentLeaf(child)
      if (found) return found
    }
  }
  return null
}

function leafDurableIdentity(leaf: any): string | undefined {
  return (
    leaf?.content?.sessionId ??
    leaf?.content?.sessionRef?.sessionId ??
    leaf?.content?.resumeSessionId
  )
}

// --- REST helpers (donor: continuity-smoke.spec.ts / agent-continuity-matrix) ---

function restApiHeaders(info: TestServerInfo): Record<string, string> {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

/** POST /api/tabs; returns the created tabId (envelope is {status,data}). */
async function createTabViaRest(info: TestServerInfo, body: object): Promise<string> {
  const res = await fetch(`${info.baseUrl}/api/tabs`, {
    method: 'POST',
    headers: restApiHeaders(info),
    body: JSON.stringify(body),
  })
  const payload = await res.json()
  expect(res.ok, `POST /api/tabs: ${JSON.stringify(payload)}`).toBe(true)
  const tabId = payload?.data?.tabId
  expect(tabId, 'POST /api/tabs envelope data.tabId').toBeTruthy()
  return tabId as string
}

// ---------------------------------------------------------------------------
// The wall
// ---------------------------------------------------------------------------

test.describe('Restore Contract Wall (P0.1)', () => {
  test.setTimeout(180_000)

  test('shell terminal: SIGKILL restore yields a fresh shell in initialCwd', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-shell-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    const { server, harness, info } = await bootWall(page)
    try {
      await selectShellIfPickerShowing(page)

      // Create the shell pane with a KNOWN cwd via REST so the initialCwd
      // contract is assertable.
      const tabCountBefore = await harness.getTabCount()
      const tabId = await createTabViaRest(info, { mode: 'shell', cwd: projectDir })
      await expect(async () => {
        expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
      }).toPass({ timeout: 15_000 })

      const terminalIdBefore: string = await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId)
      expect(terminalIdBefore).toBeTruthy()

      // Prove the shell is interactive before the kill.
      await page.locator('.xterm').last().click()
      await page.keyboard.type('echo wall-shell-alive')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdBefore)
          return typeof buffer === 'string' && buffer.replace(/\n/g, '').includes('wall-shell-alive')
        }, { timeout: 15_000 })
        .toBe(true)

      // --- SIGKILL + revive on the same disk state; live client reconnects. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.1: pane recreates (new terminalId), never status:error.
      const terminalIdAfter: string = await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId)
      expect((await harness.getPaneLayout(tabId))?.content?.status).not.toBe('error')

      // CONTRACT §2.1: the fresh shell starts in the pane's opened directory.
      await page.locator('.xterm').last().click()
      await page.keyboard.type('pwd')
      await page.keyboard.press('Enter')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          return typeof buffer === 'string' && buffer.replace(/\n/g, '').includes(projectDir)
        }, { timeout: 15_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
