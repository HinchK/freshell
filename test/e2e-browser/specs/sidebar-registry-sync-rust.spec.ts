/**
 * P1.14 sidebar/tab-registry sync re-verification (Lane C1).
 * Pins the Incident-4 sidebar contract against ledger-backed identity:
 *  case-c: fresh codex duplicate collapse (this task)
 *  case-b: REST-created tabs are green + dedupe   (Task 6)
 *  case-a: joins survive server restart            (Task 7)
 *  case-d: joins correct after recover-my-panes    (Task 8)
 * Owns a RustServer directly (ephemeral loopback port -- NEVER 3001/3002).
 */
import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { RustServer, ensureRustServerBuilt, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SEEDED_CLAUDE_ID = randomUUID()
const PROJECT_DIR = '/tmp/p114-sidebar-project'

// Copied VERBATIM from pane-ledger-restart-rust.spec.ts:29 (per this
// suite's per-spec-ownership convention: helpers are copied, not imported).
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

// Copied VERBATIM from remote-tab-linkage-rust.spec.ts:60-74.
async function selectShellIfPickerShowing(page: import('@playwright/test').Page): Promise<void> {
  await page.waitForTimeout(500)
  const xtermVisible = await page.locator('.xterm').first().isVisible().catch(() => false)
  if (xtermVisible) return
  const shellNames = ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']
  for (const name of shellNames) {
    try {
      await page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }).click({ timeout: 5_000 })
      await page.locator('.xterm').first().waitFor({ state: 'visible', timeout: 15_000 })
      return
    } catch {
      continue
    }
  }
}

// Copied VERBATIM from remote-tab-linkage-rust.spec.ts:76-86.
async function bootAndConnect(
  page: import('@playwright/test').Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await selectShellIfPickerShowing(page)
  return harness
}

// Copied VERBATIM from remote-tab-linkage-rust.spec.ts:89-93.
/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

// Copied VERBATIM from codex-terminal-restore-rust.spec.ts:122.
/** Flatten a pane layout tree into its leaf nodes. */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function buildClaudeSessionJsonl(sessionId: string, cwd: string, title: string): string {
  // Donor shape: session-directory-matrix.spec.ts:36 (buildSessionJsonl).
  // Field names verified against the donor (system/init: session_id, uuid,
  // timestamp, cwd; turns: parentUuid, sessionId, cwd, message, uuid, timestamp).
  const t0 = '2026-07-20T08:00:00.000Z'
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-0', timestamp: t0, cwd }),
    JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: 'u-0', timestamp: t0, sessionId, cwd, message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-2', parentUuid: 'u-1', timestamp: t0, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} reply` }] } }),
  ].join('\n') + '\n'
}

const SEEDED_CODEX_THREAD_ID = randomUUID()

async function seedCodexRollout(homeDir: string, threadId: string, cwd: string): Promise<void> {
  // Donor shape: sidebar-click-resume.spec.ts ~:175-185 -- verify field
  // names (session_meta payload.id/payload.cwd + a message record) there.
  // VALIDATED: the cwd field is mandatory -- a rollout that does not parse
  // with a cwd is excluded from the index (R10b) and will NEVER appear.
  const day = '2026/07/20'
  const dir = path.join(homeDir, '.codex', 'sessions', day)
  await fs.mkdir(dir, { recursive: true })
  const lines = [
    JSON.stringify({ timestamp: '2026-07-20T08:00:00.000Z', type: 'session_meta', payload: { id: threadId, cwd } }),
    JSON.stringify({ timestamp: '2026-07-20T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'P114 seeded codex session' }] } }),
  ]
  await fs.writeFile(path.join(dir, `rollout-2026-07-20T08-00-00-${threadId}.jsonl`), lines.join('\n') + '\n')
}

// Decline idiom from recover-my-panes-rust.spec.ts:377 (recovery-decline).
// Why: case-c leaves its panes in server memory, and case-b's FRESH browser
// context (no client state) makes RecoveryOfferPanel offer to restore them
// ("Restore N panes from server memory?"). That dialog is a fixed inset-0
// z-[60] overlay that intercepts EVERY sidebar click, so case-b's row.click()
// retries forever and the test times out (observed on full-suite runs; the
// scenario passes standalone where server memory is empty at boot). Recovery
// semantics themselves are case-d territory (Task 8) -- here we just decline.
async function declineRecoveryOfferIfShowing(page: import('@playwright/test').Page): Promise<void> {
  const panel = page.getByTestId('recovery-offer-panel')
  const appeared = await panel.waitFor({ state: 'visible', timeout: 10_000 }).then(
    () => true,
    () => false, // standalone run: no panes in server memory, no offer
  )
  if (!appeared) return
  await page.getByTestId('recovery-decline').click()
  await panel.waitFor({ state: 'hidden', timeout: 5_000 })
}

test.describe.serial('P1.14 sidebar registry sync (rust)', () => {
  test.setTimeout(240_000)
  let server: RustServer
  let info: TestServerInfo
  let sharedRoot: string

  test.beforeAll(async () => {
    // Same hook-timeout + prebuild pattern as recover-my-panes-rust.spec.ts:194-195:
    // the first release build of freshell-server can take minutes, and the
    // default 60s hook timeout would kill server.start() mid-build.
    test.setTimeout(600_000)
    ensureRustServerBuilt()
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p114-sidebar-'))
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-claude-cli.mjs')
    const fakeCodex = await installFakeCli(binDir, 'codex', 'fake-codex-terminal.mjs')
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        CODEX_CMD: fakeCodex,
        FAKE_CLAUDE_ARGV_LOG: path.join(sharedRoot, 'claude-argv.jsonl'),
        FAKE_CODEX_TERMINAL_ARGV_LOG: path.join(sharedRoot, 'codex-argv.jsonl'),
      },
      setupHome: async (homeDir: string) => {
        await fs.mkdir(PROJECT_DIR, { recursive: true })
        // enable the providers the scenarios use
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex'] } },
        }, null, 2))
        // seed a claude session file for case-b (Task 6)
        const slug = PROJECT_DIR.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${SEEDED_CLAUDE_ID}.jsonl`),
          buildClaudeSessionJsonl(SEEDED_CLAUDE_ID, PROJECT_DIR, 'P114 seeded claude session'))
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  test('case-c: fresh codex terminal collapses to a single green row', async ({ page }) => {
    const harness = await bootAndConnect(page, info)

    // REST-create a fresh codex terminal tab (no resume id) --
    // request shape: donor remote-tab-linkage-rust.spec.ts:197.
    const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
      headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
      data: { mode: 'codex', cwd: PROJECT_DIR },
    })
    expect(res.ok()).toBe(true)
    const body = await res.json()
    const restTabId: string = body?.data?.tabId
    expect(restTabId).toBeTruthy()

    // Wait for the codex PTY to attach and print its prompt BEFORE typing --
    // same gate as donor codex-terminal-restore-rust.spec.ts:226-229. An
    // Enter typed before the PTY attaches is dropped, and the fixture only
    // writes its rollout on the FIRST Enter, so an early keypress would
    // strand the pane without an identity artifact (observed flake).
    let codexTerminalId: string | null = null
    await expect.poll(async () => {
      const layout = await harness.getPaneLayout(restTabId)
      const leaf = collectLeaves(layout).find((l) => l?.content?.mode === 'codex')
      codexTerminalId = leaf?.content?.terminalId ?? null
      return codexTerminalId
    }, { timeout: 20_000 }).toBeTruthy()
    await expect.poll(async () => {
      const buffer = await harness.getTerminalBuffer(codexTerminalId!)
      return typeof buffer === 'string' && buffer.includes('codex> ')
    }, { timeout: 15_000 }).toBe(true)

    // The driven client shows the pane; type Enter so the fake codex
    // terminal materializes its rollout (Enter-gated, fixture contract).
    // NOTE: multiple .xterm elements stay mounted (every tab's TabContent is
    // kept alive, App.tsx:1611) -- always scope with .last()/.first() or
    // Playwright strict mode throws (donor: remote-tab-linkage-rust.spec.ts:179).
    await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 20_000 })
    await page.locator('.xterm').last().click()
    await page.keyboard.press('Enter')

    // THE CONTRACT: eventually exactly ONE codex sidebar row, green, and
    // no provisional `terminal:<id>` row left behind -- WITHOUT a reload
    // (proves arming+adoption (Task 4), the stamped feed (Task 2), the
    //  verified client fold, and the no-reload push (Task 3)).
    await expect(async () => {
      const rows = page.locator('[data-provider="codex"][data-session-id]')
      const count = await rows.count()
      expect(count).toBe(1)
      await expect(rows.first()).toHaveAttribute('data-has-tab', 'true')
      const sessionId = await rows.first().getAttribute('data-session-id')
      expect(sessionId?.startsWith('terminal:')).toBe(false)
    }).toPass({ timeout: 45_000 })
  })

  test('case-b: REST-created resume tabs are green and dedupe on click', async ({ page }) => {
    const harness = await bootAndConnect(page, info) // keep the TestHarness -- the dedupe gate below needs it
    await declineRecoveryOfferIfShowing(page) // case-c's server-memory panes trigger the offer overlay
    await seedCodexRollout(info.homeDir, SEEDED_CODEX_THREAD_ID, PROJECT_DIR)

    for (const [mode, sessionId] of [
      ['claude', SEEDED_CLAUDE_ID],
      ['codex', SEEDED_CODEX_THREAD_ID],
    ] as const) {
      const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
        headers: { 'x-auth-token': info.token, 'content-type': 'application/json' },
        // VALIDATED: raw codex resumeSessionId is deliberately 400-rejected at
        // HEAD (terminal_tabs.rs:124-131, pinned by
        // create_codex_tab_rejects_raw_resume_session_id_without_session_ref);
        // the canonical sessionRef shape IS accepted (pinned by
        // create_codex_tab_accepts_session_ref_and_derives_resume_args). Do NOT
        // "fix" the rejection -- use the canonical shape for codex.
        data: mode === 'codex'
          ? { mode, cwd: PROJECT_DIR, sessionRef: { provider: 'codex', sessionId } }
          : { mode, cwd: PROJECT_DIR, resumeSessionId: sessionId },
      })
      expect(res.ok()).toBe(true)

      const row = page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`)
      // Incident-4 contract: the row exists and is GREEN, not grey.
      await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
      await expect(row).toHaveCount(1)

      // Dedupe contract: clicking the green row focuses the existing pane
      // instead of opening a second tab (donor: remote-tab-linkage:252-255).
      // getTabCount() is a NODE-SIDE TestHarness method
      // (helpers/test-harness.ts:150-155) that reads
      // window.__FRESHELL_TEST_HARNESS__?.getState() inside the page. The
      // window global itself has NO getTabCount method (src/lib/test-harness.ts
      // exposes getState/dispatch/getWsReadyState/...), so never call
      // getTabCount via page.evaluate -- that throws on every run.
      // Fail-loud guard: getTabCount() returns 0 when the harness is missing,
      // so pin tabsBefore > 0 (this loop just created tabs) to make a vacuous
      // 0 === 0 pass impossible.
      const tabsBefore = await harness.getTabCount()
      expect(tabsBefore).toBeGreaterThan(0)
      await row.click()
      await page.waitForTimeout(500)
      const tabsAfter = await harness.getTabCount()
      expect(tabsAfter).toBe(tabsBefore)
    }
  })
})
