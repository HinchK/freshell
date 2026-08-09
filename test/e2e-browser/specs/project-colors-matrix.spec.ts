import fs from 'fs/promises'
import path from 'path'
import type { Page, Response } from '@playwright/test'
import { test, expect } from '../helpers/fixtures.js'
import { createE2eServerHandle } from '../helpers/external-target.js'
import { TestHarness } from '../helpers/test-harness.js'

/**
 * SESSION-05 — project colors on History project headers (matrix leg).
 *
 * Acceptance text (docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md):
 * "Choose a project color in one browser, assert the History project header
 * updates in two contexts, reload/restart, and verify persistence plus
 * unchanged unrelated project colors."
 *
 * Save → broadcast → render path (this spec exercises the real one):
 * PUT /api/project-colors → config `projectColors` → `sessions.changed`
 * broadcast → every open context refetches `/api/session-directory` whose
 * page now carries `projectColors` → the client's group overlay recolors
 * the History header swatch. Runs against BOTH server kinds via the
 * HARNESS-02 seam (`e2eServerKind`); legacy is a true parity control.
 *
 * Seeds reuse the trimmed Claude-JSONL shape from
 * session-directory-matrix.spec.ts (the upstream corpus builder HARNESS-04
 * is not required — two single-file projects suffice for the color claim).
 */

const ALPHA_SESSION_ID = '00000000-0000-4000-8000-0000000c0a10'
const BETA_SESSION_ID = '00000000-0000-4000-8000-0000000b3b20'

function buildSessionJsonl(input: {
  sessionId: string
  cwd: string
  title: string
}): string {
  const lines: string[] = [
    JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: input.sessionId,
      uuid: `${input.sessionId}-system`,
      timestamp: '2026-07-16T08:00:00.000Z',
      cwd: input.cwd,
      git: { branch: 'main', dirty: false },
    }),
  ]

  let previousUuid = `${input.sessionId}-system`
  for (let turnIndex = 0; turnIndex < 2; turnIndex += 1) {
    const userUuid = `${input.sessionId}-user-${turnIndex + 1}`
    const assistantUuid = `${input.sessionId}-assistant-${turnIndex + 1}`
    lines.push(JSON.stringify({
      parentUuid: previousUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'user',
      message: { role: 'user', content: `${input.title} request ${turnIndex + 1}` },
      uuid: userUuid,
      timestamp: `2026-07-16T08:0${turnIndex}:01.000Z`,
    }))
    lines.push(JSON.stringify({
      parentUuid: userUuid,
      cwd: input.cwd,
      sessionId: input.sessionId,
      version: '2.1.23',
      gitBranch: 'main',
      type: 'assistant',
      message: {
        role: 'assistant',
        model: 'claude-opus-4-6-20260301',
        content: [{ type: 'text', text: `${input.title} reply ${turnIndex + 1}` }],
        usage: {
          input_tokens: 100,
          output_tokens: 40,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
      },
      uuid: assistantUuid,
      timestamp: `2026-07-16T08:0${turnIndex}:02.000Z`,
    }))
    previousUuid = assistantUuid
  }
  lines.push(JSON.stringify({
    type: 'summary',
    summary: `${input.title} summary`,
    leafUuid: previousUuid,
  }))
  return `${lines.join('\n')}\n`
}

/** `/tmp`-rooted so the SAME literal is the JSONL cwd AND the projectPath. */
const ALPHA_PROJECT = '/tmp/freshell-pcolors/alpha-project'
const BETA_PROJECT = '/tmp/freshell-pcolors/beta-project'
const PICKED_COLOR_HEX = '#e11d48'
const PICKED_COLOR_RGB = 'rgb(225, 29, 72)'
const DEFAULT_COLOR_RGB = 'rgb(107, 114, 128)'

/** The icon-only sidebar nav buttons carry `title` (no aria-label — the
 * pre-existing a11y shape HARNESS-11 owns); title is the stable handle. */
async function openHistoryView(page: Page): Promise<void> {
  await page.locator('button[title="Projects (Ctrl+B P)"]').click()
  await page.locator(`[data-project-path="${ALPHA_PROJECT}"]`).waitFor({ state: 'visible', timeout: 15_000 })
  await page.locator(`[data-project-path="${BETA_PROJECT}"]`).waitFor({ state: 'visible', timeout: 15_000 })
}

function headerSwatch(page: Page, projectPath: string) {
  return page
    .locator(`[data-project-path="${projectPath}"]`)
    .locator('div.h-3.w-3')
}

/**
 * Rust-leg recovery-offer handling (gate B001 fix2). The Rust server alone
 * implements `GET /api/recovery/inventory` (B3/P1.9; legacy 404s and the
 * client's `.catch` stays quiet — a documented KNOWN DIVERGENCE of the
 * matrix). On a FRESH browser boot (empty localStorage, so the D1
 * `hadPersistedLayoutAtBoot` gate cannot suppress it) the client's
 * `RecoveryOfferPanel` fetches the inventory once at mount; when the other
 * context's already-pushed tab snapshot predates this boot's cutoff (A16),
 * the panel opens — a `fixed inset-0` modal overlay that intercepts EVERY
 * pointer event, so its unhandled appearance hangs any later click up to the
 * whole test budget (exactly the B001 rust-leg red; same failure class as
 * sidebar-registry-sync-rust.spec.ts:110-131, whose decline idiom this
 * refines).
 *
 * Discipline: register the response waiter BEFORE the fresh-boot `goto`
 * (the inventory fetch fires at mount, seconds ahead of the harness/WS
 * waits), then branch on the OBSERVED response instead of the server kind —
 * both servers answer the fetch (legacy 404), so no leg pays a blind
 * panel-poll, and a rust offer that renders slowly (f3wp: >10 s under load)
 * is still caught: `recoverable: true` on the wire is followed by a strict
 * panel-visibility assertion before the decline click. Only FIRST boots need
 * this: reloads have a persisted layout (D1 suppresses), and a decisive
 * decline records dismissal + clears the pending offer.
 */
async function declineRecoveryOfferIfMade(
  page: Page,
  inventoryResponse: Promise<Response | null>,
): Promise<void> {
  const response = await inventoryResponse
  if (!response || !response.ok()) return
  const inventory = await response.json().catch(() => null) as { recoverable?: boolean } | null
  if (inventory?.recoverable !== true) return
  const panel = page.getByTestId('recovery-offer-panel')
  await expect(panel).toBeVisible({ timeout: 30_000 })
  await page.getByTestId('recovery-decline').click()
  await expect(panel).toHaveCount(0)
}

/** Register the inventory waiter, then perform a fresh-context boot. */
async function bootFreshPage(
  page: Page,
  info: { baseUrl: string; token: string },
): Promise<TestHarness> {
  const inventoryResponse = page.waitForResponse(
    (r) => r.url().includes('/api/recovery/inventory'),
    { timeout: 30_000 },
  ).catch(() => null)
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  await declineRecoveryOfferIfMade(page, inventoryResponse)
  return harness
}

/**
 * The History color gesture. `input[type=color]` receives no `fill()` support
 * guarantees, so set the value through the native setter (React's
 * valueTracker bookkeeping) and dispatch a bubbling `input` event — that is
 * what React's `onChange` listens for on this input, and the handler PUTs
 * `/api/project-colors` (`HistoryView.tsx`).
 */
async function pickProjectColor(page: Page, projectPath: string, hex: string): Promise<void> {
  const header = page.locator(`[data-project-path="${projectPath}"]`)
  await header.click() // expand the project
  await page.getByRole('button', { name: 'Open color picker' }).click()
  const input = page.getByLabel('Project color picker')
  await input.evaluate((el, value) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  }, hex)
}

test.describe('SESSION-05 project colors (History project headers)', () => {
  test.setTimeout(120_000)

  test('color set in one browser renders in two contexts, persists across reload and restart, and leaves other projects unchanged', async ({ browser, page, e2eServerKind }) => {
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        setupHome: async (homeDir) => {
          const projectsDir = path.join(homeDir, '.claude', 'projects')
          const alphaDir = path.join(projectsDir, 'tmp-freshell-pcolors-alpha-project')
          await fs.mkdir(alphaDir, { recursive: true })
          await fs.writeFile(
            path.join(alphaDir, `${ALPHA_SESSION_ID}.jsonl`),
            buildSessionJsonl({
              sessionId: ALPHA_SESSION_ID,
              cwd: ALPHA_PROJECT,
              title: 'session-05 alpha',
            }),
          )
          const betaDir = path.join(projectsDir, 'tmp-freshell-pcolors-beta-project')
          await fs.mkdir(betaDir, { recursive: true })
          await fs.writeFile(
            path.join(betaDir, `${BETA_SESSION_ID}.jsonl`),
            buildSessionJsonl({
              sessionId: BETA_SESSION_ID,
              cwd: BETA_PROJECT,
              title: 'session-05 beta',
            }),
          )
          await fs.mkdir(ALPHA_PROJECT, { recursive: true })
          await fs.mkdir(BETA_PROJECT, { recursive: true })
        },
      },
    })
    const info = await server.start()

    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()

    try {
      // --- Context A + Context B both open, both on the History (Projects)
      // view, BEFORE any color is set: both swatches show the default. ---
      // Both are FRESH boots (the only boots the rust RecoveryOfferPanel can
      // appear on — see declineRecoveryOfferIfMade's doc block).
      const harnessA = await bootFreshPage(page, info)
      await openHistoryView(page)

      const harnessB = await bootFreshPage(pageB, info)
      await openHistoryView(pageB)

      await expect(headerSwatch(page, ALPHA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)
      await expect(headerSwatch(pageB, ALPHA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)

      // --- Context A performs the real color gesture. ---
      await pickProjectColor(page, ALPHA_PROJECT, PICKED_COLOR_HEX)

      // Context A (the actor; its own PUT then local refresh): swatch updates.
      await expect(headerSwatch(page, ALPHA_PROJECT)).toHaveCSS('background-color', PICKED_COLOR_RGB)

      // Context B (NO local action — update arrives only via the
      // sessions.changed broadcast → refetch → overlay path).
      await expect(headerSwatch(pageB, ALPHA_PROJECT)).toHaveCSS('background-color', PICKED_COLOR_RGB, { timeout: 20_000 })

      // The unrelated project keeps the default in BOTH contexts.
      await expect(headerSwatch(page, BETA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)
      await expect(headerSwatch(pageB, BETA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)

      // --- Persistence: the isolated config carries exactly one entry. ---
      const config = JSON.parse(
        await fs.readFile(path.join(info.homeDir, '.freshell', 'config.json'), 'utf8'),
      ) as { projectColors?: Record<string, string> }
      expect(config.projectColors).toEqual({ [ALPHA_PROJECT]: PICKED_COLOR_HEX })

      // --- Reload both contexts: the color survives a full client reboot. ---
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harnessA.waitForHarness()
      await harnessA.waitForConnection()
      await openHistoryView(page)
      await expect(headerSwatch(page, ALPHA_PROJECT)).toHaveCSS('background-color', PICKED_COLOR_RGB)

      await pageB.reload({ waitUntil: 'domcontentloaded' })
      await harnessB.waitForHarness()
      await harnessB.waitForConnection()
      await openHistoryView(pageB)
      await expect(headerSwatch(pageB, ALPHA_PROJECT)).toHaveCSS('background-color', PICKED_COLOR_RGB)
      await expect(headerSwatch(pageB, BETA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)

      // --- Full server restart, SAME isolated home: still there. ---
      if (!server.restart) {
        throw new Error(`${e2eServerKind} E2eServerHandle does not implement restart()`)
      }
      await server.restart()
      await expect(async () => {
        const status = await page.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }).toPass({ timeout: 30_000 })
      const statusB = async () => {
        const status = await pageB.evaluate(() => window.__FRESHELL_TEST_HARNESS__?.getWsReadyState())
        expect(status).toBe('ready')
      }
      await expect(statusB).toPass({ timeout: 30_000 })

      await openHistoryView(page)
      await expect(headerSwatch(page, ALPHA_PROJECT)).toHaveCSS('background-color', PICKED_COLOR_RGB)
      await expect(headerSwatch(page, BETA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)

      await openHistoryView(pageB)
      await expect(headerSwatch(pageB, ALPHA_PROJECT)).toHaveCSS('background-color', PICKED_COLOR_RGB)
      await expect(headerSwatch(pageB, BETA_PROJECT)).toHaveCSS('background-color', DEFAULT_COLOR_RGB)
    } finally {
      await contextB.close().catch(() => {})
      await server.stop().catch(() => {})
    }
  })
})
