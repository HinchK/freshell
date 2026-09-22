/**
 * WEDGE-BACKSTOP (Task 5) — terminal-mode wedged-agent detection, end to
 * end with a real Rust server + real browser
 * (docs/plans/2026-09-21-wedge-backstop.md — acceptance proof of the User
 * Request: a running agent-mode terminal whose PTY output is a pure
 * repaint loop surfaces the amber "Agent appears stuck" card with
 * kill/restart actions).
 *
 * The fake `opencode` shim is WRITTEN BY THE SPEC into its throwaway shared
 * root (never a repo file) and emits the REAL animation shape Task 1's
 * classifier fixture pinned (crates/freshell-terminal/src/idle_noise.rs,
 * opencode_tui_gradient_bar_spinner_cycle_is_noise_after_first_sweep): per
 * repaint unit, cursor-hide + braille spinner cell / 8-cell gradient bar
 * sweep (14 distinct compositions cycling), ~10 units/s, ignoring stdin.
 * After the first sweep every frame is ring-known repaint noise — exactly
 * the eternal-spinner zombie class the backstop exists for.
 *
 * Cadence recipe (HARNESS-14, NOT wall-clock bounds): boot with
 * FRESHELL_TEST_CLOCK=1 (mounts the /api/test-clock verbs behind
 * x-auth-token, drops the stuck sweep to 250ms ticks) +
 * FRESHELL_TERMINAL_STUCK_WINDOW_MS=4000; ring-warm from an OBSERVED
 * start — poll the pane's xterm buffer for the shim's spinner cell (its
 * presence proves the full 14-composition cycle already first-occurred,
 * so the noise ring is warm regardless of pane-boot lag) — then a ~2s
 * REAL-time window with the false-start assertion (freeze-after-quiet
 * discipline — frames landing after an advance would re-stamp the
 * meaningful clock at the advanced instant, so the ring must be warmed
 * BEFORE freezing), then POST /api/test-clock/freeze + POST
 * /api/test-clock/advance {"ms":5000} (window + 1000 margin), then poll
 * the alert with a ~5s bound. The
 * kill/ack/created restart round runs on REAL ws time — the virtual clock
 * stays frozen and cannot interfere (a row created at a frozen instant can
 * never age past the window, so the recovered pane deterministically stays
 * unflagged).
 *
 * Fixture recipe (LB-9, mirrors opencode-terminal-restore-rust.spec.ts:157-216):
 * installFakeCli → OPENCODE_CMD pointing at the ABSOLUTE shim path (the
 * env override wins over the extension manifest's `command: "opencode"`),
 * enabledProviders seeded in the isolated HOME config so the picker offers
 * opencode panes.
 *
 * Rust-only: the registry sweep, the stuck monitor, and the
 * stuck-recovery kill branch live in the Rust server. Each test owns one
 * RustServer rig (ephemeral loopback port — NEVER 3001/3002) and tears it
 * down with server.stop() + fs.rm(sharedRoot) in finally.
 */
import { createFreshE2ePage, test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import type { Browser, BrowserContext, Page } from '@playwright/test'
import { RustServer, ensureRustServerBuilt } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

/** Deterministic stuck window: 4s of MEANINGFUL silence (while raw output
 *  keeps flowing) flags an agent pane. The 5000ms advance crosses it with
 *  1s of margin even from a zero-staleness freeze (the observed warm-up
 *  start proves the ring is already warm before the freeze, so no
 *  first-occurrence frame can land post-advance). */
const STUCK_WINDOW_MS = 4_000
const STUCK_ADVANCE_MS = 5_000

/**
 * The scratch fake `opencode` TUI (written into the rig's shared root and
 * pointed at by OPENCODE_CMD). Byte-faithful to Task 1's real-capture
 * fixture shapes: each unit hides the cursor, repaints the 8-cell gradient
 * bar (■ U+25A0 / ⬝ U+2B1D — the only significant chars) with per-cell SGR
 * colors, and parks the cursor; a braille spinner unit (zero significant
 * chars) rides the sweep. String.raw keeps every escape literal in the
 * written file; the shim source deliberately contains no template-literal
 * `${` interpolation of its own.
 *
 * Behavior selection via env (inherited through the server's PTY spawn):
 *   FAKE_OPENCODE_STUCK_MODE=meaningful — genuinely-new text lines every
 *     250ms (the healthy pane; digits are STRIPPED from noise fingerprints,
 *     so every line varies in LETTERS to stay ring-new forever).
 *   FAKE_OPENCODE_PHASE2_MS=<ms>        — wedge mode: after <ms> of REAL
 *     runtime, switch to distinct meaningful lines (the unstuck driver).
 */
const WEDGE_SHIM_SOURCE = String.raw`#!/usr/bin/env node
// Scratch fake 'opencode' TUI for the terminal-stuck (wedge-backstop) e2e.
// Written by terminal-stuck-rust.spec.ts; never a repo file.
const DIM = '\x1b[38;2;36;57;86m\x1b[48;2;10;10;10m'
const BRIGHT = '\x1b[38;2;92;156;245m\x1b[48;2;10;10;10m'
const PARK = '\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h'
function unit(cells) { return '\x1b[?25l\x1b[38;4H' + cells + PARK }
const compositions = []
for (let n = 0; n < 8; n++) compositions.push(unit(DIM + '⬝'.repeat(n) + '\x1b[0m' + BRIGHT + '■'.repeat(8 - n)))
for (let n = 1; n < 7; n++) compositions.push(unit(BRIGHT + '■'.repeat(n) + '\x1b[0m' + DIM + '⬝'.repeat(8 - n)))
const SPINNER = '\x1b[?25l\x1b[6;6H\x1b[38;2;128;128;128m\x1b[48;2;10;10;10m⠦\x1b[0m\x1b[0m\x1b[34;6H\x1b[?25h'

// Base-26 counter spelling: every "meaningful" line differs in LETTERS
// (digits are stripped from noise fingerprints), so lines stay ring-new.
function letters(n) {
  let s = ''
  do { s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26) } while (n > 0)
  return s
}

const out = (s) => process.stdout.write(s)
out('opencode v9.9.9 wedge-shim booted\r\n')
const mode = process.env.FAKE_OPENCODE_STUCK_MODE || 'wedge'
const phase2Ms = Number(process.env.FAKE_OPENCODE_PHASE2_MS || '0')
const started = Date.now()
let i = 0
if (mode === 'meaningful') {
  setInterval(() => { out('progress ' + letters(i++) + ': module batch compiled ok\r\n') }, 250)
} else {
  setInterval(() => {
    if (phase2Ms > 0 && Date.now() - started >= phase2Ms) {
      out('recovered ' + letters(i++) + ': worker heartbeat resumed ok\r\n')
      return
    }
    // ~10 units/s; the braille spinner unit rides the sweep as in the real
    // capture and is noise even on first sight (zero significant chars).
    out(i % 15 === 14 ? SPINNER : compositions[i % 14])
    i++
  }, 100)
}
process.stdin.resume()
`

/** Install the shim as an executable named `opencode`; returns the ABSOLUTE
 *  path OPENCODE_CMD must point at (same copy-then-chmod shape as the
 *  sibling specs' installFakeCli, but writing the source inline — the plan
 *  pins this as a spec-owned scratch fixture, not a repo file). */
async function installWedgeOpencodeShim(binDir: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, 'opencode')
  await fs.writeFile(target, WEDGE_SHIM_SOURCE, 'utf8')
  await fs.chmod(target, 0o755)
  return target
}

/** Seed the isolated HOME config so the picker offers opencode panes
 *  (mirrors opencode-terminal-restore-rust.spec.ts's enabledProviders seed:
 *  PanePicker only renders a CLI option when availableClis + enabledProviders
 *  both agree). */
function seedOpencodeEnabledConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        { version: 1, settings: { codingCli: { enabledProviders: ['opencode'] } } },
        null,
        2,
      ),
    )
  }
}

function clockHeaders(info: E2eServerInfo) {
  return { 'x-auth-token': info.token, 'content-type': 'application/json' }
}

async function clockFreeze(info: E2eServerInfo): Promise<void> {
  const res = await fetch(`${info.baseUrl}/api/test-clock/freeze`, {
    method: 'POST',
    headers: clockHeaders(info),
  })
  expect(res.status, 'POST /api/test-clock/freeze').toBe(200)
}

async function clockAdvance(info: E2eServerInfo, ms: number): Promise<void> {
  const res = await fetch(`${info.baseUrl}/api/test-clock/advance`, {
    method: 'POST',
    headers: clockHeaders(info),
    body: JSON.stringify({ ms }),
  })
  expect(res.status, 'POST /api/test-clock/advance').toBe(200)
}

/** The wedge-backstop card (role=alert, TerminalStuckCard.tsx). */
function stuckAlert(page: Page) {
  return page.getByRole('alert').filter({ hasText: /appears stuck/i })
}

function restartAgentButton(page: Page) {
  return page.getByRole('button', { name: /restart the opencode agent/i })
}

/** Donor: agent-crash-autoresume-rust.spec.ts:73 (a live shell terminal's
 *  cwd pre-fills the Starting-directory combobox the opencode pane create
 *  below depends on). */
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

/** Donor: agent-crash-autoresume-rust.spec.ts:122 */
async function connect(page: Page, info: { baseUrl: string; token: string }): Promise<TestHarness> {
  await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return harness
}

/** Donor: opencode-terminal-restore-rust.spec.ts:110 — open a NEW pane via
 *  the picker and select the OpenCode provider, accepting the pre-filled
 *  Starting-directory with Enter. */
async function openOpencodePane(page: Page): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
}

/** Flatten a pane layout tree into its leaf nodes. */
function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

function findOpencodeLeaves(layout: any): any[] {
  return collectLeaves(layout).filter((leaf) => leaf?.content?.mode === 'opencode')
}

/** Donor: opencode-terminal-restore-rust.spec.ts:135 — open a fresh opencode
 *  pane (splitting the current terminal) and return the NEWLY-added leaf,
 *  identified by diffing the opencode leaf set before vs after. */
async function openOpencodePaneAndGetLeaf(
  page: Page,
  harness: TestHarness,
  tabId: string,
): Promise<any> {
  const before = findOpencodeLeaves(await harness.getPaneLayout(tabId))
  const beforeIds = new Set(before.map((leaf) => leaf.id))
  await openOpencodePane(page)
  await expect(page.locator('.xterm').last()).toBeVisible({ timeout: 15_000 })
  await expect.poll(async () => {
    const layout = await harness.getPaneLayout(tabId)
    const newLeaf = findOpencodeLeaves(layout).find((leaf) => !beforeIds.has(leaf.id))
    return newLeaf?.content?.terminalId ? newLeaf : null
  }, { timeout: 15_000 }).not.toBeNull()
  const layout = await harness.getPaneLayout(tabId)
  const leaf = findOpencodeLeaves(layout).find((l) => !beforeIds.has(l.id))
  expect(leaf?.content?.terminalId, 'the new opencode pane holds a terminalId').toBeTruthy()
  return leaf
}

/** Re-read the (possibly reshuffled) leaf for a given pane id. */
async function findLeafById(harness: TestHarness, tabId: string, paneId: string): Promise<any> {
  const layout = await harness.getPaneLayout(tabId)
  return collectLeaves(layout).find((leaf) => leaf.id === paneId)
}

/** The client-side fold of the `terminal.stuck` broadcast
 *  (terminalLifecycleSlice.stuckAtByPaneId, keyed by paneId). */
async function stuckEntryOf(harness: TestHarness, paneId: string): Promise<any> {
  const state = await harness.getState()
  return state?.terminalLifecycle?.stuckAtByPaneId?.[paneId] ?? null
}

/** OBSERVED ring-warm start (Task-5 review Minor-1): poll the pane's
 *  xterm buffer for deterministic evidence that the shim's frames are
 *  actually flowing BEFORE the fixed warm-up window begins, so pane-boot
 *  lag can never eat the warm-up margin (which could leave the ring
 *  under-warmed at the freeze and let a first-occurrence frame land
 *  post-advance, re-stamping the meaningful clock and delaying the flag
 *  by a full window past the 5s alert poll).
 *
 *  Wedge needle (⠦): the shim paints the braille spinner cell once every
 *  15 frames and nothing ever overwrites it (bar units repaint only the
 *  bar row), so its presence proves ≥15 consecutive frames were INGESTED
 *  in PTY order — the first 14 are the complete bar-composition cycle,
 *  so at this observed start the noise ring is provably FULLY WARM and
 *  the meaningful clock was stamped by the immediately-preceding
 *  first-occurrence frame (~one frame interval ago).
 *  Meaningful needle ('progress '): the live meaningful frame stream
 *  itself (every line re-stamps the meaningful clock). */
async function waitForObservedFrames(
  harness: TestHarness,
  terminalId: string,
  needle: string,
): Promise<void> {
  await expect.poll(async () => {
    const buffer = await harness.getTerminalBuffer(terminalId)
    return typeof buffer === 'string' && buffer.includes(needle)
  }, { timeout: 15_000 }).toBe(true)
}

/**
 * One owned server per rig: each test needs a different shim behavior env,
 * and the gated clock + window must be scoped to the test's own server.
 */
interface Rig {
  root: string
  server: RustServer
  info: E2eServerInfo
}

async function bootRig(prefix: string, shimEnv: Record<string, string>): Promise<Rig> {
  ensureRustServerBuilt()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `terminal-stuck-e2e-${prefix}-`))
  const shimPath = await installWedgeOpencodeShim(path.join(root, 'bin'))
  const server = new RustServer({
    env: {
      OPENCODE_CMD: shimPath,
      // HARNESS-14 gated clock: mounts the /api/test-clock verbs and drops
      // the stuck sweep cadence to 250ms (the sweep still ticks on real
      // time; only the threshold math follows the virtual clock).
      FRESHELL_TEST_CLOCK: '1',
      FRESHELL_TERMINAL_STUCK_WINDOW_MS: String(STUCK_WINDOW_MS),
      ...shimEnv,
    },
    setupHome: seedOpencodeEnabledConfig(),
  })
  const info = await server.start()
  return { root, server, info }
}

interface RigPage {
  rig: Rig
  context: BrowserContext
  page: Page
}

async function bootRigPage(
  browser: Browser,
  prefix: string,
  shimEnv: Record<string, string>,
): Promise<RigPage> {
  const rig = await bootRig(prefix, shimEnv)
  try {
    const { context, page } = await createFreshE2ePage(browser, rig.info)
    return { rig, context, page }
  } catch (error) {
    await teardownRig(rig)
    throw error
  }
}

async function teardownRig(rig: Rig | undefined): Promise<void> {
  await rig?.server.stop().catch(() => {})
  if (rig?.root) await fs.rm(rig.root, { recursive: true, force: true }).catch(() => {})
}

async function teardownRigPage(rigPage: RigPage | undefined): Promise<void> {
  await rigPage?.context.close().catch(() => {})
  await teardownRig(rigPage?.rig)
}

test.describe('terminal stuck backstop (rust only)', () => {
  // Pay any cold cargo release build inside a generous HOOK timeout, not a
  // test timeout (donor: agent-crash-autoresume-rust.spec.ts's beforeAll).
  test.beforeAll(async () => {
    test.setTimeout(1_200_000)
    ensureRustServerBuilt()
  })

  test('wedged agent pane surfaces the stuck card, restart recovers it', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      rigPage = await bootRigPage(browser, 'wedge', { FAKE_OPENCODE_STUCK_MODE: 'wedge' })
      const { rig, page } = rigPage
      const harness = await connect(page, rig.info)
      await selectShellIfPickerShowing(page)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const paneId: string = leaf.id
      const terminalId: string = leaf.content.terminalId

      // The shim spawned: its boot banner proves the pane's PTY is the
      // wedge shim (terminal.created + buffer evidence).
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('wedge-shim booted')
      }, { timeout: 15_000 }).toBe(true)

      // OBSERVED ring-warm start: the spinner cell proves the full
      // 14-composition cycle already first-occurred (frames ingest in PTY
      // order and the spinner is the 15th frame), so the noise ring is
      // fully warm and the meaningful clock is freshly stamped at this
      // observed start — regardless of how long pane boot lagged.
      await waitForObservedFrames(harness, terminalId, '⠦')

      // Ring-warm ~2s from the OBSERVED start, in REAL time
      // (freeze-after-quiet): every frame from here on is ring-known
      // noise — the MEANINGFUL clock stops advancing while raw output
      // keeps flowing. False-start bound: an animated pane UNDER the
      // window must NOT flag (at the freeze the last first-occurrence was
      // ~2s ago, well inside the 4s window), so the card cannot
      // legitimately appear yet — assert it hasn't.
      await page.waitForTimeout(1_000)
      await expect(stuckAlert(page), 'under-window mid-warm check').toHaveCount(0)
      await page.waitForTimeout(1_000)
      await expect(stuckAlert(page), 'false-start bound: an animated but under-window pane must not flag').toHaveCount(0)

      // Freeze-after-quiet, then step 5s past the 4s window: the continuing
      // repaint frames re-stamp ONLY the raw-activity clock (at the frozen
      // instant), so the two-clock differential the backstop keys on is
      // exact: meaningful-stale beyond the window + activity-fresh.
      await clockFreeze(rig.info)
      await clockAdvance(rig.info, STUCK_ADVANCE_MS)

      // The card surfaces within ~one gated 250ms sweep tick + broadcast +
      // ws fold (poll bound 5s).
      await expect(stuckAlert(page)).toBeVisible({ timeout: 5_000 })
      await expect(restartAgentButton(page)).toBeVisible()
      // ...and the client folded the flag for the OWNING pane (the store
      // entry carries the flagged terminalId — the stale-flag adoption
      // contract).
      await expect.poll(async () => await stuckEntryOf(harness, paneId), { timeout: 5_000 }).not.toBeNull()
      const entry = await stuckEntryOf(harness, paneId)
      expect(entry.terminalId).toBe(terminalId)

      // Restart: the card's action runs the kill (reason:'stuck-recovery'
      // — the durable session stays resumable; the ledger close envelope and
      // identity retirement are skipped) → correlated terminal.killed →
      // reconcile reset → fresh terminal.created. The round runs on REAL ws
      // time (the clock stays frozen and cannot interfere).
      await restartAgentButton(page).click()

      await expect.poll(async () => {
        const after = await findLeafById(harness, tabId!, paneId)
        return after?.content?.status === 'running'
          && typeof after?.content?.terminalId === 'string'
          && after.content.terminalId !== terminalId
      }, { timeout: 30_000 }).toBe(true)

      const after = await findLeafById(harness, tabId!, paneId)
      const newTerminalId: string = after.content.terminalId
      // The respawned PTY is genuinely the shim again (a live terminal, not
      // a dead pane).
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(newTerminalId)
        return typeof buffer === 'string' && buffer.includes('wedge-shim booted')
      }, { timeout: 15_000 }).toBe(true)

      // Card gone: no stuck alert anywhere, no alert surfaces at all, and
      // the store entry was cleared (the kill's clearTerminalLifecycle +
      // the created fold's clear-on-adoption).
      await expect(stuckAlert(page)).toHaveCount(0)
      await expect(page.getByRole('alert')).toHaveCount(0)
      await expect.poll(async () => await stuckEntryOf(harness, paneId), { timeout: 5_000 }).toBeNull()
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('a pane emitting meaningful output never shows the card', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      rigPage = await bootRigPage(browser, 'meaningful', { FAKE_OPENCODE_STUCK_MODE: 'meaningful' })
      const { rig, page } = rigPage
      const harness = await connect(page, rig.info)
      await selectShellIfPickerShowing(page)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const paneId: string = leaf.id
      const terminalId: string = leaf.content.terminalId

      // OBSERVED start: a `progress ` line proves the meaningful frame
      // stream is flowing (every line re-stamps the MEANINGFUL clock at
      // its arrival instant, so this pane can never go meaningful-stale).
      await waitForObservedFrames(harness, terminalId, 'progress ')

      // Warm-up window from the OBSERVED start: real time, live clock,
      // and no card during it.
      await page.waitForTimeout(2_000)
      await expect(stuckAlert(page), 'warm-up must not flag a healthy pane').toHaveCount(0)

      // SAME freeze + advance past the window — then the load-bearing
      // assertion: the shim keeps printing genuinely-new lines, each
      // re-stamping the MEANINGFUL clock at the advanced instant, so the
      // sweep can never see meaningful-staleness. Give the sweep ample
      // ticks (5s real ≈ 20 gated sweeps) before asserting the negative.
      await clockFreeze(rig.info)
      await clockAdvance(rig.info, STUCK_ADVANCE_MS)
      await page.waitForTimeout(5_000)
      await expect(stuckAlert(page), 'a pane with fresh meaningful output must never flag').toHaveCount(0)
      expect(await stuckEntryOf(harness, paneId)).toBeNull()
      // The pane itself is unaffected: still the same running terminal.
      const after = await findLeafById(harness, tabId!, paneId)
      expect(after?.content?.status).toBe('running')
      expect(after?.content?.terminalId).toBe(terminalId)
    } finally {
      await teardownRigPage(rigPage)
    }
  })

  test('unstuck transition removes the card while the terminal keeps running', async ({ browser }) => {
    test.setTimeout(240_000)
    let rigPage: RigPage | undefined
    try {
      // Wedge shim that RESUMES meaningful output at ~15s of its own runtime
      // (generous margin over the plan's ~6s so cloud-lane choreography
      // before the freeze can never race the phase switch; the observed
      // card window stays several seconds wide either way).
      rigPage = await bootRigPage(browser, 'unstuck', {
        FAKE_OPENCODE_STUCK_MODE: 'wedge',
        FAKE_OPENCODE_PHASE2_MS: '15000',
      })
      const { rig, page } = rigPage
      const harness = await connect(page, rig.info)
      await selectShellIfPickerShowing(page)
      const tabId = await harness.getActiveTabId()
      expect(tabId).toBeTruthy()

      const leaf = await openOpencodePaneAndGetLeaf(page, harness, tabId!)
      const paneId: string = leaf.id
      const terminalId: string = leaf.content.terminalId

      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('wedge-shim booted')
      }, { timeout: 15_000 }).toBe(true)

      // OBSERVED ring-warm start (same spinner proof as the wedged-pane
      // test), then the same warm-up + freeze + advance: the card appears
      // deterministically right after the advance.
      await waitForObservedFrames(harness, terminalId, '⠦')
      await page.waitForTimeout(2_000)
      await expect(stuckAlert(page), 'false-start bound before the freeze').toHaveCount(0)
      await clockFreeze(rig.info)
      await clockAdvance(rig.info, STUCK_ADVANCE_MS)
      await expect(stuckAlert(page), 'the wedged pane flags first').toBeVisible({ timeout: 5_000 })

      // The shim switches to genuinely-new lines at ~15s of its runtime; the
      // next ingest re-stamps the MEANINGFUL clock, the next sweep emits
      // stuck:false, and the card disappears — with NO kill: the pane keeps
      // the SAME running terminal throughout.
      await expect(stuckAlert(page), 'meaningful output must clear the flag').toHaveCount(0, { timeout: 20_000 })
      const after = await findLeafById(harness, tabId!, paneId)
      expect(after?.content?.status, 'the terminal keeps running through the unstuck transition').toBe('running')
      expect(after?.content?.terminalId, 'no kill happened — same terminal').toBe(terminalId)
      expect(await stuckEntryOf(harness, paneId)).toBeNull()
      await expect.poll(async () => {
        const buffer = await harness.getTerminalBuffer(terminalId)
        return typeof buffer === 'string' && buffer.includes('recovered ')
      }, { timeout: 5_000 }).toBe(true)
    } finally {
      await teardownRigPage(rigPage)
    }
  })
})
