# OpenCode Daemon Death Recovery Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix the freshopencode shared-daemon death incident class in the Freshell repo (Rust server + React client): (1) an opencode compact request timeout must no longer kill the shared `opencode serve` sidecar; (2) a daemon discard must emit a structured log; (3) daemon loss must self-heal at the freshopencode runtime level with a client-visible status edge and a backoff-guarded respawn, mirroring the freshcodex onExit self-heal; (4) the client must not dead-end on the fresh-agent snapshot 409 RESTORE_UNAVAILABLE — it must drive the documented generation-fenced attach recovery and refetch.

### Explicit constraints
- The user explicitly requested the-usual workflow (plan, load-bearing validation, independent fresh-eyes reviews, TDD execution, recap).
- Work in a dedicated worktree under `.worktrees/`; branch from `origin/main`; PR only after explicit user approval; never push behavior changes to `main` directly.
- Red/Green/Refactor TDD; ensure unit and e2e coverage; never reduce test coverage to get tests passing.
- Never restart the self-hosted production Freshell server on port 3001 without the user's explicit "APPROVED".
- TypeScript NodeNext relative imports require `.js` extensions.
- Follow repo test-coordination rules (coordinated broad runs, base-gate for green-base checks).

### Accepted tradeoffs and residuals
- The user approved the proposed fix set "presumably step 1-4, unless analysis reveals otherwise": planning analysis may adjust the exact fix set if evidence shows a different cut is more idiomatic, but the four identified defects are the baseline scope.

**Goal:** A freshopencode pane survives — and automatically recovers from — the loss of the shared `opencode serve` daemon, and no single slow request can kill that daemon for every session again.

**Architecture:** Four layers, each mirroring an established in-repo precedent. (1) The compact request lane adopts the b8ke FR2 captured-base + `DiscardOnTimeout::No` pattern already used by `get_session_at`/`list_messages_at`/`abort_at`, so a timed-out summarize POST returns `RequestTimeout` without touching the shared daemon. (2) `discard_running` logs a structured WARN with its reason (the parameter already exists, unused). (3) The serve manager gains a daemon-level exit watcher + loss signal channel + backoff-guarded automatic re-warm (mirroring freshcodex `spawn_exit_watcher`), and the freshopencode runtime subscribes one listener task that fans a typed `freshAgent.error{OPENCODE_DAEMON_LOST}` edge to every materialized session and, after a successful respawn, restarts dead serve bridges and pushes idle snapshot edges. (4) The client's `handleSnapshotError` gains a 409 `RESTORE_UNAVAILABLE` arm that drives the documented recovery — one generation-fenced `freshAgent.attach` per pane identity plus a snapshot refetch — instead of dead-ending at a dismiss-only banner.

**Tech Stack:** Rust (tokio, axum, tracing; crates `freshell-opencode`, `freshell-freshagent`), TypeScript/React (Redux Toolkit, Zod, Vitest + Testing Library, Playwright).

## Global Constraints

- All work happens in the worktree `.worktrees/opencode-daemon-death-recovery` on branch `the-usual/opencode-daemon-death-recovery` (base `855dae72a`). Never commit on `main`.
- The production self-hosted server on port 3001 must not be restarted without explicit user "APPROVED". All verification runs against locally spawned test servers or in-process harnesses only.
- The snapshot threads-route 409 envelope is a frozen contract: `status:"error"`, `code:"RESTORE_UNAVAILABLE"`, message `"Session <id> is still running on the server."` are load-bearing (pinned by `snapshot.rs:1151` `opencode_cold_get_owned_or_transitioning_answers_the_typed_409`; client regexes depend on the text). Additive fields are allowed; changing/removing pinned fields is not.
- The snapshot GET stays side-effect-free: never spawn, kill, or discard from `get_opencode_snapshot` (pinned by `snapshot.rs:1070` and `lib.rs:7474`/`lib.rs:7529`).
- `ServeError::RequestTimeout` must stay OUTSIDE `never_dispatched()` (a timed-out POST may have reached the daemon — the compact redo-destroy stands; serve.rs:539-551 pins this forever).
- Structured logging: `tracing` macros, dotted event name as the message, structured fields (schema: `freshell-server/src/logging.rs`). New event names follow the `freshagent.opencode.*` family (existing: `freshagent.opencode.compact_failed`, `freshagent.opencode.handoff_stop_abort_undelivered`).
- The shared daemon is NEVER a per-session kill target (`freshAgent.kill` stays session-scoped; lib.rs:2318-2325 "the shared opencode serve daemon is NOT the per-session writer and must NEVER be killed" — that invariant refers to the ownership watchdog; the manager's own discard/re-warm lifecycle is the exception this plan carefully rebuilds).
- Client a11y: no new interactive elements without labels/roles; the recovery reuses existing banner/card components, so no new a11y surface should be introduced.
- Rust: `cargo fmt --all --check` and `cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings` must stay clean (pre-push gate).
- TypeScript: `npm run typecheck` clean; relative imports in NodeNext contexts need `.js` extensions (the client uses `@/` aliases).
- Focused test commands (delegated, non-coordinated — safe for TDD loops):
  - `cargo test -p freshell-opencode`
  - `cargo test -p freshell-freshagent opencode_ws::tests`
  - `cargo test -p freshell-freshagent get_opencode_snapshot` (the lib.rs FR2 pins; crate-root tests are named `tests::...`, so filter by test-name substring — `lib::tests` matches nothing)
  - `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/<spec>.ts`
- Broad/coordinated runs (`npm test`, `test:server` zero-arg, `test:integration` zero-arg) go through the shared coordinator; wait for a free gate, never kill a foreign holder.

### Deliberate residuals (documented, out of scope)

- `prompt_async` (the send-turn POST) and the thin `json_request` wrappers (`get_session`, `list_messages`, `get_session_status_map`, `abort`, `fork`, `revert`, `unrevert`) KEEP `DiscardOnTimeout::Yes`. Rationale: they are the deliberate wedged-daemon recycler for writes (FR2 kept Yes for writes on purpose), and the incident class was compact-specific (an LLM-scale budget routinely exceeded by a healthy-but-busy daemon). A wedged-alive daemon is also caught by the new exit-watcher only if it exits; a hung-but-alive daemon remains the send-lane's recycle responsibility. Revisit only with a dedicated wedged-detection design.
- The frozen 409 message text stays (even when the Live owner's daemon is dead, the text says "still running on the server" — clients' muscle memory depends on it). The new `OPENCODE_DAEMON_LOST` runtime edge is what tells the user the truth.
- **Terminal-owner 409s are a different scenario from the incident** (log-validated in the load-bearing stage: the incident-time key was `Live{FreshAgent, gen 1}` — the pane's own stale claim; the later-observed `ownerKind:"terminal", ownerGeneration:2` body was the post-salvage handoff state, minted ~2h17m after the daemon died). For a genuine terminal owner the fenced attach is refused by design, and the existing recovery doors are the session-directory handoff (the door the user actually used to salvage the session) or the owning terminal's exit. The client 409 recovery (Task 5) is scoped to `ownerKind:"fresh-agent"` — the stale-own-claim class the incident actually was.
- **The validated core gap for the incident state** (LB-05, falsified): a map-hit fenced attach re-subscribes the serve bridge but never respawns the daemon — `spawn_serve_bridge` never calls `ensure_started`, and `ensure_manager` returns the discarded manager. The attach was exercised 3× in the incident and recovered nothing. Task 4 therefore adds `ensure_started` to the attach tail's bridge-restart arm (mirroring what `resume_durable_session` already does for map-misses), turning the fenced attach into a real recovery verb for the map-hit daemon-dead state.
- After Task 1, a timed-out compact leaves the summarize turn running daemon-side until its own ~600 s budget expires or an interrupt arrives; the pane's busy state settles via the existing await-idle/turn-settle machinery.
- Runtime watcher arming (Task 4): armed from the WS materializing handlers (handle_send/handle_attach/handle_compact) plus an immediate level pass at arming (revive dead bridges if the daemon is already running). Residual: a REST-only, never-viewed pane misses the `OPENCODE_DAEMON_LOST` banner until its first WS interaction — accepted, because the pane renders nothing until viewed, and revival is level-triggered.
- E2E daemon-death/respawn coverage runs in TWO lanes (plan-review round 1): Task 6 adds the cloud-legal client-recovery spec (routed-fetch pattern — it satisfies the configured-cloud-backend PR gate), and Task 7 adds the real-daemon self-heal spec on the LOCAL lane, modeled on the existing `freshopencode-restart-recovery.spec.ts` harness (real RustServer + fake-opencode on PATH). The real-daemon spec lands in `CLOUD_SKIP_SPECS` (same provider-lifecycle-timing class as its model), so the cloud gate's e2e coverage is carried by Task 6 while the end-to-end server lanes (process-exit detection, backoff respawn, bridge revival, status edge) are proven by Task 7 locally plus the Rust unit tests (the same coverage strategy the freshcodex self-heal uses).

---

### Task 1: Compact (and its pre-flight config read) no longer kill the shared daemon on timeout

**Files:**
- Modify: `crates/freshell-opencode/src/serve.rs` (`compact()` at ~:1193-1232, `get_config()` at ~:1169, `json_request_maybe_witnessed` at ~:864-888 stays untouched)
- Test: `crates/freshell-opencode/src/serve.rs` `#[cfg(test)] mod tests` (beside `compact_uses_the_dedicated_compact_timeout_not_the_generic_request_bound`, ~:2083)

**Interfaces:**
- Consumes: `json_request_over_base(method, path, body, not_found_value, base: String, discard_on_timeout: DiscardOnTimeout, dispatch_witnesses, timeout_override)` (serve.rs:890), `require_base()` (serve.rs:845), `DiscardOnTimeout` (serve.rs:345-355).
- Produces: unchanged public signatures for `compact()` / `get_config()` — the change is internal lane behavior only. Later tasks rely on: "a compact timeout does not clear the manager's running entry".

**Behavior:** `compact` becomes the FR2 shape for writes: resolve the base once (`require_base()` — spawn-on-demand is preserved), then POST `/session/{id}/summarize` through `json_request_over_base` with `DiscardOnTimeout::No` and the dedicated `compact_timeout`. `get_config` (a read, and the compact drive's pre-flight model-pair resolution at opencode_ws.rs:3675-3696) gets the same treatment — a slow GET must never kill the shared daemon (the FR2 doc rule for reads; today it violates it). All other lanes keep their current discard policy (see residuals).

- [ ] **Step 1: Write the failing behavioral test**

Add to the `#[cfg(test)] mod tests` module in serve.rs, reusing the existing fakes (`started_recording_manager_with_config`, `NeverExitsProcess` with its `killed: Arc<AtomicUsize>` counter, and a recording HTTP fake scripted so health answers 200 and `/summarize` never resolves — the wedged shape from `tests/serve_health_bounded.rs:78` (`std::future::pending()`), exposed through a per-URL scripting seam like `RecordingHttp` at serve.rs:1781-1871):

```rust
// 2026-09-20 incident: a compact timeout (600 s budget) ran the
// DiscardOnTimeout::Yes arm and KILLED the one shared `opencode serve`
// daemon for every freshopencode session. The compact lane must degrade
// like the FR2 snapshot lane: the POST times out, the daemon survives.
#[tokio::test]
async fn compact_timeout_does_not_kill_the_shared_daemon() {
    let killed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut config = ServeConfig::default();
    config.compact_timeout = std::time::Duration::from_millis(50);
    let (manager, http) = started_recording_manager_with_config(
        /* summarize always times out: script `/summarize` responses to hang */
        RecordingHttpScript::SummarizePending,
        config,
        killed.clone(),
    );
    let err = manager
        .compact("ses_timeout", "anthropic", "claude-sonnet-4-5", &route_for("/w"), None, None)
        .await
        .expect_err("the summarize POST must time out");
    assert!(matches!(err, ServeError::RequestTimeout { .. }), "got {err:?}");
    assert_eq!(
        killed.load(std::sync::atomic::Ordering::SeqCst),
        0,
        "a compact timeout must NEVER kill the shared daemon"
    );
    assert!(
        manager.base_url().await.is_some(),
        "the running entry must survive a compact timeout"
    );
    // The compact-timeout POST must still carry the dedicated budget.
    let summarize_index = http.index_of("POST", "/session/ses_timeout/summarize");
    assert_eq!(http.recorded_timeout(summarize_index), Some(std::time::Duration::from_millis(50)));
}

// The compact drive's pre-flight model-pair resolution reads /config; a slow
// config GET is the same defect class (a read must never kill the daemon).
#[tokio::test]
async fn get_config_timeout_does_not_kill_the_shared_daemon() {
    let killed = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut config = ServeConfig::default();
    config.request_timeout = std::time::Duration::from_millis(50);
    let (manager, _http) = started_recording_manager_with_config(
        RecordingHttpScript::ConfigPending,
        config,
        killed.clone(),
    );
    let err = manager.get_config().await.expect_err("config GET must time out");
    assert!(matches!(err, ServeError::RequestTimeout { .. }));
    assert_eq!(killed.load(std::sync::atomic::Ordering::SeqCst), 0,
        "a config read timeout must NEVER kill the shared daemon");
    assert!(manager.base_url().await.is_some());
}
```

(Draft: adapt the fake construction to the actual `RecordingHttp`/`started_recording_manager*` signatures — the fakes already record per-request timeouts at serve.rs:1808-1817; extend their URL scripting to include a never-resolving `/summarize` and `/config` arm if not already scriptable. The two assertions that matter are `killed == 0` and `base_url().is_some()` after `Err(RequestTimeout)`.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-opencode does_not_kill`

Expected: FAIL — `compact_timeout_does_not_kill_the_shared_daemon` fails with `killed: 1` (the discard-on-timeout arm killed the process) and/or `base_url()` is `None`; `get_config_timeout_does_not_kill_the_shared_daemon` fails the same way. (Single positional filter: cargo test accepts ONE TESTNAME — `does_not_kill` matches both new tests.)

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-opencode/src/serve.rs`:

```rust
/// `getConfig` for the compact drive's model-pair resolution (and any other
/// routed config read). Signature UNCHANGED (`route: &Route` stays — the
/// runtime calls `manager.get_config(&route)` for project-scoped config, and
/// the path must be `with_route("/config", route)`). A slow config read must
/// never kill the shared daemon — the FR2 read rule (b8ke): capture the base
/// once (spawn-on-demand is fine), then transport over the captured base
/// with `DiscardOnTimeout::No`.
pub async fn get_config(&self, route: &Route) -> Result<Value, ServeError> {
    let base = self.require_base().await?;
    self.json_request_over_base(
        HttpMethod::Get, &with_route("/config", route), None, None,
        base,
        DiscardOnTimeout::No,
        &[],
        None,
    ).await
}
```

and inside `compact()` (serve.rs:1193-1232), replace the `json_request_maybe_witnessed(...)` call with the captured-base form (keep the exact path/body/witness/timeout logic):

```rust
// 2026-09-20 incident: the summarize POST used the discard-on-timeout lane,
// so a 600 s budget exceeded on a healthy-but-busy daemon KILLED the one
// shared daemon for every freshopencode session. Mirror the FR2 captured-base
// transport (`get_session_at`, serve.rs:1003): a timed-out compact answers
// `RequestTimeout` and NEVER kills the shared daemon. The redo-destroy
// classification is unchanged — `RequestTimeout` stays outside
// `never_dispatched()` (a timed-out POST may have reached the daemon).
let base = self.require_base().await?;
self.json_request_over_base(
    HttpMethod::Post, &path, Some(body), None,
    base,
    DiscardOnTimeout::No,
    &witnesses,
    Some(self.config().compact_timeout),
).await?;
Ok(())
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-opencode does_not_kill`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None needed beyond the above (the change is already the FR2 mirror; `json_request_maybe_witnessed` remains for the lanes that intentionally keep `Yes`).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `freshell-opencode` tests (compact family, config, timeout plumbing) plus the `freshell-freshagent` compact-drive tests (the redo-destroy family pins `never_dispatched` classification and the `compact_failed` WARN — unchanged by this fix, but they exercise the compact lane end-to-end).

Run: `cargo test -p freshell-opencode && cargo test -p freshell-freshagent compact`

Expected: PASS (a pre-existing-failure comparison against the baseline ledger is not needed; baseline is green).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/serve.rs
git commit -m "fix(opencode): compact and config timeouts never kill the shared serve daemon"
```

---

### Task 2: Daemon discards emit a structured log

**Files:**
- Modify: `crates/freshell-opencode/src/serve.rs` (`discard_running` at ~:1348-1354)
- Test: `crates/freshell-opencode/src/serve.rs` `#[cfg(test)]` (beside the `config_capture` tracing-capture module, ~:2451-2502)

**Interfaces:**
- Consumes: the `config_capture` thread-local tracing capture idiom (serve.rs:2451-2502, the DIAG-01 pattern), `prompt_async` (serve.rs:1091 — a lane that intentionally keeps `DiscardOnTimeout::Yes`).
- Produces: `discard_running(reason: &str)` logs `tracing::warn!(reason = ..., "freshagent.opencode.daemon_discarded")` before the kill. Task 3 builds on this exact site.

- [ ] **Step 1: Write the failing behavioral test**

```rust
// 2026-09-20 incident: the daemon discard that killed the shared serve left
// ZERO log trace (discard_running's reason parameter is unused). The discard
// must be observable in the structured JSONL log.
#[tokio::test]
async fn discard_running_emits_a_structured_warn_with_its_reason() {
    let capture = config_capture::capture();
    let mut config = ServeConfig::default();
    config.request_timeout = std::time::Duration::from_millis(50);
    let (manager, _http) = started_recording_manager_with_config(
        RecordingHttpScript::PromptPending, // a Yes-lane request that times out
        config,
        Default::default(),
    );
    let err = manager.prompt_async(/* minimal args as in existing prompt tests */).await
        .expect_err("prompt POST must time out");
    assert!(matches!(err, ServeError::RequestTimeout { .. }));
    let events = capture.finish();
    let discard = events.iter().find(|e| e.get("message")
        .map(|m| m.as_str() == Some("freshagent.opencode.daemon_discarded")).unwrap_or(false))
        .expect("a daemon discard must emit freshagent.opencode.daemon_discarded");
    assert_eq!(discard.get("reason").and_then(|r| r.as_str()), Some("request_timeout"));
}
```

(Draft: adapt to the actual `config_capture` helper API and `prompt_async` minimal-args shape used by `run_turn_arms_the_accepted_witness_at_the_dispatch_boundary` at serve.rs:1982. If `config_capture` needs the event on the test's own thread, note `#[tokio::test]` runs current-thread — `discard_running` executes inline on it, so the capture sees it.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-opencode discard_running_emits`

Expected: FAIL — no `freshagent.opencode.daemon_discarded` event is captured (discard_running is tracing-silent today).

- [ ] **Step 3: Add the minimal production implementation**

```rust
async fn discard_running(&self, reason: &str) {
    let taken = self.inner.running.lock().await.take();
    if let Some(running) = taken {
        tracing::warn!(
            reason = reason,
            "freshagent.opencode.daemon_discarded"
        );
        running.process.kill();
    }
    self.emit_lost_for_all();
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-opencode discard_running_emits`

Expected: PASS

- [ ] **Step 5: Refactor while green**

None (single-site change; keep the underscore removal as the whole diff).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the whole `freshell-opencode` unit suite (tracing capture tests assert event sets; adding an event could affect any test asserting exact event streams — none do outside `config_capture`).

Run: `cargo test -p freshell-opencode`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/serve.rs
git commit -m "feat(opencode): structured log for shared-daemon discards"
```

---

### Task 3: Manager-level daemon-loss machinery — exit watcher, loss signal, backoff re-warm

**Files:**
- Modify: `crates/freshell-opencode/src/serve.rs` (Inner at ~:643-655, `RunningServe` at ~:634-641, `ensure_started` at ~:690-770, `discard_running` at ~:1348, `ServeConfig` at ~:557-603, `shutdown` at ~:1510-1517)
- Test: `crates/freshell-opencode/src/serve.rs` `#[cfg(test)]` + a new integration file `crates/freshell-opencode/tests/serve_daemon_selfheal.rs` (follows `serve_idle_edge.rs` / `serve_health_bounded.rs` conventions)

**Interfaces:**
- Consumes: `ServeProcess::exited()` (serve.rs:404-411), `emit_lost_for_all` (serve.rs:1332), Task 2's log site.
- Produces (used by Task 4 and later tests):
  - `pub enum DaemonSignal { Lost { reason: &'static str }, Started }` (crate-root re-export)
  - `OpencodeServeManager::subscribe_daemon_signals(&self) -> tokio::sync::broadcast::Receiver<DaemonSignal>` (capacity 16; NOTE: tokio broadcast does NOT replay history to late subscribers — late `subscribe()` starts at the tail, so Task 4's watcher design is level-triggered, not event-history-dependent)
  - `ServeConfig` gains: `daemon_watch_interval: Duration` (default 1000 ms), `re_warm_backoff_initial_ms: u64` (default 2000), `re_warm_backoff_max_ms: u64` (default 60_000).
  - `RunningServe` gains an additive `ownership_id: String` field (currently only a local in `ensure_started`), and `process` becomes `Arc<dyn ServeProcess>` (LB-06: the watcher needs a handle that outlives the entry; share the Arc, never move the Box).
  - Semantics: `Started` is broadcast on every successful cold start (not on fast-path returns of an already-running daemon); `Lost{reason}` on discard (`"request_timeout"` today) and on unrequested process exit (`"process_exit"`). The shared loss path is exactly-once (LB-07): only the arm whose running-entry take yields `Some` logs/signals/schedules; a `None` take is a silent no-op (the watcher-vs-discard race resolves via the take).

**Behavior:**
1. `ensure_started` spawns a daemon exit-watcher task after a successful health check (store its abort handle on `RunningServe` as `_exit_watch`). The watcher polls `process.exited()` every `daemon_watch_interval`; on `Some(exit)` it verifies the running entry is still ITS daemon (compare the captured `ownership_id`), then runs the manager's loss path.
2. The loss path (shared by watcher-exit and, minus the abort, by `discard_running`): WARN `freshagent.opencode.daemon_crash_detected` (watcher arm; fields `reason="process_exit"`, `base_url`) or the Task-2 discard WARN; take the running entry (killing it in the watcher arm is unnecessary — the process already exited; still call `process.kill()` for the /proc ownership reaper parity); `emit_lost_for_all()`; broadcast `DaemonSignal::Lost{reason}`; schedule a backoff-guarded re-warm. **Exactly-once (LB-07):** the take is the race arbiter — if it yields `None` (the other arm already ran), the whole path is a silent no-op: no log, no Lost, no re-warm.
3. Re-warm: a spawned task sleeps `min(re_warm_backoff_initial_ms * 2^(attempts-1), re_warm_backoff_max_ms)`, then calls `ensure_started()` (shutdown-flag checked inside; the task also checks it before sleeping). `attempts` is an `AtomicUsize` on `Inner`, incremented per scheduled re-warm, never reset (a crash-looping daemon retries at the max interval forever — self-heals when e.g. disk frees). Log `tracing::info!(outcome=..., attempt=..., "freshagent.opencode.daemon_re_warm")` on success and `tracing::warn!` on failure.
4. `discard_running` aborts the watcher FIRST (requested kill — no crash event), then the existing kill+lost, then `Lost` signal + re-warm schedule.
5. `shutdown`'s inline duplicate (serve.rs:1510-1517) also aborts the watcher; it must NOT schedule a re-warm (shutdown flag blocks it) and need not signal (server is going down) — keep it minimal: abort watcher + existing behavior.

- [ ] **Step 1: Write the failing behavioral tests**

New integration file `crates/freshell-opencode/tests/serve_daemon_selfheal.rs` (drafts; adapt fakes from `serve_health_bounded.rs:41-127` — add an `ExitingProcess` fake whose `exited()` flips to `Some(0)` after the test sets a shared flag, plus a kill counter):

```rust
// A daemon that dies on its own must not leave a poisoned running entry
// forever (the 2026-09-20 incident's silent half): the watcher clears the
// entry, emits Lost for in-flight turns, signals daemon loss, and schedules
// a backoff-guarded respawn.
#[tokio::test]
async fn unrequested_daemon_exit_clears_running_emits_lost_and_signals() {
    let exiting = Arc::new(AtomicBool::new(false));
    let killed = Arc::new(AtomicUsize::new(0));
    let spawner = FakeSpawner::with_process(ExitingProcess::new(exiting.clone(), killed.clone()));
    let mut config = ServeConfig::default();
    config.daemon_watch_interval = Duration::from_millis(10);
    config.re_warm_backoff_initial_ms = 5;
    let manager = started_manager_with(spawner, config); // health 200 fake
    let mut signals = manager.subscribe_daemon_signals();
    let mut idle = manager.subscribe("ses_a").expect("subscribable");
    exiting.store(true, Ordering::SeqCst); // the daemon "exits"
    let signal = tokio::time::timeout(Duration::from_secs(2), signals.recv())
        .await.expect("loss signal within budget").expect("channel alive");
    assert!(matches!(signal, DaemonSignal::Lost { reason: "process_exit" }));
    assert!(manager.base_url().await.is_none(), "running entry must be cleared");
    assert!(matches!(idle.try_recv(), Ok(SessionSignal::Lost)), "in-flight subscribers must see Lost");
    // ...assert the WARN freshagent.opencode.daemon_crash_detected via the
    // tracing capture if the integration file can host it (else assert in unit tests).
}

// Crash-loop guard: the automatic re-warm must back off exponentially, not
// spawn-storm.
#[tokio::test]
async fn daemon_loss_re_warm_backs_off_exponentially() {
    // Process that "dies" immediately after every successful start:
    let spawns = Arc::new(AtomicUsize::new(0));
    let spawner = FakeSpawner::with_process(ExitAfterHealthProcess::new(spawns.clone()));
    let mut config = ServeConfig::default();
    config.daemon_watch_interval = Duration::from_millis(5);
    config.re_warm_backoff_initial_ms = 50;
    config.re_warm_backoff_max_ms = 400;
    let manager = started_manager_with(spawner, config);
    manager.ensure_started().await.expect("first start");
    tokio::time::sleep(Duration::from_millis(700)).await;
    let observed = spawns.load(Ordering::SeqCst);
    // With 50ms initial doubling to 400ms cap: expected spawns within 700ms
    // of the first loss are ~3-4. Un-backed-off would be dozens. Assert a
    // conservative bound:
    assert!(observed <= 6, "re-warm must back off (observed {observed} spawns)");
}

// Plan-review round 1: a failed re-warm attempt must RETRY (the loop), not
// give up — a transient spawn/health failure (e.g. disk pressure) must not
// leave the daemon permanently absent until unrelated user activity.
#[tokio::test]
async fn a_failed_re_warm_retries_until_the_daemon_starts() {
    // Scripted spawner/health: the first two cold starts FAIL health, the
    // third succeeds (a spawner whose fake process exits before health, then
    // a healthy one — or an http fake scripted 500/500/200 on /global/health).
    let spawns = Arc::new(AtomicUsize::new(0));
    let (manager, _http) = started_manager_with_failing_then_healthy(
        /* fail_twice_then_healthy */ spawns.clone(),
        ServeConfig {
            daemon_watch_interval: Duration::from_millis(5),
            re_warm_backoff_initial_ms: 10,
            re_warm_backoff_max_ms: 50,
            ..ServeConfig::default()
        });
    manager.ensure_started().await.expect_err("first start fails (scripted)");
    // Drive the FIRST loss (watcher fires on the dead fake process), then the
    // retry loop must keep trying until the scripted success:
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if manager.base_url().await.is_some() { break; }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }).await.expect("the re-warm loop must eventually succeed");
    assert!(spawns.load(Ordering::SeqCst) >= 3, "failed attempts must be retried (observed {})", spawns.load(Ordering::SeqCst));
}

// A discard (the intentional kill path) must ALSO signal daemon loss so the
// runtime self-heal (Task 4) observes it.
#[tokio::test]
async fn discard_running_signals_daemon_loss_and_schedules_re_warm() {
    // prompt-timeout discard (Yes-lane), then:
    // - DaemonSignal::Lost { reason: "request_timeout" } arrives
    // - after the backoff, a respawn happened (spawner count grew)
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-opencode --test serve_daemon_selfheal`

Expected: FAIL — `subscribe_daemon_signals` does not exist (compile error is the intended missing behavior; write the enum + stub method returning a channel that never signals if needed to make it a runtime red instead — prefer the compile-first red, then a minimal stub for a runtime red on the watcher semantics).

- [ ] **Step 3: Add the minimal production implementation**

In serve.rs (sketch — the implementer adapts to the actual Inner/ensure_started structure; LB-06/LB-07 corrections applied: the watcher holds an `Arc` clone of the process + the ownership id, never a moved Box):

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonSignal { Lost { reason: &'static str }, Started }

// Inner gains:
//   daemon_signals: tokio::sync::broadcast::Sender<DaemonSignal>,  (capacity 16, on construction)
//   re_warm_attempts: std::sync::atomic::AtomicUsize,
// RunningServe gains:
//   ownership_id: String,
//   process: Arc<dyn ServeProcess>,        // was Box<dyn ServeProcess> — LB-06
//   _exit_watch: Option<tokio::task::AbortHandle>,

// ensure_started, after storing RunningServe (the cold-start success path):
let watch = self.spawn_exit_watch(base_url.clone(), Arc::clone(&process), ownership_id.clone());
running._exit_watch = watch;
let _ = self.inner.daemon_signals.send(DaemonSignal::Started);

// The watcher polls the SHARED process Arc (the running entry keeps its own
// Arc; nothing is moved out of RunningServe):
fn spawn_exit_watch(&self, base_url: String, process: Arc<dyn ServeProcess>, ownership_id: String) -> Option<AbortHandle> {
    let manager = self.clone(); // OpencodeServeManager is Arc-backed-cheap
    let interval = ...config.daemon_watch_interval...;
    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if process.exited().is_some() {
                manager.handle_unrequested_exit(&base_url, &ownership_id).await;
                return;
            }
        }
    });
    Some(handle.abort_handle())
}

// Staleness-gated loss path. The take is the exactly-once arbiter (LB-07):
// a None take means the other arm already handled this loss — silent no-op.
async fn handle_unrequested_exit(&self, base_url: &str, ownership_id: &str) {
    let taken = {
        let mut running = self.inner.running.lock().await;
        match running.as_ref() {
            Some(r) if r.ownership_id == ownership_id => running.take(), // ours, still current
            _ => return, // stale watcher (a newer daemon owns the entry) — no-op
        }
    };
    let Some(running) = taken else { return };
    tracing::warn!(reason = "process_exit", base_url = %base_url, "freshagent.opencode.daemon_crash_detected");
    running.process.kill(); // reaper parity only — the process already exited
    self.emit_lost_for_all();
    let _ = self.inner.daemon_signals.send(DaemonSignal::Lost { reason: "process_exit" });
    self.schedule_re_warm();
}

// discard_running: abort the watcher (running._exit_watch) FIRST, Task-2 WARN,
// kill, emit_lost_for_all, send Lost{reason}, schedule_re_warm(). Same
// exactly-once discipline: the take yields None only if the watcher lost the
// race, in which case the abort already ran and the watcher returned.

fn schedule_re_warm(&self) {
    if self.inner.shutdown.load(Ordering::SeqCst) { return; }
    let manager = self.clone();
    tokio::spawn(async move {
        // RETRY LOOP (plan-review round 1): a failed attempt must schedule
        // the NEXT attempt — a single-shot spawn that only WARNs leaves the
        // daemon permanently absent (the disk-pressure case). Retry forever at
        // the capped interval; the shutdown flag is checked each iteration.
        loop {
            let attempts = manager.inner.re_warm_attempts.fetch_add(1, Ordering::SeqCst) + 1;
            let delay_ms = (manager.config().re_warm_backoff_initial_ms
                .saturating_mul(1u64 << (attempts - 1).min(16)))
                .min(manager.config().re_warm_backoff_max_ms);
            tokio::time::sleep(Duration::from_millis(delay_ms)).await;
            if manager.inner.shutdown.load(Ordering::SeqCst) { return; }
            match manager.ensure_started().await {
                Ok(_) => {
                    tracing::info!(attempt = attempts, "freshagent.opencode.daemon_re_warm");
                    return; // started — the loop ends; the exit watcher arms again for this daemon
                }
                Err(err) => {
                    // Log and RETRY (backoff escalates via the attempts counter).
                    tracing::warn!(attempt = attempts, error = %err, "freshagent.opencode.daemon_re_warm");
                }
            }
        }
    });
}

pub fn subscribe_daemon_signals(&self) -> tokio::sync::broadcast::Receiver<DaemonSignal> {
    self.inner.daemon_signals.subscribe()
}
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-opencode --test serve_daemon_selfheal && cargo test -p freshell-opencode`

Expected: PASS (including all pre-existing tests — especially `rejects_on_sidecar_lost`, `settles_within_deadline_when_health_never_resolves` (its kill path now aborts the watcher too), and the FR2 trio).

- [ ] **Step 5: Refactor while green**

Fold the shared loss path (take-entry + lost + signal + schedule) into one private helper used by both the watcher arm and `discard_running` (the only difference: the WARN text/reason and the pre-abort).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all of `freshell-opencode` (manager core), plus `freshell-freshagent opencode_ws::tests` (the runtime drives the manager — its fakes seed via `set_manager_for_test`; new fields/behavior must not break the 119 existing tests) and `freshell-freshagent lib::tests` (FR2 pins).

Run: `cargo test -p freshell-opencode && cargo test -p freshell-freshagent opencode_ws::tests && cargo test -p freshell-freshagent get_opencode_snapshot`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-opencode/src/serve.rs crates/freshell-opencode/tests/serve_daemon_selfheal.rs
git commit -m "feat(opencode): daemon exit watcher, loss signal, and backoff re-warm"
```

---

### Task 4: Runtime-level self-heal — daemon-loss fan-out, bridge restart, and pane revival

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (state struct ~:92-162, `handle_attach` ~:5166, `handle_send` ~:1428, `handle_compact` ~:3544, `spawn_serve_bridge` ~:5971)
- Modify: `crates/freshell-freshagent/src/lib.rs` (`ensure_manager` ~:2803 — expose the manager cell clone helper if needed)
- Modify: `AGENTS.md` (architecture prose, "Agent Status Indicators" freshopencode sentence) and `crates/freshell-server/src/logging.rs` canonical event-name list (~:48-54) if it enumerates event names
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` `#[cfg(test)] mod tests` (mirror the codex self-heal test at codex.rs:15846)

**Interfaces:**
- Consumes: Task 3's `subscribe_daemon_signals()` / `DaemonSignal`; `event_frame`/`emit_fresh_agent_error` (opencode_ws.rs:6068/686), `spawn_serve_bridge` (opencode_ws.rs:5971), `FreshAgentState.broadcast_tx` (lib.rs:1917), `set_manager_for_test` (lib.rs:2837), `ensure_manager` (lib.rs:2803 — the real seam; there is no `peek_or_ensure_manager`).
- Produces: 
  - A per-materialized-session typed edge on daemon loss: `freshAgent.event{provider:"opencode", sessionType:"freshopencode", event:{type:"freshAgent.error", code:"OPENCODE_DAEMON_LOST", message:"The opencode serve daemon was lost unexpectedly - it is restarting automatically."}}` — folds client-side through the EXISTING generic `sessionError` path (fresh-agent-ws.ts:514-520), showing the dismissible "Agent error:" banner and clearing busy.
  - Level-triggered bridge revival: on arming, and again on every `DaemonSignal::Started`, restart bridges that are dead/absent for materialized sessions and push `freshAgent.session.snapshot{status:"idle"}` ONLY to sessions whose bridge was actually restarted (which the client treats as snapshot-invalidating → transcript refetch). No `saw_loss` heuristic — tokio broadcast does not replay history, so revival must not depend on having seen the `Lost` edge (LB-02).
  - **The fenced attach becomes a real recovery verb (LB-05 redesign):** `handle_attach`'s dead-bridge restart arm (opencode_ws.rs:5460-5473) gains `manager.ensure_started().await` before `spawn_serve_bridge` — a map-hit fenced attach against a daemon-absent manager now respawns the shared daemon and re-bridges, exactly as `resume_durable_session` already does for map-misses. No chime: the recovery must never emit `freshAgent.turn.complete`.

- [ ] **Step 1: Write the failing behavioral tests**

In `opencode_ws.rs` tests (drafts; mirror `onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped` at codex.rs:15846-15896 and the `state_with_bus` harness at codex.rs:9983-9991 — the opencode tests already have the bus pattern + `set_manager_for_test`):

```rust
// 2026-09-20 incident: the shared daemon died and NOTHING told the panes —
// no status edge, no respawn, no bridge revival; panes dead-ended on the
// snapshot 409. The runtime self-heal must make daemon loss observable and
// recoverable per session. (LB-02: revival is level-triggered — it runs on
// arming and on Started, never dependent on having observed Lost.)
#[tokio::test]
async fn daemon_loss_fans_out_a_typed_edge_then_revives_bridges_after_respawn() {
    let exiting = Arc::new(AtomicBool::new(false));
    let (state, rx) = opencode_state_with_bus(); // FreshAgentState::new(auth, tx) + FreshOpencodeState, per existing helpers
    state.fresh_agent.set_manager_for_test(fake_manager_exiting_after( // health 200, prompt/summarize ok, ExitingProcess(exiting)
        exiting.clone(), /* tiny watch + backoff config */));
    let session = materialized_opencode_session(&state, "ses_recover").await; // via handle_send against the fake http, as existing send tests do
    exiting.store(true, Ordering::SeqCst); // the daemon dies
    let frame = next_fresh_agent_frame(&rx).await;
    assert_eq!(frame["event"]["type"], "freshAgent.error");
    assert_eq!(frame["event"]["code"], "OPENCODE_DAEMON_LOST");
    assert_eq!(frame["sessionId"], "ses_recover");
    // NO chime ever accompanies a daemon loss:
    assert_no_turn_complete(&rx).await;
    // Plan-review round 1 (Minor): the session is dual-keyed (placeholder +
    // ses_*) in the map — exactly ONE OPENCODE_DAEMON_LOST edge per
    // materialized session must be emitted (drain the bus and count).
    assert_exactly_one_daemon_lost_edge(&rx, "ses_recover").await;
    exiting.store(false, Ordering::SeqCst); // the re-warm's respawn now succeeds
    let frame = next_fresh_agent_frame(&rx).await; // DaemonSignal::Started → level-triggered revival
    assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
    assert_eq!(frame["event"]["status"], "idle");
    assert!(session_serve_bridge_alive(&state, "ses_recover").await, "bridge restarted after respawn");
}

// LB-05 (falsified → redesign): in the incident, the pane's fenced attach was
// exercised 3× against the dead shared daemon and recovered NOTHING, because
// the attach tail only re-subscribed the bridge — nothing respawns the
// daemon for a map-hit. The attach tail must ensure the daemon exists.
#[tokio::test]
async fn map_hit_fenced_attach_respawns_the_daemon_and_rebridges() {
    let spawns = Arc::new(AtomicUsize::new(0));
    let (state, rx) = opencode_state_with_bus();
    state.fresh_agent.set_manager_for_test(fake_manager_with( // health 200; daemon DISCARDED before the attach
        FakeSpawner::counting(spawns.clone())));
    let session = materialized_opencode_session(&state, "ses_attach_recover").await;
    discard_manager_running_entry(&state).await; // the shared daemon is dead; the session row persists
    let fence = observed_fence_for(&state, "ses_attach_recover").await; // the runtime-owner pair
    state.handle_attach(attach_msg("ses_attach_recover", fence)).await;
    assert!(spawns.load(Ordering::SeqCst) >= 1, "a map-hit attach against a daemon-absent manager must respawn the daemon");
    assert!(session_serve_bridge_alive(&state, "ses_attach_recover").await, "the bridge must be restarted");
    let frame = next_fresh_agent_frame(&rx).await; // the attach tail's snapshot push
    assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
}
```

(Drafts: adapt to the actual harness helpers — `opencode_state_with_bus`, session materialization via `handle_send` against the seeded fake http, and the manager's running-entry discard via the fake's own seams or `discard_running`. Lock discipline per LB-01: any test helper that walks the sessions map must clone the `Arc` session handles under a short map lock and drop the map guard before locking a session — the map guard is NEVER held across a per-session lock acquisition, per the documented contract at opencode_ws.rs:100-115.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent daemon_loss_fans_out` && `cargo test -p freshell-freshagent map_hit_fenced_attach` (two commands — cargo test accepts ONE positional TESTNAME)

Expected: FAIL — `daemon_loss_fans_out...` fails with no `OPENCODE_DAEMON_LOST` frame (today `SessionSignal::Lost` is a no-op at opencode_ws.rs:6018; no listener exists); `map_hit_fenced_attach...` fails because the attach tail never spawns the daemon (spawns == 0, the LB-05-validated gap).

- [ ] **Step 3: Add the minimal production implementation**

Two server-side changes (LB-01/LB-02/LB-08/LB-10/N-3 corrections applied):

**(a) The attach tail's bridge-restart arm (opencode_ws.rs:5460-5473) ensures the daemon exists before re-bridging — the LB-05 redesign that turns the fenced attach into a real recovery verb:**

```rust
// LB-05 (falsified → redesign): in the incident the fenced attach was
// exercised 3× against the dead daemon and recovered nothing — the tail only
// re-subscribed the bridge. A map-hit attach must respawn the shared daemon
// (mirroring resume_durable_session's map-miss behavior). ensure_started is
// single-flighted, so concurrent attach/send/compact callers cannot spawn a
// second daemon.
let manager = self.fresh_agent.ensure_manager().await;
if let Err(err) = manager.ensure_started().await {
    // Bounded health failure: answer the attach with the typed error path
    // (the existing emit_fresh_agent_error machinery) instead of a silent
    // half-attached state.
    ...
}
// ...existing dead-bridge restart + spawn_serve_bridge tail...
```

**(b) The daemon-loss watcher on `FreshOpencodeState` (idempotent; armed from handle_send/handle_attach/handle_compact; LB-10: the task holds a full state clone so `spawn_serve_bridge(&self, ...)` is callable directly):**

```rust
// FreshOpencodeState gains: daemon_loss_watcher: Arc<OnceCell<()>>.
fn ensure_daemon_loss_watcher(&self) {
    if self.daemon_loss_watcher.set(()).is_err() { return; } // already armed
    let manager = self.fresh_agent.ensure_manager().await; // lib.rs:2803 (N-3: the real seam)
    let state = self.clone();
    let mut signals = manager.subscribe_daemon_signals();
    tokio::spawn(async move {
        // Arming-time level pass (LB-02: broadcast does NOT replay history —
        // if the daemon already re-warmed before we subscribed, revive now).
        state.revive_dead_bridges_if_daemon_running().await;
        loop {
            match signals.recv().await {
                Ok(DaemonSignal::Lost { reason }) => {
                    tracing::warn!(reason = reason, "freshagent.opencode.daemon_loss_observed");
                    // LB-01: NEVER hold the sessions-map guard across a
                    // per-session lock (contract at opencode_ws.rs:100-115 —
                    // the reverse edge deadlocked production). Clone the
                    // (id, Arc<session>) pairs under ONE short map lock,
                    // drop the guard, then read each session outside it.
                    // Plan-review round 1 (Minor): the map is keyed by BOTH
                    // the placeholder and the durable id pointing at the SAME
                    // session — dedupe by real_session_id (BTreeSet) so each
                    // materialized session gets exactly ONE edge.
                    let materialized: std::collections::BTreeSet<String> = {
                        let map = state.sessions.lock().await;
                        let handles: Vec<Arc<TokioMutex<OpencodeSession>>> = map.values().cloned().collect();
                        drop(map);
                        handles.into_iter().filter_map(|s| s.lock().await.real_session_id.clone()).collect()
                    };
                    for id in materialized {
                        let _ = state.fresh_agent.broadcast_tx.send(event_frame_json(&id, json!({
                            "type": "freshAgent.error", "sessionId": id,
                            "code": "OPENCODE_DAEMON_LOST",
                            "message": "The opencode serve daemon was lost unexpectedly - it is restarting automatically.",
                        })));
                    }
                }
                Ok(DaemonSignal::Started) => {
                    // Level-triggered revival (LB-02): revive whatever is
                    // dead; push the idle snapshot ONLY to sessions whose
                    // bridge was actually restarted. No `saw_loss` heuristic.
                    state.revive_dead_bridges_if_daemon_running().await;
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue, // LB-08: never disarm on Lagged
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
            }
        }
    });
}

// The revival pass (also called at arming), respecting LB-01's lock order:
// 1. manager.base_url().await is None → return (daemon absent — nothing to
//    revive into; the next Started signal or attach drives revival).
// 2. Snapshot the map: clone (session_id, Arc<Mutex<OpencodeSession>>) pairs
//    under ONE short map lock, dropping the guard immediately.
// 3. For each pair (OUTSIDE the map guard): lock the session; if
//    real_session_id is Some AND the serve-bridge handle is_finished/absent
//    → spawn_serve_bridge(...) and broadcast snapshot_event(real_id, "idle").
//    Push the snapshot ONLY to sessions whose bridge was actually restarted.
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent daemon_loss_fans_out` && `cargo test -p freshell-freshagent map_hit_fenced_attach`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Ensure the fan-out + bridge-revival helper is shared (not duplicated) with `handle_attach`'s restart arm; keep AGENTS.md's "Agent Status Indicators" paragraph truthful — update the freshopencode sentence to document the daemon-loss self-heal (edge shape, no chime, backoff respawn, bridge revival, and the fix-4 client recovery pointer).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `opencode_ws::tests` (119 tests) plus the lib.rs snapshot pins (`get_opencode_snapshot_*` — crate-root `mod tests` tests are named `tests::...`, so the filter is the test-name substring, not `lib::tests`).

Run: `cargo test -p freshell-freshagent`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/lib.rs AGENTS.md crates/freshell-server/src/logging.rs
git commit -m "feat(freshopencode): daemon-loss self-heal edge, respawn revival, and bridge restarts"
```

---

### Task 5: Client drives fenced attach + refetch on the snapshot 409 RESTORE_UNAVAILABLE

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (predicate beside `isLostFreshOpencodeThreadError` at ~:455-463; new arm in `handleSnapshotError` at ~:2770-2827; a one-shot guard ref; the pane-refresh attach-decision lane at ~:1718-1761 is the reuse pattern)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (beside the 404 test at ~:1887-1930)

**Interfaces:**
- Consumes: `ApiError.details` (the full 409 body: `code`, `ownerKind`, `ownerGeneration`), `captureFreshAgentAttachmentAttempt` (the real wrapper at FreshAgentView.tsx — R-1: the pane-refresh reaction pattern at :1718-1761 is the exact reuse: bump `attachDecisionSerialRef`, capture, `sendFencedFreshAgentAttach(attempt)`), `sendFencedFreshAgentAttach` (:1262-1275), `requestSnapshotRefresh` / `requestRevealRefresh`, `selectPaneOwnerFence`.
- Produces: on a 409 `RESTORE_UNAVAILABLE` snapshot error for a freshopencode pane whose refusal names a `fresh-agent` owner (the incident class — the pane's own stale claim; LB-05 scoped terminal owners out to the session-directory handoff door): ONE generation-fenced `freshAgent.attach` followed by a snapshot refetch. Bounded (LB-03): the ENTIRE recovery — attach + refetch — runs once per pane identity (`createRequestId` + `snapshotThreadId`); a second 409 falls through to the existing error surfaces (loadError banner / reveal error), never re-triggering fetches. When the 409 arrived on the reveal lane with `snapshotDirty` set, the recovery drives the reveal-refresh path (`requestRevealRefresh(true)`) so the success-path reveal-dirty clear can run and the "Refreshing conversation" overlay lifts (LB-04). The pane identity is NOT reset (unlike the 404 lost-thread path).

- [ ] **Step 1: Write the failing behavioral test**

In FreshAgentView.test.tsx (draft — template is the 404 test at :1887-1930; reuse its harness: `apiMock.getFreshAgentThreadSnapshot.mockRejectedValueOnce`, `StoreBackedFreshAgentView`, `sentFreshAgentMessages`):

```ts
// 2026-09-20 incident (log-validated): the daemon died, the reveal GET
// answered the typed 409 RESTORE_UNAVAILABLE for the pane's OWN stale
// Live{FreshAgent, gen 1} claim, and the pane dead-ended on a dismiss-only
// banner forever. The documented recovery is the generation-fenced attach +
// refetch — drive it once.
// LB-09: the mount attach already sends ONE freshAgent.attach on mount, so a
// bare length assertion is vacuous — read the baseline AFTER the mount
// settles and assert the POST-409 delta.
// Plan-review round 1: DEFER the first rejection until after the baseline is
// read — an immediately-rejected mock races the mount fetch (the recovery
// attach may land before the test snapshots the count).
it('recovers a freshopencode pane from a snapshot 409 with one fenced attach and a refetch', async () => {
  let rejectFirstSnapshot!: (error: unknown) => void
  apiMock.getFreshAgentThreadSnapshot
    .mockImplementationOnce(() => new Promise<never>((_, reject) => { rejectFirstSnapshot = reject }))
    .mockResolvedValue(freshopencodeSnapshot({ sessionId: 'ses_live', status: 'idle' })) // the refetch succeeds
  renderFreshAgentPane({ provider: 'opencode', sessionId: 'ses_live', status: 'connected' })
  await waitFor(() => expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(1))
  const attachCountBeforeRecovery = sentFreshAgentMessages('freshAgent.attach').length // the mount attach, settled
  await act(async () => {
    rejectFirstSnapshot({
      status: 409,
      message: 'Session ses_live is still running on the server.',
      details: { code: 'RESTORE_UNAVAILABLE', ownerKind: 'fresh-agent', ownerGeneration: 1 },
    })
  })
  await waitFor(() => {
    expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(attachCountBeforeRecovery + 1) // the RECOVERY attach (LB-09)
  })
  await waitFor(() => {
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2) // exactly one recovery refetch
  })
  // The pane kept its identity (the 409 is NOT the 404 lost-thread reset):
  expect(getFreshAgentPaneContent(store).sessionId).toBe('ses_live')
  // And no dead-end banner for the recovered pane:
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

it('does not loop recovery fetches on repeated 409s', async () => {
  apiMock.getFreshAgentThreadSnapshot.mockRejectedValue({
    status: 409, message: 'Session ses_live is still running on the server.',
    details: { code: 'RESTORE_UNAVAILABLE', ownerKind: 'fresh-agent', ownerGeneration: 1 },
  })
  renderFreshAgentPane({ provider: 'opencode', sessionId: 'ses_live', status: 'connected' })
  // Plan-review round 1: AWAIT the banner — findByText returns a promise;
  // asserting its truthiness is always true and leaves the baseline unordered.
  await screen.findByText(/still running on the server/i)
  const baseline = sentFreshAgentMessages('freshAgent.attach').length
  // Let any would-be refetch loop run (fake timers or a short flush):
  await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
  expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(baseline) // one recovery total, not per fetch (LB-03)
  expect(apiMock.getFreshAgentThreadSnapshot.mock.calls.length).toBeLessThanOrEqual(3) // mount + recovery only — no loop
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t '409'`

Expected: FAIL — no attach is sent; the pane shows the dismiss-only alert banner (the current dead-end).

- [ ] **Step 3: Add the minimal production implementation**

In FreshAgentView.tsx (sketch):

```ts
function isRestoreUnavailableSnapshotError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const status = 'status' in error ? (error as { status?: unknown }).status : undefined
  const details = 'details' in error ? (error as { details?: unknown }).details : undefined
  const code = details && typeof details === 'object' && 'code' in details
    ? (details as { code?: unknown }).code
    : undefined
  const ownerKind = details && typeof details === 'object' && 'ownerKind' in details
    ? (details as { ownerKind?: unknown }).ownerKind
    : undefined
  // LB-05 scoping: fresh-agent owners are the pane's own stale-claim class
  // (the incident state) — the fenced attach proceeds for them. Terminal
  // owners are a different scenario (a genuinely terminal-owned session);
  // their recovery door is the session-directory handoff, so the client does
  // not attempt the (refused) attach for them.
  return status === 409 && code === 'RESTORE_UNAVAILABLE' && ownerKind === 'fresh-agent'
}
```

In `handleSnapshotError`, after the opencode lost-404 arm and BEFORE the reveal arm — provider-gated to `opencode` (LB-03: the ENTIRE recovery — attach + refetch — sits inside the once-per-identity guard; a second 409 falls through to the honest error surfaces below, never looping):

```ts
// 2026-09-20 incident: with the daemon dead, daemon-absent snapshot GETs
// answer the typed 409 RESTORE_UNAVAILABLE for as long as the session key
// stays Live. The documented recovery is the generation-fenced attach
// (b8ke Task-5: cold resume flows only through the explicit lifecycle
// commands) — drive it ONCE per pane identity, then refetch via the
// reveal-refresh path when reveal-dirty (LB-04) so the overlay can clear.
// Repeated 409s fall through to the honest error surfaces below; never
// reset the pane.
if (paneContent.provider === 'opencode' && isRestoreUnavailableSnapshotError(error)) {
  const fresh = paneContentRef.current
  const recoveryKey = `${fresh.createRequestId}:${sessionId}`
  if (restoreUnavailableRecoveryRef.current !== recoveryKey) {
    restoreUnavailableRecoveryRef.current = recoveryKey
    attachDecisionSerialRef.current += 1
    const attempt = captureFreshAgentAttachmentAttempt(fresh) // R-1: the real wrapper's call shape
    sendFencedFreshAgentAttach(attempt)
    // LB-04: a reveal-lane 409 with snapshotDirty set must refetch through
    // the reveal path ('reveal' trigger), or the success-path reveal-dirty
    // clear never runs and the pane hides behind the "Refreshing
    // conversation" overlay forever. Otherwise refetch via 'manual'.
    if (trigger === 'reveal' && snapshotDirtyRef.current) {
      revealRefreshStartedAtRef.current = null
      setSnapshotRevealError(null)
      requestRevealRefresh(true)
    } else {
      setLoadError(null)
      requestSnapshotRefresh('manual')
    }
    return // recovery fired for this error — the honest error surfaces below are for SUBSEQUENT 409s only
  }
  // Recovery already attempted for this identity: do NOT clear errors and do
  // NOT refetch again — fall through to the reveal error arm / setLoadError
  // below so the user sees the honest state.
}
```

(Adapt: the ref `restoreUnavailableRecoveryRef = useRef<string | null>(null)` beside the other reveal refs ~:800-804; `captureFreshAgentAttachmentAttempt`'s real signature follows the pane-refresh reaction lane at :1735-1739. Verify the reveal-refresh request helper's exact name/behavior (`requestRevealRefresh(true)` forces a reveal-tagged refresh) against the state machine at :2601-2624 and the arming sites ~:1233.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx -t '409'`

Expected: PASS

- [ ] **Step 5: Refactor while green**

If the 409 arm and the 404 arm now share reset-vs-recover structure, extract only what is genuinely shared (they intentionally differ: reset vs recover) — otherwise leave as-is.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the full FreshAgentView suite (the snapshot error paths, reveal lanes, attach lanes, and scheduler tests all touch `handleSnapshotError`) plus the fresh-agent-ws fold tests.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/lib/fresh-agent-turn-complete.test.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "fix(fresh-agent): recover freshopencode panes from snapshot 409 via fenced attach and refetch"
```

---

### Task 6: Cloud-legal e2e — the 409 recovery story end to end

**Files:**
- Create: `test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts`
- Test: itself (local chromium run; must NOT be added to `CLOUD_SKIP_SPECS` in `test/e2e-browser/playwright.cloud.config.ts`)

**Interfaces:**
- Consumes: the model-picker "sidecar suppressed + routed fetch" pattern (the explicitly-cloud-legal pattern cited at playwright.cloud.config.ts:36-38; follow `test/e2e-browser/specs/freshopencode-model-picker.spec.ts`), the `TestHarness` (`test/e2e-browser/helpers/test-harness.js`), `RustServer` helper.
- Produces: an e2e proof of the Task-5 user story: a freshopencode pane whose snapshot fetch first 409s (`RESTORE_UNAVAILABLE` + `ownerKind`/`ownerGeneration` body) then 200s, recovers by sending `freshAgent.attach` and rendering the transcript — with no dismiss-only dead-end.

- [ ] **Step 1: Write the failing-passing spec (verification task; Task 5 already turned the behavior green)**

Draft structure (follow the model-picker spec's routing/suppression mechanics exactly):

```ts
test('freshopencode pane recovers from a snapshot 409 via fenced attach', async ({ page }) => {
  // 1. Suppress the opencode sidecar (model-picker pattern:
  //    setSuppressAllFreshAgentNetworkEffects(true) routes freshAgent.* WS
  //    frames to the harness spy — getSentWsMessages() captures them).
  // 2. Route /api/fresh-agent/threads/freshopencode/opencode/:id:
  //    first call -> fulfill(409, { status:'error', code:'RESTORE_UNAVAILABLE',
  //      message:'Session <id> is still running on the server.',
  //      ownerKind:'fresh-agent', ownerGeneration:1 })   // the incident class (LB-05)
  //    subsequent -> fulfill(200, <a minimal valid FreshAgentSnapshot>)
  // 3. Seed a freshopencode pane with a durable ses_* session (harness).
  // 4. Assert: a POST-409 recovery freshAgent.attach frame is sent (R-2: the
  //    mount attach also appears in the spy log — count the delta after the
  //    409 lands, not the total), the transcript renders from the 200
  //    snapshot, and no dismiss-only dead-end alert remains.
})
```

- [ ] **Step 2: Run it locally**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts`

Expected: PASS. (Sanity-check the red history: `git stash` the Task-5 commit is NOT needed — Task 5's unit red already proves the pre-fix dead-end; record that linkage in the commit message.)

- [ ] **Step 3: Verify cloud inclusion**

Run: `FRESHELL_E2E_BACKEND=cloud npm run test:e2e` in the coordinated lane (or the narrow cloud invocation the repo sanctions for one spec) and confirm the spec is selected — it must not appear in `CLOUD_SKIP_SPECS`, `LOCAL_ONLY_SPECS`, or match any `CLOUD_SKIP_TITLES` pattern.

Expected: the spec runs (and passes) on the cloud backend; per AGENTS.md, "a spec sitting in CLOUD_SKIP_SPECS is not coverage".

- [ ] **Step 4: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-snapshot-409-recovery.spec.ts
git commit -m "test(e2e): freshopencode snapshot-409 recovery runs cloud-legal end to end"
```

---

### Task 7: Local-lane e2e — the real daemon-death self-heal path end to end

**Files:**
- Create: `test/e2e-browser/specs/freshopencode-daemon-death-selfheal.spec.ts`
- Modify: `test/e2e-browser/playwright.cloud.config.ts` (add the new spec to `CLOUD_SKIP_SPECS`, same provider-lifecycle-timing reason as `freshopencode-restart-recovery`)
- Test: itself (local chromium run)

**Interfaces:**
- Consumes: the `freshopencode-restart-recovery.spec.ts` harness pattern — `installFakeOpencode` (`fixtures/fake-opencode.cjs` on the spawned server's PATH), the `RustServer` + `TestHarness` helpers, the fake's `FAKE_OPENCODE_AUDIT_LOG` JSONL for spawn/event assertions, and a fixture capability to make the fake daemon process DIE on demand (reuse the model spec's daemon restart/death mechanics if present; otherwise add a minimal scripted-exit verb to the fixture — e.g. an env-armed exit or a served `/__kill` endpoint the spec hits).
- Produces: an e2e proof of the SERVER-side self-heal chain with a real spawned server and a fake daemon process: (1) the pane is materialized and live; (2) the daemon dies an UNREQUESTED death; (3) the pane shows the `OPENCODE_DAEMON_LOST` "Agent error:" banner; (4) the daemon respawns automatically within a bounded wait (audit log shows a second serve spawn); (5) the pane recovers (the idle snapshot push refetches the transcript; the banner is dismissible and no dead-end remains); (6) NO `freshAgent.turn.complete` chime during the window.

- [ ] **Step 1: Write the spec** (verification task; Tasks 3+4 turned the chain green — their Rust unit tests carry the TDD red history for this behavior)

Follow the restart-recovery spec's structure (fake CLI on PATH, harness-seeded freshopencode pane with a durable `ses_*` id, deterministic waits on harness state — never wall-clock-sensitive provider-boot timing).

- [ ] **Step 2: Run it locally**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/freshopencode-daemon-death-selfheal.spec.ts`

Expected: PASS

- [ ] **Step 3: Register the cloud-skip honestly**

Add the filename to `CLOUD_SKIP_SPECS` (the spec is the same provider-lifecycle class as its model — 2-CPU/2-worker cloud contention cannot guarantee daemon-death timing). Cloud-backend PR coverage is carried by Task 6's cloud-legal spec; this spec is the local-lane end-to-end proof.

- [ ] **Step 4: Commit the task**

```bash
git add test/e2e-browser/specs/freshopencode-daemon-death-selfheal.spec.ts test/e2e-browser/playwright.cloud.config.ts
git commit -m "test(e2e): real-daemon death self-heal recovery runs end to end (local lane)"
```

---

### Task 8: Whole-branch verification gates

**Files:** none (verification only — the plan declares these gates, so the plan must run them; the-usual's Stage-5 exit additionally runs the coordinated full suite once at the final HEAD after the review loop closes)

- [ ] **Step 1: Rust formatting and lints**

Run: `cargo fmt --all --check && cargo clippy --workspace --exclude freshell-tauri --all-targets -- -D warnings`

Expected: PASS (clean)

- [ ] **Step 2: Client typecheck and lints**

Run: `npm run typecheck && npm run lint`

Expected: PASS (clean; eslint includes the jsx-a11y rules)

- [ ] **Step 3: Focused suite confirmation**

Run: `cargo test -p freshell-opencode && cargo test -p freshell-freshagent && npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/fresh-agent-ws.test.ts`

Expected: PASS (all tasks' focused suites green together on the final HEAD)

- [ ] **Step 4: Record**

No commit (verification only). Record the gate results in the run state; the coordinated full-suite gate at final HEAD runs per the-usual Stage 5 after the delta review loop ends.

---

## Plan self-review (re-run after Stage-2 load-bearing corrections AND plan-review round 1)

1. **Spec coverage:** defect 1 → Tasks 1 (compact/config no-kill, FR2 mirror); defect 2 → Task 2 (structured discard log); defect 3 → Tasks 3+4 (exit watcher + loss signal + retrying backoff re-warm + runtime fan-out edge + level-triggered bridge revival — the freshcodex-onExit mirror adapted to shared-daemon topology); defect 4 → Tasks 4a+5+6 (the fenced attach made a real recovery verb by respawning the daemon on map-hits, the client 409 arm driving it once, cloud-legal e2e). E2E coverage: Task 6 (cloud-legal client recovery) + Task 7 (local-lane real-daemon self-heal chain) + Rust unit tests (server lanes). Gates: Task 8 runs fmt/clippy/typecheck/lint + the focused suites on the final HEAD; the coordinated full suite runs at the-usual Stage-5 exit. The "backoff-guarded respawn" and "client-visible status edge" elements of defect 3 are both explicit (Task 3 re-warm config + retry loop; Task 4 `OPENCODE_DAEMON_LOST` edge).
2. **No silent deferrals:** the deliberate residuals (prompt_async and thin wrappers keep `DiscardOnTimeout::Yes`; frozen 409 text; terminal-owner 409s recover via the session-directory handoff door; REST-only never-viewed panes miss the banner until first WS interaction) are stated in Global Constraints, each with its reason and precedent. The real-daemon e2e is local-lane with an honest CLOUD_SKIP_SPECS entry (cloud PR coverage carried by Task 6).
3. **File and interface consistency:** all paths/signatures cross-checked against the six exploration reports at base 855dae72a, then corrected against the load-bearing ledger (LB-01 map lock order, LB-02 no-replay → level-triggered revival + arming pass, LB-03 bounded recovery, LB-04 reveal-trigger refetch, LB-05 attach-respawn redesign + fresh-agent-owner scoping, LB-06 Arc process + ownership_id, LB-07 exactly-once take, LB-08 Lagged tolerance, LB-09 attach-count delta, LB-10 state clone, R-1 `captureFreshAgentAttachmentAttempt`, N-3 `ensure_manager` seam) AND plan-review round 1 (routed `get_config(route)`, retrying re-warm with a fail-then-succeed test, single-filter cargo commands, deferred-rejection + awaited-banner client tests, dual-key dedupe, Tasks 7/8).
4. **Executable tests:** each red test names its exact lane failure (killed counter, missing frame, missing spawn, missing attach) and reuses pinned fake/harness idioms (NeverExitsProcess kill counters, config_capture tracing capture, state_with_bus + set_manager_for_test, the 404 ApiError-mock template with delta-based attach counting and an explicit synchronization point). Every cargo invocation uses a single positional TESTNAME filter that matches the named tests.
5. **Placeholder scan:** drafts reference real helpers; where a fake needs a small extension (ExitingProcess, summarize/config hang scripting, fail-twice-then-healthy scripting, the fake-opencode death verb), the extension is named and its model (existing fakes) is cited — no TBDs.
6. **Operational completeness:** new structured event names are logged (Task 3/4) and registered in the logging docs if enumerated; AGENTS.md architecture prose updated (Task 4); no migrations; rollback = revert the commits (no persisted-state changes); verification gates explicit (Task 8 + the Stage-5 full suite).

UNRESOLVED COVERAGE GAP: none. The original soft spot was resolved in Stage 2 (R-1), and the one falsified assumption (LB-05) reshaped Tasks 4+5 — the fenced attach now respawns the daemon (map-hit), and the client recovery is scoped to the fresh-agent-owner class the incident actually was.
