/**
 * MISSED-OWNER-BROADCAST STALE-REFUSAL HEAL (the-usual delta round 6, the
 * round-5 Major) — the browser-level proof of the typed stale-fence
 * refusal healing against the REAL Rust server + REAL SPA.
 *
 * WHAT IT STAGES: device A holds a codex terminal pane on a killed
 * session. Device B reopens the same durable session on ITS side; A never
 * folds B's commit-to-Live owner broadcast (the default-off test-only
 * seam `?__freshellFreezeFence=1` drops exactly that frame class on A's
 * page — src/lib/owner-fence-freeze-seam.ts). A's user clicks the pane's
 * surfaced Reopen affordance; the recovery-create carries A's STALE
 * observed (epoch, generation) pair and the server REFUSES it typed.
 * The refusal's CURRENT pair folds into A's runtimeOwners fence (observed
 * directly in the browser store AND proven by the server's own telemetry),
 * and the very next ownership claim — the branch's designed continuation,
 * the reconcile-driven attach onto B's live terminal, whose wire attach
 * re-reads the fence at send time — carries the FRESH pair and converges
 * A's pane (a terminalId new to the pane, the resumed marker, an input
 * round-trip) with NO page reload on either device.
 *
 * WHY THE SEAM (Path B; the Path A offline window is unstageable): every
 * (re)connect resets and re-folds the server's authoritative
 * runtimeOwners ready-replay (src/lib/fresh-agent-ws.ts
 * foldReadyRuntimeOwners ← App's ready handler; the server builds it from
 * ownership.snapshot_records() on EVERY handshake — crates/freshell-ws/
 * src/lib.rs build_handshake_with_capabilities), so a client that was
 * offline across the kill+reopen converges its fence on reconnect. A
 * CONNECTED client folds the commit broadcast AND auto-adopts the new
 * same-kind terminal owner (TerminalView's same-kind convergence effect)
 * — three independent automatic healings close every connected/offline
 * window. The only real stale-pair condition left is the in-flight race
 * (the pair advances between the pane's send-time fence read and the
 * server's claim adjudication), which cannot be staged deterministically
 * from a browser; the seam manufactures exactly that race's client-side
 * state (stale pair over an otherwise-current owner record) by dropping
 * the one frame whose pair A would have folded.
 *
 * WHY NO INTER-CLICK NEGATIVE POLL / NO SECOND USER CLICK (the honest
 * deviation from the round-5 sketch, recorded in the fix report): the
 * branch's create-refusal FAST PATH (TerminalView's
 * resolveReserveExhaustionViaReconcile arm — "a stale-observed-generation
 * refusal carrying the pair PROVES the request's own pair can never win a
 * re-drive — abandon the request to the reconcile flow") hands the
 * refused create to a single pane.reconcile.request whose verdict for a
 * live owner is Attach (crates/freshell-ws/src/reconcile.rs
 * live_terminal_for_claimed_ref) — the reconciliation IS the designed next
 * claim, and its wire attach carries the freshly folded pair (a stale
 * pair would be refused by the attach guard —
 * ownership.attach_guard.refused/STALE_GENERATION; this spec asserts zero
 * such rows). The negative poll is staged on what "no new terminal"
 * means for a refused claim: NO new PTY is ever minted (the fake's spawn
 * ledger stays frozen across the whole A-side healing) and NO
 * terminal.created ever answers A's createRequestId — while the server's
 * own stale-refusal telemetry (ownership.begin_start.stale_generation,
 * observed_generation < generation) proves the claim was refused typed.
 *
 * Rust-only lane (real Rust server): Chromium-local; cloud-legal by
 * design (fake CLI only — never added to CLOUD_SKIP_SPECS).
 *
 * Helpers are copied, not imported, per the e2e suite's per-spec-ownership
 * convention (donors: handoff-two-device-rust.spec.ts — the fence-heal
 * cross-device test B is this spec's closest sibling).
 */
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import type { E2eServerInfo } from '../helpers/server-fixture-support.js'
import { TestHarness } from '../helpers/test-harness.js'
import { installRecoveryOfferAutoDeclineOnContext } from '../helpers/recovery-offer.js'
import { installDualRoleCodexCli } from '../fixtures/codex-dual-role.js'
import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, BrowserContext, Page } from '@playwright/test'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const FAKE_CODEX_TERMINAL = path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs')

const CODEX_SESSION_ID = '21000000-aaaa-4bbb-8ccc-000000000043'
const SESSION_TITLE = 'missed-broadcast stale-refusal codex session'

// ---------------------------------------------------------------------------
// Copied helpers (per-spec copies — donors: handoff-two-device-rust.spec.ts)
// ---------------------------------------------------------------------------

/** Read a JSONL log as parsed rows ([] when absent/unparseable). */
function readJsonl(filePath: string): any[] {
  if (!existsSync(filePath)) return []
  return readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((row) => row !== null)
}

/** The Rust server's structured JSONL log rows (logging.rs schema). */
function readServerLogRows(info: E2eServerInfo): any[] {
  return readJsonl(path.join(info.logsDir, 'rust-server.jsonl'))
}

/** Poll the server's structured log until a row matches `pred`. */
async function waitForServerLogRow(
  info: E2eServerInfo,
  pred: (row: any) => boolean,
  what: string,
  timeoutMs = 20_000,
): Promise<any> {
  let found: any = null
  await expect
    .poll(
      () => {
        found = readServerLogRows(info).find(pred) ?? null
        return Boolean(found)
      },
      { timeout: timeoutMs, message: `timed out waiting for ${what} in the server log` },
    )
    .toBe(true)
  return found
}

/** The fake codex terminal's spawn argv log rows — ONE row per minted PTY. */
function codexTerminalSpawns(argvLogPath: string): Array<{ pid: number; t: number; argv: string[] }> {
  return readJsonl(argvLogPath)
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

/**
 * Idempotent .freshell/config.json seed (donor: reconcile-completion-rust)
 * plus the codex watch-root pre-creation the mid-test rollout needs.
 */
async function seedSpecConfig(homeDir: string): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  await fs.writeFile(
    path.join(freshellDir, 'config.json'),
    JSON.stringify(
      {
        version: 1,
        settings: {
          codingCli: { enabledProviders: ['codex'] },
        },
      },
      null,
      2,
    ),
  )
  await fs.mkdir(path.join(homeDir, '.codex', 'sessions'), { recursive: true })
}

/**
 * Seed ~/.codex/sessions/<id>.jsonl so both devices' sidebars list a
 * resumable codex TERMINAL session (donor: handoff-two-device-rust's
 * seedFenceHealCodexHome shape): a titled session transcript.
 */
async function seedCodexHome(homeDir: string): Promise<void> {
  await seedSpecConfig(homeDir)
  const codexSessionsDir = path.join(homeDir, '.codex', 'sessions')
  await fs.mkdir(codexSessionsDir, { recursive: true })
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-21T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: CODEX_SESSION_ID, cwd: homeDir },
    }),
    JSON.stringify({
      timestamp: '2026-07-21T08:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${SESSION_TITLE} request 1` }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-21T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `${SESSION_TITLE} reply 1` }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-21T08:00:03.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${SESSION_TITLE} request 2` }],
      },
    }),
  ]
  await fs.writeFile(path.join(codexSessionsDir, `${CODEX_SESSION_ID}.jsonl`), `${lines.join('\n')}\n`)
}

/**
 * A DEVICE: its own BrowserContext (own localStorage ⇒ its own durable
 * device id), with the recovery-offer auto-decline adopted directly.
 */
async function newDeviceContext(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext()
  installRecoveryOfferAutoDeclineOnContext(context)
  return context
}

/**
 * Open one device's page against the owned server and wait for the harness.
 * `freezeFence` arms the default-off test-only seam on THIS page load only
 * (the missed-owner-broadcast condition); `receivedFrames` (optional)
 * captures the page's inbound WS frames for wire-level assertions.
 */
async function openDevicePage(
  context: BrowserContext,
  info: E2eServerInfo,
  opts?: { freezeFence?: boolean; receivedFrames?: Array<Record<string, any>> },
): Promise<{ page: Page; harness: TestHarness }> {
  const page = await context.newPage()
  if (opts?.receivedFrames) {
    const ownedWsOrigin = info.baseUrl.replace(/^http/, 'ws')
    page.on('websocket', (socket) => {
      if (!socket.url().startsWith(ownedWsOrigin)) return
      socket.on('framereceived', ({ payload }) => {
        try {
          const frame = JSON.parse(String(payload))
          if (frame && typeof frame === 'object' && !Array.isArray(frame)) {
            opts.receivedFrames.push(frame as Record<string, any>)
          }
        } catch {
          // Ignore protocol frames that are not JSON.
        }
      })
    })
  }
  await page.goto(
    `${info.baseUrl}/?token=${info.token}&e2e=1`
    + (opts?.freezeFence ? '&__freshellFreezeFence=1' : ''),
  )
  // The server-owned machine registry gates every fresh context's boot —
  // answer the chooser with the real "Add this machine" affordance
  // (best-effort: a dialog that never shows is a no-op).
  const machineChooser = page.getByRole('dialog', { name: 'Choose a machine' })
  await page
    .waitForFunction(
      () =>
        Boolean(
          document.querySelector('[data-testid="sidebar-session-list"]')
            || (document.querySelector('section[role="dialog"]')?.textContent ?? '').includes('Choose a machine'),
        ),
      undefined,
      { timeout: 15_000 },
    )
    .catch(() => {})
  if (await machineChooser.isVisible().catch(() => false)) {
    await page.getByRole('button', { name: 'Add this machine' }).click()
    await machineChooser.waitFor({ state: 'detached', timeout: 20_000 }).catch(() => {})
  }
  const harness = new TestHarness(page)
  await harness.waitForHarness()
  await harness.waitForConnection()
  return { page, harness }
}

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

test.describe('Missed owner broadcast: typed stale-refusal heal (rust only)', () => {
  test.setTimeout(240_000)

  test('the missed reopen commit leaves the pane fence stale; the refused Reopen folds the fresh pair and the next claim heals without a reload', async ({
    browser,
  }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-missed-bcast-'))
    const projectDir = path.join(sharedRoot, 'project')
    await fs.mkdir(projectDir, { recursive: true })
    // Dual-role: the codex terminal lane boots a `codex app-server` sidecar
    // FIRST (PTY_SPAWN_FAILED otherwise), so the fake must answer both
    // app-server argv and terminal argv (codex-dual-role.ts).
    const fakeCodex = await installDualRoleCodexCli(
      path.join(sharedRoot, 'bin'),
      FAKE_CODEX_TERMINAL,
    )
    const termArgvLogPath = path.join(sharedRoot, 'codex-terminal-argv.jsonl')
    const server = new RustServer({
      env: {
        CODEX_CMD: fakeCodex,
        FAKE_CODEX_ARGV_LOG: termArgvLogPath,
      },
      setupHome: seedCodexHome,
    })
    let deviceACtx: BrowserContext | null = null
    let deviceBCtx: BrowserContext | null = null
    try {
      const info = await server.start()
      deviceACtx = await newDeviceContext(browser)
      deviceBCtx = await newDeviceContext(browser)
      // A loads WITH the seam flag (it must miss the reopen's commit
      // broadcast); B loads clean (its own kill + reopen behave normally).
      const aFrames: Array<Record<string, any>> = []
      const deviceA = await openDevicePage(deviceACtx, info, {
        freezeFence: true,
        receivedFrames: aFrames,
      })
      const deviceB = await openDevicePage(deviceBCtx, info)
      expect(await deviceA.page.evaluate(() => localStorage.getItem('freshell.device-id.v2')))
        .not.toBe(await deviceB.page.evaluate(() => localStorage.getItem('freshell.device-id.v2')))

      const sessionRowOn = (page: Page) =>
        page.getByTestId('sidebar-session-list').locator(`[data-session-id="${CODEX_SESSION_ID}"]`)

      await selectShellIfPickerShowing(deviceA.page)
      await selectShellIfPickerShowing(deviceB.page)

      // 1. DEVICE A opens the seeded session from the sidebar — the
      //    terminal-lane resume create commits Live gen N under terminal
      //    T1 (A folds its own committed pair via the terminal.created
      //    trio; the seam only drops the BROADCAST, and A's own create
      //    settles before B exists).
      const aRow = sessionRowOn(deviceA.page)
      await expect(aRow).toBeVisible({ timeout: 15_000 })
      const aTabCountBefore = await deviceA.harness.getTabCount()
      await aRow.click()
      await expect(async () => {
        expect(await deviceA.harness.getTabCount()).toBe(aTabCountBefore + 1)
      }).toPass({ timeout: 15_000 })
      const aTabId = (await deviceA.harness.getActiveTabId())!
      const aPane = () => deviceA.harness.getPaneLayout(aTabId)
      const firstTerminalId: string = await expect
        .poll(async () => (await aPane())?.content?.terminalId ?? null, { timeout: 20_000 })
        .not.toBeNull()
        .then(async () => (await aPane())?.content?.terminalId)
      await expect
        .poll(async () => {
          const buffer = await deviceA.harness.getTerminalBuffer(firstTerminalId)
          return typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        }, { timeout: 30_000 })
        .toContain(`codex: resumed session ${CODEX_SESSION_ID}`)
      const aCreateRequestId = (await aPane())?.content?.createRequestId as string
      expect(aCreateRequestId).toBeTruthy()
      const aCreatedFramesFor = () =>
        aFrames.filter((f) => f.type === 'terminal.created' && f.requestId === aCreateRequestId)

      // 2. DEVICE B opens the SAME session: B's row reports A's running
      //    terminal, routing B's click through the direct-attach arm —
      //    B's pane lands on the SAME terminalId, no respawn.
      const bRow = sessionRowOn(deviceB.page)
      await expect(bRow).toBeVisible({ timeout: 15_000 })
      await expect(bRow).toHaveAttribute('data-is-running', 'true', { timeout: 30_000 })
      await expect(bRow).toHaveAttribute('data-running-terminal-id', firstTerminalId, { timeout: 30_000 })
      const bTabCountBefore = await deviceB.harness.getTabCount()
      await bRow.click()
      await expect(async () => {
        expect(await deviceB.harness.getTabCount()).toBe(bTabCountBefore + 1)
      }).toPass({ timeout: 15_000 })
      const bTabId = (await deviceB.harness.getActiveTabId())!
      await expect
        .poll(async () => (await deviceB.harness.getPaneLayout(bTabId))?.content?.terminalId ?? null, { timeout: 20_000 })
        .toBe(firstTerminalId)

      // 3. DEVICE B KILLS the shared terminal via the REAL kill
      //    affordance: shift-click its tab's CLOSE button. B's tab closes
      //    after the durable-close ack; the kill releases ownership — the
      //    record goes VACANT (the released broadcast; A still folds
      //    released frames under the seam).
      await deviceB.page
        .locator(`[data-context="tab"][data-tab-id="${bTabId}"]`)
        .getByRole('button', { name: /close/i })
        .click({ modifiers: ['Shift'] })
      await expect(async () => {
        expect(await deviceB.harness.getTabCount()).toBe(bTabCountBefore)
      }).toPass({ timeout: 15_000 })

      // 4. A's CONNECTED pane converges to the honest EXITED state with
      //    the killed-session recovery affordance (clean exit + the
      //    folded VACANT record). Without the seam this is where the
      //    story would end — every later owner broadcast would fold and
      //    nothing would ever be stale.
      await expect
        .poll(async () => (await aPane())?.content?.status ?? null, { timeout: 20_000 })
        .toBe('exited')
      await expect
        .poll(async () => (await aPane())?.content?.terminalId ?? null, { timeout: 20_000 })
        .toBe(null)
      const reopenButton = deviceA.page
        .locator(`[data-context="terminal"][data-tab-id="${aTabId}"]`)
        .getByRole('button', { name: 'Reopen codex session' })
      await expect(reopenButton).toBeVisible({ timeout: 15_000 })

      // 5. DEVICE B REOPENS the session from ITS sidebar: B's
      //    resume-create commits Live under B's NEW terminal T2 at a
      //    generation A never observed. The commit-to-Live owner
      //    BROADCAST is dropped on A's page (the seam) — A's pane fence
      //    stays at the vacant release's pair. The not-running wait
      //    guarantees the sidebar click routes through the resume-create
      //    arm (a stale data-is-running row would route the attach arm
      //    at the DEAD terminal instead).
      await expect(bRow).toHaveAttribute('data-is-running', 'false', { timeout: 20_000 })
      const bTabCountAtReopen = await deviceB.harness.getTabCount()
      await sessionRowOn(deviceB.page).click()
      await expect(async () => {
        expect(await deviceB.harness.getTabCount()).toBe(bTabCountAtReopen + 1)
      }).toPass({ timeout: 15_000 })
      const bReopenTabId = (await deviceB.harness.getActiveTabId())!
      const secondTerminalId: string = await expect
        .poll(async () => (await deviceB.harness.getPaneLayout(bReopenTabId))?.content?.terminalId ?? null, { timeout: 30_000 })
        .not.toBeNull()
        .then(async () => (await deviceB.harness.getPaneLayout(bReopenTabId))?.content?.terminalId)
      expect(secondTerminalId).not.toBe(firstTerminalId)
      await expect
        .poll(async () => {
          const buffer = await deviceB.harness.getTerminalBuffer(secondTerminalId)
          return typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        }, { timeout: 30_000 })
        .toContain(`codex: resumed session ${CODEX_SESSION_ID}`)

      // THE SEAM HELD: A's pane did NOT fold B's commit (a connected
      // client without the seam folds it, its same-kind convergence
      // effect auto-adopts T2, and the Reopen affordance vanishes) — the
      // bar is still there and the pane is still exited.
      await expect(reopenButton).toBeVisible({ timeout: 5_000 })
      expect((await aPane())?.content?.status).toBe('exited')
      expect((await aPane())?.content?.terminalId ?? null).toBe(null)

      // The no-reload sentinels (both pages): surviving to the end proves
      // neither device ever needed a reload.
      await deviceA.page.evaluate(() => {
        ;(window as any).__missedBcastNoReloadSentinel = 'a'
      })
      await deviceB.page.evaluate(() => {
        ;(window as any).__missedBcastNoReloadSentinel = 'b'
      })

      // The watermark: exactly TWO codex PTYs ever spawned (A's original
      // resume + B's reopen) and exactly ONE terminal.created answered
      // A's createRequestId (its original anchor).
      const spawnsAtClick = codexTerminalSpawns(termArgvLogPath).length
      expect(spawnsAtClick).toBe(2)
      const createdFramesAtClick = aCreatedFramesFor().length
      expect(createdFramesAtClick).toBe(1)

      // 6. A's USER CLICKS REOPEN. The recovery-create carries the STALE
      //    observed pair and the server REFUSES it typed — the
      //    coordinator's own telemetry proves the refusal AND the
      //    staleness (observed_generation < generation, same epoch).
      await reopenButton.click()
      // The wire create's coordinator claim mints operation ids as
      // `term-create-<requestId>` (crates/freshell-ws/src/terminal.rs's
      // begin_terminal_lane_claim call) — the row is keyed by that, not
      // the bare requestId.
      const refusalRow = await waitForServerLogRow(
        info,
        (row) =>
          row?.event === 'ownership.begin_start.stale_generation'
          && row?.operation_id === `term-create-${aCreateRequestId}`
          && row?.provider === 'codex'
          && row?.session_id === CODEX_SESSION_ID,
        `the typed stale-refusal for A's createRequestId ${aCreateRequestId}`,
      )
      expect(refusalRow.outcome).toBe('refused')
      expect(refusalRow.failure_reason).toBe('STALE_GENERATION')
      expect(refusalRow.observed_epoch).toBe(refusalRow.epoch)
      expect(refusalRow.observed_generation).toBeLessThan(refusalRow.generation)

      // 7. THE FOLD, observed directly in the browser: the refusal's
      //    CURRENT pair entered A's runtimeOwners fence (merge-only — the
      //    record keeps its vacant owner kind).
      await expect
        .poll(
          async () =>
            await deviceA.page.evaluate((sessionId) =>
              (window as any).__FRESHELL_TEST_HARNESS__?.getState?.()?.freshAgent?.runtimeOwners?.[sessionId] ?? null,
            `codex:${CODEX_SESSION_ID}`),
          { timeout: 10_000, message: 'the refusal pair never entered A\'s runtimeOwners fence' },
        )
        .toMatchObject({
          ownerKind: 'vacant',
          epoch: refusalRow.epoch,
          generation: refusalRow.generation,
        })

      // 8. THE BOUNDED NEGATIVE POLL — the refused claim minted NO new
      //    terminal: no new PTY spawn ever answers A's click (the whole
      //    A-side healing is claim-refusal + attach) and no new
      //    terminal.created frame answers A's createRequestId.
      await deviceA.page.waitForTimeout(8_000)
      expect(codexTerminalSpawns(termArgvLogPath)).toHaveLength(spawnsAtClick)
      expect(aCreatedFramesFor()).toHaveLength(createdFramesAtClick)

      // 9. THE NEXT CLAIM HEALS — the branch's designed continuation: the
      //    refused create is handed to the single-pane reconcile whose
      //    Attach verdict points A's pane at B's live terminal; the wire
      //    attach re-reads the fence at send time and carries the FRESH
      //    (folded) pair — a stale pair would have been refused by the
      //    attach's atomic adopt (the fold's behavioral proof: zero
      //    terminal_attach_refused rows for this session, ever).
      await expect
        .poll(async () => (await aPane())?.content?.terminalId ?? null, { timeout: 30_000 })
        .toBe(secondTerminalId)
      await expect
        .poll(async () => (await aPane())?.content?.status ?? null, { timeout: 15_000 })
        .toBe('running')
      expect(
        readServerLogRows(info).filter(
          (row) =>
            row?.session_id === CODEX_SESSION_ID
            && String(row?.msg ?? '').includes('terminal_attach_refused'),
        ),
        'the post-refusal attach armed at the freshly folded pair — a stale pair would have been refused (terminal_attach_refused)',
      ).toHaveLength(0)
      // The convergence attached A's pane onto B's terminal — A's pane
      // streams T2's buffer, which already carries the resumed marker
      // B's create wrote.
      await expect
        .poll(async () => {
          const buffer = await deviceA.harness.getTerminalBuffer(secondTerminalId)
          return typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        }, { timeout: 15_000 })
        .toContain(`codex: resumed session ${CODEX_SESSION_ID}`)

      // 10. An input round-trip on A's pane — the healed pane is live and
      //     typing reaches the shared terminal's PTY.
      await deviceA.page
        .locator(`[data-context="terminal"][data-tab-id="${aTabId}"] .xterm`)
        .first()
        .click()
      await deviceA.page.keyboard.type('missed-bcast-heal')
      await expect
        .poll(async () => {
          const buffer = await deviceA.harness.getTerminalBuffer(secondTerminalId)
          return typeof buffer === 'string' ? buffer.replace(/\n/g, '') : ''
        }, { timeout: 30_000 })
        .toContain('missed-bcast-heal')

      // 11. NO RELOAD, on either device — the entire healing (refusal →
      //     fold → reconcile-attach) happened inside the loaded page.
      expect(await deviceA.page.evaluate(() => (window as any).__missedBcastNoReloadSentinel)).toBe('a')
      expect(await deviceB.page.evaluate(() => (window as any).__missedBcastNoReloadSentinel)).toBe('b')
    } finally {
      await deviceACtx?.close().catch(() => {})
      await deviceBCtx?.close().catch(() => {})
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
