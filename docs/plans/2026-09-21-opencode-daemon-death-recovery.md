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
  - `cargo test -p freshell-freshagent lib::tests`
  - `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  - `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/<spec>.ts`
- Broad/coordinated runs (`npm test`, `test:server` zero-arg, `test:integration` zero-arg) go through the shared coordinator; wait for a free gate, never kill a foreign holder.

### Deliberate residuals (documented, out of scope)

- `prompt_async` (the send-turn POST) and the thin `json_request` wrappers (`get_session`, `list_messages`, `get_session_status_map`, `abort`, `fork`, `revert`, `unrevert`) KEEP `DiscardOnTimeout::Yes`. Rationale: they are the deliberate wedged-daemon recycler for writes (FR2 kept Yes for writes on purpose), and the incident class was compact-specific (an LLM-scale budget routinely exceeded by a healthy-but-busy daemon). A wedged-alive daemon is also caught by the new exit-watcher only if it exits; a hung-but-alive daemon remains the send-lane's recycle responsibility. Revisit only with a dedicated wedged-detection design.
- The frozen 409 message text stays (even when the Live owner's daemon is dead, the text says "still running on the server" — clients' muscle memory depends on it). The new `OPENCODE_DAEMON_LOST` runtime edge is what tells the user the truth.
- E2E daemon-death/respawn coverage against a real spawned daemon is the cloud-skipped provider-lifecycle class (see `CLOUD_SKIP_SPECS`: `freshopencode-restart-recovery` et al.). This run adds cloud-legal e2e for the client recovery lane (Task 6) and covers the server lanes with the Rust unit tests (the same coverage strategy the freshcodex self-heal uses).

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

Run: `cargo test -p freshell-opencode compact_timeout_does_not_kill get_config_timeout_does_not`

Expected: FAIL — `compact_timeout_does_not_kill_the_shared_daemon` fails with `killed: 1` (the discard-on-timeout arm killed the process) and/or `base_url()` is `None`; `get_config_timeout_does_not_kill_the_shared_daemon` fails the same way.

- [ ] **Step 3: Add the minimal production implementation**

In `crates/freshell-opencode/src/serve.rs`:

```rust
/// `getConfig` for the compact drive's model-pair resolution (and the model
/// catalog lanes). A slow config read must never kill the shared daemon —
/// the FR2 read rule (b8ke): capture the base once (spawn-on-demand is fine),
/// then transport over the captured base with `DiscardOnTimeout::No`.
pub async fn get_config(&self) -> Result<Value, ServeError> {
    let base = self.require_base().await?;
    self.json_request_over_base(
        HttpMethod::Get, "/config", None, None,
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

Run: `cargo test -p freshell-opencode compact_timeout_does_not_kill get_config_timeout_does_not`

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
  - `OpencodeServeManager::subscribe_daemon_signals(&self) -> tokio::sync::broadcast::Receiver<DaemonSignal>` (capacity 16)
  - `ServeConfig` gains: `daemon_watch_interval: Duration` (default 1000 ms), `re_warm_backoff_initial_ms: u64` (default 2000), `re_warm_backoff_max_ms: u64` (default 60_000).
  - Semantics: `Started` is broadcast on every successful cold start (not on fast-path returns of an already-running daemon); `Lost{reason}` on discard (`"request_timeout"` today) and on unrequested process exit (`"process_exit"`).

**Behavior:**
1. `ensure_started` spawns a daemon exit-watcher task after a successful health check (store its abort handle on `RunningServe` as `_exit_watch`). The watcher polls `process.exited()` every `daemon_watch_interval`; on `Some(exit)` it verifies the running entry is still ITS daemon (compare the captured `ownership_id`), then runs the manager's loss path.
2. The loss path (shared by watcher-exit and, minus the abort, by `discard_running`): WARN `freshagent.opencode.daemon_crash_detected` (watcher arm; fields `reason="process_exit"`, `base_url`) or the Task-2 discard WARN; take the running entry (killing it in the watcher arm is unnecessary — the process already exited; still call `process.kill()` for the /proc ownership reaper parity); `emit_lost_for_all()`; broadcast `DaemonSignal::Lost{reason}`; schedule a backoff-guarded re-warm.
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

In serve.rs (sketch — the implementer adapts to the actual Inner/ensure_started structure):

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DaemonSignal { Lost { reason: &'static str }, Started }

// Inner gains:
//   daemon_signals: tokio::sync::broadcast::Sender<DaemonSignal>,  (capacity 16, on construction)
//   re_warm_attempts: std::sync::atomic::AtomicUsize,
// RunningServe gains:
//   _exit_watch: Option<tokio::task::AbortHandle>,

// ensure_started, after storing RunningServe (the cold-start success path):
let watch = self.spawn_exit_watch(base_url.clone(), process_handle_for_watch, ownership_id.clone());
running._exit_watch = watch;
let _ = self.inner.daemon_signals.send(DaemonSignal::Started);

fn spawn_exit_watch(self: &Arc<Inner>, base_url: String, process: Box<dyn ServeProcess>, ownership_id: String) -> Option<AbortHandle> {
    let manager = self.manager_clone(); // however the crate threads weak self (mirror make_dispatch_sink's weak-Inner pattern, serve.rs:836-843)
    let interval = ...config.daemon_watch_interval...;
    let handle = tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            if let Some(_code) = process.exited() {
                manager.handle_unrequested_exit(&base_url, &ownership_id).await;
                return;
            }
        }
    });
    Some(handle.abort_handle())
}

// handle_unrequested_exit: guard stale watchers (compare ownership_id against
// the current running entry), WARN freshagent.opencode.daemon_crash_detected,
// take the entry (kill for reaper parity), emit_lost_for_all, send
// DaemonSignal::Lost{reason:"process_exit"}, schedule_re_warm().

// discard_running: abort the watcher (running._exit_watch), Task-2 WARN, kill,
// emit_lost_for_all, send Lost{reason}, schedule_re_warm().

fn schedule_re_warm(&self) {
    if self.inner.shutdown.load(Ordering::SeqCst) { return; }
    let attempts = self.inner.re_warm_attempts.fetch_add(1, Ordering::SeqCst) + 1;
    let delay_ms = (self.config().re_warm_backoff_initial_ms.saturating_mul(1 << (attempts-1).min(16)))
        .min(self.config().re_warm_backoff_max_ms);
    let manager = self.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
        if manager.inner.shutdown.load(Ordering::SeqCst) { return; }
        match manager.ensure_started().await {
            Ok(_) => tracing::info!(attempt = attempts, "freshagent.opencode.daemon_re_warm"),
            Err(err) => tracing::warn!(attempt = attempts, error = %err, "freshagent.opencode.daemon_re_warm"),
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

Run: `cargo test -p freshell-opencode && cargo test -p freshell-freshagent opencode_ws::tests && cargo test -p freshell-freshagent lib::tests`

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
- Consumes: Task 3's `subscribe_daemon_signals()` / `DaemonSignal`; `event_frame`/`emit_fresh_agent_error` (opencode_ws.rs:6068/686), `spawn_serve_bridge` (opencode_ws.rs:5971), `FreshAgentState.broadcast_tx` (lib.rs:1917), `set_manager_for_test` (lib.rs:2837).
- Produces: a per-materialized-session typed edge on daemon loss: `freshAgent.event{provider:"opencode", sessionType:"freshopencode", event:{type:"freshAgent.error", code:"OPENCODE_DAEMON_LOST", message:"The opencode serve daemon was lost unexpectedly - it is restarting automatically."}}` — folds client-side through the EXISTING generic `sessionError` path (fresh-agent-ws.ts:514-520), showing the dismissible "Agent error:" banner and clearing busy. After a successful respawn: dead serve bridges restart and each materialized session gets `freshAgent.session.snapshot{status:"idle"}` (which the client treats as snapshot-invalidating → transcript refetch). No chime: the recovery must never emit `freshAgent.turn.complete`.

- [ ] **Step 1: Write the failing behavioral test**

In `opencode_ws.rs` tests (draft; mirror `onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped` at codex.rs:15846-15896 and the `state_with_bus` harness at codex.rs:9983-9991 — the opencode tests already have the bus pattern + `set_manager_for_test`):

```rust
// 2026-09-20 incident: the shared daemon died and NOTHING told the panes —
// no status edge, no respawn, no bridge revival; panes dead-ended on the
// snapshot 409. The runtime self-heal must make daemon loss observable and
// recoverable per session.
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
    exiting.store(false, Ordering::SeqCst); // the re-warm's respawn now succeeds
    let frame = next_fresh_agent_frame(&rx).await;
    assert_eq!(frame["event"]["type"], "freshAgent.session.snapshot");
    assert_eq!(frame["event"]["status"], "idle");
    assert!(session_serve_bridge_alive(&state, "ses_recover").await, "bridge restarted after respawn");
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent daemon_loss_fans_out`

Expected: FAIL — no `OPENCODE_DAEMON_LOST` frame is broadcast (today `SessionSignal::Lost` is a no-op at opencode_ws.rs:6018; no listener exists).

- [ ] **Step 3: Add the minimal production implementation**

In `opencode_ws.rs` (sketch):

```rust
// FreshOpencodeState gains: daemon_loss_watcher: Arc<OnceCell<()>> (or AtomicBool)
// and this idempotent starter, called at the top of handle_send, handle_attach,
// and handle_compact:
fn ensure_daemon_loss_watcher(&self) {
    if self.daemon_loss_watcher.set(()).is_err() { return; } // already running
    let Ok(manager) = ... self.fresh_agent.peek_or_ensure_manager() ... else { reset the guard and return; };
    let sessions = Arc::clone(&self.sessions);
    let broadcast_tx = Arc::clone(&self.fresh_agent.broadcast_tx);
    let mut signals = manager.subscribe_daemon_signals();
    tokio::spawn(async move {
        loop {
            let Ok(signal) = signals.recv().await else { return };
            match signal {
                DaemonSignal::Lost { reason } => {
                    tracing::warn!(reason = reason, "freshagent.opencode.daemon_loss_observed");
                    let materialized: Vec<String> = sessions.lock().await.values()
                        .filter_map(|s| s.lock().await.real_session_id.clone()).collect();
                    for id in materialized {
                        let _ = broadcast_tx.send(event_frame_json(&id, json!({
                            "type": "freshAgent.error", "sessionId": id,
                            "code": "OPENCODE_DAEMON_LOST",
                            "message": "The opencode serve daemon was lost unexpectedly - it is restarting automatically.",
                        })));
                    }
                }
                DaemonSignal::Started => {
                    // Restart dead bridges for materialized sessions and push
                    // an idle snapshot edge (client refetches the transcript).
                    ...for each materialized session: if bridge handle is_finished/absent -> spawn_serve_bridge(...); send snapshot_event(id, "idle")...
                }
            }
        }
    });
}
```

(Adapt to the actual locking model of `sessions` (a `TokioMutex<HashMap<String, Arc<TokioMutex<OpencodeSession>>>>`) and the real `spawn_serve_bridge` signature — it is an async method on `FreshOpencodeState`; if it cannot be called from a free task, factor the bridge-restart body (the same logic as handle_attach's restart arm at opencode_ws.rs:5460-5473) into a standalone async helper both call. Track "Started after Lost" via a local `saw_loss` bool so normal cold starts emit nothing.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent daemon_loss_fans_out`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Ensure the fan-out + bridge-revival helper is shared (not duplicated) with `handle_attach`'s restart arm; keep AGENTS.md's "Agent Status Indicators" paragraph truthful — update the freshopencode sentence to document the daemon-loss self-heal (edge shape, no chime, backoff respawn, bridge revival, and the fix-4 client recovery pointer).

- [ ] **Step 6: Run impacted-test verification**

Impacted set: all `opencode_ws::tests` (119 tests), `lib::tests` snapshot pins, plus the whole `freshell-freshagent` unit suite.

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
- Consumes: `ApiError.details` (the full 409 body: `code`, `ownerKind`, `ownerGeneration`), `captureAttachmentAttempt` (FreshAgentView.tsx:403-412), `sendFencedFreshAgentAttach` (:1262-1275), `requestSnapshotRefresh` / `requestRevealRefresh`, `selectPaneOwnerFence`.
- Produces: on a 409 `RESTORE_UNAVAILABLE` snapshot error for a freshopencode pane: ONE generation-fenced `freshAgent.attach` (via a fresh attachment decision — bump `attachDecisionSerialRef`, capture, send) followed by a snapshot refetch. Bounded: once per pane identity (`createRequestId` + `snapshotThreadId`); a second 409 falls through to the existing error surfaces (loadError banner / reveal error), no loop. The pane identity is NOT reset (unlike the 404 lost-thread path).

- [ ] **Step 1: Write the failing behavioral test**

In FreshAgentView.test.tsx (draft — template is the 404 test at :1887-1930; reuse its harness: `apiMock.getFreshAgentThreadSnapshot.mockRejectedValueOnce`, `StoreBackedFreshAgentView`, `sentFreshAgentMessages`):

```ts
// 2026-09-20 incident: the daemon died, the reveal GET answered the typed
// 409 RESTORE_UNAVAILABLE, and the pane dead-ended on a dismiss-only banner
// forever ("Session ... is still running on the server."). The documented
// recovery is the generation-fenced attach + refetch — drive it once.
it('recovers a freshopencode pane from a snapshot 409 with one fenced attach and a refetch', async () => {
  apiMock.getFreshAgentThreadSnapshot
    .mockRejectedValueOnce({
      status: 409,
      message: 'Session ses_live is still running on the server.',
      details: { code: 'RESTORE_UNAVAILABLE', ownerKind: 'terminal', ownerGeneration: 2 },
    })
    .mockResolvedValue(freshopencodeSnapshot({ sessionId: 'ses_live', status: 'idle' })) // the refetch succeeds
  renderFreshAgentPane({ provider: 'opencode', sessionId: 'ses_live', status: 'connected' })
  await waitFor(() => {
    expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(1)
  })
  await waitFor(() => {
    expect(apiMock.getFreshAgentThreadSnapshot).toHaveBeenCalledTimes(2) // the refetch
  })
  // The pane kept its identity (the 409 is NOT the 404 lost-thread reset):
  expect(getFreshAgentPaneContent(store).sessionId).toBe('ses_live')
  // And no dead-end banner for the recovered pane:
  await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument())
})

it('does not loop attach attempts on repeated 409s', async () => {
  apiMock.getFreshAgentThreadSnapshot.mockRejectedValue({
    status: 409, message: 'Session ses_live is still running on the server.',
    details: { code: 'RESTORE_UNAVAILABLE', ownerKind: 'terminal', ownerGeneration: 2 },
  })
  renderFreshAgentPane({ provider: 'opencode', sessionId: 'ses_live', status: 'connected' })
  await waitFor(() => expect(screen.findByText(/still running on the server/i)).toBeTruthy())
  expect(sentFreshAgentMessages('freshAgent.attach')).toHaveLength(1) // once, not per fetch
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
  return status === 409 && code === 'RESTORE_UNAVAILABLE'
}
```

In `handleSnapshotError`, after the opencode lost-404 arm and BEFORE the reveal arm — provider-gated to `opencode`:

```ts
// 2026-09-20 incident: with the daemon dead, daemon-absent snapshot GETs
// answer the typed 409 RESTORE_UNAVAILABLE for as long as the session key
// stays Live. The documented recovery is the generation-fenced attach
// (b8ke Task-5: cold resume flows only through the explicit lifecycle
// commands) — drive it ONCE per pane identity, then refetch. Repeated 409s
// fall through to the honest error surfaces below; never reset the pane.
if (paneContent.provider === 'opencode' && isRestoreUnavailableSnapshotError(error)) {
  const fresh = paneContentRef.current
  const recoveryKey = `${fresh.createRequestId}:${sessionId}`
  if (restoreUnavailableRecoveryRef.current !== recoveryKey) {
    restoreUnavailableRecoveryRef.current = recoveryKey
    attachDecisionSerialRef.current += 1
    const attempt = captureAttachmentAttempt('restore-unavailable-recovery')
    sendFencedFreshAgentAttach(attempt)
  }
  if (trigger === 'reveal' && snapshotDirtyRef.current) {
    revealRefreshStartedAtRef.current = null
    setSnapshotRevealError(null) // recovery in flight; don't dead-end the reveal lane
  }
  setLoadError(null)
  requestSnapshotRefresh('manual') // refetch once the attach lands
  return
}
```

(Adapt: `captureAttachmentAttempt`'s real signature at :403-412; the ref `restoreUnavailableRecoveryRef = useRef<string | null>(null)` beside the other reveal refs ~:800-804. The `trigger === 'reveal'` branch must still let the reveal-dirty state clear on the NEXT successful fetch — verify against the reveal-refresh state machine at :2601-2624; if clearing `snapshotRevealError` alone is insufficient, keep the reveal arm's bookkeeping and skip its error assignment while recovery is in flight.)

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
  // 1. Suppress the opencode sidecar (model-picker pattern).
  // 2. Route /api/fresh-agent/threads/freshopencode/opencode/:id:
  //    first call -> fulfill(409, { status:'error', code:'RESTORE_UNAVAILABLE',
  //      message:'Session <id> is still running on the server.',
  //      ownerKind:'terminal', ownerGeneration:2 })
  //    subsequent -> fulfill(200, <a minimal valid FreshAgentSnapshot>)
  // 3. Seed a freshopencode pane with a durable ses_* session (harness).
  // 4. Assert: a freshAgent.attach frame is sent (harness ws capture),
  //    the transcript renders from the 200 snapshot, and no dismiss-only
  //    dead-end alert remains.
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

## Plan self-review (completed before commit)

1. **Spec coverage:** defect 1 → Tasks 1 (compact/config no-kill, FR2 mirror); defect 2 → Task 2 (structured discard log); defect 3 → Tasks 3+4 (exit watcher + loss signal + backoff re-warm + runtime fan-out edge + bridge revival — the freshcodex-onExit mirror adapted to shared-daemon topology); defect 4 → Tasks 5+6 (client fenced-attach recovery + refetch, cloud-legal e2e). The "backoff-guarded respawn" and "client-visible status edge" elements of defect 3 are both explicit (Task 3 re-warm config; Task 4 `OPENCODE_DAEMON_LOST` edge).
2. **No silent deferrals:** the deliberate residuals (prompt_async and thin wrappers keep `DiscardOnTimeout::Yes`; frozen 409 text; cloud-skipped real-daemon-lifecycle e2e class) are stated in Global Constraints, each with its reason and precedent.
3. **File and interface consistency:** all paths/signatures cross-checked against the six exploration reports (`serve-lane-mechanics.md`, `runtime-compact-events.md`, `codex-selfheal-precedent.md`, `client-409-recovery.md`, `server-snapshot-409.md`, `testing-conventions.md`) at base 855dae72a.
4. **Executable tests:** each red test names its exact lane failure (killed counter, missing frame, missing attach) and reuses pinned fake/harness idioms (NeverExitsProcess kill counters, config_capture tracing capture, state_with_bus + set_manager_for_test, the 404 ApiError-mock template).
5. **Placeholder scan:** drafts reference real helpers; where a fake needs a small extension (ExitingProcess, summarize/config hang scripting), the extension is named and its model (existing fakes) is cited — no TBDs.
6. **Operational completeness:** new structured event names are logged (Task 3/4) and registered in the logging docs if enumerated; AGENTS.md architecture prose updated (Task 4); no migrations; rollback = revert the commits (no persisted-state changes).

UNRESOLVED COVERAGE GAP: none known. The one soft spot — whether `captureAttachmentAttempt`'s real signature supports the Task-5 recovery arm without a wrapper — is a load-bearing assumption carried to Stage 2 for validation before execution.
