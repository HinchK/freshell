# pkvz Deflake Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Eliminate the load-dependent flake in
`fresh_pane_locator_identity_reaches_activity_and_turn_complete` by fixing the
root-cause state-machine bug that suppresses `terminal.turn.complete` when the
rollout's `task_started`+`task_complete` land in one reconcile batch — not by
widening the wait budget again.

**Architecture:** The codex activity tracker's `reconcile_rollout` promotion
guard computes `effective_clear = max(observed_clear, last_cleared_at)`. When a
live (Pending) turn's rollout is drained in one batch (start+complete together),
the same-batch `observed_clear` shadows the `task_started`, the promotion is
skipped, `accepted_start_at` stays `None`, and the Pending clear branch re-arms
(via `has_queued_submit`'s `unwrap_or(true)`) instead of recording the
completion — so `terminal.turn.complete` is never emitted. The fix scopes the
promotion guard to use prior clears only (`last_cleared_at`) when the phase is
`Pending`, so a one-batch live turn promotes-then-clears and records exactly one
completion — matching the already-green separate-batch path. The Idle
(historical-turn) suppression is preserved unchanged.

**Tech Stack:** Rust, tokio, `freshell-activity` crate (`CodexActivityTracker`),
`freshell-ws` integration tests (real server + socket + fake codex PTY).

## Global Constraints

- Work only in the `the-usual/pkvz-deflake` worktree at
  `/home/dan/code/freshell/.worktrees/pkvz-deflake` on branch
  `the-usual/pkvz-deflake` (base `9d3da1e69`).
- Do NOT widen the `wait_for_frame` budget. The 30s budget stays. A genuinely
  missing frame must still fail. (Merged precedent `f2c505e9f`; AGENTS.md:
  "fix the system over the symptom.")
- Preserve the existing `reconcile_ignores_an_already_resolved_rollout`
  semantic: a one-batch start+complete on an Idle (historical, not-watched)
  terminal stays Idle and records nothing (resume-busy seeding must not ring a
  turn that ended before the tracker watched).
- Do NOT touch the parallel `fix/ci-rust-test-flakes` branch
  (`ef30f5faf`, the 30s→120s budget bump). It is a separate effort; the user
  chooses at PR time. No conflict avoidance edits — both branches may touch
  `codex_locator_activity.rs`; the user/merge resolves.
- Red/Green/Refactor TDD: the new unit test fails first on the current code for
  the stated reason, passes after the fix.
- No comments in production code unless asked; the fix's rationale lives in the
  plan and the test, plus one short in-code note anchoring the phase-conditional
  to pkvz (the existing code is heavily commented; match that style minimally).
- Run cargo commands from the worktree. Avoid running heavy cargo while a
  foreign cargo test is in flight on the same box (coordination, not a blocker).

## Requirements

- **R1 — Outcome:** `fresh_pane_locator_identity_reaches_activity_and_turn_complete`
  no longer flakes under whole-workspace `cargo test` load. The
  `terminal.turn.complete` frame (with `provider=codex` and the locator-stamped
  `sessionId`) is emitted reliably even when the rollout's
  `task_started`+`task_complete` are read in one reconcile batch.
- **R2 — Constraint:** The fix targets the root-cause state-machine suppression
  in `reconcile_rollout`, not a wait-budget bump. The 30s `wait_for_frame` budget
  is unchanged. Existing one-batch semantics for Idle (historical) rollouts are
  preserved.
- **R3 — Evidence:** A new unit test pins the previously-untested gap — a
  Pending terminal with a queued submit receiving a one-batch
  `task_started`+`task_complete` records exactly one completion. The existing
  `freshell-activity` unit suite and the `freshell-ws` `codex_locator_activity`
  integration test stay green; the integration test is shown stable under
  repeated and loaded runs.

---

### Task 1: Root-cause fix — one-batch start+clear on a Pending turn records the completion

**Requirements served:** R1, R2, R3

**Behavior:**
- A `CodexActivityTracker` terminal in `Pending` phase (a submit was entered)
  with a queued second submit, fed a single `reconcile_rollout` batch containing
  BOTH `latest_task_started_at` and `latest_task_completed_at` (completed after
  started), promotes to Busy (sets `accepted_start_at = started_at`) and then
  clears to Idle, recording exactly one completion — matching the
  separate-batch path (`reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`
  at `codex.rs:1576` when the start is newer than the queued submit).
- An Idle terminal receiving the same one-batch start+complete STILL suppresses
  the promotion and records nothing — `reconcile_ignores_an_already_resolved_rollout`
  (`codex.rs:1393`) is unchanged.
- The 30s `wait_for_frame` budget in `codex_locator_activity.rs` is unchanged.

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs:389` (the `effective_clear`
  computation in `reconcile_rollout`'s promotion guard)
- Test: `crates/freshell-activity/src/codex.rs` (new `#[test]` next to
  `reconcile_clear_with_queued_submit_swallows_the_late_bel_echo` at ~line 1614)

**Interfaces:**
- Consumes: `CodexActivityTracker::track_terminal`, `note_input`, `reconcile_rollout`;
  `CodexTaskEvents { latest_task_started_at, latest_task_completed_at, .. }`;
  helpers `started(at)`, `completed(at)`, `phases(&effects)`, `completions(&effects)`
  already defined in the test module (`codex.rs:1361-1379` and above).
- Produces: no new public API. The promotion guard's `effective_clear` becomes
  phase-conditional (Pending uses `last_cleared_at` only; other phases unchanged).

**Test cases:**
- Pending + queued submit + one-batch started(40)+completed(60) (both newer than
  the queued submit at 20) → exactly one completion, phase Idle. (Fails on current
  code: zero completions, phase Pending — the suppression.)
- Idle (no submit) + one-batch started(100)+completed(150) → zero completions,
  phase Idle. (Already pinned by `reconcile_ignores_an_already_resolved_rollout`;
  re-run to confirm unchanged.)
- Pending + queued submit + one-batch started(12)+completed(25) where the start
  is OLDER than the queued submit at 20 → zero completions, phase Pending (re-arm).
  This is the one-batch analogue of
  `reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`'s separate-batch
  re-arm: the queued submit is newer than the accepted start, so the clear re-arms
  turn 2 instead of completing. Confirms the fix does not over-ring when the
  queued submit postdates the completed turn.

- [ ] **Step 1: Write the failing behavioral test**

In `crates/freshell-activity/src/codex.rs`, in the `#[cfg(test)]` module, add a
new test after `reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`
(~line 1614):

```rust
#[test]
fn reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes() {
    // pkvz: under whole-workspace load the hub drains the just-attached
    // rollout in ONE batch (session_meta + task_started + task_complete). The
    // promotion guard's effective_clear included the same-batch task_complete,
    // shadowing the task_started, so accepted_start_at stayed None; the
    // Pending clear branch then re-armed (has_queued_submit's unwrap_or(true))
    // instead of recording the completion -- terminal.turn.complete never
    // fired. The separate-batch path was green because the promotion landed
    // before the clear. This pins the one-batch path: a LIVE (Pending) turn
    // whose start postdates the queued submit completes in one batch.
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 0);
    tracker.note_input("t1", "\r", 10); // turn 1 pending
    tracker.note_input("t1", "\r", 20); // queued submit (turn 2)
    let events = CodexTaskEvents {
        latest_task_started_at: Some(40), // newer than the queued submit
        latest_task_completed_at: Some(60),
        ..Default::default()
    };
    let effects = tracker.reconcile_rollout("t1", &events, 70);
    assert_eq!(
        completions(&effects),
        vec![1],
        "one-batch live turn (start newer than queued submit) completes exactly once"
    );
    assert_eq!(
        phases(&effects),
        vec![CodexPhase::Idle],
        "the turn lands Idle, not re-armed Pending"
    );
}

#[test]
fn reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms() {
    // Mirror of the separate-batch re-arm in
    // reconcile_clear_with_queued_submit_swallows_the_late_bel_echo: when the
    // queued submit (20) postdates the completed turn's start (12), the clear
    // re-arms turn 2 and records nothing -- the one-batch path must match the
    // separate-batch path here too (no over-ring).
    let mut tracker = CodexActivityTracker::new();
    tracker.track_terminal("t1", Some("thread-1"), 0);
    tracker.note_input("t1", "\r", 10);
    tracker.note_input("t1", "\r", 20); // queued submit newer than the turn start
    let events = CodexTaskEvents {
        latest_task_started_at: Some(12),
        latest_task_completed_at: Some(25),
        ..Default::default()
    };
    let clear = tracker.reconcile_rollout("t1", &events, 30);
    assert!(
        completions(&clear).is_empty(),
        "re-arm to the queued turn is not a turn end (one-batch parity with separate-batch)"
    );
    assert_eq!(phases(&clear), vec![CodexPhase::Pending]);
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib codex:: reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms -- --exact --nocapture
```

Expected: the FIRST test FAILs with `assertion failed: ... == [1]` but got `[]`
(zero completions) and phase `Pending` (re-armed) — the one-batch suppression.
The SECOND test PASSes on current code (re-arm is the current behavior for the
older-start case). The first test is the red.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-activity/src/codex.rs`, replace the `effective_clear`
computation in `reconcile_rollout` (line 389):

```rust
let effective_clear = max_ts(observed_clear, state.last_cleared_at);
```

with a phase-conditional form — a same-batch clear must NOT shadow the start
promotion of a LIVE (Pending) turn (the start-then-clear is a complete turn
cycle for the pending submit, not a stale echo); historical (Idle) rollouts keep
the same-batch clear in the guard so an already-resolved turn stays un-rung:

```rust
// pkvz: under load the hub drains the just-attached rollout in ONE batch
// (session_meta + task_started + task_complete). For a LIVE (Pending) turn the
// same-batch clear must NOT shadow the start promotion -- the start-then-clear
// is the pending submit's complete turn cycle, not a stale echo. Prior clears
// (`last_cleared_at`) still gate it. Idle (historical, not-watched) rollouts
// keep the same-batch clear in the guard so resume-busy seeding does not ring
// a turn that ended before the tracker watched
// (`reconcile_ignores_an_already_resolved_rollout`).
let effective_clear = if state.phase == CodexPhase::Pending {
    state.last_cleared_at
} else {
    max_ts(observed_clear, state.last_cleared_at)
};
```

No other production change. The clear branch (lines 418-467) already handles the
same-batch clear correctly once the promotion sets `accepted_start_at`: the Busy
condition `cleared_at >= accepted_start_at` fires `transition_after_turn_clear`,
and `has_queued_submit` compares the queued submit against the now-set
`accepted_start_at` (yielding `false` when the start postdates the queued
submit → Idle → one completion; `true` when the queued submit postdates the
start → Pending re-arm → no completion).

- [ ] **Step 4: Run the focused test**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib codex:: reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms -- --exact --nocapture
```

Expected: both PASS. The first test now records exactly one completion and
lands Idle; the second re-arms to Pending with no completion.

- [ ] **Step 5: Refactor while green**

The fix is one conditional; no refactor needed. Confirm the comment style
matches the surrounding heavily-commented `reconcile_rollout` and that the
`pkvz` anchor names the kata for future traceability.

- [ ] **Step 6: Run broader verification**

Run the full `freshell-activity` unit suite to confirm no regression (notably
`reconcile_ignores_an_already_resolved_rollout`,
`reconcile_clear_completes_a_pending_pty_turn_exactly_once`,
`reconcile_clear_with_queued_submit_swallows_the_late_bel_echo`,
`bel_clears_a_reconcile_promoted_busy_turn_exactly_once`,
`dup_bel_chunk_after_stale_busy_submit_completes_exactly_once`):

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib
```

Expected: PASS (all existing tests green; the two new tests green).

- [ ] **Step 7: Commit the task**

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  git add crates/freshell-activity/src/codex.rs && \
  git commit -m "fix(codex-activity): one-batch start+clear on a Pending turn records the completion (kata pkvz)

reconcile_rollout's promotion guard computed effective_clear from the same-batch
observed_clear, so a LIVE (Pending) turn whose rollout was drained in one batch
(task_started+task_complete together, the load-induced hub drain ordering) had
its promotion shadowed by its own clear: accepted_start_at stayed None, the
Pending clear branch re-armed via has_queued_submit's unwrap_or(true), and
terminal.turn.complete never fired (kata pkvz). Scope the guard to prior clears
(last_cleared_at) only when the phase is Pending, so the one-batch live turn
promotes-then-clears and records exactly one completion -- matching the
already-green separate-batch path. Idle (historical) rollouts keep the same-batch
clear in the guard, preserving reconcile_ignores_an_already_resolved_rollout."
```

---

### Task 2: Integration verification — the codex_locator_activity flake is gone, no regression

**Requirements served:** R1, R3

**Behavior:**
- `fresh_pane_locator_identity_reaches_activity_and_turn_complete` passes
  reliably in isolation and under repeated runs (the one-batch path now records
  the completion regardless of hub drain timing).
- The broader `freshell-ws` codex/locator integration surface stays green.

**Files:**
- No source changes. (Test-only verification.)

**Interfaces:**
- Consumes: the Task 1 fix via the real server's `CodexActivityTracker`.

**Test cases:**
- Run the flaky integration test 10× in isolation → 10/10 PASS.
- Run the flaky integration test once under deliberate whole-workspace load
  (a parallel `cargo build` or a second `cargo test` of an unrelated crate) →
  PASS within the unchanged 30s `wait_for_frame` budget.
- Run the whole `freshell-ws` `codex_locator_activity` test file and the
  `freshell-activity` crate → PASS.

- [ ] **Step 1: Isolated repeat stability**

Run the flaky test 10 times in isolation (single test, repeat via a shell loop;
`--test-threads=1` keeps the binary's process-global env ownership clean):

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  for i in $(seq 1 10); do \
    cargo test -p freshell-ws --test codex_locator_activity \
      fresh_pane_locator_identity_reaches_activity_and_turn_complete -- --exact --test-threads=1 || \
      { echo "FAIL on run $i"; exit 1; }; \
  done; echo "10/10 PASS"
```

Expected: 10/10 PASS. (Pre-fix this would still mostly pass in isolation — the
flake is load-dependent — so this is a non-regression guard, not the load
proof.)

- [ ] **Step 2: Load stability**

Run the flaky test once while a deliberate load generator saturates the box
(mimics the whole-workspace `cargo test` contention that originally exposed the
flake). Use a parallel `cargo build -p freshell-server` (or
`cargo test -p freshell-sessions -- --run` if a build is already warm) to
contend for the blocking pool and tokio workers:

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  ( cargo build -p freshell-server 2>/dev/null & LOAD=$!; \
    cargo test -p freshell-ws --test codex_locator_activity \
      fresh_pane_locator_identity_reaches_activity_and_turn_complete -- --exact --test-threads=1; \
    STATUS=$?; wait $LOAD; exit $STATUS )
```

Expected: PASS within the 30s budget. If it still flakes, capture the failure
log and re-examine (the one-batch path is now fixed; a remaining flake would be
a DIFFERENT race — record it in out-of-scope-findings.md and do not widen the
budget).

- [ ] **Step 3: Broader suite non-regression**

Run the codex/locator integration surface and the activity unit crate together:

```bash
cd /home/dan/code/freshell/.worktrees/pkvz-deflake && \
  cargo test -p freshell-activity --lib && \
  cargo test -p freshell-ws --test codex_locator_activity && \
  cargo test -p freshell-ws --test codex_fork_rebind && \
  cargo test -p freshell-ws --test rest_locator_identity
```

Expected: all PASS.

- [ ] **Step 4: No commit (verification-only task)**

Task 2 makes no source changes. If Step 2 reveals a residual flake, add a
finding to `<logs-dir>/out-of-scope-findings.md` (a different race, not pkvz)
and continue. Do not commit a budget bump.

---

## Self-review

1. **Spec coverage:** R1 (flake gone) → Task 1 root-cause fix + Task 2 Steps 1-2
   stability. R2 (root-cause, not budget bump; Idle preserved) → Task 1 Step 3
   phase-conditional guard + Task 1 Step 6 re-runs
   `reconcile_ignores_an_already_resolved_rollout`. R3 (new unit test + no
   regression) → Task 1 Step 1 (two new tests) + Task 2 Step 3 (broader suite).
2. **No silent deferrals:** No stubs, mocks, or seams. The fix is production
   code in `reconcile_rollout`; the integration test uses the real server.
3. **File and interface consistency:** `effective_clear` is the only production
   change; it is consumed only by the promotion guard at `codex.rs:395-397`. The
   clear branch at 418-467 is unchanged and already handles the post-promotion
   Busy clear. Test helpers `started`/`completed`/`phases`/`completions` are
   defined in-module. `note_input("\r", at)` drives Pending + queued submit
   (confirmed at `codex.rs:530`).
4. **Executable tests:** The first new test fails first for the stated reason
   (zero completions, phase Pending — the suppression) and passes after the
   guard change. The second test passes before and after (re-arm parity). The
   Idle test is re-run, not duplicated.
5. **Placeholder scan:** No TBD/TODO/"later". All commands are runnable as
   written.
6. **Operational completeness:** No migrations, no config, no docs changes
   (internal state-machine fix; the test's existing comments stay accurate).
   Structured logging unchanged. The kata `pkvz` is closed post-merge by the
   user/approved step, not by this plan.
7. **Task relevance:** Task 1 serves R1/R2/R3; Task 2 serves R1/R3. Both
   necessary; neither removable.
8. **Task size:** Task 1 is one production conditional + two unit tests — one
   coherent TDD change. Task 2 is verification-only. Each is independently
   reviewable.
