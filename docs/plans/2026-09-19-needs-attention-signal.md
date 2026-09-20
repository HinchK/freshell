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

**Architecture:** The server-side emission widening is the core: the client pipeline is already outcome-agnostic in its FOLD (it reads only `{provider, sessionId, at}` from `freshAgent.turn.complete`/`turn.waiting` frames, fresh-agent-ws.ts:388-414), but the current client VIOLATES four explicit request constraints and gets small behavior changes (Task 6): (1) attention flags are persisted to localStorage and rehydrated on reload (`persistMiddleware.ts:726-733`, `turnCompletionSlice.ts:40-72`), highlighting pre-load turn endings — persistence is removed so a reload witnesses nothing; (2) a watched turn ending currently marks the tab flag AND the pane (`useTurnCompletionNotifications.ts:45-71` dispatches tab+pane attention before suppressing only the sound) — but the tab attention flag also drives the SIDEBAR row highlight (Sidebar.tsx:394-406), which for a split tab lights up sibling sessions that did not end; watched endings therefore get their OWN mark (`watchedCompletionByTab`) that renders on the TAB STRIP ONLY (same emerald styling), never touches attentionByTab/attentionByPane/sidebar/pane-header, and clears when the user navigates away and back (any later re-activation of the tab clears it — being re-activated implies the away leg); (3) the bell coalesces a whole effect-batch into one `play()` — it now rings once per event, and `useNotificationSound` gains a serialized ring queue (fresh Audio instance per ring; the next ring starts when the previous ends) so each event is AUDIBLY distinct instead of one restart-truncated chime; (4) `turnCompletionPersistence.test.ts`'s writer half (pins that persistMiddleware WRITES the attention maps) inverts along with the rehydration half. Each provider's emission guard changes from "positive completion only" to "any turn end except user-initiated interrupt": freshopencode drops the `succeeded`/`turn_errored` terms from its settle gate, freshcodex's `on_turn_completed` emits for `completed`/`failed`/absent statuses AND for `interrupted` WITHOUT a recorded user-interrupt marker (the freshagent interrupt lane records a per-session marker at the interrupt verb, mirroring opencode's `turn_aborted` — only user-caused interrupts are silent; the interrupt_rpc.rs test constructs its own subscription and must arm the marker explicitly), the freshclaude sidecar emits for any result subtype unless that session's gate holds a pending accepted user-interrupt mark (ordering-scoped: the SDK serializes turns within a query, so the interrupted turn's result is the first result after the settle — the mark is consumed by exactly that result and needs NO reset-at-send), and the crash/death wedged paths (codex exit-watcher with a turn in flight — the in-flight authority is a latch armed at start_turn DISPATCH, before awaiting its response, not the post-response quiet-window state; codex quiet deadman fire; freshclaude unrequested sidecar death with a turn in flight; freshclaude mid-turn stream exception gated on a send-scoped awaitingResult latch set at send-accept — `turnOpen` only arms after the first assistant/system frame and would miss the accept→first-message window; opencode failed settles) mint the same `freshAgent.turn.complete` frame with a per-session monotonic `at`. Test contracts that pinned "never a false completion" invert deliberately; docs and comments follow.

**Tech Stack:** Rust (freshell-codex, freshell-freshagent, freshell-ws crates, tokio), Node ESM (crates/freshell-claude-sidecar), TypeScript/React client (comments/contract tests only), Vitest (client + new sidecar gate unit test), Playwright e2e-browser.

## Global Constraints

- Red-Green-Refactor for every behavior change; never delete/weaken a test to pass — tests that pinned the old success-only contract are updated to pin the new unified contract (with the plan's per-test direction), never skipped.
- Relative TS imports need `.js` extensions where NodeNext/ESM applies (client code uses `@/` aliases; the sidecar package uses plain ESM).
- Rust: `cargo fmt` clean; pre-push gate runs typecheck + clippy + targeted cargo tests; PRs touching Rust must pass the required `rust-gate` check.
- Cargo test commands with MULTIPLE test filters must put the filters after `--` (`cargo test -p CRATE -- FILTER_A FILTER_B` — the libtest harness ORs them; cargo itself accepts only one positional filter before `--`).
- This machine's test backends are CONFIGURED cloud (`FRESHELL_VITEST_BACKEND=cloud`, `FRESHELL_E2E_BACKEND=cloud`): vitest lanes run via `npm run test:vitest -- ...` (the repo-owned path honoring the backend), and e2e verification runs the affected specs on the CONFIGURED backend (the cloud lane) — never a raw local-config Playwright invocation as the sole evidence. Affected/new e2e specs must actually run on the configured backend and must not sit in `CLOUD_SKIP_SPECS` (`test/e2e-browser/playwright.cloud.config.ts`).
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

Run: `cargo test -p freshell-freshagent -- errored_turn_emits failed_settle_emits --nocapture`

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

### Task 2: freshcodex — widen the turn/completed status guard with a user-interrupt marker

**Files:**
- Modify: `crates/freshell-codex/src/events.rs:151-185` (`on_turn_completed`) and its module doc `:6-15`
- Modify: the interrupt lane — trace from `crates/freshell-freshagent/src/codex/controls.rs` (interrupt verb) to the freshell-codex client call that issues the interrupt to the app server; add the marker where that lane can share state with `on_turn_completed` (the subscription/session state struct)
- Test: `crates/freshell-codex/tests/completion_gating.rs`, `crates/freshell-codex/tests/interrupt_rpc.rs`, `crates/freshell-codex/src/events.rs` in-file tests (:269-436), `crates/freshell-freshagent/src/codex.rs:13602-13652` (compact failed/interrupted test)

**Interfaces:**
- Consumes: `turn_status(&event.params)` (protocol.rs:355-368), `next_monotonic_turn_complete_at`, `TURN_STATUSES` = `completed|interrupted|failed|inProgress` (protocol.rs:28).
- Produces: new guard semantics consumed by all freshagent codex lanes: emit for `Some("completed") | Some("failed") | None`, and for `Some("interrupted")` WITHOUT a recorded user-interrupt marker; suppress for `Some("inProgress")` and `Some("interrupted")` WITH a pending user-interrupt marker (the marker is set by the interrupt control lane and consumed by the matching interrupted completion). The marker mirrors opencode's `turn_aborted` precedent: only a USER-initiated interrupt is silent — an automation/rollback-forced `interrupted` is a turn end the user didn't witness and rings.

- [ ] **Step 1: Write the failing behavioral tests**

Rewrite the status matrix in `crates/freshell-codex/tests/completion_gating.rs`:
- `each_status_gates_the_completion_edge_in_both_wire_shapes` (:38-82) → `each_status_routes_the_unified_attention_edge_in_both_wire_shapes`: for `completed` and `failed` (both wire shapes) assert snapshot + exactly one TurnComplete; for `inProgress` assert snapshot only; for `interrupted` WITH the user-interrupt marker armed assert snapshot only; for `interrupted` WITHOUT a marker assert snapshot + TurnComplete (non-user interrupts ring).
- `absent_status_and_foreign_thread_never_chime` (:84-104) → `absent_status_emits_the_edge_and_foreign_thread_never_does`: absent status now snapshot + TurnComplete; foreign thread unchanged (nothing).
- `only_completed_advances_the_monotonic_clock` (:106-137) → `every_edge_emitting_status_advances_the_monotonic_clock`: `failed` advances the clock like `completed`; marker-armed `interrupted` does not; same-ms `completed`→`failed` sequence gets strictly increasing `at`.

Update the in-file `events.rs` tests to the same direction:
- `interrupted_status_emits_snapshot_but_never_chimes` (:318-340) → `interrupted_status_with_a_user_interrupt_marker_emits_snapshot_only` (arm the marker first) — keep, plus a new sibling `interrupted_status_without_a_marker_emits_the_unified_edge`.
- `failed_status_never_chimes` (:342-355) → `failed_status_emits_the_unified_edge`.
- `in_progress_status_never_chimes` (:357-370) — unchanged contract, keep.
- `absent_status_never_chimes_but_still_snapshots` (:372-379) → `absent_status_emits_the_unified_edge_and_still_snapshots`.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-codex --test completion_gating`

Expected: FAIL — `failed`/absent cases produce no TurnComplete under the current guard, and the no-marker interrupted case cannot even be expressed (no marker API yet).

- [ ] **Step 3: Add the minimal production implementation**

1. Marker: add a per-session `user_interrupt_pending: Arc<StdMutex<bool>>` (or turn-id-keyed set if the session supports concurrent turns — verify; the app-server protocol has one active turn, a bool suffices) to the freshell-codex subscription/session state that `on_turn_completed` already reads. Set it in the interrupt control lane (where the user's interrupt verb is dispatched to the app server); expose a subscription-level arm handle so both the real control lane and the low-level `interrupt_rpc.rs` test (which constructs its own `CodexSubscription`, :77) can arm it; `on_turn_completed`'s interrupted branch consumes it (load + clear) and suppresses only when it was set.
2. Guard replacement at :173:

```rust
// events.rs — replace the guard at :173
// Unified "needs attention": every turn/completed that ENDED the turn rings
// except a USER-initiated interrupt (the interrupt lane arms the
// user_interrupt_pending marker; consume it here) and the non-terminal
// `inProgress` marker. `completed`, `failed`, an absent status (the turn
// ended, outcome unknown), and a NON-user `interrupted` (automation- or
// rollback-forced) all ring identically — the user didn't witness any of
// them.
let status = turn_status(&event.params);
match status.as_deref() {
    Some("inProgress") => return out,
    Some("interrupted") => {
        if user_interrupt_pending.swap(false, Ordering::SeqCst) {
            return out;
        }
    }
    _ => {}
}
```

(Adapt the marker access to the actual state-handle shape `on_turn_completed` holds; if the guard site cannot reach the session state, thread the Arc the same way the subscription's `last_turn_complete_at` is threaded — both are per-session liveness-scoped.)

Update the module doc at events.rs:6-15 to state the unified rule (user-armed interrupts and inProgress stay silent; completed/failed/absent and non-user interrupted ring).

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-codex --test completion_gating && cargo test -p freshell-codex events::`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — guard replacement; doc comments updated in place.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every codex test touching the guard's output — `interrupt_rpc.rs` (`interrupt_turn_rpc_then_interrupted_completion_snapshots_without_chime` — drives the REAL interrupt lane, so the marker arms and it stays green), `app_server_drive.rs` `full_drive_interrupted_turn_does_not_chime` (same — verify its interrupt goes through the marker-arming lane; if it fabricates the completion directly, arm the marker in the test), and in freshagent `codex.rs`: `handle_compact_failed_or_interrupted_turn_produces_no_completion_chime` (:13602-13652) — SPLIT into `handle_compact_failed_turn_emits_the_unified_edge` (failed compact now rings; update assertions) and `handle_compact_interrupted_turn_with_a_user_interrupt_stays_silent` (drive the real interrupt lane so the marker arms; the interrupted half stays silent); `completed_turn_yields_snapshot_then_chime_frames` (:9897-9926, stays green); the superseded/stale-completion legs (:12842, :12994, :13143, :13265, stay green); `handle_send_always_broadcasts_accepted_before...` (stays green); `turn_complete_event_frames_carry_the_inner_type` (stays green).

Run: `cargo test -p freshell-freshagent codex -- --nocapture`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None — guard replacement; doc comments updated in place.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: every codex test touching the guard's output — `interrupt_rpc.rs` `interrupt_turn_rpc_then_interrupted_completion_snapshots_without_chime` — CRITICAL: this test does NOT drive `FreshCodexState::handle_interrupt`; it calls the low-level `CodexAppServerClient::interrupt_turn` (:45), then constructs a fresh `CodexSubscription` (:77) and feeds it the interrupted notification directly (:75) — so the marker will NOT be armed by the real lane and the test would flip red. Update it to arm the marker explicitly on its subscription (the marker API must be reachable from the subscription the test constructs) and KEEP the silent expectation; it now pins "marker-armed interrupt is silent" at the RPC seam. `app_server_drive.rs` `full_drive_interrupted_turn_does_not_chime` — verify whether its interrupt goes through the real handle_interrupt lane (marker arms → stays green) or fabricates the completion (then arm the marker explicitly the same way). In freshagent `codex.rs`: `handle_compact_failed_or_interrupted_turn_produces_no_completion_chime` (:13602-13652) — SPLIT into `handle_compact_failed_turn_emits_the_unified_edge` (failed compact now rings; update assertions) and `handle_compact_interrupted_turn_with_a_user_interrupt_stays_silent` (drive the real interrupt lane so the marker arms, or arm the marker explicitly if the test fabricates the event; the interrupted half stays silent); `completed_turn_yields_snapshot_then_chime_frames` (:9897-9926, stays green); the superseded/stale-completion legs (:12842, :12994, :13143, :13265, stay green); `handle_send_always_broadcasts_accepted_before...` (stays green); `turn_complete_event_frames_carry_the_inner_type` (stays green).

Run: `cargo test -p freshell-freshagent codex -- --nocapture` && `cargo test -p freshell-codex`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-codex/src/events.rs crates/freshell-codex/src/lib.rs crates/freshell-codex/tests/completion_gating.rs crates/freshell-codex/tests/interrupt_rpc.rs crates/freshell-freshagent/src/codex.rs
git commit -m "feat(freshcodex): ring the unified attention edge for failed and unknown-status turn ends; only user-armed interrupts stay silent"
```

### Task 3: freshcodex — crash (exit-watcher) and wedged (quiet deadman) turn ends emit the unified edge

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` — `CodexSession` struct (:358-390, add per-session synthesized-edge clock), crash arm of `spawn_exit_watcher` (:8691-8790), `disarm_codex_quiet` (:8868-8882), deadman waiter `watch_codex_quiet_deadline` (:6457-6498)
- Test: `crates/freshell-freshagent/src/codex.rs` (`onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped` :15846-15896; deadman tests :10302-10674)

**Interfaces:**
- Consumes: `CodexAdapterEvent::TurnComplete { session_id, at }` and `adapter_event_to_frame` (codex.rs:9123-9159), `next_monotonic_turn_complete_at`, `QuietDeadman` fields (`deadline`, `stuck_since`), `quiet_handles` (:6419-6427), `now_ms()`.
- Produces: `CodexSession.synthesized_attention_at: Arc<StdMutex<Option<i64>>>` — the per-session monotonic clock for edges minted OUTSIDE the consumer (crash/deadman). PREFER sharing the consumer subscription's own `last_turn_complete_at` Arc (thread it into the exit-watcher and the deadman at spawn, the same way `quiet_deadman` is threaded) so ordinary and synthesized edges use ONE clock and can never collide; fall back to a second `synthesized_attention_at` clock ONLY if the consumer's handle genuinely cannot reach those sites — then wall-clock advancement keeps the two ordered in practice (a cross-clock NTP-backwards collision would at worst swallow one edge; accepted residual, same regime as controls.rs's waiting clock).

- [ ] **Step 1: Write the failing behavioral tests**

1. Extend `onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped` — rename to `onexit_self_heal_emits_exited_and_rings_the_unified_edge_when_a_turn_was_in_flight`, and add a twin `onexit_self_heal_emits_exited_without_an_edge_when_idle`:
   - with a turn in flight at crash: assert the `freshAgent.status{exited}` frame AND a `freshAgent.turn.complete` frame (finite numeric `at`) for the same session; session stays mapped.
   - idle crash: `freshAgent.status{exited}` only, NO turn.complete (the `rx.try_recv()` no-edge assertion as today).
2. Deadman: update `quiet_deadman_fires_stuck_status_without_fabricating_a_turn_complete` (:10302-10394) → `quiet_deadman_fires_stuck_and_rings_the_unified_attention_edge`: on fire, assert BOTH the `freshAgent.status{stuck}` frame and a `freshAgent.turn.complete` frame; `quiet_deadman_resolves_on_turn_completion` (:10396-10524) additionally asserts the resolution leg emits NO second edge from the deadman and the (now widened, Task 2) genuine completion still rings exactly once.

- [ ] **Step 2: Run and verify the intended failure**

Run: `cargo test -p freshell-freshagent -- onexit_self_heal quiet_deadman --nocapture`

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
2. Crash arm (codex.rs:8691-8790): the turn-in-flight authority must be a latch armed at start_turn DISPATCH — BEFORE awaiting its response — not the quiet-window state (`handle_send` arms the quiet timer only after the start_turn response is processed, codex.rs:2861→:6592, while the independently-running exit watcher can observe an immediate post-response exit first; a real accepted turn would be classified idle and miss its crash edge, or the deadman arms after the sidecar is already gone). Verify where `handle_send`'s `arm_turn_op(&in_turn, ...)` (:4235) sits relative to the `start_turn(...).await` (:2861): if the in_turn latch is armed before the await, use it; otherwise arm it (and the quiet window) at dispatch time and disarm on dispatch/response failure. Then in the crash arm, when the captured latch says a turn was in flight: after `disarm_codex_quiet(...)` and after broadcasting `Status{Exited}`, mint and broadcast:
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
3. Deadman fire (codex.rs:6457-6498): in the `fired == true` branch, after the `Status{Stuck}` broadcast, mint + broadcast the same TurnComplete frame using the shared per-session clock (the waiter already has the session's quiet handle; extend it or read the clock via the same session map access it already uses for `active_turn`). The deadman's own arming moves to dispatch time with the in-flight latch (step 2) so it cannot arm after the sidecar is already gone; its existing disarm-on-terminal-status paths are unchanged.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent -- onexit_self_heal quiet_deadman --nocapture`

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
- Modify: `crates/freshell-claude-sidecar/index.mjs` — result case (:279-300), `handleInterrupt` (:483-506), `consumeStream` catch arm (:311-331), sidecar protocol doc (:34-35), ADR comment (:49-52)
- Test: `test/unit/sidecar/claude-turn-complete-gate.test.ts` (new; imports the pure module by relative path)
- Modify: `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` (:251-258 guard + interrupt handling + crash lane) — parity with the real sidecar

**Interfaces:**
- Consumes: per-session sidecar state `st` (add `st.turnCompleteGate` and `st.awaitingResult`), `nextMonotonic` (:170-172), SDK result message (`subtype: 'success' | 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'`), `sdk.interrupt_settled{ok}` frames (settle lands BEFORE the interrupted turn's result per the SDK contract, sdk.d.ts:3765), the send-accept site (where `st.awaitingResult` arms — NOT `turnOpen`, which only arms after the first assistant/system frame, index.mjs:217-222).
- Produces: `createTurnCompleteGate()` — pure state machine with `noteInterruptRequest()`, `noteInterruptSettled(ok: boolean)`, `resultEmitsAttention(): boolean` (consumes a pending mark; ALWAYS returns true when no mark). NO `reset()` and NO reset-at-send: the SDK serializes turns within one query (a queued send is input pushed onto the same stream; results arrive in turn order), so the interrupted turn's result is deterministically the FIRST result after the accepted settle — the mark is consumed by exactly that result. A reset-at-send would race (a queued send clears the mark before the interrupted turn's late result arrives → the user's own interrupt rings); lifecycle bounds staleness instead (the mark dies with the session state in `consumeStream`'s `sessions.delete`). Emission rule: EVERY result emits `sdk.turn.complete` (any subtype — success, error_*, success-with-is_error) EXCEPT a result consumed by a pending accepted user-interrupt mark.

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

  it('a mark survives a queued send and still consumes only the interrupted turn\'s result (no reset-at-send)', () => {
    // Ordering contract: the SDK serializes turns within one query, so the
    // interrupted turn's result is the FIRST result after the settle even if
    // the next prompt was queued before it arrived.
    const gate = createTurnCompleteGate()
    gate.noteInterruptRequest()
    gate.noteInterruptSettled(true)
    // (queued send happens here — the gate deliberately does NOT reset)
    expect(gate.resultEmitsAttention()).toBe(false) // interrupted turn's late result
    expect(gate.resultEmitsAttention()).toBe(true)  // the queued turn's own result
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
 * clears the mark.
 *
 * There is DELIBERATELY no reset-on-send: the SDK serializes turns within
 * one query (a queued send is input pushed onto the same stream, and
 * results arrive in turn order), so the interrupted turn's result is
 * deterministically the FIRST result after the accepted settle. A
 * reset-at-send would race a queued send against the interrupted turn's
 * late result and let the user's own interrupt ring. Staleness is bounded
 * by the session lifecycle instead — the mark dies with the session state
 * when consumeStream's finally deletes it.
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
  }
}
```

`index.mjs` wiring (per session state `st`):
1. Create the gate and `awaitingResult: false` where the session state is initialized (alongside `lastTurnCompleteAt`); arm `st.awaitingResult = true` where a send is accepted (the input-stream push succeeding). Do NOT reset the gate on send/create — see the module doc's ordering argument.
2. In `handleInterrupt` (:483-506): call `st.turnCompleteGate.noteInterruptRequest()` immediately before `st.query.interrupt()`; in the `.then` arm call `noteInterruptSettled(true)`, in the `.catch` arm `noteInterruptSettled(false)`.
3. In the result case (:279-300): replace the `if (msg.subtype === 'success')` block with the following — and clear `st.awaitingResult = false` at the TOP of the result case (the awaited turn's terminal frame arrived; the catch arm must not fire for it):

```js
      // Unified attention edge: any turn end rings unless this result is the
      // interrupted turn's own (the SDK contract orders the settle receipt
      // before it). No outcome rides the wire — the client treats all ends
      // identically.
      st.awaitingResult = false
      if (st.turnCompleteGate.resultEmitsAttention()) {
        const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
        st.lastTurnCompleteAt = at
        emit({ type: 'sdk.turn.complete', sessionId, at })
      }
```

4. In `consumeStream`'s catch arm (:315-316) — a mid-turn stream EXCEPTION ends the turn without any result frame and without process death (the sidecar stays alive), so it must ring on its own. Do NOT gate this on `st.turnOpen`: that latch arms only on the first assistant/system frame (index.mjs:217-222), so a stream failing after prompt-accept but BEFORE the first provider message would slip through. Gate on a new send-scoped latch instead — `st.awaitingResult`, set true where a send is accepted (the input-stream push succeeding, the same place a turn's prompt is handed to the SDK), cleared at the result case (where `turnOpen` clears) and cleared defensively in `consumeStream`'s finally alongside the session teardown:

```js
  } catch (err) {
    emit({ type: 'sdk.error', sessionId, message: `SDK error: ${err?.message || 'Unknown error'}` })
    // A stream exception mid-turn IS a turn end the user didn't witness —
    // ring the unified edge (the abort/sdk.exit path is a REQUESTED
    // teardown and deliberately stays silent). awaitingResult covers the
    // accept→first-message window turnOpen cannot see.
    if (st?.awaitingResult && st.turnCompleteGate.resultEmitsAttention()) {
      const at = nextMonotonic(st.lastTurnCompleteAt, Date.now())
      st.lastTurnCompleteAt = at
      emit({ type: 'sdk.turn.complete', sessionId, at })
    }
  }
```

5. Update the protocol doc at :34-35 and the ADR comment at :49-52 to the new contract (an accepted user interrupt's result is consumed silently; the stale "interrupts yield no result at all" claim is corrected; a mid-turn stream exception emits the attention edge).

6. `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs`: replace the `if (subtype === 'success')` guard (:251-258) with the same gate logic — import `createTurnCompleteGate` from the real sidecar package. The fake's interrupt arm (:408-440) exists but only models the no-in-flight-query shape (settle `ok:false`, no result after) — for the interrupt-silence e2e to be non-vacuous, EXTEND it: an interrupt while a turn is in flight settles `ok:true` and is followed by the interrupted turn's own non-success `sdk.result` (mirroring the real SDK contract, sdk.d.ts:3765), which the fake's gate must then suppress. For the stream-exception path, add a NEW scripted lane (e.g. `stream-error`) that models the real `consumeStream` catch arm: mid-turn it emits `sdk.error` + `sdk.turn.complete` (gate consulted) and tears down the session WITHOUT exiting the process — keep the existing `crash` lane's semantics untouched (a real crash screams no protocol frame and exits the process, :268-269/:454; the Rust unrequested-death synthesis in Task 5 is what rings for it, and emitting an edge from the fake's crash lane would double-ring). The deny-lane e2e (fresh-agent-control-rust.spec.ts:674-734 asserts `sdk.turn.complete` absence up to idle after deny) will be updated in Task 7 to expect the edge.

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
Also update the death arm (c) of `in_turn_clears_on_exactly_the_four_contract_edges_fail_closed_otherwise` (:19265-19349) — busy-clearing stays, and add the edge assertion for the in-flight case. And HARDEN the latch contract: `sdk.turn.complete` becomes a fifth in_turn-clearing edge (today Rust does NOT clear in_turn on it — only result/idle/EOF — so a sidecar that emits the edge and then dies without a result would double-ring: the sidecar edge plus the Rust death synthesis). Rename the test accordingly (`..._five_contract_edges_...`) and add the turn.complete case: armed in_turn + a `sdk.turn.complete` frame + unrequested death → exactly ONE edge total (the sidecar's; the death arm sees the cleared latch and stays silent).

**Sandbox scope note:** these tests SIGKILL only their OWN spawned fixture sidecar children — the exact class of the existing `sidecar_death_*` and `freshagent_claude_kill_interrupt` in-crate/integration tests, which run in the standard cargo suite. The destructive-test-sandbox rule (`scripts/sandbox-test.sh`) targets host-affecting process-kill/config-corruption/restart-storm suites; it does not apply to killing one's own test children, per the existing precedent.

- [ ] **Step 2: Run and verify the intended failure**

Run: `cargo test -p freshell-freshagent sidecar_death -- --nocapture`

Expected: FAIL — the with-turn test finds no turn.complete frame today.

- [ ] **Step 3: Add the minimal production implementation**

**Placement (critical):** by the time control reaches the unrequested-death arm (:8129-8179), the EOF handling has ALREADY cleared `in_turn` (:8098-8113) and evicted the session from the map (:8119-8128) — so reading `in_turn` or the session there is always false/gone. Capture the pre-state at the TOP of the EOF handling, before any clearing/eviction:

1. At EOF-detected entry (before :8098): capture `let turn_was_in_flight = in_turn.load(Ordering::SeqCst);` and clone the clock handle + ids the death arm needs (`session.last_synthesized_complete_at` Arc clone, broadcast id, sidecar session id, session_type) into locals that survive the eviction.
2. In the unrequested-death arm (where `emit_fresh_agent_error(... SIDECAR_EXITED ...)` fires), mint using the CAPTURED values — not the (now-cleared) latch or the (now-evicted) session:

```rust
// Unified "needs attention": an unrequested sidecar death ends any in-flight
// turn — the user must come look. Requested deaths (kill/shutdown/teardown)
// stay silent: the user caused them or the pane is already gone. The armed
// state was captured at EOF entry — the code below the eviction site has
// already cleared in_turn and dropped the session, so it cannot be read here.
if turn_was_in_flight {
    let at = {
        let mut guard = last_synthesized_complete_at.lock().expect("synthesized clock");
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

(Adapt to the arm's actual variable names; the `session_type` covers both freshclaude and kilroy. Requested deaths never reach this arm — the map entry is removed first, unchanged. The clock Arc lives on after eviction because it was cloned out at capture time; if the session struct is not reachable at EOF entry either, store the clock Arc in the same map/slot the consumer already holds for the session's liveness.)

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent -- sidecar_death in_turn_clears --nocapture`

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

### Task 6: client behavior corrections — no persisted attention, watched = tab-strip-only mark, audibly distinct bell per event

**Files:**
- Modify: `src/store/turnCompletionSlice.ts:40-72` (rehydrate path + new watched-mark state), `src/store/persistMiddleware.ts:726-733` (persisted keys), `src/hooks/useTurnCompletionNotifications.ts:45-71` (mark + sound effect), `src/hooks/useNotificationSound.ts` (ring queue), `src/components/TabItem.tsx` (tab-strip attention styling unions the watched mark), `src/store/turnCompletionAttention.ts` (selectors expose the union for the tab strip)
- Modify (selection clear): the existing tab-selection middleware/home (`src/store/paneSelectionMiddleware.ts` or wherever `setActiveTab` is observed) — activating a tab clears that tab's watched mark (the away-and-back clear)
- Test: `test/unit/client/store/turnCompletionPersistence.test.ts`, `test/unit/client/hooks/useTurnCompletionNotifications.test.tsx`, `test/unit/client/hooks/useNotificationSound.test.tsx`

**Interfaces:**
- Consumes: the existing `recordTurnComplete`/attention action shapes and selectors (unchanged); the fold from Task 5's edges.
- Produces: (1) `attentionByTab`/`attentionByPane` are no longer persisted to localStorage nor rehydrated on load — a page reload witnesses NOTHING (pre-load turn ends produce no highlight, honoring "reload... highlights no tabs for turn ends that happened before the page loaded"); (2) a watched turn ending (window focused AND the event's tab is the active tab) dispatches ONLY `markTabWatchedCompletion({tabId})` — new state `watchedCompletionByTab` that renders on the TAB STRIP ONLY (TabItem unions `attentionByTab ∪ watchedCompletionByTab` for its emerald styling; NOT persisted). The sidebar row and pane-header mark stay driven by attentionByTab/attentionByPane and are therefore NOT touched by watched endings — the strict "visual mark on the tab only" (attentionByTab also highlights every session row of a split tab, including siblings that did not end, so it cannot carry the watched mark). Clearing: any later re-activation of the tab clears its watched mark (re-activation implies the navigate-away leg happened — "the mark clears next time you navigate away and back"); (3) the bell rings once per event, AUDIBLY: `useNotificationSound.play()` enqueues a ring and a serial driver starts each ring on a FRESH Audio instance when the previous one ends (today every call pauses/rewinds/restarts ONE shared Audio object, so back-to-back events truncate each other into one chime); queue cap 5 pending rings (a >5 simultaneous-end burst drops the excess — recorded consequence).

- [ ] **Step 1: Write the failing behavioral tests (RED)**

1. `test/unit/client/store/turnCompletionPersistence.test.ts` — BOTH halves invert:
   - the writer test (:18-40): after `markTabAttention`/`markPaneAttention` and the persist debounce, the persisted payload must NOT contain attention keys (the maps are no longer persisted).
   - the rehydration test (:42-56): after a rehydrate from a persisted payload containing attention entries, `attentionByTab`/`attentionByPane` must be EMPTY.
   Keep green every assertion about OTHER persisted turnCompletion state (only the attention maps drop out of the contract).
2. `test/unit/client/hooks/useTurnCompletionNotifications.test.tsx`:
   - the mark matrix (:151-192): the watched case (focused window + active tab) now asserts the watched mark SET (`watchedCompletionByTab[tabId]`), `attentionByTab` NOT set, `attentionByPane` NOT set, no sound; every background case keeps tab+pane attention marks + per-event sound.
   - the burst case (:236-259) SPLITS (the existing fixture's first event belongs to the watched active tab — expecting two plays for it would contradict the watched silence):
     - mixed batch (one watched-tab event + one background-tab event): exactly ONE `play()` call.
     - double-background batch (two background-tab events): TWO `play()` calls — one per event.
   - a new watched-clear case: after a watched mark is set, activating a different tab and then re-activating the original tab clears `watchedCompletionByTab` (dispatch the selection actions the same way the app does; assert the mark is gone).
3. `test/unit/client/hooks/useNotificationSound.test.tsx` — pin the ring queue: two `play()` calls in the same tick → ring 1 starts immediately, ring 2 starts only after ring 1's audio ENDS (assert via the audio element's ended callback / fake audio); a third `play()` while two rings are queued still results in three distinct sequential rings. Update any existing single-Audio restart expectations to the queue contract.

- [ ] **Step 2: Run and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/store/turnCompletionPersistence.test.ts test/unit/client/hooks/useTurnCompletionNotifications.test.tsx test/unit/client/hooks/useNotificationSound.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — attention persists/rehydrates today, watched endings mark tab+pane attention, the burst coalesces to one play, and the sound hook restarts one shared Audio.

- [ ] **Step 3: Add the minimal production implementation**

1. `persistMiddleware.ts:726-733`: drop the attention keys from the persisted turnCompletion payload.
2. `turnCompletionSlice.ts:40-72`: the rehydrate path ignores/strips attention entries (no restoration of `attentionByTab`/`attentionByPane`); add `watchedCompletionByTab` state + `markTabWatchedCompletion`/`clearTabWatchedCompletion` actions (not persisted).
3. `useTurnCompletionNotifications.ts:45-71`: per processed event — if watched (window focused AND active tab id matches the event's tab id): dispatch `markTabWatchedCompletion` only (no attention marks, no sound); otherwise: dispatch tab + pane attention marks and call `play()` once for THIS event. The batch-level `anyCompletion` boolean and single trailing `play()` go away.
4. `useNotificationSound.ts`: `play()` enqueues a ring (cap 5 pending); a serial driver starts each ring on a fresh `Audio` instance for the chime source and advances when the previous ring's `ended` event fires (the existing sound-off fallback tone and chime-load-failure fallback logic are preserved per ring).
5. `turnCompletionAttention.ts`/`TabItem.tsx`: the tab strip's emerald attention styling renders for `attentionByTab[tabId] || watchedCompletionByTab[tabId]`; the sidebar and pane-header derivations are untouched.
6. Watched-mark clear: observe tab activation (the existing selection middleware/home) and dispatch `clearTabWatchedCompletion` for the newly-activated tab (re-activation = the away-and-back round trip completed).

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/store/turnCompletionPersistence.test.ts test/unit/client/hooks/useTurnCompletionNotifications.test.tsx test/unit/client/hooks/useNotificationSound.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the watched-check or ring-queue logic repeats, extract a tiny local predicate/helper in the owning file; no new modules.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: anything asserting persisted/rehydrated attention, bell counts, or the tab-strip attention styling — `rg -n "attentionByTab|attentionByPane|watchedCompletion" src/ test/` (review each hit: TabItem/TabBar/Sidebar selectors, the persistence tests, the notification tests), plus `test/e2e/fresh-agent-turn-complete-notification.test.tsx` (bell-count and attention expectations — update to per-event rings and the watched/b background mark split as needed).

Run: `npm run test:vitest -- run test/unit/client/store/ test/e2e/fresh-agent-turn-complete-notification.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/turnCompletionSlice.ts src/store/persistMiddleware.ts src/store/turnCompletionAttention.ts src/hooks/useTurnCompletionNotifications.ts src/hooks/useNotificationSound.ts src/components/TabItem.tsx src/store/paneSelectionMiddleware.ts test/unit/client/store/turnCompletionPersistence.test.ts test/unit/client/hooks/useTurnCompletionNotifications.test.tsx test/unit/client/hooks/useNotificationSound.test.tsx
git commit -m "feat(client): unified attention signal client corrections — no persisted attention, watched endings mark the tab strip only, audibly distinct bell per event"
```

### Task 7: wire-contract comments, e2e spec updates, and the unified-signal e2e on the configured backend

**Files:**
- Modify: `src/store/turnCompletionThunks.ts:44-54` (doc comment), `test/unit/client/lib/fresh-agent-ws.test.ts:484-538` (premise comment + companion fold test)
- Modify: `test/e2e-browser/specs/restore-matrix.spec.ts:1129-1294` (crash lane)
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts:96-101, 674-734, 1926-2015` (deny + deadman lanes)
- Create: `test/e2e-browser/specs/fresh-agent-error-turn-attention.spec.ts` (new e2e)

**Interfaces:**
- Consumes: Tasks 1-6's server edges and client corrections (same frame shape as today's success edges; the fold stays outcome-agnostic).
- Produces: e2e proof that an errored turn end in a background tab rings once, highlights tab+sidebar, and dismisses on visit — running on the CONFIGURED e2e backend.

- [ ] **Step 1: Update the inverted contracts (RED)**

1. `restore-matrix.spec.ts:1283-1289`: the `sentDuringCrash.some(type === 'freshAgent.turn.complete')` assertion reads the OUTBOUND browser→server ledger (vacuous w.r.t. server edges). Rewrite the lane as TWO explicit scenarios (the old sentence conflated them):
   - Scenario A (unwitnessed): a freshcodex pane's turn is in flight in a BACKGROUND tab, the sidecar crashes (the fake's silent `crash` lane — process death, no protocol frame) → assert `turnCompletion.seq` increments by exactly 1 (the Rust unrequested-death synthesis from Task 5) AND the bell rings.
   - Scenario B (watched): the same crash repeated with the pane's tab ACTIVE and the window focused → assert NO bell, but the tab strip shows the watched emerald mark (Task 6's `watchedCompletionByTab` rendering) and NO sidebar row highlight appears for the pane's session (the strict watched contract).
   Use the harness's focus/active-tab controls as the existing specs do.
2. `fresh-agent-control-rust.spec.ts`:
   - deny lane (:674-734): the sidecar-wire absence assertions stay literally green, but the browser-facing contract flips — after deny, the tab must now get attention (assert `turnCompletion.seq === 1` and the emerald tab class), and the lane's `:96-101` comment rewrites to "deny is an unwitnessed error turn end — it rings the unified edge".
   - deadman lane (:1926-2015): after the stuck card appears, assert the unified attention edge also fired (`turnCompletion.seq` bump for the pane's tab) and the "never a fabricated idle/turn-complete" comments are replaced with the new contract (the deadman rings deliberately).
3. `fresh-agent-ws.test.ts:484-538`: update the premise comment ("the deadman never fabricates a freshAgent.turn.complete" → "the STATUS frame itself dispatches no attention; the deadman's companion turn.complete edge is a separate frame") and add the companion assertion: a `freshAgent.status{stuck}` frame followed by a `freshAgent.turn.complete` frame for the same session folds status + attention independently (status fold dispatches no turnCompletion action; the edge dispatches recordTurnComplete — both asserted).
4. `turnCompletionThunks.ts:44-54`: reword the doc comment from "ONLY on a positive completion" to the unified contract ("any turn end except a user-initiated interrupt; crashes, deadman fires, and mid-turn stream exceptions included").

- [ ] **Step 2: Run and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`

Expected: the companion fold assertions PASS as pure fold tests (the true RED evidence for the e2e lanes is exercised in Step 4); treat this run as the contract-update verification and record it.

- [ ] **Step 3: Add the new e2e spec**

`test/e2e-browser/specs/fresh-agent-error-turn-attention.spec.ts` — model it on `truly-idle-alerting.spec.ts`'s harness (fake claude sidecar, two tabs, `turnCompletion.seq` counting, tab class assertions), but build it CLOUD-LEGAL: drive everything through the fake's deterministic `__emit_*__` lanes — NO idle-grace-period or shade-transition timing dependencies (the exact patterns that put `truly-idle-alerting.spec.ts` itself in `CLOUD_SKIP_SPECS`; the new spec must NOT end up skipped):
1. Create tab A with a freshclaude agent and tab B with a shell; keep tab B active (background the agent tab), window focused.
2. Drive a turn that errors (the fake's deny/error lane: `__emit_result__` with `subtype: 'error_max_turns'`, or the approval-deny flow).
3. Assert: bell rings once (`turnCompletion.seq === 1`), tab A gets the emerald attention class, the pane session's sidebar row highlights, and the pane-header mark is set (unwatched endings mark everything).
4. Visit tab A → attention clears (click mode); send a new message → new turn; interrupt it via the pane's interrupt control while watching → assert NO new `turnCompletion` event (interrupt silence end-to-end), the tab strip shows the WATCHED emerald mark, and NO sidebar row or pane-header highlight appears for it (strict "tab only"); then navigate away to tab B and back to tab A → the watched mark clears. Drive the IN-FLIGHT interrupt shape via the fake sidecar's extended interrupt arm (Task 4): turn in flight → interrupt → settle `ok:true` → the interrupted turn's non-success `sdk.result` follows — the gate must suppress the edge, proving the silence is the GATE's doing, not a missing result frame (the fake's pre-existing no-in-flight arm would make this step vacuous).
5. Drive a second errored turn while the window is unfocused (harness blur) → the bell path is not directly observable; assert `seq` increments and the attention flag sets (the suppression is unit-pinned in Task 6; e2e asserts the fold).
6. Drive the mid-turn stream-exception lane: freshclaude turn in flight in a background tab → the fake's NEW `stream-error` lane (Task 4: `sdk.error` + `sdk.turn.complete`, NO process exit) → assert the unified edge rings (`turnCompletion.seq` increments by exactly 1), the pane resolves to idle, and the sidecar process is still alive (no unrequested-death double edge). Keep the `crash` lane (silent process death) for the Rust-synthesis lane asserted in `restore-matrix.spec.ts`.

- [ ] **Step 4: Run the affected e2e specs on the CONFIGURED backend**

1. First verify the backend scope: `rg -n "fresh-agent-error-turn-attention|fresh-agent-control-rust|restore-matrix" test/e2e-browser/playwright.cloud.config.ts` — none of the three may appear in `CLOUD_SKIP_SPECS` (`fresh-agent-control-rust.spec.ts` and `restore-matrix.spec.ts` are NOT skipped today; the new spec must not be added there either). A spec sitting in the skip list or a filter that matched no tests is NOT coverage.
2. Inner-loop iteration may use local runs (`npm run test:e2e:local --` scoped to the three specs, or the local Playwright config), but the EVIDENCE run is the configured backend (`FRESHELL_E2E_BACKEND=cloud`): `npm run test:e2e` (full cloud lane — it runs the affected specs as part of the suite; if the cloud lane supports spec passthrough filtering, scope it to the three specs). Expected: PASS with the three specs actually executed on the cloud lane (confirm they ran, not filtered).

- [ ] **Step 5: Refactor while green**

Extract any repeated "drive errored turn" fixture helpers into the fake's support file if three specs duplicate them.

- [ ] **Step 6: Run impacted-test verification**

Run the client unit files touching the fold on the repo-owned vitest path (configured backend):
`npm run test:vitest -- run test/unit/client/lib/fresh-agent-turn-complete.test.ts test/unit/client/lib/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/store/turnCompletionThunks.ts test/unit/client/lib/fresh-agent-ws.test.ts test/e2e-browser/specs/
git commit -m "test(fresh-agent): pin the unified attention signal end-to-end (errored turns ring; crash, deny, and deadman lanes invert; configured-backend evidence)"
```

### Task 8: documentation contract update

**Files:**
- Modify: `AGENTS.md` ("Agent Status Indicators" paragraph), `docs/development/` only if a doc names the success-only rule (grep first; the rename-scope contract does not).

**Interfaces:** None (prose only). docs/index.html is NOT updated: the change alters WHICH events trigger the attention UX, not the UX surface itself.

- [ ] **Step 1: Rewrite the AGENTS.md contract paragraph**

Rewrite the "Agent Status Indicators" sentences that read "a discrete `freshAgent.turn.complete` edge emitted only on a positive completion — freshclaude/kilroy on the SDK `result` with `subtype === 'success'`, freshopencode on the success-only `emitStatus(idle)` path, and freshcodex on `turn/completed` only when `params.turn.status === 'completed'`" to the unified rule: every turn end the user didn't witness rings one identical edge — success, error, max-turns, crashed (sidecar death with a turn in flight), mid-turn stream exception, wedged/stuck (codex deadman), and approval/question (turn.waiting) — with only USER-initiated interrupts silent; freshclaude/kilroy emit for any `result` subtype unless an accepted user interrupt's gate consumed it, freshcodex for `completed`/`failed`/absent statuses and non-user `interrupted` (the interrupt lane arms a per-session marker; only marker-armed interrupts are silent), freshopencode for every settle except `turn_aborted`. Also update the client-side sentences: attention flags are no longer persisted across reloads (a reload witnesses nothing), watched endings set a tab-strip-only watched mark (no sidebar row, no pane-header mark, no sound; it clears on away-and-back), and the bell rings audibly once per event via a serialized ring queue. Also correct the stale claim "only Claude/kilroy raise approvals/questions" (codex controls does too) and the "no chime — a crash is not a positive completion" phrasing for the codex crash self-heal (now: crash-while-busy rings; the exit still clears blue).

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
- E2e evidence runs on the CONFIGURED backend (`FRESHELL_E2E_BACKEND=cloud`): the three affected specs must actually execute (not be skipped/filtered) and pass on the cloud lane.
- End-of-execution full-suite gate: `npm test` (coordinated) from the worktree, green excluding ledger-recorded pre-existing failures.
- The user-visible outcome proof: `fresh-agent-error-turn-attention.spec.ts` (errored background turn → one bell + emerald tab + sidebar highlight; interrupt while watching → silence; crash, deny, and deadman lanes in the updated specs).

## Known accepted consequences (record for reviewers)

1. `FreshAgentView` treats every `freshAgent.turn.complete` as snapshot/transcript-invalidating, so error/crash/stuck endings now also trigger one snapshot refetch per visible pane (bounded; failed fetches flow into existing error/lost handling). Deliberately accepted — no client change.
2. A wedged codex turn that later genuinely completes fires two edges (stuck fire, then completion) — two honest events, two rings, monotonic `at` keeps them distinct. Accepted.
3. Where synthesized edges are minted, the implementation PREFERS sharing the consumer subscription's own `at` clock (one clock per session — no cross-clock collision possible); if a site genuinely cannot reach it, a second per-session clock exists and wall-clock advancement orders the two in practice — same accepted regime as the existing controls-lane waiting clock (a cross-clock same-millisecond or NTP-backwards collision would at worst swallow one edge; rare and self-healing on the next event).
4. Absent-status codex completions (outcome unknown) and non-user `interrupted` completions (automation/rollback-forced) now ring — an ended turn is an ended turn, and the user didn't witness it.
5. Compacts follow the same widened rule as turns (their `result`/turn-completed ends ring on non-interrupt outcomes), for all three providers.
6. With per-event bells, a serial ring queue makes simultaneous events audibly distinct (each ring is a fresh Audio instance started when the previous ends); the queue holds at most 5 pending rings — a >5-simultaneous-end burst drops the excess rings (the events still mark/highlight; only the chime queue truncates). Accepted bound against pathological storms.
7. Watched endings set the separate `watchedCompletionByTab` mark, rendered on the tab strip only — no sidebar row highlight (which for a split tab would light up sibling sessions that did not end), no pane-header mark, no sound. The mark clears on any later away-and-back (re-activation of the tab). This is the strict implementation of "visual mark on the tab only".
