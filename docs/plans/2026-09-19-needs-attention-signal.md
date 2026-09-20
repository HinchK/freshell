# Unified "Needs Attention" Turn-End Signal Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Freshell agent attention becomes one binary "needs attention" signal: any turn end the user did not witness — finished, errored, hit max-turns, crashed, wedged/stuck, or waiting on an approval/question — produces the identical tab highlight (green with top line), sidebar row highlight, and a single bell, with no distinction by outcome.

### Explicit constraints
- No difference in chime or visual treatment between finished, error, and approval/question turn endings — one binary signal.
- A turn end the user was watching: visual mark on the tab only, no sound; the mark clears next time the user navigates away and back.
- A user-initiated interrupt is silent.
- The bell also rings when the browser window is not focused (user in another app), for any tab.
- The bell rings once per event; attention persists until dismissed.
- Never replay history: reload, reconnect, or server restart rehydrates idle/busy state but rings no bells and highlights no tabs for turn ends that happened before the page loaded.
- Multiple devices: each device rings based on what it itself witnessed.
- A turn end while its tab is closed produces no highlight anywhere; reopening from the sidebar shows the idle state without an attention flag.
- Terminal-mode CLI panes keep today's behavior unchanged.
- Attention dismissal is unchanged: visiting the tab clears (click mode) or typing in the pane clears (type mode), and clearing always covers the whole tab including sibling panes' marks.
- With sound disabled in settings, highlights still appear; if the chime file cannot play, a quiet built-in tone substitutes.
- All fresh-agent providers (freshclaude/kilroy, freshcodex, freshopencode) are covered for all turn-end outcomes.
- Blue = working, green = idle icon semantics stay state-based and unchanged.

### Accepted tradeoffs and residuals
- Browsers may mute audio until the page's first user interaction; this platform limitation is accepted.
- Remote-resume superseding an old attention flag, and rollback revoking an attention flag, stay at existing behavior — explicitly not important.
- The pane-level "agent appears stuck" card may remain as inline pane content; the tab/sidebar/bell treatment for stuck is the same unified signal.

**Goal:** Any turn end the user didn't witness rings the bell and paints the tab/sidebar once, identically for every outcome, with user-initiated interrupts (and watched endings' sound) the only exceptions.

**Architecture:** All changes are server-side emission widening; the client pipeline is already outcome-agnostic (it reads only `{provider, sessionId, at}` from `freshAgent.turn.complete`/`turn.waiting` frames) and needs zero behavioral code changes. Each provider's emission guard changes from "positive completion only" to "any turn end except user-initiated interrupt": freshopencode drops the `succeeded`/`turn_errored` terms from its settle gate, freshcodex's `on_turn_completed` emits for `completed`/`failed`/absent statuses (skipping only `interrupted`/`inProgress`), the freshclaude sidecar emits for any result subtype unless that session has a user-interrupt pending (a per-session interrupt mark, the opencode `turn_aborted` precedent), and the crash/death wedged paths (codex exit-watcher with a turn in flight, codex quiet deadman fire, freshclaude unrequested sidecar death with a turn in flight, opencode failed settles) mint the same `freshAgent.turn.complete` frame with a per-session monotonic `at`. Test contracts that pinned "never a false completion" invert deliberately; docs and comments follow.

**Tech Stack:** Rust (freshell-codex, freshell-freshagent, freshell-ws crates, tokio), Node ESM (crates/freshell-claude-sidecar), TypeScript/React client (comments/contract tests only), Vitest (client + new sidecar gate unit test), Playwright e2e-browser.

## Global Constraints

- Red-Green-Refactor for every behavior change; never delete/weaken a test to pass — tests that pinned the old success-only contract are updated to pin the new unified contract (with the plan's per-test direction), never skipped.
- Relative TS imports need `.js` extensions where NodeNext/ESM applies (client code uses `@/` aliases; the sidecar package uses plain ESM).
- Rust: `cargo fmt` clean; pre-push gate runs typecheck + clippy + targeted cargo tests; PRs touching Rust must pass the required `rust-gate` check.
- The e2e fakes (`test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs`) must mirror the real sidecar's new semantics exactly — they are the e2e contract.
- All new `freshAgent.turn.complete` frames must carry a finite numeric strictly-monotonic per-session `at` (client drops malformed `at` silently).
- Terminal-mode CLI panes and the codex remote-proxy lane (`remote_proxy.rs`, feeds the terminal activity hub) are NOT touched.
- AGENTS.md's "Agent Status Indicators" paragraph is the durable doc contract — it must be rewritten by the final task, including the stale claim that only Claude/kilroy raise approvals (codex controls does too).
- Every command in this plan runs from the worktree root `/home/dan/code/freshell/.worktrees/needs-attention-signal` unless stated otherwise.

---

### Task 1: freshopencode — widen the settle gate to "any turn end except user interrupt"

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs:6102-6128` (`settle_turn_outcome`)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (in-file tests listed below)

**Interfaces:**
- Consumes: `next_monotonic_turn_complete_at` (freshell-codex), per-session `last_turn_complete_at`, `TurnTask::abort_and_settle`, flags `turn_aborted`/`turn_errored` (all unchanged).
- Produces: `settle_turn_outcome`'s new gate: emit `freshAgent.turn.complete` whenever `!turn_aborted` — i.e. for clean turns, errored turns (`turn_errored`), and failed settles (`succeeded=false`: prompt-POST failure, `IdleTimeout`, `SidecarLost`). Later tasks depend on this same rule for their providers.

- [ ] **Step 1: Write the failing behavioral test** — update the errored-turn test to assert the new contract, and add a failed-settle test.

In `opencode_ws.rs`, rewrite `errored_turn_emits_no_turn_complete_but_forwards_the_error` (at :12578-12653) into `errored_turn_emits_the_error_and_the_unified_attention_edge` — keep the existing dispatch of a real `session.error` SSE event and its `freshAgent.error{message:"boom"}` assertion; replace the "no turn.complete" assertion with:

```rust
// Unified signal: an errored turn end the user didn't witness rings the
// SAME edge as a clean one — the pane resolves, the at is monotonic.
let edge = drain_frames_until(&mut rx, |f| {
    f.get("event").and_then(|e| e.get("type")).and_then(Value::as_str)
        == Some("freshAgent.turn.complete")
}).expect("errored turn must emit the unified attention edge");
assert!(edge["event"]["at"].is_i64());
```

(Use the file's existing frame-draining helpers/patterns — see how `clean_turn_emits_busy_then_idle_then_one_monotonic_turn_complete` at :12454-12501 drains and asserts the chime; mirror them exactly.)

Add a sibling test `failed_settle_emits_the_unified_attention_edge` driving a send whose prompt POST fails (follow the fake-serve harness patterns used by `compact_serve_error_broadcasts_idle_and_a_loud_error_without_a_chime` at :15121-15165 for injecting serve errors, but for the send path's POST): assert the idle snapshot still broadcasts and the `freshAgent.turn.complete` edge follows.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent errored_turn_emits -- --nocapture`

Expected: FAIL — the errored turn still produces no `freshAgent.turn.complete` (the `succeeded && !turn_errored` guard suppresses it).

- [ ] **Step 3: Add the minimal production implementation**

```rust
fn settle_turn_outcome(
    fresh_agent: &FreshAgentState,
    real_id: &str,
    succeeded: bool,
    turn_aborted: &AtomicBool,
    turn_errored: &AtomicBool,
    last_turn_complete_at: &StdMutex<Option<i64>>,
) {
    fresh_agent.broadcast(&event_frame(real_id, snapshot_event(real_id, "idle")));
    // Unified "needs attention": ANY turn end rings except a user-initiated
    // interrupt (turn_aborted). A clean finish, a session.error turn
    // (turn_errored), and a failed settle (succeeded=false: prompt-POST
    // failure, IdleTimeout, SidecarLost) all ended a turn the user may not
    // have been watching — one identical edge, no outcome on the wire.
    if turn_aborted.load(Ordering::SeqCst) {
        return;
    }
    let at = {
        let mut guard = last_turn_complete_at.lock().expect("last_turn_complete_at mutex");
        let at = next_monotonic_turn_complete_at(*guard, now_ms());
        *guard = Some(at);
        at
    };
    if !succeeded || turn_errored.load(Ordering::SeqCst) {
        tracing::debug!(provider = PROVIDER, session_id = %real_id, "turn.settled_non_clean_unified_edge");
    }
    fresh_agent.broadcast(&event_frame(real_id, turn_complete_event(real_id, at)));
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent errored_turn_emits failed_settle_emits -- --nocapture`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — the change is a guard contraction; the doc comment above it carries the rationale.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every opencode test that asserts chime presence/absence — `clean_turn_emits_busy_then_idle_then_one_monotonic_turn_complete`, `interrupted_turn_emits_no_turn_complete` (must STAY green — user interrupt), `compact_posts_summarize_...`, `compact_after_an_interrupted_or_errored_turn_resets_the_stale_flags_and_chimes`, `compact_serve_error_broadcasts_idle_and_a_loud_error_without_a_chime` (must be updated in Step 1 to expect the chime), `kill_during_an_in_flight_compact_aborts_it_without_a_false_completion` (stays green — kill aborts before settle), `interrupt_during_an_in_flight_compact_...`, `compact_while_a_turn_is_in_flight_is_refused_and_never_posts`, `event_frame_shapes_match_legacy_wire_contract`, `attach_known_materialized_session_emits_idle_snapshot` (stays green — no turn).

Run: `cargo test -p freshell-freshagent opencode -- --nocapture`

Expected: PASS (all opencode tests green with the two updated in Step 1)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(freshopencode): ring the unified attention edge on any turn end except user interrupt"
```

### Task 2: freshcodex — widen the turn/completed status guard

**Files:**
- Modify: `crates/freshell-codex/src/events.rs:151-185` (`on_turn_completed`) and its module doc `:6-15`
- Test: `crates/freshell-codex/tests/completion_gating.rs`, `crates/freshell-codex/src/events.rs` in-file tests (:269-436), `crates/freshell-freshagent/src/codex.rs:13602-13652` (compact failed/interrupted test)

**Interfaces:**
- Consumes: `turn_status(&event.params)` (protocol.rs:355-368), `next_monotonic_turn_complete_at`, `TURN_STATUSES` = `completed|interrupted|failed|inProgress` (protocol.rs:28).
- Produces: new guard semantics consumed by all freshagent codex lanes: emit for `Some("completed") | Some("failed") | None`; suppress for `Some("interrupted") | Some("inProgress")`.

- [ ] **Step 1: Write the failing behavioral tests**

Rewrite the status matrix in `crates/freshell-codex/tests/completion_gating.rs`:
- `each_status_gates_the_completion_edge_in_both_wire_shapes` (:38-82) → `each_status_routes_the_unified_attention_edge_in_both_wire_shapes`: for `completed` and `failed` (both wire shapes) assert snapshot + exactly one TurnComplete; for `interrupted` and `inProgress` assert snapshot only.
- `absent_status_and_foreign_thread_never_chime` (:84-104) → `absent_status_emits_the_edge_and_foreign_thread_never_does`: absent status now snapshot + TurnComplete; foreign thread unchanged (nothing).
- `only_completed_advances_the_monotonic_clock` (:106-137) → `every_edge_emitting_status_advances_the_monotonic_clock`: `failed` advances the clock like `completed`; `interrupted` does not; same-ms `completed`→`failed` sequence gets strictly increasing `at`.

Update the in-file `events.rs` tests to the same direction:
- `interrupted_status_emits_snapshot_but_never_chimes` (:318-340) — unchanged contract (interrupt silent), keep.
- `failed_status_never_chimes` (:342-355) → `failed_status_emits_the_unified_edge`.
- `in_progress_status_never_chimes` (:357-370) — unchanged contract, keep.
- `absent_status_never_chimes_but_still_snapshots` (:372-379) → `absent_status_emits_the_unified_edge_and_still_snapshots`.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-codex --test completion_gating`

Expected: FAIL — `failed`/absent cases produce no TurnComplete under the current guard.

- [ ] **Step 3: Add the minimal production implementation**

```rust
// events.rs — replace the guard at :173
// Unified "needs attention": every turn/completed that ENDED the turn rings
// except an interrupt — user- or automation-initiated alike, `interrupted`
// is silent either way — and the non-terminal `inProgress` marker.
// `completed`, `failed`, and an absent status (the turn ended, outcome
// unknown) all ring identically.
match turn_status(&event.params).as_deref() {
    Some("interrupted") | Some("inProgress") => return out,
    _ => {}
}
```

Update the module doc at events.rs:6-15 to state the unified rule (interrupts and inProgress stay silent; completed/failed/absent ring).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-codex --test completion_gating && cargo test -p freshell-codex events::`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — guard replacement; doc comments updated in place.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every codex test touching the guard's output — `interrupt_rpc.rs` (`interrupt_turn_rpc_then_interrupted_completion_snapshots_without_chime` — stays green, interrupt silent), `app_server_drive.rs` `full_drive_interrupted_turn_does_not_chime` (stays green), and in freshagent `codex.rs`: `handle_compact_failed_or_interrupted_turn_produces_no_completion_chime` (:13602-13652) — SPLIT into `handle_compact_failed_turn_emits_the_unified_edge` (failed compact now rings; update assertions) and keep the interrupted half silent; `completed_turn_yields_snapshot_then_chime_frames` (:9897-9926, stays green); the superseded/stale-completion legs (:12842, :12994, :13143, :13265, stay green); `handle_send_always_broadcasts_accepted_before...` (stays green); `turn_complete_event_frames_carry_the_inner_type` (stays green).

Run: `cargo test -p freshell-codex && cargo test -p freshell-freshagent codex -- --nocapture`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/events.rs crates/freshell-codex/tests/completion_gating.rs crates/freshell-freshagent/src/codex.rs
git commit -m "feat(freshcodex): ring the unified attention edge for failed and unknown-status turn ends"
```

### Task 3: freshcodex — crash (exit-watcher) and wedged (quiet deadman) turn ends emit the unified edge

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` — `CodexSession` struct (:358-390, add per-session synthesized-edge clock), crash arm of `spawn_exit_watcher` (:8691-8790), `disarm_codex_quiet` (:8868-8882), deadman waiter `watch_codex_quiet_deadline` (:6457-6498)
- Test: `crates/freshell-freshagent/src/codex.rs` (`onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped` :15846-15896; deadman tests :10302-10674)

**Interfaces:**
- Consumes: `CodexAdapterEvent::TurnComplete { session_id, at }` and `adapter_event_to_frame` (codex.rs:9123-9159), `next_monotonic_turn_complete_at`, `QuietDeadman` fields (`deadline`, `stuck_since`), `quiet_handles` (:6419-6427), `now_ms()`.
- Produces: `CodexSession.synthesized_attention_at: Arc<StdMutex<Option<i64>>>` — the per-session monotonic clock for edges minted OUTSIDE the consumer (crash/deadman). Note: the consumer's own `CodexSubscription.last_turn_complete_at` is a separate in-memory clock; wall-clock advancement keeps the two ordered in practice (a cross-clock NTP-backwards collision would at worst swallow one edge; accepted, same regime as controls.rs's waiting clock).

- [ ] **Step 1: Write the failing behavioral tests**

1. Extend `onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped` — rename to `onexit_self_heal_emits_exited_and_rings_the_unified_edge_when_a_turn_was_in_flight`, and add a twin `onexit_self_heal_emits_exited_without_an_edge_when_idle`:
   - with a turn in flight at crash: assert the `freshAgent.status{exited}` frame AND a `freshAgent.turn.complete` frame (finite numeric `at`) for the same session; session stays mapped.
   - idle crash: `freshAgent.status{exited}` only, NO turn.complete (the `rx.try_recv()` no-edge assertion as today).
2. Deadman: update `quiet_deadman_fires_stuck_status_without_fabricating_a_turn_complete` (:10302-10394) → `quiet_deadman_fires_stuck_and_rings_the_unified_attention_edge`: on fire, assert BOTH the `freshAgent.status{stuck}` frame and a `freshAgent.turn.complete` frame; `quiet_deadman_resolves_on_turn_completion` (:10396-10524) additionally asserts the resolution leg emits NO second edge from the deadman and the (now widened, Task 2) genuine completion still rings exactly once.

- [ ] **Step 2: Run and verify the intended failure**

Run: `cargo test -p freshell-freshagent onexit_self_heel deadman -- --nocapture` (adjust selectors to match: `onexit_self_heal quiet_deadman`)

Expected: FAIL — no turn.complete is emitted today on crash or deadman fire.

- [ ] **Step 3: Add the minimal production implementation**

1. Add to `CodexSession`:
```rust
/// Monotonic `at` clock for attention edges minted outside the notification
/// consumer (crash self-heal, quiet-deadman fire) — the unified
/// "needs attention" edge for turn ends the consumer never sees.
pub(crate) synthesized_attention_at: Arc<StdMutex<Option<i64>>>,
```
(initialized `Arc::default()` at every construction site).
2. Crash arm (codex.rs:8691-8790): after `disarm_codex_quiet(...)` and before/after broadcasting `Status{Exited}`, when a turn was in flight at exit (teach `disarm_codex_quiet` to return whether a window was armed — change its signature to return `bool` and propagate; callers log the same `resolved` as today plus now use the armed state), mint and broadcast:
```rust
if turn_was_in_flight {
    let at = {
        let mut guard = session.synthesized_attention_at.lock().expect("synthesized_attention_at mutex");
        let at = next_monotonic_turn_complete_at(*guard, now_ms());
        *guard = Some(at);
        at
    };
    let event = CodexAdapterEvent::TurnComplete { session_id: thread_id.clone(), at };
    if let Some(frame) = adapter_event_to_frame(&event, &thread_id) {
        let _ = broadcast_tx.send(frame);
    }
}
```
(the crash arm holds `broadcast_tx`; obtain the session handle the same way `quiet_handles` does — if the session map is unavailable there, thread the `Arc<StdMutex<Option<i64>>>` into the watcher at spawn, mirroring how `quiet_deadman` is threaded).
3. Deadman fire (codex.rs:6457-6498): in the `fired == true` branch, after the `Status{Stuck}` broadcast, mint + broadcast the same TurnComplete frame using `synthesized_attention_at` (the waiter already has the session's quiet handle; extend it or read the clock via the same session map access it already uses for `active_turn`).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent onexit_self_heal quiet_deadman -- --nocapture`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the armed-state plumbing for `disarm_codex_quiet` spreads, extract a tiny helper `mint_synthesized_attention_edge(session, thread_id, broadcast_tx)` shared by the crash arm and the deadman fire — one mint site, two callers.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: `codex_sidecar_tracking_tests.rs` (`unrequested_exit_arm_removes_the_record` — watcher signature changes compile), the crash-recovery family (:19645-20507 — respawn semantics; they drain frames for snapshots — if any asserts an EXACT frame sequence, extend for the new edge when their crash scenarios have a turn in flight; scenarios without an in-flight turn stay edge-free), `requested_exit_watcher_reports_confirmed_reap` (requested kill — stays silent).

Run: `cargo test -p freshell-freshagent codex -- --nocapture`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/codex_sidecar_tracking_tests.rs
git commit -m "feat(freshcodex): ring the unified attention edge on crash-while-busy and deadman fires"
```

### Task 4: freshclaude/kilroy sidecar — any-result emission gated on a user-interrupt mark

**Files:**
- Create: `crates/freshell-claude-sidecar/turn-complete-gate.mjs` (pure gate module)
- Modify: `crates/freshell-claude-sidecar/index.mjs` — result case (:279-300), `handleInterrupt` (:483-506), the per-send reset points, sidecar protocol doc (:34-35), ADR comment (:49-52)
- Test: `test/unit/sidecar/claude-turn-complete-gate.test.ts` (new; imports the pure module by relative path)
- Modify: `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` (:251-258 guard + interrupt handling) — parity with the real sidecar

**Interfaces:**
- Consumes: per-session sidecar state `st` (add `st.turnCompleteGate`), `nextMonotonic` (:170-172), SDK result message (`subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`), `sdk.interrupt_settled{ok}` frames (settle lands BEFORE the interrupted turn's result per the SDK contract, sdk.d.ts:3765).
- Produces: `createTurnCompleteGate()` — pure state machine with `noteInterruptRequest()`, `noteInterruptSettled(ok: boolean)`, `resultEmitsAttention(): boolean` (consumes a pending mark; ALWAYS returns true when no mark), `reset()`. Emission rule: EVERY result emits `sdk.turn.complete` (any subtype — success, error_*, success-with-is_error) EXCEPT a result consumed by a pending accepted user-interrupt mark.

- [ ] **Step 1: Write the failing behavioral test**

`test/unit/sidecar/claude-turn-complete-gate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { createTurnCompleteGate } from '../../../crates/freshell-claude-sidecar/turn-complete-gate.mjs'

describe('freshell-claude-sidecar turn-complete gate', () => {
  it('emits for every result subtype with no interrupt in flight', () => {
    for (const subtype of ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries']) {
      const gate = createTurnCompleteGate()
      expect(gate.resultEmitsAttention()).toBe(true) // {subtype} all ring
    }
  })

  it('suppresses the result that follows an accepted user interrupt', () => {
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(true)
    expect(gate.resultEmitsAttention()).toBe(false) // the interrupted turn's own result
    expect(gate.resultEmitsAttention()).toBe(true)  // the next turn rings again
  })

  it('a rejected interrupt (ok:false) never suppresses a later result', () => {
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(false)
    expect(gate.resultEmitsAttention()).toBe(true)
  })

  it('a stale mark never leaks into a later send (reset)', () => {
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.reset()
    expect(gate.resultEmitsAttention()).toBe(true)
  })
})
```

- [ ] **Step 2: Run and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/sidecar/claude-turn-complete-gate.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — module does not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

`crates/freshell-claude-sidecar/turn-complete-gate.mjs`:

```js
/**
 * Unified "needs attention" turn-complete gate (freshell-claude-sidecar).
 *
 * Every SDK `result` — success, error_during_execution, error_max_turns,
 * error_max_budget_usd, error_max_structured_output_retries, and
 * success-with-is_error — ends a turn the user may not have been watching,
 * so every result emits `sdk.turn.complete`. The ONE exception is a
 * user-initiated interrupt: per the SDK contract the `interrupt_settled`
 * receipt lands BEFORE the interrupted turn's own terminal result, so an
 * accepted interrupt arms a mark that consumes (and suppresses) exactly
 * that result. A rejected interrupt (ok:false — the turn kept running)
 * clears the mark; a new send clears any stale mark.
 */
export function createTurnCompleteGate() {
  let userInterruptPending = false
  return {
    noteInterruptRequest() { userInterruptPending = true },
    noteInterruptSettled(ok) { if (!ok) userInterruptPending = false },
    resultEmitsAttention() {
      const interrupted = userInterruptPending
      userInterruptPending = false
      return !interrupted
    },
    reset() { userInterruptPending = false },
  }
}
```

`index.mjs` wiring (per session state `st`):
1. Create the gate where the session state is initialized (alongside `lastTurnCompleteAt`), and call `st.turnCompleteGate.reset()` at the top of every send/create handling (the same place `lastTurnCompleteAt` is initialized/reset for a new turn scope).
2. In `handleInterrupt` (:483-506): call `st.turnCompleteGate.noteInterruptRequest()` immediately before `st.query.interrupt()`; in the `.then` arm call `noteInterruptSettled(true)`, in the `.catch` arm `noteInterruptSettled(false)`.
3. In the result case (:279-300): replace the `if (msg.subtype === 'success')` block with:

```js
      // Unified attention edge: any turn end rings unless this result is the
      // interrupted turn's own (the SDK contract orders the settle receipt
      // before it). No outcome rides the wire — the client treats all ends
      // identically.
      if (st.turnCompleteGate.resultEmitsAttention()) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
```

4. Update the protocol doc at :34-35 and the ADR comment at :49-52 to the new contract (including that an accepted user interrupt's result is consumed silently and the stale "interrupts yield no result at all" claim is corrected).

5. `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs`: replace the `if (subtype === 'success')` guard (:251-258) with the same gate logic — import `createTurnCompleteGate` from the real sidecar package (the fixture already models the interrupt path; verify its interrupt handler exists and wire `noteInterruptRequest`/`noteInterruptSettled` there; if the fake lacks an interrupt handler, add the minimal hook mirroring the real one). The deny-lane e2e (fresh-agent-control-rust.spec.ts:674-734 asserts `sdk.turn.complete` absence up to idle after deny) will be updated in Task 6 to expect the edge.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/sidecar/claude-turn-complete-gate.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — the gate is already the extracted seam.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the e2e fake is consumed by every freshclaude e2e spec — at the unit level nothing else imports the sidecar; run the vitest oracle tier that grades the sidecar contract: `npm run test:vitest -- run test/unit/port/oracle/t2-invariants.test.ts test/unit/port/oracle/freshagent-wireshape-differential.test.ts --config config/vitest/vitest.config.ts` — if either encodes the success-only rule, update its fixtures to the unified rule (they are contract mirrors, and the new contract is the plan's authority). Also run `cargo test -p freshell-freshagent claude -- --nocapture` — the in-crate fake never emits `sdk.turn.complete`, so the claude Rust suite stays green; verify and record.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-claude-sidecar/turn-complete-gate.mjs crates/freshell-claude-sidecar/index.mjs test/unit/sidecar/claude-turn-complete-gate.test.ts test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs
git commit -m "feat(freshclaude): ring the unified attention edge on any turn end except a user interrupt"
```

### Task 5: freshclaude Rust — unrequested sidecar death with a turn in flight emits the unified edge

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` — `ClaudeSession` struct (:512-648, add synthesized clock), unrequested-death arm of the stdout consumer (:8098-8179), module doc (:22-27)
- Test: `crates/freshell-freshagent/src/claude.rs` — `sidecar_death_never_yields_false_completion` (:10298-10334) split; new death-with-turn test; `in_turn_clears_on_exactly_the_four_contract_edges_fail_closed_otherwise` (:19265-19349) death arm (c)

**Interfaces:**
- Consumes: `in_turn` armed state at EOF (the consumer's turn-latch), `emit_fresh_agent_error` (:1630-1648), `ServerMessage::FreshAgentEvent` envelope + `broadcast` helper (:1675-1679), `freshell_codex::next_monotonic_turn_complete_at` (freshagent already depends on freshell-codex — opencode_ws.rs imports it).
- Produces: `ClaudeSession.last_synthesized_complete_at: Arc<StdMutex<Option<i64>>>` — the Rust-side per-session clock for death-minted edges (the sidecar's own clock dies with the process; wall-clock advancement keeps the two ordered, same accepted regime as Task 3).

- [ ] **Step 1: Write the failing behavioral test**

Split `sidecar_death_never_yields_false_completion` into:
1. `sidecar_death_while_idle_emits_no_completion` — the existing death-truncated stream WITHOUT an armed turn: no `freshAgent.turn.complete` (existing assertions).
2. `sidecar_death_with_turn_in_flight_rings_the_unified_edge` (NEW) — model init → send (arms the turn) → stream → assistant → SIGKILL: assert the `freshAgent.error{SIDECAR_EXITED}` frame AND a `freshAgent.turn.complete` frame (finite numeric `at`) for the broadcast id; assert the `at` is strictly greater on a second such cycle (monotonic clock).
Also update the death arm (c) of `in_turn_clears_on_exactly_the_four_contract_edges_fail_closed_otherwise` — busy-clearing stays, and add the edge assertion for the in-flight case.

- [ ] **Step 2: Run and verify the intended failure**

Run: `cargo test -p freshell-freshagent sidecar_death -- --nocapture`

Expected: FAIL — the with-turn test finds no turn.complete frame today.

- [ ] **Step 3: Add the minimal production implementation**

In the unrequested-death arm (where `emit_fresh_agent_error(... SIDECAR_EXITED ...)` fires, claude.rs:8129-8179): if the consumer's turn latch (`in_turn`) was armed at EOF, mint and broadcast the edge BEFORE the session is evicted (capture the broadcast id first, mirroring the existing arm's ordering):

```rust
// Unified "needs attention": an unrequested sidecar death ends any in-flight
// turn — the user must come look. Requested deaths (kill/shutdown/teardown)
// stay silent: the user caused them or the pane is already gone.
if in_turn.load(Ordering::SeqCst) {
    let at = {
        let mut guard = session.last_synthesized_complete_at.lock().expect("synthesized clock");
        let at = freshell_codex::next_monotonic_turn_complete_at(*guard, now_ms());
        *guard = Some(at);
        at
    };
    let frame = ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({ "type": "freshAgent.turn.complete", "sessionId": sidecar_session_id, "at": at }),
        provider: PROVIDER.to_string(),
        session_id: broadcast_id.clone(),
        session_type: session_type.to_string(),
    });
    let _ = broadcast_tx.send(serde_json::to_string(&frame).expect("serialize"));
}
```

(Adapt to the arm's actual variable names; the `session_type` covers both freshclaude and kilroy. Requested deaths never reach this arm — the map entry is removed first, unchanged.)

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent sidecar_death in_turn_clears -- --nocapture`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — one mint site.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: `crates/freshell-ws/tests/freshagent_claude_rollback.rs` (`assert_never_completes` at :851-861 — the rollback lanes respawn the sidecar by REQUESTED paths and their conversations' results flow through the in-crate fake which never emits the edge; must stay green — verify and record), `freshagent_claude_kill_interrupt.rs` (kill lane — requested, silent), `rollback_during_a_compact_turn...` (:19396-19459, fake-driven, stays green).

Run: `cargo test -p freshell-freshagent claude && cargo test -p freshell-ws --test freshagent_claude_rollback --test freshagent_claude_kill_interrupt`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "feat(freshclaude): ring the unified attention edge when the sidecar dies with a turn in flight"
```

### Task 6: client contract updates, e2e spec updates, and the unified-signal e2e

**Files:**
- Modify: `src/store/turnCompletionThunks.ts:44-54` (doc comment), `test/unit/client/lib/fresh-agent-ws.test.ts:484-538` (premise comment + companion fold test)
- Modify: `test/e2e-browser/specs/restore-matrix.spec.ts:1129-1294` (crash lane)
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts:96-101, 674-734, 1926-2015` (deny + deadman lanes)
- Create: `test/e2e-browser/specs/fresh-agent-error-turn-attention.spec.ts` (new e2e)

**Interfaces:**
- Consumes: Tasks 1-5's server edges (same frame shape as today's success edges); the client pipeline unchanged (outcome-agnostic: fresh-agent-ws.ts:388-414, turnCompletionThunks.ts:55-104).
- Produces: e2e proof that an errored turn end in a background tab rings once, highlights tab+sidebar, and dismisses on visit.

- [ ] **Step 1: Update the inverted contracts (RED)**

1. `restore-matrix.spec.ts:1283-1289`: the `sentDuringCrash.some(type === 'freshAgent.turn.complete')` assertion reads the OUTBOUND browser→server ledger (vacuous w.r.t. server edges). Rewrite the lane to assert the crash RINGS via the server-frame path the harness exposes (mirror how `truly-idle-alerting.spec.ts` counts `turnCompletion.seq`): after the mid-turn crash of a freshcodex pane in a background tab, `turnCompletion.seq` increments by exactly 1 (the crash edge) — with the pane in the ACTIVE tab and the window focused it must NOT increment the bell count but the attention flag must still set (use the harness's focus/active-tab controls as the existing specs do).
2. `fresh-agent-control-rust.spec.ts`:
   - deny lane (:674-734): the sidecar-wire absence assertions stay literally green, but the browser-facing contract flips — after deny, the tab must now get attention (assert `turnCompletion.seq === 1` and the emerald tab class), and the lane's `:96-101` comment rewrites to "deny is an unwitnessed error turn end — it rings the unified edge".
   - deadman lane (:1926-2015): after the stuck card appears, assert the unified attention edge also fired (`turnCompletion.seq` bump for the pane's tab) and the "never a fabricated idle/turn-complete" comments are replaced with the new contract (the deadman rings deliberately).
3. `fresh-agent-ws.test.ts:484-538`: update the premise comment ("the deadman never fabricates a freshAgent.turn.complete" → "the STATUS frame itself dispatches no attention; the deadman's companion turn.complete edge is a separate frame") and add the companion assertion: a `freshAgent.status{stuck}` frame followed by a `freshAgent.turn.complete` frame for the same session folds status + attention independently (status fold dispatches no turnCompletion action; the edge dispatches recordTurnComplete — both asserted).
4. `turnCompletionThunks.ts:44-54`: reword the doc comment from "ONLY on a positive completion" to the unified contract ("any turn end except a user-initiated interrupt; crashes and deadman fires included").

- [ ] **Step 2: Run and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL for the new companion assertions (before the Task 4 fake parity is exercised — run against the branch state; if the server-side lanes aren't exercised by this unit file, the new assertions are pure fold tests that PASS; treat Step 1's unit-file edits as contract updates verified green here, with the true RED evidence in the e2e steps below).

- [ ] **Step 3: Add the new e2e spec**

`test/e2e-browser/specs/fresh-agent-error-turn-attention.spec.ts` — model it on `truly-idle-alerting.spec.ts`'s harness (fake claude sidecar, two tabs, `turnCompletion.seq` counting, tab class assertions):
1. Create tab A with a freshclaude agent and tab B with a shell; keep tab B active (background the agent tab), window focused.
2. Drive a turn that errors (the fake's deny/error lane: `__emit_result__` with `subtype: 'error_max_turns'`, or the approval-deny flow).
3. Assert: bell rings once (`turnCompletion.seq === 1`), tab A gets the emerald attention class, the pane session's sidebar row highlights; the pane icon shows green (idle state), no amber card.
4. Visit tab A → attention clears (click mode); send a new message → new turn; interrupt it via the pane's interrupt control while watching → assert NO new `turnCompletion` event (interrupt silence end-to-end).
5. Drive a second errored turn while the window is unfocused (harness blur) → the bell path is not directly observable; assert `seq` increments and the attention flag sets (the suppression is unit-pinned; e2e asserts the fold).

- [ ] **Step 4: Run the focused tests**

Run the affected e2e specs on the configured backend (default local):
`npx playwright test test/e2e-browser/specs/fresh-agent-error-turn-attention.spec.ts test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/restore-matrix.spec.ts --config test/e2e-browser/playwright.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Extract any repeated "drive errored turn" fixture helpers into the fake's support file if three specs duplicate them.

- [ ] **Step 6: Run impacted-test verification**

Run the full fresh-agent e2e directory plus the client unit files touching the fold:
`npm run test:vitest -- run test/unit/client/lib/fresh-agent-turn-complete.test.ts test/unit/client/lib/fresh-agent-ws.test.ts test/e2e/fresh-agent-turn-complete-notification.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/turnCompletionThunks.ts test/unit/client/lib/fresh-agent-ws.test.ts test/e2e-browser/specs/
git commit -m "test(fresh-agent): pin the unified attention signal end-to-end (errored turns ring; crash and deadman lanes invert)"
```

### Task 7: documentation contract update

**Files:**
- Modify: `AGENTS.md` ("Agent Status Indicators" paragraph), `docs/development/` only if a doc names the success-only rule (grep first; the rename-scope contract does not).

**Interfaces:** None (prose only). docs/index.html is NOT updated: the change alters WHICH events trigger the attention UX, not the UX surface itself.

- [ ] **Step 1: Rewrite the AGENTS.md contract paragraph**

Rewrite the "Agent Status Indicators" sentences that read "a discrete `freshAgent.turn.complete` edge emitted only on a positive completion — freshclaude/kilroy on the SDK `result` with `subtype === 'success'`, freshopencode on the success-only `emitStatus(idle)` path, and freshcodex on `turn/completed` only when `params.turn.status === 'completed'`" to the unified rule: every turn end the user didn't witness rings one identical edge — success, error, max-turns, crashed (sidecar death with a turn in flight), wedged/stuck (codex deadman), and approval/question (turn.waiting) — with only user-initiated interrupts silent; freshclaude/kilroy emit for any `result` subtype unless an accepted user interrupt consumed it, freshcodex for `completed`/`failed`/absent statuses, freshopencode for every settle except `turn_aborted`. Also correct the stale claim "only Claude/kilroy raise approvals/questions" (codex controls does too) and the "no chime — a crash is not a positive completion" phrasing for the codex crash self-heal (now: crash-while-busy rings; the exit still clears blue).

- [ ] **Step 2: Verify**

Run: `rg -n "positive completion|only on a positive|success-only" AGENTS.md docs/ src/ crates/ --glob '!node_modules'`

Expected: no stale success-only contract language remains (unrelated uses reviewed and left only if genuinely about other features).

- [ ] **Step 3: Commit the task**

```bash
git add AGENTS.md
git commit -m "docs(agents): rewrite the turn-complete attention contract to the unified needs-attention rule"
```

---

## Verification summary

- Unit/Rust per-task gates: as listed in each task's Step 4/6.
- End-of-execution full-suite gate: `npm test` (coordinated) from the worktree, green excluding ledger-recorded pre-existing failures.
- The user-visible outcome proof: `fresh-agent-error-turn-attention.spec.ts` (errored background turn → one bell + emerald tab + sidebar highlight; interrupt while watching → silence; crash + deadman lanes in the updated specs).

## Known accepted consequences (record for reviewers)

1. `FreshAgentView` treats every `freshAgent.turn.complete` as snapshot/transcript-invalidating, so error/crash/stuck endings now also trigger one snapshot refetch per visible pane (bounded; failed fetches flow into existing error/lost handling). Deliberately accepted — no client change.
2. A wedged codex turn that later genuinely completes fires two edges (stuck fire, then completion) — two honest events, two rings, monotonic `at` keeps them distinct. Accepted.
3. Two per-session `at` clocks exist where synthesized edges are minted (consumer clock vs synthesized clock in codex/claude); wall-clock advancement orders them in practice — same accepted regime as the existing controls-lane waiting clock.
4. Absent-status codex completions (outcome unknown) now ring — an ended turn is an ended turn.
5. Compacts follow the same widened rule as turns (their `result`/turn-completed ends ring on non-interrupt outcomes), for all three providers.
