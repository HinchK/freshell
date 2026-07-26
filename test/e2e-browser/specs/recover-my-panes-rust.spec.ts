/**
 * B3/P1.9 recover-my-panes — the campaign's first browser-loss recovery e2e
 * (docs/plans/2026-07-26-recover-my-panes.md, Task 8).
 *
 * Scenario 1 (accept path): a browser with a claude CLI pane + a browser pane
 * is LOST (context closed), the server restarts, and a fresh browser context
 * (empty storage = new machine) is OFFERED recovery — accepting recreates the
 * panes, resumes the dead claude session (`--resume <sessionId>` argv proof +
 * the fake CLI's scrollback marker), recreates the mixed-kind browser pane,
 * and a same-browser reload never re-offers (localStorage now has a layout).
 *
 * Scenario 2 (decline path): a fresh context declines — the panel closes and
 * no recovered tabs are added.
 *
 * Scenario 3 (no-restart browser loss, D7): the browser is lost WITHOUT a
 * server restart, so the claude PTY stays Running (registry-owned). The next
 * fresh context's offer shows the live-session note, and accepting recreates
 * the pane WITHOUT `--resume` — the running session is left untouched.
 *
 * Fixture shapes (fake CLI, config seeding, shell-picker choreography) are
 * COPIED from pane-ledger-restart-rust.spec.ts per this suite's
 * per-spec-ownership convention.
 *
 * Rust-only: drives `GET /api/recovery/inventory` (no legacy equivalent) and
 * owns a RustServer directly (ephemeral loopback port — NEVER 3001/3002).
 * Registered ONLY under `rust-chromium` and testIgnore'd on every match-all
 * project (see playwright.config.ts's RUST_ONLY_SPECS).
 */
import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import type { BrowserContext, Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { TestServerInfo } from '../helpers/test-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Donor: pane-ledger-restart-rust.spec.ts:29 */
async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

/** Donor: pane-ledger-restart-rust.spec.ts:37 */
function seedConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] } },
        },
        null,
        2,
      ),
    )
  }
}

/**
 * Donor: pane-ledger-restart-rust.spec.ts:65 (load-bearing comment there):
 * a live shell terminal's cwd pre-fills the Starting-directory combobox the
 * CLI-pane creates below depend on.
 */
async function selectShellIfPickerShowing(page: Page): Promise<void> {
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

/** Donor: pane-ledger-restart-rust.spec.ts:81 */
async function openCliPane(page: Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

/** Read the fake CLI's argv-log JSONL (empty array if not yet written). */
async function readArgvLog(logPath: string): Promise<Array<{ argv: string[] }>> {
  const raw = await fs.readFile(logPath, 'utf8').catch(() => '')
  if (!raw) return []
  return raw.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { argv: string[] })
}

/**
 * Claude-adapted adjacent-pair matcher (per the task brief's Interfaces): the
 * fake claude CLI receives the `--resume <id>` FLAG (fake-claude-cli.mjs:26-30)
 * — NOT codex's bare `resume` subcommand token, so a codex-style
 * `resume <id>` adjacent-pair matcher would never match here.
 */
const hasClaudeResumePair = (argv: string[], sessionId: string) => {
  const i = argv.indexOf('--resume')
  return i !== -1 && argv[i + 1] === sessionId
}

/** `--session-id <id>` values, in order, from a slice of argv-log entries. */
function sessionIdsOf(entries: Array<{ argv: string[] }>): string[] {
  return entries.flatMap((e) => {
    const i = e.argv.indexOf('--session-id')
    return i >= 0 ? [e.argv[i + 1]] : []
  })
}

/** Boot a page against the server (donor: the retired snapshot-restore-rust spec). */
async function connect(page: Page, info: { baseUrl: string; token: string }): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/** Triage aid: log inventory request failures/non-200s (kept quiet on success). */
function traceInventoryFailures(page: Page, label: string): void {
  page.on('response', (r) => {
    if (!r.url().includes('/api/recovery/inventory') || r.status() === 200) return
    console.log(`[${label}] inventory response ${r.status()} ${r.url()}`)
  })
  page.on('requestfailed', (req) => {
    if (!req.url().includes('/api/recovery/inventory')) return
    console.log(`[${label}] inventory request FAILED: ${req.failure()?.errorText}`)
  })
}

/** Create the browser pane the way a user would (browser-pane.spec.ts:8). */
async function createBrowserPane(page: Page, url: string): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^Browser$/i }).click({ force: true })
  const urlInput = page.getByPlaceholder('Enter URL...')
  await expect(urlInput).toBeVisible({ timeout: 10_000 })
  await urlInput.fill(url)
  await urlInput.press('Enter')
  const iframe = page.locator('iframe[title="Browser content"]')
  await iframe.waitFor({ state: 'attached', timeout: 10_000 })
}

test.describe('recover-my-panes browser-loss recovery (rust only)', () => {
  // Scenarios share ONE owned server and build on each other's durable state
  // (snapshots, ledger rows, a still-running PTY) — strict ordering required.
  test.describe.configure({ mode: 'serial' })

  let sharedRoot = ''
  let capturedHome = ''
  let argLog = ''
  let server: RustServer
  let info: TestServerInfo

  /**
   * Wait until SOME persisted snapshot generation contains every needle.
   * Stronger than the brief's minimum (a device dir with >=1 .json): pushes
   * fire on ready + every 5s, so an early generation may predate the panes
   * under test — matching CONTENT guarantees the recoverable state actually
   * includes them before we kill the context.
   */
  async function waitForSnapshotContaining(needles: string[], timeoutMs = 30_000): Promise<void> {
    const snapshotsDir = path.join(capturedHome, '.freshell', 'tabs-snapshots')
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const devices = await fs.readdir(snapshotsDir).catch(() => [] as string[])
      for (const device of devices) {
        const deviceDir = path.join(snapshotsDir, device)
        const files = await fs.readdir(deviceDir).catch(() => [] as string[])
        for (const f of files.filter((f) => f.endsWith('.json'))) {
          const body = await fs.readFile(path.join(deviceDir, f), 'utf8').catch(() => '')
          if (needles.every((n) => body.includes(n))) return
        }
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    throw new Error(`No tabs-snapshot generation contained [${needles.join(', ')}] within ${timeoutMs}ms`)
  }

  test.beforeAll(async () => {
    test.setTimeout(600_000) // first release build of freshell-server can take minutes
    ensureRustServerBuilt()
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'recover-my-panes-e2e-'))
    argLog = path.join(sharedRoot, 'claude-argv.jsonl')
    const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
    const seed = seedConfig()
    server = new RustServer({
      env: { CLAUDE_CMD: fakeClaude, FAKE_CLAUDE_ARGV_LOG: argLog },
      setupHome: async (homeDir: string) => {
        capturedHome = homeDir
        await seed(homeDir)
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop().catch(() => {})
    if (sharedRoot) await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
  })

  /**
   * SERVICE WORKERS ARE BLOCKED in every context this spec opens (the
   * perf harness precedent, perf/create-audit-context.ts:18): the production
   * client registers /sw.js and RELOADS on `controllerchange` (pwa.ts:24-34).
   * On a FRESH context that reload races App mount, aborting in-flight boot
   * fetches (observed: the recovery-inventory fetch dying with
   * net::ERR_ABORTED) — and the panel's fetch is deliberately one-shot
   * best-effort (RecoveryOfferPanel.tsx: on fetch failure, stay quiet), so a
   * lost race means no offer for that boot. Blocking the SW removes the
   * reload entirely; recovery behavior itself never depends on the SW.
   */
  const FRESH_CONTEXT_OPTIONS = { serviceWorkers: 'block' as const }

  /**
   * Open a FRESH context (empty storage) and REQUIRE the recovery offer —
   * one context, one hard `toBeVisible` assertion (the brief's contract).
   * No retry loop: with service workers blocked (above) the only known cause
   * of transient offer suppression is gone, and a retry here would quietly
   * absorb exactly the flaky-offer regression class this feature already
   * exhibited once. If the offer ever goes flaky again, this MUST fail loud.
   */
  async function openFreshContextWithOffer(
    browser: import('@playwright/test').Browser,
    label: string,
  ): Promise<{ ctx: BrowserContext; page: Page; harness: TestHarness }> {
    const ctx = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const page = await ctx.newPage()
    traceInventoryFailures(page, label)
    const harness = await connect(page, info)
    await expect(page.getByTestId('recovery-offer-panel')).toBeVisible({ timeout: 15_000 })
    return { ctx, page, harness }
  }

  // Scenario 1's claude session — scenario 2/3 reason about the same log.
  let sessionIdA = ''

  test('scenario 1: lose the browser, restart the server, accept — panes recreated, claude resumed, reload never re-offers', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)

    // ---- Context A: populate a tab with a claude CLI pane + a browser pane ----
    const ctxA: BrowserContext = await browser.newContext(FRESH_CONTEXT_OPTIONS)
    const pageA = await ctxA.newPage()
    await connect(pageA, info)
    await selectShellIfPickerShowing(pageA)
    await expect(pageA.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // Claude pane (button label is the extension manifest's "Claude CLI").
    await openCliPane(pageA, /^Claude CLI$/i)

    // Record the pre-allocated sessionId from the argv log's --session-id pair
    // (pane-ledger-restart-rust.spec.ts:162-168 extraction).
    await expect(async () => {
      const sid = sessionIdsOf(await readArgvLog(argLog))[0]
      expect(sid, 'fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdA = sid!
    }).toPass({ timeout: 30_000 })

    // Let it BIND: the ledger binding row for that sessionId hits disk (the
    // donor spec's readiness wait) — the inventory's D4 resolve needs it.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(sessionIdA))).toBe(true)
    }).toPass({ timeout: 15_000 })

    // Mixed-kind coverage (A12): a browser pane at https://example.com in the
    // SAME tab, created the way a user would (split + picker "Browser").
    await createBrowserPane(pageA, 'https://example.com')

    // A snapshot generation containing BOTH panes exists on disk (pushes fire
    // on ready + every 5s).
    await waitForSnapshotContaining([sessionIdA, 'example.com'])

    // ---- The "lost browser" + server restart ----
    await ctxA.close()
    await server.restart()

    // ---- Context B: fresh storage = new machine; the offer is REQUIRED ----
    const { ctx: ctxB, page: pageB } = await openFreshContextWithOffer(browser, 'contextB')

    const panelB = pageB.getByTestId('recovery-offer-panel')
    await expect(panelB).toBeVisible()
    await expect(panelB.getByRole('heading')).toHaveText(/restore \d+ pane/i)

    const argvCountBeforeAccept = (await readArgvLog(argLog)).length
    await pageB.getByTestId('recovery-accept').click()
    await expect(panelB).toHaveCount(0)

    // A recreated terminal pane renders.
    await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // PRIMARY resume proof: the accept re-spawned claude with the adjacent
    // pair `--resume <sessionIdA>` (delta past the pre-accept log).
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      expect(
        entries.slice(argvCountBeforeAccept).some((e) => hasClaudeResumePair(e.argv, sessionIdA)),
        'accept must exec `claude --resume <sessionId>`',
      ).toBe(true)
    }).toPass({ timeout: 30_000 })

    // SECONDARY resume proof: the recreated pane's xterm text shows the fake
    // CLI's startup marker (fake-claude-cli.mjs:26-30; scrollback replay
    // delivers it to the late-attaching context). Buffers are read via the
    // renderer-agnostic harness API across ALL registered terminals. The
    // recovered claude pane is NARROW (third pane in a horizontal chain), so
    // the ~60-char marker line WRAPS across buffer rows — compare with all
    // whitespace stripped so wrapping (and trimmed wrap points) cannot hide it.
    await pageB.waitForFunction(
      (marker) => {
        const harness = (window as any).__FRESHELL_TEST_HARNESS__
        if (!harness) return false
        const state = harness.getState()
        const ids: string[] = []
        for (const tab of state?.tabs?.tabs ?? []) {
          const walk = (node: any) => {
            if (!node) return
            if (node.type === 'leaf') {
              if (node.content?.kind === 'terminal' && node.content?.terminalId) ids.push(node.content.terminalId)
              return
            }
            for (const child of node.children ?? []) walk(child)
          }
          walk(state?.panes?.layouts?.[tab.id])
        }
        const squash = (s: string) => s.replace(/\s+/g, '')
        return ids.some((id) => squash(harness.getTerminalBuffer(id) ?? '').includes(squash(marker)))
      },
      `claude: resumed session ${sessionIdA}`,
      { timeout: 30_000 },
    )

    // The browser pane was recreated too (mixed-kind restore, A12).
    const iframeB = pageB.locator('iframe[title="Browser content"]')
    await iframeB.waitFor({ state: 'attached', timeout: 15_000 })
    expect(await iframeB.getAttribute('src')).toContain('example.com')

    // ---- Same-browser reload guard: localStorage now has a layout ----
    await pageB.reload()
    const harnessB2 = new TestHarness(pageB)
    await harnessB2.waitForHarness()
    await harnessB2.waitForConnection()
    // Eligibility is boot-captured and synchronous (hadPersistedLayoutAtBoot
    // short-circuits BEFORE any fetch); the settle covers the async fetch path
    // that would have to complete for a wrongful offer to appear.
    await pageB.waitForTimeout(2_000)
    await expect(pageB.getByTestId('recovery-offer-panel')).toHaveCount(0)

    await ctxB.close()
  })

  test('scenario 2: decline path — panel closes, no recovered tabs added', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(120_000)

    // Fresh context C against the same server (recoverable state still exists
    // from scenario 1 — context B's accepted layout also pushed snapshots).
    const { ctx: ctxC, page: pageC, harness: harnessC } = await openFreshContextWithOffer(browser, 'contextC')

    const panelC = pageC.getByTestId('recovery-offer-panel')
    await expect(panelC).toBeVisible()
    await pageC.getByTestId('recovery-decline').click()
    await expect(panelC).toHaveCount(0)

    // No recovered tabs: only the auto-created default tab remains — settle
    // first so a straggling (wrongful) recovery could have landed.
    await expect(async () => {
      expect(await harnessC.getTabCount()).toBe(1)
    }).toPass({ timeout: 10_000 })
    await pageC.waitForTimeout(1_500)
    expect(await harnessC.getTabCount()).toBe(1)

    await ctxC.close()
  })

  test('scenario 3: no-restart browser loss — live session recreates WITHOUT resume (D7)', async ({ browser, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    test.setTimeout(240_000)

    // ---- Context D against the SAME still-running server (no restart) ----
    // The offer MODAL (role="dialog" + overlay) appears first — D's storage is
    // empty and recoverable state exists — and would intercept all pointer
    // events. Clear it BEFORE any pane interaction (this dismissal lives only
    // in D's localStorage; context E below is a different fresh context).
    const { ctx: ctxD, page: pageD } = await openFreshContextWithOffer(browser, 'contextD')
    const panelD = pageD.getByTestId('recovery-offer-panel')
    await pageD.getByTestId('recovery-decline').click()
    await expect(panelD).toHaveCount(0)

    await selectShellIfPickerShowing(pageD)
    await expect(pageD.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    const argvCountBeforeCreate = (await readArgvLog(argLog)).length
    await openCliPane(pageD, /^Claude CLI$/i)

    // The NEW pane's sessionId = the --session-id pair past the pre-create count.
    let sessionIdD = ''
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      const sid = sessionIdsOf(entries.slice(argvCountBeforeCreate))[0]
      expect(sid, 'context D fake claude received a pre-allocated --session-id').toBeTruthy()
      sessionIdD = sid!
    }).toPass({ timeout: 30_000 })

    // Ledger binding for D's session (inventory needs the bound row to
    // resolve + join liveness), then a snapshot generation that includes it.
    await expect(async () => {
      const dir = path.join(capturedHome, '.freshell', 'pane-ledger', 'bindings', 'claude')
      const rows = await fs.readdir(dir, { recursive: true }).catch(() => [] as string[])
      expect(rows.map(String).some((f) => f.includes(sessionIdD))).toBe(true)
    }).toPass({ timeout: 15_000 })
    await waitForSnapshotContaining([sessionIdD])

    // The argv-log watermark for the D7 negative assertion below.
    const argvCountAtD = (await readArgvLog(argLog)).length

    // ---- Lose the browser WITHOUT restarting the server: the claude PTY
    // stays Running (registry-owned, not connection-owned). ----
    await ctxD.close()

    // ---- Context E: the offer appears (the new session changed the
    // recoverable substance — scenario 2's dismissal cannot suppress it, and
    // E is a different fresh context anyway) with the live-session note. ----
    const { ctx: ctxE, page: pageE } = await openFreshContextWithOffer(browser, 'contextE')

    const panelE = pageE.getByTestId('recovery-offer-panel')
    await expect(pageE.getByTestId('recovery-live-note')).toBeVisible()

    await pageE.getByTestId('recovery-accept').click()
    await expect(panelE).toHaveCount(0)

    // A terminal pane is recreated.
    await expect(pageE.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

    // D7 negative assertion, non-vacuously: FIRST wait until the recreated
    // claude spawn is OBSERVED in the log (the live pane recreates as a fresh
    // claude — a new entry past the watermark), THEN assert none of the new
    // entries carries `--resume <sessionIdD>`. The matcher itself is proven
    // non-vacuous by scenario 1's PRIMARY poll, which matched a real pair.
    await expect(async () => {
      const entries = await readArgvLog(argLog)
      expect(entries.length, 'accept must re-spawn a claude CLI for the live pane').toBeGreaterThan(argvCountAtD)
    }).toPass({ timeout: 30_000 })
    const newEntries = (await readArgvLog(argLog)).slice(argvCountAtD)
    expect(
      newEntries.some((e) => hasClaudeResumePair(e.argv, sessionIdD)),
      'live session must be recreated WITHOUT --resume (left untouched, D7)',
    ).toBe(false)

    await ctxE.close()
  })
})
