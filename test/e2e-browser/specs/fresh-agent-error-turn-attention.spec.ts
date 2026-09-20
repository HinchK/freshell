// Unified needs-attention e2e — the fresh-agent error-turn contract
// (needs-attention-signal Tasks 1-7).
//
// One binary signal: ANY turn end the user did not witness — finished,
// errored, hit max-turns, crashed, wedged/stuck, or waiting — produces the
// identical tab highlight, sidebar row highlight, and a single bell. A turn
// end the user WAS watching produces the tab-strip-only watched mark, no
// sound, cleared on the next away-and-back. A user-initiated interrupt is
// silent, full stop. This spec drives the deterministic fake claude-SDK
// sidecar (`fixtures/providers/fake-claude-sdk-sidecar.mjs`) end to end —
// composer → Rust server → sidecar → unified `freshAgent.turn.complete` →
// client fold → marks — through every lane of that contract:
//
//   1. an ERRORED turn (error_max_turns) ending in a BACKGROUND tab rings
//      exactly one bell-pipeline event (turnCompletion.seq 1) and marks
//      everything: emerald tab, sidebar row, pane header;
//   2. visiting the tab dismisses the attention (click mode);
//   3. a user-initiated interrupt of an in-flight turn (while watching) is
//      TOTALLY silent — no event, no mark of any kind — and the wire proves
//      the silence is the GATE's doing (the settle + the interrupted turn's
//      non-success sdk.result both arrive; no edge follows them);
//   4. a COMPLETED turn the user watched sets the tab-strip-only watched
//      mark: no bell, no sidebar row, no pane-header mark — and the mark
//      clears on away-and-back;
//   5. an errored turn while the WINDOW is unfocused (user in another app)
//      still folds the edge and sets the attention flag — the bell rings for
//      any tab when the window is unfocused (the sound suppression split is
//      unit-pinned; e2e asserts the fold partition);
//   6. a mid-turn stream exception (sdk.error + the finally-minted edge, NO
//      process exit) rings exactly one edge, resolves the pane to idle, and
//      leaves the sidecar process alive (no unrequested-death double edge).
//
// CLOUD-LEGALITY: everything is driven through the fake's deterministic
// program lanes (`FRESHELL_FAKE_PROGRAM` text-matched rules with bounded
// `delayMs` emissions) — there are NO idle-grace-period or shade-transition
// timing dependencies here (the patterns that put truly-idle-alerting.spec.ts
// itself in CLOUD_SKIP_SPECS). The delayed emissions hand the spec a bounded
// window to move the user's attention (background the tab, blur the window,
// click Stop) BEFORE the scripted turn ends; every wait is a poll on
// observed state, never a fixed sleep on a pipeline. This spec must NOT be
// added to CLOUD_SKIP_SPECS.

import fs from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const CLAUDE_SIDECAR_FIXTURE = path.resolve(__dirname, '../fixtures/providers/fake-claude-sdk-sidecar.mjs')

/**
 * Deterministic fake-sidecar program. The 3s emission delays are the ONLY
 * timing in this spec, and they are lane-controlled (the fake consumes the
 * delay BEFORE the emission fires): each send opens a bounded window in
 * which the spec moves the user's attention, then the scripted turn ends.
 */
const FAKE_PROGRAM = {
  rules: [
    {
      // Errored turn lane: error_max_turns is a turn end like any other.
      on: 'msg:send',
      match: { text: 'ERROR_TURN' },
      emit: [
        {
          kind: 'completion',
          data: { subtype: 'error_max_turns', text: 'Fixture turn hit the turn limit.' },
          delayMs: 3_000,
        },
      ],
    },
    {
      // In-flight interrupt lane: the completion stays pending long enough
      // for the Stop click to land while the turn is provably in flight.
      // The fake's extended interrupt arm then arms the REAL gate, settles
      // ok:true, and this delayed completion renders the interrupted turn's
      // non-success subtype with its ring consumed.
      on: 'msg:send',
      match: { text: 'INTERRUPT_ME' },
      emit: [
        { kind: 'completion', data: { subtype: 'success', text: 'slow fixture turn' }, delayMs: 4_000 },
      ],
    },
    {
      // Mid-turn stream-exception lane (NO process exit): sdk.error + the
      // finally-minted unified edge + session teardown. The sidecar stays
      // alive — the separate `crash` lane (silent process death) belongs to
      // the Rust-synthesis lanes.
      on: 'msg:send',
      match: { text: 'STREAM_ERROR' },
      emit: [{ kind: 'stream-error', delayMs: 3_000 }],
    },
  ],
}

/** Read a JSONL fixture log (the fake's event/wire audit). */
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

test.describe('fresh-agent error-turn attention (unified needs-attention signal)', () => {
  test.setTimeout(180_000)

  test('errored turns ring the unified signal; interrupts are silent; watched endings mark the tab strip only', async ({ page }) => {
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-error-turn-attention-'))
    let server: RustServer | undefined
    try {
      const projectDir = path.join(sharedRoot, 'project')
      await fs.mkdir(projectDir, { recursive: true })
      server = new RustServer({
        env: {
          FRESHELL_CLAUDE_SIDECAR: CLAUDE_SIDECAR_FIXTURE,
          FRESHELL_CLAUDE_NODE: process.execPath,
          FRESHELL_FAKE_PROVIDER: 'freshclaude',
          FRESHELL_FAKE_PROGRAM: JSON.stringify(FAKE_PROGRAM),
          FRESHELL_FAKE_STDIN: path.join(sharedRoot, 'sidecar-stdin.jsonl'),
          FRESHELL_FAKE_EVENTS: path.join(sharedRoot, 'sidecar-events.jsonl'),
        },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
            version: 1,
            settings: {
              codingCli: { enabledProviders: ['claude'] },
              freshAgent: { enabled: true },
            },
          }, null, 2))
        },
      })
      const info = await server.start()
      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()

      // The boot tab shows the pane-type picker (no shell is selected first,
      // so the freshclaude pane REPLACES the picker — no split sibling): make
      // the fresh-agent options visible, then pick Freshclaude.
      await page.evaluate(() => {
        window.__FRESHELL_TEST_HARNESS__?.dispatch({
          type: 'connection/setAvailableClis',
          payload: { claude: true },
        })
      })
      const picker = await openPanePicker(page)
      await picker.getByRole('button', { name: /^Freshclaude$/i }).click({ force: true })
      const directoryInput = page.getByLabel(/^Starting directory for Freshclaude$/i)
      await expect(directoryInput).toBeVisible({ timeout: 15_000 })
      await directoryInput.fill(projectDir)
      await directoryInput.press('Enter')

      const paneRoot = page.locator('[data-context="fresh-agent"]').last()
      await expect(paneRoot).toBeVisible({ timeout: 15_000 })

      const tabA = (await harness.getActiveTabId())!
      expect(tabA).toBeTruthy()

      // The pane materializes its bridge session + durable sessionRef.
      const paneId: string = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.id ?? null
      }, { timeout: 15_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout).id as string
      })
      const bridgeSessionId: string = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.sessionId ?? null
      }, { timeout: 30_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout).content.sessionId as string
      })
      const durableCliSessionId: string = await expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.sessionRef?.sessionId ?? null
      }, { timeout: 30_000 }).not.toBeNull().then(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout).content.sessionRef.sessionId as string
      })

      const composer = paneRoot.getByRole('textbox', { name: 'Chat message input' })
      const sendButton = paneRoot.getByRole('button', { name: 'Send' })
      const tabALocator = page.locator(`[data-context="tab"][data-tab-id="${tabA}"]`)
      const paneHeader = page.locator(`[data-context="pane-header"][data-pane-id="${paneId}"]`)
      const sidebarRow = page
        .getByTestId('sidebar-session-list')
        .locator(`[data-session-id="${durableCliSessionId}"][data-provider="claude"]`)

      const paneStatus = () => expect.poll(async () => {
        const layout = await harness.getPaneLayout(tabA)
        return findFreshAgentLeaf(layout)?.content?.status ?? null
      }, { timeout: 30_000 })
      const turnCompletionState = () => harness.getState().then((s: any) => s?.turnCompletion ?? {})

      // The pane opens idle before any turn is driven.
      await paneStatus().toBe('idle')
      expect((await turnCompletionState()).seq ?? 0).toBe(0)

      // ── Step 1: an ERRORED turn ending in a BACKGROUND tab ──────────────
      // Send, then move to a fresh shell tab inside the fake's 3s emission
      // window — the user is in another tab when the max-turns error lands.
      await composer.fill('ERROR_TURN')
      await sendButton.click()
      await page.getByRole('button', { name: 'New shell tab' }).click()
      await harness.waitForTabCount(2)
      const tabB = (await harness.getActiveTabId())!
      expect(tabB).not.toBe(tabA)

      // One bell: exactly one turnCompletion event enters the pipeline.
      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the errored background turn rings exactly one event (seq 1)' })
        .toBe(1)
      // Unwitnessed endings mark EVERYTHING: tab, pane header, sidebar row.
      const erroredState = await turnCompletionState()
      expect(erroredState.attentionByTab?.[tabA], 'the errored turn sets the tab attention flag').toBe(true)
      expect(erroredState.attentionByPane?.[paneId], 'the errored turn sets the pane-header mark').toBe(true)
      expect(erroredState.watchedCompletionByTab?.[tabA], 'an unwitnessed ending sets no watched mark').toBeUndefined()
      await expect(tabALocator, 'the background tab carries the emerald attention class').toHaveClass(/bg-emerald-100/)
      await expect(paneHeader, 'the pane header carries the emerald attention mark').toHaveClass(/bg-emerald-50/)
      await expect(sidebarRow, 'the pane session has a sidebar row to check').toBeVisible({ timeout: 30_000 })
      await expect(sidebarRow, 'the session row highlights in the sidebar').toHaveClass(/bg-emerald-50|border-l-emerald-500/)

      // One-shot: the errored turn rings exactly once — stable across a
      // settle window (no replay re-ring, no second bell).
      await page.waitForTimeout(1_500)
      expect((await turnCompletionState()).seq).toBe(1)

      // ── Step 2: visiting the tab dismisses the attention ────────────────
      await tabALocator.click()
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 10_000, message: 'visiting the tab clears the tab attention (click mode)' })
        .toBeNull()
      await expect
        .poll(async () => (await turnCompletionState()).attentionByPane?.[paneId] ?? null,
          { timeout: 10_000, message: 'visiting the tab clears the pane-header mark too' })
        .toBeNull()
      await expect(tabALocator).not.toHaveClass(/bg-emerald-100/)
      await paneStatus().toBe('idle')

      // ── Step 3: a user-initiated interrupt while watching = TOTAL silence ─
      // The delayed completion keeps the turn provably in flight; the Stop
      // click lands inside the window. The fake arms the REAL gate, settles
      // ok:true, and the interrupted turn's non-success result follows with
      // its ring consumed — so NO new event, and NO mark of any kind (a
      // user interrupt creates neither attention nor a watched mark).
      await composer.fill('INTERRUPT_ME')
      await sendButton.click()
      const stopButton = paneRoot.getByRole('button', { name: 'Stop' })
      await expect(stopButton, 'the Stop control enables while the turn is in flight').toBeEnabled({ timeout: 2_000 })
      await stopButton.click()

      // The turn ends (pane back to idle) — and the pipeline stayed silent.
      await paneStatus().toBe('idle')
      await page.waitForTimeout(1_000)
      const interruptState = await turnCompletionState()
      expect(interruptState.seq, 'a user-initiated interrupt rings NO new event').toBe(1)
      expect(interruptState.attentionByTab?.[tabA], 'an interrupt creates no tab attention').toBeUndefined()
      expect(interruptState.attentionByPane?.[paneId], 'an interrupt creates no pane-header mark').toBeUndefined()
      expect(interruptState.watchedCompletionByTab?.[tabA], 'an interrupt creates no watched mark').toBeUndefined()
      await expect(tabALocator, 'the tab strip shows no mark of any kind after the interrupt').not.toHaveClass(/bg-emerald-100|border-t-success/)

      // Wire truth — the silence is the GATE's doing, not a missing result:
      // the settle (ok:true) AND the interrupted turn's own NON-SUCCESS
      // sdk.result are on the wire, with NO sdk.turn.complete after them.
      const wires = readJsonl(path.join(sharedRoot, 'sidecar-events.jsonl')).filter((r) => r.kind === 'wire')
      const settleIdx = wires.findIndex(
        (r) => r.frame?.type === 'sdk.interrupt_settled' && r.frame?.sessionId === bridgeSessionId,
      )
      expect(settleIdx, 'the interrupt settle (ok:true) crossed the sidecar wire').toBeGreaterThanOrEqual(0)
      expect(wires[settleIdx].frame?.ok).toBe(true)
      const interruptedResultIdx = wires.findIndex(
        (r, i) => i > settleIdx && r.frame?.type === 'sdk.result' && r.frame?.sessionId === bridgeSessionId,
      )
      expect(interruptedResultIdx, 'the interrupted turn\'s own result follows the settle').toBeGreaterThan(settleIdx)
      expect(wires[interruptedResultIdx].frame?.result, 'the interrupted turn never ends success').toBe('error_during_execution')
      expect(
        wires.slice(settleIdx).filter((r) => r.frame?.type === 'sdk.turn.complete' && r.frame?.sessionId === bridgeSessionId),
        'the armed gate consumed the interrupted turn\'s ring — no edge after the settle',
      ).toEqual([])

      // ── Step 4: a COMPLETED turn the user watched = tab strip only ─────
      // (tab A is active and the window focused; the plain send completes
      // with the canned success turn.)
      await composer.fill('a watched happy turn')
      await sendButton.click()
      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the watched completion edge still folds (seq 2) — watching partitions the MARKS, not the edge' })
        .toBe(2)
      await paneStatus().toBe('idle')
      const watchedState = await turnCompletionState()
      expect(watchedState.attentionByTab?.[tabA], 'a watched ending creates no tab attention').toBeUndefined()
      expect(watchedState.attentionByPane?.[paneId], 'a watched ending creates no pane-header mark').toBeUndefined()
      expect(watchedState.watchedCompletionByTab?.[tabA], 'the watched ending sets the tab-strip-only mark').toBe(true)
      await expect(tabALocator, 'the ACTIVE tab renders the watched green top-line mark').toHaveClass(/border-t-success/)
      await expect(tabALocator, 'the watched mark never shades an active tab like a background alert').not.toHaveClass(/bg-emerald-100/)
      await expect(paneHeader, 'the pane header stays dark for a watched ending').not.toHaveClass(/bg-emerald-50/)
      await expect(sidebarRow, 'the sidebar row stays dark for a watched ending').not.toHaveClass(/bg-emerald-50|border-l-emerald-500/)

      // The watched mark clears on away-and-back: navigate to tab B and
      // return — only a REAL re-activation may clear it.
      await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()
      await tabALocator.click()
      await expect
        .poll(async () => (await turnCompletionState()).watchedCompletionByTab?.[tabA] ?? null,
          { timeout: 10_000, message: 'the away-and-back clears the watched mark' })
        .toBeNull()
      await expect(tabALocator, 'the watched top-line mark is gone after away-and-back').not.toHaveClass(/border-t-success/)

      // ── Step 5: an errored turn while the WINDOW is unfocused ───────────
      // (the user is in another app; the bell rings for any tab.) Headless
      // Chromium cannot produce an OS-level window blur — probe-verified:
      // a sibling page's bringToFront() leaves BOTH pages reporting
      // document.hasFocus() === true — so the spec drives the ONE
      // browser-API signal the production partition reads (isWindowFocused()
      // → document.hasFocus()): patch it to false through the page, verify
      // the patch took, drive the turn, then restore the real function. The
      // fold, the partition, and the attention products below are all real
      // production behavior; only the focus READING is seeded.
      await page.evaluate(() => {
        (window as any).__FRESHELL_ORIGINAL_HAS_FOCUS__ = Document.prototype.hasFocus
        Document.prototype.hasFocus = () => false
      })
      await expect
        .poll(async () => page.evaluate(() => document.hasFocus()),
          { timeout: 10_000, message: 'the unfocused-window seam is verified, not assumed' })
        .toBe(false)

      await composer.fill('ERROR_TURN')
      await sendButton.click()

      // The edge folds (seq 3) and — with the window unfocused — the
      // unwitnessed partition sets the attention flag even though the pane's
      // tab is the ACTIVE tab. The audible ring itself is not directly
      // observable in e2e; the partition inputs (unfocused + active-tab) and
      // its attention products are, and the sound-suppression split is
      // unit-pinned (useTurnCompletionNotifications).
      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the unfocused-window errored turn still folds its edge (seq 3)' })
        .toBe(3)
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 15_000, message: 'the unfocused window keeps the ending unwitnessed — attention sets' })
        .toBe(true)
      await paneStatus().toBe('idle')

      // Restore the REAL focus signal before the away-and-back dismissal
      // (the click-mode dismiss requires the window to be focused), and
      // clear the step-5 attention so the stream-error lane below starts
      // from a clean slate.
      await page.evaluate(() => {
        const original = (window as any).__FRESHELL_ORIGINAL_HAS_FOCUS__
        if (typeof original === 'function') Document.prototype.hasFocus = original
      })
      await expect
        .poll(async () => page.evaluate(() => document.hasFocus()),
          { timeout: 10_000, message: 'the real hasFocus is restored' })
        .toBe(true)
      await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()
      await tabALocator.click()
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 10_000, message: 'the step-5 attention clears on away-and-back' })
        .toBeNull()
      await paneStatus().toBe('idle')

      // ── Step 6: mid-turn stream exception — NO process exit ────────────
      // The fake's stream-error lane models the real consumeStream
      // catch+finally: sdk.error + the finally-minted unified edge + session
      // teardown, with the sidecar process still alive.
      await composer.fill('STREAM_ERROR')
      await sendButton.click()
      await page.locator(`[data-context="tab"][data-tab-id="${tabB}"]`).click()

      await expect
        .poll(async () => (await turnCompletionState()).seq ?? 0,
          { timeout: 30_000, message: 'the stream-exception turn rings exactly one unified edge (seq 4)' })
        .toBe(4)
      await expect
        .poll(async () => (await turnCompletionState()).attentionByTab?.[tabA] ?? null,
          { timeout: 15_000, message: 'the unwitnessed stream exception sets attention' })
        .toBe(true)
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabA)
          return findFreshAgentLeaf(layout)?.content?.status ?? null
        }, { timeout: 30_000, message: 'the pane resolves to idle after the stream exception' })
        .toBe('idle')

      // The sidecar process is STILL ALIVE: the wire rows carry its pid and
      // signal-0 proves the process exists — a process death would have let
      // the Rust unrequested-death synthesis mint a SECOND edge, which the
      // exact-one seq pin above already excludes; this is the direct proof.
      const streamWires = readJsonl(path.join(sharedRoot, 'sidecar-events.jsonl'))
        .filter((r) => r.kind === 'wire' && r.frame?.sessionId === bridgeSessionId)
      expect(streamWires.length, 'the session produced wire rows to read the sidecar pid from').toBeGreaterThan(0)
      const sidecarPid = streamWires[0].pid as number
      expect(() => process.kill(sidecarPid, 0), 'the sidecar process survived the stream error (no exit)').not.toThrow()
      const streamErrIdx = streamWires.findIndex((r) => r.frame?.type === 'sdk.error')
      expect(streamErrIdx, 'the stream-exception lane surfaced its sdk.error frame').toBeGreaterThanOrEqual(0)
      expect(
        streamWires.slice(streamErrIdx).filter((r) => r.frame?.type === 'sdk.turn.complete'),
        'exactly one unified edge for the stream-exception turn (fenced after its sdk.error; the session\'s earlier turns each rang their own edge)',
      ).toHaveLength(1)

      // One edge total for the lane — stable across a settle window (no
      // death-synthesis double ring).
      await page.waitForTimeout(1_500)
      expect((await turnCompletionState()).seq).toBe(4)
    } finally {
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
