# Graceful Restore/Resume — Slice 1 Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Restore-class terminal creates never die from anticipatable contention — codex sidecar planning moves OUTSIDE the spawn-gate permit, and restore-class plans queue cancel-aware on the planning budget instead of failing fast at 30s — with zero protocol changes (the frozen client sees strictly fewer error frames).

**Architecture:** Two pillars from the design spec (`docs/plans/2026-07-30-graceful-restore-resume.md`, the authoritative spec — P1 and P2 of §4). P1: extract launch preparation (resume-session-id derivation + `plan_codex_managed_launch`) from `handle_create` and run it in `spawn_gated_restore_create` BEFORE `spawn_gate.acquire`, so permits cover only fast, mode-uniform PTY-spawn→settle work; a prepared-but-unadopted sidecar is held in an RAII guard so EVERY early-exit path discards it by construction. P2: `LaunchClass::{Interactive, Restore}` on the codex plan budget — `Restore` waits cancel-aware with no wall-clock death (bounded structurally by queue depth × per-plan budget — honest numbers, per V3: worst-case per-plan hold ≈251s (5 attempts × (45s probe budget + 5s teardown) + 1s retry sleeps), so a full 64-deep queue drains worst-case in ~2.2h; this bound is REAL only with Task 1's per-probe timeout fix; overflow → `RATE_LIMITED`, which the frozen client's retry ladder absorbs), `Interactive` keeps today's 2-concurrent/30s fail-fast byte-identically. The restore-class spawn-gate wait also becomes cancel-aware-unbounded (`acquire_unbounded`). Slices 2–4 (progress protocol, hub retry, DEVIATIONS.md records) are explicitly OUT of scope.

**Tech Stack:** Rust (tokio, axum, tokio-tungstenite for tests), crates `freshell-codex`, `freshell-ws`, `freshell-freshagent`.

## Global Constraints

- **Slice 1 ONLY** — server-only, ZERO protocol changes: no new frames, no new fields, no client/TS changes. Do NOT build Slice 2 (progress protocol/client UX), Slice 3 (auto-resume hub retry), or Slice 4 (DEVIATIONS.md records / e2e storm phase in `codex_managed_launch_e2e.rs`).
- Interactive WS creates, REST `/api/tabs` creates, and the auto-resume hub respawn keep **byte-identical behavior** (`LaunchClass::Interactive`, same timeouts, same error surfaces).
- Plan concurrency stays exactly **2** (`CODEX_SIDECAR_PLAN_CONCURRENCY: usize = 2` — serialization is the point; do not raise it).
- Plan queue cap: default **64**, env knob **`FRESHELL_CODEX_PLAN_QUEUE_CAP`** with the `env_parse` fallback semantics pinned by `crates/freshell-ws/src/create_limit.rs:173-240`: `0` → default, non-numeric → default.
- Rust toolchain pinned **1.96.0** (`.github/workflows/rust-clippy.yml`). Gates: `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings`; `cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings`; full `cargo test --workspace` locally.
- Known pre-existing flake, NOT ours to fix: `pane_ledger::tests::new_locked_degrades_to_disabled_when_another_holder_exists` in the `freshell-ws` **lib** target flakes ~1/10 under load (kata f3wp → escalated as s52d, `docs/plans/2026-07-27-deflake-load-flakes.md`). If a full-workspace run fails ONLY there, re-run that lib test in isolation and do not attribute it to this work.
- All work stays in the worktree `/home/dan/code/freshell/.worktrees/graceful-restore-resume-s1` on its branch; **never touch the main checkout**; leave the branch **unmerged**.
- Test servers bind ephemeral loopback ports only — NEVER 3001/3002; never use broad kill patterns (`pkill -f node` etc.).
- Broad repo-supported test runs wait for the shared coordinator gate (`AGENTS.md:28-31`); use `npm run test:status` to inspect holders.
- **Environment precondition (node deps — required for EVERY `freshell-ws` test gate):** `handle_create` runs `generate_mcp_injection` unconditionally for every non-shell mode (`terminal.rs:2043-2063`), and the codex arm requires `<worktree_root>/node_modules/tsx/dist/loader.mjs` (`mcp_inject.rs:123-128`; `find_repo_root` at `:146-164` walks up from cwd to the FIRST `package.json` with `name == "freshell"` — the worktree's own root — so the main checkout's `node_modules` is never reached). No env var, settings field, or test seam bypasses injection; without installed deps every codex-mode create dies with `PTY_SPAWN_FAILED "Unable to resolve MCP dependency \"tsx\""`. Before the FIRST gate that runs any `freshell-ws` integration test (Task 3 Step 1 and everything after), run in the worktree root: `test -f node_modules/tsx/dist/loader.mjs || npm ci --no-audit --no-fund`. This is the repo's sanctioned fix (precedent: `docs/plans/2026-07-24-rust-attach-viewport.md:26`, `docs/plans/2026-07-29-rebind-review-polish.md:1207-1210`); do not chase tsx-resolution failures in Rust code.
- README.md untouched; the only doc edits are this plan's own file and the §D-C addendum to `docs/plans/2026-07-27-rest-spawn-gate.md` (Task 6).
- Task 4's commit message MUST cite **D-GATE-SOFT** (spec §9.1 obligation).
- **Accepted residual (A5, V3):** permit-held awaits (PTY spawn, association fs walk, fsync ledger writes) are deadline-free, so a correlated fs hang (the gate's founding WSL RCA) now parks restores silently where today they died loud at 10s; S1 compensates with warn-level tracing (periodic parked-waiter logs + a slow-hold watchdog — Task 4), NOT with new frames/fields. Disconnect-cancel remains the client escape.
- Line numbers cited below were verified against worktree HEAD `39010cb57` on 2026-07-30; if a file drifted, locate the cited code by its quoted text, not the number.

---

## File Structure

| File | Change | Responsibility after this slice |
|---|---|---|
| `crates/freshell-codex/src/launch_lifecycle.rs` | Modify | `LaunchClass`, `CodexLaunchError::{QueueFull,Cancelled}`, restore-class queue on `CodexTerminalLaunchManager` (cap + cancel-aware wait), `discard_sync`, global-manager test installer, rewritten D-C-REVISIT comment |
| `crates/freshell-codex/src/launch_plan.rs` | Modify | One-clause comment amendment on `FRESHELL_CODEX_MANAGED_LAUNCH_ENV` (D-C-REVISIT supersession pointer) |
| `crates/freshell-codex/tests/launch_lifecycle.rs` | Modify | Updated call sites; new restore-class budget tests (drain/cancel/cap) + `discard_sync` test |
| `crates/freshell-codex/tests/global_manager_install.rs` | Create | Installer pin (own process/binary) |
| `crates/freshell-freshagent/src/spawn_gate.rs` | Modify | New `acquire_unbounded` (cancel-aware, no timeout) + unit tests + module-doc amendment |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify | `LaunchClass::Interactive` at the REST plan call (one-liner), new `codex_launch_error_response` arms, D-C-REVISIT comment update |
| `crates/freshell-ws/src/terminal.rs` | Modify | `derive_launch_prep` extraction (pure rungs only — the claude P0.4 ladder stays in `handle_create` post-adopt/attach, A12); `prepare_launch` + `PreparedLaunch` + `PreparedCodexLaunch` guard + `PrepareError`; `handle_create` gains `prepared: Option<PreparedLaunch>`; `plan_codex_managed_launch` gains class/cancel + typed error |
| `crates/freshell-ws/src/create_gate.rs` | Modify | Prepare-before-acquire; restore-class unbounded gate wait; rewritten "nothing has been materialized" comment |
| `crates/freshell-ws/src/create_limit.rs` | Modify | Doc-comment amendment (timeout bound now interactive/REST/auto-resume only) |
| `crates/freshell-ws/tests/restore_spawn_gate.rs` | Modify | Rewrite restore-path gate-timeout pins to timeout-free mechanisms (gate `Timeout` is unreachable for the restore class after this slice) — V5 §A13 |
| `crates/freshell-ws/tests/create_protection.rs` | Modify | Rewrite restore-path gate-timeout pin to a timeout-free mechanism (gate `Timeout` is unreachable for the restore class after this slice) — V5 §A13 |
| `crates/freshell-ws/tests/rest_ws_shared_gate.rs` | Modify | Rewrite restore-path gate-timeout pin to a timeout-free mechanism (gate `Timeout` is unreachable for the restore class after this slice) — V5 §A13 |
| `crates/freshell-ws/tests/restore_storm.rs` | Create | The §8 restore-storm integration pins (mandate test) |
| `crates/freshell-ws/tests/restore_plan_queue_cap.rs` | Create | Plan-queue overflow → `RATE_LIMITED` WS pin (needs its own process for the global installer) |
| `docs/plans/2026-07-27-rest-spawn-gate.md` | Modify | §D-C ADDENDUM 2 discharging the recorded residual |

Decisions locked in (so all tasks agree):

- `LaunchClass` lives in `launch_lifecycle.rs` (all production callers already import that module; it is compiled into `freshell-ws`/`freshell-freshagent` via the `real-transport` feature they already enable).
- The cancel token type everywhere is `tokio::sync::watch::Receiver<bool>` (the repo-wide convention; nothing uses `CancellationToken`).
- The plan queue cap applies to the **Restore class only**. Interactive keeps today's exact semantics (timeout → `Failed("codex sidecar planning budget exhausted…")`), so no interactive surface changes.
- The auto-resume hub respawn door (`respawn_agent_terminal`, `terminal.rs:2687`) stays `LaunchClass::Interactive`: it has no cancel signal (deliberately `acquire_uncancellable`), so Restore-class-with-no-timeout would wait forever; its retry semantics belong to Slice 3. Behavior unchanged.
- Discard of a prepared-but-unadopted sidecar is enforced by an RAII guard (`PreparedCodexLaunch`) + a sync `discard_sync` seam, not by hand-enumerating early-exit arms. This is deliberately STRONGER than spec §4 P1's "small, enumerable set of 4 early returns": once planning happens before the gate, `handle_create`'s own pre-plan early returns (keyed-create adopt `terminal.rs:1461`, D8 lease arms `:1528/:1531/:1548`, unknown-mode `:1600`, D7 guard rejections, opencode port `:1996`) ALSO hold a live sidecar, and Drop-based discard covers every one of them by construction. `discard_sync` is `Handle::try_current()`-guarded (A8): spawn when a runtime handle exists, best-effort sync kill / log-and-leak otherwise — a Drop impl may NEVER panic.
- The pre-gate hoist is NARROW (A12, V6): `prepare_launch`/`derive_launch_prep` cover ONLY the mode-generic pure create-body reads and the codex rung (`terminal.rs:1679-1682`) + codex planning. The claude P0.4 ladder (`is_canonical_claude_session_id` gate + `resolve_claude_restore_session_id` + the `RESTORE_UNAVAILABLE` reject, `terminal.rs:1690-1720`) STAYS in `handle_create` at its original position — after the keyed-create adopt (`:1443-1461`) and the D8 lease/attach arms (`:1484-1558`) — because it reads mutable liveness state whose meaning depends on those arms having run first; hoisted, a duplicate claude restore in the two-connection reconcile race gets a loud "[Restore failed]" instead of adopting the winner, violating "strictly fewer error frames". Consequence: `derive_launch_prep` is infallible and `PrepareError` has no `Reject` variant.
- Fresh-plan codex restores are EXCLUDED from pre-gate planning (A4, V2): `prepare_launch` constructs a `PreparedCodexLaunch` only when `resume_session_id.is_some()`. A fresh plan arms a 45s candidate-capture timer AT PROXY START (`remote_proxy.rs:248-258`); parked past 45s on the unbounded gate wait, the identity gate permanently fails and post-adopt turn/start is rejected -32000. So a `restore:true` codex create with no sessionRef/resumeSessionId keeps today's exact on-permit inline planning path (`LaunchClass::Interactive`), byte-identical to today. `PreparedLaunch.codex_launch` is therefore `Option<PreparedCodexLaunch>`.

---

### Task 1: Restore-class plan budget — `LaunchClass`, queue-not-die, queue cap

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (error enum `:102-121`; D-C-REVISIT block + constants `:453-458`; manager struct/ctors `:460-504`; budgeted `plan_create_with_retry` `:506-530`; `ensure_ready` probe loop `:788-810` — the A6 per-probe timeout fix)
- Modify: `crates/freshell-codex/src/launch_plan.rs:48-56` (comment clause)
- Modify: `crates/freshell-ws/src/terminal.rs:1135-1142` (mechanical call-site update inside `plan_codex_managed_launch`)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`:590-599` error mapping; `:1287-1292` D-C-REVISIT comment; `:1313-1322` plan call)
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs`

**Interfaces:**
- Consumes: existing `CodexTerminalLaunchManager`, `CodexLaunchPlanInput`, `CodexRuntimeFactory`, `CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS`.
- Produces (later tasks rely on these exact names):
  - `pub enum LaunchClass { Interactive, Restore }` (derives `Debug, Clone, Copy, PartialEq, Eq`) in `freshell_codex::launch_lifecycle`.
  - `CodexLaunchError::QueueFull` and `CodexLaunchError::Cancelled` variants.
  - `pub async fn plan_create_with_retry(&self, input: &CodexLaunchPlanInput<'_>, attempts: u32, class: LaunchClass, cancel: &mut tokio::sync::watch::Receiver<bool>) -> Result<CodexTerminalLaunch, CodexLaunchError>` on `CodexTerminalLaunchManager`.
  - `pub async fn plan_create_with_retry_uncancellable(&self, input: &CodexLaunchPlanInput<'_>, attempts: u32, class: LaunchClass) -> Result<CodexTerminalLaunch, CodexLaunchError>`.
  - `pub fn with_plan_budget(runtime_factory: CodexRuntimeFactory, concurrency: usize, wait: Duration, queue_cap: usize) -> Self` (4th param added).
  - `pub fn plan_queue_depth(&self) -> usize`.
  - `pub const FRESHELL_CODEX_PLAN_QUEUE_CAP_ENV: &str = "FRESHELL_CODEX_PLAN_QUEUE_CAP";`

- [ ] **Step 1: Write the failing tests**

In `crates/freshell-codex/tests/launch_lifecycle.rs`, add (near the existing budget test at `:509`; reuse the file's existing `FakeRuntime`, `BlockingRuntime`, `blocking_test_runtime_factory` helpers):

```rust
/// Graceful restore/resume S1 (P2): a runtime that counts CONCURRENT
/// `ensure_ready` bodies and sleeps, so "max plan concurrency <= budget"
/// is observable without wall-clock racing. All trait methods other than
/// `ensure_ready` are copied from [`FakeRuntime`]'s impl (delegate to an
/// inner FakeRuntime started on demand, exactly like BlockingRuntime does).
struct CountingRuntime {
    in_flight: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    peak: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    plan_delay: std::time::Duration,
}

impl CodexLaunchRuntime for CountingRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> BoxFuture<'_, Result<CodexRuntimeReady, String>> {
        Box::pin(async move {
            use std::sync::atomic::Ordering;
            let now = self.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.peak.fetch_max(now, Ordering::SeqCst);
            tokio::time::sleep(self.plan_delay).await;
            self.in_flight.fetch_sub(1, Ordering::SeqCst);
            let inner = FakeRuntime::start().await;
            inner.ensure_ready(cwd).await
        })
    }
    // Copy the remaining CodexLaunchRuntime trait methods from the
    // BlockingRuntime impl in this same file (`tests/launch_lifecycle.rs:464+`)
    // verbatim — they are pass-through/no-op shapes.
}

/// The mandate's unit pin: 8 restore-class plans on a 2-permit budget with a
/// wait FAR smaller than the drain time — all 8 succeed (no wall-clock
/// death), and observed plan concurrency never exceeds 2.
#[tokio::test(flavor = "multi_thread")]
async fn eight_restore_class_plans_queue_and_drain_without_error() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let in_flight = std::sync::Arc::new(AtomicUsize::new(0));
    let peak = std::sync::Arc::new(AtomicUsize::new(0));
    let (rt_in, rt_peak) = (in_flight.clone(), peak.clone());
    let factory: freshell_codex::launch_lifecycle::CodexRuntimeFactory =
        Box::new(move || {
            std::sync::Arc::new(CountingRuntime {
                in_flight: rt_in.clone(),
                peak: rt_peak.clone(),
                plan_delay: std::time::Duration::from_millis(200),
            }) as std::sync::Arc<dyn CodexLaunchRuntime>
        });
    // wait = 200ms: 8 plans / 2 permits * 200ms = ~800ms of queueing.
    // Interactive would die; Restore must drain.
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            2,
            std::time::Duration::from_millis(200),
            64,
        ),
    );
    let mut handles = Vec::new();
    for _ in 0..8 {
        let m = manager.clone();
        handles.push(tokio::spawn(async move {
            let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
            m.plan_create_with_retry(
                &CodexLaunchPlanInput::default(),
                1,
                freshell_codex::launch_lifecycle::LaunchClass::Restore,
                &mut cancel_rx,
            )
            .await
        }));
    }
    for h in handles {
        let launch = h
            .await
            .expect("join")
            .expect("restore-class plan must never die on the budget");
        manager.discard(launch).await;
    }
    let seen_peak = peak.load(Ordering::SeqCst);
    assert!(seen_peak <= 2, "plan concurrency bound violated: {seen_peak}");
}

/// Cancel-aware queueing: a restore-class waiter parked on a zero-permit
/// budget unblocks as Cancelled the moment the watch fires.
#[tokio::test]
async fn restore_class_plan_wait_cancels_when_the_watch_fires() {
    let (factory, _release) = blocking_test_runtime_factory();
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            0,
            std::time::Duration::from_millis(50),
            64,
        ),
    );
    let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
    let m = manager.clone();
    let waiter = tokio::spawn(async move {
        m.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut cancel_rx,
        )
        .await
    });
    // Let the waiter park (0 permits => it can only be waiting or done-wrong).
    for _ in 0..200 {
        if manager.plan_queue_depth() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(manager.plan_queue_depth(), 1, "waiter must be queued");
    cancel_tx.send(true).expect("fire cancel");
    let err = waiter
        .await
        .expect("join")
        .expect_err("cancel must unblock the queued restore-class plan");
    assert!(
        matches!(err, freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled),
        "{err}"
    );
    assert_eq!(manager.plan_queue_depth(), 0, "queue slot reclaimed on cancel");
}

/// The backpressure backstop: restore-class waiters beyond the queue cap
/// fail loud as QueueFull (the WS door maps this to RATE_LIMITED).
#[tokio::test(flavor = "multi_thread")]
async fn restore_class_queue_overflow_fails_loud_as_queue_full() {
    let (factory, release) = blocking_test_runtime_factory();
    // 1 permit, cap 1: holder + one queued waiter fill the system.
    let manager = std::sync::Arc::new(
        freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            factory,
            1,
            std::time::Duration::from_millis(50),
            1,
        ),
    );
    let m1 = manager.clone();
    let holder = tokio::spawn(async move {
        let (_tx, mut c) = tokio::sync::watch::channel(false);
        m1.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c,
        )
        .await
    });
    // Let the holder take the permit (it parks inside ensure_ready).
    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    let m2 = manager.clone();
    let queued = tokio::spawn(async move {
        let (_tx, mut c) = tokio::sync::watch::channel(false);
        m2.plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c,
        )
        .await
    });
    for _ in 0..200 {
        if manager.plan_queue_depth() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(manager.plan_queue_depth(), 1, "one waiter queued at the cap");
    // Third arrival overflows the cap.
    let (_tx3, mut c3) = tokio::sync::watch::channel(false);
    let err = manager
        .plan_create_with_retry(
            &CodexLaunchPlanInput::default(),
            1,
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            &mut c3,
        )
        .await
        .expect_err("overflow past the plan queue cap must fail loud");
    assert!(
        matches!(err, freshell_codex::launch_lifecycle::CodexLaunchError::QueueFull),
        "{err}"
    );
    // Drain: release the parked plans (BlockingRuntime parks on a Notify;
    // the queued waiter parks again after the holder finishes, so notify twice).
    release.notify_waiters();
    let launch = holder.await.expect("join").expect("holder plan completes");
    manager.discard(launch).await;
    release.notify_waiters();
    let launch2 = queued.await.expect("join").expect("queued plan completes");
    manager.discard(launch2).await;
}
```

Add `use futures::future::BoxFuture;` etc. to match the file's existing imports (it already imports what `BlockingRuntime` needs).

- [ ] **Step 2: Run the new tests to verify they fail**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/graceful-restore-resume-s1
cargo test -p freshell-codex --features real-transport --test launch_lifecycle -- restore_class 2>&1 | tail -20
```
Expected: **compile error** — `LaunchClass` not found, `plan_create_with_retry` takes 2 arguments, `with_plan_budget` takes 3, no `plan_queue_depth`, no `QueueFull`/`Cancelled` variants.

- [ ] **Step 3: Implement — enum, error variants, queue semantics**

In `crates/freshell-codex/src/launch_lifecycle.rs`:

3a. Add the class enum (place it just above `CodexLaunchError` at `:102`):

```rust
/// Which class of caller is asking for a codex launch plan (graceful
/// restore/resume S1, spec P2 — docs/plans/2026-07-30-graceful-restore-resume.md).
/// `Interactive` keeps the D-C-REVISIT fail-fast: a human is actively
/// waiting, so loud-at-30s is defensible. `Restore` is the bounce-restore
/// fleet: anticipatable contention must never kill it (the D-GATE-SOFT
/// generalization), so it queues cancel-aware with no wall-clock death —
/// the wait is bounded structurally (queue depth x per-plan attempt budget;
/// honest worst case ~251s/plan, ~2.2h for a full 64-deep queue — see the
/// D-C-REVISIT block below) and by cancellation (disconnect/shutdown).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LaunchClass {
    Interactive,
    Restore,
}
```

3b. Extend `CodexLaunchError` (`:102-121`) — add two variants and Display arms:

```rust
    /// Restore-class plan queue overflow (more than the configured cap of
    /// waiters). The true backpressure backstop: the WS door maps it to
    /// RATE_LIMITED (frozen-client ladder absorbs it), the REST door to 429.
    QueueFull,
    /// The restore-class caller's cancel watch fired (or its sender dropped)
    /// while queued — the client is gone (disconnect/shutdown). Never
    /// user-visible: callers abandon silently.
    Cancelled,
```

and in the `Display` impl:

```rust
            CodexLaunchError::QueueFull => {
                f.write_str("codex plan queue full; too many queued codex launches")
            }
            CodexLaunchError::Cancelled => f.write_str("codex launch planning cancelled"),
```

3c. Add the env constant + parse helper (near `CODEX_SIDECAR_PLAN_CONCURRENCY`):

```rust
/// Env knob for the restore-class plan queue cap. Mirrors
/// `FRESHELL_SPAWN_GATE_QUEUE_CAP` semantics (create_limit.rs): unset,
/// `0`, or non-numeric fall back to the default.
pub const FRESHELL_CODEX_PLAN_QUEUE_CAP_ENV: &str = "FRESHELL_CODEX_PLAN_QUEUE_CAP";
const CODEX_PLAN_QUEUE_CAP_DEFAULT: usize = 64;

fn plan_queue_cap_from_env() -> usize {
    std::env::var(FRESHELL_CODEX_PLAN_QUEUE_CAP_ENV)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(CODEX_PLAN_QUEUE_CAP_DEFAULT)
}
```

3d. Rewrite the D-C-REVISIT block (`:453-458`) — replace the four doc-comment lines above the constants with:

```rust
/// D-C-REVISIT — SUPERSEDED IN PART (2026-07-30, graceful restore/resume S1;
/// spec docs/plans/2026-07-30-graceful-restore-resume.md §9.2): the
/// concurrency bound of 2 STANDS (a burst may never stack ~226s plan holds —
/// the half of the 2026-07-30 resolution that mattered). The fail-fast half
/// is superseded for `LaunchClass::Restore`: the S5.e flag-flip bounce
/// analysis is the revisit evidence (tabs 3+ died at >=5 codex tabs), so
/// restore-class waiters now QUEUE cancel-aware with no wall-clock death,
/// bounded by the plan queue cap below. `LaunchClass::Interactive` (WS
/// interactive, REST /api/tabs, auto-resume respawn) keeps the 30s fail-fast.
/// Honest arithmetic (V3 bounded-hold audit): worst-case per-plan hold
/// ~251s (5 attempts x (45s probe budget + 5s teardown) + 1s retry sleeps),
/// so a full 64-deep restore queue drains worst-case in ~2.2h, and an
/// Interactive waiter behind K queued restores waits ~ceil(K/2) x T
/// (T = healthy plan time, seconds).
pub const CODEX_SIDECAR_PLAN_CONCURRENCY: usize = 2;
pub const CODEX_SIDECAR_PLAN_WAIT: Duration = Duration::from_secs(30);
```

3e. Extend `CodexTerminalLaunchManager` (`:460-504`): add fields `plan_queue_cap: usize` and `plan_waiting: std::sync::Arc<std::sync::atomic::AtomicUsize>`; initialize in `new()` with `plan_queue_cap: plan_queue_cap_from_env()` and `plan_waiting: Arc::new(AtomicUsize::new(0))` (the env read MUST be in `new()` — `global()` calls `new()`, so `with_plan_budget` alone would never reach production). Change `with_plan_budget` to take a 4th `queue_cap: usize` parameter and assign it. Add:

```rust
    /// Current depth of the restore-class plan queue (waiters parked on the
    /// budget). Observability for tests and diagnostics.
    pub fn plan_queue_depth(&self) -> usize {
        self.plan_waiting.load(std::sync::atomic::Ordering::SeqCst)
    }
```

3f. Add the cancel-safe queue-depth guard (module scope, near the manager):

```rust
/// Cancel-safe accounting for the restore-class plan queue depth: the
/// decrement lives in Drop so success, cancellation, and futures dropped
/// mid-wait all reclaim the slot (the SpawnGate::WaitingGuard discipline,
/// crates/freshell-freshagent/src/spawn_gate.rs:80-87).
struct PlanWaitingGuard<'a>(&'a std::sync::atomic::AtomicUsize);
impl Drop for PlanWaitingGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}
```

3g. Replace the budgeted `plan_create_with_retry` body (`:506-530`) with the class-split version and add the uncancellable helper:

```rust
    /// Must be called from async (tokio) context; the teardown worker is spawned lazily
    /// here so [`CodexTerminalLaunchManager::notify_terminal_exit`] can stay sync-safe.
    ///
    /// Budget semantics by class (graceful restore/resume S1, P2):
    /// - `Interactive`: today's fail-fast, unchanged — the 30s wait races the
    ///   semaphore; on loss the caller gets the loud budget-exhausted error.
    /// - `Restore`: queue cancel-aware with NO wall-clock death. Bounded
    ///   structurally (restore storms are known-finite: N panes existed, N
    ///   restores arrive, the queue drains N; per-plan hold worst ~251s,
    ///   full 64-deep queue worst ~2.2h — see the D-C-REVISIT block) and by
    ///   the queue cap (overflow => QueueFull, the backpressure backstop).
    pub async fn plan_create_with_retry(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
        class: LaunchClass,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        use std::sync::atomic::Ordering;
        self.ensure_teardown_worker();
        let _budget = match class {
            LaunchClass::Interactive => {
                match tokio::time::timeout(
                    self.plan_budget_wait,
                    self.plan_budget.clone().acquire_owned(),
                )
                .await
                {
                    Ok(Ok(permit)) => permit,
                    _ => {
                        return Err(CodexLaunchError::Failed(
                            "codex sidecar planning budget exhausted; too many concurrent codex launches"
                                .to_string(),
                        ))
                    }
                }
            }
            LaunchClass::Restore => {
                if *cancel.borrow() {
                    return Err(CodexLaunchError::Cancelled);
                }
                // Fast path mirrors SpawnGate::acquire: tokio's fair semaphore
                // fails try_acquire while waiters queue, so no barging.
                match self.plan_budget.clone().try_acquire_owned() {
                    Ok(permit) => permit,
                    Err(_) => {
                        let waiting_before = self.plan_waiting.fetch_add(1, Ordering::SeqCst);
                        if waiting_before >= self.plan_queue_cap {
                            self.plan_waiting.fetch_sub(1, Ordering::SeqCst);
                            tracing::warn!(
                                target: "freshell_codex::launch",
                                waiting = waiting_before,
                                queue_cap = self.plan_queue_cap,
                                "codex_plan_queue_full"
                            );
                            return Err(CodexLaunchError::QueueFull);
                        }
                        let _waiting_guard = PlanWaitingGuard(&self.plan_waiting);
                        tokio::select! {
                            acquired = self.plan_budget.clone().acquire_owned() => match acquired {
                                Ok(permit) => permit,
                                // Semaphore closed = planner shutdown.
                                Err(_) => return Err(CodexLaunchError::Failed(
                                    "codex launch planner is shut down".to_string(),
                                )),
                            },
                            // Ok(()) = the watch changed (we only ever send true);
                            // Err(_) = the sender dropped (connection loop exited).
                            // Both mean this waiter's client is gone: cancel.
                            _ = cancel.changed() => {
                                tracing::info!(
                                    target: "freshell_codex::launch",
                                    "codex_plan_wait_cancelled"
                                );
                                return Err(CodexLaunchError::Cancelled);
                            }
                        }
                    }
                }
            }
        };
        self.planner
            .plan_create_with_retry(input, attempts, CODEX_INITIAL_LAUNCH_RETRY_DELAY_MS)
            .await
    }

    /// No-cancel doors — WS interactive create, REST /api/tabs, auto-resume
    /// respawn. The never-fired watch lives HERE, not at call sites (the
    /// kata bccd discipline the spawn gate's `acquire_uncancellable` set).
    pub async fn plan_create_with_retry_uncancellable(
        &self,
        input: &CodexLaunchPlanInput<'_>,
        attempts: u32,
        class: LaunchClass,
    ) -> Result<CodexTerminalLaunch, CodexLaunchError> {
        let (_cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        self.plan_create_with_retry(input, attempts, class, &mut cancel_rx)
            .await
    }
```

NOTE: keep the semaphore permit binding `_budget` held across the inner retry loop exactly as today (RAII drop at fn exit).

- [ ] **Step 4: Mechanical call-site updates (behavior byte-identical)**

4a. `crates/freshell-ws/src/terminal.rs:1135-1142` — inside `plan_codex_managed_launch`, change the manager call to:

```rust
    freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
        .plan_create_with_retry_uncancellable(
            &input,
            freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
            freshell_codex::launch_lifecycle::LaunchClass::Interactive,
        )
        .await
        .map(Some)
        .map_err(|error| error.to_string())
```

(Task 4 threads the real class/cancel through; for now everything stays Interactive = today's behavior.)

4b. `crates/freshell-freshagent/src/terminal_tabs.rs:1319-1323` — the REST plan call becomes (this IS the "one-line freshagent counterpart" from the spec):

```rust
            match freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .plan_create_with_retry_uncancellable(
                    &input,
                    freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    freshell_codex::launch_lifecycle::LaunchClass::Interactive,
                )
                .await
```

4c. `crates/freshell-freshagent/src/terminal_tabs.rs:590-599` — `codex_launch_error_response` gains arms for the new variants:

```rust
    let status = match &error {
        CodexLaunchError::Config(_) => StatusCode::BAD_REQUEST,
        CodexLaunchError::Failed(_) => StatusCode::INTERNAL_SERVER_ERROR,
        // Restore-class-only variants. The REST door is Interactive by
        // construction, so these are defensively mapped, mirroring
        // spawn_gate_error_response's QueueFull -> 429.
        CodexLaunchError::QueueFull => StatusCode::TOO_MANY_REQUESTS,
        CodexLaunchError::Cancelled => StatusCode::INTERNAL_SERVER_ERROR,
    };
```

4d. `crates/freshell-freshagent/src/terminal_tabs.rs:1287-1292` — in the D-C-REVISIT comment block above the REST plan call, replace the clause `(CODEX_SIDECAR_PLAN_CONCURRENCY=2, fail-fast)` with `(CODEX_SIDECAR_PLAN_CONCURRENCY=2; fail-fast for LaunchClass::Interactive — this door; restore-class queues per graceful restore/resume S1)`.

4e. `crates/freshell-codex/src/launch_plan.rs:48-56` — in the doc comment on `FRESHELL_CODEX_MANAGED_LAUNCH_ENV`, extend the final sentence: after `docs/plans/2026-07-27-rest-spawn-gate.md §D-C addendum).` append ` The fail-fast half of that resolution was later superseded for the Restore class (graceful restore/resume S1, §D-C ADDENDUM 2).`

4f. Update existing test call sites in `crates/freshell-codex/tests/launch_lifecycle.rs`: every `manager.plan_create_with_retry(&input, N)` / `m.plan_create_with_retry(&CodexLaunchPlanInput::default(), N)` on the MANAGER (test fns at `:355`, `:396`, `:411`, `:445`, `:509`, `:551` — the planner-level 3-arg calls at `:316`/`:333` are a different method and stay untouched) becomes `plan_create_with_retry_uncancellable(<same args>, LaunchClass::Interactive)`. Update the one `with_plan_budget(...)` caller (`:513`) to pass `64` as the 4th argument. Keep `third_concurrent_plan_fails_fast_on_the_sidecar_budget` semantically identical — it now pins the Interactive class explicitly.

- [ ] **Step 5: Bound every sidecar probe dial (the A6 fix — makes the structural bound REAL)**

In `ensure_ready` (`crates/freshell-codex/src/launch_lifecycle.rs:788-810`), wrap each `connect_async` probe in `tokio::time::timeout(<remaining SIDECAR_START_BUDGET>, connect_async(...))`, treating `Elapsed` exactly like a failed probe:

```rust
// A6 fix (V3 bounded-hold audit, reports/V3-bounded-holds.md §A6): the 45s
// SIDECAR_START_BUDGET was only checked in the Err arm (:802) — an
// individual `connect_async` has NO deadline of its own (TCP connect +
// HTTP upgrade + response read), so a child that binds/listens but stalls
// the WS handshake parks this await FOREVER, permanently losing 1 of the
// 2 plan permits (uncancellable: cancellation covers only the queue wait,
// never the held plan). Timeout-per-probe restores the structural bound.
let remaining = deadline
    .checked_duration_since(tokio::time::Instant::now())
    .unwrap_or(Duration::ZERO);
match tokio::time::timeout(remaining, tokio_tungstenite::connect_async(&ws_url)).await {
    Ok(Ok((probe, _))) => {
        drop(probe);
        break;
    }
    // Failed probe and stalled-handshake probe take the SAME arm: the
    // existing child-exit check, deadline check (now guaranteed reached),
    // and 100ms retry sleep run unchanged.
    Ok(Err(error)) => { /* existing Err arm body (:796-807), verbatim */ }
    Err(_elapsed) => { /* same body, with a synthesized error message,
                          e.g. "probe timed out awaiting the WS handshake" */ }
}
```

(Factor the shared arm body into a small closure/helper or duplicate the few lines — implementer's choice; keep the child-exit and deadline checks byte-identical.) No fake in `crates/freshell-codex/tests/launch_lifecycle.rs` reaches the real transport's `connect_async`, so there is no failing-test-first counterpart for this step; instead VERIFY by inspection after implementing: (a) every await inside the probe loop is deadline-wrapped; (b) `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings` stays clean (the `real-transport` feature compiles this path); (c) the worst-case hold arithmetic in the Step 3d comment (≈251s/plan) now holds with no unbounded residue.

- [ ] **Step 6: Run the tests and make sure they pass**

```bash
cargo test -p freshell-codex --features real-transport --test launch_lifecycle 2>&1 | tail -10
```
Expected: PASS, including `eight_restore_class_plans_queue_and_drain_without_error`, `restore_class_plan_wait_cancels_when_the_watch_fires`, `restore_class_queue_overflow_fails_loud_as_queue_full`, and the pre-existing `third_concurrent_plan_fails_fast_on_the_sidecar_budget`.

- [ ] **Step 7: Workspace gates**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -5
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: clean (the compiler flags any exhaustive `match` on `CodexLaunchError` you missed — fix by adding arms, never a `_` catch-all).

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-codex crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "feat(codex): LaunchClass — restore-class plans queue cancel-aware on the sidecar budget

Supersedes the fail-fast half of D-C-REVISIT for LaunchClass::Restore
(spec 2026-07-30-graceful-restore-resume §4 P2, §9.2): restore-class
waiters queue with no wall-clock death, bounded by queue cap (default 64,
FRESHELL_CODEX_PLAN_QUEUE_CAP) and cancellation. Concurrency bound 2 and
the Interactive 30s fail-fast are unchanged."
```

---

### Task 2: Global-manager test installer + sync discard seam

**Files:**
- Modify: `crates/freshell-codex/src/launch_lifecycle.rs` (`global()` at `:495-504`; `discard` at `:561-566`)
- Test: `crates/freshell-codex/tests/launch_lifecycle.rs` (discard_sync), `crates/freshell-codex/tests/global_manager_install.rs` (create — installer needs its own process)

**Interfaces:**
- Consumes: `CodexTerminalLaunchManager`, `CodexTerminalLaunch`.
- Produces:
  - `pub fn set_global_codex_launch_manager_for_tests(manager: CodexTerminalLaunchManager) -> bool` — set-once installer; returns `false` if the global was already initialized. Mirrors the `set_codex_proxy_event_sink` seam precedent (`launch_lifecycle.rs:405`). Task 5's WS integration tests depend on this — without it the storm test cannot inject a fake runtime (`global()` is a `OnceLock` with no installer).
  - `pub fn discard_sync(&self, launch: CodexTerminalLaunch)` — Drop-safe discard for RAII guards that cannot `.await` (Task 4's `PreparedCodexLaunch`). MUST never panic, with or without an ambient tokio runtime (A8: `tokio::spawn` in Drop panics outside runtime context).

- [ ] **Step 1: Write the failing tests**

1a. New file `crates/freshell-codex/tests/global_manager_install.rs`:

```rust
//! Pin for the test-only global-manager installer (graceful restore/resume
//! S1): integration suites (freshell-ws restore-storm) must be able to make
//! `global()` resolve to a manager over a FAKE runtime. Lives in its own
//! test binary because the global is process-wide and set-once.
#![cfg(feature = "real-transport")]

use freshell_codex::launch_lifecycle::{
    CodexLaunchRuntime, CodexTerminalLaunchManager, LaunchClass,
};

// Copy the FakeRuntime struct + impl + `FakeRuntime::start()` helper from
// crates/freshell-codex/tests/launch_lifecycle.rs:36-124 verbatim (test
// binaries cannot share code without a common module; this repo's harness
// convention is copy-with-attribution).

#[tokio::test(flavor = "multi_thread")]
async fn installed_manager_is_returned_by_global_and_set_twice_fails() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move || factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>),
        2,
        std::time::Duration::from_secs(30),
        64,
    );
    assert!(
        freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(manager),
        "first install must win"
    );
    // Prove global() is the installed instance: plan through it and observe
    // the fake runtime being exercised.
    let launch = CodexTerminalLaunchManager::global()
        .plan_create_with_retry_uncancellable(
            &freshell_codex::launch_plan::CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan through the installed manager");
    assert_eq!(
        runtime.ensure_ready_calls.lock().unwrap().len(),
        1,
        "the installed fake runtime must have served the plan"
    );
    CodexTerminalLaunchManager::global().discard(launch).await;

    let runtime2 = FakeRuntime::start().await;
    let second = CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move || runtime2.clone() as std::sync::Arc<dyn CodexLaunchRuntime>),
        2,
        std::time::Duration::from_secs(30),
        64,
    );
    assert!(
        !freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(second),
        "second install must report failure (set-once)"
    );
}
```

1b. In `crates/freshell-codex/tests/launch_lifecycle.rs` add:

```rust
/// discard_sync must tear the sidecar down (asynchronously) without the
/// caller awaiting — the seam Task 4's RAII guard uses from Drop.
#[tokio::test(flavor = "multi_thread")]
async fn discard_sync_tears_down_an_unadopted_plan() {
    let runtime = FakeRuntime::start().await;
    let factory_runtime = runtime.clone();
    let manager = CodexTerminalLaunchManager::with_plan_budget(
        Box::new(move || factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>),
        2,
        std::time::Duration::from_secs(30),
        64,
    );
    let launch = manager
        .plan_create_with_retry_uncancellable(
            &CodexLaunchPlanInput::default(),
            1,
            LaunchClass::Interactive,
        )
        .await
        .expect("plan");
    manager.discard_sync(launch);
    // Teardown is fire-and-forget: poll for the shutdown.
    for _ in 0..200 {
        if runtime.shutdown_calls.load(std::sync::atomic::Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        runtime.shutdown_calls.load(std::sync::atomic::Ordering::SeqCst),
        1,
        "discard_sync must shut the sidecar down"
    );
}
```

(Adjust the `shutdown_calls` atomic type/ordering to match the existing `FakeRuntime` field, `AtomicU32` per `tests/launch_lifecycle.rs:40`.)

1c. Also in `crates/freshell-codex/tests/launch_lifecycle.rs`, the A8 failing-first counterpart — `discard_sync` outside runtime context must NEVER panic (it is called from `PreparedCodexLaunch::drop`, Task 4):

```rust
/// A8 (V4): `tokio::spawn` panics with no ambient runtime, and discard_sync
/// is called from Drop — where a panic is a double-panic abort during
/// unwind. Plan on a locally-built runtime, tear the runtime down, then
/// call discard_sync from plain (non-tokio) test context: pre-hardening
/// this PANICS ("there is no reactor running"); post-hardening it must
/// degrade to best-effort kill / log-and-leak.
#[test] // deliberately NOT #[tokio::test]
fn discard_sync_outside_runtime_context_does_not_panic() {
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("local runtime");
    let (manager, launch) = rt.block_on(async {
        let runtime = FakeRuntime::start().await;
        let factory_runtime = runtime.clone();
        let manager = CodexTerminalLaunchManager::with_plan_budget(
            Box::new(move || factory_runtime.clone() as std::sync::Arc<dyn CodexLaunchRuntime>),
            2,
            std::time::Duration::from_secs(30),
            64,
        );
        let launch = manager
            .plan_create_with_retry_uncancellable(
                &CodexLaunchPlanInput::default(),
                1,
                LaunchClass::Interactive,
            )
            .await
            .expect("plan");
        (manager, launch)
    });
    rt.shutdown_timeout(std::time::Duration::from_secs(5));
    // No ambient runtime here: must not panic (teardown is best-effort).
    manager.discard_sync(launch);
}
```

(If holding `manager`/`launch` across the runtime drop trips an unrelated Drop that itself requires a runtime, note it and adapt — the pinned property is only that `discard_sync` itself never panics without a runtime.)

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-codex --features real-transport --test global_manager_install 2>&1 | tail -5
cargo test -p freshell-codex --features real-transport --test launch_lifecycle -- discard_sync 2>&1 | tail -5
```
Expected: compile errors — `set_global_codex_launch_manager_for_tests` and `discard_sync` not found.

- [ ] **Step 3: Implement**

In `crates/freshell-codex/src/launch_lifecycle.rs`:

3a. Hoist the `OnceLock` out of `global()` to module scope and add the installer:

```rust
static GLOBAL_MANAGER: OnceLock<CodexTerminalLaunchManager> = OnceLock::new();

/// Test-only global installer (mirrors the `set_codex_proxy_event_sink`
/// seam): lets integration suites make [`CodexTerminalLaunchManager::global`]
/// resolve to a manager over a fake runtime. Set-once: returns `false` (and
/// installs nothing) if the global was already initialized. Production code
/// must never call this.
pub fn set_global_codex_launch_manager_for_tests(manager: CodexTerminalLaunchManager) -> bool {
    GLOBAL_MANAGER.set(manager).is_ok()
}
```

and change `global()`'s body to use the module-scope `GLOBAL_MANAGER` (same `get_or_init` closure as today, deleting only the fn-local `static GLOBAL`).

3b. Add next to `discard` (`:561-566`):

```rust
    /// [`Self::discard`] for sync contexts (RAII Drop guards): fire-and-forget
    /// the sidecar teardown on the runtime. Same best-effort semantics —
    /// teardown errors are swallowed; the create failure the caller is
    /// surfacing (or the silent cancel) is the primary event.
    ///
    /// A8 hardening (V4): `tokio::spawn` PANICS when no ambient runtime
    /// exists, and this fn is called from Drop (`PreparedCodexLaunch`),
    /// where panicking is never acceptable (double-panic abort during
    /// unwind). Spawn only when a handle exists; otherwise degrade to a
    /// best-effort SYNCHRONOUS kill of the sidecar child (or, if no sync
    /// kill seam is reachable from here, `tracing::warn!` and leak) —
    /// NEVER panic.
    pub fn discard_sync(&self, launch: CodexTerminalLaunch) {
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    let _ = launch.sidecar.shutdown().await;
                });
            }
            Err(_) => {
                // No runtime (e.g. Drop during unwind after runtime
                // teardown): best-effort synchronous child kill — use the
                // sidecar's sync-callable kill path (`child.start_kill()`
                // is sync; the ownership reap `reap_owned_codex_sidecars`
                // is plain std). If neither is reachable without an async
                // lock, log-and-leak:
                tracing::warn!(
                    target: "freshell_codex::launch",
                    "discard_sync outside runtime context; best-effort kill/leak"
                );
                // implementer: add the sync kill here if a seam exists;
                // leaking is acceptable, panicking is not.
            }
        }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-codex --features real-transport 2>&1 | tail -10
```
Expected: PASS (all binaries).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-codex
git commit -m "feat(codex): global launch-manager test installer + sync discard seam

set_global_codex_launch_manager_for_tests (set-once, mirrors the proxy
event-sink seam) unblocks WS-level fake-runtime injection for the S1
restore-storm pins; discard_sync is the Drop-safe teardown the prepared-
launch RAII guard needs (Handle::try_current-guarded: never panics
outside runtime context)."
```

---

### Task 3: Extract `derive_launch_prep` from `handle_create` (behavior-preserving; the claude ladder STAYS)

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (derivation block `:1621-1722` inside `handle_create` — ONLY the pure rungs `:1621-1689` are extracted; the claude P0.4 ladder `:1690-1720` stays in `handle_create`)

**SCOPE NARROWED per A12/V6 (`reports/V6-derivation-block.md`):** the extraction hoists ONLY the mode-generic pure create-body reads (locals init, `requested_ref`, the fresh-prealloc predicates/arms) and the codex rung (`terminal.rs:1679-1682`, pure reads of `sessionRef.sessionId`/`resumeSessionId`). The claude P0.4 ladder — the `is_canonical_claude_session_id` gate + `resolve_claude_restore_session_id` + the `RESTORE_UNAVAILABLE` reject (`terminal.rs:1690-1720`) — is NOT extracted: it reads mutable liveness state (Running rows, live-owner joins, ledger rows) whose meaning depends on running AFTER the keyed-create adopt (`:1443-1461`) and the D8 lease/attach arms (`:1484-1558`). Hoisted pre-gate, a duplicate claude restore in the two-connection reconcile race would get a loud "[Restore failed]" instead of adopting the winner — violating "strictly fewer error frames" (the ladder's own doc comment at `:3122-3125` pins the designed dependence on the dedupe running first).

**Interfaces:**
- Consumes: `TerminalCreate`, `WsState`, `LaunchIntent`, the helpers the extracted rungs already use (`freshell_platform::should_preallocate_fresh_claude`).
- Produces (Task 4 relies on these exact names):

```rust
/// Spawn-time launch intent + resume identity, derived before spawn.
/// PURE with respect to server state: create-body reads + local RNG only
/// (V6 rung table). The claude restore ladder deliberately does NOT live
/// here — it stays in handle_create, after the adopt/D8 arms.
pub(crate) struct LaunchPrep {
    pub launch_intent: LaunchIntent,
    pub resume_session_id: Option<String>,
    pub claude_fresh_prealloc: bool,
}

/// Extraction of handle_create's PURE derivation rungs
/// (terminal.rs:1621-1689). Infallible: the only loud reject in the old
/// block (the claude RESTORE_UNAVAILABLE ladder, :1690-1720) is not
/// extracted, so there is no error path.
pub(crate) fn derive_launch_prep(
    create: &TerminalCreate,
    mode: &str,
) -> LaunchPrep
```

(Drop `async` and the `state` parameter if the compiler confirms the extracted rungs need neither — the ladder was the only `state` consumer and the only await; keep them only if some retained rung genuinely uses them.)

- [ ] **Step 1: Snapshot the pins that must stay green (the "red" for a refactor is a broken pin)**

Environment precondition FIRST (Global Constraints): these binaries perform codex-mode creates, which die at MCP injection (`PTY_SPAWN_FAILED "Unable to resolve MCP dependency \"tsx\""`) in a worktree without node deps — an environmental failure unrelated to this slice.

```bash
cd /home/dan/code/freshell/.worktrees/graceful-restore-resume-s1
test -f node_modules/tsx/dist/loader.mjs || npm ci --no-audit --no-fund
cargo test -p freshell-ws --test claude_restore_unavailable 2>&1 | tail -5
cargo test -p freshell-ws --test codex_session_ref_resume 2>&1 | tail -5
cargo test -p freshell-ws --test restore_spawn_gate 2>&1 | tail -5
cargo test -p freshell-ws --lib terminal_create_ordering 2>&1 | tail -5
```
Expected: all PASS (record the counts). NOTE: the source-ordering pin is NOT an integration test under `crates/freshell-ws/tests/` — it is a lib unit-test module (`crates/freshell-ws/src/terminal_create_ordering_tests.rs`, declared via `#[path]` in `terminal.rs:72-73`), so it must be invoked with `--lib` plus the filter above, which runs `terminal::terminal_create_ordering_tests::claude_binding_write_precedes_pty_spawn_in_handle_create` (verified: 1 passed at worktree HEAD). If the filter ever matches nothing, find it: `grep -rn "terminal_create_ordering" crates/freshell-ws/src/` — it asserts source ordering inside `handle_create` (claude binding write precedes PTY spawn); read its mechanism BEFORE moving code and keep it satisfied.

ORDERING NOTE (V5 §A13): `restore_spawn_gate.rs` still contains its gate-timeout pins at this point — that is CORRECT here (Task 3 changes no gate behavior, so they pass pre-change). Task 4 Step 8 rewrites four such pins to timeout-free mechanisms BEFORE Task 4's own all-green gate; do not "pre-fix" them in this task.

- [ ] **Step 2: Extract (pure rungs ONLY — the claude ladder stays put)**

In `crates/freshell-ws/src/terminal.rs`, define `LaunchPrep` and `derive_launch_prep` (place them immediately above `handle_create`). Move the PURE derivation rungs — everything from `let mut launch_intent = LaunchIntent::Resume;` (`:1621` region, including its leading comment block) through the sessionRef-first `else` rung's assignment ending `.filter(|s| !s.is_empty());` (`:1679-1682`) — into `derive_launch_prep` VERBATIM, with exactly these edits:

1. The function begins:
```rust
pub(crate) fn derive_launch_prep(
    create: &TerminalCreate,
    mode: &str,
) -> LaunchPrep {
    let mut launch_intent = LaunchIntent::Resume;
    let mut resume_session_id: Option<String> = None;
    let mut claude_fresh_prealloc = false;
    if mode != "shell" {
        // ... moved rungs, unchanged: requested_ref, the two prealloc
        // predicates, the prealloc arms, the sessionRef-first else rung
        // (:1679-1682) ...
    }
    LaunchPrep {
        launch_intent,
        resume_session_id,
        claude_fresh_prealloc,
    }
}
```
2. Do NOT move the claude P0.4 ladder (`if mode == "claude" && create.restore == Some(true) { ... }`, `:1690-1720`, including its leading P0.4 comment at `:1683-1689`). It stays in `handle_create` — see below.
3. Any direct uses of locals defined before the block (e.g. `mode`) become the fn parameters. If nothing in the moved rungs needs `state` or an await, this fn is sync and `state`-free (expected per the V6 rung table); let the compiler confirm.

Then, at the block's old location in `handle_create`, replace it with the destructure IMMEDIATELY FOLLOWED by the retained ladder:

```rust
    let LaunchPrep {
        mut launch_intent,
        mut resume_session_id,
        claude_fresh_prealloc,
    } = derive_launch_prep(&create, &mode);
    // A12 (V6): the claude P0.4 ladder stays HERE — at its original
    // position AFTER the keyed-create adopt (:1443-1461) and the D8
    // lease/attach arms (:1484-1558) — because it reads mutable liveness
    // state whose meaning depends on those arms having run first (the
    // ladder's own doc comment, :3122-3125). Hoisting it pre-gate would
    // turn a duplicate claude restore in the two-connection reconcile
    // race into a loud "[Restore failed]" instead of adopting the winner.
    if mode == "claude" && create.restore == Some(true) {
        // ... ladder body VERBATIM from :1690-1720 (canonical-id gate,
        // resolve_claude_restore_session_id, RESTORE_UNAVAILABLE reject
        // via send_create_error — all unchanged) ...
    }
```

This re-nesting is behavior-identical: for `mode == "claude" && restore == Some(true)` the prealloc arms are unreachable (`should_preallocate_fresh_claude` is false whenever `restore == Some(true)`, cli_launch.rs:616-626; the amplifier arm requires `mode == "amplifier"`), so the else rung was ALWAYS taken and the ladder's guard condition is equivalent at either nesting depth. (Keep `mut` on `launch_intent`/`resume_session_id` only if later code in `handle_create` actually mutates them — the ladder mutates `resume_session_id`; check with the compiler; drop unused `mut` to satisfy clippy. `claude_fresh_prealloc` is read-only downstream per the PIN2 comment.)

- [ ] **Step 3: Re-run the pins + suite**

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo test -p freshell-ws 2>&1 | tail -10
```
Expected: identical pass counts to Step 1; full `freshell-ws` suite green (modulo the documented pane_ledger lib flake).

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/src/terminal.rs
git commit -m "refactor(ws): extract derive_launch_prep from handle_create (behavior-preserving)

Seam for graceful restore/resume S1: the restore path will run this
derivation BEFORE the spawn-gate permit. Only the pure rungs move; the
claude P0.4 ladder stays in handle_create AFTER the adopt/D8 arms (A12:
it reads mutable liveness state that presumes those arms ran first). No
behavior change; pins claude_restore_unavailable /
codex_session_ref_resume stay green."
```

---

### Task 4: Move codex planning off-permit; restore-class gate wait becomes cancel-aware-unbounded

This is the core of Slice 1 (spec P1 + the restore-class gate wait of P2). It is one atomic task: the pieces only compile and make sense together.

**Files:**
- Modify: `crates/freshell-freshagent/src/spawn_gate.rs` (add `acquire_unbounded` — cancel-aware, no timeout, periodic parked-waiter warn — + tests; amend module doc `:26-42` bounded-wait bullet)
- Modify: `crates/freshell-ws/src/terminal.rs` (`plan_codex_managed_launch` `:1094-1143`; `handle_create` signature `:1413-1423` + plan site `:2007-2031`; interactive call site `:593-607`; respawn call site `:2738-2753`; new `prepare_launch`/`PreparedLaunch`/`PreparedCodexLaunch`/`PrepareError`/`PlanLaunchError`)
- Modify: `crates/freshell-ws/src/create_gate.rs` (`spawn_gated_restore_create` `:53-189`; slow-hold watchdog)
- Modify: `crates/freshell-ws/src/create_limit.rs` (doc comment `:37-39` region)
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs`, `crates/freshell-ws/tests/create_protection.rs`, `crates/freshell-ws/tests/rest_ws_shared_gate.rs` (Step 8: rewrite the four gate-timeout restore pins to timeout-free mechanisms — V5 §A13)

**Interfaces:**
- Consumes: Task 1's `LaunchClass` + manager API; Task 2's `discard_sync`; Task 3's `derive_launch_prep`/`LaunchPrep`; existing `SpawnGate`, `spawn_gate_error_parts`, `send_create_error`, `clear_if_in_flight`.
- Produces:

```rust
// crates/freshell-freshagent/src/spawn_gate.rs
pub async fn acquire_unbounded(
    &self,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<OwnedSemaphorePermit, SpawnGateError>

// crates/freshell-ws/src/terminal.rs
pub(crate) struct PreparedCodexLaunch(Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch>);
// methods: pub(crate) fn take(&mut self) -> Option<CodexTerminalLaunch>; Drop discards via discard_sync.

pub(crate) struct PreparedLaunch {
    pub prep: LaunchPrep,
    /// Some(..) ONLY when a resume session id was derived. A4/V2: fresh
    /// plans arm a 45s candidate-capture timer AT PROXY START
    /// (remote_proxy.rs:248-258); None => handle_create plans on-permit
    /// inline (today's Interactive path, byte-identical).
    pub codex_launch: Option<PreparedCodexLaunch>,
}

pub(crate) enum PrepareError {
    // NO Reject variant: derivation is infallible post-A12 (the claude
    // RESTORE_UNAVAILABLE ladder stays inside handle_create).
    /// Restore-class plan queue overflow -> error{code:RATE_LIMITED}.
    PlanQueueFull,
    /// Cancel watch fired while queued -> silent abandon, no frame.
    Cancelled,
    /// Plan failed (T4/T6 residue) -> error{code:PTY_SPAWN_FAILED}, today's frame.
    PlanFailed(String),
}

pub(crate) async fn prepare_launch(
    create: &TerminalCreate,
    state: &WsState,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<PreparedLaunch, PrepareError>

pub(crate) enum PlanLaunchError { QueueFull, Cancelled, Failed(String) }
// method: pub(crate) fn message(self) -> String

async fn plan_codex_managed_launch(
    state: &WsState,
    mode: &str,
    raw_cwd: Option<&str>,
    resume_session_id: Option<&str>,
    class: freshell_codex::launch_lifecycle::LaunchClass,
    cancel: Option<&mut tokio::sync::watch::Receiver<bool>>,
) -> Result<Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch>, PlanLaunchError>

pub(crate) async fn handle_create(
    create: TerminalCreate,
    prepared: Option<PreparedLaunch>,   // NEW, 2nd parameter
    out: &mut crate::create_gate::CreateOutput<'_>,
    state: &WsState,
    conn_id: u64,
    pane_reconcile_v1: bool,
    create_limiter: &mut crate::create_limit::CreateRateLimiter,
) -> bool
```

- [ ] **Step 1: Write the failing spawn-gate unit tests**

In `crates/freshell-freshagent/src/spawn_gate.rs`'s existing `#[cfg(test)] mod tests` (tests live around `:242, :268`), add:

```rust
    #[tokio::test]
    async fn unbounded_acquire_waits_past_any_timeout_and_gets_the_released_permit() {
        let gate = std::sync::Arc::new(SpawnGate::new(1, 4));
        let first = gate
            .acquire_uncancellable(std::time::Duration::from_secs(5))
            .await
            .expect("first permit");
        let g2 = gate.clone();
        let waiter = tokio::spawn(async move {
            let (_tx, mut cancel) = tokio::sync::watch::channel(false);
            g2.acquire_unbounded(&mut cancel).await
        });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await; // park it
        drop(first);
        let permit = waiter
            .await
            .expect("join")
            .expect("unbounded waiter must receive the released permit");
        drop(permit);
    }

    #[tokio::test]
    async fn unbounded_acquire_cancels_when_the_watch_fires() {
        let gate = std::sync::Arc::new(SpawnGate::new(0, 4));
        let (cancel_tx, mut cancel_rx) = tokio::sync::watch::channel(false);
        let g = gate.clone();
        let waiter = tokio::spawn(async move { g.acquire_unbounded(&mut cancel_rx).await });
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        cancel_tx.send(true).expect("fire cancel");
        let err = waiter.await.expect("join").expect_err("must cancel");
        assert_eq!(err, SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);
    }

    #[tokio::test]
    async fn unbounded_acquire_still_fails_loud_on_queue_full() {
        let gate = SpawnGate::new(0, 0);
        let (_tx, mut cancel) = tokio::sync::watch::channel(false);
        let err = gate
            .acquire_unbounded(&mut cancel)
            .await
            .expect_err("cap 0 must reject");
        assert_eq!(err, SpawnGateError::QueueFull);
    }
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-freshagent --lib spawn_gate 2>&1 | tail -5
```
Expected: compile error — `acquire_unbounded` not found.

- [ ] **Step 3: Implement `SpawnGate::acquire_unbounded`**

In `crates/freshell-freshagent/src/spawn_gate.rs`, next to `acquire` (`:111-183`), mirroring it exactly minus the timeout wrapper (same fast path, same cap check, same `WaitingGuard`, same counters — read `acquire`'s body and keep the `queued_total` increment at the same point it has):

```rust
    /// Acquire a spawn permit with NO wall-clock timeout (graceful
    /// restore/resume S1: the WS restore door — contention may not kill a
    /// restore, the D-GATE-SOFT generalization). Still cancel-aware
    /// (disconnect/shutdown unblocks as `Cancelled`) and still bounded by
    /// the queue cap (`QueueFull` fails loud BEFORE the wait). The wait is
    /// bounded structurally: permits recycle per settled create, and with
    /// planning moved off-permit every hold is fast and mode-uniform.
    ///
    /// OBSERVABILITY (A5, V3 bounded-hold audit — the accepted residual):
    /// permit-held awaits are deadline-free (PTY spawn terminal.rs:2253-2269,
    /// association fs walk :2431-2454, fsync ledger writes :2517-2545), so a
    /// correlated fs hang (the gate's founding WSL RCA) now hangs restores
    /// SILENTLY where today they died loud at 10s. The periodic warn below
    /// replaces that deleted ops signal WITHOUT protocol changes.
    pub async fn acquire_unbounded(
        &self,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<OwnedSemaphorePermit, SpawnGateError> {
        if *cancel.borrow() {
            self.cancellations.fetch_add(1, Ordering::Relaxed);
            return Err(SpawnGateError::Cancelled);
        }
        if let Ok(permit) = self.semaphore.clone().try_acquire_owned() {
            return Ok(permit);
        }
        let waiting_before = self.waiting.fetch_add(1, Ordering::SeqCst);
        if waiting_before >= self.queue_cap {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            self.queue_rejections.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                target: "freshell_ws::spawn_gate",
                waiting = waiting_before,
                queue_cap = self.queue_cap,
                "spawn_gate_queue_full"
            );
            return Err(SpawnGateError::QueueFull);
        }
        let _waiting_guard = WaitingGuard(&self.waiting);
        self.queued_total.fetch_add(1, Ordering::Relaxed);
        // CRITICAL: create the acquire future ONCE and pin it — recreating
        // it per loop iteration would forfeit FIFO queue position (first-poll
        // order, V4 A16-N1). The sleep arm only logs; it never restarts the
        // acquire.
        let wait_started = tokio::time::Instant::now();
        let acquire = self.semaphore.clone().acquire_owned();
        tokio::pin!(acquire);
        loop {
            tokio::select! {
                acquired = &mut acquire => match acquired {
                    Ok(permit) => return Ok(permit),
                    // Closed semaphore = server teardown; map like a cancel.
                    Err(_) => {
                        self.cancellations.fetch_add(1, Ordering::Relaxed);
                        return Err(SpawnGateError::Cancelled);
                    }
                },
                _ = cancel.changed() => {
                    self.cancellations.fetch_add(1, Ordering::Relaxed);
                    tracing::info!(target: "freshell_ws::spawn_gate", "spawn_gate_cancelled");
                    return Err(SpawnGateError::Cancelled);
                }
                // A5 residual signal: while parked, warn every 30s with the
                // waited duration and queue depth (no frames, no protocol).
                _ = tokio::time::sleep(std::time::Duration::from_secs(30)) => {
                    tracing::warn!(
                        target: "freshell_ws::spawn_gate",
                        waited_s = wait_started.elapsed().as_secs(),
                        queue_depth = self.waiting.load(Ordering::SeqCst),
                        "spawn_gate_unbounded_wait_slow"
                    );
                }
            }
        }
    }
```

(If `acquire`'s real body orders `queued_total` differently, mirror it — the counter is asserted by existing tests via `queued_total()`.)

Amend the module doc (`spawn_gate.rs` header, the "Bounded wait" bullet): after "fails LOUD (`Timeout`)" append " — interactive/REST/auto-resume doors only; the WS restore door uses `acquire_unbounded` (cancel-aware, no wall-clock death — graceful restore/resume S1)".

Run: `cargo test -p freshell-freshagent --lib spawn_gate 2>&1 | tail -5` — Expected: PASS.

- [ ] **Step 4: Typed plan errors + class/cancel through `plan_codex_managed_launch`**

In `crates/freshell-ws/src/terminal.rs`:

4a. Add near `plan_codex_managed_launch`:

```rust
/// WS-side projection of [`CodexLaunchError`] keeping exactly the
/// distinctions the create doors need (graceful restore/resume S1).
pub(crate) enum PlanLaunchError {
    /// Restore-class plan queue overflow -> RATE_LIMITED (ladder absorbs).
    QueueFull,
    /// Cancel watch fired while queued -> silent abandon.
    Cancelled,
    /// Everything else -> PTY_SPAWN_FAILED with this message (today's shape).
    Failed(String),
}

impl PlanLaunchError {
    pub(crate) fn message(self) -> String {
        match self {
            PlanLaunchError::QueueFull => {
                "codex plan queue full; too many queued codex launches".to_string()
            }
            PlanLaunchError::Cancelled => "codex launch planning cancelled".to_string(),
            PlanLaunchError::Failed(message) => message,
        }
    }
}
```

4b. Change `plan_codex_managed_launch` (`:1094-1143`) to the new signature (see Interfaces) and replace its tail:

```rust
    let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
    let result = match cancel {
        Some(cancel_rx) => {
            manager
                .plan_create_with_retry(
                    &input,
                    freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    class,
                    cancel_rx,
                )
                .await
        }
        None => {
            manager
                .plan_create_with_retry_uncancellable(
                    &input,
                    freshell_codex::launch_plan::CODEX_INITIAL_LAUNCH_ATTEMPTS,
                    class,
                )
                .await
        }
    };
    result.map(Some).map_err(|error| match error {
        freshell_codex::launch_lifecycle::CodexLaunchError::QueueFull => PlanLaunchError::QueueFull,
        freshell_codex::launch_lifecycle::CodexLaunchError::Cancelled => PlanLaunchError::Cancelled,
        other => PlanLaunchError::Failed(other.to_string()),
    })
```

Also update its doc comment: append "Restore-class callers thread their per-connection cancel watch; the WS interactive and auto-resume doors pass `None` (never-fired watch minted in the manager)."

4c. Update the two existing call sites:
- `handle_create`'s plan site (`:2007-2031`): pass `freshell_codex::launch_lifecycle::LaunchClass::Interactive, None` and change the error arm to `Err(error) => { return send_create_error(out, ErrorCode::PtySpawnFailed, error.message(), &create.request_id).await; }` (QueueFull/Cancelled are unreachable for Interactive-class `None`-cancel calls; `message()` keeps the frame text identical for `Failed`).
- `respawn_agent_terminal` (`:2738-2753`): pass `LaunchClass::Interactive, None`; error arm becomes `Err(error) => return Err(RespawnError::LaunchUnresolvable(error.message()))`.

- [ ] **Step 5: `PreparedCodexLaunch` guard, `PreparedLaunch`, `PrepareError`, `prepare_launch`**

Add to `crates/freshell-ws/src/terminal.rs` (above `handle_create`):

```rust
/// RAII holder for a planned-but-unadopted codex launch (graceful
/// restore/resume S1, P1). Once planning happens BEFORE the spawn-gate
/// permit, a live sidecar+proxy exists across every early-exit arm of
/// `spawn_gated_restore_create` AND every pre-plan early return inside
/// `handle_create` (keyed-create adopt, D8 lease, unknown mode, D7 guard,
/// opencode port). Enumerating those arms is fragile; Drop is not. Dropping
/// this guard without `take()` tears the sidecar down via `discard_sync`
/// (which is `Handle::try_current()`-guarded — Task 2 — so this Drop can
/// NEVER panic, even outside runtime context).
pub(crate) struct PreparedCodexLaunch(
    Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch>,
);

impl PreparedCodexLaunch {
    pub(crate) fn new(
        launch: Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch>,
    ) -> Self {
        Self(launch)
    }
    /// Hand the launch to the adoption path; the guard becomes inert.
    pub(crate) fn take(
        &mut self,
    ) -> Option<freshell_codex::launch_lifecycle::CodexTerminalLaunch> {
        self.0.take()
    }
}

impl Drop for PreparedCodexLaunch {
    fn drop(&mut self) {
        if let Some(launch) = self.0.take() {
            tracing::info!(
                target: "freshell_ws::create",
                "prepared_codex_launch_discarded"
            );
            freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global()
                .discard_sync(launch);
        }
    }
}

/// Everything a restore-class create computes BEFORE the spawn-gate permit.
pub(crate) struct PreparedLaunch {
    pub prep: LaunchPrep,
    /// Some(..) ONLY when a resume session id was derived; None means
    /// "not planned pre-gate" and handle_create plans on-permit inline.
    pub codex_launch: Option<PreparedCodexLaunch>,
}

pub(crate) enum PrepareError {
    // No Reject variant: post-A12, derive_launch_prep is infallible (the
    // claude RESTORE_UNAVAILABLE ladder stays inside handle_create, after
    // the adopt/D8 arms).
    /// Restore-class plan queue overflow -> error{code:RATE_LIMITED}.
    PlanQueueFull,
    /// Cancel fired while queued -> silent abandon (no frame, no PTY).
    Cancelled,
    /// Plan failed (T4/T6 residue) -> error{code:PTY_SPAWN_FAILED}.
    PlanFailed(String),
}

/// P1's prepare phase: resume-identity derivation + the codex managed plan,
/// run BEFORE the spawn-gate permit so permits only ever cover fast,
/// mode-uniform PTY-spawn->settle work. Restore-class only.
pub(crate) async fn prepare_launch(
    create: &TerminalCreate,
    state: &WsState,
    cancel: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<PreparedLaunch, PrepareError> {
    // Same mode derivation handle_create uses (copy the exact expression
    // from the `:1578-1586` region so the two sites can never disagree).
    let mode = /* copy handle_create's `mode` expression verbatim */;
    let prep = derive_launch_prep(create, &mode);
    // A4 (V2 codex-sidecar audit): pre-gate planning ONLY when a resume
    // session id was derived. A fresh plan (resume_session_id == None,
    // i.e. `require_candidate_persistence`) arms a 45s candidate-capture
    // timer AT PROXY START (remote_proxy.rs:248-258); parked past 45s on
    // the unbounded gate wait, the identity gate permanently fails and
    // every post-adopt turn/start is rejected -32000 — an adoptable but
    // functionally broken pane. So a `restore:true` codex create with no
    // sessionRef/resumeSessionId keeps today's EXACT on-permit inline
    // planning path (LaunchClass::Interactive inside handle_create),
    // byte-identical to today.
    let codex_launch = if prep.resume_session_id.is_some() {
        match plan_codex_managed_launch(
            state,
            &mode,
            create.cwd.as_deref(),
            prep.resume_session_id.as_deref(),
            freshell_codex::launch_lifecycle::LaunchClass::Restore,
            Some(cancel),
        )
        .await
        {
            Ok(launch) => Some(PreparedCodexLaunch::new(launch)),
            Err(PlanLaunchError::QueueFull) => return Err(PrepareError::PlanQueueFull),
            Err(PlanLaunchError::Cancelled) => return Err(PrepareError::Cancelled),
            Err(PlanLaunchError::Failed(message)) => {
                return Err(PrepareError::PlanFailed(message))
            }
        }
    } else {
        None
    };
    Ok(PreparedLaunch { prep, codex_launch })
}
```

Notes for the implementer:
- Signature drift-guard: the `derive_launch_prep(create, &mode)` calls here and in Step 6b assume Task 3's firm contract (sync, `state`-free — Self-Review §4); if Task 3's compiler check forced `state` and/or `async` to be retained, thread them here and at the Step 6b inline call IDENTICALLY, and update Self-Review §4 — the two call sites must never diverge.
- For non-codex modes (`shell`, `claude`, …) `plan_codex_managed_launch` returns `Ok(None)` immediately — prepare is cheap and mode-uniform (a `Some(PreparedCodexLaunch::new(None))` guard is inert).
- Only the PURE derivation rungs run pre-gate (A12/V6 correction — this supersedes an earlier draft of this plan that claimed the claude-ladder reject "simply fires pre-gate (better…)"; that was WRONG): the claude P0.4 ladder reads mutable liveness state whose meaning depends on running AFTER the keyed-create adopt (`terminal.rs:1443-1461`) and the D8 lease/attach arms (`:1484-1558`). Hoisted, a duplicate claude restore in the two-connection reconcile race would get a loud "[Restore failed]" instead of adopting the winner — violating "strictly fewer error frames". The ladder therefore still runs inside `handle_create` at its original post-adopt/attach position (Task 3), for BOTH the prepared and inline paths. What runs here is read-only create-body derivation (restore:true never mints fresh identities: `should_preallocate_fresh_claude` and the amplifier prealloc arm are both false when `restore == Some(true)`), so the reordering is safe.
- A claude restore's `prep.resume_session_id` may carry a non-canonical client id at this point — harmless: it never reaches `plan_codex_managed_launch`'s codex branch (mode != codex), and the ladder normalizes/rejects it post-gate exactly as today.
- An unknown `mode` reaches derivation here where it previously didn't (the unknown-mode reject stays in `handle_create`). Derivation for an unknown mode takes the sessionRef-first `else` rung and produces no side effects; `handle_create` still rejects it post-gate with today's frame. Deliberately not hoisting the mode check — minimal diff.

- [ ] **Step 6: `handle_create` gains `prepared`**

6a. Change the signature (`:1413-1423`) to add `prepared: Option<PreparedLaunch>` as the 2nd parameter.

6b. At the Task-3 derivation call site, use the prepared values when present:

```rust
    let (prep, mut prepared_codex) = match prepared {
        // p.codex_launch is None for non-codex modes AND for the A4
        // fresh-plan exclusion (no derived resume session id) — the None
        // arm of the plan site below then plans on-permit, byte-identical
        // to today.
        Some(p) => (Some(p.prep), p.codex_launch),
        None => (None, None),
    };
    let LaunchPrep {
        mut launch_intent,
        mut resume_session_id,
        claude_fresh_prealloc,
    } = match prep {
        Some(prep) => prep,
        None => derive_launch_prep(&create, &mode),
    };
    // The claude P0.4 ladder (Task 3) runs HERE for BOTH branches —
    // prepared and inline — at its original post-adopt/attach position
    // (A12/V6). Do not move it.
```

IMPORTANT placement: do the `let (prep, mut prepared_codex) = …` destructure at the TOP of `handle_create` (before the keyed-create dedupe at `:1424`), so `prepared_codex`'s Drop guard is alive across every pre-plan early return; keep the `LaunchPrep` destructure where the derivation block was. (Between those two points `prepared_codex` is simply carried.)

6c. At the plan site (`:2007-2031`), consume the guard instead of re-planning when prepared:

```rust
    let codex_launch = match prepared_codex.as_mut() {
        // Restore path with a derived resume id: planned pre-gate (P1).
        // take() disarms the guard — from here the existing failed-spawn
        // arm (`:2329-2337`) and adopt path own the launch exactly as
        // today. The None arm below serves interactive creates AND the A4
        // fresh-plan exclusion (restore:true codex with no derived resume
        // session id): both plan on-permit inline, byte-identical to today.
        Some(guard) => guard.take(),
        None => match plan_codex_managed_launch(
            state,
            &mode,
            create.cwd.as_deref(),
            resume_session_id.as_deref(),
            freshell_codex::launch_lifecycle::LaunchClass::Interactive,
            None,
        )
        .await
        {
            Ok(launch) => launch,
            Err(error) => {
                return send_create_error(
                    out,
                    ErrorCode::PtySpawnFailed,
                    error.message(),
                    &create.request_id,
                )
                .await
            }
        },
    };
```

6d. Update the interactive call site (`:593-607`) to `handle_create(create, None, &mut out, state, conn_id, pane_reconcile_v1, &mut create_limiter)` (argument order per the new signature). Grep for every other `terminal::handle_create(` / `handle_create(` call on THIS function (there are exactly two production sites plus `create_gate.rs:147`) and add the `prepared` argument.

- [ ] **Step 7: Rewire `spawn_gated_restore_create`**

Replace the body of the `tokio::spawn(async move { … })` block in `crates/freshell-ws/src/create_gate.rs` (`:63-179`) with:

```rust
    tokio::spawn(async move {
        // P1 (graceful restore/resume S1): prepare — resume-identity
        // derivation + the codex managed plan — runs BEFORE the gate, so
        // permits only ever cover fast, mode-uniform PTY-spawn->settle work
        // and codex planning can no longer starve other modes' restores.
        // The restore-class plan wait is cancel-aware with no wall-clock
        // death (LaunchClass::Restore; overflow -> RATE_LIMITED).
        let prepared = match crate::terminal::prepare_launch(&create, &state, &mut cancel_rx).await
        {
            Ok(prepared) => prepared,
            Err(crate::terminal::PrepareError::Cancelled) => {
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %create.request_id,
                    "restore_create_cancelled"
                );
                // Non-settled exit: drop the dedupe sentinel (and fail any
                // cross-connection waiters loud) so a resend proceeds fresh.
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
            Err(crate::terminal::PrepareError::PlanQueueFull) => {
                let mut out = CreateOutput::Channel(&sink);
                let _ = crate::terminal::send_create_error(
                    &mut out,
                    ErrorCode::RateLimited,
                    "Too many concurrent codex launches".to_string(),
                    &create.request_id,
                )
                .await;
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
            // (No Reject arm: post-A12, prepare_launch cannot reject — the
            // claude RESTORE_UNAVAILABLE ladder runs inside handle_create,
            // after the adopt/D8 arms, exactly as today.)
            Err(crate::terminal::PrepareError::PlanFailed(message)) => {
                // Same frame this failure produced when it happened inside
                // handle_create (`error{code:PTY_SPAWN_FAILED}`).
                let mut out = CreateOutput::Channel(&sink);
                let _ = crate::terminal::send_create_error(
                    &mut out,
                    ErrorCode::PtySpawnFailed,
                    message,
                    &create.request_id,
                )
                .await;
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
        };
        // Restore-class gate wait: cancel-aware, NO timeout (D-GATE-SOFT
        // generalized: contention may not kill a restore). QueueFull still
        // fails loud (-> RATE_LIMITED via spawn_gate_error_parts); Timeout
        // is unreachable on this path. Interactive creates never ride this
        // fn and keep spawn_timeout_ms.
        let permit = match state.spawn_gate.acquire_unbounded(&mut cancel_rx).await {
            Ok(permit) => permit,
            Err(SpawnGateError::Cancelled) => {
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %create.request_id,
                    "restore_create_cancelled"
                );
                // `prepared` drops here: the RAII guard discards the sidecar.
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
            Err(err) => {
                // A prepared codex launch IS materialized now (P1 inverted
                // the old "nothing has been materialized yet" invariant);
                // dropping `prepared` on this return discards it via the
                // PreparedCodexLaunch guard. QueueFull maps to RATE_LIMITED
                // (spawn_gate_error_parts) — the ladder absorbs it.
                let (code, msg) = spawn_gate_error_parts(err);
                let mut out = CreateOutput::Channel(&sink);
                let _ = crate::terminal::send_create_error(
                    &mut out,
                    code,
                    msg.to_string(),
                    &create.request_id,
                )
                .await;
                state.create_dedupe.clear_if_in_flight(&create.request_id);
                return;
            }
        };
        // Last-instant check: the permit may have been granted a beat after
        // the client vanished. Nothing has been spawned yet — abandon
        // (dropping `prepared` discards the sidecar).
        if *cancel_rx.borrow() {
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %create.request_id,
                "restore_create_cancelled"
            );
            state.create_dedupe.clear_if_in_flight(&create.request_id);
            return;
        }
        // A10 shutdown-race pre-check (V3): kill_all snapshots ids once
        // (registry.rs:889-892); if shutdown already began, nothing has been
        // spawned yet — abandon instead of inserting a PTY the snapshot will
        // never visit. (`prepared` drops -> sidecar discarded.)
        if state
            .shutdown_started
            .load(std::sync::atomic::Ordering::SeqCst)
        {
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %create.request_id,
                "restore_create_abandoned_for_shutdown"
            );
            state.create_dedupe.clear_if_in_flight(&create.request_id);
            return;
        }
        // Permit held across PTY spawn -> registry insert -> meta/identity ->
        // terminal.created -> broadcasts (the spawn-to-settled requirement,
        // pinned by permit_released_only_after_work_completes). Codex
        // planning happens ABOVE, outside the permit — the hold is now fast
        // and mode-uniform. Replies go through the non-blocking conn sink,
        // so no stalled client can wedge the permit (the da5d9b5c hazard
        // still cannot exist on this path).
        let request_id = create.request_id.clone();
        // A5 residual signal (V3), hold side: the permit-held awaits below
        // are deadline-free (PTY spawn terminal.rs:2253-2269, association
        // fs walk :2431-2454, fsync ledger writes :2517-2545) — a wedged
        // hold would otherwise be invisible. Warn ONCE at ~30s while the
        // hold is still in flight; abort the watchdog when the hold
        // settles. Logging only — no frames, no protocol change.
        let hold_watchdog = tokio::spawn({
            let request_id = request_id.clone();
            async move {
                tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                tracing::warn!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %request_id,
                    "spawn_gate_permit_hold_slow"
                );
            }
        });
        hold_permit_across(permit, async {
            let mut out = CreateOutput::Channel(&sink);
            // Fresh limiter, never consulted: `handle_create`'s rate-limit
            // check is gated on `create.restore != Some(true)`, and this
            // path is restore:true by construction (the `if create.restore
            // == Some(true)` branch in `handle_client_text`) — so this is a
            // throwaway to satisfy the shared signature, not a live budget.
            let mut create_limiter = crate::create_limit::CreateRateLimiter::new(
                state.create_protect.rate_limit,
                state.create_protect.rate_window_ms,
            );
            let _ = crate::terminal::handle_create(
                create,
                Some(prepared),
                &mut out,
                &state,
                conn_id,
                pane_reconcile_v1,
                &mut create_limiter,
            )
            .await;
            // Covers create failure: no-op when handle_create settled the entry,
            // drops the InFlight sentinel (failing waiters loud) when it did not.
            state.create_dedupe.clear_if_in_flight(&request_id);
            // A10 shutdown-race post-check (V3): unchanged — keep the existing
            // kill_all block verbatim.
            if state
                .shutdown_started
                .load(std::sync::atomic::Ordering::SeqCst)
            {
                let killed = state.registry.kill_all();
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %request_id,
                    killed,
                    "restore_create_settled_during_shutdown_reaped"
                );
            }
        })
        .await;
        // Hold settled (fast path): silence the slow-hold watchdog.
        hold_watchdog.abort();
    });
```

(Add the needed imports: `ErrorCode` is already used in the module via `spawn_gate_error_parts`'s return; import `crate::terminal::{prepare_launch, PrepareError}` or path-qualify as shown. `prepared` is moved into the `hold_permit_across` closure together with `create` — the guard disarms inside `handle_create` via `take()`.)

Also update `crates/freshell-ws/src/create_limit.rs` doc comment (`:37-39` region): amend the "must stay far below the frozen client's ~38s ladder patience" sentence with "(interactive, REST, and auto-resume doors — the WS restore door waits unbounded-cancel-aware since graceful restore/resume S1)".

- [ ] **Step 8: Rewrite the four gate-timeout restore pins (A13, V5 §A13 — MUST land before Step 9's all-green gate, which is unsatisfiable without it)**

Gate `Timeout` is unreachable for the restore class after Step 7, so four existing pins that force it now park forever and panic on their message deadlines. Rewrite each to a timeout-free mechanism that preserves the PROPERTY it pins (read `reports/V5-harness-pins.md` §A13 for the full failure analysis):

8a. `restore_creates_are_gated_and_non_restore_bypass` (`crates/freshell-ws/tests/restore_spawn_gate.rs:315-355`) — the gate's wiring proof in the restore direction. Keep the non-restore-bypass half verbatim (zero-permit gate, plain create settles instantly). Replace the timeout half with a timeout-free wiring proof merging the cancel pattern of `queued_restore_create_is_abandoned_on_disconnect_without_spawning` (`:453-491`): send the restore create, poll until `gate.queued_total() == 1` (parked on the 0-permit gate = it consulted the gate), disconnect (`drop(client)`), poll+assert `gate.cancellations() == 1`, and `registry.kill_all() == 1` (only the bypassing plain create spawned). Drop the `gate.timeouts() == 1` and error-frame assertions; update the test's PR #552 comment to say the restore direction is now proven by queue+cancel, not timeout death.

8b. `resend_on_new_connection_never_swallowed_while_inflight` (`restore_spawn_gate.rs:738-781`) — the A2 wedge-guard property (a cross-connection duplicate waiter is NEVER silently dropped) still matters post-change, but its non-settled exit trigger can no longer be gate timeout. Rewrite with a timeout-free trigger: park the ORIGINAL create on the 0-permit gate, land the duplicate from a second connection (it registers as a waiter on the InFlight sentinel), then disconnect the ORIGINAL connection — its create exits non-settled via disconnect-cancel, and `clear_if_in_flight` must fail the cross-connection waiter LOUD on the second socket (same fail-loud frame family as today). Assert the waiter's error frame arrives on connection B and no PTY spawned.

8c. `zero_permit_gate_times_out_create_with_pinned_error_frame` (`crates/freshell-ws/tests/create_protection.rs:212-250`) — restore creates now QUEUE on a zero-permit gate instead of dying. Rewrite as a cancel-based pin (rename accordingly, e.g. `zero_permit_gate_parks_restore_create_until_disconnect_cancels`): restore create parks (no frame arrives within a short quiet-drain window), non-restore create still bypasses for an instant `terminal.created` (keep that half), then disconnect and assert the parked create is cancelled without spawning. If the file's `common::spawn_server_with_create_protect` harness does not expose the `SpawnGate` handle for `queued_total()`/`cancellations()` probes, extend it (mirror `restore_spawn_gate.rs`'s `spawn_server` return shape) or assert via no-frame + `registry` emptiness. Update its PR #552 rationale comment block (`:220-222` region): the restore-only gate scope stands, but the restore-side consequence is now queue-until-cancel, not loud timeout death (graceful restore/resume S1, D-GATE-SOFT generalization).

8d. `ws_and_rest_creates_share_one_spawn_budget` (`crates/freshell-ws/tests/rest_ws_shared_gate.rs:31-91`) — re-prove the shared-budget property timeout-free. Keep step 2 verbatim (REST door starved → 503 `SPAWN_TIMEOUT`: REST keeps the timed Interactive acquire). Replace step 3's WS-starved error-frame assertion with a queue-depth probe (send the WS restore create while the external permit is held; `queued_total` is CUMULATIVE and step 2's starved REST acquire already incremented it to 1, so poll `gate.queued_total() == 2` — or snapshot the counter before sending the WS create and poll for the +1 delta; same gate instance, so the WS door demonstrably waits on the SAME budget). Then handle V5's A13-N1 explicitly: on `drop(held)` the PARKED WS create consumes the released permit and SPAWNS — that is now the recovery proof, not a stray. Await its `terminal.created` (recovery-after-release), then the REST recovery POST (it acquires after the WS create settles and releases), then the second WS create as today. Adjust cleanup to kill EVERY spawned terminal (the formerly-starved WS create's PTY included — no stray un-killed PTY; simplest: assert `registry.kill_all()` equals the exact spawn count instead of two targeted kills).

Run:
```bash
cargo test -p freshell-ws --test restore_spawn_gate 2>&1 | tail -5
cargo test -p freshell-ws --test create_protection 2>&1 | tail -5
cargo test -p freshell-ws --test rest_ws_shared_gate 2>&1 | tail -5
```
Expected: PASS. (Task 3 Step 1 ran these files as pre-change pin snapshots — correct then, since Task 3 changed no gate behavior; THIS step is where they are rewritten, and only after it may Step 9's all-green gate run.)

- [ ] **Step 9: Full verification of the rewire**

(Node-deps precondition from Global Constraints must already hold — `test -f node_modules/tsx/dist/loader.mjs || npm ci --no-audit --no-fund` in the worktree root — or the `freshell-ws` codex-create tests fail environmentally at MCP injection.)

```bash
cargo fmt --all
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings 2>&1 | tail -3
cargo test -p freshell-freshagent 2>&1 | tail -5
cargo test -p freshell-ws 2>&1 | tail -10
```
Expected: all green — this gate runs AFTER Step 8's pin rewrites (without them it is unsatisfiable: four pins force the now-unreachable restore-path gate Timeout, V5 §A13). Pay special attention to `restore_spawn_gate.rs` (the two cancel/shutdown-drain pins `queued_restore_create_is_abandoned_on_disconnect_without_spawning` and `queued_restore_creates_drain_without_spawning_on_shutdown` MUST stay green: `acquire_unbounded` preserves cancel semantics), `claude_restore_unavailable.rs` (unchanged frames: the claude ladder still runs inside `handle_create` at its original post-adopt/attach position — A12), and `auto_resume_respawn.rs` (Interactive class, unchanged).

- [ ] **Step 10: Commit (cites D-GATE-SOFT — required by spec §9.1)**

```bash
git add crates/freshell-ws crates/freshell-freshagent crates/freshell-codex
git commit -m "feat(ws): restore creates plan codex launches BEFORE the spawn-gate permit

Graceful restore/resume S1, P1: prepare_launch (resume-identity derivation
+ codex managed plan, LaunchClass::Restore) runs before spawn_gate.acquire,
so permits cover only fast mode-uniform PTY-spawn->settle work — codex
planning can no longer starve shell/claude/opencode restores. The restore
gate wait is now acquire_unbounded (cancel-aware, no 10s death); QueueFull
still fails loud as RATE_LIMITED. Prepared-but-unadopted sidecars are
discarded on EVERY early exit via the PreparedCodexLaunch RAII guard.

Scoped per the load-bearing review: only resume-planned codex restores are
prepared pre-gate (A4: fresh plans arm a 45s candidate-capture timer at
proxy start — no-session codex restores keep today's on-permit Interactive
planning); the claude P0.4 ladder stays post-adopt/attach in handle_create
(A12); the four gate-timeout restore pins are rewritten timeout-free (A13);
warn-level slow-wait/slow-hold tracing replaces the deleted 10s ops signal
(A5 accepted residual).

D-GATE-SOFT generalized: the gate may not kill a live pane; now contention
may not kill a restore. Permit scope spawn->settle unchanged (da5d9b5c
class pinned by permit_released_only_after_work_completes)."
```

---

### Task 5: Restore-storm integration pins (the mandate test)

**Files:**
- Create: `crates/freshell-ws/tests/restore_storm.rs`
- Create: `crates/freshell-ws/tests/restore_plan_queue_cap.rs`
- Modify (only if needed): `crates/freshell-ws/Cargo.toml` — ensure `futures` is in `[dev-dependencies]` (for `BoxFuture` in the fake runtime impl).

**Interfaces:**
- Consumes: Task 2's `set_global_codex_launch_manager_for_tests`; Task 1's `with_plan_budget(factory, 2, wait, cap)` + `plan_queue_depth()`; the `CodexLaunchRuntime` trait; the `restore_spawn_gate.rs` harness (`spawn_server`, `connect_and_hello`, `send_text` — copy verbatim per that file's convention).
- Produces: test-only code.

**Test-harness ground rules (from the repo's own precedents):**
- Copy `spawn_server` from `crates/freshell-ws/tests/restore_spawn_gate.rs:76-163` verbatim, then add a `codex` sleeper CLI spec to `cli_commands`. Sleeper scripts MUST use a unique-per-call path (append a per-call counter/UUID to the filename), NOT the shared `{name}-{pid}` shape — the `1839b11e` ETXTBSY fix.
- **MCP precondition (V6-N1, corrected in fresheyes iteration 1):** there is NO settings- or env-level MCP off-switch. `settings.codingCli.mcpServer` is never read in the create path — it is only declared (`freshell-protocol/src/settings.rs:80`), defaulted (`freshell-server/src/settings.rs:44`), and key-whitelisted (`freshell-server/src/settings_store.rs:1467-1471`) — so pinning `"mcpServer": false` in a test settings fixture is a NO-OP; do not rely on it. `handle_create` runs `generate_mcp_injection` unconditionally for every non-shell mode (`terminal.rs:2043-2063`), and the codex arm requires `<worktree_root>/node_modules/tsx/dist/loader.mjs` (`mcp_inject.rs:123-128`); without it every codex create dies at MCP injection with `PTY_SPAWN_FAILED "Unable to resolve MCP dependency \"tsx\""` BEFORE spawn (this is exactly how `codex_session_ref_resume` fails in a bare worktree). The ONLY mechanism that makes these storm binaries (and every existing codex-create test) runnable is the Global Constraints environment precondition — node deps installed in the worktree root (`test -f node_modules/tsx/dist/loader.mjs || npm ci --no-audit --no-fund`) BEFORE the test gates. Copy `test_settings_value()` (`restore_spawn_gate.rs:22-40`) verbatim, leaving `"mcpServer": true` untouched (the value is inert). Without the precondition, "12 settle with zero error frames" fails for a reason unrelated to anything this slice changes.
- **Fresh-plan consistency (A4):** every storm codex frame carries a `sessionRef` (`codex_restore_frame` below), so every storm codex create derives a resume session id and is resume-planned PRE-GATE (`LaunchClass::Restore`) — consistent with the A4 exclusion (only a no-session codex restore, which no storm test sends, plans on-permit Interactive). Do not add a sessionRef-less codex restore frame to these binaries without also accepting that it exercises the inline Interactive path instead of the plan queue.
- Copy `connect_and_hello` (`:165-208`) verbatim INCLUDING `set_nodelay(true)` (load-bearing for bursts) and `send_text`.
- One installed global manager per test binary (set-once). All test fns in `restore_storm.rs` share it: budget `with_plan_budget(factory, 2, Duration::from_secs(30), 64)`; the shared fake runtime is switchable via atomics; serialize test fns with a `static TEST_LOCK: tokio::sync::Mutex<()>` (via `OnceLock`) and reset counters at each test start.
- **One shared tokio runtime for the WHOLE binary (fresheyes iteration 3):** write every test fn in `restore_storm.rs` as `#[test] fn name() { storm_rt().block_on(async { ... }); }` on a `static OnceLock<tokio::runtime::Runtime>` (multi-thread, `enable_all`) — NOT `#[tokio::test]`. Reason: the manager arms its adopted-terminal teardown worker lazily, ONCE, on whichever runtime first runs `plan_create_with_retry` (`ensure_teardown_worker`, Task 1 step 3g; today the arming is the `OnceLock` sender at `launch_lifecycle.rs:467` armed at `:513`, with a DETACHED `tokio::spawn` worker at `:632-643` whose `JoinHandle` is discarded). Under per-test `#[tokio::test]` runtimes that worker dies when the first arming test's runtime drops, and every later `notify_terminal_exit` hand-off is silently swallowed (`let _ = ...send(..)`, `launch_lifecycle.rs:602-612`) — adopted teardowns from later tests would never run, `shutdown_calls` would never reach its expected totals, and the drain rule below would time out. One never-dropped shared runtime keeps the worker alive for the whole binary.
- **Teardown-drain rule (fresheyes iteration 3 — plugs the cross-test `shutdown_calls` bleed):** killing an ADOPTED codex terminal tears the sidecar down ASYNCHRONOUSLY — the kill path only QUEUES the teardown (the kill drops the `PtyTerminal`, whose `Drop` joins the reader thread, `pty.rs:440-453`; the reader's EOF hook runs `notify_terminal_exit`, `freshell-ws/src/terminal.rs:1333-1337`, which sends on the worker channel and returns), and the detached worker increments `shutdown_calls` some time AFTER `kill_all()` returns. Without a drain those late increments land after `TEST_LOCK` is released and corrupt the NEXT test's exact-count `shutdown_calls` asserts (the discard-arm tests). Therefore: every test that kills adopted codex terminals (the mandate storm and the deterministic-failure storm) MUST call `drain_adopted_teardowns(c, N).await` (harness helper below; N = number of ADOPTED codex terminals) after its final `kill_all()` assertion and before returning. The drain is deterministic, not a wall-clock bet: because the reader-thread join happens inside the kill, every teardown send is already queued when `kill_all()` returns — the poll only waits for the live worker to execute the queued shutdowns. Within-test exact `shutdown_calls` asserts (the discard arms) still belong BEFORE any `kill_all`, in tests where nothing was adopted.

- [ ] **Step 1: Write the harness + shared runtime**

`crates/freshell-ws/tests/restore_storm.rs` skeleton (fill the copied parts as instructed):

```rust
//! Graceful restore/resume S1 — the mandate's integration pins (spec §8):
//! a restore storm of 8 codex + 4 shell creates in one burst produces ZERO
//! user-facing error frames, all 12 panes, shells settling before the codex
//! backlog drains (proof that planning is off-permit), and plan concurrency
//! never exceeding the budget of 2. Plus: deterministic plan failure stays
//! loud for THAT create only; disconnect/shutdown/queue-full paths discard
//! prepared sidecars (fake runtime records spawn/teardown pairs).
//!
//! REAL axum server + REAL tokio-tungstenite client (the
//! restore_spawn_gate.rs harness convention), with the codex launch manager
//! globally installed over a fake runtime (set-once per process).

use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// [copy: imports, AUTH_TOKEN, test_settings_value, sleeper_cli_spec (with
//  unique-per-call script path), spawn_server (+ codex spec), TestWs,
//  connect_and_hello, send_text — from restore_spawn_gate.rs]

/// Switchable fake codex runtime shared by every test in this binary.
struct StormControls {
    plan_delay_ms: AtomicU64,
    park: AtomicBool,                       // park plans on `release` instead of sleeping
    release: tokio::sync::Notify,
    fail_cwd: Mutex<Option<String>>,        // plans for this cwd ALWAYS fail
    in_flight: AtomicUsize,
    peak: AtomicUsize,
    plans_started: AtomicU64,
    shutdown_calls: AtomicU64,
}

impl StormControls {
    fn reset(&self) {
        self.plan_delay_ms.store(0, Ordering::SeqCst);
        self.park.store(false, Ordering::SeqCst);
        *self.fail_cwd.lock().unwrap() = None;
        self.in_flight.store(0, Ordering::SeqCst);
        self.peak.store(0, Ordering::SeqCst);
        self.plans_started.store(0, Ordering::SeqCst);
        self.shutdown_calls.store(0, Ordering::SeqCst);
    }
}

struct StormRuntime {
    c: Arc<StormControls>,
}

impl freshell_codex::launch_lifecycle::CodexLaunchRuntime for StormRuntime {
    fn ensure_ready(
        &self,
        cwd: Option<String>,
    ) -> futures::future::BoxFuture<'_, Result<freshell_codex::launch_lifecycle::CodexRuntimeReady, String>>
    {
        Box::pin(async move {
            self.c.plans_started.fetch_add(1, Ordering::SeqCst);
            if let Some(fail) = self.c.fail_cwd.lock().unwrap().clone() {
                if cwd.as_deref() == Some(fail.as_str()) {
                    return Err("codex app-server unavailable (storm negative pin)".to_string());
                }
            }
            let now = self.c.in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.c.peak.fetch_max(now, Ordering::SeqCst);
            if self.c.park.load(Ordering::SeqCst) {
                self.c.release.notified().await;
            } else {
                let delay = self.c.plan_delay_ms.load(Ordering::SeqCst);
                if delay > 0 {
                    tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
                }
            }
            self.c.in_flight.fetch_sub(1, Ordering::SeqCst);
            // Real loopback upstream so the planned proxy relays against a
            // live socket: delegate to a FakeRuntime copied from
            // crates/freshell-codex/tests/launch_lifecycle.rs:36-124.
            let inner = FakeRuntime::start().await;
            inner.ensure_ready(cwd).await
        })
    }
    fn shutdown(&self) -> futures::future::BoxFuture<'_, Result<(), String>> {
        self.c.shutdown_calls.fetch_add(1, Ordering::SeqCst);
        Box::pin(async { Ok(()) })
    }
    // Copy any remaining trait methods from FakeRuntime's impl verbatim
    // (match the trait definition in launch_lifecycle.rs — e.g. the
    // ownership-update hook is a recording no-op).
}

/// Install the manager once per process; return the shared controls.
fn storm_controls() -> &'static Arc<StormControls> {
    static CONTROLS: OnceLock<Arc<StormControls>> = OnceLock::new();
    CONTROLS.get_or_init(|| {
        let controls = Arc::new(StormControls { /* zeroed fields, Notify::new() */ });
        let factory_controls = controls.clone();
        let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::with_plan_budget(
            Box::new(move || {
                Arc::new(StormRuntime { c: factory_controls.clone() })
                    as Arc<dyn freshell_codex::launch_lifecycle::CodexLaunchRuntime>
            }),
            2,
            std::time::Duration::from_secs(30),
            64,
        );
        assert!(
            freshell_codex::launch_lifecycle::set_global_codex_launch_manager_for_tests(manager),
            "storm binary must be the first global() toucher in this process"
        );
        controls
    })
}

fn test_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

/// One tokio runtime for the WHOLE binary, never dropped: the manager's
/// lazily-armed teardown worker (see ground rules) must outlive every test
/// fn, so every test is `#[test] fn .. { storm_rt().block_on(async { .. }); }`
/// instead of `#[tokio::test]`.
fn storm_rt() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
            .expect("storm runtime")
    })
}

/// Ground-rule drain: block until the manager's async teardowns of ADOPTED
/// codex terminals have all executed, so no late `shutdown_calls` increment
/// can bleed past TEST_LOCK into the next test's exact-count asserts.
/// Deterministic (see ground rules): `kill_all()` joins each PTY reader
/// thread, whose exit hook queues the teardown — every send is already on
/// the worker channel when this poll starts; it only waits for execution.
/// Call after the final `kill_all()` in every test that adopted codex
/// terminals (`expected_total` = adopted count; counters reset at start).
async fn drain_adopted_teardowns(c: &StormControls, expected_total: u64) {
    for _ in 0..400 {
        if c.shutdown_calls.load(Ordering::SeqCst) >= expected_total {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    }
    assert_eq!(
        c.shutdown_calls.load(Ordering::SeqCst),
        expected_total,
        "all adopted-terminal teardowns must drain before releasing TEST_LOCK"
    );
}

/// `terminal.create` frames. Codex restores carry identity in sessionRef
/// (the frozen client's shape — codex_session_ref_resume.rs precedent).
fn codex_restore_frame(request_id: &str, session_id: &str, cwd: Option<&str>) -> String {
    let mut v = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "codex",
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": session_id },
    });
    if let Some(cwd) = cwd {
        v["cwd"] = serde_json::json!(cwd);
    }
    v.to_string()
}

fn shell_restore_frame(request_id: &str) -> String {
    format!(
        r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system","restore":true}}"#
    )
}

/// Drain frames until `expected` terminal.created arrive or `deadline`
/// passes. PANICS on any `error` frame (the mandate) and on any
/// output-family frame before attach (A21). Returns (requestId, terminalId)
/// in ARRIVAL ORDER — the fairness assertion's substrate.
async fn drain_created(ws: &mut TestWs, expected: usize, deadline: std::time::Duration) -> Vec<(String, String)> {
    let start = tokio::time::Instant::now();
    let mut created: Vec<(String, String)> = Vec::new();
    while created.len() < expected {
        let remaining = deadline
            .checked_sub(start.elapsed())
            .unwrap_or_else(|| panic!("deadline: only {}/{expected} settled", created.len()));
        let msg = tokio::time::timeout(remaining, futures_util::StreamExt::next(ws))
            .await
            .unwrap_or_else(|_| panic!("deadline: only {}/{expected} settled", created.len()))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let v: serde_json::Value = serde_json::from_str(text).expect("json frame");
            let t = v["type"].as_str().unwrap_or("");
            assert!(
                t != "error",
                "user-facing error frame during the storm (mandate violation): {v}"
            );
            assert!(
                t != "terminal.output" && t != "terminal.outputBatch",
                "output before attach breaks the A21 causal invariant: {v}"
            );
            if t == "terminal.created" {
                created.push((
                    v["requestId"].as_str().expect("requestId").to_string(),
                    v["terminalId"].as_str().expect("terminalId").to_string(),
                ));
            }
        }
    }
    created
}
```

- [ ] **Step 2: Write the five test fns**

All five run on the shared `storm_rt()` runtime (`#[test]` + `block_on` — ground rules); the sketch keeps bodies at their original indentation inside `block_on(async { ... });`, `cargo fmt` settles the final shape.

```rust
/// THE mandate pin (spec §8), DETERMINISTIC park/release form (V5 §A10):
/// one burst of 8 codex + 4 shell restore creates -> zero error frames,
/// all 12 settle, and while every codex plan is PARKED the 4 shells all
/// settle — fairness is STRUCTURAL (codex parked => shells cannot starve),
/// not a wall-clock bet. The previous 500ms plan_delay shape eroded
/// one-sidedly under CI load: the fake plan sleep is load-INVARIANT while
/// PTY spawn is load-SENSITIVE, so only the shell side of the race
/// stretches. Plan concurrency <= 2 throughout.
#[test]
fn restore_storm_settles_all_twelve_with_zero_error_frames_and_no_shell_starvation() {
    storm_rt().block_on(async {
    let _serial = test_lock().lock().await;
    let c = storm_controls();
    c.reset();
    c.park.store(true, Ordering::SeqCst); // NO plan_delay: plans park on `release`
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;

    // Codex burst FIRST (worst case for shells), then shells — one burst.
    for i in 0..8 {
        let sid = uuid::Uuid::new_v4().to_string();
        send_text(&mut client, &codex_restore_frame(&format!("codex-{i}"), &sid, None)).await;
    }
    for i in 0..4 {
        send_text(&mut client, &shell_restore_frame(&format!("shell-{i}"))).await;
    }

    // Drain EXACTLY 4 terminal.created while all codex plans are parked:
    // they must all be shells (zero error frames enforced by drain_created).
    let created = drain_created(&mut client, 4, std::time::Duration::from_secs(30)).await;
    assert!(
        created.iter().all(|(rid, _)| rid.starts_with("shell-")),
        "only shells can settle while codex plans are parked: {created:?}"
    );

    // Structural queue state while parked: 2 plans hold the budget, 6 queued.
    let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
    for _ in 0..400 {
        if c.plans_started.load(Ordering::SeqCst) == 2 && manager.plan_queue_depth() == 6 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    // NOTE: plans_started is CUMULATIVE (fetch_add, reset only in reset());
    // at this instant it equals the 2 currently parked plans, but never
    // use it as an "in flight" gauge — that is what in_flight is for.
    assert_eq!(
        c.plans_started.load(Ordering::SeqCst),
        2,
        "exactly 2 plans started (both parked on the budget)"
    );
    assert_eq!(manager.plan_queue_depth(), 6, "6 plans queued behind the budget");

    // Wave-structured release (deterministic): notify_waiters releases only
    // the CURRENTLY parked ensure_ready bodies (Notify stores no permit for
    // future waiters), so 8 codex plans on a 2-permit budget drain in 4
    // waves of exactly 2. Per wave: poll until BOTH permits are held by
    // parked plans, release them, drain exactly their 2 created frames
    // (drain_created panics on any error frame — the zero-error mandate —
    // and on deadline, so a wedged wave fails loud, never hangs).
    let mut settled = created;
    for wave in 1..=4u32 {
        for _ in 0..400 {
            if c.in_flight.load(Ordering::SeqCst) == 2 {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
        assert_eq!(
            c.in_flight.load(Ordering::SeqCst),
            2,
            "wave {wave}: both budget permits must be held by parked plans"
        );
        c.release.notify_waiters();
        settled.extend(drain_created(&mut client, 2, std::time::Duration::from_secs(30)).await);
    }
    assert_eq!(settled.len(), 12, "all 12 panes must be created");
    let peak = c.peak.load(Ordering::SeqCst);
    assert!(peak <= 2, "plan concurrency exceeded the budget: {peak}");
    assert_eq!(registry.kill_all(), 12, "exactly 12 PTYs, no duplicates");
    drain_adopted_teardowns(c, 8).await; // 8 adopted codex sidecars — ground-rule drain
    });
}

/// Negative pin (spec §8, adapted to S1's zero-protocol scope — the
/// errorClass discriminator is Slice 2): a deterministic per-create plan
/// failure is loud for THAT create only; the other 11 are unaffected.
#[test]
fn deterministic_plan_failure_is_loud_for_that_create_only() {
    storm_rt().block_on(async {
    let _serial = test_lock().lock().await;
    let c = storm_controls();
    c.reset();
    c.plan_delay_ms.store(100, Ordering::SeqCst);
    let doomed_cwd = std::env::temp_dir().join("freshell-storm-doomed");
    std::fs::create_dir_all(&doomed_cwd).expect("mk doomed cwd");
    let doomed_cwd = doomed_cwd.to_string_lossy().to_string();
    *c.fail_cwd.lock().unwrap() = Some(doomed_cwd.clone());

    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    for i in 0..8 {
        let sid = uuid::Uuid::new_v4().to_string();
        let cwd = (i == 2).then_some(doomed_cwd.as_str());
        send_text(&mut client, &codex_restore_frame(&format!("codex-{i}"), &sid, cwd)).await;
    }
    for i in 0..4 {
        send_text(&mut client, &shell_restore_frame(&format!("shell-{i}"))).await;
    }
    // Custom drain: 11 created + EXACTLY the one expected error frame.
    let mut created = 0usize;
    let mut errors: Vec<serde_json::Value> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(60);
    while created < 11 || errors.is_empty() {
        let remaining = deadline
            .checked_duration_since(tokio::time::Instant::now())
            .unwrap_or_else(|| panic!("deadline: created={created} errors={errors:?}"));
        let msg = tokio::time::timeout(remaining, futures_util::StreamExt::next(&mut client))
            .await
            .unwrap_or_else(|_| panic!("deadline: created={created} errors={errors:?}"))
            .expect("stream not ended")
            .expect("no ws error");
        if let WsMessage::Text(text) = &msg {
            let v: serde_json::Value = serde_json::from_str(text).expect("json frame");
            match v["type"].as_str().unwrap_or("") {
                "terminal.created" => created += 1,
                "error" => errors.push(v),
                _ => {}
            }
        }
    }
    assert_eq!(errors.len(), 1, "exactly one loud error: {errors:?}");
    assert_eq!(errors[0]["requestId"], serde_json::json!("codex-2"));
    assert_eq!(
        errors[0]["code"],
        serde_json::json!("PTY_SPAWN_FAILED"),
        "unanticipatable plan failure keeps today's loud code: {}",
        errors[0]
    );
    assert_eq!(registry.kill_all(), 11, "the doomed create must not spawn");
    drain_adopted_teardowns(c, 7).await; // 7 adopted (codex-2 never produced a sidecar)
    *c.fail_cwd.lock().unwrap() = None;
    });
}

/// T11 extension + discard arms (1)/(3): disconnect mid-storm drains the
/// plan queue with no PTY spawns and no further plans; the two in-flight
/// plans complete and are DISCARDED (fake runtime records the teardowns).
#[test]
fn disconnect_mid_storm_drains_queue_without_spawns_and_discards_prepared_launches() {
    storm_rt().block_on(async {
    let _serial = test_lock().lock().await;
    let c = storm_controls();
    c.reset();
    c.park.store(true, Ordering::SeqCst);
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    for i in 0..8 {
        let sid = uuid::Uuid::new_v4().to_string();
        send_text(&mut client, &codex_restore_frame(&format!("codex-{i}"), &sid, None)).await;
    }
    // Wait until 2 plans hold the budget and 6 queue behind it.
    let manager = freshell_codex::launch_lifecycle::CodexTerminalLaunchManager::global();
    for _ in 0..400 {
        if c.plans_started.load(Ordering::SeqCst) == 2 && manager.plan_queue_depth() == 6 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(c.plans_started.load(Ordering::SeqCst), 2, "2 plans in flight");
    assert_eq!(manager.plan_queue_depth(), 6, "6 plans queued");

    drop(client); // disconnect: cancel watch fires for all 8 tasks

    // Queued waiters drain as Cancelled (no plan ever starts for them)...
    for _ in 0..400 {
        if manager.plan_queue_depth() == 0 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(manager.plan_queue_depth(), 0, "plan queue must drain on disconnect");
    // ...then release the 2 parked plans: their creates are cancelled, so
    // the prepared launches must be DISCARDED (arm 1/3), never spawned.
    c.release.notify_waiters();
    for _ in 0..400 {
        if c.shutdown_calls.load(Ordering::SeqCst) == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(
        c.shutdown_calls.load(Ordering::SeqCst),
        2,
        "both completed-but-cancelled plans must be torn down"
    );
    assert_eq!(c.plans_started.load(Ordering::SeqCst), 2, "no further plans after disconnect");
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
    });
}

/// Discard arm (2): a prepared launch whose gate acquire rejects QueueFull
/// gets RATE_LIMITED (ladder absorbs) and the sidecar is torn down.
#[test]
fn gate_queue_full_after_prepare_sends_rate_limited_and_discards_the_sidecar() {
    storm_rt().block_on(async {
    let _serial = test_lock().lock().await;
    let c = storm_controls();
    c.reset();
    // 0 permits + 0 queue cap: the FIRST gated waiter rejects QueueFull.
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(CreateProtectConfig::default(), SpawnGate::new(0, 0)).await;
    let mut client = connect_and_hello(&ws_url).await;
    let sid = uuid::Uuid::new_v4().to_string();
    send_text(&mut client, &codex_restore_frame("qf-0", &sid, None)).await;
    // Expect exactly one RATE_LIMITED error frame for qf-0 (reuse the
    // next_json_of_type helper copied from restore_spawn_gate.rs:233-248).
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["requestId"], serde_json::json!("qf-0"));
    assert_eq!(err["code"], serde_json::json!("RATE_LIMITED"));
    for _ in 0..400 {
        if c.shutdown_calls.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(c.shutdown_calls.load(Ordering::SeqCst), 1, "prepared sidecar discarded");
    assert_eq!(registry.kill_all(), 0, "no PTY spawned");
    });
}

/// Discard arm (4): shutdown beginning between prepare and spawn abandons
/// the create silently and discards the prepared sidecar.
#[test]
fn shutdown_after_prepare_abandons_silently_and_discards_the_sidecar() {
    storm_rt().block_on(async {
    let _serial = test_lock().lock().await;
    let c = storm_controls();
    c.reset();
    c.park.store(true, Ordering::SeqCst);
    let (ws_url, registry, _shutdown, _gate, shutdown_started) =
        spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).await;
    let mut client = connect_and_hello(&ws_url).await;
    let sid = uuid::Uuid::new_v4().to_string();
    send_text(&mut client, &codex_restore_frame("sd-0", &sid, None)).await;
    for _ in 0..400 {
        if c.plans_started.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(c.plans_started.load(Ordering::SeqCst), 1, "plan in flight");
    shutdown_started.store(true, Ordering::SeqCst); // A10 pre-check trips next
    c.release.notify_waiters();
    for _ in 0..400 {
        if c.shutdown_calls.load(Ordering::SeqCst) == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(c.shutdown_calls.load(Ordering::SeqCst), 1, "prepared sidecar discarded");
    assert_eq!(registry.kill_all(), 0, "no PTY spawned during shutdown");
    // Silent: drain the socket briefly and assert no error frame arrived.
    let quiet = tokio::time::timeout(
        std::time::Duration::from_millis(500),
        futures_util::StreamExt::next(&mut client),
    )
    .await;
    if let Ok(Some(Ok(WsMessage::Text(text)))) = quiet {
        let v: serde_json::Value = serde_json::from_str(&text).expect("json");
        assert_ne!(v["type"], serde_json::json!("error"), "shutdown abandon must be silent: {v}");
    }
    });
}
```

And `crates/freshell-ws/tests/restore_plan_queue_cap.rs` (own binary — it needs a DIFFERENT installed manager, cap 0):

```rust
//! Plan-queue overflow -> RATE_LIMITED on the WS restore door (graceful
//! restore/resume S1, P2 backstop). Own binary: the installed global
//! manager here has concurrency 0 / queue cap 0 so the FIRST restore-class
//! plan overflows deterministically.
// [harness copies as in restore_storm.rs, minus StormControls — a plain
//  FakeRuntime factory suffices]

#[tokio::test(flavor = "multi_thread")]
async fn plan_queue_overflow_maps_to_rate_limited_on_the_ws_restore_door() {
    // Install: with_plan_budget(fake_factory, 0, Duration::from_millis(50), 0)
    // via set_global_codex_launch_manager_for_tests — assert it returns true.
    // spawn_server(CreateProtectConfig::default(), SpawnGate::new(4, 64)).
    // Send ONE codex restore create.
    // Expect: exactly one error frame, code == "RATE_LIMITED",
    // requestId matches; registry.kill_all() == 0; the fake runtime's
    // ensure_ready was NEVER called (plans_started == 0 — overflow happens
    // before any plan runs).
}
```
Write the body fully following the storm file's helpers (it is the same harness with a different manager and one create).

- [ ] **Step 3: Run the new binaries**

```bash
cargo test -p freshell-ws --test restore_storm 2>&1 | tail -15
cargo test -p freshell-ws --test restore_plan_queue_cap 2>&1 | tail -5
```
Expected: PASS (5 tests + 1 test). These pins verify Task 4's implementation; if the shells-settle-while-parked drain fails, planning is still on-permit — fix Task 4, not the test. Sanity-check the pins bite: temporarily revert the `create_gate.rs` prepare-before-acquire hunk (`git stash` the change or flip `Some(prepared)` back to inline planning) and confirm `restore_storm_settles_all_twelve...` FAILS — with planning back on-permit, the parked codex plans hold gate permits, so the first `drain_created(.., 4, ..)` cannot complete (shells starve behind parked planners, structurally, not by timing) — then restore.

- [ ] **Step 4: Full workspace gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo test -p freshell-ws 2>&1 | tail -10
```
Expected: clean; all `freshell-ws` binaries green.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/tests crates/freshell-ws/Cargo.toml
git commit -m "test(ws): restore-storm pins — zero error frames, off-permit fairness, prepared-sidecar discard

Spec §8 integration pins for graceful restore/resume S1: 8 codex + 4 shell
burst settles all 12 with zero user-facing errors, shells settle before the
codex backlog drains (planning off-permit), plan concurrency <= 2;
deterministic plan failure stays loud for that create only; disconnect/
shutdown/queue-full paths tear prepared sidecars down; plan-queue overflow
maps to RATE_LIMITED."
```

---

### Task 6: Decision-record addendum + final gates

**Files:**
- Modify: `docs/plans/2026-07-27-rest-spawn-gate.md` (append after the §D-C ADDENDUM block that ends at `:129`)

**Interfaces:**
- Consumes: the shipped Tasks 1–5.
- Produces: coherent decision records (spec §9.2/§9.3; DEVIATIONS.md is explicitly Slice 4's job, per spec §7 — do NOT touch `port/oracle/DEVIATIONS.md` here).

- [ ] **Step 1: Append the addendum**

In `docs/plans/2026-07-27-rest-spawn-gate.md`, immediately after the existing `§D-C ADDENDUM` block (its residual note reads: *"WS restore-creates still plan under the caller-held permit (`create_gate.rs`) … Revisit if a restore-fleet incident implicates it."* at `:127-129`), append:

```markdown
### D-C ADDENDUM 2 (2026-07-30 — graceful restore/resume S1)

The residual recorded above is discharged. The revisit condition fired: the
S5.e managed-launch default flip made codex planning (sidecar spawn + proxy
start, seconds each; up to a 30s budget wait) run under the caller-held
permit for every WS restore-create, and the bounce analysis showed a
>=5-codex-tab restore storm starving shell/claude/opencode restores into the
10s queue-timeout death (spec: docs/plans/2026-07-30-graceful-restore-resume.md,
F1/F2).

As of S1, WS restore-creates run a **prepare phase** (pure resume-identity
derivation + `plan_codex_managed_launch`, `LaunchClass::Restore`) BEFORE
`spawn_gate.acquire` (`create_gate.rs`). Two scope guards from the S1
load-bearing review: only resume-planned codex restores prepare pre-gate
(a fresh plan arms a 45s candidate-capture timer at proxy start —
`remote_proxy.rs:248-258` — so no-session codex restores keep on-permit
Interactive planning), and the claude restore ladder stays inside
`handle_create` after the adopt/D8 arms (its liveness reads presume those
arms ran first). This adopts what §D-C's "latency
exposure" DECISION rejected as alternative (a) — plan-before-acquire with
discard-on-rejection — because the ground has moved since 2026-07-27: the
sidecar planning budget (concurrency 2) now bounds concurrent plans, and the
prepared launch is discarded on EVERY early exit by an RAII guard
(`PreparedCodexLaunch`), not by hand-audited cleanup.

Unchanged and still load-bearing:
- The permit scope still brackets PTY spawn -> settle exactly (the da5d9b5c
  regression class cannot recur; pinned by
  `permit_released_only_after_work_completes`, `create_gate.rs`).
- The REST door is untouched by S1: it plans before its own acquire (D-C-R
  2026-07-30, above) with `LaunchClass::Interactive` fail-fast semantics and
  the same bounded `acquire_uncancellable` wait.
- "Rejection needs NO cleanup" now holds only for the REST/interactive
  doors; the WS restore door's rejections DO hold a prepared sidecar, which
  the RAII guard discards.

The WS restore door's gate wait is now `acquire_unbounded` (cancel-aware, no
wall-clock death; QueueFull still fails loud as RATE_LIMITED). Timeout death
for restores is gone by design — see the D-GATE-SOFT generalization in the
S1 spec ("contention may not kill a restore").
```

- [ ] **Step 2: Run the FULL gates (the branch's exit state)**

```bash
cd /home/dan/code/freshell/.worktrees/graceful-restore-resume-s1
test -f node_modules/tsx/dist/loader.mjs || npm ci --no-audit --no-fund
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings 2>&1 | tail -3
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings 2>&1 | tail -3
cargo test --workspace 2>&1 | tail -20
```
Expected: fmt/clippy clean; workspace tests green. If the ONLY failure is `pane_ledger::tests::new_locked_degrades_to_disabled_when_another_holder_exists` in the `freshell-ws` lib target, re-run it alone (`cargo test -p freshell-ws --lib pane_ledger`) and record it as the documented f3wp/s52d flake — it is NOT this branch's regression. Any other failure blocks completion.

- [ ] **Step 3: Commit (leave the branch unmerged)**

```bash
git add docs/plans/2026-07-27-rest-spawn-gate.md
git commit -m "docs: §D-C ADDENDUM 2 — WS restore planning moved off-permit (graceful restore/resume S1)"
```

Do NOT merge, do NOT push to main. The branch is reviewed as-is by the workflow's later stages.

---

## Self-Review Record

Run against the spec (`docs/plans/2026-07-30-graceful-restore-resume.md` §7 Slice 1, §8, §9) and the task mandate:

1. **Spec coverage:** P1 extraction + pre-permit prepare → Tasks 3+4; every-early-exit discard → Task 4 (RAII guard, deliberately stronger than the spec's 4-arm enumeration — rationale recorded in File Structure) + Task 5 pins for arms 1/2/3/4; `LaunchClass::{Interactive,Restore}` with cancel-aware unbounded restore wait, structural bound, cap→RATE_LIMITED → Tasks 1+4; interactive 2/30s fail-fast preserved → Task 1 (pinned by the retained `third_concurrent_plan_fails_fast...`); restore-class spawn-gate wait → Task 4 (`acquire_unbounded`); freshagent one-liner → Task 1 Step 4b; §8 storm test (zero error frames, 12 panes, all shells settle while codex plans are parked — the deterministic A10 form — concurrency ≤2, disconnect drain) → Task 5; D-C-REVISIT/A14 coherence → Task 1 comment rewrites (no literal "A14" comment exists in freshell-codex — the D-C-REVISIT blocks at `launch_lifecycle.rs:453` and `terminal_tabs.rs:993` are the real targets, verified by exploration) + Task 6 addendum; full Rust gates + flake note + unmerged branch → Task 6. Slices 2/3/4 excluded everywhere.
2. **No silent deferrals:** the spec §8 negative pin's `errorClass:'contention'` assertion belongs to Slice 2's wire field; S1's adaptation (exactly one `PTY_SPAWN_FAILED` for the doomed create, zero error frames otherwise) pins the same S1-observable behavior without protocol changes — this is the spec's own slicing (§7), not a scope reduction. The auto-resume respawn door staying Interactive is likewise the spec's own S3 boundary (§4 P4). No stubs or fakes stand in for production behavior: fake codex runtimes are test harnesses injected through a production seam whose production default (`global()` → real runtime) is untouched.
3. **Placeholder scan:** two deliberate "copy from `<file:line>` verbatim" instructions remain (FakeRuntime trait-impl remainder; restore_spawn_gate harness) — these reference existing, located code per this repo's test-harness copy convention, not unwritten code. The one `let mode = /* copy handle_create's mode expression */` marker in Task 4 Step 5 is the same class: the expression exists at `terminal.rs:1578-1586` and MUST be copied, not invented, so the two sites cannot diverge.
4. **Type consistency:** `LaunchClass` (Task 1) is consumed by Tasks 4/5 with the same path; `with_plan_budget(.., queue_cap)` 4-arg form used in Tasks 1/2/5; `plan_queue_depth()` used in Tasks 1/5; `discard_sync`/`set_global_codex_launch_manager_for_tests` (Task 2) used in Tasks 4/5; `derive_launch_prep(&TerminalCreate, &str) -> LaunchPrep` (infallible, Task 3) consistent with Task 4's `prepare_launch` and inline uses; `PreparedLaunch{prep, codex_launch: Option<PreparedCodexLaunch>}`, `PrepareError::{PlanQueueFull,Cancelled,PlanFailed}` (no `Reject` — A12), `PlanLaunchError::{QueueFull,Cancelled,Failed}` consistent across Task 4's steps; `acquire_unbounded(&mut watch::Receiver<bool>)` consistent between its definition, tests, and `create_gate.rs` use.
