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

/** Seed ~/.codex/sessions/<id>.jsonl so the sidebar shows a resumable codex session. */
function seedCodexHome(
  sessionId: string,
  sessionTitle: string,
  projectDir: string,
): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    await seedWallConfig({ providers: ['codex'] })(homeDir)
    const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
    await fs.mkdir(codexSessionsDir, { recursive: true })
    const lines = [
      JSON.stringify({
        timestamp: '2026-07-21T08:00:00.000Z',
        type: 'session_meta',
        payload: { id: sessionId, cwd: projectDir },
      }),
      JSON.stringify({
        timestamp: '2026-07-21T08:00:01.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${sessionTitle} request 1` }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-21T08:00:02.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: `${sessionTitle} reply 1` }],
        },
      }),
      JSON.stringify({
        timestamp: '2026-07-21T08:00:03.000Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: `${sessionTitle} request 2` }],
        },
      }),
    ]
    await fs.writeFile(path.join(codexSessionsDir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`)
  }
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

// --- opencode pane helpers (donor: opencode-terminal-restore-rust.spec.ts:104-146) ---

/**
 * Open a NEW pane via the picker and select the "OpenCode" provider option.
 * The follow-up "Starting directory for OpenCode" combobox arrives pre-filled
 * and focused; Enter accepts the current directory as-is.
 */
async function openOpencodePane(page: Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
}

/**
 * Open a new opencode pane (splitting the current terminal) and return the
 * NEWLY-added opencode leaf -- identified by diffing the leaf set before vs
 * after, since a fresh pane's terminalId isn't known until create completes.
 */
async function openOpencodePaneAndGetLeaf(
  page: Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const before = findLeavesByMode(await harness.getPaneLayout(tabId), 'opencode')
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openOpencodePane(page)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  return expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId)
      const newLeaf = findLeavesByMode(layout, 'opencode').find((leaf) => !beforeIds.has(leaf.id))
      return newLeaf?.content?.terminalId ? newLeaf : null
    }, { timeout: 15_000 })
    .not.toBeNull()
    .then(async () => {
      const layout = await harness.getPaneLayout(tabId)
      return findLeavesByMode(layout, 'opencode').find((leaf) => !beforeIds.has(leaf.id))
    })
}

/** Look up a single leaf by pane id in a tab's current layout. */
async function findLeafById(harness: TestHarness, tabId: string, paneId: string): Promise<any> {
  const layout = await harness.getPaneLayout(tabId)
  return collectLeaves(layout).find((leaf) => leaf.id === paneId) ?? null
}

// --- freshcodex fresh-agent helpers (donors: restore-matrix.spec.ts:62-92,
// restore-double-restart.spec.ts:148-176) ---

/**
 * Install the fake codex app-server as a re-exec WRAPPER, never a content
 * copy (donor: restore-matrix.spec.ts:62-92): the fixture's
 * `import { WebSocketServer } from 'ws'` is an ESM bare specifier resolved
 * relative to the FILE'S OWN location -- a copy dropped in a bare temp dir
 * has no `node_modules` ancestor and dies with ERR_MODULE_NOT_FOUND.
 */
async function installFakeCodexAppServer(destDir: string): Promise<string> {
  await fs.mkdir(destDir, { recursive: true })
  const dest = path.join(destDir, 'fake-codex-app-server-wrapper.mjs')
  const wrapper = `#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
const target = ${JSON.stringify(FAKE_CODEX_APP_SERVER_SOURCE)}
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
`
  await fs.writeFile(dest, wrapper, 'utf8')
  await fs.chmod(dest, 0o755)
  return dest
}

async function createFreshcodexPane(page: Page, harness: TestHarness): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch (App.tsx:572,609). Callers reach this
  // helper only after harness.waitForConnection(), which is what makes the
  // dispatch land AFTER those overwrites (donor ordering:
  // freshopencode-restart-recovery.spec.ts:100-115). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: false, codex: true },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
  // "First option" exists here only because selectShellIfPickerShowing
  // already opened a shell whose live-terminal cwd becomes a candidate dir
  // (/api/files/candidate-dirs returns [] on a truly clean boot -- no $HOME
  // fallback, crates/freshell-server/src/files.rs:15-26). This mirrors the
  // donor exactly (restore-double-restart.spec.ts:148-176); if no option
  // renders, switch to the fill+Enter pattern used by
  // createFreshopencodePane/createFreshclaudePane.
  await page.getByRole('option').first().click()
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

/** Send one chat turn in the last fresh-agent pane and wait for idle. */
async function sendFreshAgentTurn(
  page: Page,
  harness: TestHarness,
  tabId: string,
  text: string,
): Promise<void> {
  const paneRoot = page.locator('[data-context="fresh-agent"]').last()
  await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
      timeout: 20_000,
    })
    .toBe('idle')
  const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
  await composer.fill(text)
  await paneRoot.getByRole('button', { name: 'Send' }).click()
  await expect
    .poll(async () => findFreshAgentLeaf(await harness.getPaneLayout(tabId))?.content?.status, {
      timeout: 30_000,
    })
    .toBe('idle')
}

// --- freshopencode fresh-agent helpers (donor:
// freshopencode-restart-recovery.spec.ts:114-206) ---

async function enableFreshOpencode(
  page: Page,
  enabledProviders: string[] = ['opencode'],
): Promise<void> {
  // These dispatches are client-only and MUST land AFTER the app bootstrap +
  // /api/platform fetch (App.tsx:572,609 overwrite availableClis). Callers
  // reach this helper only after harness.waitForConnection(), which is the
  // donor's ordering (freshopencode-restart-recovery.spec.ts:100-115).
  //
  // CAUTION: mergeServerSettings REPLACES the enabledProviders array when the
  // key is present (shared/settings.ts:1216-1218) -- it does not union. Any
  // test that needs OTHER providers' picker buttons after this call (e.g. the
  // Task 9 ruler, which still has freshclaude to create) MUST pass the full
  // provider list, or those buttons disappear (PanePicker.tsx:125-152 gates
  // fresh-agent options on enabledProviders.includes(<provider>)).
  await page.evaluate((providers) => {
    const harness = (window as any).__FRESHELL_TEST_HARNESS__
    harness?.dispatch({ type: 'connection/setAvailableClis', payload: { opencode: true } })
    harness?.dispatch({
      type: 'settings/previewServerSettingsPatch',
      payload: { codingCli: { enabledProviders: providers }, freshAgent: { enabled: true } },
    })
  }, enabledProviders)
}

async function createFreshopencodePane(page: Page, cwd: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshopencode$/i }).click({ force: true })
  const directoryInput = page.getByLabel(/^Starting directory for Freshopencode$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
}

// --- freshclaude fresh-agent helper (fixture: fake-claude-sidecar.mjs via the
// production env seam FRESHELL_CLAUDE_SIDECAR) ---

async function createFreshclaudePane(page: Page, harness: TestHarness, cwd: string): Promise<void> {
  // setAvailableClis is client-only AND gets overwritten by the app
  // bootstrap + /api/platform fetch (App.tsx:572,609). Callers reach this
  // helper only after harness.waitForConnection(), which is what makes the
  // dispatch land AFTER those overwrites (donor ordering:
  // freshopencode-restart-recovery.spec.ts:100-115). Keep it that way.
  await page.evaluate(() => {
    ;(window as any).__FRESHELL_TEST_HARNESS__?.dispatch({
      type: 'connection/setAvailableClis',
      payload: { claude: true, codex: false },
    })
  })
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
  // /api/files/candidate-dirs returns [] on a clean isolated HOME (no $HOME
  // fallback, crates/freshell-server/src/files.rs:15-26), so a "first
  // option" may not exist -- TYPE the cwd and press Enter instead (donor:
  // freshopencode-restart-recovery.spec.ts:117-124).
  const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
  await expect(directoryInput).toBeVisible({ timeout: 15_000 })
  await directoryInput.fill(cwd)
  await directoryInput.press('Enter')
  await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({
    timeout: 15_000,
  })
  // NOTE: once the canonical-UUID cliSessionId lands, the client fetches the
  // thread snapshot and the Rust router has NO claude adapter -> 503
  // FRESH_AGENT_RUNTIME_UNAVAILABLE (crates/freshell-freshagent/src/
  // snapshot.rs:133-146), which can surface a history-load-error banner on a
  // perfectly healthy fresh pane. Assert pane state via the harness (Redux),
  // tolerate the banner -- never assert error-free UI chrome for freshclaude.
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

  test('claude terminal: pre-allocated session resumes with --resume after SIGKILL', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-claude-term-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaudePath = await installFakeCli(
      FAKE_CLAUDE_CLI_SOURCE,
      'claude',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootWall(page, {
      env: { CLAUDE_CMD: fakeClaudePath, FAKE_CLAUDE_ARGV_LOG: argLogPath },
      setupHome: seedWallConfig({ providers: ['claude'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!

      // Fresh claude pane via the PICKER (WS path) -> server pre-allocates
      // --session-id (terminal.rs:969-982). REST would not (PF1,
      // terminal_tabs.rs:756-768). Candidate dirs can be EMPTY on a clean
      // isolated HOME (crates/freshell-server/src/files.rs:15-26 -- no $HOME
      // fallback), so TYPE the cwd instead of clicking a suggestion (donor:
      // freshopencode-restart-recovery.spec.ts:117-124).
      const beforeIds = new Set(
        findLeavesByMode(await harness.getPaneLayout(tabId), 'claude').map((l) => l.id),
      )
      // The boot picker commits its selection only after its fade-out
      // transition (PanePicker onTransitionEnd -> onSelect), so wait for the
      // boot pane to become a REAL terminal before opening the pane picker --
      // otherwise openPanePicker early-returns the still-fading boot picker
      // and the Claude click is swallowed when that pane turns into the shell
      // (donor: truly-idle-alerting.spec.ts waits for .xterm after picking).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Claude CLI$/i }).click({ force: true })
      const dirInput = page.getByRole('combobox', { name: /Starting directory for Claude/i })
      await expect(dirInput).toBeVisible({ timeout: 15_000 })
      await dirInput.fill(projectDir)
      await dirInput.press('Enter')

      // The new claude pane is a SPLIT in the active tab -- track it by leaf id.
      const claudeLeaf = await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId)
          const newLeaf = findLeavesByMode(layout, 'claude').find((l) => !beforeIds.has(l.id))
          return newLeaf?.content?.terminalId ? newLeaf : null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const layout = await harness.getPaneLayout(tabId)
          return findLeavesByMode(layout, 'claude').find((l) => !beforeIds.has(l.id))!
        })
      const paneId: string = claudeLeaf.id
      const terminalIdBefore: string = claudeLeaf.content.terminalId
      const claudeContent = async () => {
        const layout = await harness.getPaneLayout(tabId)
        return collectLeaves(layout).find((l) => l.id === paneId)?.content
      }

      // t=0 identity: the FIRST spawn already carries --session-id <uuid>.
      const preallocatedId: string = await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          const withId = entries.find((e) => e.argv.includes('--session-id'))
          if (!withId) return null
          return withId.argv[withId.argv.indexOf('--session-id') + 1] ?? null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const entries = await readArgvLog(argLogPath)
          const withId = entries.find((e) => e.argv.includes('--session-id'))!
          return withId.argv[withId.argv.indexOf('--session-id') + 1]!
        })
      expect(preallocatedId).toMatch(/^[0-9a-f-]{36}$/)

      // Client persisted the identity ("restore info set quickly", §2.2).
      // PANE-level content.sessionRef: the fold happens in the mounted pane's
      // own terminal.created handler (TerminalView.tsx:3729-3742 ->
      // panesSlice.ts:1705-1707), so assert on the leaf, never the tab.
      await expect
        .poll(async () => (await claudeContent())?.sessionRef?.sessionId ?? null, {
          timeout: 20_000,
        })
        .toBe(preallocatedId)

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL + revive; live client recovers on its own reconnect. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.2: new terminalId, resumed with --resume <preallocatedId>.
      await expect
        .poll(async () => {
          const tid = (await claudeContent())?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeKill)
            .some((e) => hasFlagPair(e.argv, '--resume', preallocatedId))
        }, { timeout: 30_000 })
        .toBe(true)

      const terminalIdAfter = (await claudeContent())?.terminalId
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`claude: resumed session ${preallocatedId}`)
        }, { timeout: 20_000 })
        .toBe(true)
      expect((await claudeContent())?.status).not.toBe('error')
      expect((await claudeContent())?.sessionRef?.sessionId).toBe(preallocatedId)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('codex terminal: sessionRef-bound pane resumes with `resume <id>` after SIGKILL', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const CODEX_SESSION_ID = '11111111-2222-4333-8444-555555555555'
    const SESSION_TITLE = 'wall codex session'
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-codex-term-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const argLogPath = path.join(sharedRoot, 'codex-argv.jsonl')
    const fakeCodexPath = await installFakeCli(
      FAKE_CODEX_CLI_SOURCE,
      'codex',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootWall(page, {
      env: { CODEX_CMD: fakeCodexPath, FAKE_CODEX_ARGV_LOG: argLogPath },
      setupHome: seedCodexHome(CODEX_SESSION_ID, SESSION_TITLE, projectDir),
    })
    try {
      await selectShellIfPickerShowing(page)

      // Open the seeded historical session from the sidebar (identity lands
      // in content.sessionRef only -- the incident shape).
      const sessionList = page.getByTestId('sidebar-session-list')
      await expect(sessionList).toBeVisible({ timeout: 15_000 })
      const sessionItem = page.getByText(SESSION_TITLE, { exact: false }).first()
      await expect(sessionItem).toBeVisible({ timeout: 15_000 })
      const tabCountBefore = await harness.getTabCount()
      await sessionItem.click()
      await expect(async () => {
        expect(await harness.getTabCount()).toBe(tabCountBefore + 1)
      }).toPass({ timeout: 15_000 })
      const tabId = (await harness.getActiveTabId())!

      const terminalIdBefore: string = await expect
        .poll(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () => (await harness.getPaneLayout(tabId))?.content?.terminalId)
      expect((await harness.getPaneLayout(tabId))?.content?.sessionRef?.sessionId).toBe(
        CODEX_SESSION_ID,
      )

      // Create-time resume proof.
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries.some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 20_000 })
        .toBe(true)

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL + revive; live client recovers on its own reconnect. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.3: new terminalId, re-resumed argv, same sessionRef.
      await expect
        .poll(async () => {
          const tid = (await harness.getPaneLayout(tabId))?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeKill)
            .some((e) => hasResumePair(e.argv, CODEX_SESSION_ID))
        }, { timeout: 30_000 })
        .toBe(true)
      const contentAfter = (await harness.getPaneLayout(tabId))?.content
      expect(contentAfter?.status).not.toBe('error')
      expect(contentAfter?.sessionRef?.sessionId).toBe(CODEX_SESSION_ID)
      const terminalIdAfter = contentAfter?.terminalId
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalIdAfter)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`codex: resumed session ${CODEX_SESSION_ID}`)
        }, { timeout: 20_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  test('opencode terminal: locator-resolved session resumes with --session after SIGKILL', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-opencode-term-'))
    const argLogPath = path.join(sharedRoot, 'opencode-argv.jsonl')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_TERMINAL_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootWall(page, {
      env: {
        OPENCODE_CMD: fakeOpencodePath,
        FAKE_OPENCODE_TERMINAL_ARGV_LOG: argLogPath,
      },
      // NOTE: seedWallConfig only overwrites config.json -- it never touches
      // <home>/.local/share/opencode/opencode.db, so the runtime-minted DB
      // survives restartAbrupt()'s setupHome re-run. No symlink needed.
      setupHome: seedWallConfig({ providers: ['opencode'] }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out
      // (donor: truly-idle-alerting.spec.ts:122; same guard as Contract B).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId)
      const paneId: string = leaf.id
      const terminalIdBefore: string = leaf.content.terminalId

      // Mint the session: click the pane, type, press Enter (the fake writes
      // the opencode.db row on its first stdin data event).
      await page.locator('.xterm').last().click()
      await page.keyboard.type('hello wall opencode')
      await page.keyboard.press('Enter')

      // Wait for the locator to associate (identity lands in sessionRef).
      const associatedSessionId: string = await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, paneId)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId ?? null
        }, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => {
          const l = await findLeafById(harness, tabId, paneId)
          return l?.content?.sessionRef?.sessionId ?? l?.content?.resumeSessionId
        })
      expect(associatedSessionId).toMatch(/^ses_e2e_/)

      const argvCountBeforeKill = (await readArgvLog(argLogPath)).length

      // --- SIGKILL + revive; live client recovers on its own reconnect. ---
      await server.restartAbrupt()
      await waitForWsReady(page)

      // CONTRACT §2.4: new terminalId, resumed via --session <id>.
      await expect
        .poll(async () => {
          const l = await findLeafById(harness, tabId, paneId)
          const tid = l?.content?.terminalId ?? null
          return tid && tid !== terminalIdBefore ? tid : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      await expect
        .poll(async () => {
          const entries = await readArgvLog(argLogPath)
          return entries
            .slice(argvCountBeforeKill)
            .some((e) => hasFlagPair(e.argv, '--session', associatedSessionId))
        }, { timeout: 30_000 })
        .toBe(true)
      const leafAfter = await findLeafById(harness, tabId, paneId)
      expect(leafAfter?.content?.status).not.toBe('error')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(leafAfter?.content?.terminalId)
          const unwrapped = typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
          return unwrapped.includes(`opencode: resumed session ${associatedSessionId}`)
        }, { timeout: 20_000 })
        .toBe(true)
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.6: freshcodex is the reference implementation -- after
  // SIGKILL+restart+reload the pane must rebind to the SAME durable thread
  // with history rehydrated ('Fixture turn' is the fake's deterministic
  // reply) and a non-wedged status.
  test('freshcodex: SIGKILL restore rebinds the same thread with history rehydrated', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-freshcodex-'))
    const fakeCodexPath = await installFakeCodexAppServer(path.join(sharedRoot, 'bin'))

    const { server, harness } = await bootWall(page, {
      env: { CODEX_CMD: fakeCodexPath },
      setupHome: seedWallConfig({ providers: ['codex'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshcodex click is swallowed (donor ordering:
      // restore-double-restart.spec.ts:210-214; same guard as Contracts B/D).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshcodexPane(page, harness)
      await sendFreshAgentTurn(page, harness, tabId, 'wall freshcodex turn')
      await expect(
        page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'),
      ).toBeVisible({ timeout: 20_000 })

      const originalSessionId: string = await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))) ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))!,
        )

      await flushPersistence(page)
      await harness.clearSentWsMessages()

      // --- SIGKILL + revive, then reload (full client rehydrate). ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.6: same durable identity, history rehydrated, not wedged,
      // and every post-reload create targets the ORIGINAL thread.
      const rehydratedTabId = (await harness.getActiveTabId())!
      const rehydratedIdentity: string | undefined = await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))), {
          timeout: 30_000,
        })
        .not.toBeUndefined()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))),
        )
      expect(rehydratedIdentity).toBe(originalSessionId)
      await expect(
        page.locator('[data-context="fresh-agent"]').last().getByText('Fixture turn'),
      ).toBeVisible({ timeout: 30_000 })
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))
      expect(finalLeaf?.content?.status).not.toBe('error')

      const sentAfterReload = await harness.getSentWsMessages()
      const createsAfterReload = sentAfterReload.filter((m: any) => m?.type === 'freshAgent.create')
      for (const create of createsAfterReload) {
        const resumeTarget = (create as any).resumeSessionId ?? (create as any).sessionRef?.sessionId
        expect(resumeTarget).toBe(originalSessionId)
      }
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.7: the serve DB survives; after SIGKILL+restart+reload the
  // pane must carry the SAME ses_* identity, rehydrate prompt+response, and
  // mint NO new session.
  test('freshopencode: SIGKILL restore keeps the ses_* identity and rehydrates history', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // PINNED (observed failure mode, run of 2026-07-24): after
    // SIGKILL+restart+RELOAD the rehydrated pane does NOT carry the durable
    // ses_* identity -- leafDurableIdentity returns a freshly minted
    // `freshopencode-<requestId>` placeholder (the lazy-create shape,
    // server/fresh-agent/adapters/opencode/adapter.ts:75 /
    // crates/freshell-freshagent/src/opencode_ws.rs:245) and no message
    // history is visible, even though the durable ses_http_* session
    // SURVIVED the kill (it still lists in the sidebar). The serve-DB
    // survival half of §2.7 holds; the pane rebind half does not. The donor
    // (freshopencode-restart-recovery.spec.ts) stays green because it never
    // reloads the page -- live reconnect preserves in-memory pane state.
    test.fail(
      e2eServerKind === 'rust',
      'P1.8/P1.13 (§2.7): post-reload freshopencode pane re-mints a freshopencode-* placeholder instead of rebinding the surviving ses_* session',
    )
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-freshopencode-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    const auditLogPath = path.join(sharedRoot, 'opencode-audit.jsonl')
    const fakeOpencodePath = await installFakeCli(
      FAKE_OPENCODE_SIDECAR_SOURCE,
      'opencode',
      path.join(sharedRoot, 'bin'),
    )

    const { server, harness } = await bootWall(page, {
      env: { OPENCODE_CMD: fakeOpencodePath, FAKE_OPENCODE_AUDIT_LOG: auditLogPath },
      setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
    })
    // NOTE: the fixture's /session/:id/abort and /fork routes 404 -- known
    // and out of contract scope (the only production caller is
    // freshAgent.interrupt, whose error is swallowed,
    // crates/freshell-freshagent/src/opencode_ws.rs:562-572). Do not add
    // interrupt-shaped assertions against this fixture.
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      await enableFreshOpencode(page)
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshopencode click is swallowed (donor:
      // truly-idle-alerting.spec.ts:122; same guard as Contracts B/D/E --
      // kept in the TEST BODY so the produced helpers stay verbatim).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshopencodePane(page, projectDir)

      const prompt = 'wall freshopencode turn'
      await sendFreshAgentTurn(page, harness, tabId, prompt)
      await expect(page.getByText(`Fake OpenCode response: ${prompt}`)).toBeVisible({
        timeout: 30_000,
      })

      // Materialized ses_* identity.
      const sessionId: string = await expect
        .poll(async () => {
          const id = leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))
          return id && /^ses_/.test(id) ? id : null
        }, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))!,
        )

      const auditRawBefore = await fs.readFile(auditLogPath, 'utf8').catch(() => '')
      const auditCountBefore = auditRawBefore ? auditRawBefore.trim().split('\n').length : 0

      await flushPersistence(page)

      // --- SIGKILL + revive, then reload. The opencode.db lives under the
      // preserved home (XDG_DATA_HOME) and survives; setupHome only rewrites
      // config.json. ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.7: same identity, history rehydrated, not wedged.
      const rehydratedTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))), {
          timeout: 30_000,
        })
        .toBe(sessionId)
      await expect(page.getByText(prompt)).toBeVisible({ timeout: 30_000 })
      await expect(page.getByText(`Fake OpenCode response: ${prompt}`)).toBeVisible({
        timeout: 30_000,
      })
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))
      expect(finalLeaf?.content?.status).not.toBe('error')

      // No NEW durable session was minted by the restore.
      const auditRawAfter = await fs.readFile(auditLogPath, 'utf8').catch(() => '')
      const eventsAfter = auditRawAfter
        .trim()
        .split('\n')
        .filter(Boolean)
        .slice(auditCountBefore)
        .map((line) => JSON.parse(line) as { event?: string })
      expect(
        eventsAfter.filter(
          (event) => event.event === 'session_create_requested' || event.event === 'session_created',
        ),
      ).toEqual([])
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })

  // Per plan §2.8: freshclaude is "not restart-resilient at all": attach is
  // swallowed, snapshot 503s. The CONTRACT asserted is the target state
  // (rebound with history rehydrated, status not wedged); the pin records
  // today's reality.
  test('freshclaude: SIGKILL restore rebinds with history rehydrated and status not wedged', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    // EXPECTED-FAIL WALL PIN -- P0.2 (§2.8): the FIRST failure today is that
    // claude fresh-agent identity is never persisted -- the server sends no
    // sessionRef for claude (crates/freshell-freshagent/src/claude.rs:94-96,247)
    // and the persist middleware strips sessionId without a serverInstanceId
    // (src/store/persistMiddleware.ts:245-266) -- so post-reload the pane
    // sends NEITHER attach nor create, and the identity poll below times out.
    // Attach-swallow (crates/freshell-ws/src/terminal.rs:535-553 `_ => {}`)
    // and snapshot-503 (crates/freshell-freshagent/src/snapshot.rs:132-145)
    // are real and block rebind + rehydration AFTER identity persistence
    // lands. FLIP only when claude identity survives reload AND the attach
    // arm + snapshot adapter land (P0.2 slices). See file doc comment.
    test.fail(
      e2eServerKind === 'rust',
      'P0.2 (§2.8): claude identity never persisted; attach swallow + missing snapshot adapter block rebind behind it',
    )

    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-wall-freshclaude-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })

    const { server, harness } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const tabId = (await harness.getActiveTabId())!
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker, else openPanePicker races the boot picker's fade-out and
      // the Freshclaude click is swallowed (donor:
      // truly-idle-alerting.spec.ts:122; same guard as Contracts B/D/E/F --
      // kept in the TEST BODY so the produced helper stays verbatim).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await createFreshclaudePane(page, harness, projectDir)
      await sendFreshAgentTurn(page, harness, tabId, 'wall freshclaude turn')
      // Pre-kill turn proof via the HARNESS (Redux), not UI chrome: the
      // fresh-agent transcript renders exclusively from the REST thread
      // snapshot (FreshAgentView.tsx:1302,1782 -- getFreshAgentThreadSnapshot
      // -> snapshot?.turns), and the Rust router has NO claude snapshot
      // adapter (503 FRESH_AGENT_RUNTIME_UNAVAILABLE, crates/
      // freshell-freshagent/src/snapshot.rs:133-146), so the assistant reply
      // NEVER renders in the DOM today even though the turn completed. The
      // sidecar protocol itself is verified end-to-end: freshAgent.event/
      // freshAgent.assistant arrives on the wire and folds into the
      // freshAgent slice (turns[]) -- assert THAT (createFreshclaudePane's
      // note: assert pane state via the harness, never error-free UI chrome
      // for freshclaude).
      await expect
        .poll(async () => {
          const sessions = (await harness.getState())?.freshAgent?.sessions ?? {}
          return Object.values(sessions).some((s: any) =>
            (s?.turns ?? []).some((turn: any) =>
              turn?.role === 'assistant'
              && (turn?.items ?? []).some(
                (item: any) => typeof item?.text === 'string' && item.text.includes('Fixture claude turn'),
              ),
            ),
          )
        }, { timeout: 20_000 })
        .toBe(true)

      const originalSessionId: string = await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId))) ?? null, {
          timeout: 20_000,
        })
        .not.toBeNull()
        .then(async () =>
          leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(tabId)))!,
        )

      await flushPersistence(page)

      // --- SIGKILL + revive, then reload. ---
      await server.restartAbrupt()
      await waitForWsReady(page)
      await reloadAndReconnect(page, harness)

      // CONTRACT §2.8 target: same identity, history rehydrated, not wedged.
      const rehydratedTabId = (await harness.getActiveTabId())!
      await expect
        .poll(async () => leafDurableIdentity(findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))), {
          timeout: 30_000,
        })
        .toBe(originalSessionId)
      await expect(
        page.locator('[data-context="fresh-agent"]').last().getByText('Fixture claude turn'),
      ).toBeVisible({ timeout: 30_000 })
      const finalLeaf = findFreshAgentLeaf(await harness.getPaneLayout(rehydratedTabId))
      expect(finalLeaf?.content?.status).not.toBe('error')
      expect(finalLeaf?.content?.status).not.toBe('creating')
    } finally {
      await server.stop()
      await fs.rm(sharedRoot, { recursive: true, force: true })
    }
  })
})
