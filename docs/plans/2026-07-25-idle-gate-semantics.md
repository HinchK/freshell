# Idle-Gate Semantics (Lane A) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Fix false-chime / spurious truly-idle in the Rust freshell server by making the `IdleGate` busy-aware (G1) and by emitting the `queue-empty` idle reason with legacy-parity semantics (G2), for the claude, codex, and amplifier terminal CLI lanes.

**Architecture:** Port the legacy Node `TrulyIdleEmitter` decision table (`server/coding-cli/truly-idle-emitter.ts`) faithfully into the Rust `IdleGate` (`crates/freshell-activity/src/idle.rs`): per-terminal `busy`/`pending`/`saw_queue_evidence` state fed from the tracker `Changed` streams, a turn boundary that records queue evidence instead of arming while busy, and an `expire` that picks `queue-empty` vs `grace` from the evidence flag. The three `*_frames` functions in `crates/freshell-ws/src/activity.rs` (lines 589-731) are rewired to forward BOTH phase edges (busy AND idle) plus removals to the gate — uniformly for claude, codex, and amplifier. Also fixes a latent bug discovered during investigation: production constructs `IdleGate::default()` whose derived `Default` leaves `grace_ms == 0`, so `terminal.idle` fires instantly instead of after the 2 s grace window.

**Tech Stack:** Rust (cargo workspace crates `freshell-activity`, `freshell-ws`, `freshell-protocol`), Playwright e2e (`test/e2e-browser/`, TypeScript NodeNext ESM), existing fake-CLI fixtures.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/idle-gate-semantics`, branch `fix/idle-gate-semantics`, based on `origin/main@2bf579e6`. All commands below run from the worktree root unless stated otherwise.
- SCOPE FENCE (verbatim from the lane spec): you own `crates/freshell-activity/src/idle.rs` and the frames/arming region `crates/freshell-ws/src/activity.rs:589-731`. Do NOT touch `activity.rs` `attach_lane`/`drain_lane` (lines ~392-545 — Lane B owns those), `codex.rs` tracker internals (Lane D), `terminal.rs`/`registry.rs` (Lane E), or client `src/` (Lane C). Do not touch kimi/gemini/opencode. (Appending NEW tests at the end of `activity.rs`, a doc-comment-only edit in `freshell-protocol/src/server_messages.rs`, and new files under `test/e2e-browser/` are in scope.)
- NEVER touch the user's live servers: no restarts, no broad kill patterns, and e2e tests must NEVER use ports 3001/3002. `RustServer` allocates ephemeral ports via `findFreePort()` — always use it.
- PR POLICY: PR creation is NOT user-approved. When green: commit, push the branch, STOP before `gh pr create`. Report branch + red→green test names.
- Server/test TS uses NodeNext ESM: relative imports must include `.js` extensions.
- Rust quality gates: `cargo clippy --workspace --all-targets -- -D warnings` and `cargo fmt --all -- --check` must pass.
- Broad Node test runs (`npm test`, `npm run check`) go through the shared coordinator gate: run `npm run test:status` first; if another agent holds the gate, WAIT (four sibling lanes run concurrently). Set `FRESHELL_TEST_SUMMARY="lane A idle-gate-semantics verification"` for broad runs.
- The wire protocol needs NO changes: `TerminalIdleReason::QueueEmpty` already exists and serializes as `"queue-empty"` (`crates/freshell-protocol/src/server_messages.rs:372-377`); the client already accepts both reasons (`shared/ws-protocol.ts:212`, `src/store/turnCompletionSlice.ts:18`, `src/App.tsx:1178`). Only a stale doc comment changes.
- Commit messages end with the Amplifier footer:

  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

## Spec Deviations Grounded in Repo Reality (read before reviewing coverage)

1. **"FLIP the test.fixme in playwright.config.ts:69-73"** — there is NO `test.fixme` to flip. Verified by full-file reads: `test/e2e-browser/specs/truly-idle-alerting.spec.ts` (189 lines) contains zero `fixme` occurrences and its header (lines 77-79) says "Rust leg live since feat/rust-terminal-activity-idle"; the spec IS in `MATRIX_SPECS` (`playwright.config.ts:71`) so its rust leg already runs under the `rust-chromium` project. The comment at `playwright.config.ts:68-70` claiming a fixme is STALE. This plan satisfies the requirement's intent by (a) correcting the stale comment (Task 1) and (b) proving the rust leg passes post-fix (Task 6). The "red e2e that exposes G1" role is served by the NEW spec written red-first in Task 1.
2. **Latent grace-window bug folded in (Task 4):** `HubInner` is `#[derive(Default)]` (`crates/freshell-ws/src/activity.rs:92`), so production builds `IdleGate::default()` with `grace_ms == 0` — `IdleGate::new()` is never called in production. `terminal.idle` therefore fires immediately at the turn boundary instead of after `IDLE_GRACE_MS` (2000 ms). Evidence: `cargo test -p freshell-ws --lib activity::` completes its 6 tests in ~3.0 s wall — exactly the one 3 s absence-wait, with the idle-flow tests emitting instantly. This is squarely idle-gate semantics (it makes the G1 false chime instantaneous) and is fixed inside `idle.rs` only (manual `Default` impl), respecting the fence.
3. **Amplifier reason is `grace`, by design.** The amplifier tracker has no queue ledger (a second `prompt:submit` while Busy is a no-op, and `TurnCompleted` only fires from phase Busy — `amplifier/tracker.rs:205-232`), so a boundary-while-busy can never occur for amplifier and no queue evidence can accrue. This matches the legacy emitter, where only claude (boundary-while-busy) and codex (busy→pending re-arm) can set `sawQueueEvidence`. The uniform G1 fix (busy-aware gate + full phase forwarding) IS applied to the amplifier lane; its e2e asserts reason `grace` and grace-window respect.

## File Structure

| File | Change |
|---|---|
| `crates/freshell-activity/src/idle.rs` | Rewrite gate state machine: per-terminal `TerminalIdleState { busy, pending, saw_queue_evidence, deadline }`, new `IdleGatePhase` enum + `note_phase()`, busy-aware `note_turn_boundary()`, evidence-driven reason in `expire()`, manual `Default`. All new unit tests live here. |
| `crates/freshell-ws/src/activity.rs` | Lines 589-731 only: replace `note_busy_upserts` with `note_changed_to_gate` (forwards busy AND idle edges + removals) in `claude_frames`, `codex_frames`, `amplifier_frames`. New hub tests appended to the existing `mod tests`. Possibly raise two existing test timeouts (Task 4). |
| `crates/freshell-protocol/src/server_messages.rs` | Doc comment only (lines ~367-370): remove "reserved; every current CLI lane uses `grace`". |
| `test/e2e-browser/helpers/ws-capture.ts` | NEW: reusable raw-WS frame capture helper (modeled on the `WsCapture` class inside `terminal-activity-rust.spec.ts:61-111`). |
| `test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts` | NEW: rust-only e2e — queued-submit-before-BEL for claude/codex/amplifier, restart-mid-busy via `restartAbrupt()`, two concurrent `RustServer`s. |
| `test/e2e-browser/playwright.config.ts` | Fix stale comment (lines 68-70); one-line append to `RUST_ONLY_SPECS` (before line ~92) and one-line append to `rust-chromium.testMatch` (before line ~213). |

Design decision (locked): the busy-awareness lives INSIDE `IdleGate`, fed from the `Changed` stream — exactly like the legacy `TrulyIdleEmitter`. Rationale: no tracker exposes a phase query (`states` are private; `list()` is the only route), trackers emit `Changed` BEFORE `TurnComplete` in one effect vector, and `has_public_change` suppresses busy→busy `Changed` entirely (proof: `claude.rs:339-358` `stacked_submits_need_matching_bels`) — so the gate's busy flag persisting from the LAST public phase edge is precisely the information needed. This keeps `note_turn_boundary`'s signature unchanged (zero churn on its 6 existing test call sites) and keeps all tracker crates untouched (fence-safe).

## The Legacy Decision Table Being Ported (from `server/coding-cli/truly-idle-emitter.ts`, read in full)

Per-terminal state: `busy`, `pending`, `sawQueueEvidence`, grace timer. `isBusyPhase(p) = p === 'busy' || p === 'pending'` (`:40-42`). Grace = 2000 ms (`:9`).

| Input | Branch | Effect |
|---|---|---|
| activity upsert (`:87-101`) | nextBusy && prev.busy && !prev.pending && next=='pending' | `sawQueueEvidence = true` (codex queued-submit re-arm, `:94-95`) |
| activity upsert | nextBusy (any) | cancel grace timer (`:97`) |
| activity upsert | !nextBusy (idle/unknown) | INERT: no cancel, no arm, no evidence (deadman/signal-loss idle flips never arm) |
| activity upsert | always | store `busy`/`pending` (`:99-100`) |
| activity remove (`:102-109`) | state exists | cancel timer + DELETE whole state (evidence lost); never emits |
| turn complete (`:112-121`) | `state.busy` (incl. pending) | `sawQueueEvidence = true`; return — DO NOT ARM (`:114-118`) |
| turn complete | not busy | arm one-shot grace (re-arm resets the full window) |
| grace expiry (`:157-169`) | `state.busy` | return without emitting (defensive) |
| grace expiry | else | `reason = sawQueueEvidence ? 'queue-empty' : 'grace'`; reset evidence; emit `{terminalId, at, reason}` |

Deliberate retained divergence: the Rust gate derives deadlines from the boundary's `at` (all call sites pass `now_ms()`), and `note_activity` EXTENDS a pending window (amplifier events lane needs this). Both are pre-existing Rust regime choices; this plan preserves them.

---

### Task 1: Red e2e — new rust-only spec + WsCapture helper + playwright config

**Files:**
- Create: `test/e2e-browser/helpers/ws-capture.ts`
- Create: `test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (lines ~68-70 comment; one-line appends at ~92 and ~213)

**Interfaces:**
- Consumes: `RustServer` from `test/e2e-browser/helpers/rust-server.ts` (`new RustServer({ env?, setupHome?, token? })`, `await server.start(): TestServerInfo` with `info.baseUrl`/`info.wsUrl`/`info.token`, `await server.restartAbrupt()`, `await server.stop()`); `TestHarness` from `helpers/test-harness.ts` (`waitForHarness()`, `waitForConnection()`, `getActiveTabId()`, `getPaneLayout(tabId)`, `getState()`); fixtures `test/e2e-browser/fixtures/fake-bel-cli.mjs` (BEL per stdin line: 700 ms, or 6000 ms if the prompt contains `slow`) and `fake-amplifier-activity-cli.mjs` (events.jsonl `prompt:submit`/`prompt:complete`, turn length via `FAKE_AMPLIFIER_TURN_MS`).
- Produces: `WsCapture` class (`new WsCapture(wsUrl, token)`, `await ready()`, `await waitFor(pred, timeoutMs, label): WsFrame`, `count(pred): number`, `get all(): WsFrame[]`, `close()`), used by this spec and available to future specs.

- [ ] **Step 1: Write the WsCapture helper**

Create `test/e2e-browser/helpers/ws-capture.ts`. This is modeled on the spec-local `WsCapture` class in `test/e2e-browser/specs/terminal-activity-rust.spec.ts:61-111` — open that file and mirror its hello handshake EXACTLY (the shape below is `{ type: 'hello', protocolVersion: 7, token }`; if the reference file differs, copy the reference verbatim):

```ts
// Raw server-side WebSocket frame capture for wire-level assertions
// (terminal.idle / terminal.turn.complete edges), independent of the browser
// client. Mirrors the WsCapture pattern in terminal-activity-rust.spec.ts.
import WebSocket from 'ws'

export type WsFrame = Record<string, any>

export class WsCapture {
  private ws: WebSocket
  private frames: WsFrame[] = []
  private readyPromise: Promise<void>

  constructor(wsUrl: string, token: string) {
    this.ws = new WebSocket(wsUrl)
    this.readyPromise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('WsCapture: no ready frame within 15s')),
        15_000,
      )
      this.ws.on('open', () => {
        this.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 7, token }))
      })
      this.ws.on('message', (data) => {
        let frame: WsFrame
        try {
          frame = JSON.parse(String(data))
        } catch {
          return
        }
        this.frames.push(frame)
        if (frame.type === 'ready') {
          clearTimeout(timer)
          resolve()
        }
      })
      this.ws.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
    })
  }

  async ready(): Promise<void> {
    return this.readyPromise
  }

  get all(): WsFrame[] {
    return this.frames
  }

  count(pred: (f: WsFrame) => boolean): number {
    return this.frames.filter(pred).length
  }

  async waitFor(pred: (f: WsFrame) => boolean, timeoutMs: number, label: string): Promise<WsFrame> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const hit = this.frames.find(pred)
      if (hit) return hit
      if (Date.now() >= deadline) {
        throw new Error(`WsCapture: timed out after ${timeoutMs}ms waiting for ${label}`)
      }
      await new Promise((r) => setTimeout(r, 100))
    }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      // already closed
    }
  }
}
```

- [ ] **Step 2: Write the new spec file**

Create `test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts`. Notes for the implementer: the provider-button regexes (`/Claude CLI/i` etc.) and the starting-directory combobox flow mirror `truly-idle-alerting.spec.ts:109-125` and `terminal-activity-rust.spec.ts:141-177` — if a locator misses, copy the exact locator from those files. Timings: fake BEL turns are 700 ms (or 6000 ms with `slow` in the prompt); the grace window is 2000 ms.

```ts
// IDLE-GATE SEMANTICS (Lane A) -- rust-only e2e proof of the busy-aware
// truly-idle gate (G1) and queue-empty reason parity (G2).
//
// Every test boots its OWN RustServer (ephemeral port via findFreePort inside
// RustServer.start(), fresh mkdtemp FRESHELL_HOME, random token). NEVER
// touches ports 3001/3002 (the user's live servers).
//
// RED HISTORY: written BEFORE the Rust fix. Pre-fix expected failures:
//   - claude/codex queued tests: a terminal.idle fires MID-TURN after the
//     first BEL (G1), and the final reason is 'grace' not 'queue-empty' (G2);
//   - amplifier test: terminal.idle fires instantly (grace_ms==0 Default bug);
//   - restart + two-server tests are regression guards and may already pass.
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { WsCapture, type WsFrame } from '../helpers/ws-capture.js'

const FIXTURES_DIR = fileURLToPath(new URL('../fixtures', import.meta.url))
const FAKE_BEL_CLI = path.join(FIXTURES_DIR, 'fake-bel-cli.mjs')
const FAKE_AMPLIFIER_CLI = path.join(FIXTURES_DIR, 'fake-amplifier-activity-cli.mjs')
const GRACE_MS = 2_000

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(source, target)
  await fs.chmod(target, 0o755)
  return target
}

function seedProviders(providers: string[]): (homeDir: string) => Promise<void> {
  return async (homeDir: string) => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        { version: 1, settings: { codingCli: { enabledProviders: providers } } },
        null,
        2,
      ),
    )
  }
}

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

/** Boot tab shows the pane-type picker: pick the CLI, accept the starting
 * directory, and resolve the new pane's terminalId. */
async function openBootCliPane(
  page: import('@playwright/test').Page,
  harness: TestHarness,
  buttonName: RegExp,
  mode: string,
  cwd: string,
): Promise<string> {
  await page.getByRole('button', { name: buttonName }).click({ timeout: 15_000 })
  const cwdBox = page.getByRole('combobox', { name: /starting directory/i })
  await expect(cwdBox).toBeVisible({ timeout: 10_000 })
  await cwdBox.fill(cwd)
  await cwdBox.press('Enter')
  await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
  const tabId = await harness.getActiveTabId()
  expect(tabId).toBeTruthy()
  await expect
    .poll(async () => {
      const layout = await harness.getPaneLayout(tabId!)
      const leaf = collectLeaves(layout).find(
        (l) => l?.content?.mode === mode && l?.content?.terminalId,
      )
      return leaf?.content?.terminalId ?? null
    }, { timeout: 20_000 })
    .not.toBeNull()
  const layout = await harness.getPaneLayout(tabId!)
  const leaf = collectLeaves(layout).find(
    (l) => l?.content?.mode === mode && l?.content?.terminalId,
  )
  return leaf!.content.terminalId as string
}

async function typePrompt(page: import('@playwright/test').Page, text: string): Promise<void> {
  await page.locator('.xterm').first().click()
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

const idleFor = (terminalId: string) => (f: WsFrame) =>
  f.type === 'terminal.idle' && f.terminalId === terminalId
const turnCompleteFor = (terminalId: string) => (f: WsFrame) =>
  f.type === 'terminal.turn.complete' && f.terminalId === terminalId

test.describe('idle-gate semantics (rust)', () => {
  test.setTimeout(300_000)

  test('claude: queued submit BEFORE the BEL never fires idle mid-turn; drain emits one queue-empty idle', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-claude-'))
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude },
        setupHome: seedProviders(['claude']),
      })
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)

        // Turn 1 is SLOW (6000ms). The second submit lands ~immediately, so
        // its 700ms BEL arrives FIRST, completing one queued turn while the
        // slow turn is still running (in_flight >= 2 -> phase stays Busy).
        await typePrompt(page, 'first slow prompt')
        await typePrompt(page, 'second prompt')

        // BEL #1 (~0.7s): one turn.complete, tracker still Busy.
        await capture.waitFor(turnCompleteFor(terminalId), 15_000, 'turn.complete #1')
        // G1 PROBE: sit well past the grace window mid-turn -- NO idle allowed.
        await page.waitForTimeout(GRACE_MS + 1_500)
        expect(capture.count(idleFor(terminalId))).toBe(0)

        // BEL #2 (~6s): the queue drains.
        await capture.waitFor(
          (f) => turnCompleteFor(terminalId)(f) && capture.count(turnCompleteFor(terminalId)) >= 2,
          15_000,
          'turn.complete #2',
        )
        expect(capture.count(idleFor(terminalId))).toBe(0)

        // G2: the deferred-arm emission carries reason 'queue-empty'.
        const idle = await capture.waitFor(idleFor(terminalId), GRACE_MS + 4_000, 'terminal.idle')
        expect(idle.reason).toBe('queue-empty')

        await page.waitForTimeout(1_500)
        expect(capture.count(idleFor(terminalId))).toBe(1)
        expect(capture.count(turnCompleteFor(terminalId))).toBe(2)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('codex: queued submit re-arm never fires idle mid-turn; drain emits one queue-empty idle', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-codex-'))
    try {
      const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
      const server = new RustServer({
        env: { CODEX_CMD: fakeCodex },
        setupHome: seedProviders(['codex']),
      })
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Codex CLI/i, 'codex', sharedRoot)

        // Slow turn 1 + immediate queued turn 2 (its BEL arrives first and is
        // consumed as the codex busy->pending re-arm = queue evidence).
        await typePrompt(page, 'first slow prompt')
        await typePrompt(page, 'second prompt')

        // Codex emits its single completion only when the queue drains (~6s).
        const tc = await capture.waitFor(turnCompleteFor(terminalId), 20_000, 'turn.complete')
        // G1: nothing fired mid-turn before the drain.
        expect(capture.count(idleFor(terminalId))).toBe(0)

        const idle = await capture.waitFor(idleFor(terminalId), GRACE_MS + 4_000, 'terminal.idle')
        expect(idle.reason).toBe('queue-empty')
        expect(idle.at).toBeGreaterThanOrEqual(tc.at)

        await page.waitForTimeout(1_500)
        expect(capture.count(idleFor(terminalId))).toBe(1)
        expect(capture.count(turnCompleteFor(terminalId))).toBe(1)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('amplifier: overlapping prompts emit exactly one grace idle, never inside the grace window', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-amp-'))
    try {
      const fakeAmp = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      const server = new RustServer({
        env: { AMPLIFIER_CMD: fakeAmp, FAKE_AMPLIFIER_TURN_MS: '3000' },
        setupHome: seedProviders(['amplifier']),
      })
      const info = await server.start()
      const capture = new WsCapture(info.wsUrl, info.token)
      try {
        await capture.ready()
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Amplifier CLI/i, 'amplifier', sharedRoot)

        // prompt:complete #1 lands at ~3.0s, #2 at ~3.8s (the second events
        // append EXTENDS the armed window -- still one emission, after grace).
        await typePrompt(page, 'first prompt')
        await page.waitForTimeout(800)
        await typePrompt(page, 'second prompt')

        const tc = await capture.waitFor(turnCompleteFor(terminalId), 20_000, 'turn.complete')
        expect(capture.count(idleFor(terminalId))).toBe(0)

        const idle = await capture.waitFor(idleFor(terminalId), GRACE_MS + 6_000, 'terminal.idle')
        expect(idle.reason).toBe('grace')
        // Grace-window respect: kills the grace_ms==0 Default bug.
        expect(idle.at - tc.at).toBeGreaterThanOrEqual(GRACE_MS)

        await page.waitForTimeout(1_500)
        expect(capture.count(idleFor(terminalId))).toBe(1)
      } finally {
        capture.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('restart mid-busy: no spurious idle or chime edge after an abrupt SIGKILL + reboot', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-restart-'))
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude },
        setupHome: seedProviders(['claude']),
      })
      const info = await server.start()
      let capture: WsCapture | null = null
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const terminalId = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)

        // Start a SLOW turn (6000ms) and kill the server mid-turn.
        await typePrompt(page, 'a slow prompt')
        await page.waitForTimeout(1_000) // provably mid-turn (BEL at ~6s)
        await server.restartAbrupt()

        // The live client reconnects on its own (no page.reload()).
        await expect(async () => {
          const status = await page.evaluate(
            () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState(),
          )
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        // Fresh wire capture against the reborn server (same port/token).
        capture = new WsCapture(info.wsUrl, info.token)
        await capture.ready()

        // Observation window > grace + fake turn remainder: NOTHING may fire
        // for the killed-mid-turn terminal -- no idle, no completion.
        await page.waitForTimeout(8_000)
        expect(capture.count(idleFor(terminalId))).toBe(0)
        expect(capture.count(turnCompleteFor(terminalId))).toBe(0)

        // Client-side: no chime edge was folded in either.
        const state = await harness.getState()
        expect(state?.turnCompletion?.seq ?? 0).toBe(0)
      } finally {
        capture?.close()
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('two concurrent servers keep independent idle/status streams', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-idlegate-twoserver-'))
    try {
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', FAKE_BEL_CLI)
      const mkServer = () =>
        new RustServer({ env: { CLAUDE_CMD: fakeClaude }, setupHome: seedProviders(['claude']) })
      const serverA = mkServer()
      const serverB = mkServer()
      const infoA = await serverA.start()
      const infoB = await serverB.start()
      expect(infoA.port).not.toBe(infoB.port)
      const captureA = new WsCapture(infoA.wsUrl, infoA.token)
      const captureB = new WsCapture(infoB.wsUrl, infoB.token)
      try {
        await captureA.ready()
        await captureB.ready()
        const anyIdle = (f: WsFrame) => f.type === 'terminal.idle'
        const anyTurn = (f: WsFrame) => f.type === 'terminal.turn.complete'

        // Full turn + idle cycle on A only.
        await page.goto(`${infoA.baseUrl}/?token=${infoA.token}&e2e=1`)
        let harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const termA = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)
        await typePrompt(page, 'hello from A')
        const idleA = await captureA.waitFor(idleFor(termA), 20_000, 'A terminal.idle')
        expect(idleA.terminalId).toBe(termA)
        // B saw NOTHING.
        expect(captureB.count(anyIdle)).toBe(0)
        expect(captureB.count(anyTurn)).toBe(0)

        // Now a cycle on B; A's stream must not grow.
        const idleCountA = captureA.count(anyIdle)
        await page.goto(`${infoB.baseUrl}/?token=${infoB.token}&e2e=1`)
        harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()
        const termB = await openBootCliPane(page, harness, /Claude CLI/i, 'claude', sharedRoot)
        await typePrompt(page, 'hello from B')
        const idleB = await captureB.waitFor(idleFor(termB), 20_000, 'B terminal.idle')
        expect(idleB.terminalId).toBe(termB)
        expect(captureA.count(anyIdle)).toBe(idleCountA)
      } finally {
        captureA.close()
        captureB.close()
        await serverA.stop().catch(() => {})
        await serverB.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
```

- [ ] **Step 3: Register the spec in playwright config + fix the stale comment**

In `test/e2e-browser/playwright.config.ts`:

(a) Replace the stale comment above the `MATRIX_SPECS` truly-idle entry (lines ~67-70). Old:

```ts
  // Truly-idle alerting (terminal.idle): end-to-end blue -> green + one alert
  // edge + tab shade -> activate clears. Legacy leg runs; the rust leg is
  // test.fixme pending the rust terminal.idle emitter
  // (feat/rust-terminal-activity-idle) so it flips on trivially.
```

New:

```ts
  // Truly-idle alerting (terminal.idle): end-to-end blue -> green + one alert
  // edge + tab shade -> activate clears. Both legs live: the rust
  // terminal.idle emitter shipped with feat/rust-terminal-activity-idle.
```

(b) Append ONE line inside `RUST_ONLY_SPECS` (immediately before the closing `]`, ~line 92; sibling lanes append here too — trivial merge conflicts are expected and fine):

```ts
  // Lane A: busy-aware idle gate + queue-empty reason (imports RustServer
  // directly for restartAbrupt() and two concurrent servers).
  /idle-gate-semantics-rust\.spec\.ts$/,
```

(c) Append the SAME regex as one line inside the `rust-chromium` project's `testMatch` array (immediately before its closing `]`, ~line 213):

```ts
        /idle-gate-semantics-rust\.spec\.ts$/,
```

Both (b) and (c) are required: `RUST_ONLY_SPECS` only excludes the spec from the match-all `chromium`/`firefox`/`webkit` projects; `testMatch` is what includes it in `rust-chromium`.

- [ ] **Step 4: Run the new spec — verify it fails for the RIGHT reasons (RED)**

Run (first run also does `cargo build --release -p freshell-server`, budget several minutes):

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/idle-gate-semantics-rust.spec.ts
```

Expected: FAIL. Specifically:
- claude test: FAILS at the G1 probe (`expect(capture.count(idleFor(terminalId))).toBe(0)` after turn.complete #1 — a `terminal.idle` fired mid-turn) or, if it limps past, at `expect(idle.reason).toBe('queue-empty')` receiving `'grace'`.
- codex test: FAILS the same way (mid-turn idle count, or reason `'grace'`).
- amplifier test: FAILS at `expect(idle.at - tc.at).toBeGreaterThanOrEqual(2000)` (idle fires instantly — the `grace_ms == 0` Default bug).
- restart and two-server tests: may PASS (they are regression guards).

If a test fails on UI mechanics instead (locator not found, terminalId never resolves), that is NOT the right red — fix the locators against `truly-idle-alerting.spec.ts` / `terminal-activity-rust.spec.ts` until the failures are the semantic ones above.

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/helpers/ws-capture.ts \
        test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts \
        test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): red idle-gate semantics spec (queued-before-BEL, restart, two-server)

RED by design: proves G1 (mid-turn terminal.idle after a queued submit
that precedes the BEL) and G2 (queue-empty reason unreachable) plus the
grace_ms==0 IdleGate::default() bug, ahead of the Rust fix tasks.
Also corrects the stale 'rust leg is test.fixme' comment in
playwright.config.ts (the rust leg has been live since PR #525).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: IdleGate busy-awareness (G1, unit level)

**Files:**
- Modify: `crates/freshell-activity/src/idle.rs` (struct + methods + tests; currently 180 lines)

**Interfaces:**
- Consumes: `freshell_protocol::TerminalIdleReason` (unchanged).
- Produces (relied on by Tasks 3-5): `pub enum IdleGatePhase { Busy, Pending, Idle }`; `pub fn note_phase(&mut self, terminal_id: &str, phase: IdleGatePhase)`; UNCHANGED signatures for `new()`, `with_grace_ms(i64)`, `note_turn_boundary(&str, i64)`, `note_busy(&str)`, `note_activity(&str, i64)`, `note_exit(&str)`, `expire(i64) -> Vec<IdleEmission>`, `next_deadline() -> Option<i64>`. `IdleEmission` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `crates/freshell-activity/src/idle.rs`:

```rust
    #[test]
    fn turn_boundary_while_busy_never_arms() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        // claude in_flight >= 2: BEL #1's boundary lands while the tracker
        // still reports Busy (busy->busy emits no Changed frame, so the gate's
        // busy flag persists from the FIRST busy upsert).
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.next_deadline(), None);
        assert!(gate.expire(100 + 10 * IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn boundary_after_the_idle_flip_arms_normally() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        // The final BEL: Changed(Idle) is processed BEFORE TurnComplete in the
        // same effect vector, so the gate sees not-busy at the boundary.
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.next_deadline(), Some(100 + IDLE_GRACE_MS));
        assert_eq!(gate.expire(100 + IDLE_GRACE_MS).len(), 1);
    }

    #[test]
    fn idle_phase_report_is_inert() {
        // Deadman/signal-loss idle flips arrive WITHOUT a turn boundary and
        // never arm; they also never cancel an armed window (legacy parity).
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Idle);
        assert_eq!(gate.next_deadline(), None);
        gate.note_turn_boundary("t1", 100);
        gate.note_phase("t1", IdleGatePhase::Idle); // e.g. duplicate idle upsert
        assert_eq!(gate.next_deadline(), Some(100 + IDLE_GRACE_MS));
    }

    #[test]
    fn busy_phase_report_cancels_a_pending_window() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_phase("t1", IdleGatePhase::Busy);
        assert_eq!(gate.next_deadline(), None);
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn pending_phase_counts_as_busy_for_the_boundary_gate() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Pending);
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.next_deadline(), None);
    }

    #[test]
    fn a_second_boundary_rearms_the_full_window() {
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_turn_boundary("t1", 1_000);
        assert_eq!(gate.next_deadline(), Some(1_000 + IDLE_GRACE_MS));
        assert!(gate.expire(100 + IDLE_GRACE_MS).is_empty());
    }

    #[test]
    fn expire_never_emits_while_busy_even_with_a_stale_deadline() {
        // Defensive second gate (legacy handleGraceExpiry's busy guard): if a
        // deadline somehow survives into a busy phase, drop it silently.
        let mut gate = IdleGate::new();
        gate.note_turn_boundary("t1", 100);
        gate.note_phase("t1", IdleGatePhase::Pending); // cancels
        gate.note_turn_boundary("t1", 200); // busy -> refuses to arm
        assert!(gate.expire(200 + 10 * IDLE_GRACE_MS).is_empty());
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-activity --lib idle::
```

Expected: COMPILE ERROR — `IdleGatePhase` / `note_phase` not found (that is the red: the API does not exist).

- [ ] **Step 3: Implement the state machine**

In `crates/freshell-activity/src/idle.rs`, replace the `IdleGate` struct (lines 38-43) and the `impl` (lines 45-107) with the following. Keep `IDLE_GRACE_MS` and `IdleEmission` unchanged. Leave `#[derive(Debug, Default)]` on `IdleGate` for now (Task 4 replaces it):

```rust
/// Tracker phase kinds the gate distinguishes (legacy `isBusyPhase` plus the
/// codex `pending` special case that carries queue evidence).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleGatePhase {
    Busy,
    Pending,
    Idle,
}

#[derive(Debug, Default)]
struct TerminalIdleState {
    /// Tracker reports busy-or-pending (legacy `isBusyPhase`).
    busy: bool,
    /// Tracker phase is specifically `pending` (codex submit gate).
    pending: bool,
    /// Queue evidence observed since the last emission (queued turn /
    /// re-armed submit). Selects the `queue-empty` reason. (Wired in the
    /// queue-evidence change; kept false until then.)
    saw_queue_evidence: bool,
    /// Armed grace deadline, if any.
    deadline: Option<i64>,
}

#[derive(Debug, Default)]
pub struct IdleGate {
    states: HashMap<String, TerminalIdleState>,
    grace_ms: i64,
}

impl IdleGate {
    pub fn new() -> Self {
        Self::with_grace_ms(IDLE_GRACE_MS)
    }

    pub fn with_grace_ms(grace_ms: i64) -> Self {
        Self {
            states: HashMap::new(),
            grace_ms,
        }
    }

    /// A tracker `Changed` upsert: record the phase edge. Busy/pending cancels
    /// any pending window; an idle report is INERT (no cancel, no arm —
    /// deadman/signal-loss idle flips never arm).
    pub fn note_phase(&mut self, terminal_id: &str, phase: IdleGatePhase) {
        let state = self.states.entry(terminal_id.to_string()).or_default();
        let next_busy = matches!(phase, IdleGatePhase::Busy | IdleGatePhase::Pending);
        if next_busy {
            state.deadline = None;
        }
        state.busy = next_busy;
        state.pending = phase == IdleGatePhase::Pending;
    }

    /// A positive turn boundary. While the tracker still reports busy this is
    /// a QUEUED turn (claude keeps phase Busy until in_flight drains): never
    /// arm mid-turn. Otherwise arm (or re-arm) the grace window.
    pub fn note_turn_boundary(&mut self, terminal_id: &str, at: i64) {
        let state = self.states.entry(terminal_id.to_string()).or_default();
        if state.busy {
            return;
        }
        state.deadline = Some(at + self.grace_ms);
    }

    /// Provisional busy (submit-shaped PTY input / amplifier TurnBegan):
    /// cancel any pending emission — it was never truly idle. Does NOT set
    /// the busy flag: only confirmed tracker phase edges do that.
    pub fn note_busy(&mut self, terminal_id: &str) {
        if let Some(state) = self.states.get_mut(terminal_id) {
            state.deadline = None;
        }
    }

    /// New session-file activity while the window is pending (amplifier:
    /// events.jsonl appends): extend the window.
    pub fn note_activity(&mut self, terminal_id: &str, at: i64) {
        if let Some(state) = self.states.get_mut(terminal_id) {
            if let Some(deadline) = state.deadline.as_mut() {
                *deadline = (*deadline).max(at + self.grace_ms);
            }
        }
    }

    /// Terminal exited or was removed from a tracker: drop ALL gate state for
    /// it (legacy remove semantics — never emit for a dead terminal).
    pub fn note_exit(&mut self, terminal_id: &str) {
        self.states.remove(terminal_id);
    }

    /// Emit every window whose deadline has lapsed (once each). A terminal
    /// that re-entered busy never emits (defensive second gate).
    pub fn expire(&mut self, at: i64) -> Vec<IdleEmission> {
        let mut emissions = Vec::new();
        for (terminal_id, state) in self.states.iter_mut() {
            let Some(deadline) = state.deadline else {
                continue;
            };
            if at < deadline {
                continue;
            }
            state.deadline = None;
            if state.busy {
                continue;
            }
            emissions.push(IdleEmission {
                terminal_id: terminal_id.clone(),
                at,
                reason: TerminalIdleReason::Grace,
            });
        }
        emissions
    }

    /// Earliest pending deadline — `None` when no window is armed.
    pub fn next_deadline(&self) -> Option<i64> {
        self.states.values().filter_map(|s| s.deadline).min()
    }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cargo test -p freshell-activity --lib idle::
```

Expected: PASS — all 13 tests (6 pre-existing + 7 new). The 6 pre-existing tests (`boundary_then_quiet_grace_emits_exactly_once`, `busy_reentry_cancels_the_pending_emission`, `session_file_activity_extends_the_window`, `activity_without_a_pending_window_arms_nothing`, `exit_cancels`, `next_deadline_reflects_the_earliest_window`) must pass UNCHANGED — they encode the frozen wire contract.

- [ ] **Step 5: Compile the dependent crate (no behavior change expected yet)**

```bash
cargo test -p freshell-ws --lib activity::
```

Expected: PASS (6 tests) — the hub still calls only the unchanged-signature methods.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-activity/src/idle.rs
git commit -m "feat(activity): busy-aware IdleGate — a turn boundary never arms mid-turn

Ports the legacy TrulyIdleEmitter's busy gate: per-terminal busy/pending
state fed by note_phase(), boundary-while-busy refuses to arm (G1), and
expire() carries a defensive busy guard. note_busy() stays a provisional
cancel; idle phase reports are inert (deadman flips never arm).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Queue evidence and the `queue-empty` reason (G2, unit level) + doc updates

**Files:**
- Modify: `crates/freshell-activity/src/idle.rs`
- Modify: `crates/freshell-protocol/src/server_messages.rs` (doc comment lines ~367-370 only)

**Interfaces:**
- Consumes: Task 2's `TerminalIdleState`, `note_phase`, `note_turn_boundary`, `expire`.
- Produces: same public API; `expire` now emits `TerminalIdleReason::QueueEmpty` when queue evidence accrued. Relied on by Task 5's hub tests.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `idle.rs`:

```rust
    #[test]
    fn boundary_while_busy_then_drain_emits_queue_empty() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_turn_boundary("t1", 100); // queued turn: evidence, no arm
        gate.note_phase("t1", IdleGatePhase::Idle); // queue drained
        gate.note_turn_boundary("t1", 200); // arms
        let emissions = gate.expire(200 + IDLE_GRACE_MS);
        assert_eq!(
            emissions,
            vec![IdleEmission {
                terminal_id: "t1".into(),
                at: 200 + IDLE_GRACE_MS,
                reason: TerminalIdleReason::QueueEmpty
            }]
        );
    }

    #[test]
    fn evidence_resets_after_an_emission() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_turn_boundary("t1", 100); // evidence
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 200);
        assert_eq!(gate.expire(200 + IDLE_GRACE_MS).len(), 1); // queue-empty
        // Next cycle without new evidence: plain grace.
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 10_000);
        let emissions = gate.expire(10_000 + IDLE_GRACE_MS);
        assert_eq!(emissions[0].reason, TerminalIdleReason::Grace);
    }

    #[test]
    fn codex_busy_to_pending_rearm_counts_as_queue_evidence() {
        // Legacy truly-idle-emitter.ts:90-98 — a busy->pending transition is
        // the codex queued-submit-consumed-at-turn-clear signal.
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_phase("t1", IdleGatePhase::Pending); // re-arm: evidence
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 100);
        let emissions = gate.expire(100 + IDLE_GRACE_MS);
        assert_eq!(emissions[0].reason, TerminalIdleReason::QueueEmpty);
    }

    #[test]
    fn pending_to_pending_is_not_queue_evidence() {
        // Only the busy&&!pending -> pending edge counts (legacy :94).
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Pending);
        gate.note_phase("t1", IdleGatePhase::Pending);
        gate.note_phase("t1", IdleGatePhase::Idle);
        gate.note_turn_boundary("t1", 100);
        assert_eq!(gate.expire(100 + IDLE_GRACE_MS)[0].reason, TerminalIdleReason::Grace);
    }

    #[test]
    fn exit_discards_queue_evidence_with_the_rest_of_the_state() {
        let mut gate = IdleGate::new();
        gate.note_phase("t1", IdleGatePhase::Busy);
        gate.note_turn_boundary("t1", 100); // evidence
        gate.note_exit("t1"); // legacy remove: whole state deleted
        gate.note_turn_boundary("t1", 200); // fresh terminal id reuse
        assert_eq!(gate.expire(200 + IDLE_GRACE_MS)[0].reason, TerminalIdleReason::Grace);
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-activity --lib idle::
```

Expected: FAIL — `boundary_while_busy_then_drain_emits_queue_empty`, `evidence_resets_after_an_emission`, `codex_busy_to_pending_rearm_counts_as_queue_evidence` fail with reason `Grace` where `QueueEmpty` is expected (the flag exists but nothing sets or reads it). `pending_to_pending_is_not_queue_evidence` and `exit_discards_queue_evidence_...` may already pass (they pin the negative space).

- [ ] **Step 3: Implement evidence recording and the reason selection**

Three edits in `idle.rs`:

(1) In `note_phase`, add the codex re-arm edge detection (full method after the edit):

```rust
    pub fn note_phase(&mut self, terminal_id: &str, phase: IdleGatePhase) {
        let state = self.states.entry(terminal_id.to_string()).or_default();
        let next_busy = matches!(phase, IdleGatePhase::Busy | IdleGatePhase::Pending);
        if next_busy {
            // Codex busy->pending re-arm: a queued submit was consumed at the
            // turn clear — queue evidence (legacy truly-idle-emitter.ts:94-95).
            if state.busy && !state.pending && phase == IdleGatePhase::Pending {
                state.saw_queue_evidence = true;
            }
            state.deadline = None;
        }
        state.busy = next_busy;
        state.pending = phase == IdleGatePhase::Pending;
    }
```

(2) In `note_turn_boundary`, record evidence on the refused arm (full method):

```rust
    pub fn note_turn_boundary(&mut self, terminal_id: &str, at: i64) {
        let state = self.states.entry(terminal_id.to_string()).or_default();
        if state.busy {
            // Queued turn (claude in_flight ledger keeps phase busy until the
            // queue drains): record queue evidence, never arm
            // (legacy truly-idle-emitter.ts:114-118).
            state.saw_queue_evidence = true;
            return;
        }
        state.deadline = Some(at + self.grace_ms);
    }
```

(3) In `expire`, select and reset the reason (replace the `emissions.push` block):

```rust
            let reason = if state.saw_queue_evidence {
                TerminalIdleReason::QueueEmpty
            } else {
                TerminalIdleReason::Grace
            };
            state.saw_queue_evidence = false;
            emissions.push(IdleEmission {
                terminal_id: terminal_id.clone(),
                at,
                reason,
            });
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cargo test -p freshell-activity --lib idle::
```

Expected: PASS — all 18 tests.

- [ ] **Step 5: Update the two stale doc comments**

(a) `crates/freshell-activity/src/idle.rs` module doc, lines ~14-17. Old:

```rust
//! * the window lapsing emits exactly one `terminal.idle` with reason
//!   `grace` (per-CLI queued-prompt detection: where a CLI's queued-prompt
//!   state is undetectable, grace-window-only is the accepted fallback —
//!   every current lane uses `grace`);
```

New:

```rust
//! * the window lapsing emits exactly one `terminal.idle`; the reason is
//!   `queue-empty` when queue evidence accrued since the last emission (a
//!   boundary while the tracker still reported busy, or a codex
//!   busy→pending re-arm), else `grace`;
//! * a turn boundary while the tracker still reports busy/pending is a
//!   QUEUED turn: it records queue evidence and never arms mid-turn;
```

(b) `crates/freshell-protocol/src/server_messages.rs`, lines ~367-370. Old:

```rust
/// `terminal.idle.reason` — why the server believes the terminal is truly
/// idle: `grace` = a grace window passed with no new activity after the turn
/// boundary; `queue-empty` = the provider positively reported no queued user
/// prompt (reserved; every current CLI lane uses `grace`).
```

New:

```rust
/// `terminal.idle.reason` — why the server believes the terminal is truly
/// idle: `grace` = a grace window passed with no new activity after the turn
/// boundary; `queue-empty` = queued-prompt evidence was observed during the
/// turn (a boundary while busy, or a codex busy→pending re-arm) and the
/// queue has since drained.
```

- [ ] **Step 6: Run the protocol tests (wire contract unchanged)**

```bash
cargo test -p freshell-protocol
```

Expected: PASS, including `terminal_idle_serializes_the_pinned_contract` (pins both `"grace"` and `"queue-empty"` wire strings).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-activity/src/idle.rs crates/freshell-protocol/src/server_messages.rs
git commit -m "feat(activity): queue-empty idle reason with legacy TrulyIdleEmitter parity

Queue evidence accrues on a boundary-while-busy (claude queued turns) and
on the codex busy->pending re-arm; expire() emits reason 'queue-empty'
and resets the flag, exactly matching truly-idle-emitter.ts:87-169. Wire
contract untouched (both reason strings were already pinned).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Fix `IdleGate::default()` grace window (latent production bug)

**Files:**
- Modify: `crates/freshell-activity/src/idle.rs`
- Possibly modify: two test timeouts inside `crates/freshell-ws/src/activity.rs` `mod tests` (see Step 4)

**Interfaces:**
- Consumes: `HubInner` is `#[derive(Default)]` (`crates/freshell-ws/src/activity.rs:92`), so production builds `IdleGate::default()` — that construction is NOT changed (fence); the fix is inside `IdleGate`.
- Produces: `IdleGate::default()` ≡ `IdleGate::new()` (grace = `IDLE_GRACE_MS`).

- [ ] **Step 1: Write the failing test**

Append to `mod tests` in `idle.rs`:

```rust
    #[test]
    fn default_gate_uses_the_production_grace_window() {
        // HubInner is #[derive(Default)] (freshell-ws activity.rs), so
        // PRODUCTION constructs IdleGate::default(). A derived Default left
        // grace_ms == 0 — terminal.idle fired instantly at the boundary.
        let mut gate = IdleGate::default();
        gate.note_turn_boundary("t1", 100);
        assert!(
            gate.expire(100 + IDLE_GRACE_MS - 1).is_empty(),
            "the default gate must honor the full grace window"
        );
        assert_eq!(gate.expire(100 + IDLE_GRACE_MS).len(), 1);
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-activity --lib idle::default_gate_uses_the_production_grace_window
```

Expected: FAIL — the `expire(100 + IDLE_GRACE_MS - 1).is_empty()` assertion trips (emission happens immediately because derived `grace_ms == 0`).

- [ ] **Step 3: Implement — manual `Default`**

In `idle.rs`, change `#[derive(Debug, Default)]` on `IdleGate` to `#[derive(Debug)]` and add directly below the struct:

```rust
impl Default for IdleGate {
    /// Production constructs the gate via `HubInner: Default` — the default
    /// MUST carry the real grace window, not a zeroed one.
    fn default() -> Self {
        Self::new()
    }
}
```

Run: `cargo test -p freshell-activity --lib idle::` — Expected: PASS (19 tests).

- [ ] **Step 4: Run the hub tests — repair timing assumptions they inherited from the 0ms bug**

```bash
cargo test -p freshell-ws --lib activity::
```

The hub's idle-flow tests were passing instantly under the 0 ms bug; with a real 2 s grace they now genuinely wait. Expected outcome: PASS but ~4-5 s slower wall time. If `claude_submit_bel_turn_complete_and_terminal_idle_flow` (activity.rs:819-882) or `amplifier_events_lane_drives_busy_complete_and_idle_via_inotify` (activity.rs:1021-1111) FAIL by timing out while awaiting `"terminal.idle"`, find their `next_frame_of_type(&mut rx, "terminal.idle", <timeout>)` call and raise that timeout to `5_000` (test-only edit; do not touch anything else in those tests). Re-run until: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-activity/src/idle.rs crates/freshell-ws/src/activity.rs
git commit -m "fix(activity): IdleGate::default() must carry the real grace window

HubInner is #[derive(Default)], so production built IdleGate::default()
with grace_ms == 0 — terminal.idle fired instantly at the turn boundary
instead of after IDLE_GRACE_MS (2s). Default now delegates to new().

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

(If Step 4 required no timeout edits, drop `crates/freshell-ws/src/activity.rs` from the `git add`.)

---

### Task 5: Wire the gate into all three frames lanes (hub level)

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` — ONLY the frames/arming region (lines ~589-731: `claude_frames`, `codex_frames`, `amplifier_frames`, `note_busy_upserts`) plus NEW tests appended inside the existing `mod tests`. Also the `use` line that imports `IdleGate`.
- Modify: `crates/freshell-activity` re-export if needed (see Step 3 note).

**Interfaces:**
- Consumes: `IdleGatePhase` + `note_phase` + `note_exit` from Task 2/3; `TrackerEffect::{Changed, TurnComplete, ForceRead}`; phase enums `freshell_protocol::{ClaudePhase, CodexPhase, AmplifierPhase}`; existing test helpers `hub()`, `observer_send()`, `next_frame_of_type()` (activity.rs:754-798).
- Produces: hub behavior — no `terminal.idle` while a tracker reports busy; `queue-empty` on the wire after a queued drain. No signature changes visible outside this file.

- [ ] **Step 1: Write the failing hub tests**

Append inside `mod tests` in `crates/freshell-ws/src/activity.rs` (after the last existing test, following the file's existing test style — `hub()`, `observer_send`, `next_frame_of_type` are the helpers already used by `queued_prompt_suppresses_terminal_idle` at lines 884-930):

```rust
    /// G1 red test: the queued submit arrives BEFORE the BEL (claude
    /// in_flight >= 2). BEL #1 completes turn 1 while the tracker still
    /// reports Busy (busy->busy emits no Changed frame — claude.rs
    /// stacked_submits_need_matching_bels), so the boundary is the ONLY
    /// effect. The gate must not arm; no terminal.idle may fire mid-turn.
    /// The existing queued_prompt_suppresses_terminal_idle test sends its
    /// second submit AFTER the BEL — this is the untested ordering.
    #[tokio::test(flavor = "multi_thread")]
    async fn stacked_submits_before_the_bel_suppress_terminal_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // The second submit is typed BEFORE any BEL: in_flight == 2.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // BEL #1: turn 1 completes, turn 2 still running.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 3_000)
                .await
                .is_none(),
            "terminal.idle must not fire while the queued turn is still running"
        );
    }

    /// G2: draining the stacked queue emits exactly ONE terminal.idle with
    /// reason queue-empty (evidence recorded at the mid-queue boundary).
    #[tokio::test(flavor = "multi_thread")]
    async fn draining_stacked_submits_emits_one_queue_empty_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "claude".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        for _ in 0..2 {
            observer_send(
                &hub,
                ActivityEvent::Input {
                    terminal_id: "t1".into(),
                    data: "\r".into(),
                    at: now_ms(),
                },
            );
        }
        for _ in 0..2 {
            observer_send(
                &hub,
                ActivityEvent::Output {
                    terminal_id: "t1".into(),
                    data: "\u{07}".into(),
                    at: now_ms(),
                },
            );
        }
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle after the queue drains");
        assert_eq!(idle["reason"], "queue-empty");
        assert!(
            next_frame_of_type(&mut rx, "terminal.idle", 1_000)
                .await
                .is_none(),
            "exactly one emission per busy->truly-idle transition"
        );
    }

    /// Codex lane parity: a queued submit consumed at the turn clear
    /// (busy->pending re-arm) is queue evidence; the drain emits queue-empty.
    #[tokio::test(flavor = "multi_thread")]
    async fn codex_queued_rearm_drains_to_a_queue_empty_idle() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        // Turn 1 submitted -> Pending.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // Streaming output promotes Pending -> Busy (output liveness).
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "working on it...".into(),
                at: now_ms(),
            },
        );
        // Queued submit while Busy.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: now_ms(),
            },
        );
        // BEL #1: turn clear consumes the queued submit -> Busy->Pending
        // re-arm (queue evidence), NO completion.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        // BEL #2: queue empty -> Idle + completion -> the gate arms.
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: now_ms(),
            },
        );
        let idle = next_frame_of_type(&mut rx, "terminal.idle", 5_000)
            .await
            .expect("terminal.idle after the codex queue drains");
        assert_eq!(idle["reason"], "queue-empty");
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-ws --lib activity::stacked_submits_before_the_bel_suppress_terminal_idle \
&& cargo test -p freshell-ws --lib activity::draining_stacked_submits_emits_one_queue_empty_idle \
&& cargo test -p freshell-ws --lib activity::codex_queued_rearm_drains_to_a_queue_empty_idle
```

Expected: all three FAIL —
- `stacked_submits_before_the_bel...`: a `terminal.idle` arrives within 3 s (the gate armed at BEL #1 because nothing feeds it phase edges yet);
- `draining_stacked_submits...`: reason is `"grace"` (no evidence reached the gate);
- `codex_queued_rearm...`: reason is `"grace"`.

- [ ] **Step 3: Wire the gate — replace `note_busy_upserts` with full phase + removal forwarding**

In `crates/freshell-ws/src/activity.rs`:

(a) Extend the import of `IdleGate` to also bring in `IdleGatePhase` (find the existing `use` that names `IdleGate` near the top of the file and add `IdleGatePhase` beside it; if `freshell-activity` does not re-export it from the same path, add it to the same `pub use`/module export in `crates/freshell-activity/src/lib.rs` where `IdleGate` is exported).

(b) Replace `note_busy_upserts` (lines ~724-731) with:

```rust
/// Forward a tracker `Changed` effect to the idle gate IN FULL: every phase
/// edge (busy AND idle — the gate's busy-awareness needs both) and every
/// removal. Uniform across the claude/codex/amplifier lanes.
fn note_changed_to_gate<'a>(
    idle: &mut IdleGate,
    upserts: impl Iterator<Item = (&'a str, IdleGatePhase)>,
    remove: &[String],
) {
    for (terminal_id, phase) in upserts {
        idle.note_phase(terminal_id, phase);
    }
    for terminal_id in remove {
        idle.note_exit(terminal_id);
    }
}
```

(c) In `claude_frames` (lines ~597-609), replace the `note_busy_upserts(...)` call with:

```rust
            TrackerEffect::Changed { upsert, remove } => {
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            if r.phase == freshell_protocol::ClaudePhase::Busy {
                                IdleGatePhase::Busy
                            } else {
                                IdleGatePhase::Idle
                            },
                        )
                    }),
                    &remove,
                );
                frames.push(ServerMessage::ClaudeActivityUpdated(
                    ClaudeActivityUpdated { remove, upsert },
                ));
            }
```

(d) In `codex_frames` (lines ~639-657), same replacement with the three-way mapping:

```rust
            TrackerEffect::Changed { upsert, remove } => {
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            match r.phase {
                                freshell_protocol::CodexPhase::Busy => IdleGatePhase::Busy,
                                freshell_protocol::CodexPhase::Pending => IdleGatePhase::Pending,
                                _ => IdleGatePhase::Idle,
                            },
                        )
                    }),
                    &remove,
                );
                frames.push(ServerMessage::CodexActivityUpdated(CodexActivityUpdated {
                    remove,
                    upsert,
                }));
            }
```

(e) In `amplifier_frames` (lines ~689-702), same replacement:

```rust
            TrackerEffect::Changed { upsert, remove } => {
                note_changed_to_gate(
                    idle,
                    upsert.iter().map(|r| {
                        (
                            r.terminal_id.as_str(),
                            if r.phase == freshell_protocol::AmplifierPhase::Busy {
                                IdleGatePhase::Busy
                            } else {
                                IdleGatePhase::Idle
                            },
                        )
                    }),
                    &remove,
                );
                frames.push(ServerMessage::AmplifierActivityUpdated(
                    AmplifierActivityUpdated { remove, upsert },
                ));
            }
```

Leave the three `TrackerEffect::TurnComplete` arms (the `idle.note_turn_boundary(&terminal_id, at)` calls at 617/664/709) EXACTLY as they are — the busy decision now lives inside the gate. Do not touch `attach_lane`/`drain_lane` or the Input/Exit handlers.

- [ ] **Step 4: Run the full hub + activity + protocol test set**

```bash
cargo test -p freshell-ws --lib activity:: && cargo test -p freshell-activity && cargo test -p freshell-protocol
```

Expected: ALL PASS —
- the 3 new hub tests go green;
- the 6 pre-existing hub tests stay green, in particular `claude_submit_bel_turn_complete_and_terminal_idle_flow` (asserts `reason == "grace"`, activity.rs:875), `amplifier_events_lane_drives_busy_complete_and_idle_via_inotify` (`"grace"`, :1105), `queued_prompt_suppresses_terminal_idle`, and `idle_terminals_arm_no_timers_and_read_no_files` (`hub_next_deadline == None` — the new per-terminal gate states carry no deadline, so no phantom timers);
- the whole `freshell-activity` crate (62+ lib tests) stays green (claude/codex/amplifier trackers untouched).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs crates/freshell-activity/src/lib.rs
git commit -m "feat(ws): feed the idle gate full phase edges in all three CLI frames lanes

note_busy_upserts (busy-edge-only) becomes note_changed_to_gate: every
Changed upsert forwards its phase (claude/amplifier Busy|Idle, codex
Busy|Pending|Idle) and every removal drops gate state — uniformly for
the claude BEL, codex BEL, and amplifier events lanes. With the
busy-aware gate this closes G1 (queued submit BEFORE the BEL no longer
chimes mid-turn) and makes queue-empty reachable on the wire (G2).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

(Drop `lib.rs` from the add if no re-export change was needed.)

---

### Task 6: E2E green — new spec passes; existing truly-idle matrix legs still pass

**Files:**
- No planned source changes. Permitted if needed: locator/timing fixes INSIDE `test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts` or `helpers/ws-capture.ts` only.

**Interfaces:**
- Consumes: everything from Tasks 1-5. Playwright rebuilds the release server binary automatically (`ensureRustServerBuilt` runs `cargo build --release -p freshell-server` per run).

- [ ] **Step 1: Run the new spec (now expected GREEN)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/idle-gate-semantics-rust.spec.ts
```

Expected: 5 passed. If the claude/codex/amplifier tests fail on ASSERTIONS, the Rust fix is incomplete — go back to Task 5, do not weaken the assertions. If they fail on locators/timing flake, fix the spec mechanics only (assertion values are the contract).

- [ ] **Step 2: Run the pre-existing matrix specs that guard adjacent behavior**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/truly-idle-alerting.spec.ts specs/terminal-activity-rust.spec.ts
```

Expected: PASS. `truly-idle-alerting` proves the "flip the rust leg" requirement is real and green (single-turn flow: blue → one alert edge → green, reason path unchanged); `terminal-activity-rust` pins `reason === 'grace'` for single-turn flows (must NOT have become `queue-empty`).

- [ ] **Step 3: Run the legacy leg of the matrix spec (unchanged behavior on the Node server)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=legacy-chromium specs/truly-idle-alerting.spec.ts
```

Expected: PASS (no server/ TS was touched).

- [ ] **Step 4: Commit (only if spec-mechanics fixes were needed)**

```bash
git add test/e2e-browser/specs/idle-gate-semantics-rust.spec.ts test/e2e-browser/helpers/ws-capture.ts
git commit -m "test(e2e): stabilize idle-gate semantics spec mechanics (green post-fix)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Full verification, push, STOP before PR

**Files:** none (verification + push only).

- [ ] **Step 1: Rust gates**

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all -- --check
```

Expected: all pass, zero warnings, no fmt diffs. Fix anything found (stay inside the scope fence) and amend/commit.

- [ ] **Step 2: Node coordinated suite (coordinator-gate etiquette)**

```bash
npm run test:status
# If another agent holds the gate: WAIT and re-check; never kill a foreign holder.
FRESHELL_TEST_SUMMARY="lane A idle-gate-semantics verification" npm run check
```

Expected: typecheck clean; coordinated full suite green (no server/ or src/ changes were made, so any failure here is either pre-existing on the shared base — compare with `npm run test:status` history — or caused by the playwright/e2e TS files' types).

- [ ] **Step 3: Lint (a11y + TS, covers the new e2e files)**

```bash
npm run lint
```

Expected: clean.

- [ ] **Step 4: Push the branch — DO NOT create a PR**

```bash
git push -u origin fix/idle-gate-semantics
```

Then STOP. Do NOT run `gh pr create` (not user-approved). Final report must include:
- branch name `fix/idle-gate-semantics` + head commit hash;
- red→green proof, naming the exact tests:
  - unit: `idle::tests::turn_boundary_while_busy_never_arms`, `idle::tests::boundary_while_busy_then_drain_emits_queue_empty`, `idle::tests::codex_busy_to_pending_rearm_counts_as_queue_evidence`, `idle::tests::default_gate_uses_the_production_grace_window` (each observed failing in Tasks 2-4 Step 2, passing after implementation);
  - hub: `activity::tests::stacked_submits_before_the_bel_suppress_terminal_idle`, `activity::tests::draining_stacked_submits_emits_one_queue_empty_idle`, `activity::tests::codex_queued_rearm_drains_to_a_queue_empty_idle` (failing in Task 5 Step 2, passing in Step 4);
  - e2e: the 3 provider tests in `idle-gate-semantics-rust.spec.ts` (failing in Task 1 Step 4, passing in Task 6 Step 1);
- verification command outputs summary (cargo workspace / clippy / fmt / npm run check / lint).

---

## Self-Review (performed at plan time)

1. **Spec coverage:** G1 busy-aware arming — Tasks 2 (gate) + 5 (uniform wiring across claude/codex/amplifier lanes at activity.rs 589-731) + the exact red test the spec demands (queued submit BEFORE the BEL, hub level: Task 5 Step 1 first test; e2e level: Task 1 claude/codex tests). G2 queue-empty parity — Task 3 ports the full legacy decision table with per-branch unit tests (boundary-while-busy, codex busy→pending re-arm, evidence reset on emit, pending→pending negative, remove-clears, expiry busy guard, idle-flip inert, re-arm resets window); wire field pre-exists, doc comments updated. Truly-idle spec rust leg — no fixme exists (deviation note 1); stale comment fixed (Task 1), leg proven green (Task 6). E2E requirements — own RustServer instances w/ ephemeral ports + mkdtemp homes (all 5 tests), never 3001/3002, queued-submit-before-BEL per CLI, correct reason after drain, `restartAbrupt()` mid-busy with no spurious idle/chime, two concurrent servers with independent streams, new spec file + minimal one-line config appends. Repo rules — TDD red→green everywhere, cargo + coordinated suite, coordinator-gate etiquette, no server restarts/broad kills, push-then-STOP before PR.
2. **No silent deferrals:** every requirement lands in production code paths proven by wire-level e2e against the real release server binary with real (fake-CLI-driven) PTYs; no stubs or seams stand in for behavior. The amplifier lane intentionally asserts reason `grace` — that is legacy-correct production behavior, not a deferral (deviation note 3). The lone judgment call folded in rather than deferred: the `Default` grace bug (Task 4), required for any grace-window e2e assertion to be truthful.
3. **Placeholder scan:** no TBDs; every code step carries complete code; commands carry expected outcomes; the two spots where the implementer must verify against a reference file (WsCapture hello handshake; provider-button locators) name the exact file+lines to copy from — verification instructions, not placeholders.
4. **Type consistency:** `IdleGatePhase{Busy,Pending,Idle}` and `note_phase(&str, IdleGatePhase)` are identical in Tasks 2, 3, and 5; `note_changed_to_gate(idle, upserts, &remove)` matches its definition; `note_turn_boundary(&str, i64)` signature never changes (all 6 pre-existing call sites untouched); `IdleEmission`/`TerminalIdleReason` untouched; e2e helper API (`ready/waitFor/count/all/close`) matches all five uses.
