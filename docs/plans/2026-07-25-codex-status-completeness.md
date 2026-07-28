# Codex Terminal Status Completeness Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Codex `terminal.turn.complete` frames always carry the session id once identity is known (GAP G3), and codex busy-state is real: the JSONL rollout-reconcile lane is ported so `CodexPhase::Busy`/`Unknown` are reachable, resume-busy seeding works, and no dead state machinery remains (GAP G9).

**Architecture:** Three additive layers. (1) `CodexActivityTracker` gains `bind_session` (identity binder, mirrors claude) and `reconcile_rollout` (JSONL task-event state machine that makes the existing dormant `Busy`/`Unknown`/`accepted_start_at` machinery live). (2) A new `freshell-ws/src/codex_reconcile.rs` module provides a raw-line rollout tailer, a task-event folder, and a rollout locator. (3) `ActivityHub` gains `bind_codex_session`, `attach_codex_rollout`, and a per-terminal codex lane (notify watcher + tailer), triggered from the candidate-adopt path (fresh terminals) and the resume-create path (restored terminals) — exactly mirroring the existing amplifier events-lane architecture without modifying it.

**Tech Stack:** Rust (crates/freshell-activity, crates/freshell-ws, crates/freshell-server), notify 6 (already a dep), serde_json, Playwright + TypeScript e2e (test/e2e-browser).

## Global Constraints

- Base: `origin/main` @ `2bf579e6` (PRs #528–#531 merged). Worktree: `/home/dan/code/freshell/.worktrees/codex-status-completeness`. All work happens inside this worktree.
- **Scope fence (Lane D of a 5-lane wave):** owned files are `crates/freshell-activity/src/codex.rs`, `crates/freshell-ws/src/codex_candidate.rs`, and ADDITIVE changes to `crates/freshell-ws/src/activity.rs`. In `activity.rs` NEVER edit lines inside `fn attach_lane`/`fn drain_lane` (currently :392-545, Lane B) or the `claude_frames`/`codex_frames`/`amplifier_frames`/`note_busy_upserts` free functions (currently :589-731, Lane A) — new code may CALL them but not modify them. Do NOT touch `crates/freshell-activity/src/idle.rs`, `crates/freshell-ws/src/terminal.rs`, `crates/freshell-terminal/src/registry.rs`, or client `src/`. No kimi/gemini/opencode changes. Additional additive touches justified per-task: one `mod` line in `freshell-ws/src/lib.rs`, locator install in `freshell-server/src/main.rs`, an additive spawn variant in `crates/freshell-ws/tests/common/mod.rs`, new test files, one new e2e spec + two one-line `playwright.config.ts` appends.
- TDD (Red-Green-Refactor) for every task. Run the failing test BEFORE implementing.
- Naming: codex's private change-commit helper is `changed` (codex.rs:87); claude's is `commit_change`. Do not mix them up.
- E2E specs spin up their OWN servers via `test/e2e-browser/helpers/rust-server.ts` (`RustServer`, ephemeral ports via `findFreePort()`). NEVER use ports 3001/3002 (the user's LIVE servers). NEVER restart the user's self-hosted Freshell server. NEVER use broad kill patterns.
- Broad JS test runs go through the coordinator gate: `npm run test:status` to inspect; if another agent holds the gate, WAIT (four sibling lanes run concurrently). Set `FRESHELL_TEST_SUMMARY="lane D codex status completeness"` for broad runs. Cargo runs (`cargo test`) are not gated.
- Server TS uses NodeNext/ESM: relative imports in `test/e2e-browser` include `.js` extensions.
- **Sibling-lane composition (from the load-bearing validation pass, V5):** (a) do NOT reference `note_busy_upserts` by name in any new code or test — Lane A renames it (`note_changed_to_gate`); call only `codex_frames`, whose signature is preserved. (b) Lane A also fixes the idle grace from 0 to ~2000 ms — write any assertion adjacent to `terminal.idle` timing grace-window-tolerant (scan/poll, never assert immediate idle). (c) Lane E adds fields to `WsState` — if Task 3's duplicated spawn body stops compiling after a sibling merge, add the new fields exactly as the donor function has them (compiler-caught, expected). (d) Before ANY rebase onto merged sibling work, re-run a diff sweep of the shared surfaces (`activity.rs` Created/Exit arms, `tests/common/mod.rs`, `playwright.config.ts`, `main.rs:397-408`) — sibling plans are declarations, not contracts; line anchors WILL drift (anchor by symbol).
- Commits: focused and atomic, one per task, message ends with the Amplifier co-author trailer:

```
🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
```

- PR POLICY: NOT approved. Push the branch, STOP before `gh pr create`. Report branch + red→green proof.

---

## Decision record: GAP G9 — PORT, not delete

Both options were evaluated against the legacy implementation (`server/coding-cli/codex-activity-tracker.ts`, `server/coding-cli/providers/codex.ts:344-376`, `server/coding-cli/codex-activity-wiring.ts`):

**(b) DELETE** would remove `CodexPhase::Busy` handling, the busy-deadman (`expire`, `next_deadline` Busy arms), `accepted_start_at`, and `transition_after_turn_clear` — and pin "restored mid-turn shows idle" as an expected-fail. Rejected: the user's directive for this wave is "bulletproof, don't skip anything", and the port is demonstrably proportionate (below).

**(a) PORT** is proportionate because:
1. The JSONL parsing half is ALREADY ported and fixture-tested: `crates/freshell-sessions/src/parse/codex.rs:433-447` folds the exact three discriminators (`event_msg` + `task_started`/`task_complete`/`turn_aborted`), `crates/freshell-sessions/src/time.rs:29` (`parse_timestamp_ms`, pub, handles ISO strings AND numeric ms), `CodexTaskEventSnapshot` in `meta.rs:27-31`, parity-tested against `test/fixtures/coding-cli/codex/task-events.sanitized.jsonl`.
2. The state-machine half the tracker needs is ~120 LOC on top of machinery that already exists dormant (`Busy`/`Unknown` variants, `BUSY_DEADMAN_MS`, `accepted_start_at`, `transition_after_turn_clear`, the `expire`/`next_deadline` Busy arms). Porting makes the dead machinery live; nothing dead survives.
3. No new dependencies: `notify = "6"` is already in freshell-ws; timestamps parse without chrono via `freshell_sessions::time`.

**Documented narrowing deviations** (written into codex.rs module doc in Task 7):
- **Per-bound-terminal rollout tailing** instead of the legacy whole-library `reconcileProjects` scan. The legacy tracker only ever touched terminals it had records for anyway; watching just the bound terminal's rollout file (mirroring the amplifier events lane) removes the indexer feed and the 2s/5s debounce machinery.
- **Tail-trusting reads** instead of head+tail snippet + `sanitizeCodexTaskEventsForTruncatedSnippet`: the initial attach read is bounded to the last 256 KB of the rollout; incremental reads are offset-tailed. Trusting the tail is exactly what the legacy sanitizer converged to for truncated files, and it prevents the "permanently blue" hazard by construction (p99 rollout is 28 MB — never read whole files per change event).
- **No latent/association distrust** (`latentAcceptedStartAt` is not ported): legacy needed it because `reason: 'association'` bindings were cwd/time GUESSES. Every Rust binding is proof-carrying — resume argv (`codex resume <id>`) or disk-truth candidate adoption (`verify_rollout_path`: first-line `session_meta.payload.id` ownership proof + single-owner guard 3b). Trusted bindings promote directly.

## Validation record (load-bearing pass, 2026-07-25)

The plan's load-bearing assumptions were validated before execution (full ledger:
`.worktrees/.the-usual-logs/codex-status-completeness/load-bearing-ledger.md`, evidence in
`reports/validator-V1..V6.md`). Findings that shape execution:

1. **VERIFIED — single-file tailing is sound.** Codex source (installed version 0.145.0,
   tag `rust-v0.145.0`): `codex resume <id>` opens the EXISTING rollout append-mode
   (`codex-rs/core/src/rollout/recorder.rs:1828-1831`, `meta: None`); the foreign-lineage
   `payload.session_id` cases are FORKS (new file), not resumes. Error recovery reopens the
   same path; rollback is an appended logical marker, never a rewrite. The narrowing
   deviation stands.
2. **VERIFIED — locator contract.** Census of the real 8,234-rollout tree: first line is
   always `session_meta`; `payload.id` is unique across files AND always equals the
   filename uuid. First-match-wins needs no recency ordering. Real first lines are ~22 KB
   (session_meta embeds `base_instructions`) — `first_line_owns`'s 1 MB `take` cap is
   load-bearing; never reduce it below 64 KB.
3. **VERIFIED — discriminators current.** All 3,762 rollouts newer than 2026-07-01 carry
   the three `event_msg` discriminators with top-level ISO timestamps (26,116
   `task_started` / 21,842 `task_complete` / 2,429 `turn_aborted` lines).
4. **FALSIFIED — inline locator walk.** Measured on the real tree: 35–55 ms warm,
   seconds-scale cold. The Created-arm trigger therefore runs the locator under
   `tokio::task::spawn_blocking` (Task 7a as written below).
5. **FALSIFIED — fresh-terminal production trigger (G3 scope note).** NO Rust code emits
   `terminal.codex.durability.updated` (protocol-only type, `server_messages.rs:99/:889`;
   durability store deferred to S5 per `launch_lifecycle.rs:21-28`), and the frozen
   client's ONLY `terminal.codex.candidate.persisted` send site is gated on that message
   (`TerminalView.tsx:3886-3919`). So against today's Rust server the candidate-adopt
   trigger chain never fires in production; it goes live when S5 ports the durability
   emitter (legacy reference: `broadcastCodexDurability`, `server/terminal-registry.ts:3044-3056`,
   fed by the sidecar candidate chain). Tasks 3/7b remain REQUIRED — they are the
   server-side half S5 plugs into, and the RESUME path (locator) is production-live now.
   Task 8's raw-WS candidate injection is therefore a protocol-level proof of the adopt
   path (the same established pattern as `tests/codex_candidate_persisted.rs`), not proof
   of the production trigger chain — Task 8 documents this honestly.
6. **FALSIFIED — two-field exactly-once dedupe.** Adversarial enumeration found two
   reachable double-completion interleavings (and one pre-existing zero-fire). Task 4 now
   ships the two fixes and pins them with tests: a one-shot BEL-echo swallow armed by
   reconcile-initiated clears, and nulling `accepted_start_at` in
   `transition_pending_after_turn_clear` (details in Task 4).
7. **ACCEPTED RESIDUALS.** (a) Out-of-band rollout disappearance — codex compresses
   rollouts idle ≥7 days to `.jsonl.zst` and unlinks the `.jsonl` (`compression.rs:253,651`;
   currently inert locally), and `codex archive`/`delete` can remove files: the lane
   degrades to PTY-only for that terminal (same class as a locator miss) and self-heals on
   resume — deliberately NOT re-introducing tree watching. (b) Sibling-lane drift during
   the wave: current state verified clean (all four siblings docs-only); composition notes
   added to Global Constraints; re-run a shared-surface diff sweep before any rebase.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-activity/src/codex.rs` | Modify (owned) | `bind_session`, `CodexTaskEvents`, `reconcile_rollout`, new `TerminalActivity` fields, module-doc deviation update, tests |
| `crates/freshell-ws/src/codex_reconcile.rs` | Create | `RolloutTailer` (offset raw-line tailer), `fold_task_events`, `locate_codex_rollout`, tests |
| `crates/freshell-ws/src/lib.rs` | Modify (1 line) | `mod codex_reconcile;` |
| `crates/freshell-ws/src/activity.rs` | Modify (additive only) | `bind_codex_session`, `attach_codex_rollout`, `drain_codex_lane`, `set_codex_rollout_locator`, `CodexLane` + `codex_lanes` field, `HubEvent::CodexAttach` + handler arm, codex resume-attach block in Created arm, one teardown line in Exit arm, tests |
| `crates/freshell-ws/src/codex_candidate.rs` | Modify (owned) | Adopt path calls `bind_codex_session` + `attach_codex_rollout` |
| `crates/freshell-ws/tests/common/mod.rs` | Modify (additive fn) | `spawn_server_with_specs_and_activity` |
| `crates/freshell-ws/tests/codex_candidate_activity.rs` | Create | Integration test: candidate adopt → activity frames carry sessionId |
| `crates/freshell-server/src/main.rs` | Modify (~12 lines) | Install codex rollout locator on the hub |
| `test/e2e-browser/specs/codex-status-completeness-rust.spec.ts` | Create | 3 e2e tests (adoption identity, restart-mid-turn busy convergence, two concurrent servers) |
| `test/e2e-browser/playwright.config.ts` | Modify (2 lines) | Register new spec in `RUST_ONLY_SPECS` and `rust-chromium.testMatch` |

Key existing anchors (verified at base 2bf579e6 — line numbers may drift a few lines as sibling lanes merge; anchor by symbol name):
- `ActivityHub` insertion zone: immediately after `pub fn attach_amplifier_association` (ends activity.rs:159), before the `claude_list` doc comment.
- Adopt block: `codex_candidate.rs:201-217` (`state.identity.upsert` → `registry.set_meta` → `broadcast_terminal_session_associated`).
- Precedent to copy: `amplifier_association.rs:160-166` (`if let Some(hub) = &state.activity { … }`), `activity.rs:284-297` (post-lock resume attach via channel), `AmplifierActivityTracker::bind_session` (`amplifier/tracker.rs:142-155`).

---

### Task 1: `CodexActivityTracker::bind_session` (G3, tracker layer)

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs`
- Test: same file, `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: existing private helpers `changed(previous, next)` (codex.rs:87), `TerminalActivity::to_record()`, existing test helpers `phases()`/`completions()`.
- Produces: `pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<CodexEffect>` on `CodexActivityTracker` — Task 2's hub method and Task 6's attach call this.

- [ ] **Step 0: Baseline sanity**

```bash
cd /home/dan/code/freshell/.worktrees/codex-status-completeness
git log --oneline -1   # expect 2bf579e6 (or your lane branch on top of it)
cargo test -p freshell-activity
```
Expected: all existing freshell-activity tests PASS. If not green, STOP and report.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `crates/freshell-activity/src/codex.rs` (after the last existing test, `session_identity_from_create_flows_into_records_and_completions`):

```rust
    #[test]
    fn bind_session_on_untracked_terminal_is_a_silent_noop() {
        let mut tracker = CodexActivityTracker::new();
        let effects = tracker.bind_session("t-unknown", "thread-9");
        assert!(effects.is_empty());
        assert!(tracker.list().is_empty());
    }

    #[test]
    fn bind_session_is_idempotent_on_reannounce_and_emits_on_change() {
        // The client re-sends `terminal.codex.candidate.persisted` on every
        // durability update -- re-binding the same id must not spam frames.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);

        let first = tracker.bind_session("t1", "thread-1");
        assert_eq!(first.len(), 1, "identity change is a public change");
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-1"));

        let again = tracker.bind_session("t1", "thread-1");
        assert!(again.is_empty(), "same id re-announce is a no-op");

        let rebound = tracker.bind_session("t1", "thread-2");
        assert_eq!(rebound.len(), 1);
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-2"));
    }

    #[test]
    fn bind_session_mid_turn_retroactively_stamps_the_completion() {
        // G3: a FRESH codex terminal has no identity at create; the candidate
        // adoption binds it mid-turn; the BEL's turn.complete must carry it.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.note_input("t1", "\r", 10);
        let bind = tracker.bind_session("t1", "thread-1");
        assert_eq!(bind.len(), 1, "bind while pending is a public change");
        let effects = tracker.note_output("t1", "\u{07}", 9_000);
        let complete_session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(complete_session, Some(Some("thread-1".to_string())));
    }

    #[test]
    fn track_terminal_rebind_branch_updates_identity_in_place() {
        // Pins the previously-untested rebind branch (track_terminal on an
        // existing state with a NEW session id).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        let effects = tracker.track_terminal("t1", Some("thread-2"), 5);
        assert_eq!(effects.len(), 1);
        assert_eq!(tracker.list()[0].session_id.as_deref(), Some("thread-2"));
        let noop = tracker.track_terminal("t1", Some("thread-2"), 6);
        assert!(noop.is_empty());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-activity codex::tests::bind_session -- --nocapture
```
Expected: FAIL to compile — `no method named 'bind_session' found for struct 'CodexActivityTracker'`. (The `track_terminal_rebind_branch...` test would pass alone; the compile error is the red signal.)

- [ ] **Step 3: Implement `bind_session`**

Insert in `impl CodexActivityTracker`, immediately after `track_terminal` (i.e. after the closing brace currently at codex.rs:153):

```rust
    /// Bind (or re-bind) the session identity of an already-tracked terminal.
    /// The binder anticipated by deviation 1: the candidate-adopt path and the
    /// rollout-reconcile lane both announce identity through here. Same
    /// idempotent shape as `track_terminal`'s rebind branch and
    /// `AmplifierActivityTracker::bind_session`: untracked terminal -> silent
    /// no-op (never resurrects state for an exited terminal); same id ->
    /// no-op (the client re-announces on every durability update).
    pub fn bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        if state.session_id.as_deref() == Some(session_id) {
            return Vec::new();
        }
        let previous = state.to_record();
        state.session_id = Some(session_id.to_string());
        let next = state.to_record();
        changed(Some(&previous), next)
    }
```

Also update the module-doc parenthetical (codex.rs:26-31). Replace:

```rust
//!    state machine itself is ported faithfully. (A vestigial `bind_session`
//!    binder for that lane was deleted as dead code; session identity arrives
//!    via `track_terminal`'s `session_id` argument, and a future port of the
//!    lane would introduce its own binder.)
```

with:

```rust
//!    state machine itself is ported faithfully. (`bind_session` is that
//!    lane's binder: the candidate-adopt path and the rollout-reconcile lane
//!    announce identity through it; resume identity still arrives via
//!    `track_terminal`'s `session_id` argument.)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-activity
```
Expected: PASS, including all 4 new tests and all pre-existing tests.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-activity/src/codex.rs
git commit -m "feat(activity): reintroduce CodexActivityTracker::bind_session as the identity binder

G3: fresh codex terminals get identity only after candidate adoption;
bind_session lets that identity reach the tracker so completions carry it.
Mirrors claude/amplifier bind_session; pins the untested rebind branch."
```
(Include the Amplifier trailer from Global Constraints in this and every commit.)

---

### Task 2: `ActivityHub::bind_codex_session` (G3, hub layer)

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` (additive method + test)

**Interfaces:**
- Consumes: `CodexActivityTracker::bind_session` (Task 1); existing `codex_frames(&mut IdleGate, Vec<CodexEffect>) -> Vec<ServerMessage>` (called, NOT modified); test helpers `hub()`, `observer_send`, `next_frame_matching` (activity.rs:754-798).
- Produces: `pub fn bind_codex_session(&self, terminal_id: &str, session_id: &str)` — Task 3's adopt path calls this.

- [ ] **Step 1: Write the failing test**

Append inside `mod tests` in `crates/freshell-ws/src/activity.rs`:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn bind_codex_session_broadcasts_identity_and_stamps_completions() {
        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: None,
                at: crate::terminal::now_ms(),
            },
        );
        // Initial idle upsert (no sessionId -- the G3 gap state).
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial idle upsert");

        // Bind: a fresh terminal's adopted candidate identity arrives.
        hub.bind_codex_session("t1", "thread-1");
        let bound = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["sessionId"] == "thread-1"
        })
        .await
        .expect("bind upsert carries sessionId");
        assert_eq!(bound["upsert"][0]["terminalId"], "t1");

        // Payoff: a subsequent turn's completion carries the session id.
        observer_send(
            &hub,
            ActivityEvent::Input {
                terminal_id: "t1".into(),
                data: "\r".into(),
                at: crate::terminal::now_ms(),
            },
        );
        observer_send(
            &hub,
            ActivityEvent::Output {
                terminal_id: "t1".into(),
                data: "\u{07}".into(),
                at: crate::terminal::now_ms(),
            },
        );
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 3_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("turn complete");
        assert_eq!(complete["sessionId"], "thread-1");
        assert_eq!(complete["provider"], "codex");
    }
```

NOTE: `ActivityEvent::Input`/`Output` field names — copy the exact construction used by the existing test `exit_broadcasts_remove_and_clears_state` (activity.rs:934+); if it uses different field names (e.g. no `at`), match those.

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p freshell-ws bind_codex_session_broadcasts -- --nocapture
```
Expected: FAIL to compile — `no method named 'bind_codex_session' found for struct 'ActivityHub'`.

- [ ] **Step 3: Implement the hub method**

Insert in `impl ActivityHub`, immediately AFTER the closing brace of `attach_amplifier_association` (currently activity.rs:159) and BEFORE the `claude_list` doc comment. Channel-deferred style, mirroring `attach_amplifier_association` (:147-159): the hub's serialization invariant is that ALL frame emission happens on the single hub task (`emit` is otherwise unreachable off-task — see `drain_lane`/`attach_lane`), so a WS-dispatch caller must enqueue, never lock-compute-emit inline:

```rust
    /// G3: bind a codex terminal's session identity into the activity
    /// tracker (candidate adoption / rollout-reconcile lane). Idempotent;
    /// silent no-op for untracked terminals. Channel-deferred (mirror of
    /// `attach_amplifier_association`) so the resulting
    /// `codex.activity.updated` identity upsert is emitted on the hub task,
    /// preserving the single-emitter frame-ordering invariant; subsequent
    /// `terminal.turn.complete` frames then carry `sessionId`.
    pub fn bind_codex_session(&self, terminal_id: &str, session_id: &str) {
        let _ = self.tx.send(HubEvent::CodexBind {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
        });
    }
```

with a new `HubEvent` variant (private enum — no API impact), next to `AmplifierAttach`:

```rust
    /// Bind a codex terminal's adopted session identity (hub-task emission).
    CodexBind {
        terminal_id: String,
        session_id: String,
    },
```

and its arm in `handle_event` (next to the `AmplifierAttach` arm):

```rust
            HubEvent::CodexBind {
                terminal_id,
                session_id,
            } => {
                let frames = {
                    let mut inner = self.inner.lock().expect("activity hub lock");
                    let effects = inner.codex.bind_session(&terminal_id, &session_id);
                    codex_frames(&mut inner.idle, effects)
                };
                self.emit(frames);
            }
```

(The Step 1 test is unchanged and still valid: it awaits the bind upsert from the broadcast receiver, which the hub task delivers after processing the enqueued event.)

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws --lib
```
Expected: PASS (new test + all existing activity.rs tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs
git commit -m "feat(ws): ActivityHub::bind_codex_session routes adopted identity into the codex tracker"
```

---

### Task 3: Candidate adopt path binds identity into the hub (G3 wiring)

**Files:**
- Modify: `crates/freshell-ws/src/codex_candidate.rs` (owned)
- Modify: `crates/freshell-ws/tests/common/mod.rs` (additive function only)
- Create: `crates/freshell-ws/tests/codex_candidate_activity.rs`

**Interfaces:**
- Consumes: `ActivityHub::bind_codex_session` (Task 2); `WsState.activity: Option<ActivityHub>` (lib.rs:237, already present — nothing to thread); existing fixtures in `tests/codex_candidate_persisted.rs` (fake codex script, `CODEX_HOME` tempdir, rollout writer) and harness fns in `tests/common/mod.rs`.
- Produces: adopt path calls the hub; `spawn_server_with_specs_and_activity(specs) -> <same return type as spawn_server_with_specs>` in `tests/common/mod.rs` — Task 7's tests may also use it.

- [ ] **Step 1: Add the activity-enabled harness variant**

In `crates/freshell-ws/tests/common/mod.rs`, add a NEW function next to `spawn_server_with_specs` (do NOT change the existing one — its `activity: None` at :134 is load-bearing for the frame-ordering assumptions of the existing 353-line guard test). The variant duplicates the existing spawn body with two changes, mirroring `freshell-server/src/main.rs:397-408`:

1. Before constructing `WsState`, build a hub:
```rust
    let activity_hub =
        freshell_ws::activity::ActivityHub::new(std::sync::Arc::clone(&broadcast_tx), None);
    registry.set_activity_observer(activity_hub.registry_observer());
```
2. In the `WsState` literal, replace `activity: None` with `activity: Some(activity_hub.clone())`.

(Adapt the exact variable names — `broadcast_tx`, `registry` — to what the existing `spawn_server_with_specs` body uses; keep everything else byte-identical to the original function. If the existing body doesn't have `broadcast_tx` in scope under that name, it is the `Arc<tokio::sync::broadcast::Sender<String>>` the `WsState` is built with — reuse that binding.)

- [ ] **Step 2: Write the failing integration test**

Create `crates/freshell-ws/tests/codex_candidate_activity.rs`. Model the setup on `tests/codex_candidate_persisted.rs` (same fake-codex spec, `CODEX_HOME` tempdir, rollout writer, `send_create`, `send_candidate` helpers — copy the private helpers you need into this file rather than importing them):

```rust
//! G3 integration: a FRESH codex terminal (no resume id) whose candidate is
//! adopted must broadcast `codex.activity.updated` carrying the sessionId,
//! and its subsequent turn completion must carry the same sessionId.
//! Uses the activity-enabled harness (the default harness has `activity: None`).

#[cfg(unix)]
mod common;

// ... copy of write_fake_codex(), codex_capture_spec(), send_create(),
//     send_candidate(), and the session_meta rollout-writer helpers from
//     tests/codex_candidate_persisted.rs ...

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn adopted_candidate_identity_reaches_codex_activity() {
    const THREAD: &str = "11111111-2222-3333-4444-555555555555";

    // CODEX_HOME tempdir + a real rollout whose first line is
    // session_meta { payload: { id: THREAD } } (adoption guard 4 disk truth).
    // ... same env + fs setup as codex_candidate_persisted.rs ...

    let (url, _guard) = common::spawn_server_with_specs_and_activity(vec![codex_capture_spec()]);
    let mut ws = /* connect as codex_candidate_persisted.rs does */;

    // 1. Create a FRESH codex terminal (no sessionRef, no resume id).
    let terminal_id = send_create(&mut ws, "codex").await;

    // 2. Send the candidate frame (client announcing the persisted rollout).
    send_candidate(&mut ws, &terminal_id, THREAD, &rollout_path).await;

    // 3. The adopt path must now emit codex.activity.updated with sessionId.
    //    Collect frames until we see it (do not use a drop-on-mismatch helper
    //    if one exists in common -- match by scanning).
    let bound = wait_for_frame(&mut ws, |v| {
        v["type"] == "codex.activity.updated"
            && v["upsert"]
                .as_array()
                .map(|u| u.iter().any(|r| r["terminalId"] == terminal_id.as_str()
                    && r["sessionId"] == THREAD))
                .unwrap_or(false)
    })
    .await;
    assert!(bound, "expected codex.activity.updated carrying the adopted sessionId");
}
```

Implement `wait_for_frame` locally: loop reading WS text frames with a `tokio::time::timeout(Duration::from_secs(10), ...)` overall budget, `serde_json::from_str` each, return true on match. This test asserts step 3 only; the completion payoff is covered at hub level (Task 2) and e2e level (Task 8).

- [ ] **Step 3: Run test to verify it fails**

```bash
cargo test -p freshell-ws --test codex_candidate_activity -- --nocapture
```
Expected: FAIL — the frame never arrives (adopt path does not call the hub yet), timing out with the assert message.

- [ ] **Step 4: Implement the adopt-path call**

In `crates/freshell-ws/src/codex_candidate.rs`, at the END of `handle_codex_candidate_persisted` — AFTER `broadcast_terminal_session_associated(state, &msg.terminal_id, thread_id, row.cwd.clone());` (the ordering of `terminal.session.associated` then `terminal.meta.updated` is pinned by the comment at :220-226; the hub frame goes after both, mirroring `amplifier_association.rs:160-166`):

```rust
    // G3: adopted identity also feeds the activity tracker, so this
    // terminal's `codex.activity.updated` records and subsequent
    // `terminal.turn.complete` frames carry the sessionId (a fresh codex
    // terminal otherwise never gets one -- identity arrives only here).
    // Placed AFTER the pinned associated/meta broadcast pair.
    if let Some(hub) = &state.activity {
        hub.bind_codex_session(&msg.terminal_id, thread_id);
    }
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p freshell-ws --test codex_candidate_activity
cargo test -p freshell-ws --test codex_candidate_persisted
```
Expected: both PASS (the guard test proves the pinned broadcast order is undisturbed).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-ws/src/codex_candidate.rs crates/freshell-ws/tests/common/mod.rs crates/freshell-ws/tests/codex_candidate_activity.rs
git commit -m "feat(ws): codex candidate adoption binds session identity into the activity hub

Closes the G3 identity gap: fresh codex terminals now emit
codex.activity.updated and terminal.turn.complete with sessionId."
```

---

### Task 4: Tracker reconcile — `CodexTaskEvents` + `reconcile_rollout` (G9 state machine)

**Files:**
- Modify: `crates/freshell-activity/src/codex.rs` (owned)

**Interfaces:**
- Consumes: existing dormant machinery — `CodexPhase::Busy`/`Unknown`, `accepted_start_at`, `transition_after_turn_clear` (codex.rs:386-411), `transition_pending_after_turn_clear`, `changed`, `expire`'s busy-deadman arm (:264-270), `next_deadline`'s Busy arm (:305).
- Produces:
  - `pub struct CodexTaskEvents { pub latest_task_started_at: Option<i64>, pub latest_task_completed_at: Option<i64>, pub latest_turn_aborted_at: Option<i64> }` with `pub fn is_empty(&self) -> bool`.
  - `pub fn reconcile_rollout(&mut self, terminal_id: &str, events: &CodexTaskEvents, at: i64) -> Vec<CodexEffect>` — Task 6's `drain_codex_lane` calls this.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `crates/freshell-activity/src/codex.rs`:

```rust
    fn started(at: i64) -> CodexTaskEvents {
        CodexTaskEvents { latest_task_started_at: Some(at), ..Default::default() }
    }
    fn completed(at: i64) -> CodexTaskEvents {
        CodexTaskEvents { latest_task_completed_at: Some(at), ..Default::default() }
    }

    #[test]
    fn reconcile_seeds_busy_for_an_unresolved_rollout() {
        // Resume-busy seeding: a terminal restored mid-turn (rollout shows a
        // task_started newer than any clear) paints busy immediately.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        let effects = tracker.reconcile_rollout("t1", &started(100), 200);
        assert_eq!(phases(&effects), vec![CodexPhase::Busy]);
        assert_eq!(tracker.list()[0].phase, CodexPhase::Busy);
    }

    #[test]
    fn reconcile_ignores_an_already_resolved_rollout() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        let events = CodexTaskEvents {
            latest_task_started_at: Some(100),
            latest_task_completed_at: Some(150),
            latest_turn_aborted_at: None,
        };
        let effects = tracker.reconcile_rollout("t1", &events, 200);
        assert!(effects.is_empty());
        assert_eq!(tracker.list()[0].phase, CodexPhase::Idle);
    }

    #[test]
    fn reconcile_clear_completes_a_seeded_busy_turn_with_identity() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let effects = tracker.reconcile_rollout("t1", &completed(300), 400);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
        let session = effects.iter().find_map(|e| match e {
            TrackerEffect::TurnComplete { session_id, .. } => Some(session_id.clone()),
            _ => None,
        });
        assert_eq!(session, Some(Some("thread-1".to_string())));
    }

    #[test]
    fn reconcile_turn_aborted_also_clears_and_completes() {
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        let events = CodexTaskEvents {
            latest_turn_aborted_at: Some(300),
            ..Default::default()
        };
        let effects = tracker.reconcile_rollout("t1", &events, 400);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
    }

    #[test]
    fn reconcile_clear_completes_a_pending_pty_turn_exactly_once() {
        // JSONL task_complete usually lands BEFORE the PTY BEL: the pending
        // turn completes once via reconcile; the late BEL is an idle BEL and
        // must be ignored (single chime per turn -- legacy dedupe intent).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.note_input("t1", "\r", 10);
        let effects = tracker.reconcile_rollout("t1", &completed(50), 60);
        assert_eq!(phases(&effects), vec![CodexPhase::Idle]);
        assert_eq!(completions(&effects), vec![1]);
        let bel = tracker.note_output("t1", "\u{07}", 70);
        assert!(completions(&bel).is_empty(), "late BEL must not double-complete");
    }

    #[test]
    fn bel_clears_a_reconcile_promoted_busy_turn_exactly_once() {
        // The reverse race: reconcile promotes Pending->Busy (task_started
        // confirms the submit), then the BEL ends the turn via the
        // accepted_start_at path (transition_after_turn_clear goes live).
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.note_input("t1", "\r", 10);
        let promote = tracker.reconcile_rollout("t1", &started(20), 30);
        assert_eq!(phases(&promote), vec![CodexPhase::Busy]);
        let bel = tracker.note_output("t1", "\u{07}", 9_000);
        assert_eq!(completions(&bel), vec![1]);
        // A later stale task_complete for the same turn is a no-op (idle).
        let late = tracker.reconcile_rollout("t1", &completed(8_000), 9_500);
        assert!(completions(&late).is_empty());
    }

    #[test]
    fn busy_deadman_demotes_to_unknown_and_reconcile_repromotes() {
        // The busy-deadman (previously structurally dead) is now reachable:
        // a seeded busy with no observation for BUSY_DEADMAN_MS goes Unknown
        // instead of lying blue forever; a NEWER unresolved start re-promotes.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", None, 0);
        tracker.reconcile_rollout("t1", &started(100), 200);
        assert!(tracker.next_deadline().is_some(), "busy arms the deadman timer");
        let effects = tracker.expire(200 + BUSY_DEADMAN_MS + 1);
        assert_eq!(phases(&effects), vec![CodexPhase::Unknown]);
        let re = tracker.reconcile_rollout("t1", &started(500_000), 500_100);
        assert_eq!(phases(&re), vec![CodexPhase::Busy]);
    }

    #[test]
    fn reconcile_on_untracked_terminal_is_a_noop() {
        let mut tracker = CodexActivityTracker::new();
        let effects = tracker.reconcile_rollout("t-unknown", &started(100), 200);
        assert!(effects.is_empty());
    }

    #[test]
    fn reconcile_clear_with_queued_submit_swallows_the_late_bel_echo() {
        // Load-bearing validation CE1: reconcile clear with a queued submit
        // re-arms Pending (transition_after_turn_clear's has_queued_submit
        // branch); the PTY BEL echo of the RECONCILED turn's end must not
        // complete the re-armed turn prematurely (the disjoint key spaces --
        // server-clock pending keys vs rollout-clock accepted keys -- make
        // last_emitted_turn_key powerless here; the swallow flag is the fix).
        //
        // Completion accounting matches the frozen PTY reference: a re-arm is
        // NOT a turn end (`record_completion_if_idle` records only when the
        // terminal lands Idle -- see its doc comment and the pinned PTY test
        // `queued_submit_rearms_pending_after_the_bel_and_completes_each_turn`,
        // where two submitted turns also yield exactly ONE completion, seq 1).
        // So the reconcile clear here records nothing; the swallow flag is
        // what keeps the late BEL echo from prematurely completing turn 2.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.note_input("t1", "\r", 10); // turn 1 pending
        tracker.reconcile_rollout("t1", &started(12), 15); // promoted busy
        tracker.note_input("t1", "\r", 20); // queued submit (turn 2)
        let clear = tracker.reconcile_rollout("t1", &completed(25), 30);
        assert!(
            completions(&clear).is_empty(),
            "re-arm to the queued turn is not a turn end (PTY parity)"
        );
        // The BEL echo of turn 1's end arrives late on the PTY lane. Without
        // the swallow flag it would end the RE-ARMED turn 2 prematurely (the
        // pending-key path lands Idle and records a bogus completion).
        let echo = tracker.note_output("t1", "\u{07}", 35);
        assert!(
            completions(&echo).is_empty(),
            "BEL echo of a reconcile-cleared turn must be swallowed"
        );
        // Turn 2 then actually runs and completes exactly once -- the FIRST
        // recorded completion (ledger seq 1; the re-arm recorded none).
        tracker.reconcile_rollout("t1", &started(40), 45);
        let done = tracker.reconcile_rollout("t1", &completed(60), 65);
        assert_eq!(completions(&done), vec![1], "turn 2 completes exactly once");
    }

    #[test]
    fn dup_bel_chunk_after_stale_accepted_completes_exactly_once() {
        // Load-bearing validation CE2: transition_pending_after_turn_clear
        // must null accepted_start_at. A deadman-demoted seeded busy leaves a
        // stale accepted anchor; without the fix, a dup-BEL chunk (real PTY
        // behavior, see the existing dup-BEL test) fires TWO completions in
        // one note_output call -- pending-key chime then stale-accepted chime.
        let mut tracker = CodexActivityTracker::new();
        tracker.track_terminal("t1", Some("thread-1"), 0);
        tracker.reconcile_rollout("t1", &started(100), 200); // seeded busy, accepted=100
        tracker.expire(200 + BUSY_DEADMAN_MS + 1); // demote to Unknown
        let submit_at = 200 + BUSY_DEADMAN_MS + 1_000;
        tracker.note_input("t1", "\r", submit_at); // new pending turn
        let bel = tracker.note_output("t1", "\u{07}\u{07}", submit_at + 500);
        assert_eq!(
            completions(&bel).len(),
            1,
            "one turn end -> exactly one completion, even for a dup-BEL chunk"
        );
    }
```

(If `note_input`/`note_output`/`expire` signatures differ from the existing tests'
usage, match the existing tests exactly — these two tests reuse only constructions
already present in the suite.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-activity reconcile -- --nocapture
```
Expected: FAIL to compile — `CodexTaskEvents` / `reconcile_rollout` do not exist.

- [ ] **Step 3: Implement**

In `crates/freshell-activity/src/codex.rs`:

(a) Add near the constants (after line 50):

```rust
/// Latest codex rollout task-event timestamps (epoch ms), folded from
/// `event_msg` records: `task_started` / `task_complete` / `turn_aborted`.
/// Mirror of `freshell_sessions::CodexTaskEventSnapshot`, duplicated here so
/// this crate stays dependency-free (kernel-thin tracker).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct CodexTaskEvents {
    pub latest_task_started_at: Option<i64>,
    pub latest_task_completed_at: Option<i64>,
    pub latest_turn_aborted_at: Option<i64>,
}

impl CodexTaskEvents {
    pub fn is_empty(&self) -> bool {
        self.latest_task_started_at.is_none()
            && self.latest_task_completed_at.is_none()
            && self.latest_turn_aborted_at.is_none()
    }
}

fn max_ts(a: Option<i64>, b: Option<i64>) -> Option<i64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, None) => a,
        (None, b) => b,
    }
}
```

(b) Add three fields to `TerminalActivity` (after `accepted_start_at: Option<i64>,`):

```rust
    /// Rollout-reconcile lane: newest `task_started` timestamp ever seen for
    /// this terminal's session (promotion is edge-triggered on a NEWER start).
    last_seen_task_started_at: Option<i64>,
    /// Rollout-reconcile lane: newest clear (`task_complete`/`turn_aborted`)
    /// ever seen; a start is only unresolved if newer than this.
    last_cleared_at: Option<i64>,
    /// One-shot: a reconcile-initiated turn clear arms this so the PTY BEL
    /// echo of the SAME physical turn end is swallowed instead of completing
    /// a re-armed queued turn prematurely (validation counterexample CE1 --
    /// the PTY and reconcile key spaces are disjoint clock domains, so
    /// `last_emitted_turn_key` alone cannot dedupe across lanes).
    swallow_next_bel: bool,
```

and initialize the two `Option`s to `None` and the flag to `false` in `track_terminal`'s state literal (next to `accepted_start_at: None,`).

(c) Add the reconcile method in `impl CodexActivityTracker`, after `bind_session`:

```rust
    /// Rollout-reconcile lane (`reconcileProjects`, narrowed to one bound
    /// terminal): fold the rollout's latest task events into the state
    /// machine. Promotion rule (all Rust bindings are proof-carrying, so
    /// every binding is trusted -- see module deviations): a NEW
    /// `task_started`, newer than every known clear and newer than the
    /// accepted anchor, promotes to `busy`. Clear rule: a NEW clear at/after
    /// the turn anchor ends the turn (pending anchor first, then accepted),
    /// recording exactly one completion via the shared dedupe.
    pub fn reconcile_rollout(
        &mut self,
        terminal_id: &str,
        events: &CodexTaskEvents,
        at: i64,
    ) -> Vec<CodexEffect> {
        let Some(state) = self.states.get_mut(terminal_id) else {
            return Vec::new();
        };
        let previous = state.to_record();
        let mut completions: Vec<(Option<String>, i64, i64)> = Vec::new();

        let observed_clear = max_ts(
            events.latest_task_completed_at,
            events.latest_turn_aborted_at,
        );

        // Promote on a NEW unresolved start.
        if let Some(started_at) = events.latest_task_started_at {
            let is_new = state
                .last_seen_task_started_at
                .map(|seen| started_at > seen)
                .unwrap_or(true);
            state.last_seen_task_started_at =
                max_ts(state.last_seen_task_started_at, Some(started_at));
            let effective_clear = max_ts(observed_clear, state.last_cleared_at);
            if is_new
                && state
                    .accepted_start_at
                    .map(|accepted| started_at > accepted)
                    .unwrap_or(true)
                && effective_clear
                    .map(|cleared| started_at > cleared)
                    .unwrap_or(true)
            {
                state.phase = CodexPhase::Busy;
                state.accepted_start_at = Some(started_at);
                state.updated_at = at;
                state.last_observed_at = at;
            }
        }

        // Clear on a NEW terminating event at/after the turn anchor.
        if let Some(cleared_at) = observed_clear {
            let is_new_clear = state
                .last_cleared_at
                .map(|seen| cleared_at > seen)
                .unwrap_or(true);
            state.last_cleared_at = max_ts(state.last_cleared_at, Some(cleared_at));
            if is_new_clear {
                if state.phase == CodexPhase::Pending
                    && state
                        .pending_submit_at
                        .map(|pending| cleared_at >= pending)
                        .unwrap_or(false)
                {
                    transition_pending_after_turn_clear(state, at, &mut self.ledger, &mut completions);
                    // CE1: swallow the PTY BEL echo of this reconciled turn end
                    // (armed regardless of whether the fold arrived as one
                    // batch or split batches -- batch-agnostic by design).
                    state.swallow_next_bel = true;
                } else if (state.phase == CodexPhase::Busy || state.phase == CodexPhase::Unknown)
                    && state
                        .accepted_start_at
                        .map(|accepted| cleared_at >= accepted)
                        .unwrap_or(false)
                {
                    transition_after_turn_clear(state, at, &mut self.ledger, &mut completions);
                    state.swallow_next_bel = true;
                }
            }
        }

        let next = state.to_record();
        let terminal_id = state.terminal_id.clone();
        let mut effects = changed(Some(&previous), next);
        for (session_id, at, completion_seq) in completions {
            effects.push(TrackerEffect::TurnComplete {
                terminal_id: terminal_id.clone(),
                session_id,
                at,
                completion_seq,
            });
        }
        effects
    }
```

NOTE: mirror the exact `TrackerEffect::TurnComplete` push shape used at the end of `note_output` (codex.rs:232-239) — copy its field construction verbatim if it differs from the above.

(d) Two cross-lane dedupe fixes required by the load-bearing validation pass (counterexamples CE1/CE2 in `validator-V4.md`; both edits are in this OWNED file):

1. **BEL-echo swallow (CE1).** In `note_output`'s BEL handling, BEFORE any completion logic runs for a BEL occurrence: if `state.swallow_next_bel` is true, set it to `false` and treat that BEL as consumed (no phase transition, no completion) — one-shot. Also clear the flag in `note_input` whenever a NEW submit is recorded from Idle/Unknown (a fresh pending turn means any armed swallow is stale). The reconcile clear paths in (c) arm the flag; without it, a reconcile clear that re-arms Pending for a queued submit lets the late PTY BEL echo of the RECONCILED turn complete the queued turn prematurely, and the queued turn then completes AGAIN via its own rollout clear (the two key spaces are disjoint clock domains — `last_emitted_turn_key` cannot catch this).
2. **Null the accepted anchor on pending clears (CE2).** In `transition_pending_after_turn_clear` (codex.rs:361-384), add `state.accepted_start_at = None;` alongside the other anchor resets (mirror how `transition_after_turn_clear` nulls it). Without this, a deadman-demoted seeded busy leaves a stale `accepted_start_at`, and a dup-BEL chunk fires two completions in one `note_output` call (pending-key chime, then stale-accepted chime).

(e) `transition_after_turn_clear` (codex.rs:386-411) and the `Busy` arms of `note_input`/`expire`/`next_deadline` are now LIVE — do not delete anything; the tests in Step 1 pin them. Also pin the dedupe interplay: `record_completion_if_idle`'s `last_emitted_turn_key` now sees both `pending_submit_at` keys (PTY) and `accepted_start_at` keys (reconcile); the "exactly once" tests above (including the CE1/CE2 tests) prove no double-fire. Known pre-existing PTY-parity behavior, NOT fixed here (validation CE3): pending decay leaves `queued_submit_at` stale, so a later real turn's BEL can re-arm onto a ghost queued submit and complete silently without a chime — this exists in the frozen PTY reference today and is out of this lane's scope; do not "fix" it opportunistically.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-activity
```
Expected: PASS — all 10 new tests plus all pre-existing tests (especially `queued_submit_rearms_pending_after_the_bel_and_completes_each_turn` and `deadline_driven_expiry_converges_for_a_quiet_submit`, which prove no regression in the PTY lane; the swallow flag must not disturb them — it only arms on RECONCILE-initiated clears, which those tests never trigger).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-activity/src/codex.rs
git commit -m "feat(activity): port the codex rollout-reconcile state machine (G9)

CodexTaskEvents + reconcile_rollout make Busy/Unknown reachable:
resume-busy seeding, JSONL clears with single-completion dedupe against
the PTY BEL, and the busy-deadman all go live. transition_after_turn_clear
and accepted_start_at are no longer dead machinery."
```

---

### Task 5: Rollout tailer, task-event folder, and locator (`codex_reconcile.rs`)

**Files:**
- Create: `crates/freshell-ws/src/codex_reconcile.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (one line: `mod codex_reconcile;` next to the existing `mod codex_candidate;`)

**Interfaces:**
- Consumes: `freshell_sessions::time::parse_timestamp_ms(&serde_json::Value) -> Option<i64>` (pub, handles ISO strings and numeric ms; freshell-ws already depends on freshell-sessions); `freshell_activity::codex::CodexTaskEvents` (Task 4).
- Produces (all `pub(crate)`):
  - `struct RolloutTailer` — `fn new(path: impl Into<PathBuf>) -> Self`, `fn attach(&mut self) -> std::io::Result<u64>` (seeks to `max(0, len - INITIAL_TAIL_BYTES)`), `fn read_new_lines(&mut self) -> Vec<String>`.
  - `fn fold_task_events(lines: &[String]) -> CodexTaskEvents`.
  - `fn locate_codex_rollout(sessions_root: &Path, session_id: &str) -> Option<PathBuf>`.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-ws/src/codex_reconcile.rs` with ONLY the test module first:

```rust
//! Codex rollout-reconcile lane plumbing (G9): a raw-line offset tailer for
//! rollout JSONL files, the task-event folder (the three `event_msg`
//! discriminators), and the resume-time rollout locator.
//!
//! Deviations from the legacy lane are documented in
//! `freshell-activity/src/codex.rs`'s module doc (per-terminal tailing,
//! tail-trusting bounded initial read, no latent/association distrust).

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn event_line(payload_type: &str, ts: &str) -> String {
        format!(
            r#"{{"timestamp":"{ts}","type":"event_msg","payload":{{"type":"{payload_type}"}}}}"#
        )
    }

    #[test]
    fn fold_extracts_latest_task_event_timestamps() {
        let lines = vec![
            event_line("task_started", "2026-07-25T08:00:00.000Z"),
            event_line("task_complete", "2026-07-25T08:00:10.000Z"),
            event_line("task_started", "2026-07-25T08:01:00.000Z"),
            r#"{"timestamp":"2026-07-25T08:01:01.000Z","type":"response_item","payload":{"type":"message"}}"#.to_string(),
            "not json at all".to_string(),
        ];
        let events = fold_task_events(&lines);
        assert!(events.latest_task_started_at > events.latest_task_completed_at);
        assert!(events.latest_task_started_at.is_some());
        assert!(events.latest_turn_aborted_at.is_none());
    }

    #[test]
    fn fold_handles_turn_aborted_and_numeric_timestamps() {
        let lines = vec![
            r#"{"timestamp":1753430400000,"type":"event_msg","payload":{"type":"turn_aborted"}}"#
                .to_string(),
        ];
        let events = fold_task_events(&lines);
        assert_eq!(events.latest_turn_aborted_at, Some(1_753_430_400_000));
    }

    #[test]
    fn tailer_reads_appended_lines_incrementally() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("rollout.jsonl");
        std::fs::write(&path, "line1\nline2\n").unwrap();

        let mut tailer = RolloutTailer::new(&path);
        tailer.attach().unwrap();
        assert_eq!(tailer.read_new_lines(), vec!["line1", "line2"]);
        assert!(tailer.read_new_lines().is_empty(), "no new bytes -> no lines");

        let mut f = std::fs::OpenOptions::new().append(true).open(&path).unwrap();
        write!(f, "line3\npart").unwrap();
        assert_eq!(tailer.read_new_lines(), vec!["line3"]);

        write!(f, "ial4\n").unwrap();
        assert_eq!(tailer.read_new_lines(), vec!["partial4"]);
    }

    #[test]
    fn tailer_initial_attach_is_bounded_and_drops_the_partial_first_line() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("big.jsonl");
        // > INITIAL_TAIL_BYTES of filler, then two real lines at the end.
        let filler = "x".repeat(INITIAL_TAIL_BYTES as usize + 1024);
        std::fs::write(&path, format!("{filler}\nreal1\nreal2\n")).unwrap();
        let mut tailer = RolloutTailer::new(&path);
        tailer.attach().unwrap();
        let lines = tailer.read_new_lines();
        // The truncated filler tail must be dropped; only complete lines
        // inside the window survive (tail-trusting semantics).
        assert_eq!(lines, vec!["real1", "real2"]);
    }

    #[test]
    fn locate_finds_dated_rollout_by_first_line_ownership_proof() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        let day = root.join("2026").join("07").join("25");
        std::fs::create_dir_all(&day).unwrap();
        const SID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        const OTHER: &str = "99999999-8888-7777-6666-555555555555";
        // Decoy: filename embeds SID but first line proves OTHER owns it
        // (foreign-lineage spoof -- filename matching alone is unsafe).
        std::fs::write(
            day.join(format!("rollout-2026-07-25T07-00-00-{SID}.decoy.jsonl")),
            format!(r#"{{"type":"session_meta","payload":{{"id":"{OTHER}"}}}}"#) + "\n",
        )
        .unwrap();
        std::fs::write(
            day.join(format!("rollout-2026-07-25T08-00-00-{SID}.jsonl")),
            format!(r#"{{"type":"session_meta","payload":{{"id":"{SID}"}}}}"#) + "\n",
        )
        .unwrap();
        let found = locate_codex_rollout(&root, SID).expect("locates the owned rollout");
        assert!(found.to_string_lossy().contains("T08-00-00"));
        assert!(locate_codex_rollout(&root, "no-such-id").is_none());
    }

    #[test]
    fn locate_finds_flat_test_shape_rollouts() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        const SID: &str = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        std::fs::write(
            root.join(format!("{SID}.jsonl")),
            format!(r#"{{"type":"session_meta","payload":{{"id":"{SID}"}}}}"#) + "\n",
        )
        .unwrap();
        assert!(locate_codex_rollout(&root, SID).is_some());
    }
}
```

Add `mod codex_reconcile;` to `crates/freshell-ws/src/lib.rs` next to `mod codex_candidate;`.

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-ws codex_reconcile -- --nocapture
```
Expected: FAIL to compile — none of the three items exist yet.

- [ ] **Step 3: Implement**

Add above the test module in `codex_reconcile.rs`:

```rust
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use freshell_activity::codex::CodexTaskEvents;
use freshell_sessions::time::parse_timestamp_ms;

/// Initial attach reads at most this much of the rollout's tail. Rollouts
/// reach 28MB+ (p99, see codex_candidate.rs:72-73); the latest task events
/// live at the end, and trusting the tail is the legacy sanitizer's
/// converged behavior for truncated snapshots.
pub(crate) const INITIAL_TAIL_BYTES: u64 = 256 * 1024;

/// Raw-line offset tailer for an append-only rollout JSONL file. Owns no
/// watcher and no timer -- reads are entirely caller-driven (same contract
/// as `AmplifierEventsTailer`, which is hard-wired to the amplifier schema
/// and therefore not reusable here).
#[derive(Debug)]
pub(crate) struct RolloutTailer {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// True until the first complete line after a mid-file attach is dropped.
    skip_first_partial: bool,
}

impl RolloutTailer {
    pub(crate) fn new(path: impl Into<PathBuf>) -> Self {
        Self {
            path: path.into(),
            offset: 0,
            partial: Vec::new(),
            skip_first_partial: false,
        }
    }

    /// Position the tailer: start of file for small files, else
    /// `len - INITIAL_TAIL_BYTES` (the first, almost-certainly partial line
    /// after that offset is dropped on the first read).
    pub(crate) fn attach(&mut self) -> std::io::Result<u64> {
        let len = std::fs::metadata(&self.path)?.len();
        if len > INITIAL_TAIL_BYTES {
            self.offset = len - INITIAL_TAIL_BYTES;
            self.skip_first_partial = true;
        } else {
            self.offset = 0;
        }
        Ok(self.offset)
    }

    /// Read bytes appended since the last read and return the COMPLETE lines
    /// among them; an unterminated trailing fragment is buffered for the next
    /// read. IO errors and a shrunk file yield an empty batch (fail quiet;
    /// the deadman covers a wedged lane).
    pub(crate) fn read_new_lines(&mut self) -> Vec<String> {
        let Ok(mut file) = std::fs::File::open(&self.path) else {
            return Vec::new();
        };
        let Ok(len) = file.metadata().map(|m| m.len()) else {
            return Vec::new();
        };
        if len < self.offset {
            // Truncated/replaced file: restart from the top.
            self.offset = 0;
            self.partial.clear();
            self.skip_first_partial = false;
        }
        if len == self.offset {
            return Vec::new();
        }
        if file.seek(SeekFrom::Start(self.offset)).is_err() {
            return Vec::new();
        }
        let mut buf = Vec::with_capacity((len - self.offset) as usize);
        if file.read_to_end(&mut buf).is_err() {
            return Vec::new();
        }
        self.offset = len;
        self.partial.extend_from_slice(&buf);

        let mut lines = Vec::new();
        while let Some(newline_at) = self.partial.iter().position(|b| *b == b'\n') {
            let line_bytes: Vec<u8> = self.partial.drain(..=newline_at).collect();
            let line = String::from_utf8_lossy(&line_bytes[..line_bytes.len() - 1])
                .trim_end_matches('\r')
                .to_string();
            if self.skip_first_partial {
                self.skip_first_partial = false;
                continue;
            }
            if !line.is_empty() {
                lines.push(line);
            }
        }
        lines
    }
}

/// Fold rollout JSONL lines into the latest task-event timestamps.
/// Discriminators mirror `freshell_sessions::parse::codex` (parse/codex.rs
/// :433-447) and the legacy `providers/codex.ts:344-359`: top-level
/// `type == "event_msg"`, `payload.type` in
/// {`task_started`, `task_complete`, `turn_aborted`}.
pub(crate) fn fold_task_events(lines: &[String]) -> CodexTaskEvents {
    let mut events = CodexTaskEvents::default();
    for line in lines {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(|t| t.as_str()) != Some("event_msg") {
            continue;
        }
        let ts = value.get("timestamp").and_then(parse_timestamp_ms);
        let slot = match value
            .get("payload")
            .and_then(|p| p.get("type"))
            .and_then(|t| t.as_str())
        {
            Some("task_started") => &mut events.latest_task_started_at,
            Some("task_complete") => &mut events.latest_task_completed_at,
            Some("turn_aborted") => &mut events.latest_turn_aborted_at,
            _ => continue,
        };
        *slot = match (*slot, ts) {
            (Some(a), Some(b)) => Some(a.max(b)),
            (a, None) => a,
            (None, b) => b,
        };
    }
    events
}

/// Resume-time rollout locator: find the rollout owned by `session_id` under
/// the codex sessions root. Filename containment is only a cheap PREFILTER;
/// ownership is proven by the first line being a `session_meta` whose
/// `payload.id` equals the session id -- filename/substring matching alone is
/// documented-unsafe (codex_candidate.rs:46-57: 40% of sampled rollouts
/// contain foreign uuids). Bounded recursive walk (the tree is
/// `sessions/YYYY/MM/DD/rollout-*.jsonl`, flat `<id>.jsonl` in tests).
pub(crate) fn locate_codex_rollout(sessions_root: &Path, session_id: &str) -> Option<PathBuf> {
    fn walk(dir: &Path, session_id: &str, depth: u8, hit: &mut Option<PathBuf>) {
        if depth > 5 || hit.is_some() {
            return;
        }
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for entry in entries.flatten() {
            if hit.is_some() {
                return;
            }
            let path = entry.path();
            if path.is_dir() {
                walk(&path, session_id, depth + 1, hit);
            } else if path
                .file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.ends_with(".jsonl") && n.contains(session_id))
                .unwrap_or(false)
                && first_line_owns(&path, session_id)
            {
                *hit = Some(path);
            }
        }
    }
    let mut hit = None;
    walk(sessions_root, session_id, 0, &mut hit);
    hit
}

/// Bounded first-line ownership proof (same predicate as
/// `verify_rollout_path`, without the containment checks -- we generated the
/// candidate path ourselves from a walk of the root).
fn first_line_owns(path: &Path, session_id: &str) -> bool {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else {
        return false;
    };
    let mut reader = std::io::BufReader::new(file).take(1024 * 1024);
    let mut first = String::new();
    if reader.read_line(&mut first).is_err() {
        return false;
    }
    let Ok(value) = serde_json::from_str::<serde_json::Value>(first.trim()) else {
        return false;
    };
    value.get("type").and_then(|t| t.as_str()) == Some("session_meta")
        && value
            .get("payload")
            .and_then(|p| p.get("id"))
            .and_then(|i| i.as_str())
            == Some(session_id)
}
```

NOTE on the bounded-attach test: after a mid-file attach the tailer's first drained line is the filler remnant and is dropped via `skip_first_partial`; `real1`/`real2` survive. If `freshell_activity::codex::CodexTaskEvents` is not visible, confirm Task 4 declared it `pub` and that `freshell-ws` re-exports nothing extra is needed (`freshell_activity::codex::` path is enough — the module is `pub mod codex` in freshell-activity's lib.rs; if it is not, make the module path match however `CodexActivityTracker` is imported at activity.rs:43).

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws codex_reconcile
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/codex_reconcile.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): codex rollout tailer, task-event folder, and ownership-proof locator (G9 plumbing)"
```

---

### Task 6: Hub lane plumbing — attach, drain, teardown (G9 hub layer)

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` (additive only; see scope fence)

**Interfaces:**
- Consumes: Task 4 (`reconcile_rollout`, `CodexTaskEvents`), Task 5 (`RolloutTailer`, `fold_task_events`), existing `codex_frames` (called, not modified), `notify` crate (already a dep), `self.stats.tail_reads`.
- Produces:
  - `pub fn attach_codex_rollout(&self, terminal_id: &str, session_id: &str, rollout_path: &Path)` — Task 7's triggers call this.
  - `pub fn set_codex_rollout_locator(&self, locator: CodexRolloutLocator)` and `pub type CodexRolloutLocator = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>` — Task 7's main.rs wiring calls these.
  - Private: `struct CodexLane`, `HubInner.codex_lanes`, `HubInner.codex_rollout_locator`, `HubEvent::CodexAttach`/`HubEvent::CodexFsChange`, `fn attach_codex_lane(...)` (hub-task worker), `fn drain_codex_lane(&self, terminal_id: &str)`, Exit-arm teardown.

- [ ] **Step 1: Write the failing tests**

Append inside `mod tests` in `crates/freshell-ws/src/activity.rs`:

```rust
    /// Write a rollout line and return the (dir-guard, path).
    fn codex_rollout_fixture(lines: &[String]) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("rollout-2026-07-25T08-00-00-sess-1.jsonl");
        std::fs::write(&path, format!("{}\n", lines.join("\n"))).expect("write rollout");
        (dir, path)
    }

    fn codex_event_line(payload_type: &str, at_ms: i64) -> String {
        format!(
            r#"{{"timestamp":{at_ms},"type":"event_msg","payload":{{"type":"{payload_type}"}}}}"#
        )
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn codex_rollout_lane_seeds_busy_then_clears_via_inotify() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["terminalId"] == "t1"
        })
        .await
        .expect("initial upsert");

        // Rollout shows an unresolved turn (restored mid-turn).
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);

        // Resume-busy seeding: initial drain promotes to busy.
        let busy = next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("seeded busy upsert");
        assert_eq!(busy["upsert"][0]["sessionId"], "sess-1");

        // The turn completes on disk -> inotify -> drain -> idle + completion.
        {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&rollout)
                .expect("append");
            writeln!(f, "{}", codex_event_line("task_complete", now + 1_000)).expect("write");
        }
        let idle = next_frame_matching(&mut rx, "codex.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "idle"
        })
        .await
        .expect("idle upsert after task_complete");
        assert_eq!(idle["upsert"][0]["terminalId"], "t1");
        let complete = next_frame_matching(&mut rx, "terminal.turn.complete", 5_000, |v| {
            v["terminalId"] == "t1"
        })
        .await
        .expect("turn complete from the reconcile lane");
        assert_eq!(complete["sessionId"], "sess-1");
        assert_eq!(complete["provider"], "codex");
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn codex_lane_is_torn_down_on_exit() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );
        let (_guard, rollout) = codex_rollout_fixture(&[codex_event_line("task_started", now)]);
        hub.attach_codex_rollout("t1", "sess-1", &rollout);
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("busy");

        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: crate::terminal::now_ms(),
            },
        );
        next_frame_matching(&mut rx, "codex.activity.updated", 3_000, |v| {
            v["remove"][0] == "t1"
        })
        .await
        .expect("remove on exit");
        let lanes = hub.inner.lock().unwrap().codex_lanes.len();
        assert_eq!(lanes, 0, "exit drops the lane (and its inotify watcher)");
    }
```

(Match `ActivityEvent::Exit`'s exact field construction to the existing `exit_broadcasts_remove_and_clears_state` test.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-ws --lib codex_rollout_lane -- --nocapture
```
Expected: FAIL to compile — `attach_codex_rollout` / `codex_lanes` do not exist.

- [ ] **Step 3: Implement**

All edits to `activity.rs` are additive; do not modify any existing line inside `attach_lane`, `drain_lane`, or the `*_frames` free functions.

(a) Next to the `AmplifierEventsPathResolver` type alias (activity.rs:58), add:

```rust
/// G9: resolve a resumed codex terminal's session id to its rollout file
/// (ownership-proof walk of the codex sessions root). `None` -> the terminal
/// runs the PTY-only lane, same degradation as the amplifier resolver.
pub type CodexRolloutLocator = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;
```

(b) After the `AmplifierLane` struct (activity.rs:85-90), add:

```rust
/// G9: one rollout-reconcile lane per bound codex terminal (narrowed port of
/// the legacy whole-library `reconcileProjects` -- deviations documented in
/// `freshell-activity/src/codex.rs`).
struct CodexLane {
    tailer: crate::codex_reconcile::RolloutTailer,
    /// Keeps the inotify watcher alive for the lane's lifetime.
    _watcher: notify::RecommendedWatcher,
}
```

(c) Add two fields to `HubInner` (both `Default`-friendly; the derive stays):

```rust
    codex_lanes: HashMap<String, CodexLane>,
    codex_rollout_locator: Option<CodexRolloutLocator>,
```

(d) Add two `HubEvent` variants (private enum — no API impact; `CodexBind` already exists from Task 2):

```rust
    /// Attach a codex rollout-reconcile lane (resume-created terminal).
    /// Channel-deferred like `AmplifierAttach` so the Created arm's own
    /// frames are emitted before the lane's seeding frames.
    CodexAttach {
        terminal_id: String,
        session_id: String,
        rollout_path: PathBuf,
    },
    /// Rollout file changed on disk -- drain on the hub task (mirror of
    /// `AmplifierFsChange`; the notify thread NEVER drains or emits itself,
    /// preserving the single-emitter frame-ordering invariant).
    CodexFsChange { terminal_id: String },
```

and their arms in `handle_event` (next to the `AmplifierAttach`/`AmplifierFsChange` arms):

```rust
            HubEvent::CodexAttach {
                terminal_id,
                session_id,
                rollout_path,
            } => {
                self.attach_codex_lane(&terminal_id, &session_id, &rollout_path);
            }
            HubEvent::CodexFsChange { terminal_id } => {
                self.drain_codex_lane(&terminal_id);
            }
```

(e) In `impl ActivityHub`, after `bind_codex_session` (Task 2), add:

```rust
    /// Install the resume-time rollout locator (called once from
    /// `freshell-server` at boot; tests inject tempdir-backed closures).
    pub fn set_codex_rollout_locator(&self, locator: CodexRolloutLocator) {
        let mut inner = self.inner.lock().expect("activity hub lock");
        inner.codex_rollout_locator = Some(locator);
    }

    /// G9: attach the rollout-reconcile lane for a bound codex terminal.
    /// Channel-deferred like `attach_amplifier_association` (:147-159): the
    /// caller (WS dispatch / candidate adopt / spawn_blocking locator) only
    /// enqueues -- the tailer attach (file I/O), watcher registration, and
    /// ALL frame emission run on the single hub task, preserving the
    /// one-emitter frame-ordering invariant.
    pub fn attach_codex_rollout(&self, terminal_id: &str, session_id: &str, rollout_path: &Path) {
        let _ = self.tx.send(HubEvent::CodexAttach {
            terminal_id: terminal_id.to_string(),
            session_id: session_id.to_string(),
            rollout_path: rollout_path.to_path_buf(),
        });
    }

    /// Hub-task worker for `HubEvent::CodexAttach` (mirror of `attach_lane`).
    /// Binds identity (idempotent), tails the rollout (bounded initial read),
    /// watches it via inotify, and runs the initial drain -- which performs
    /// resume-busy seeding when the rollout shows an unresolved turn.
    fn attach_codex_lane(&self, terminal_id: &str, session_id: &str, rollout_path: &Path) {
        use notify::Watcher;
        let mut tailer = crate::codex_reconcile::RolloutTailer::new(rollout_path);
        if let Err(err) = tailer.attach() {
            tracing::warn!(
                terminal_id = %terminal_id,
                rollout = %rollout_path.display(),
                error = %err,
                "codex rollout lane attach failed; PTY-only lane continues"
            );
            return;
        }
        // Watcher: mirror the amplifier watcher (activity.rs:412-436) EXACTLY.
        // The closure captures only the hub-event sender + terminal id (never
        // a hub clone: that would put an Arc cycle inside HubInner and let the
        // notify thread emit frames out of order with the hub task). The
        // event-kind filter is the amplifier one VERBATIM (copy the matches!
        // expression from activity.rs:422-430): our own tail read triggers
        // Access(..) events and an atime-driven Modify(Metadata(..)) --
        // forwarding either would self-trigger one extra read per real read,
        // breaking the zero-polling accounting.
        let tx = self.tx.clone();
        let watched_terminal = terminal_id.to_string();
        let mut watcher = match notify::recommended_watcher(
            move |res: Result<notify::Event, notify::Error>| {
                let Ok(event) = res else { return };
                use notify::event::ModifyKind;
                use notify::EventKind::{Any, Create, Modify, Remove};
                let relevant = matches!(
                    event.kind,
                    Modify(ModifyKind::Data(_))
                        | Modify(ModifyKind::Any)
                        | Modify(ModifyKind::Name(_))
                        | Create(_)
                        | Remove(_)
                        | Any
                );
                if relevant {
                    let _ = tx.send(HubEvent::CodexFsChange {
                        terminal_id: watched_terminal.clone(),
                    });
                }
            },
        ) {
            Ok(w) => w,
            Err(err) => {
                tracing::warn!(error = %err, "codex rollout watcher construction failed");
                return;
            }
        };
        if let Err(err) = watcher.watch(rollout_path, notify::RecursiveMode::NonRecursive) {
            tracing::warn!(
                rollout = %rollout_path.display(),
                error = %err,
                "codex rollout watch failed; PTY-only lane continues"
            );
            return;
        }

        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let bind = inner.codex.bind_session(terminal_id, session_id);
            let frames = codex_frames(&mut inner.idle, bind);
            inner.codex_lanes.insert(
                terminal_id.to_string(),
                CodexLane {
                    tailer,
                    _watcher: watcher,
                },
            );
            frames
        };
        self.emit(frames);
        // Initial drain: resume-busy seeding for a rollout already mid-turn.
        self.drain_codex_lane(terminal_id);
    }

    /// Read new rollout lines and reconcile them into the codex tracker.
    fn drain_codex_lane(&self, terminal_id: &str) {
        self.stats.tail_reads.fetch_add(1, Ordering::Relaxed);
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let Some(lane) = inner.codex_lanes.get_mut(terminal_id) else {
                return;
            };
            let lines = lane.tailer.read_new_lines();
            if lines.is_empty() {
                return;
            }
            let events = crate::codex_reconcile::fold_task_events(&lines);
            if events.is_empty() {
                return;
            }
            let now = crate::terminal::now_ms();
            let effects = inner.codex.reconcile_rollout(terminal_id, &events, now);
            codex_frames(&mut inner.idle, effects)
        };
        self.emit(frames);
    }
```

(If `Ordering` is not already imported at the top of activity.rs, use the fully-qualified `std::sync::atomic::Ordering::Relaxed`, matching however `drain_lane` increments `tail_reads`.)

(f) In the `ActivityEvent::Exit` arm, add ONE line directly after `inner.lanes.remove(&terminal_id);` (currently :369):

```rust
                    inner.codex_lanes.remove(&terminal_id);
```

This is the only edit inside an existing function body, it is a single additive statement, and it is outside both fenced regions.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws --lib
```
Expected: PASS — both new tests plus all existing hub tests, in particular `idle_terminals_arm_no_timers_and_read_no_files` (the zero-polling invariant: an attached-but-idle codex lane arms no timers; only Busy arms the deadman deadline, which is existing `next_deadline` behavior).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs
git commit -m "feat(ws): codex rollout-reconcile lane in the activity hub (G9)

Per-terminal rollout tailing + inotify, resume-busy seeding on initial
drain, JSONL clears -> idle + identity-bearing turn.complete, lane
teardown on exit. Mirrors the amplifier events-lane architecture without
modifying it."
```

---

### Task 7: Wire the attach triggers (resume-create + candidate adopt) and the boot locator

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` (additive block in the Created arm)
- Modify: `crates/freshell-ws/src/codex_candidate.rs` (owned — one more call)
- Modify: `crates/freshell-server/src/main.rs` (~12 additive lines)
- Modify: `crates/freshell-activity/src/codex.rs` (module-doc deviation rewrite)

**Interfaces:**
- Consumes: Task 6 (`attach_codex_rollout`, `set_codex_rollout_locator`, `HubEvent::CodexAttach`), Task 5 (`locate_codex_rollout`), `codex_sessions_root()` (codex_candidate.rs:99, private — see step 3c).
- Produces: end-to-end triggers; no new APIs.

- [ ] **Step 1: Write the failing test (resume-create trigger)**

Append inside `mod tests` in `crates/freshell-ws/src/activity.rs`:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn resume_created_codex_terminal_attaches_the_rollout_lane_via_locator() {
        let (hub, mut rx) = hub();
        let now = crate::terminal::now_ms();
        let (_guard, rollout) =
            codex_rollout_fixture(&[codex_event_line("task_started", now - 5_000)]);
        let rollout_for_locator = rollout.clone();
        hub.set_codex_rollout_locator(Arc::new(move |session_id: &str| {
            (session_id == "sess-1").then(|| rollout_for_locator.clone())
        }));

        // A restored codex terminal is a normal create carrying the resume id.
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "codex".into(),
                resume_session_id: Some("sess-1".into()),
                at: now,
            },
        );

        // The lane attaches and the initial drain seeds busy: the restored
        // mid-turn terminal is blue, not lying idle/green (the G9 headline).
        let busy = next_frame_matching(&mut rx, "codex.activity.updated", 5_000, |v| {
            v["upsert"][0]["phase"] == "busy"
        })
        .await
        .expect("resume-busy seeding via the locator-attached lane");
        assert_eq!(busy["upsert"][0]["sessionId"], "sess-1");
    }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p freshell-ws --lib resume_created_codex_terminal -- --nocapture
```
Expected: FAIL — times out waiting for the busy upsert (nothing attaches the lane on create yet).

- [ ] **Step 3: Implement the three trigger sites**

(a) **Resume-create** — in `handle_registry_event`'s Created arm, add a post-lock block directly after the existing `if mode == "amplifier" { … }` resolver block (currently :284-297) and before `self.emit(frames);`, mirroring it exactly (locator runs outside the mutex; attach is channel-deferred so the Created arm's own idle upsert is emitted first):

```rust
                // G9: resume-created codex terminals attach the rollout-
                // reconcile lane via the locator (fresh terminals get theirs
                // from the candidate-adopt path instead). Channel-deferred
                // like AmplifierAttach so create's frames land first.
                //
                // MEASURED (load-bearing validation, F6): the locator's walk
                // of a real ~/.codex/sessions tree (8k+ files) is 35-55ms
                // warm and seconds-scale cold -- NEVER run it inline on the
                // hub task (the amplifier resolver stays inline because its
                // path is deterministic and cheap; this one is not). The
                // walk runs on a blocking thread; the attach event was
                // already channel-deferred, so frame ordering vs the Created
                // upsert is unchanged.
                if mode == "codex" {
                    if let Some(session_id) = resume_session_id.as_deref() {
                        let locator = {
                            let inner = self.inner.lock().expect("activity hub lock");
                            inner.codex_rollout_locator.clone()
                        };
                        if let Some(locator) = locator {
                            let tx = self.tx.clone();
                            let terminal_id = terminal_id.clone();
                            let session_id = session_id.to_string();
                            tokio::task::spawn_blocking(move || {
                                if let Some(rollout_path) = locator(&session_id) {
                                    let _ = tx.send(HubEvent::CodexAttach {
                                        terminal_id,
                                        session_id,
                                        rollout_path,
                                    });
                                }
                            });
                        }
                    }
                }
```

(Adapt the deferred-send mechanics to the file's reality: if the `HubEvent` sender is not a clonable sync-`send` handle usable off-task (check how the `AmplifierAttach` deferred send at activity.rs:284-297 obtains its sender), obtain the sender the same way that precedent does and move THAT into the `spawn_blocking` closure. The non-negotiable part, per the measured falsification, is that `locator(...)` executes on a blocking thread, not on the hub task.)

(b) **Candidate adopt** — in `codex_candidate.rs`, extend the Task 3 block (the rollout path is already disk-truth verified by guard 4):

```rust
    if let Some(hub) = &state.activity {
        hub.bind_codex_session(&msg.terminal_id, thread_id);
        // G9: the verified rollout also feeds the reconcile lane, so this
        // fresh terminal gets real busy-state from disk, not just PTY
        // heuristics. Both calls only enqueue hub events (Task 2/Task 6):
        // no file I/O and no frame emission happens on this WS dispatch
        // path -- the hub task does the work, keeping frames serialized.
        hub.attach_codex_rollout(
            &msg.terminal_id,
            thread_id,
            std::path::Path::new(&msg.rollout_path),
        );
    }
```

(c) **Boot locator** — in `crates/freshell-server/src/main.rs`, directly after `registry.set_activity_observer(activity_hub.registry_observer());` (currently :408):

```rust
    // G9: resume-time codex rollout locator (ownership-proof walk of the
    // codex sessions root; None -> PTY-only lane, same degradation as the
    // amplifier resolver above).
    if let Some(codex_sessions_root) = freshell_ws::codex_sessions_root() {
        activity_hub.set_codex_rollout_locator(std::sync::Arc::new(
            move |session_id: &str| {
                freshell_ws::locate_codex_rollout(&codex_sessions_root, session_id)
            },
        ));
    }
```

This requires two visibility promotions in freshell-ws:
- In `codex_reconcile.rs`: change `pub(crate) fn locate_codex_rollout` to `pub fn locate_codex_rollout`.
- In `codex_candidate.rs`: change `fn codex_sessions_root()` (:99) to `pub(crate) fn codex_sessions_root()` and add re-exports in `crates/freshell-ws/src/lib.rs`:

```rust
pub use codex_candidate::codex_sessions_root;
pub use codex_reconcile::locate_codex_rollout;
```

Wait — `codex_sessions_root` is currently private (`fn`); make it `pub(crate)` is not enough for a `pub use`. Make it `pub` within the crate file with a doc comment noting it is exported for the server's locator wiring. (Both files are in scope: codex_candidate.rs is owned; lib.rs re-export lines are additive.)

(d) **Deviation doc rewrite** — replace deviation 1's body in `crates/freshell-activity/src/codex.rs` (lines 19-31 region) with:

```rust
//! 1. **Tracking starts at terminal create, not session bind**, and the
//!    JSONL-reconcile lane is ported NARROWED (G9): per-bound-terminal
//!    rollout tailing (`freshell-ws/src/codex_reconcile.rs` + the hub's
//!    codex lanes) instead of the legacy whole-library `reconcileProjects`
//!    scan; tail-trusting bounded reads (256KB initial) instead of the
//!    head+tail snippet sanitizer; and NO latent/association distrust
//!    (`latentAcceptedStartAt` unported) because every Rust binding is
//!    proof-carrying -- resume argv or disk-truth candidate adoption
//!    (`verify_rollout_path`). `bind_session` is the lane's binder;
//!    `reconcile_rollout` is its state machine; `busy`/`unknown`, the
//!    busy-deadman, and `accepted_start_at` are live. Cross-lane
//!    completion dedupe adds a one-shot BEL-echo swallow armed by
//!    reconcile-initiated clears (the PTY and rollout key spaces are
//!    disjoint clock domains, so the turn-key alone cannot dedupe them).
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws
cargo test -p freshell-activity
cargo check -p freshell-server
```
Expected: all PASS / clean check. The Task 3 integration test still passes (the adopt path now ALSO attaches a lane; the seeded fixture rollout has no task events, so no extra phase frames disturb its assertions — if it asserts an exact frame sequence, loosen it to scan-matching).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs crates/freshell-ws/src/codex_candidate.rs crates/freshell-ws/src/codex_reconcile.rs crates/freshell-ws/src/lib.rs crates/freshell-server/src/main.rs crates/freshell-activity/src/codex.rs
git commit -m "feat: wire codex rollout lane triggers -- resume-create locator + candidate adoption (G9)

Restored mid-turn codex terminals seed busy from the rollout; fresh
terminals get the lane at adoption. Deviation doc updated: the lane is
ported (narrowed), nothing dormant remains."
```

---

### Task 8: E2E spec — fresh terminal, candidate adoption, identity-bearing turn-complete

**Files:**
- Create: `test/e2e-browser/specs/codex-status-completeness-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (2 one-line appends)

**Interfaces:**
- Consumes: `RustServer`/`createE2eServerHandle` (helpers), `TestHarness`, donor patterns from `specs/terminal-activity-rust.spec.ts` (`WsCapture` :61-111, `installFakeCli` :48-54, `bootAndConnect` :129-139, `openCliPaneAndGetTerminalId` :155-177, `tabBlueIcons` :185-187 — all spec-local; COPY them into the new file, they are not exported).
- Produces: the spec file that Tasks 9-10 extend with two more tests.

- [ ] **Step 1: Create the spec skeleton + test 1 (RED)**

Create `test/e2e-browser/specs/codex-status-completeness-rust.spec.ts`. Copy the following spec-local helpers verbatim from `specs/terminal-activity-rust.spec.ts` (adjusting imports; `.js` extensions per ESM): `installFakeCli`, `FAKE_BEL_CLI` const, `WsCapture` (add ONE method to the copy — `send(frame: unknown): void { this.ws.send(JSON.stringify(frame)) }`), `bootAndConnect`, `openCliPane`, `openCliPaneAndGetTerminalId`, `collectLeaves`, `typePromptIntoLastPane`, `tabBlueIcons`, `selectShellIfPickerShowing`.

Then add:

```ts
import { test, expect } from './helpers/fixtures.js' // match the donor spec's exact import line

const THREAD_A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0001'
const SESSION_TITLE = 'Codex status completeness seeded session'

/** Write a real dated rollout owned by `sessionId` under <home>/.codex.
 * Mirrors the donor seeds (codex-terminal-bounce-rust.spec.ts:129-131,
 * sidebar-click-resume.spec.ts:174-177): the `session_meta` record carries
 * identity/cwd, and the `response_item`/`message` records exist so a REAL
 * title is extracted -- Task 9's sidebar resume gesture selects the session
 * by that title text, so these records are load-bearing, not decoration. */
async function seedRollout(
  homeDir: string,
  sessionId: string,
  extraLines: string[] = [],
): Promise<string> {
  const rolloutDir = path.join(homeDir, '.codex', 'sessions', '2026', '07', '25')
  await fs.mkdir(rolloutDir, { recursive: true })
  const rolloutPath = path.join(rolloutDir, `rollout-2026-07-25T08-00-00-${sessionId}.jsonl`)
  const lines = [
    JSON.stringify({
      timestamp: '2026-07-25T08:00:00.000Z',
      type: 'session_meta',
      payload: { id: sessionId, cwd: os.tmpdir() },
    }),
    JSON.stringify({
      timestamp: '2026-07-25T08:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `${SESSION_TITLE} request 1` }],
      },
    }),
    JSON.stringify({
      timestamp: '2026-07-25T08:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: `${SESSION_TITLE} reply 1` }],
      },
    }),
    ...extraLines,
  ]
  await fs.writeFile(rolloutPath, `${lines.join('\n')}\n`)
  return rolloutPath
}

function taskEventLine(payloadType: string, isoTs: string): string {
  return JSON.stringify({ timestamp: isoTs, type: 'event_msg', payload: { type: payloadType } })
}

test.describe('Codex status completeness (Rust only)', () => {
  test.setTimeout(240_000)

  test('fresh codex terminal: candidate adoption stamps sessionId on turn-complete', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-status-'))
    const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
    let rolloutPath = ''
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {
        env: { CODEX_CMD: fakeCodex },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(
            path.join(freshellDir, 'config.json'),
            JSON.stringify(
              { version: 1, settings: { codingCli: { enabledProviders: ['codex'] } } },
              null,
              2,
            ),
          )
          rolloutPath = await seedRollout(homeDir, THREAD_A)
        },
      },
    })
    const info = await server.start()
    const capture = new WsCapture(info.baseUrl, info.token)
    try {
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const tabId = await harness.getActiveTabId()

      // FRESH codex pane -- created with no resume id: the G3 gap state.
      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Codex/i, 'codex')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('fake-cli>')
        }, { timeout: 15_000 })
        .toBe(true)

      // The client announces the persisted rollout (candidate adoption).
      capture.send({
        type: 'terminal.codex.candidate.persisted',
        terminalId,
        candidateThreadId: THREAD_A,
        rolloutPath,
      })
      // Adoption is observable on the wire: identity upsert...
      await capture.waitFor(
        (f) =>
          f.type === 'codex.activity.updated' &&
          f.upsert?.some((r: any) => r.terminalId === terminalId && r.sessionId === THREAD_A),
        10_000,
        'adopted identity upsert',
      )

      // ...and the payoff: a full turn's completion carries the sessionId.
      await typePromptIntoLastPane(page, 'do the thing')
      const complete = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        15_000,
        'identity-bearing turn complete',
      )
      expect(complete.provider).toBe('codex')
      expect(complete.sessionId).toBe(THREAD_A)
    } finally {
      capture.close()
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
```

Verify the exact client-frame field casing against the Rust protocol type for `TerminalCodexCandidatePersisted` (`crates/freshell-protocol`, `rename_all = "camelCase"` convention → `terminalId`/`candidateThreadId`/`rolloutPath`); if the wire names differ, match the protocol. Known required field the snippet above omits: `capturedAt` (protocol `captured_at: i64`, client_messages.rs:229) — include it (e.g. `capturedAt: Date.now()`), or the frame is rejected on deserialize.

NOTE (validated scope, see the Validation record): no Rust code emits `terminal.codex.durability.updated` today, so the production client never sends this candidate frame against the Rust server — the trigger chain goes live at S5. This spec's raw-WS injection is the established protocol-level proof of the server-side adopt path (same pattern as `crates/freshell-ws/tests/codex_candidate_persisted.rs`); it is honest evidence for the SERVER half of G3-fresh, and the plan documents the S5 dependency explicitly rather than claiming production-trigger coverage.

- [ ] **Step 2: Register the spec (both lists — the safe convention)**

In `test/e2e-browser/playwright.config.ts`:

1. Append to `RUST_ONLY_SPECS` (:82-92):
```ts
  /codex-status-completeness-rust\.spec\.ts$/,
```
2. Append to the `rust-chromium` project's `testMatch` array (before its closing `]`):
```ts
        // Rust-only: drives RustServer directly (restartAbrupt + raw WS frames).
        /codex-status-completeness-rust\.spec\.ts$/,
```

- [ ] **Step 3: Run the test to verify it fails or passes for the RIGHT reason**

```bash
cd /home/dan/code/freshell/.worktrees/codex-status-completeness
npm run build:server 2>/dev/null || true   # only if the harness needs it; RustServer builds the rust binary itself
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium codex-status-completeness -g "candidate adoption"
```
Expected: PASS (the Rust work from Tasks 1-7 is already committed). If it fails, the failure is a REAL integration bug — debug the server logs at `info.debugLogPath`, fix in the Rust layer, and re-run. Do not weaken assertions. (RED for this test was established at the Rust layers; this e2e is the integration proof.)

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/codex-status-completeness-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): fresh codex terminal adoption stamps sessionId on turn-complete (G3)"
```

---

### Task 9: E2E — restartAbrupt mid-codex-turn, restore converges to busy then completes

**Files:**
- Modify: `test/e2e-browser/specs/codex-status-completeness-rust.spec.ts`

**Interfaces:**
- Consumes: Task 8's helpers (including the title-bearing `seedRollout` — the sidebar gesture selects the session by its extracted title, so the seeded `response_item`/`message` records are load-bearing); `RustServer.restartAbrupt()` (rust-server.ts:344 — SIGKILL process group, reboot on SAME home/port/token; `setupHome` re-runs on every boot — make it idempotent, do NOT overwrite the rollout on re-run); `fixtures/fake-codex-cli.mjs` (resume-aware fake, donor install pattern at `codex-terminal-bounce-rust.spec.ts:51-57`); sidebar resume gesture (donor: the gesture block in `codex-terminal-bounce-rust.spec.ts`, ~:181-218 — wait for the `sidebar-session-list` testid, click `page.getByText(SESSION_TITLE, { exact: false }).first()`, and NOTE: the click opens a NEW tab — the donor waits for `getTabCount() === tabCountBefore + 1` then reads `getActiveTabId()`; same pattern in `sidebar-click-resume.spec.ts:218-256`).
- Produces: nothing downstream.

- [ ] **Step 1: Add the test**

Append inside the describe block. This test imports `RustServer` directly (it needs `restartAbrupt`):

```ts
  test('restartAbrupt mid-codex-turn: restored pane seeds busy from the rollout, then completes with identity', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-restart-'))
    const fakeCodex = await installFakeCli(
      path.join(sharedRoot, 'bin'),
      'codex',
      path.resolve(__dirname, '../fixtures/fake-codex-cli.mjs'),
    )
    let rolloutPath = ''
    const server = new RustServer({
      env: { CODEX_CMD: fakeCodex },
      setupHome: async (homeDir) => {
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(
          path.join(freshellDir, 'config.json'),
          JSON.stringify(
            { version: 1, settings: { codingCli: { enabledProviders: ['codex'] } } },
            null,
            2,
          ),
        )
        // Idempotent across restartAbrupt's setupHome re-run: seed only once.
        const candidate = path.join(
          homeDir, '.codex', 'sessions', '2026', '07', '25',
          `rollout-2026-07-25T08-00-00-${THREAD_A}.jsonl`,
        )
        try {
          await fs.access(candidate)
          rolloutPath = candidate
        } catch {
          rolloutPath = await seedRollout(homeDir, THREAD_A)
        }
      },
    })
    try {
      const info = await server.start()
      const harness = await bootAndConnect(page, info)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Resume the seeded session from the sidebar (donor gesture:
      // codex-terminal-bounce-rust.spec.ts ~:181-218 -- click the seeded
      // session's TITLE entry; the click opens a NEW tab, so all later
      // assertions target the returned resumeTabId, not the boot tab).
      // The rollout is currently RESOLVED (no task events), so no busy yet.
      const { tabId: resumeTabId, terminalId } = await resumeCodexSessionFromSidebar(
        page,
        harness,
        SESSION_TITLE,
      )

      // The turn goes mid-flight on disk (codex writes task_started), then
      // the server dies abruptly -- the classic mid-turn crash.
      await fs.appendFile(rolloutPath, `${taskEventLine('task_started', '2026-07-25T09:00:00.000Z')}\n`)
      await server.restartAbrupt()

      // The page's WS auto-reconnects; the client restores the pane, which
      // re-creates the terminal with the resume id -> locator attaches the
      // lane -> initial drain sees the unresolved start -> BUSY (blue).
      await harness.waitForConnection(30_000)
      const capture = new WsCapture(info.baseUrl, info.token)
      try {
        await capture.ready()
        const restoredId = await waitForRestoredCodexTerminalId(harness, resumeTabId, terminalId)
        await capture.waitFor(
          (f) =>
            f.type === 'codex.activity.updated' &&
            f.upsert?.some(
              (r: any) =>
                r.terminalId === restoredId && r.phase === 'busy' && r.sessionId === THREAD_A,
            ),
          20_000,
          'resume-busy seeding after abrupt restart',
        )
        await expect(tabBlueIcons(page, resumeTabId)).not.toHaveCount(0, { timeout: 10_000 })

        // The (dead) turn's completion arrives on disk -> lane clears it.
        await fs.appendFile(rolloutPath, `${taskEventLine('task_complete', '2026-07-25T09:05:00.000Z')}\n`)
        await capture.waitFor(
          (f) =>
            f.type === 'codex.activity.updated' &&
            f.upsert?.some((r: any) => r.terminalId === restoredId && r.phase === 'idle'),
          15_000,
          'reconcile clear -> idle',
        )
        const complete = await capture.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === restoredId,
          15_000,
          'reconcile-lane turn complete',
        )
        expect(complete.provider).toBe('codex')
        expect(complete.sessionId).toBe(THREAD_A)
        await expect(tabBlueIcons(page, resumeTabId)).toHaveCount(0, { timeout: 10_000 })
      } finally {
        capture.close()
      }
    } finally {
      await server.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

Implement the two helpers in the same file:
- `resumeCodexSessionFromSidebar(page, harness, title): Promise<{ tabId: string; terminalId: string }>` — mirror the sidebar resume gesture from `codex-terminal-bounce-rust.spec.ts` (~:181-218), copying the donor's selectors and waits exactly:
  1. `await expect(page.getByTestId('sidebar-session-list')).toBeVisible(...)` (the donor does not toggle the sidebar open — the list is already rendered);
  2. `const sessionItem = page.getByText(title, { exact: false }).first()` and wait for it visible — this is why `seedRollout`'s `response_item`/`message` records are load-bearing: the sidebar entry's text IS the extracted title;
  3. `const tabCountBefore = await harness.getTabCount()`, then `await sessionItem.click()`;
  4. the click opens a NEW tab (donor invariant): `await expect(async () => { expect(await harness.getTabCount()).toBe(tabCountBefore + 1) }).toPass({ timeout: 15_000 })`, then `const tabId = await harness.getActiveTabId()` (assert truthy);
  5. poll THAT new tab's pane layout — same `collectLeaves` polling as `openCliPaneAndGetTerminalId` — for the codex leaf and return `{ tabId, terminalId }`.
- `waitForRestoredCodexTerminalId(harness, tabId, previousId)` — `expect.poll` the pane layout of the RESUME tab (the returned `tabId` above, which persists client-side across the abrupt restart) until a codex leaf has a `terminalId` different from `previousId` (the restore mints a new terminal), return it.

- [ ] **Step 2: Run the test**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium codex-status-completeness -g "restartAbrupt"
```
Expected: PASS. This is the integration proof of the G9 headline ("restored mid-turn shows busy, then converges"). Any failure is a real bug — check `debugLogPath`, fix at the Rust layer, re-run.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/codex-status-completeness-rust.spec.ts
git commit -m "test(e2e): abrupt restart mid-codex-turn seeds busy on restore and completes with identity (G9)"
```

---

### Task 10: E2E — two concurrent RustServers, independent codex status streams

**Files:**
- Modify: `test/e2e-browser/specs/codex-status-completeness-rust.spec.ts`

**Interfaces:**
- Consumes: Task 8's helpers. Two concurrent `RustServer`s isolate cleanly today: each mkdtemps its own HOME (`applyIsolatedHomeEnvironment` derives per-instance `CODEX_HOME`), own `findFreePort()` port, own token, own process group (no spec does this yet — this is new ground, per e2e recon §6).
- Produces: nothing downstream.

- [ ] **Step 1: Add the test**

This test drives both servers over raw WS (no page needed for server B; use the page for server A only, or drive both via WS captures + `browser.newContext()` for a second page — the simpler raw-WS variant is fine because the assertion target is stream independence, not DOM):

```ts
  test('two concurrent servers keep independent codex status streams', async ({
    page,
    e2eServerKind,
    browser,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-codex-twin-'))
    const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', FAKE_BEL_CLI)
    const mkServer = () =>
      new RustServer({
        env: { CODEX_CMD: fakeCodex },
        setupHome: async (homeDir) => {
          const freshellDir = path.join(homeDir, '.freshell')
          await fs.mkdir(freshellDir, { recursive: true })
          await fs.writeFile(
            path.join(freshellDir, 'config.json'),
            JSON.stringify(
              { version: 1, settings: { codingCli: { enabledProviders: ['codex'] } } },
              null,
              2,
            ),
          )
        },
      })
    const serverA = mkServer()
    const serverB = mkServer()
    let contextB: import('@playwright/test').BrowserContext | undefined
    try {
      const [infoA, infoB] = await Promise.all([serverA.start(), serverB.start()])
      expect(infoA.port).not.toBe(infoB.port)

      const captureA = new WsCapture(infoA.baseUrl, infoA.token)
      const captureB = new WsCapture(infoB.baseUrl, infoB.token)
      try {
        await Promise.all([captureA.ready(), captureB.ready()])

        // Server A: page-driven codex pane + a full turn.
        const harnessA = await bootAndConnect(page, infoA)
        await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabA = await harnessA.getActiveTabId()
        const terminalA = await openCliPaneAndGetTerminalId(page, harnessA, tabA!, /Codex/i, 'codex')

        // Server B: second browser context, its own codex pane + turn.
        contextB = await browser.newContext()
        const pageB = await contextB.newPage()
        const harnessB = await bootAndConnect(pageB, infoB)
        await expect(pageB.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
        const tabB = await harnessB.getActiveTabId()
        const terminalB = await openCliPaneAndGetTerminalId(pageB, harnessB, tabB!, /Codex/i, 'codex')

        // Drive a turn on A only.
        await typePromptIntoLastPane(page, 'turn on A')
        const completeA = await captureA.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalA,
          15_000,
          'A turn complete',
        )
        expect(completeA.provider).toBe('codex')

        // Independence: B's stream never saw A's terminal, and vice versa.
        expect(captureB.count((f) => f.terminalId === terminalA)).toBe(0)
        expect(captureA.count((f) => f.terminalId === terminalB && f.type === 'terminal.turn.complete')).toBe(0)

        // Now a turn on B, proving B's stream is live and independent.
        await pageB.locator('.xterm').last().click()
        await pageB.keyboard.type('turn on B')
        await pageB.keyboard.press('Enter')
        const completeB = await captureB.waitFor(
          (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalB,
          15_000,
          'B turn complete',
        )
        expect(completeB.provider).toBe('codex')
        expect(completeB.completionSeq).toBe(1)
        expect(captureA.count((f) => f.terminalId === terminalB)).toBe(0)
      } finally {
        captureA.close()
        captureB.close()
      }
    } finally {
      await contextB?.close().catch(() => {})
      await Promise.all([
        serverA.stop().catch(() => {}),
        serverB.stop().catch(() => {}),
      ])
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

- [ ] **Step 2: Run the test**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium codex-status-completeness -g "two concurrent"
```
Expected: PASS. (Validated, V6: concurrent `start()`s are safe — `ensureRustServerBuilt` uses `spawnSync`, which serializes builds on the event loop, and all instance state is instance-scoped. Known loud-flake mode: on a COLD build, both `findFreePort()` probes resolve before the first build finishes, widening the port-reuse TOCTOU window; if the test flakes on a bind failure, the fix is a warm binary — run any rust e2e first, or set `FRESHELL_E2E_RUST_SERVER_BIN` — NOT staggered starts.)

- [ ] **Step 3: Run the whole new spec file**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium codex-status-completeness
```
Expected: 3/3 PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/codex-status-completeness-rust.spec.ts
git commit -m "test(e2e): two concurrent rust servers keep independent codex status streams"
```

---

### Task 11: Full verification, push, STOP before PR

**Files:** none new.

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch + red→green evidence for the report.

- [ ] **Step 1: Rust quality gates**

```bash
cd /home/dan/code/freshell/.worktrees/codex-status-completeness
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: all clean/PASS. Fix any findings (formatting via `cargo fmt --all`).

- [ ] **Step 2: Coordinated JS suite (gate-aware)**

```bash
npm run test:status   # if another agent holds the gate, WAIT and re-check; never kill a foreign holder
FRESHELL_TEST_SUMMARY="lane D codex status completeness" npm run check
```
Expected: typecheck + coordinated full suite PASS. (Four sibling lanes run concurrently — waiting at the gate is expected and correct.)

- [ ] **Step 3: E2E confirmation of the new spec**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium codex-status-completeness
```
Expected: 3/3 PASS.

- [ ] **Step 4: Push the branch — and STOP**

```bash
git log --oneline origin/main..HEAD   # review the task commits
git push -u origin HEAD
```

Then STOP. Do NOT run `gh pr create` or any equivalent — PR creation is not yet approved. Report: branch name, commit list, and the red→green proof per task (each task's Step "verify it fails" output followed by its passing run).

---

## Self-Review

**1. Spec coverage.**
- G3 identity binder additive at top of `impl ActivityHub` (~:160): Task 2. Routed through the idempotent session-update branch shape: Task 1 (`bind_session` mirrors codex.rs:124-134 / amplifier tracker.rs:142-155). Called from the codex_candidate adopt path: Task 3. Amplifier hook pattern verified and mirrored (`amplifier_association.rs:160-166`): Tasks 2/3. Red test "fresh codex terminal + adopted candidate → turn_complete carries session id": Task 1 (tracker), Task 2 (hub payoff assert), Task 3 (integration), Task 8 (e2e). ✓
- G9 decision required in plan stage, both options evaluated honestly, bias to port: Decision record section; PORT chosen with evidence (legacy read: `codex-activity-tracker.ts` reconcile/seeding rules, `providers/codex.ts:344-376` discriminators, ~235 LOC, parsing already ported). Real Busy phase + resume-busy seeding: Tasks 4-7. Unit tests pin every reachable phase transition including previously-dead Busy/Unknown/deadman/`transition_after_turn_clear`: Task 4. Unreachable-state situation does not survive (machinery made live, not deleted; deviation doc rewritten): Tasks 4, 7. ✓
- E2E requirements: own RustServers via ephemeral ports (never 3001/3002): all e2e tasks. Fresh terminal → adoption → turn-complete WITH sessionId: Task 8. `restartAbrupt()` mid-codex-turn then restore → busy convergence (port chosen → busy asserted, not expected-fail): Task 9. TWO concurrent RustServer instances, independent streams: Task 10. New specs = new file; playwright.config minimal appends: Task 8. ✓
- Scope fence: owned files only + justified additive touches (File Structure table + Global Constraints); Lane A/B regions untouched (`codex_frames` et al. only CALLED; `attach_lane`/`drain_lane` untouched; the single Exit-arm line is outside both regions); terminal.rs/registry.rs/idle.rs/client src untouched. ✓
- Repo rules: TDD per task, coordinator-gate awareness (Tasks 1 step 0, 11), no server restarts, no broad kills, PR stop: Global Constraints + Task 11. ✓

**1b. No silent deferrals.** Every requirement lands in production behavior with a real-outcome test: identity on the wire (e2e Task 8 asserts the actual `terminal.turn.complete` frame), busy from disk truth (e2e Task 9 restores against a real rollout file after a real SIGKILL restart), stream isolation (Task 10, two real servers). Fake CLIs (`fake-bel-cli`, `fake-codex-cli`) are the repo's established CI-safe provider stand-ins (campaign convention; real-provider contracts remain opt-in via `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`) — they stub the codex BINARY, not the behavior under test (freshell's status pipeline). No TODO/stub/expected-fail remains. One EXPLICIT (not silent) scope boundary from the load-bearing validation pass: the fresh-terminal candidate-adopt trigger chain is production-inert until S5 ports the durability emitter (Validation record item 5) — the server-side adopt path this plan builds is exactly what S5 plugs into, the resume path is production-live now, and Task 8 states what its raw-WS injection does and does not prove. No UNRESOLVED COVERAGE GAPS.

**1c. Load-bearing validation applied.** The validation pass (ledger: `.worktrees/.the-usual-logs/codex-status-completeness/load-bearing-ledger.md`) verified 5 assumptions and falsified 3; every falsification is reflected above: S5 trigger note (Validation record + Task 8), CE1/CE2 dedupe fixes with pinning tests (Task 4 Steps 1/3d), `spawn_blocking` locator (Task 7a), plus sibling-composition rules (Global Constraints) and the Task 10 cold-build flake contingency.

**2. Placeholder scan.** No TBD/TODO/"implement later"/"add appropriate handling". Two intentional donor-mirroring instructions remain with exact file:line donors and full surrounding code: the `spawn_server_with_specs_and_activity` body (Task 3 — byte-copy of an existing function plus two quoted insertions) and the sidebar-resume gesture helper (Task 9 — donor `codex-terminal-bounce-rust.spec.ts:101-162`, with the helper's contract and polling implementation specified). These reference existing repo code by exact location, not future work.

**3. Type consistency.**
- `bind_session(&mut self, terminal_id: &str, session_id: &str) -> Vec<CodexEffect>` — defined Task 1, called Tasks 2 and 6 with `&str` args. ✓
- `CodexTaskEvents { latest_task_started_at/latest_task_completed_at/latest_turn_aborted_at: Option<i64> }` + `is_empty()` — defined Task 4 (pub, with `Default`), consumed Task 5 (`fold_task_events` return) and Task 6 (`reconcile_rollout` arg, `is_empty` gate). ✓
- `reconcile_rollout(&mut self, terminal_id: &str, events: &CodexTaskEvents, at: i64) -> Vec<CodexEffect>` — defined Task 4, called Task 6. ✓
- `RolloutTailer::{new, attach() -> io::Result<u64>, read_new_lines() -> Vec<String>}` — defined Task 5, consumed Task 6 (all three). ✓
- `fold_task_events(&[String]) -> CodexTaskEvents`, `locate_codex_rollout(&Path, &str) -> Option<PathBuf>` — defined Task 5 (`pub(crate)`; locator promoted to `pub` in Task 7 with the re-export), consumed Tasks 6/7. ✓
- `bind_codex_session(&self, &str, &str)`, `attach_codex_rollout(&self, &str, &str, &Path)`, `set_codex_rollout_locator(&self, CodexRolloutLocator)` — defined Tasks 2/6, called Tasks 3/6/7 and tests, matching signatures. ✓
- Helper name discipline: codex uses `changed`, claude uses `commit_change` — Task 1 uses `changed`. ✓
- `swallow_next_bel: bool` — private `TerminalActivity` field (Task 4b), armed only inside `reconcile_rollout` (Task 4c), consumed only inside `note_input`/`note_output` (Task 4d) — no cross-task signature impact. ✓
- E2E helper names (`WsCapture.send`, `seedRollout`, `taskEventLine`, `resumeCodexSessionFromSidebar`, `waitForRestoredCodexTerminalId`) consistent across Tasks 8-10. ✓
