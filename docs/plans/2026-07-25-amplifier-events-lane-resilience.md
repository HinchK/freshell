# Amplifier Events-Lane Resilience Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** The amplifier CLI's status pipeline (events.jsonl tail lane) survives transient failures with bounded re-attach + backoff instead of going permanently status-inert (GAP G4), and never replays an unbounded backlog on Start-attach (GAP G8, 4 MiB cap with EOF fallback, parity with the frozen TS reference).

**Architecture:** All changes live in `crates/freshell-ws/src/activity.rs` (the `ActivityHub`); the tailer (`crates/freshell-activity/src/amplifier/tailer.rs`) stays pure and unchanged. G8 is a stat-and-downgrade decision at the `attach_lane` call site. G4 adds per-terminal retry bookkeeping (`lane_retries: HashMap<String, LaneRetry>` on `HubInner`), a bounded backoff schedule (`[250, 1000, 3000]` ms, then loud give-up), a fifth deadline source folded into the hub's existing single one-shot timer (`hub_next_deadline` + `expire_due` — never `tokio::time::sleep`), and per-attempt re-resolution of the events path via the hub's existing `resolver` (port of the legacy sessionId-keyed `resolveEventsPath` semantics).

**Tech Stack:** Rust (tokio, notify 6.1.1, tracing), cargo test for unit/hub tests; Playwright + `RustServer` fixture for browser e2e.

## Global Constraints

- **Worktree:** all work happens in `/home/dan/code/freshell/.worktrees/amplifier-events-lane-resilience`, branched from `origin/main` @ `2bf579e6`. All file paths below are relative to that worktree root.
- **Scope fence (5-lane parallel wave — Lane B owns ONLY):** `crates/freshell-ws/src/activity.rs` `attach_lane`/`drain_lane` and surrounding hub plumbing (lane struct, `HubInner`, `hub_next_deadline`, `expire_due`, `handle_event`, exit teardown, tests module), plus `crates/freshell-activity/src/amplifier/*` if needed (this plan needs NO change there). Do NOT touch: `crates/freshell-activity/src/idle.rs`; the frames/arming block in activity.rs (`claude_frames`, `codex_frames`, `amplifier_frames`, `note_busy_upserts` — currently activity.rs:589-731; CALLING them is fine, modifying is not); codex tracker internals (Lane D); `crates/freshell-*/src/terminal.rs` / `registry.rs` (Lane E); client `src/` (Lane C); `shared/ws-protocol.ts` (pinned wire contract — do not change unilaterally). No kimi/gemini/opencode changes.
- **Wire contract:** emit ONLY existing frame shapes (`amplifier.activity.updated` with `remove`/`upsert`, `terminal.turn.complete`, `terminal.idle`). Do NOT add `AmplifierPhase::Unknown` or any new frame/field (see Design Decisions).
- **Zero-polling invariant:** the hub has exactly one one-shot timer. Retry deadlines MUST flow through `hub_next_deadline` + `expire_due`. Never `tokio::time::sleep` in hub logic. The test `idle_terminals_arm_no_timers_and_read_no_files` (activity.rs:1115-1148) must stay green.
- **G8 parity values (verbatim from `server/coding-cli/amplifier-activity-integration.ts:50, 313-330`):** cap constant `AMPLIFIER_CATCHUP_MAX_BYTES = 4 * 1024 * 1024`, strict `>` comparison, log event `amplifier_events_catchup_skipped` with `size_bytes`/`cap_bytes` fields, and a failed `metadata()` stat (file not yet created) must NOT count as over-cap.
- **TDD:** Red-Green-Refactor at unit and hub level — write the failing test, RUN it, watch it fail for the right reason, then implement. E2E specs are written after implementation as end-to-end proof (per the task spec, red-first is mandated at unit/hub level).
- **Process safety:** never restart the user's self-hosted Freshell server; never broad kill patterns (`pkill -f ...`); e2e servers use `findFreePort()` via the `RustServer` fixture — NEVER ports 3001/3002 (the user's LIVE servers).
- **Test coordination:** broad Vitest runs (`npm test`, `npm run check`) wait for the shared coordinator gate — four sibling lanes run concurrently. Set `FRESHELL_TEST_SUMMARY="lane-b amplifier events-lane resilience"` for broad runs. WAIT if another agent holds the gate; never kill a foreign holder. `cargo test` is not coordinated and may run freely.
- **TS specs:** NodeNext/ESM — relative imports must include `.js` extensions.
- **PR policy:** NOT yet approved. Push the branch, STOP before `gh pr create`. Report branch + red→green proof.
- **Commits:** focused and atomic, one per task step-5, with the Amplifier co-author trailer.

## Design Decisions (locked in; do not re-litigate mid-execution)

1. **Give-up-loudly signal = tracker-record removal via existing frames.** There is no existing "degraded" frame the client renders (verified: grepping client for `degraded` finds only an unrelated ws-reconnect log; `AmplifierPhase` is `{Idle, Busy}` only). The task spec forbids inventing a new client-side feature, and `shared/ws-protocol.ts` is a pinned contract owned outside this lane. What removal actually buys (validated against the frozen client, Stage-2 load-bearing check): a `remove` **clears a stale busy indication** — the sole apply site `App.tsx:1135-1141` deletes `byTerminalId[tid]` and busy rendering requires `record?.phase === 'busy'` (`src/lib/pane-activity.ts:164-172`) — so the pane can never freeze busy-stale. It is **NOT visually distinct from ordinary idle**: `resolvePaneIdleGreen` (`pane-activity.ts:248-252`) falls back to `sessionRef?.sessionId`, which every associated pane has, so post-remove the idle-green stays lit and the end state is pixel-identical to a normal idle pane. Alternatives inside the pinned contract were evaluated and rejected (an idle-phase upsert also looks like idle but additionally leaves a stale record implying a live lane; a new frame/field is forbidden) — removal remains the best available effect. The "loud" components are therefore: stale-busy clearing + `amplifier_list()` consistency for late joiners + a `tracing::error!` with event `amplifier_events_lane_dead`. Implementation: on give-up, call `inner.amplifier.note_exit(terminal_id)` and route its effects through `amplifier_frames` (calling, not modifying) — this emits `{"type":"amplifier.activity.updated","remove":["<tid>"]}`. **Intended consequence (validated):** after `note_exit`, the tracker no-ops `note_input`/`note_output`/`bind_session` for that terminal (`tracker.rs:245-247, 267-269, 144`), so ALL amplifier status — including PTY-side provisional busy — stays dead until the pane/terminal is recreated (the locator will not re-fire for a bound terminal). This is deliberate: a lane that failed 3 consecutive re-attaches must not half-track status that may be wrong.
2. **Retry schedule:** `AMPLIFIER_LANE_RETRY_DELAYS_MS: [i64; 3] = [250, 1000, 3000]` (mirrors the repo's bounded-retry exemplar `crates/freshell-tauri/src/renderer_recovery.rs:44`). Max 3 re-attach attempts; a successful `Ok` read resets the counter. Exposed as `pub(crate) const` so tests assert the schedule directly.
3. **Re-attach always at `AttachAt::Eof`** — a rotated/reset file's history is not ours to replay, and Eof-attach is the cheap `size == offset` no-op path.
4. **Fresh state on every re-attach:** both `AmplifierEventsTailer.degraded` (tailer.rs:84, checked at :114) and `ReducerState.degraded` (reducer.rs:99, checked at :173) are sticky one-way latches. Every re-attach constructs a fresh `AmplifierEventsTailer::new(path)` + fresh `create_reducer_state()` — which `attach_lane` already does, so re-attach = re-invoking `attach_lane`. A fresh **watcher** per attach is likewise *required*, not merely tidy (validated empirically against notify 6.1.1): on `DELETE_SELF` notify silently drops the file watch (inotify backend L300), so a recreated same-path file emits nothing from the old watcher — only drop-and-re-attach recovers.
5. **`SchemaMismatch` never retries** — it is deterministic (the file's first lifecycle record fails the schema gate; retrying re-reads the same record). Give up loudly on the first occurrence. `ReadError` and `FileReset` are the transient, retry-worthy classes. Validated: the frozen TS reference treated schema mismatch identically to every other degrade — terminal, zero retries (`amplifier-activity-integration.ts:193-221, 232-235`), so never-retry is strictly MORE generous than legacy parity; and the Rust gate cannot fire transiently on a torn line — it evaluates only complete, newline-terminated, fully-parsed lifecycle records (tailer.rs:228, 246, 255-279; torn-line buffering proven by the existing tailer test :407-436). The theoretical hole (a schema-bad file later *replaced* by a valid one) is inherited from legacy and unrecoverable within a ≤4.25 s retry window anyway — accepted.
6. **Path re-resolution (legacy port):** legacy resolution is pure sessionId keying (`indexer.getFilePathForSession(sessionId)`); a re-attach never carries offsets over and re-derives the path from the session id. Port: at each retry attempt, prefer `self.resolver(session_id)` (wired in production to `resolve_amplifier_events_path`, main.rs:1019-1032) and fall back to the `events_path` captured at degrade time (unit tests run with `resolver = None`). Scope of what this covers (corrected by Stage-2 validation): re-resolution recovers **same-session-id path moves only** (e.g. a project-slug directory change) — the walk is sid-keyed over existing files. An amplifier *restart inside the same terminal* produces a NEW session id that nothing re-attaches: locator arming happens only at terminal create (terminal.rs:1394), a successful location permanently disarms it (amplifier_locator.rs:554-556), and both `arm()` and `drain_and_associate` reject already-bound terminals (amplifier_locator.rs:238-240; amplifier_association.rs:128-134). That new-sid gap is inherited unchanged from legacy (whose `resolveEventsPath` is equally sid-keyed, integration.ts:98/405/440) and is OUT OF SCOPE for this lane — the resolver call is kept because it is cheap, harmless, and exact legacy parity.
7. **Initial-attach failures join the same machinery.** `attach_lane` today has three silent `warn + return` failure paths (tailer attach fail, watcher create fail, `watcher.watch()` fail). All three now route into the same failure handler, so a transient failure at first attach also gets bounded retries instead of silent permanent death. Safety validated (no lazy-creation false positive): both producers of `events_path` guarantee an already-existing, content-verified file — the locator emits `Located` only after `probe_events_file` opened and parsed the file (amplifier_locator.rs:604-666, :501-514; missing file = `NotReady` retry, :424-430), and the resume resolver returns only `is_file()` paths with `None` skipping the attach entirely (main.rs:1027; activity.rs:288) — so an initial-attach failure is always a genuine fault and can never burn retries then destructively give up on a healthy fresh session. (Empirically: `watcher.watch()` on a missing path returns `Err(Io(NotFound))`.) Note: `AttachAt::Start` performs no fs call at attach time (tailer.rs:127), so the tailer-attach-fail branch is effectively reachable only for resume/Eof attaches.
8. **G8 lives in `attach_lane`, not the tailer** — stat once at the call site, downgrade `Start`→`Eof` when over cap. The tailer stays pure.

## File Structure

- **Modify:** `crates/freshell-ws/src/activity.rs` — all production changes (constants, two pure helpers, `LaneRetry`, `HubInner.lane_retries`, `AmplifierLane` fields, `note_lane_failure`, `handle_attach_failure`, `attach_lane`, `drain_lane`, `expire_due`, `hub_next_deadline`, exit teardown) and all new unit/hub tests (in the existing `#[cfg(test)] mod tests`).
- **Create:** `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts` — three browser e2e tests (truncation recovery, abrupt-restart recovery, dual-server independence).
- **Modify:** `test/e2e-browser/playwright.config.ts` — two one-line regex appends (rust-chromium `testMatch` + `RUST_ONLY_SPECS`).

No other files change. No new dependencies.

---

### Task 1: G8 pure decision helper — `effective_attach_at` + catch-up cap constant

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` (constants near the top after imports, ~line 58 area; test in the `#[cfg(test)] mod tests` module at the bottom, which starts at :749)

**Interfaces:**
- Consumes: `AttachAt` (already imported in activity.rs from `freshell_activity::amplifier::tailer`).
- Produces: `pub(crate) const AMPLIFIER_CATCHUP_MAX_BYTES: u64`, `pub(crate) fn effective_attach_at(requested: AttachAt, file_len: Option<u64>) -> AttachAt` — Task 2 wires this into `attach_lane`.

- [ ] **Step 1: Write the failing test**

Add inside `mod tests` in `crates/freshell-ws/src/activity.rs` (after the existing helper fns, alongside the other `#[test]`s):

```rust
    #[test]
    fn effective_attach_at_caps_oversized_start_attach() {
        // Missing file (stat failed / not yet created) must NEVER count as
        // over-cap: keep Start and let the first inotify event drive the read.
        assert_eq!(effective_attach_at(AttachAt::Start, None), AttachAt::Start);
        // Exactly at the cap: strict `>` keeps Start (parity with the frozen
        // TS reference, amplifier-activity-integration.ts:318).
        assert_eq!(
            effective_attach_at(AttachAt::Start, Some(AMPLIFIER_CATCHUP_MAX_BYTES)),
            AttachAt::Start
        );
        // One byte over: downgrade to Eof.
        assert_eq!(
            effective_attach_at(AttachAt::Start, Some(AMPLIFIER_CATCHUP_MAX_BYTES + 1)),
            AttachAt::Eof
        );
        // Eof requests are untouched regardless of size.
        assert_eq!(
            effective_attach_at(AttachAt::Eof, Some(AMPLIFIER_CATCHUP_MAX_BYTES + 1)),
            AttachAt::Eof
        );
    }
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-events-lane-resilience
cargo test -p freshell-ws effective_attach_at_caps_oversized_start_attach
```
Expected: COMPILE ERROR — `cannot find function effective_attach_at` / `cannot find value AMPLIFIER_CATCHUP_MAX_BYTES`.

- [ ] **Step 3: Write minimal implementation**

Add in `crates/freshell-ws/src/activity.rs`, module level, right after the `AmplifierEventsPathResolver` type alias (currently :58):

```rust
/// G8 parity with the frozen TS reference
/// (server/coding-cli/amplifier-activity-integration.ts:50): never replay an
/// events backlog larger than this at Start-attach — attach at Eof instead
/// and let live records take over.
pub(crate) const AMPLIFIER_CATCHUP_MAX_BYTES: u64 = 4 * 1024 * 1024;

/// Decide the effective attach point for an events lane. `file_len` is `None`
/// when the events file could not be stat'ed (fresh sessions create
/// events.jsonl lazily) — that must NOT count as over-cap.
pub(crate) fn effective_attach_at(requested: AttachAt, file_len: Option<u64>) -> AttachAt {
    match (requested, file_len) {
        (AttachAt::Start, Some(len)) if len > AMPLIFIER_CATCHUP_MAX_BYTES => AttachAt::Eof,
        (requested, _) => requested,
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
cargo test -p freshell-ws effective_attach_at_caps_oversized_start_attach
```
Expected: `test result: ok. 1 passed`.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs
git commit -m "feat(activity): add amplifier catch-up cap decision helper (G8)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: G8 wiring — cap enforced in `attach_lane`, hub-level proof

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` — `attach_lane` (currently :392-485) + one hub-level test in `mod tests`

**Interfaces:**
- Consumes: `effective_attach_at`, `AMPLIFIER_CATCHUP_MAX_BYTES` (Task 1); existing test helpers `hub()` (:754), `observer_send` (:760), `next_frame_matching` (:768), `amplifier_line` (:800).
- Produces: `attach_lane` behavior change only (signature unchanged in this task). Warn log event `amplifier_events_catchup_skipped` with fields `size_bytes`, `cap_bytes`.

- [ ] **Step 1: Write the failing hub-level test**

Add inside `mod tests`, mirroring the construction sequence of the existing model test `amplifier_events_lane_drives_busy_complete_and_idle_via_inotify` (:1021):

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn catchup_cap_attaches_at_eof_for_oversized_backlog() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        // > 4 MiB of pre-filter noise (skipped without parsing — no lifecycle
        // event prefix) followed by a lifecycle record that must NOT be
        // replayed once the cap downgrades the attach to Eof.
        let noise = format!("{{\"noise\":\"{}\"}}\n", "x".repeat(5 * 1024 * 1024));
        std::fs::write(
            &events_path,
            [noise, amplifier_line("prompt:submit")].concat(),
        )
        .unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);

        // The oversized backlog must NOT be replayed: no busy upsert appears.
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 1_500, |v| {
            v["upsert"]
                .as_array()
                .map(|u| u.iter().any(|r| r["phase"] == "busy"))
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_none(), "oversized backlog was replayed: {busy:?}");

        // The lane is LIVE at Eof: a freshly appended record drives busy.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes()).unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "live append after Eof attach did not drive busy");
    }
```

(`std::io::Write` is already imported at the top of `mod tests` (:752); `ActivityEvent::Created`'s exact field set is whatever the model test at :1022-1035 uses — copy it verbatim if it differs from the above.)

- [ ] **Step 2: Run test to verify it fails**

```bash
cargo test -p freshell-ws catchup_cap_attaches_at_eof_for_oversized_backlog
```
Expected: FAIL on the first assertion — `oversized backlog was replayed` (today the Start-attach replays the whole file, so the trailing `prompt:submit` drives a busy upsert).

- [ ] **Step 3: Write minimal implementation**

In `attach_lane`, immediately BEFORE the `tailer.attach(attach_at)` call (currently :400-401, i.e. right after `let mut tailer = AmplifierEventsTailer::new(events_path);`), insert the stat-and-downgrade:

```rust
        // G8: never replay an unbounded backlog. Stat once at the call site;
        // a failed stat means "file not created yet" and keeps Start.
        let file_len = std::fs::metadata(events_path).ok().map(|m| m.len());
        let effective = effective_attach_at(attach_at, file_len);
        if effective != attach_at {
            tracing::warn!(
                terminal_id = %terminal_id,
                session_id = %session_id,
                size_bytes = file_len.unwrap_or(0),
                cap_bytes = AMPLIFIER_CATCHUP_MAX_BYTES,
                "amplifier_events_catchup_skipped: events backlog exceeds the catch-up cap; attaching at EOF (live records take over)"
            );
        }
        let attach_at = effective;
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws activity::
```
Expected: PASS, including the new test and the existing model test at :1021 (which proves the sub-cap positive case — small backlogs ARE still replayed) and the zero-polling test at :1115.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs
git commit -m "feat(activity): cap amplifier Start-attach catch-up at 4 MiB, fall back to Eof (G8)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: G4 retry primitives — schedule, bookkeeping struct, deadline source

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` — constants + `lane_retry_delay_ms` (module level), `LaneRetry` struct, `HubInner.lane_retries` field, `hub_next_deadline` (currently :577-587); two pure tests in `mod tests`

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 4 and 5 rely on these exact names/types):
  - `pub(crate) const AMPLIFIER_LANE_RETRY_DELAYS_MS: [i64; 3] = [250, 1000, 3000];`
  - `pub(crate) fn lane_retry_delay_ms(failures: u32) -> Option<i64>` — delay before the `failures`-th consecutive failure's retry (1-based); `None` = exhausted.
  - `struct LaneRetry { session_id: String, events_path: PathBuf, failures: u32, next_attempt_at: Option<i64> }` (private, `#[derive(Debug, Clone)]`)
  - `HubInner.lane_retries: HashMap<String, LaneRetry>` (key = terminal id)
  - `hub_next_deadline` folds `lane_retries` `next_attempt_at` values in as a fifth source.

- [ ] **Step 1: Write the failing tests**

Add inside `mod tests`:

```rust
    #[test]
    fn lane_retry_schedule_is_bounded() {
        assert_eq!(lane_retry_delay_ms(1), Some(250));
        assert_eq!(lane_retry_delay_ms(2), Some(1_000));
        assert_eq!(lane_retry_delay_ms(3), Some(3_000));
        assert_eq!(lane_retry_delay_ms(4), None, "retries must be bounded");
    }

    #[test]
    fn lane_retry_deadline_feeds_hub_next_deadline() {
        let mut inner = HubInner::default();
        assert_eq!(hub_next_deadline(&inner), None);
        inner.lane_retries.insert(
            "t1".into(),
            LaneRetry {
                session_id: "sess-1".into(),
                events_path: PathBuf::from("/nonexistent/events.jsonl"),
                failures: 1,
                next_attempt_at: Some(12_345),
            },
        );
        assert_eq!(hub_next_deadline(&inner), Some(12_345));
        // An in-flight attempt (None) arms no timer — no polling, no busy loop.
        inner.lane_retries.get_mut("t1").unwrap().next_attempt_at = None;
        assert_eq!(hub_next_deadline(&inner), None);
    }
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-ws lane_retry
```
Expected: COMPILE ERROR — `lane_retry_delay_ms`, `LaneRetry`, and `lane_retries` do not exist.

- [ ] **Step 3: Write minimal implementation**

(a) Module level, right after the G8 constants from Task 1:

```rust
/// G4: bounded re-attach backoff schedule for a degraded events lane.
/// Index = failures-1; after the last entry the lane gives up LOUDLY.
/// Shape mirrors the repo's bounded-retry exemplar
/// (crates/freshell-tauri/src/renderer_recovery.rs:44).
pub(crate) const AMPLIFIER_LANE_RETRY_DELAYS_MS: [i64; 3] = [250, 1000, 3000];

/// Backoff delay before the retry that follows the `failures`-th consecutive
/// failure (1-based). `None` = retries exhausted.
pub(crate) fn lane_retry_delay_ms(failures: u32) -> Option<i64> {
    let index = failures.checked_sub(1)? as usize;
    AMPLIFIER_LANE_RETRY_DELAYS_MS.get(index).copied()
}
```

(b) Right above `struct HubInner` (currently :92):

```rust
/// G4: bookkeeping for a degraded amplifier events lane awaiting bounded
/// re-attach. Lives on `HubInner` (the lane itself is dropped on degrade).
#[derive(Debug, Clone)]
struct LaneRetry {
    session_id: String,
    events_path: PathBuf,
    /// Consecutive failures (degrades + failed re-attaches) since the last
    /// successful read. Reset by an `Ok` read, not by a successful attach.
    failures: u32,
    /// When the next re-attach fires. `None` while an attempt is in flight or
    /// has landed and awaits its first `Ok` read — arms no timer.
    next_attempt_at: Option<i64>,
}
```

(c) Add the field to `HubInner` (it derives `Default`; `HashMap` is `Default`-constructible):

```rust
    lanes: HashMap<String, AmplifierLane>,
    /// G4: terminal id → pending bounded re-attach bookkeeping.
    lane_retries: HashMap<String, LaneRetry>,
```

(d) Extend `hub_next_deadline` (currently :577-587) to a fifth source:

```rust
fn hub_next_deadline(inner: &HubInner) -> Option<i64> {
    [
        inner.claude.next_deadline(),
        inner.codex.next_deadline(),
        inner.amplifier.next_deadline(),
        inner.idle.next_deadline(),
        inner
            .lane_retries
            .values()
            .filter_map(|retry| retry.next_attempt_at)
            .min(),
    ]
    .into_iter()
    .flatten()
    .min()
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws activity::
```
Expected: PASS (both new tests; `idle_terminals_arm_no_timers_and_read_no_files` still green — an empty `lane_retries` contributes `None`).

Note: `LaneRetry`/`lane_retries` are constructed only by tests at this point — if the compiler warns `dead_code`/never-constructed, that is expected and disappears in Task 4; do NOT suppress it with `#[allow]`.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/activity.rs
git commit -m "feat(activity): lane-retry schedule, bookkeeping, and deadline source (G4 scaffolding)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: G4 mechanism — degrade schedules bounded re-attach; exhausted/permanent failures give up loudly

This is one coherent mechanism (schedule → fire → succeed-or-escalate → give up), so it carries one test cycle with four failing tests written up front.

**Files:**
- Modify: `crates/freshell-ws/src/activity.rs` — imports (:37), `AmplifierLane` (:85-90), `attach_lane` (:392-485), `drain_lane` (:487-545), `expire_due` (:549-574), exit teardown (:369 area), new methods `note_lane_failure` + `handle_attach_failure`; four hub-level tests in `mod tests`

**Interfaces:**
- Consumes: Task 3 primitives (`LaneRetry`, `lane_retries`, `lane_retry_delay_ms`); `TailerDegradeReason` (must be added to the existing import from `freshell_activity::amplifier::tailer`); existing tracker API `note_events_signal_lost` / `note_exit` and the callable-but-not-modifiable `amplifier_frames`.
- Produces: the full G4 behavior. Log events: `amplifier_events_lane_retry_scheduled` (warn), `amplifier_events_lane_reattach_attempt` (info), `amplifier_events_lane_dead` (error). Frame on give-up: `amplifier.activity.updated` with `remove: ["<terminal_id>"]` (via `note_exit` effects).

- [ ] **Step 1: Write the four failing tests**

Add inside `mod tests`. Also add this helper next to `amplifier_line` (:800):

```rust
    /// A lifecycle record whose schema version fails the gate (major != 1) —
    /// drives the tailer's deterministic SchemaMismatch degrade.
    fn bad_schema_line(event: &str) -> String {
        format!(
            "{}\n",
            serde_json::json!({
                "ts": crate::now_iso(),
                "schema": { "name": "amplifier.log", "ver": "2.0.0" },
                "event": event,
                "session_id": "sess-1",
                "data": {}
            })
        )
    }
```

Test A — the core recovery loop (spec requirement: "a Degraded outcome must lead to re-attach"):

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn degraded_lane_reattaches_and_recovers() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        // Wait for the bind upsert: attach + initial drain are done.
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // Rotation: truncate below the tailer's offset -> FileReset degrade.
        std::fs::write(&events_path, "").unwrap();

        // Bounded backoff: first re-attach fires 250 ms after the degrade.
        // 1.2 s is comfortably past it while far below the 1 s second delay
        // plus margin.
        tokio::time::sleep(std::time::Duration::from_millis(1_200)).await;
        {
            let inner = hub.inner.lock().unwrap();
            assert!(
                inner.lanes.contains_key("t1"),
                "lane was not re-attached after FileReset degrade"
            );
        }

        // The recovered lane is LIVE with fresh tailer + reducer state:
        // a new record drives a confirmed busy.
        {
            let mut f = std::fs::OpenOptions::new()
                .append(true)
                .open(&events_path)
                .unwrap();
            f.write_all(amplifier_line("prompt:submit").as_bytes()).unwrap();
            f.flush().unwrap();
        }
        let busy = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["phase"] == "busy")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(busy.is_some(), "recovered lane did not drive busy");

        // An Ok read resets the bookkeeping — no timer leak.
        {
            let inner = hub.inner.lock().unwrap();
            assert!(
                inner.lane_retries.is_empty(),
                "retry state leaked after recovery"
            );
        }
    }
```

Test B — exhaustion surfaces loudly (spec requirement: "exhausted retries must surface, not vanish"):

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn exhausted_lane_retries_give_up_loudly() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // Make the path permanently unreadable: delete file AND parent dir so
        // every re-attach stat fails (ReadError on each of the 3 attempts).
        std::fs::remove_file(&events_path).unwrap();
        std::fs::remove_dir_all(dir.path()).unwrap();

        // After 250 + 1000 + 3000 ms of failed re-attaches the hub gives up
        // LOUDLY: the tracker record is removed so the client clears any
        // stale busy status instead of freezing it (see Design Decision 1:
        // the post-remove pane looks like ordinary idle, by design).
        let removed = next_frame_matching(&mut rx, "amplifier.activity.updated", 10_000, |v| {
            v["remove"]
                .as_array()
                .map(|r| r.iter().any(|id| id == "t1"))
                .unwrap_or(false)
        })
        .await;
        assert!(removed.is_some(), "no visible remove after retries exhausted");

        // NOTE: amplifier_list() returns a tuple — destructure it and assert
        // the records collection is empty (copy the exact call shape from an
        // existing test that uses amplifier_list()).
        let (records, _) = hub.amplifier_list();
        assert!(records.is_empty(), "tracker record survived give-up");
        let inner = hub.inner.lock().unwrap();
        assert!(inner.lanes.is_empty(), "a dead lane survived give-up");
        assert!(inner.lane_retries.is_empty(), "retry state leaked after give-up");
        assert_eq!(hub_next_deadline(&inner), None, "timer leaked after give-up");
    }
```

Test C — SchemaMismatch is permanent, no retries burned:

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn schema_mismatch_gives_up_immediately_without_retries() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, bad_schema_line("prompt:submit")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        // The Start-attach initial drain hits the schema gate immediately.
        hub.attach_amplifier_association("t1", "sess-1", &events_path);

        let removed = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["remove"]
                .as_array()
                .map(|r| r.iter().any(|id| id == "t1"))
                .unwrap_or(false)
        })
        .await;
        assert!(removed.is_some(), "no visible remove on schema mismatch");
        let inner = hub.inner.lock().unwrap();
        assert!(
            inner.lane_retries.is_empty(),
            "schema mismatch must not schedule retries — it is deterministic"
        );
    }
```

Test D — exit cleans up pending retries (no orphan timers for dead terminals):

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn exit_clears_pending_lane_retry() {
        let dir = tempfile::tempdir().unwrap();
        let events_path = dir.path().join("events.jsonl");
        std::fs::write(&events_path, amplifier_line("session:start")).unwrap();

        let (hub, mut rx) = hub();
        observer_send(
            &hub,
            ActivityEvent::Created {
                terminal_id: "t1".into(),
                mode: "amplifier".into(),
                resume_session_id: None,
                at: now_ms(),
            },
        );
        hub.attach_amplifier_association("t1", "sess-1", &events_path);
        let bound = next_frame_matching(&mut rx, "amplifier.activity.updated", 5_000, |v| {
            v["upsert"]
                .as_array()
                .map(|u| {
                    u.iter()
                        .any(|r| r["terminalId"] == "t1" && r["sessionId"] == "sess-1")
                })
                .unwrap_or(false)
        })
        .await;
        assert!(bound.is_some(), "lane never attached");

        // Persistent failure (file + dir gone) so the retry entry stays
        // pending long enough to observe (first delays: 250 ms, 1000 ms).
        std::fs::remove_file(&events_path).unwrap();
        std::fs::remove_dir_all(dir.path()).unwrap();

        // Wait until the degrade lands and a retry entry exists.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            {
                let inner = hub.inner.lock().unwrap();
                if inner.lane_retries.contains_key("t1") {
                    break;
                }
            }
            assert!(
                std::time::Instant::now() < deadline,
                "degrade never scheduled a retry"
            );
            tokio::time::sleep(std::time::Duration::from_millis(25)).await;
        }

        // Terminal exits while the retry is pending.
        observer_send(
            &hub,
            ActivityEvent::Exit {
                terminal_id: "t1".into(),
                at: now_ms(),
            },
        );
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let inner = hub.inner.lock().unwrap();
        assert!(inner.lanes.is_empty());
        assert!(
            inner.lane_retries.is_empty(),
            "exit must clear pending lane retries"
        );
        assert_eq!(hub_next_deadline(&inner), None, "timer leaked after exit");
    }
```

(If `ActivityEvent::Exit`'s field set differs, copy the construction used by the existing test `exit_broadcasts_remove_and_clears_state` at :933-975 verbatim.)

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-ws activity::tests
```
Expected: all four new tests FAIL —
- `degraded_lane_reattaches_and_recovers`: panics at `lane was not re-attached after FileReset degrade` (today the Degraded arm drops the lane permanently).
- `exhausted_lane_retries_give_up_loudly`: times out at `no visible remove after retries exhausted` (today the terminal record survives, silently stale).
- `schema_mismatch_gives_up_immediately_without_retries`: times out at `no visible remove on schema mismatch`.
- `exit_clears_pending_lane_retry`: panics at `degrade never scheduled a retry`.
All pre-existing tests still PASS.

- [ ] **Step 3: Write the implementation**

(a) **Import** — extend the tailer import (currently :37):

```rust
use freshell_activity::amplifier::tailer::{AttachAt, TailerDegradeReason, TailerReadOutcome};
```

(b) **`AmplifierLane` carries its identity** (replace :85-90):

```rust
struct AmplifierLane {
    tailer: AmplifierEventsTailer,
    reducer_state: ReducerState,
    /// Retained so a degrade can schedule a bounded re-attach (G4).
    session_id: String,
    events_path: PathBuf,
    /// Keeps the inotify watcher alive for the lane's lifetime.
    _watcher: notify::RecommendedWatcher,
}
```

And the insert site inside `attach_lane` (currently :469-477) gains the two fields:

```rust
            inner.lanes.insert(
                terminal_id.to_string(),
                AmplifierLane {
                    tailer,
                    reducer_state: create_reducer_state(),
                    session_id: session_id.to_string(),
                    events_path: events_path.to_path_buf(),
                    _watcher: watcher,
                },
            );
```

(c) **The failure bookkeeper** — add as a method on `impl ActivityHub`, next to `drain_lane`:

```rust
    /// Record a lane failure (degrade or failed [re-]attach) and either
    /// schedule the next bounded re-attach or give up LOUDLY. Caller holds
    /// the `HubInner` lock; client-visible frames are pushed onto `frames`
    /// and must be emitted by the caller AFTER releasing the lock.
    fn note_lane_failure(
        &self,
        inner: &mut HubInner,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
        permanent: bool,
        frames: &mut Vec<ServerMessage>,
    ) {
        let failures = inner
            .lane_retries
            .get(terminal_id)
            .map(|retry| retry.failures)
            .unwrap_or(0)
            + 1;
        let delay = if permanent {
            None
        } else {
            lane_retry_delay_ms(failures)
        };
        match delay {
            Some(delay_ms) => {
                tracing::warn!(
                    terminal_id = %terminal_id,
                    failures,
                    delay_ms,
                    "amplifier_events_lane_retry_scheduled"
                );
                inner.lane_retries.insert(
                    terminal_id.to_string(),
                    LaneRetry {
                        session_id: session_id.to_string(),
                        events_path: events_path.to_path_buf(),
                        failures,
                        next_attempt_at: Some(now_ms() + delay_ms),
                    },
                );
            }
            None => {
                inner.lane_retries.remove(terminal_id);
                tracing::error!(
                    terminal_id = %terminal_id,
                    failures,
                    permanent,
                    "amplifier_events_lane_dead: events lane gave up after bounded re-attach; amplifier status for this terminal is no longer tracked"
                );
                // LOUD give-up: clear the tracker record so the client
                // clears any stale busy status (an existing frame shape the
                // frozen client already renders) instead of freezing it.
                // Also keeps amplifier_list() consistent. Post-remove the
                // pane renders as ordinary idle, and the tracker no-ops all
                // further signals for this terminal — both intended (DD1).
                let effects = inner.amplifier.note_exit(terminal_id);
                let (mut f, _) = amplifier_frames(&mut inner.idle, effects);
                frames.append(&mut f);
            }
        }
    }

    /// Attach failed before a lane existed — route into the same bounded
    /// retry machinery (lock is NOT held by the caller).
    fn handle_attach_failure(
        &self,
        terminal_id: &str,
        session_id: &str,
        events_path: &Path,
        permanent: bool,
    ) {
        let frames = {
            let mut inner = self.inner.lock().expect("activity hub lock");
            let mut frames = Vec::new();
            self.note_lane_failure(
                &mut inner,
                terminal_id,
                session_id,
                events_path,
                permanent,
                &mut frames,
            );
            frames
        };
        self.emit(frames);
    }
```

(d) **`attach_lane` failure paths** — replace each of the three silent `warn + return` paths:

The tailer-attach failure (currently :401-410) becomes:

```rust
        if let Err((reason, message)) = tailer.attach(attach_at) {
            tracing::warn!(
                terminal_id = %terminal_id,
                reason = ?reason,
                message = %message,
                "amplifier_events_lane_degraded: attach failed"
            );
            self.handle_attach_failure(
                terminal_id,
                session_id,
                events_path,
                matches!(reason, TailerDegradeReason::SchemaMismatch),
            );
            return;
        }
```

The watcher-create failure (currently :437-447) keeps its `tracing::warn!` and adds, before `return;`:

```rust
                self.handle_attach_failure(terminal_id, session_id, events_path, false);
```

The `watcher.watch()` failure (currently :448-455) likewise keeps its warn and adds, before `return;`:

```rust
            self.handle_attach_failure(terminal_id, session_id, events_path, false);
```

(e) **`drain_lane`** — two changes:

In the `Ok` arm, immediately before the re-insert (`inner.lanes.insert(terminal_id.to_string(), lane);` at :524):

```rust
                    // A successful read is the recovery signal: reset the
                    // bounded-retry bookkeeping (and its timer).
                    inner.lane_retries.remove(terminal_id);
```

The `Degraded` arm (currently :526-540) becomes:

```rust
                TailerReadOutcome::Degraded { reason, message } => {
                    tracing::warn!(
                        terminal_id = %terminal_id,
                        reason = ?reason,
                        message = %message,
                        "amplifier_events_lane_degraded"
                    );
                    // Signal loss: busy reverts honestly right now; the lane
                    // (and its watcher) is dropped, and a bounded re-attach
                    // is scheduled (G4) unless the failure is deterministic.
                    let effects = inner
                        .amplifier
                        .note_events_signal_lost(terminal_id, now_ms());
                    let (mut f, _) = amplifier_frames(&mut inner.idle, effects);
                    frames.append(&mut f);
                    self.note_lane_failure(
                        &mut inner,
                        terminal_id,
                        &lane.session_id,
                        &lane.events_path,
                        matches!(reason, TailerDegradeReason::SchemaMismatch),
                        &mut frames,
                    );
                }
```

(f) **`expire_due`** (currently :549-574) — collect due retries under the lock, fire re-attaches after releasing it. Inside the existing locked block (where `frames` and `force_reads` are computed), add:

```rust
            let now = now_ms();
            let mut reattaches: Vec<(String, String, PathBuf)> = Vec::new();
            for (terminal_id, retry) in inner.lane_retries.iter_mut() {
                if matches!(retry.next_attempt_at, Some(at) if at <= now) {
                    // Mark in flight: arms no timer until the attempt resolves.
                    retry.next_attempt_at = None;
                    reattaches.push((
                        terminal_id.clone(),
                        retry.session_id.clone(),
                        retry.events_path.clone(),
                    ));
                }
            }
```

Extend the tuple returned from the locked block to `(frames, force_reads, reattaches)`, and after the existing `for terminal_id in force_reads { self.drain_lane(&terminal_id); }` loop add:

```rust
        for (terminal_id, session_id, stored_path) in reattaches {
            // Port of the legacy resolveEventsPath semantics: the path is
            // keyed by session id — re-resolve at every attempt, falling
            // back to the path captured at degrade time (unit tests run
            // with resolver = None). Covers same-sid path moves only; an
            // in-terminal amplifier restart mints a NEW sid, which nothing
            // re-attaches — an inherited legacy gap, out of scope (DD6).
            let events_path = self
                .resolver
                .as_ref()
                .and_then(|resolve| resolve(&session_id))
                .unwrap_or(stored_path);
            tracing::info!(
                terminal_id = %terminal_id,
                "amplifier_events_lane_reattach_attempt"
            );
            // Always Eof: a rotated/reset file's history is not ours to
            // replay. attach_lane builds a FRESH tailer + reducer state
            // (both degrade latches are sticky), and its failure paths feed
            // back into note_lane_failure, escalating `failures`.
            self.attach_lane(&terminal_id, &session_id, &events_path, AttachAt::Eof);
        }
```

(g) **Exit teardown** — next to the existing `inner.lanes.remove(&terminal_id);` (currently :369):

```rust
                inner.lane_retries.remove(&terminal_id);
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-ws activity::
```
Expected: PASS — all four new tests, plus every pre-existing test (notably `amplifier_events_lane_drives_busy_complete_and_idle_via_inotify` and `idle_terminals_arm_no_timers_and_read_no_files`). Then run the whole crate + neighbors:

```bash
cargo test -p freshell-ws
cargo test -p freshell-activity
```
Expected: PASS (freshell-activity is untouched; this confirms no accidental drift).

- [ ] **Step 5: Refactor check + commit**

Run formatting/lints; fix anything they flag in the touched code:

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets 2>&1 | tail -20
git add crates/freshell-ws/src/activity.rs
git commit -m "feat(activity): bounded re-attach with backoff for degraded amplifier events lanes (G4)

A Degraded tailer outcome now schedules re-attach at Eof via the hub's
single one-shot deadline (250/1000/3000 ms, fresh tailer + reducer state,
per-attempt path re-resolution). Exhausted or deterministic (SchemaMismatch)
failures give up LOUDLY: error log + tracker-record removal so the client
clears any stale busy status instead of freezing it. Initial-attach
failures feed the same machinery; exit clears pending retries.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: E2E spec — events.jsonl truncation mid-session recovers status

**Files:**
- Create: `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (two one-line appends; siblings append too — trivial conflicts are fine)

**Interfaces:**
- Consumes: `RustServer` (direct import — `restartAbrupt()` is needed by Task 6), `TestHarness`, `openPanePicker`, fixture `test/e2e-browser/fixtures/fake-amplifier-activity-cli.mjs` (emits one `prompt:submit` → `prompt:complete` turn per stdin data event, writes to `AMPLIFIER_HOME || $HOME/.amplifier`).
- Produces: spec file with local helpers `record()`, `seedAmplifierProvider()`, `findEventsFile()` (Tasks 6-7 add tests to this same file and reuse these helpers).

- [ ] **Step 1: Write the spec file**

Create `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts`. First, copy these helpers **verbatim** from `test/e2e-browser/specs/terminal-activity-rust.spec.ts` (per the suite's per-spec-ownership convention — helpers are copied, not imported): `installFakeCli` (:48), `class WsCapture` (:61-111), `selectShellIfPickerShowing` (:113), `bootAndConnect` (:129), `openCliPane` (:142), `collectLeaves` (:148), `openCliPaneAndGetTerminalId` (:155), `typePromptIntoLastPane` (:189). Then the file's own scaffolding and first test:

```ts
/**
 * AMPLIFIER EVENTS-LANE RESILIENCE (Lane B, gaps G4 + G8).
 *
 * The amplifier status pipeline tails the session's events.jsonl via an
 * inotify lane. These tests prove the lane survives real-world failure
 * modes end-to-end in a browser, against servers this spec owns:
 *  1. events.jsonl truncation/rotation mid-session -> bounded re-attach,
 *     status flows again (busy + turn-complete + chime edge).
 *  2. abrupt server death (SIGKILL) with a busy amplifier pane -> after
 *     restore the lane re-attaches at Eof and status flows again.
 *  3. two concurrent servers run fully independent amplifier lanes.
 *
 * Rust-only: imports RustServer directly (restartAbrupt) and drives the
 * Rust activity hub. Servers bind ephemeral ports via findFreePort() --
 * never the user's live 3001/3002.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FAKE_AMPLIFIER_CLI = path.resolve(__dirname, '../fixtures/fake-amplifier-activity-cli.mjs')

// [PASTE the copied helpers here: installFakeCli, WsCapture,
//  selectShellIfPickerShowing, bootAndConnect, openCliPane, collectLeaves,
//  openCliPaneAndGetTerminalId, typePromptIntoLastPane]

/** One amplifier.log record, mirroring the fake CLI's writer (live ts —
 *  a stale ts looks like deadman silence to the tracker). */
function record(event: string, extra: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    ts: new Date().toISOString(),
    lvl: 'INFO',
    schema: { name: 'amplifier.log', ver: '1.0.0' },
    event,
    ...extra,
  })}\n`
}

async function seedAmplifierProvider(homeDir: string): Promise<void> {
  const freshellDir = path.join(homeDir, '.freshell')
  await fs.mkdir(freshellDir, { recursive: true })
  await fs.writeFile(
    path.join(freshellDir, 'config.json'),
    JSON.stringify(
      { version: 1, settings: { codingCli: { enabledProviders: ['amplifier'] } } },
      null,
      2,
    ),
  )
}

/** Locate the single fake session's events.jsonl under a pinned AMPLIFIER_HOME. */
async function findEventsFile(amplifierHome: string): Promise<string> {
  const projectsRoot = path.join(amplifierHome, 'projects')
  for (const project of await fs.readdir(projectsRoot)) {
    const sessionsDir = path.join(projectsRoot, project, 'sessions')
    const sessions = await fs.readdir(sessionsDir).catch(() => [] as string[])
    for (const session of sessions) {
      const candidate = path.join(sessionsDir, session, 'events.jsonl')
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        /* keep looking */
      }
    }
  }
  throw new Error(`no events.jsonl found under ${projectsRoot}`)
}

/** Poll the server debug log until `pattern` appears — the deterministic
 *  "re-attach fired" observable. A blind fixed wait would race CI: a record
 *  appended BEFORE the Eof re-attach lands sits behind the attach point and
 *  is permanently invisible, failing the test with no retry recourse. */
async function waitForServerLog(
  debugLogPath: string,
  pattern: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const contents = await fs.readFile(debugLogPath, 'utf8').catch(() => '')
    if (contents.includes(pattern)) return
    if (Date.now() > deadline) throw new Error(`server log never matched: ${pattern}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

test.describe('Amplifier events-lane resilience (Rust only)', () => {
  test.setTimeout(240_000)

  test('events.jsonl truncation mid-session degrades then recovers: status flows again', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-lane-'))
    // Pinned AMPLIFIER_HOME so this spec can find and mutate events.jsonl;
    // both the server and the fake CLI resolve the same root.
    const amplifierHome = path.join(sharedRoot, 'amplifier-home')
    let capture: WsCapture | null = null
    let server: RustServer | null = null
    try {
      const fakeAmplifier = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      server = new RustServer({
        env: {
          AMPLIFIER_CMD: fakeAmplifier,
          AMPLIFIER_HOME: amplifierHome,
          FAKE_AMPLIFIER_TURN_MS: '3000',
        },
        setupHome: seedAmplifierProvider,
      })
      const info = await server.start()
      capture = new WsCapture(info.baseUrl, info.token)
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Amplifier/i, 'amplifier')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('amplifier>')
        }, { timeout: 15_000 })
        .toBe(true)

      // Turn 1 via the fake CLI: proves the lane attached and is healthy.
      await typePromptIntoLastPane(page, 'hello amplifier')
      const complete1 = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId,
        45_000,
        'turn 1 complete (lane healthy)',
      )
      expect(complete1.provider).toBe('amplifier')
      expect(complete1.completionSeq).toBe(1)

      const eventsPath = await findEventsFile(amplifierHome)

      // ROTATION: truncate the live file below the tailer offset (FileReset
      // degrade). Without the fix the lane dies here, permanently.
      await fs.truncate(eventsPath, 0)
      // Deterministic recovery gate (validated hardening): wait for the hub
      // to log the re-attach attempt (Task 4 emits
      // amplifier_events_lane_reattach_attempt at info level), then a short
      // settle for the attach + initial drain that follow it synchronously.
      await waitForServerLog(info.debugLogPath, 'amplifier_events_lane_reattach_attempt')
      await page.waitForTimeout(250)

      // Turn 2 by appending records DIRECTLY (no PTY input): busy and
      // turn-complete can then ONLY come from the recovered events lane --
      // there is no provisional-busy path to mask a dead lane.
      await fs.appendFile(eventsPath, record('prompt:submit'))
      await capture.waitFor(
        (f) =>
          f.type === 'amplifier.activity.updated' &&
          f.upsert?.some((r: any) => r.terminalId === terminalId && r.phase === 'busy'),
        15_000,
        'post-truncation busy from recovered lane',
      )
      await fs.appendFile(eventsPath, record('prompt:complete'))
      const complete2 = await capture.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === terminalId && f.completionSeq === 2,
        15_000,
        'post-truncation turn complete from recovered lane',
      )
      expect(complete2.provider).toBe('amplifier')
    } finally {
      capture?.close()
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
```

- [ ] **Step 2: Register the spec in playwright.config.ts (two one-line appends)**

In `test/e2e-browser/playwright.config.ts`, append to `RUST_ONLY_SPECS` before its closing `]` (currently :92):

```ts
  // AMPLIFIER EVENTS-LANE RESILIENCE (Lane B): imports RustServer directly
  // for restartAbrupt(); drives the Rust activity hub's events lane.
  /amplifier-lane-resilience-rust\.spec\.ts$/,
```

And append the same regex to the `rust-chromium` project's `testMatch` array before its closing `],` (currently :213):

```ts
        // AMPLIFIER EVENTS-LANE RESILIENCE (Lane B): rust-only, owns its
        // servers, exercises events.jsonl rotation + abrupt restart.
        /amplifier-lane-resilience-rust\.spec\.ts$/,
```

- [ ] **Step 3: Typecheck and run the spec**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-events-lane-resilience
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20   # or the repo's typecheck script if one covers e2e specs
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/amplifier-lane-resilience-rust.spec.ts
```
Expected: `1 passed`. (First run pays the `cargo build --release -p freshell-server` cost.)
Failure-mode note (this is the e2e's red-equivalent evidence): without Tasks 3-4, this test fails at `waitForServerLog(... amplifier_events_lane_reattach_attempt)` — the truncation kills the lane permanently, no re-attach is ever attempted, and no further frames arrive.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): amplifier events.jsonl truncation recovery spec (G4)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: E2E — abrupt server death with a busy amplifier pane; lane re-attaches after restore

**Files:**
- Modify: `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts` (append a second test inside the same `describe`)

**Interfaces:**
- Consumes: helpers from Task 5 (`record`, `seedAmplifierProvider`, `findEventsFile`, `installFakeCli`, `WsCapture`, `bootAndConnect`, `openCliPaneAndGetTerminalId`, `typePromptIntoLastPane`, `collectLeaves`); `RustServer.restartAbrupt()`.
- Produces: nothing consumed later.

- [ ] **Step 1: Write the test**

Append inside the `describe` block:

```ts
  test('abrupt server death mid-turn: lane re-attaches after restore and status flows again', async ({
    page,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-restart-'))
    const amplifierHome = path.join(sharedRoot, 'amplifier-home')
    let capture: WsCapture | null = null
    let capture2: WsCapture | null = null
    let server: RustServer | null = null
    try {
      const fakeAmplifier = await installFakeCli(path.join(sharedRoot, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      server = new RustServer({
        env: {
          AMPLIFIER_CMD: fakeAmplifier,
          AMPLIFIER_HOME: amplifierHome,
          // Turn far outlives the restart: the pane is provably BUSY at death.
          FAKE_AMPLIFIER_TURN_MS: '120000',
        },
        setupHome: seedAmplifierProvider,
      })
      const info = await server.start()
      capture = new WsCapture(info.baseUrl, info.token)
      await capture.ready()
      const harness = await bootAndConnect(page, info)
      const tabId = await harness.getActiveTabId()
      const terminalId = await openCliPaneAndGetTerminalId(page, harness, tabId!, /Amplifier/i, 'amplifier')
      await expect
        .poll(async () => {
          const buffer = await harness.getTerminalBuffer(terminalId)
          return typeof buffer === 'string' && buffer.includes('amplifier>')
        }, { timeout: 15_000 })
        .toBe(true)

      await typePromptIntoLastPane(page, 'long running turn')
      // Wait for the LOCATOR ASSOCIATION to land (bind upsert carrying the
      // fake session id), not just provisional busy: the association is what
      // persists the sessionRef that restore resumes from.
      await capture.waitFor(
        (f) =>
          f.type === 'amplifier.activity.updated' &&
          f.upsert?.some(
            (r: any) =>
              r.terminalId === terminalId &&
              typeof r.sessionId === 'string' &&
              r.sessionId.startsWith('fake-amp-'),
          ),
        30_000,
        'association bound before death',
      )
      // Durable-persistence gate (validated in Stage 2): the durable copy of
      // the association is CLIENT-side — the page's store flushes the layout
      // synchronously when it applies the association (persistMiddleware.ts
      // :686-687 bypasses the debounce). WsCapture above is a SEPARATE ws
      // connection, so also wait until the page itself shows the bound
      // session before killing the server. (Field name: copy the pane
      // content shape the client binds at App.tsx:968-981 if it differs.)
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout(tabId!)
          const leaves = collectLeaves(layout?.root ?? layout)
          const amp = leaves.find((l: any) => l?.content?.terminalId === terminalId)
          const ref =
            amp?.content?.sessionRef?.sessionId ?? amp?.content?.resumeSessionId ?? ''
          return typeof ref === 'string' && ref.startsWith('fake-amp-')
        }, { timeout: 15_000 })
        .toBe(true)
      capture.close()
      capture = null

      // ABRUPT DEATH: SIGKILL the server process group, then reboot on the
      // same home/port/token. The page recovers via WS auto-reconnect.
      await server.restartAbrupt()

      const harness2 = new TestHarness(page)
      await harness2.waitForConnection(30_000)

      // The restored amplifier pane gets a NEW terminal id (resume respawn).
      let restoredId = ''
      await expect
        .poll(async () => {
          const layout = await harness2.getPaneLayout(tabId!)
          const leaves = collectLeaves(layout?.root ?? layout)
          const amp = leaves.find(
            (l: any) =>
              l?.content?.mode === 'amplifier' &&
              typeof l?.content?.terminalId === 'string' &&
              l.content.terminalId.length > 0 &&
              l.content.terminalId !== terminalId,
          )
          restoredId = amp?.content?.terminalId ?? ''
          return restoredId.length > 0
        }, { timeout: 30_000 })
        .toBe(true)

      capture2 = new WsCapture(info.baseUrl, info.token)
      await capture2.ready()

      // The resume path attaches the events lane at Eof. Prove it is LIVE by
      // appending records directly -- status can only flow through the lane.
      const eventsPath = await findEventsFile(amplifierHome)
      await fs.appendFile(eventsPath, record('prompt:submit'))
      await capture2.waitFor(
        (f) =>
          f.type === 'amplifier.activity.updated' &&
          f.upsert?.some((r: any) => r.terminalId === restoredId && r.phase === 'busy'),
        30_000,
        'post-restart busy via re-attached lane',
      )
      await fs.appendFile(eventsPath, record('prompt:complete'))
      const complete = await capture2.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === restoredId,
        30_000,
        'post-restart turn complete via re-attached lane',
      )
      expect(complete.provider).toBe('amplifier')
    } finally {
      capture?.close()
      capture2?.close()
      await server?.stop().catch(() => {})
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

- [ ] **Step 2: Run the spec file**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/amplifier-lane-resilience-rust.spec.ts
```
Expected: `2 passed`.
Debugging note if the restored pane never appears: `compound-restart-rust.spec.ts` MODE A proves no-reload recovery for codex; if the amplifier pane's restore requires a reload in practice, add `await page.reload()` + `bootAndConnect`-style re-init immediately after `restartAbrupt()` (MODE B, `compound-restart-rust.spec.ts:377`) rather than weakening the assertions. Server logs are at `info.debugLogPath`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts
git commit -m "test(e2e): amplifier lane re-attach after abrupt server death

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: E2E — two concurrent servers, independent amplifier lanes

**Files:**
- Modify: `test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts` (append a third test inside the same `describe`)

**Interfaces:**
- Consumes: Task 5 helpers; Playwright `browser` fixture (second isolated context for server B).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the test**

Append inside the `describe` block:

```ts
  test('two concurrent servers run independent amplifier lanes', async ({
    page,
    browser,
    e2eServerKind,
  }) => {
    expect(e2eServerKind).toBe('rust')
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-dual-a-'))
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'freshell-amp-dual-b-'))
    const homeA = path.join(rootA, 'amplifier-home')
    const homeB = path.join(rootB, 'amplifier-home')
    let captureA: WsCapture | null = null
    let captureB: WsCapture | null = null
    let serverA: RustServer | null = null
    let serverB: RustServer | null = null
    let contextB: import('@playwright/test').BrowserContext | null = null
    try {
      const fakeA = await installFakeCli(path.join(rootA, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      const fakeB = await installFakeCli(path.join(rootB, 'bin'), 'amplifier', FAKE_AMPLIFIER_CLI)
      serverA = new RustServer({
        env: { AMPLIFIER_CMD: fakeA, AMPLIFIER_HOME: homeA, FAKE_AMPLIFIER_TURN_MS: '3000' },
        setupHome: seedAmplifierProvider,
      })
      serverB = new RustServer({
        env: { AMPLIFIER_CMD: fakeB, AMPLIFIER_HOME: homeB, FAKE_AMPLIFIER_TURN_MS: '3000' },
        setupHome: seedAmplifierProvider,
      })
      const [infoA, infoB] = await Promise.all([serverA.start(), serverB.start()])
      expect(infoA.port).not.toBe(infoB.port)

      contextB = await browser.newContext()
      const pageB = await contextB.newPage()

      captureA = new WsCapture(infoA.baseUrl, infoA.token)
      captureB = new WsCapture(infoB.baseUrl, infoB.token)
      await Promise.all([captureA.ready(), captureB.ready()])

      const harnessA = await bootAndConnect(page, infoA)
      const harnessB = await bootAndConnect(pageB, infoB)
      const tabA = await harnessA.getActiveTabId()
      const tabB = await harnessB.getActiveTabId()
      const tA = await openCliPaneAndGetTerminalId(page, harnessA, tabA!, /Amplifier/i, 'amplifier')
      const tB = await openCliPaneAndGetTerminalId(pageB, harnessB, tabB!, /Amplifier/i, 'amplifier')
      for (const [harness, tid] of [
        [harnessA, tA],
        [harnessB, tB],
      ] as const) {
        await expect
          .poll(async () => {
            const buffer = await harness.getTerminalBuffer(tid)
            return typeof buffer === 'string' && buffer.includes('amplifier>')
          }, { timeout: 15_000 })
          .toBe(true)
      }

      // Drive one full turn on EACH server; both complete independently.
      await typePromptIntoLastPane(page, 'turn on A')
      await typePromptIntoLastPane(pageB, 'turn on B')
      const cA = await captureA.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === tA,
        45_000,
        'server A turn complete',
      )
      const cB = await captureB.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === tB,
        45_000,
        'server B turn complete',
      )
      expect(cA.provider).toBe('amplifier')
      expect(cB.provider).toBe('amplifier')

      // Degrade + recover A's lane; B must be completely unaffected.
      const eventsA = await findEventsFile(homeA)
      await fs.truncate(eventsA, 0)
      // Deterministic recovery gate (see Task 5): poll A's debug log for the
      // re-attach attempt instead of a blind fixed wait.
      await waitForServerLog(infoA.debugLogPath, 'amplifier_events_lane_reattach_attempt')
      await page.waitForTimeout(250)
      await fs.appendFile(eventsA, record('prompt:submit'))
      await captureA.waitFor(
        (f) =>
          f.type === 'amplifier.activity.updated' &&
          f.upsert?.some((r: any) => r.terminalId === tA && r.phase === 'busy'),
        15_000,
        'A recovered busy after truncation',
      )
      await fs.appendFile(eventsA, record('prompt:complete'))
      await captureA.waitFor(
        (f) => f.type === 'terminal.turn.complete' && f.terminalId === tA && f.completionSeq === 2,
        15_000,
        'A recovered turn complete after truncation',
      )
      // Independence: B saw exactly its one completion, and A's degrade
      // produced no frames for B's terminal on B's bus.
      expect(captureB.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === tB)).toBe(1)
      expect(captureB.count((f) => f.type === 'terminal.turn.complete' && f.terminalId === tA)).toBe(0)
    } finally {
      captureA?.close()
      captureB?.close()
      await serverA?.stop().catch(() => {})
      await serverB?.stop().catch(() => {})
      await contextB?.close().catch(() => {})
      await fs.rm(rootA, { recursive: true, force: true }).catch(() => {})
      await fs.rm(rootB, { recursive: true, force: true }).catch(() => {})
    }
  })
```

- [ ] **Step 2: Run the full spec file**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/amplifier-lane-resilience-rust.spec.ts
```
Expected: `3 passed`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/amplifier-lane-resilience-rust.spec.ts
git commit -m "test(e2e): dual-server amplifier lane independence with mid-run degrade/recover

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 8: Full verification, push branch, STOP before PR

**Files:** none created/modified (verification + push only).

- [ ] **Step 1: Full Rust suite**

```bash
cd /home/dan/code/freshell/.worktrees/amplifier-events-lane-resilience
cargo fmt --all -- --check
cargo test --workspace
```
Expected: fmt clean; all tests pass.

- [ ] **Step 2: Coordinated Node suite (respect the shared gate — siblings run concurrently)**

```bash
npm run test:status          # inspect the current holder first
FRESHELL_TEST_SUMMARY="lane-b amplifier events-lane resilience" npm run check
```
Expected: typecheck + full coordinated suite green. If another agent holds the gate, WAIT — do not kill a foreign holder.

- [ ] **Step 3: E2E rerun (final proof)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/amplifier-lane-resilience-rust.spec.ts
```
Expected: `3 passed`.

- [ ] **Step 4: Push the branch — DO NOT create a PR**

```bash
git log --oneline origin/main..HEAD    # sanity: only this lane's commits
git push -u origin HEAD
```
Expected: branch pushed. **STOP HERE — PR creation is NOT approved.** Report: branch name, the red→green evidence per task (each Task's Step-2 failing output vs Step-4 passing output; e2e 3/3), and the note that the give-up signal uses the existing `amplifier.activity.updated` `remove` shape (Design Decision 1).

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- G4 bounded re-attach with backoff at Eof, N attempts, loud give-up → Tasks 3-4 (schedule `[250,1000,3000]`, fresh tailer+reducer, Eof-only, error log + record removal).
- Degraded-status signal the frozen client already renders → Design Decision 1 (record removal via `note_exit` effects; no new client feature; `shared/ws-protocol.ts` untouched). Stage-2 validation corrected the claim's scope: removal clears stale busy (the actual G4 harm) but the post-remove pane renders as ordinary idle — documented in DD1 as the best effect available inside the pinned contract, with the alternatives that were evaluated and rejected.
- Legacy `resolveEventsPath` re-resolution port → Design Decision 6 + Task 4 step 3(f) (per-attempt `self.resolver(session_id)` with stored-path fallback). Stage-2 validation corrected the rationale: this covers same-sid path moves only; new-sid in-terminal restarts are an inherited legacy gap, out of scope (documented in DD6).
- G8 4 MiB cap, stat at attach, Eof fallback, log, missing-file-not-over-cap, implemented in `attach_lane` keeping the tailer pure, matching legacy (no divergence) → Tasks 1-2.
- TDD red-first at unit level (Degraded→re-attach, exhausted→surface, oversized→Eof) and hub level following activity.rs test patterns → Tasks 1-4 Step 1/2 of each.
- E2E: own RustServers via findFreePort (never 3001/3002), extends the amplifier-leg patterns, rotation/truncation recovery (Task 5), restartAbrupt with busy pane + lane re-attach (Task 6), two concurrent servers with independent lanes (Task 7), new spec = new file, minimal config appends (Task 5 Step 2).
- Repo rules: worktree from origin/main@2bf579e6 (pre-created by workspace stage), coordinated-suite gating with FRESHELL_TEST_SUMMARY (Task 8), TDD, no self-hosted-server restarts, no broad kills, push-then-stop PR policy (Task 8) — Global Constraints.
- Scope fence: only activity.rs hub plumbing + tests + new e2e spec + config appends; idle.rs, frames/arming block, codex tracker, terminal/registry, client src/ untouched — Global Constraints + Design Decision 1.

**1b. No silent deferrals:** the fake amplifier CLI and direct events.jsonl appends in e2e are test *fixtures* driving the real production pipeline (real server, real inotify lane, real reducer/tracker, real WS frames to a real browser) — the observable production outcomes (busy upsert, `terminal.turn.complete`, record removal) are asserted end-to-end. No stub stands in for the shipped behavior. No requirement was moved to "known limitations". No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan:** no TBD/TODO/"handle edge cases" steps. The two "copy verbatim from file:line" instructions (test helpers in Task 5; `ActivityEvent` variant shapes in Tasks 2/4) point at exact existing repo locations with line numbers — mechanical, not deferred design. All new code is shown in full.

**3. Type consistency check:** `effective_attach_at(AttachAt, Option<u64>) -> AttachAt` (Task 1) matches its Task 2 call. `lane_retry_delay_ms(u32) -> Option<i64>` (Task 3) matches Task 4's `note_lane_failure`. `LaneRetry { session_id: String, events_path: PathBuf, failures: u32, next_attempt_at: Option<i64> }` is constructed identically in Task 3 tests and Task 4 code. `note_lane_failure(&self, &mut HubInner, &str, &str, &Path, bool, &mut Vec<ServerMessage>)` matches all three call sites (drain Degraded arm, `handle_attach_failure`, and via it the three attach failure paths). E2E helpers `record`/`seedAmplifierProvider`/`findEventsFile` defined in Task 5 and reused unchanged in Tasks 6-7.

**Known execution-time flex points (documented, not gaps):** exact current line numbers in activity.rs shift as edits land — anchors are given as function names + "currently :NNN"; `ActivityEvent::{Created,Exit}` field sets must be copied from the existing tests at :1022/:933 if they differ from the code shown; `amplifier_list()`'s tuple shape (Test B) and the pane-content sessionRef field name (Task 6 client gate) must be copied from existing usage; Task 6 documents the MODE-B reload fallback if amplifier restore requires it.

## Load-Bearing Validation (Stage 2, performed after plan-writing)

Ten load-bearing assumptions were surfaced and validated (ledger with full evidence: `.worktrees/.the-usual-logs/amplifier-events-lane-resilience/load-bearing-ledger.md`). Eight verified — notably: truncation/deletion of a watched file DO deliver filter-passing notify events with ~0.1 ms latency (empirical, notify =6.1.1 scratch probe + backend source); `remove` for a still-running terminal is benign to sessionRef/resume/dedupe; initial-attach failure can never be a healthy lazy-creation path (both events_path producers guarantee an existing file); the association's durable copy is flushed synchronously client-side, so Task 6's SIGKILL premise holds; legacy never retried ANY degrade, so the bounded-retry design is strictly more resilient than parity. Two falsified and fixed in this plan: (1) DD1's "visibly distinct from idle" claim — removal clears stale busy but post-remove renders as ordinary idle (DD1 reworded, test/commit comments aligned); (2) DD6's "handles path changes across amplifier restarts" rationale — re-resolution covers same-sid moves only (DD6 reworded). Hardening applied from validation findings: Tasks 5/7 now gate recovery on the `amplifier_events_lane_reattach_attempt` debug-log observable instead of a blind 2 s wait (a too-early append is lost forever); Task 6 gains a client-observed sessionRef gate before SIGKILL. Accepted residuals (recorded in the ledger): amplifier no-reload recovery is deferred to Task 6's documented MODE-B fallback; "real amplifier CLI writes events.jsonl append-only" rests on three frozen-reference comments (worst case if wrong: warn-logged successful re-attach per rotation — still resilient).
