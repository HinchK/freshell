# Rust WSL Crash Hardening Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Bound restore-storm PTY spawns with a cancellable, spawn-to-settled
concurrency gate in `freshell-ws`, and make `freshell-server` handle SIGHUP
gracefully while logging best-effort shutdown forensics (signal + /proc
parent-chain) so external kills become attributable.

**Architecture:** Two independent hardening tracks against the WSL-outage RCA
(`docs/plans/2026-07-06-wsl-outage-rca.md` on the `fix/wsl-crash-hardening`
worktree). Track 1 adds three new modules to `crates/freshell-ws`
(`create_limit.rs` config + per-connection rate limiter, `spawn_gate.rs`
server-wide FIFO semaphore gate with cancellable acquire, `create_gate.rs`
the spawned gated-create path) and reroutes `restore:true` creates through a
spawned task that holds a gate permit from before PTY spawn until the
`terminal.created` frame + broadcasts are queued ("settled"). Track 2 adds
`crates/freshell-server/src/shutdown_forensics.rs` (pure /proc walker,
injectable proc root) and extends `shutdown_signal()` with a SIGHUP arm plus
a forensics log emitted before any teardown step.

**Tech Stack:** Rust (edition 2021, MSRV 1.96), tokio (`sync`/`time`/`signal`
features already enabled — `Semaphore`, `watch`, `Notify`), axum WebSockets,
`tracing` JSONL logging, `tempfile` + `tokio-tungstenite` test harnesses.
**No new dependencies anywhere** — no `tokio-util`, no `nix`.

## Global Constraints

Copied from repo policy (`AGENTS.md`, `port/AGENTS.md`) and the spec — every
task implicitly includes these:

- Base branch: the checked-out worktree branch (`feat/rust-wsl-crash-hardening`,
  branched from `feat/rust-tauri-port`) — NOT `main`. Never open a PR.
- FROZEN read-only paths: `server/`, `shared/`, `src/`, `dist/client`. This
  plan touches only `crates/` and `docs/plans/`. If any task appears to need a
  client change — STOP and surface it.
- Structural limits: ≤1,000 lines per file, ≤10,000 LOC per crate. New
  behavior goes in NEW modules (`terminal.rs` is already 2,520 lines — only
  surgical edits there).
- `crates/freshell-terminal` is contractually tokio-free. Do not add tokio or
  the gate to it. The gate lives in `crates/freshell-ws`.
- No new workspace dependencies. `tokio::sync::{Semaphore, watch, Notify}`
  and `std::fs` cover everything.
- TDD: Red-Green-Refactor for every non-trivial change; never skip refactor.
- Checks that must pass before every commit:
  - `cargo fmt --all -- --check`
  - `cargo clippy --workspace --all-targets` (no NEW warnings)
  - `cargo test -p <touched crates>` (workspace-wide in the final task)
- Kill/destructive test suites run in the Docker sandbox:
  `scripts/sandbox-test.sh "cargo test -p <crate> --test <name>"`. If the
  sandbox is unavailable in the execution environment, running on host is
  acceptable ONLY for suites that signal processes they spawned themselves
  (the existing `safe11_term22_shutdown_reaping.rs` precedent). Never
  broad-kill, never touch ports 3001/3002 or processes you did not spawn.
- Commits: Conventional Commits, ASCII subject, body bullets + a
  `Verification:` paragraph naming the exact commands run, and the mandatory
  footer (two `-m` paragraphs shown in each commit step).
- Env vars follow the bare `TERMINAL_*` family and the sanitizing-parse
  convention (unset/unparseable/0/negative → default).
- Wire-visible divergence from the legacy Node server is a port defect unless
  additive. The per-connection create rate limit (Task 5) is legacy parity
  (`server/ws-handler.ts:2376-2389`); the restore gate and SIGHUP/forensics
  are additive hardening (legacy gained the same in `fix/wsl-crash-hardening`).
- Prior art: branch `feat/rust-create-protection` (commit `da5d9b5c`,
  worktree `/home/dan/code/freshell/.worktrees/rust-create-protection`).
  Reused: semaphore + queue-cap + timeout gate skeleton, rate limiter,
  error-code mapping, test shapes. **Deliberate divergences (spec-mandated):**
  1. The permit is held from before PTY spawn through "settled" (the
     `terminal.created` frame + broadcasts queued), not dropped right after
     the spawn syscall — prior art's early release made the gate cover only a
     ~0.3 ms syscall, leaving the actual restore-storm cost unbounded.
     Holding to settled is safe here because the gated path replies through
     the connection's non-blocking mpsc frame sink, never awaiting client
     socket I/O under the permit (the exact hazard `da5d9b5c` fixed on the
     inline path does not exist on the spawned path).
  2. `acquire` is cancellable (client disconnect / server shutdown), so a
     queued create whose client vanished is abandoned WITHOUT spawning a PTY.
  3. Only `restore == Some(true)` creates pass through the gate — prior art
     gated all creates. Non-restore creates keep today's inline path plus the
     per-connection rate limit.
  4. Gate env vars are named `TERMINAL_RESTORE_SPAWN_*` (spec name,
     `TERMINAL_*` family) instead of `FRESHELL_SPAWN_GATE_*`.

**Non-goals (explicitly out of scope, with reasons — not silent deferrals):**
- REST spawn paths (`POST /api/tabs`, `/split`, `/respawn` via
  `freshell-freshagent`) do not carry a `restore` flag; restore-flagged
  creates arrive only via the WS `terminal.create` message, so the WS gate
  covers 100% of the spec's target ("restore-flagged terminal creates").
- Moving `registry.create` onto `spawn_blocking` (prior art did this) is not
  required by the spec and enlarges blast radius (exit-hook + borrow rework);
  the gate bounds how many blocking spawns can pile up, which is the spec's
  requirement.
- Forensics fields `uptimeSeconds`/`runningTerminals` from the Node reference
  are not ported: the spec requires "which signal was received, plus a /proc
  parent-chain walk", the reference is explicitly "design reference only, do
  not transliterate", and `runningTerminals` would require a new cross-crate
  registry accessor (YAGNI).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/create_limit.rs` | Create | `CreateProtectConfig` (env knobs) + `CreateRateLimiter` (per-connection sliding window) + `epoch_ms()` |
| `crates/freshell-ws/src/spawn_gate.rs` | Create | `RestoreSpawnGate`: FIFO semaphore, queue cap, timeout, cancellable acquire, counters |
| `crates/freshell-ws/src/create_gate.rs` | Create | `CreateOutput` reply sink + `spawn_gated_restore_create` (the spawned, permit-holding, cancellable restore path) + gate→error-frame mapping |
| `crates/freshell-ws/src/lib.rs` | Modify | `pub mod` declarations; `WsState` gains `create_protect` + `spawn_gate`; `state()` test helper updated |
| `crates/freshell-ws/src/terminal.rs` | Modify | pub(crate) visibility for `WsSink`/`send`; `handle_create`/`send_create_error` take `CreateOutput`; per-connection cancel watch + rate-limit + dispatch branch in `run`/`handle_client_text` |
| `crates/freshell-server/src/main.rs` | Modify | Boot wiring of config + gate; SIGHUP arm + forensics call in `shutdown_signal()`; `mod shutdown_forensics;` |
| `crates/freshell-server/src/shutdown_forensics.rs` | Create | `/proc` stat parser + parent-chain walker (injectable proc root) + `log_shutdown_forensics` |
| `crates/freshell-ws/tests/restore_spawn_gate.rs` | Create | Real-socket integration proof: gating, bypass, rate limit, disconnect cancellation, shutdown drain |
| `crates/freshell-ws/tests/*.rs` (11 existing files) | Modify | Add the two new `WsState` fields to each literal |
| `crates/freshell-server/tests/sighup_forensics.rs` | Create | Real-binary integration proof: SIGHUP → graceful exit 0 + forensics JSONL line |

Known `WsState` literal sites the compiler will flag (add the two fields to
every one; the list below is from a fresh audit — trust the compiler over the
list): `crates/freshell-ws/src/lib.rs:636` (`fn state()`), inline
`state_with_bus()` helpers in `crates/freshell-ws/src/terminal.rs` (~:2226
and ~:2423 test modules), and `let state = WsState {` in each of
`crates/freshell-ws/tests/{codex_managed_launch_e2e.rs:119,
codex_session_ref_resume.rs:112, diag01_lifecycle_events.rs:136,
freshagent_claude_kill_interrupt.rs:171, hello_timeout.rs:56, keepalive.rs:57,
max_payload.rs:57, origin_policy.rs:47, safe08_restore_diagnostics.rs:143,
session_identity_frames.rs:97, term09_output_queue.rs:50}`.

---

### Task 1: `create_limit.rs` — protection config + per-connection rate limiter

**Files:**
- Create: `crates/freshell-ws/src/create_limit.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (one `pub mod` line only)

**Interfaces:**
- Consumes: nothing (leaf module; std + tracing only).
- Produces (later tasks rely on these exact signatures):
  - `pub struct CreateProtectConfig { pub rate_limit: usize, pub rate_window_ms: u64, pub restore_spawn_concurrency: usize, pub restore_spawn_queue_cap: usize, pub restore_spawn_timeout_ms: u64 }` with `Default` (10 / 10_000 / 4 / 64 / 10_000) and `pub fn from_env() -> Self`
  - `pub struct CreateRateLimiter` with `pub fn new(limit: usize, window_ms: u64) -> Self` and `pub fn try_acquire(&mut self, now_ms: u64) -> bool`
  - `pub fn epoch_ms() -> u64`

- [ ] **Step 1: Write the module with failing (RED) tests**

Create `crates/freshell-ws/src/create_limit.rs` with the full content below.
This is an adaptation of the prior-art module (`feat/rust-create-protection`,
`crates/freshell-ws/src/create_limit.rs`) with the gate knobs renamed to the
spec's `TERMINAL_RESTORE_SPAWN_*` family:

```rust
//! Server-side `terminal.create` protection knobs + the per-connection
//! sliding-window rate limiter (legacy parity: `server/ws-handler.ts:240-241,
//! 2376-2389`).
//!
//! Legacy limiter semantics reproduced EXACTLY:
//! - default 10 creates per 10_000 ms sliding window, per WS connection
//! - env `TERMINAL_CREATE_RATE_LIMIT` / `TERMINAL_CREATE_RATE_WINDOW_MS`
//! - prune predicate is strict: a timestamp survives while `now - t < window`
//! - a REJECTED create consumes no budget (timestamps push on accept only)
//! - `restore:true` creates bypass the limiter entirely (the CALLER enforces
//!   the bypass; this type is bypass-agnostic) — they are bounded by the
//!   [`crate::spawn_gate::RestoreSpawnGate`] instead.
//!
//! Deliberate env-parsing divergence from legacy: legacy is
//! `Number(env || default)`, which silently DISABLES the limiter on an
//! unparseable value and blocks ALL creates on `'0'`. We sanitize instead:
//! unset, unparseable, zero, or negative -> default.
//!
//! The restore-spawn-gate knobs (WSL-outage RCA §6.3 hardening, no legacy
//! analogue on this branch — see [`crate::spawn_gate`]) live in the same
//! config struct to keep the `WsState` surface change to two fields.

use std::collections::VecDeque;

#[derive(Debug, Clone, Copy)]
pub struct CreateProtectConfig {
    /// Max accepted non-restore `terminal.create` per window, per connection.
    pub rate_limit: usize,
    /// Sliding-window length, ms.
    pub rate_window_ms: u64,
    /// Server-wide max concurrent restore-flagged creates (gate permits).
    pub restore_spawn_concurrency: usize,
    /// Max restore creates queued waiting on the gate before failing loud.
    pub restore_spawn_queue_cap: usize,
    /// Max wait for a gate permit before failing loud, ms. Must stay far
    /// below the frozen client's ~38s RATE_LIMITED retry-ladder patience.
    pub restore_spawn_timeout_ms: u64,
}

impl Default for CreateProtectConfig {
    fn default() -> Self {
        Self {
            rate_limit: 10,
            rate_window_ms: 10_000,
            restore_spawn_concurrency: 4,
            restore_spawn_queue_cap: 64,
            restore_spawn_timeout_ms: 10_000,
        }
    }
}

/// Sanitizing env parse (same shape as the private helpers in
/// `crate::backpressure`): unset, unparseable, zero, or negative -> default.
fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse::<u64>().ok())
        .filter(|&v| v > 0)
        .unwrap_or(default)
}

impl CreateProtectConfig {
    /// Resolve from process env. Rate-limit names mirror legacy
    /// (`server/ws-handler.ts:240-241`); the restore-spawn names are the
    /// spec's `TERMINAL_RESTORE_SPAWN_*` family.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            rate_limit: env_usize("TERMINAL_CREATE_RATE_LIMIT", d.rate_limit),
            rate_window_ms: env_u64("TERMINAL_CREATE_RATE_WINDOW_MS", d.rate_window_ms),
            restore_spawn_concurrency: env_usize(
                "TERMINAL_RESTORE_SPAWN_CONCURRENCY",
                d.restore_spawn_concurrency,
            ),
            restore_spawn_queue_cap: env_usize(
                "TERMINAL_RESTORE_SPAWN_QUEUE_CAP",
                d.restore_spawn_queue_cap,
            ),
            restore_spawn_timeout_ms: env_u64(
                "TERMINAL_RESTORE_SPAWN_TIMEOUT_MS",
                d.restore_spawn_timeout_ms,
            ),
        }
    }
}

/// Per-connection sliding window of accept timestamps (epoch ms). One
/// instance per WS connection, constructed in `terminal::run` — fresh/empty
/// on reconnect, exactly like legacy `ClientState.terminalCreateTimestamps`.
#[derive(Debug)]
pub struct CreateRateLimiter {
    timestamps: VecDeque<u64>,
    limit: usize,
    window_ms: u64,
}

impl CreateRateLimiter {
    pub fn new(limit: usize, window_ms: u64) -> Self {
        Self {
            timestamps: VecDeque::new(),
            limit,
            window_ms,
        }
    }

    /// Prune expired entries (strict `now - t < window` survival, legacy
    /// parity), then either reject (recording NOTHING) or record-and-accept.
    pub fn try_acquire(&mut self, now_ms: u64) -> bool {
        while let Some(&oldest) = self.timestamps.front() {
            if now_ms.saturating_sub(oldest) < self.window_ms {
                break;
            }
            self.timestamps.pop_front();
        }
        if self.timestamps.len() >= self.limit {
            return false;
        }
        self.timestamps.push_back(now_ms);
        true
    }
}

/// Wall-clock epoch milliseconds for limiter stamping.
pub fn epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_up_to_limit_then_rejects() {
        let mut l = CreateRateLimiter::new(10, 10_000);
        for _ in 0..10 {
            assert!(l.try_acquire(0));
        }
        assert!(!l.try_acquire(0), "11th create in the window must be rejected");
    }

    #[test]
    fn rejection_consumes_no_budget() {
        let mut l = CreateRateLimiter::new(2, 10_000);
        assert!(l.try_acquire(0));
        assert!(l.try_acquire(0));
        assert!(!l.try_acquire(1_000));
        assert!(!l.try_acquire(2_000));
        // At t=10_000 both accepted stamps (t=0) expire (strict `<`). If the
        // two REJECTIONS had been recorded, capacity would still be 0.
        assert!(l.try_acquire(10_000));
        assert!(l.try_acquire(10_000));
    }

    #[test]
    fn prune_boundary_is_strict_legacy_parity() {
        // Legacy keeps `now - t < windowMs`: at exactly `window` the stamp expires.
        let mut l = CreateRateLimiter::new(1, 10_000);
        assert!(l.try_acquire(0));
        assert!(!l.try_acquire(9_999), "at now-t=9_999 the stamp still counts");
        assert!(l.try_acquire(10_000), "at now-t=10_000 the stamp is pruned");
    }

    #[test]
    fn window_slides_per_entry() {
        let mut l = CreateRateLimiter::new(2, 10_000);
        assert!(l.try_acquire(0));
        assert!(l.try_acquire(5_000));
        assert!(!l.try_acquire(9_999));
        // t=0 expired at 10_000; t=5_000 still live; one slot free.
        assert!(l.try_acquire(10_000));
        assert!(!l.try_acquire(10_001), "5_000 and 10_000 both in window");
    }

    #[test]
    fn config_defaults() {
        let c = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, 10);
        assert_eq!(c.rate_window_ms, 10_000);
        assert_eq!(c.restore_spawn_concurrency, 4);
        assert_eq!(c.restore_spawn_queue_cap, 64);
        assert_eq!(c.restore_spawn_timeout_ms, 10_000);
    }

    #[test]
    fn config_from_env_overrides_and_zero_falls_back() {
        // `std::env::set_var` mutates whole-process state; this is the ONLY
        // test in this binary touching these five names, and it restores them.
        let names = [
            "TERMINAL_CREATE_RATE_LIMIT",
            "TERMINAL_CREATE_RATE_WINDOW_MS",
            "TERMINAL_RESTORE_SPAWN_CONCURRENCY",
            "TERMINAL_RESTORE_SPAWN_QUEUE_CAP",
            "TERMINAL_RESTORE_SPAWN_TIMEOUT_MS",
        ];
        for n in names {
            std::env::remove_var(n);
        }
        let d = CreateProtectConfig::default();

        // unset -> defaults
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, d.rate_limit);
        assert_eq!(c.restore_spawn_concurrency, d.restore_spawn_concurrency);

        // valid positive override takes effect
        std::env::set_var("TERMINAL_CREATE_RATE_LIMIT", "20");
        std::env::set_var("TERMINAL_CREATE_RATE_WINDOW_MS", "20000");
        std::env::set_var("TERMINAL_RESTORE_SPAWN_CONCURRENCY", "8");
        std::env::set_var("TERMINAL_RESTORE_SPAWN_QUEUE_CAP", "128");
        std::env::set_var("TERMINAL_RESTORE_SPAWN_TIMEOUT_MS", "20000");
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, 20);
        assert_eq!(c.rate_window_ms, 20_000);
        assert_eq!(c.restore_spawn_concurrency, 8);
        assert_eq!(c.restore_spawn_queue_cap, 128);
        assert_eq!(c.restore_spawn_timeout_ms, 20_000);

        // '0' and garbage -> fallback to default
        for n in names {
            std::env::set_var(n, "0");
        }
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.restore_spawn_concurrency, d.restore_spawn_concurrency);
        for n in names {
            std::env::set_var(n, "not-a-number");
        }
        let c = CreateProtectConfig::from_env();
        assert_eq!(c.rate_limit, d.rate_limit);

        for n in names {
            std::env::remove_var(n);
        }
    }

    #[test]
    fn epoch_ms_returns_nonzero() {
        assert!(epoch_ms() > 0);
    }
}
```

- [ ] **Step 2: Run — expect failure (module not registered)**

Run: `cargo test -p freshell-ws create_limit`
Expected: the tests do NOT run (module not declared). This is the RED state.

- [ ] **Step 3: Register the module**

In `crates/freshell-ws/src/lib.rs`, the `pub mod` declarations are a block
near the top. Insert alphabetically:

```rust
pub mod create_limit;
```

(next to the existing `pub mod backpressure;` / `pub mod identity;` etc.)

- [ ] **Step 4: Run tests — expect pass**

Run: `cargo test -p freshell-ws create_limit`
Expected: `8 passed` (all tests in `create_limit::tests`).

- [ ] **Step 5: Quality gates**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: no new warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws/src/create_limit.rs crates/freshell-ws/src/lib.rs
git commit \
  -m "feat(freshell-ws): add create-protection config and per-connection rate limiter" \
  -m "- CreateProtectConfig: TERMINAL_CREATE_RATE_LIMIT/RATE_WINDOW_MS (legacy names) + TERMINAL_RESTORE_SPAWN_CONCURRENCY/QUEUE_CAP/TIMEOUT_MS knobs, sanitizing env parse
- CreateRateLimiter: legacy-parity sliding window (strict prune, rejects cost no budget)
- Ported from feat/rust-create-protection with gate knobs renamed to the TERMINAL_RESTORE_SPAWN_* family" \
  -m "Verification: cargo test -p freshell-ws create_limit (8 passed); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: `spawn_gate.rs` — cancellable, FIFO, bounded restore-spawn gate

**Files:**
- Create: `crates/freshell-ws/src/spawn_gate.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (one `pub mod` line only)

**Interfaces:**
- Consumes: `crate::create_limit::CreateProtectConfig` (Task 1).
- Produces (later tasks rely on these exact signatures):
  - `pub struct RestoreSpawnGate` with
    `pub fn new(concurrency: usize, queue_cap: usize) -> Self`,
    `pub fn from_config(cfg: &crate::create_limit::CreateProtectConfig) -> Self`,
    `pub async fn acquire(&self, timeout: std::time::Duration, cancel: &mut tokio::sync::watch::Receiver<bool>) -> Result<tokio::sync::OwnedSemaphorePermit, SpawnGateError>`,
    counters `pub fn queued_total(&self) -> u64`, `pub fn queue_rejections(&self) -> u64`,
    `pub fn timeouts(&self) -> u64`, `pub fn cancellations(&self) -> u64`
  - `pub enum SpawnGateError { QueueFull, Timeout, Cancelled }` (`Debug, Clone, Copy, PartialEq, Eq`)
- Cancellation contract: `cancel` is a `watch::Receiver<bool>` created per WS
  connection. `acquire` returns `Err(Cancelled)` when the value is already
  `true`, when the sender sends `true`, **or when the sender is dropped**
  (the connection loop exited — disconnect, socket error, keepalive timeout,
  or server shutdown 4009). Both drop and send count.

- [ ] **Step 1: Write the module with tests (RED via unregistered module)**

Create `crates/freshell-ws/src/spawn_gate.rs`:

```rust
//! Server-wide bounded-concurrency restore-spawn gate (restart-storm
//! protection; prior art: docs/plans/2026-07-06-wsl-outage-rca.md — a
//! ~20-tab fleet respawning 50-70 processes in the same instant, and branch
//! feat/rust-create-protection commit da5d9b5c).
//!
//! Semantics:
//! - `concurrency` permits bound simultaneous restore-flagged creates
//!   server-wide, from before the PTY spawn through the terminal being
//!   settled (`terminal.created` + broadcasts queued) — the caller
//!   (`crate::create_gate`) owns that scope via the RAII permit.
//! - FIFO-fair: tokio's Semaphore hands released permits to the oldest
//!   queued waiter, so restore storms drain in arrival order (the
//!   `try_acquire_owned` fast path fails while waiters queue — no barging).
//! - Bounded queue: more than `queue_cap` waiters fails LOUD (`QueueFull`).
//! - Bounded wait: no permit within the timeout fails LOUD (`Timeout`).
//! - CANCELLABLE: a queued waiter whose per-connection cancel watch fires
//!   (or whose sender drops — the connection loop exited) unblocks with
//!   `Cancelled` immediately. This is what lets a disconnecting client or a
//!   shutting-down server abandon queued restore creates without ever
//!   spawning a PTY.
//! - RAII: the returned `OwnedSemaphorePermit` releases on drop — every
//!   completion/failure/panic path frees the permit. Never call
//!   `permit.forget()` (it permanently shrinks capacity).
//!
//! `restore:true` creates bypass the per-connection RATE limiter but go
//! through THIS gate; non-restore creates do the opposite.

use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnGateError {
    /// More than `queue_cap` creates were already waiting.
    QueueFull,
    /// No permit became available within the timeout.
    Timeout,
    /// The waiter's connection went away (disconnect or server shutdown).
    Cancelled,
}

/// Cancel-safe accounting for the `waiting` queue-depth counter: the
/// decrement lives in `Drop` so success, timeout, cancellation, and the
/// future being dropped mid-wait all reclaim the slot.
struct WaitingGuard<'a>(&'a AtomicUsize);

impl Drop for WaitingGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
pub struct RestoreSpawnGate {
    semaphore: Arc<Semaphore>,
    queue_cap: usize,
    waiting: AtomicUsize,
    queued_total: AtomicU64,
    queue_rejections: AtomicU64,
    timeouts: AtomicU64,
    cancellations: AtomicU64,
}

impl RestoreSpawnGate {
    pub fn new(concurrency: usize, queue_cap: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(concurrency)),
            queue_cap,
            waiting: AtomicUsize::new(0),
            queued_total: AtomicU64::new(0),
            queue_rejections: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
            cancellations: AtomicU64::new(0),
        }
    }

    pub fn from_config(cfg: &crate::create_limit::CreateProtectConfig) -> Self {
        Self::new(cfg.restore_spawn_concurrency, cfg.restore_spawn_queue_cap)
    }

    /// Acquire a restore-spawn permit, queueing FIFO behind other waiters.
    /// Cancellable: resolves `Err(Cancelled)` the moment `cancel` observes
    /// `true` or its sender drops.
    pub async fn acquire(
        &self,
        timeout: Duration,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<OwnedSemaphorePermit, SpawnGateError> {
        if *cancel.borrow() {
            self.cancellations.fetch_add(1, Ordering::Relaxed);
            return Err(SpawnGateError::Cancelled);
        }

        // Fast path: a free permit never queues (tokio's fair semaphore
        // fails try_acquire while waiters are queued, so no barging).
        if let Ok(permit) = self.semaphore.clone().try_acquire_owned() {
            return Ok(permit);
        }

        // Queue-depth cap: fail loud instead of unbounded queueing.
        // (fetch_add/check is approximate under races by at most the number
        // of simultaneously-arriving creates; the cap is a loud safety
        // valve, not an exact admission count.)
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
        // From here every exit path (success, timeout, cancellation, drop)
        // decrements `waiting` via the guard's Drop.
        let _waiting_guard = WaitingGuard(&self.waiting);
        self.queued_total.fetch_add(1, Ordering::Relaxed);
        tracing::info!(
            target: "freshell_ws::spawn_gate",
            waiting = waiting_before + 1,
            "spawn_gate_queued"
        );

        tokio::select! {
            acquired = tokio::time::timeout(timeout, self.semaphore.clone().acquire_owned()) => {
                match acquired {
                    Ok(Ok(permit)) => Ok(permit),
                    // The semaphore is never closed; treat close like timeout.
                    Ok(Err(_closed)) => Err(SpawnGateError::Timeout),
                    Err(_elapsed) => {
                        self.timeouts.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(
                            target: "freshell_ws::spawn_gate",
                            timeout_ms = timeout.as_millis() as u64,
                            "spawn_gate_timeout"
                        );
                        Err(SpawnGateError::Timeout)
                    }
                }
            }
            // Ok(()) = the value changed (we only ever send `true`);
            // Err(_) = the sender dropped (connection loop exited). Both
            // mean this waiter's client is gone: cancel.
            _ = cancel.changed() => {
                self.cancellations.fetch_add(1, Ordering::Relaxed);
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    "spawn_gate_cancelled"
                );
                Err(SpawnGateError::Cancelled)
            }
        }
    }

    pub fn queued_total(&self) -> u64 {
        self.queued_total.load(Ordering::Relaxed)
    }

    pub fn queue_rejections(&self) -> u64 {
        self.queue_rejections.load(Ordering::Relaxed)
    }

    pub fn timeouts(&self) -> u64 {
        self.timeouts.load(Ordering::Relaxed)
    }

    pub fn cancellations(&self) -> u64 {
        self.cancellations.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::watch;

    fn cancel_pair() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    #[tokio::test]
    async fn bounds_concurrency_to_n_and_all_complete() {
        // Spawn N+K creates, assert max in-flight == N, all complete.
        let gate = Arc::new(RestoreSpawnGate::new(2, 64));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let gate = Arc::clone(&gate);
            let in_flight = Arc::clone(&in_flight);
            let max_seen = Arc::clone(&max_seen);
            handles.push(tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                let permit = gate
                    .acquire(Duration::from_secs(5), &mut rx)
                    .await
                    .expect("permit");
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max_seen.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                in_flight.fetch_sub(1, Ordering::SeqCst);
                drop(permit);
            }));
        }
        for h in handles {
            h.await.expect("task completes");
        }
        assert_eq!(max_seen.load(Ordering::SeqCst), 2, "max in-flight must equal N");
    }

    #[tokio::test]
    async fn drains_fifo_in_arrival_order() {
        let gate = Arc::new(RestoreSpawnGate::new(1, 64));
        let (_htx, mut hrx) = cancel_pair();
        let holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");
        let order = Arc::new(tokio::sync::Mutex::new(Vec::<usize>::new()));
        let mut handles = Vec::new();
        for i in 0..4 {
            let gate = Arc::clone(&gate);
            let order = Arc::clone(&order);
            handles.push(tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                let permit = gate
                    .acquire(Duration::from_secs(5), &mut rx)
                    .await
                    .expect("permit");
                order.lock().await.push(i);
                drop(permit);
            }));
            // Give each waiter time to enqueue before the next arrives.
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(holder);
        for h in handles {
            h.await.expect("task completes");
        }
        assert_eq!(*order.lock().await, vec![0, 1, 2, 3], "restore storms drain in order");
        assert_eq!(gate.queued_total(), 4);
    }

    #[tokio::test]
    async fn queue_cap_fails_loud() {
        let gate = Arc::new(RestoreSpawnGate::new(1, 2));
        let (_htx, mut hrx) = cancel_pair();
        let _holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");
        let w1 = {
            let g = Arc::clone(&gate);
            tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                g.acquire(Duration::from_secs(5), &mut rx).await
            })
        };
        let w2 = {
            let g = Arc::clone(&gate);
            tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                g.acquire(Duration::from_secs(5), &mut rx).await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await; // let them enqueue
        let (_tx3, mut rx3) = cancel_pair();
        let res = gate.acquire(Duration::from_secs(5), &mut rx3).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::QueueFull);
        assert_eq!(gate.queue_rejections(), 1);
        drop(_holder);
        assert!(w1.await.expect("join").is_ok());
        assert!(w2.await.expect("join").is_ok());
    }

    #[tokio::test]
    async fn timeout_fails_loud_and_leaks_no_permit() {
        let gate = RestoreSpawnGate::new(1, 64);
        let (_htx, mut hrx) = cancel_pair();
        let holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");
        let (_tx, mut rx) = cancel_pair();
        let res = gate.acquire(Duration::from_millis(50), &mut rx).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::Timeout);
        assert_eq!(gate.timeouts(), 1);
        drop(holder);
        let (_tx2, mut rx2) = cancel_pair();
        let again = gate.acquire(Duration::from_millis(500), &mut rx2).await;
        assert!(again.is_ok(), "no leaked permits after a timeout");
    }

    #[tokio::test]
    async fn already_cancelled_never_queues() {
        let gate = RestoreSpawnGate::new(1, 64);
        let (tx, mut rx) = cancel_pair();
        tx.send(true).expect("send");
        let res = gate.acquire(Duration::from_secs(5), &mut rx).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);
        assert_eq!(gate.queued_total(), 0, "a pre-cancelled acquire never queues");
    }

    #[tokio::test]
    async fn cancel_signal_unblocks_queued_waiter_and_reclaims_slot() {
        let gate = Arc::new(RestoreSpawnGate::new(1, 1));
        let (_htx, mut hrx) = cancel_pair();
        let holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");

        let (tx, rx) = cancel_pair();
        let waiter = {
            let g = Arc::clone(&gate);
            let mut rx = rx.clone();
            tokio::spawn(async move { g.acquire(Duration::from_secs(30), &mut rx).await })
        };
        // Poll until the waiter is actually queued (no tight sleep race).
        for _ in 0..200 {
            if gate.queued_total() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(gate.queued_total(), 1, "waiter must be queued before cancel");

        tx.send(true).expect("send cancel");
        let res = waiter.await.expect("join");
        assert_eq!(res.unwrap_err(), SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);

        // The cancelled wait's queue slot must be reclaimed: a fresh acquire
        // must QUEUE (and time out on the still-held permit), NOT QueueFull.
        let (_tx2, mut rx2) = cancel_pair();
        let res = gate.acquire(Duration::from_millis(50), &mut rx2).await;
        assert_eq!(
            res.unwrap_err(),
            SpawnGateError::Timeout,
            "cancelled queued wait must release its queue slot"
        );

        drop(holder);
        let (_tx3, mut rx3) = cancel_pair();
        let again = gate.acquire(Duration::from_millis(500), &mut rx3).await;
        assert!(again.is_ok(), "gate recovers after a cancelled queued wait");
    }

    #[tokio::test]
    async fn sender_drop_cancels_queued_waiter() {
        // The connection loop exiting (disconnect OR server shutdown) drops
        // the watch sender; a queued create must unblock as Cancelled.
        let gate = Arc::new(RestoreSpawnGate::new(1, 64));
        let (_htx, mut hrx) = cancel_pair();
        let _holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");

        let (tx, rx) = cancel_pair();
        let waiter = {
            let g = Arc::clone(&gate);
            let mut rx = rx.clone();
            tokio::spawn(async move { g.acquire(Duration::from_secs(30), &mut rx).await })
        };
        for _ in 0..200 {
            if gate.queued_total() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(tx); // the connection loop exited
        let res = waiter.await.expect("join");
        assert_eq!(res.unwrap_err(), SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);
    }

    #[tokio::test]
    async fn raii_drop_releases_permit() {
        let gate = RestoreSpawnGate::new(1, 64);
        let (_tx, mut rx) = cancel_pair();
        let p = gate
            .acquire(Duration::from_millis(100), &mut rx)
            .await
            .expect("first");
        drop(p);
        let (_tx2, mut rx2) = cancel_pair();
        let p2 = gate.acquire(Duration::from_millis(100), &mut rx2).await;
        assert!(p2.is_ok(), "dropping the guard frees the permit");
    }
}
```

- [ ] **Step 2: Run — expect RED (module not registered)**

Run: `cargo test -p freshell-ws spawn_gate`
Expected: 0 tests run.

- [ ] **Step 3: Register the module**

In `crates/freshell-ws/src/lib.rs`, insert alphabetically in the `pub mod`
block:

```rust
pub mod spawn_gate;
```

- [ ] **Step 4: Run tests — expect pass**

Run: `cargo test -p freshell-ws spawn_gate`
Expected: `8 passed`.

- [ ] **Step 5: Quality gates**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: no new warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws/src/spawn_gate.rs crates/freshell-ws/src/lib.rs
git commit \
  -m "feat(freshell-ws): add cancellable FIFO restore-spawn gate" \
  -m "- RestoreSpawnGate: tokio fair Semaphore + queue-depth cap + bounded wait, RAII OwnedSemaphorePermit
- NEW vs feat/rust-create-protection prior art: acquire() selects on a per-connection watch cancel signal; both an explicit send(true) and sender drop unblock queued waiters as Cancelled (WSL RCA: queued creates on a client-controlled flag must be droppable)
- Counters: queued_total/queue_rejections/timeouts/cancellations; tracing events spawn_gate_{queued,queue_full,timeout,cancelled}" \
  -m "Verification: cargo test -p freshell-ws spawn_gate (8 passed); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Wire config + gate into `WsState` and server boot

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (`WsState` struct ~lines 54-220; `fn state()` test helper ~line 636)
- Modify: `crates/freshell-server/src/main.rs` (`WsState` literal ~lines 351-377)
- Modify: `crates/freshell-ws/src/terminal.rs` (two inline `state_with_bus()` test helpers, ~:2226 and ~:2423 test modules)
- Modify: the 11 files in `crates/freshell-ws/tests/` listed in File Structure (one `WsState` literal each)

**Interfaces:**
- Consumes: `CreateProtectConfig` (Task 1), `RestoreSpawnGate` (Task 2).
- Produces: two new `WsState` fields every later task reads:
  - `pub create_protect: crate::create_limit::CreateProtectConfig`
  - `pub spawn_gate: std::sync::Arc<crate::spawn_gate::RestoreSpawnGate>`

- [ ] **Step 1: Add the fields to `WsState`**

In `crates/freshell-ws/src/lib.rs`, inside `#[derive(Clone)] pub struct
WsState { ... }`, after the existing `pub term09:
crate::backpressure::Term09Config,` field add:

```rust
    /// `terminal.create` protection knobs (per-connection rate limit +
    /// restore-spawn gate). See [`crate::create_limit::CreateProtectConfig`].
    pub create_protect: crate::create_limit::CreateProtectConfig,
    /// Server-wide restore-spawn gate (WSL-outage RCA §6.3). One per server
    /// process, shared across all WS connections.
    /// See [`crate::spawn_gate::RestoreSpawnGate`].
    pub spawn_gate: std::sync::Arc<crate::spawn_gate::RestoreSpawnGate>,
```

- [ ] **Step 2: Let the compiler find every construction site (RED)**

Run: `cargo test -p freshell-ws -p freshell-server --no-run`
Expected: FAIL with `missing fields create_protect and spawn_gate` errors at
every `WsState { ... }` literal (the sites listed in File Structure).

- [ ] **Step 3: Fix the production site in `main.rs`**

In `crates/freshell-server/src/main.rs`, immediately BEFORE the
`let ws_state = WsState {` literal (~line 351), add:

```rust
    // Resolved ONCE so the rate-limit knobs and the gate the handlers consult
    // are guaranteed to come from the same env snapshot.
    let create_protect = freshell_ws::create_limit::CreateProtectConfig::from_env();
```

and inside the literal, after `term09: freshell_ws::backpressure::Term09Config::from_env(),`:

```rust
        create_protect,
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::RestoreSpawnGate::from_config(
            &create_protect,
        )),
```

- [ ] **Step 4: Fix every test/helper construction site**

At every other flagged `WsState { ... }` literal (the `fn state()` helper in
`lib.rs`, both `state_with_bus()` helpers in `terminal.rs`, and the 11
`tests/*.rs` files), add the same two lines (inside `freshell-ws` use
`crate::` paths; in `tests/*.rs` use `freshell_ws::` paths):

```rust
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::RestoreSpawnGate::new(4, 64)),
```

Re-run `cargo test -p freshell-ws -p freshell-server --no-run` until it
compiles clean.

- [ ] **Step 5: Run the full crate test suites — expect pass (no behavior change yet)**

Run: `cargo test -p freshell-ws && cargo test -p freshell-server`
Expected: all existing tests pass unchanged.

- [ ] **Step 6: Quality gates**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets`
Expected: no new warnings.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws crates/freshell-server
git commit \
  -m "feat(freshell-ws): carry create-protection config and restore-spawn gate on WsState" \
  -m "- WsState gains create_protect + spawn_gate (one gate per server process, Arc-shared across connections)
- main.rs resolves CreateProtectConfig::from_env() once at boot, next to the term09 wiring
- All test WsState literals updated (lib.rs state(), terminal.rs state_with_bus x2, 11 tests/*.rs)" \
  -m "Verification: cargo test -p freshell-ws; cargo test -p freshell-server (all pre-existing tests pass); cargo fmt --all -- --check; cargo clippy --workspace --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: `CreateOutput` reply sink + `handle_create` refactor (pure refactor)

The gated restore path (Task 6) runs `handle_create` inside a spawned task
where the socket's `&mut WsSink` is unavailable; replies must flow through
the connection's mpsc `FrameSink` instead. This task makes `handle_create`
generic over the reply sink WITHOUT changing behavior on the inline path.

**Files:**
- Create: `crates/freshell-ws/src/create_gate.rs` (the `CreateOutput` half only; Task 6 adds the rest)
- Modify: `crates/freshell-ws/src/lib.rs` (one `pub(crate) mod` line)
- Modify: `crates/freshell-ws/src/terminal.rs` (visibility + signatures + send call sites in `handle_create`/`send_create_error`; the dispatch arm at ~:465)

**Interfaces:**
- Consumes: `crate::terminal::{WsSink, send}` (made `pub(crate)` here);
  `freshell_terminal::FrameSink` (`Arc<dyn Fn(ServerMessage) + Send + Sync>`).
- Produces (Task 6 relies on these exact signatures):
  - `pub(crate) enum CreateOutput<'a> { Socket(&'a mut crate::terminal::WsSink), Channel(&'a freshell_terminal::FrameSink) }`
    with `pub(crate) async fn send(&mut self, msg: &ServerMessage) -> bool`
  - `pub(crate) async fn handle_create(create: TerminalCreate, out: &mut CreateOutput<'_>, state: &WsState) -> bool` (in `terminal.rs`)
  - `pub(crate) async fn send_create_error(out: &mut CreateOutput<'_>, code: ErrorCode, message: String, request_id: &str) -> bool` (in `terminal.rs`)

- [ ] **Step 1: Create `create_gate.rs` with `CreateOutput` and a RED unit test**

Create `crates/freshell-ws/src/create_gate.rs`:

```rust
//! The gated restore-create path (WSL-outage RCA §6.3): reply-sink
//! abstraction (this task) + the spawned, permit-holding, cancellable
//! restore create (Task 6 adds `spawn_gated_restore_create`).

use freshell_protocol::ServerMessage;
use freshell_terminal::FrameSink;

/// Where a `terminal.create` reply goes.
pub(crate) enum CreateOutput<'a> {
    /// Direct socket sink — the inline (non-restore) path. A send failure
    /// propagates as `false`, which closes the connection (existing
    /// semantics, unchanged).
    Socket(&'a mut crate::terminal::WsSink),
    /// The connection's mpsc frame sink — the spawned (restore) path. The
    /// select loop drains it to the socket; pushing is non-blocking, so a
    /// stalled client can never wedge a gate permit. A dead connection just
    /// drops the frames.
    Channel(&'a FrameSink),
}

impl CreateOutput<'_> {
    pub(crate) async fn send(&mut self, msg: &ServerMessage) -> bool {
        match self {
            CreateOutput::Socket(ws_tx) => crate::terminal::send(ws_tx, msg).await,
            CreateOutput::Channel(sink) => {
                (sink)(msg.clone());
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn channel_output_forwards_message_and_reports_success() {
        let captured: Arc<Mutex<Vec<ServerMessage>>> = Arc::new(Mutex::new(Vec::new()));
        let sink: FrameSink = {
            let captured = Arc::clone(&captured);
            Arc::new(move |msg| captured.lock().expect("lock").push(msg))
        };
        let mut out = CreateOutput::Channel(&sink);
        let msg = ServerMessage::Pong; // any cheap variant; adjust to an
                                       // existing unit variant if Pong differs
                                       // (check freshell_protocol::ServerMessage).
        assert!(out.send(&msg).await);
        assert_eq!(captured.lock().expect("lock").len(), 1);
    }
}
```

Note for the implementer: if `ServerMessage` has no `Pong`-like unit variant,
construct the cheapest existing variant (e.g. the same `ServerMessage::Error`
shape `send_create_error` builds) — the test only asserts forwarding.

- [ ] **Step 2: Run — expect RED (module not registered / visibility errors)**

Run: `cargo test -p freshell-ws create_gate`
Expected: compile error (`crate::terminal::WsSink` is private / module not
declared). RED confirmed.

- [ ] **Step 3: Register module + widen visibility**

1. `crates/freshell-ws/src/lib.rs` — add alphabetically:

```rust
pub(crate) mod create_gate;
```

2. `crates/freshell-ws/src/terminal.rs`:
   - `type WsSink = SplitSink<WebSocket, Message>;` (~line 71) →
     `pub(crate) type WsSink = SplitSink<WebSocket, Message>;`
   - `async fn send(ws_tx: &mut WsSink, msg: &ServerMessage) -> bool` (~line 75) →
     `pub(crate) async fn send(...)` (body unchanged).

- [ ] **Step 4: Run — expect the new unit test to pass**

Run: `cargo test -p freshell-ws create_gate`
Expected: `1 passed`.

- [ ] **Step 5: Refactor `send_create_error` and `handle_create` onto `CreateOutput`**

In `crates/freshell-ws/src/terminal.rs`:

1. `send_create_error` (~line 1384) becomes:

```rust
/// Send the reference's `sendError` frame for a failed `terminal.create`
/// (`ws-handler.ts:2606-2614`): `{ code, message, requestId }`.
pub(crate) async fn send_create_error(
    out: &mut crate::create_gate::CreateOutput<'_>,
    code: ErrorCode,
    message: String,
    request_id: &str,
) -> bool {
    let msg = ServerMessage::Error(ErrorMsg {
        code,
        message,
        timestamp: crate::now_iso(),
        actual_session_ref: None,
        expected_session_ref: None,
        request_id: Some(request_id.to_string()),
        terminal_exit_code: None,
        terminal_id: None,
    });
    out.send(&msg).await
}
```

2. `handle_create` (~line 742) signature becomes:

```rust
pub(crate) async fn handle_create(
    create: TerminalCreate,
    out: &mut crate::create_gate::CreateOutput<'_>,
    state: &WsState,
) -> bool {
```

Inside the body, mechanically replace every send call site (the function is
one linear scope; there are eight `send_create_error(ws_tx, ...)` early
returns and one final `send(ws_tx, &created)`):
   - every `send_create_error(ws_tx, <code>, <msg>, &create.request_id).await`
     → `send_create_error(out, <code>, <msg>, &create.request_id).await`
   - `let sent = send(ws_tx, &created).await;`
     → `let sent = out.send(&created).await;`

Nothing else in the body changes.

3. The dispatch arm (~line 465) becomes:

```rust
        ClientMessage::TerminalCreate(create) => {
            let mut out = crate::create_gate::CreateOutput::Socket(ws_tx);
            handle_create(create, &mut out, state).await
        }
```

- [ ] **Step 6: Run the whole crate suite — pure refactor must stay green**

Run: `cargo test -p freshell-ws`
Expected: all tests pass (including the pre-existing terminal.rs inline
suites and all 11 integration files).

- [ ] **Step 7: Quality gates**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: no new warnings.

- [ ] **Step 8: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws
git commit \
  -m "refactor(freshell-ws): abstract terminal.create replies behind CreateOutput" \
  -m "- CreateOutput::Socket keeps today's inline ws_tx semantics byte-for-byte; CreateOutput::Channel routes through the connection FrameSink (non-blocking) for the upcoming spawned restore path
- handle_create/send_create_error now take CreateOutput; pub(crate) visibility for WsSink/send
- Pure refactor: no wire-visible behavior change" \
  -m "Verification: cargo test -p freshell-ws (all pre-existing tests pass + 1 new); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: Per-connection rate limit on non-restore creates (legacy parity)

The spec's design rests on "non-restore creates ... are covered by
per-connection rate limiting" — which does not exist on this branch yet, so
this task adds it (it is also legacy parity: `server/ws-handler.ts:2376-2389`
with the `if (!m.restore)` bypass). Restore creates are neither checked nor
charged.

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (`run` ~:150, `handle_client_text` signature ~:403 + call site ~:104, dispatch arm ~:465)
- Create: `crates/freshell-ws/tests/restore_spawn_gate.rs` (harness + first test; later tasks extend this file)

**Interfaces:**
- Consumes: `CreateRateLimiter`/`epoch_ms` (Task 1), `CreateOutput` (Task 4),
  `WsState.create_protect` (Task 3), `ErrorCode::RateLimited`
  (`freshell-protocol/src/common.rs:86`, serde `RATE_LIMITED`).
- Produces: `handle_client_text` gains the parameter
  `create_limiter: &mut crate::create_limit::CreateRateLimiter`
  (Task 6 adds one more parameter to the same signature).

- [ ] **Step 1: Write the failing integration test (RED)**

Create `crates/freshell-ws/tests/restore_spawn_gate.rs`. Build the harness by
copying the `spawn_server()` fixture from
`crates/freshell-ws/tests/session_identity_frames.rs` (lines ~88-134: the
`WsState` literal, settings fixture, router/axum serve on an ephemeral
loopback port, and its ws-client connect + hello helpers), with these harness
changes:

```rust
//! WSL-outage RCA §6.3 acceptance tests: the per-connection create rate
//! limit (legacy parity) and the cancellable restore-spawn gate. REAL axum
//! server + REAL tokio-tungstenite client, the session_identity_frames.rs
//! harness convention.

// ... imports copied from session_identity_frames.rs ...
use freshell_ws::create_limit::CreateProtectConfig;
use freshell_ws::spawn_gate::RestoreSpawnGate;

/// Real server on an ephemeral loopback port with injectable protection
/// knobs. Returns (ws_url, registry, shutdown_notify, gate).
async fn spawn_server(
    create_protect: CreateProtectConfig,
    gate: RestoreSpawnGate,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<tokio::sync::Notify>,
    std::sync::Arc<RestoreSpawnGate>,
) {
    let gate = std::sync::Arc::new(gate);
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    // ... construct WsState exactly as session_identity_frames.rs does,
    //     except:
    //         shutdown: std::sync::Arc::clone(&shutdown),
    //         create_protect,
    //         spawn_gate: std::sync::Arc::clone(&gate),
    // ... axum router + serve exactly as session_identity_frames.rs ...
    (ws_url, registry, shutdown, gate)
}
```

Then the first test. `terminal.create` frames are plain JSON; a shell create
needs no CLI spec:

```rust
fn create_frame(request_id: &str, restore: bool) -> String {
    if restore {
        format!(
            r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system","restore":true}}"#
        )
    } else {
        format!(
            r#"{{"type":"terminal.create","requestId":"{request_id}","mode":"shell","shell":"system"}}"#
        )
    }
}
```

(Adjust the `shell` value to whatever `session_identity_frames.rs` sends for
a plain shell create — copy its frame text.)

```rust
#[tokio::test(flavor = "multi_thread")]
async fn third_non_restore_create_in_window_is_rate_limited() {
    let cfg = CreateProtectConfig {
        rate_limit: 2,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, _gate) =
        spawn_server(cfg, RestoreSpawnGate::new(4, 64)).await;
    // connect + hello handshake (copy from session_identity_frames.rs)

    // Creates 1 and 2: accepted -> terminal.created replies.
    for i in 0..2 {
        send_text(&mut client, &create_frame(&format!("req-{i}"), false)).await;
        let reply = next_json_of_type(&mut client, "terminal.created").await;
        assert_eq!(reply["requestId"], format!("req-{i}"));
    }
    // Create 3: rejected with RATE_LIMITED, and no third terminal exists.
    send_text(&mut client, &create_frame("req-2", false)).await;
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "RATE_LIMITED");
    assert_eq!(err["requestId"], "req-2");

    assert_eq!(registry.kill_all(), 2, "only the two accepted creates spawned");
}
```

(`send_text` / `next_json_of_type` are small helpers over the
tokio-tungstenite stream — copy/adapt the frame-reading helpers from
`session_identity_frames.rs`, which reads frames and parses
`serde_json::Value` filtering by `type`.)

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: FAIL — the third create currently succeeds (`terminal.created`
arrives instead of an `error` frame).

- [ ] **Step 3: Implement the limiter check**

In `crates/freshell-ws/src/terminal.rs`:

1. In `run(...)`, next to the existing per-connection setup (~line 150 after
   `conn_sink` construction), add:

```rust
    // Per-connection `terminal.create` sliding-window rate limiter (legacy
    // parity: `ClientState.terminalCreateTimestamps`, ws-handler.ts:2376-2389)
    // — fresh/empty on every (re)connect, exactly like the original.
    let mut create_limiter = crate::create_limit::CreateRateLimiter::new(
        state.create_protect.rate_limit,
        state.create_protect.rate_window_ms,
    );
```

2. Thread it through: add `create_limiter: &mut crate::create_limit::CreateRateLimiter`
   as the last parameter of `handle_client_text` (~line 403; add
   `#[allow(clippy::too_many_arguments)]` above the fn if clippy complains)
   and pass `&mut create_limiter` at the call site inside the select loop
   (~line 104-117).

3. Replace the dispatch arm from Task 4 with:

```rust
        ClientMessage::TerminalCreate(create) => {
            if create.restore == Some(true) {
                // restore:true bypasses the per-connection rate limiter —
                // neither checked nor recorded (legacy `if (!m.restore)`).
                // It goes through the server-wide restore-spawn gate instead
                // (wired in the next task; until then, inline like before).
                let mut out = crate::create_gate::CreateOutput::Socket(ws_tx);
                handle_create(create, &mut out, state).await
            } else {
                if !create_limiter.try_acquire(crate::create_limit::epoch_ms()) {
                    tracing::warn!(
                        target: "freshell_ws::create_limit",
                        request_id = %create.request_id,
                        "terminal_create_rate_limited"
                    );
                    let mut out = crate::create_gate::CreateOutput::Socket(ws_tx);
                    return send_create_error(
                        &mut out,
                        ErrorCode::RateLimited,
                        "Too many terminal.create requests".to_string(),
                        &create.request_id,
                    )
                    .await;
                }
                let mut out = crate::create_gate::CreateOutput::Socket(ws_tx);
                handle_create(create, &mut out, state).await
            }
        }
```

- [ ] **Step 4: Run — expect pass**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: PASS.

- [ ] **Step 5: Full crate suite + quality gates**

Run: `cargo test -p freshell-ws && cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: all green, no new warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws
git commit \
  -m "feat(freshell-ws): per-connection terminal.create rate limit with restore bypass" \
  -m "- Legacy parity (ws-handler.ts:2376-2389): 10 creates / 10s sliding window per connection, rejects cost no budget, RATE_LIMITED error frame feeds the frozen client's retry ladder
- restore:true creates bypass the limiter (they are bounded by the restore-spawn gate)
- New real-socket acceptance test: third create in window is rejected, only two PTYs exist" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate; cargo test -p freshell-ws (all green); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: The gated restore path — spawn-to-settled permit, spawned task

**Files:**
- Modify: `crates/freshell-ws/src/create_gate.rs` (add `spawn_gated_restore_create` + `spawn_gate_error_parts`)
- Modify: `crates/freshell-ws/src/terminal.rs` (per-connection cancel watch in `run`; thread receiver into `handle_client_text`; restore branch of the dispatch arm)
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs` (two new tests)

**Interfaces:**
- Consumes: `RestoreSpawnGate::acquire` (Task 2), `CreateOutput` +
  `pub(crate) handle_create/send_create_error` (Task 4), `WsState:
  Clone` (derives Clone in `lib.rs`), `FrameSink` clone-ability (`Arc`).
- Produces:
  - `pub(crate) fn spawn_gated_restore_create(create: TerminalCreate, state: &WsState, conn_sink: &freshell_terminal::FrameSink, cancel_rx: tokio::sync::watch::Receiver<bool>)` in `create_gate.rs`
  - `handle_client_text` gains the parameter
    `create_cancel_rx: &tokio::sync::watch::Receiver<bool>`

- [ ] **Step 1: Write the failing integration tests (RED)**

Append to `crates/freshell-ws/tests/restore_spawn_gate.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn restore_creates_are_gated_and_non_restore_bypass() {
    // Zero-permit gate: any create that actually consults the gate can never
    // proceed. This is the wiring proof — if the gate were inert (the Node
    // attempt's failure mode), the restore create would succeed.
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 300,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    // connect + hello

    // Non-restore create BYPASSES the zero-permit gate and succeeds.
    send_text(&mut client, &create_frame("plain", false)).await;
    let reply = next_json_of_type(&mut client, "terminal.created").await;
    assert_eq!(reply["requestId"], "plain");

    // Restore create consults the gate, times out, fails loud.
    send_text(&mut client, &create_frame("restore-1", true)).await;
    let err = next_json_of_type(&mut client, "error").await;
    assert_eq!(err["code"], "PTY_SPAWN_FAILED");
    assert_eq!(err["requestId"], "restore-1");
    assert!(err["message"]
        .as_str()
        .expect("message")
        .contains("restore spawn slot"));
    assert_eq!(gate.timeouts(), 1);

    assert_eq!(registry.kill_all(), 1, "only the non-restore create spawned");
}

#[tokio::test(flavor = "multi_thread")]
async fn restore_create_holds_permit_until_settled() {
    // Gate with ONE permit. Two restore creates on the same connection: if
    // the permit were released at the spawn syscall (the da5d9b5c prior-art
    // shape), both would complete near-instantly regardless of order; what
    // we assert instead is the STRONGER wiring property that both complete
    // AND the gate saw a queued waiter (the second create had to wait for
    // the first create's FULL settle, not just its spawn).
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate) =
        spawn_server(cfg, RestoreSpawnGate::new(1, 64)).await;
    // connect + hello

    send_text(&mut client, &create_frame("r1", true)).await;
    send_text(&mut client, &create_frame("r2", true)).await;
    let first = next_json_of_type(&mut client, "terminal.created").await;
    let second = next_json_of_type(&mut client, "terminal.created").await;
    let mut ids: Vec<String> = vec![
        first["requestId"].as_str().expect("id").to_string(),
        second["requestId"].as_str().expect("id").to_string(),
    ];
    ids.sort();
    assert_eq!(ids, vec!["r1".to_string(), "r2".to_string()]);
    assert!(
        gate.queued_total() >= 1,
        "with 1 permit, the second concurrent restore create must have queued \
         behind the first create's spawn-to-settled window"
    );
    assert_eq!(registry.kill_all(), 2);
}
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: `restore_creates_are_gated_and_non_restore_bypass` FAILS (the
restore create currently succeeds inline — the gate is never consulted).

- [ ] **Step 3: Implement `spawn_gated_restore_create`**

Append to `crates/freshell-ws/src/create_gate.rs`:

```rust
use freshell_protocol::client_messages::TerminalCreate;
use freshell_protocol::ErrorCode;

use crate::spawn_gate::SpawnGateError;
use crate::WsState;

/// Map a gate rejection to the client-facing error frame parts.
/// QueueFull -> RATE_LIMITED so the frozen client's retry ladder converts
/// overload into backoff-and-retry (by the retry, the queue has drained).
/// Timeout -> PTY_SPAWN_FAILED: fail loud; the pane shows a launch error.
pub(crate) fn spawn_gate_error_parts(err: SpawnGateError) -> (ErrorCode, &'static str) {
    match err {
        SpawnGateError::QueueFull => (ErrorCode::RateLimited, "Too many terminal.create requests"),
        SpawnGateError::Timeout => (
            ErrorCode::PtySpawnFailed,
            "Timed out waiting for a restore spawn slot",
        ),
        // Cancelled never reaches the client: the connection is gone (or the
        // server is closing it with 4009). Mapped defensively anyway.
        SpawnGateError::Cancelled => (
            ErrorCode::PtySpawnFailed,
            "Terminal create cancelled during shutdown",
        ),
    }
}

/// Run one `restore:true` create through the server-wide gate on a spawned
/// task, holding the permit from BEFORE the PTY spawn until the terminal is
/// settled (`terminal.created` + broadcasts queued — the end of
/// `handle_create`). Spawning (instead of awaiting inline like non-restore
/// creates) keeps the connection's select loop polling, which is what makes
/// cancellation REAL: on disconnect or server shutdown the loop exits, the
/// per-connection cancel watch fires (send or sender drop), and every queued
/// restore create for that connection unblocks as Cancelled WITHOUT spawning
/// a PTY.
pub(crate) fn spawn_gated_restore_create(
    create: TerminalCreate,
    state: &WsState,
    conn_sink: &freshell_terminal::FrameSink,
    mut cancel_rx: tokio::sync::watch::Receiver<bool>,
) {
    let state = state.clone();
    let sink = std::sync::Arc::clone(conn_sink);
    tokio::spawn(async move {
        let timeout =
            std::time::Duration::from_millis(state.create_protect.restore_spawn_timeout_ms);
        let permit = match state.spawn_gate.acquire(timeout, &mut cancel_rx).await {
            Ok(permit) => permit,
            Err(SpawnGateError::Cancelled) => {
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    request_id = %create.request_id,
                    "restore_create_cancelled"
                );
                return; // Client gone or server shutting down: no PTY, no reply.
            }
            Err(err) => {
                let (code, msg) = spawn_gate_error_parts(err);
                let mut out = CreateOutput::Channel(&sink);
                let _ = crate::terminal::send_create_error(
                    &mut out,
                    code,
                    msg.to_string(),
                    &create.request_id,
                )
                .await;
                return;
            }
        };
        // Last-instant check: the permit may have been granted a beat after
        // the client vanished. Nothing has been spawned yet — abandon.
        if *cancel_rx.borrow() {
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %create.request_id,
                "restore_create_cancelled"
            );
            return;
        }
        // Permit held across the WHOLE async create: PTY spawn -> registry
        // insert -> meta/identity -> terminal.created -> broadcasts (the
        // spawn-to-settled requirement). Replies go through the non-blocking
        // conn sink, so no stalled client can wedge the permit — the exact
        // hazard prior art's da5d9b5c early release worked around does not
        // exist on this path.
        let mut out = CreateOutput::Channel(&sink);
        let _ = crate::terminal::handle_create(create, &mut out, &state).await;
        drop(permit);
    });
}
```

- [ ] **Step 4: Wire the cancel watch + restore branch in `terminal.rs`**

1. In `run(...)`, next to the `create_limiter` from Task 5, add:

```rust
    // Per-connection cancel signal for gated restore creates. The sender
    // lives in this function's scope, so queued gated creates are cancelled
    // when the loop exits for ANY reason — client disconnect, socket error,
    // keepalive timeout, or server shutdown (4009): the explicit send below
    // plus the sender drop at return both unblock waiters.
    let (create_cancel_tx, create_cancel_rx) = tokio::sync::watch::channel(false);
```

2. In the teardown section after the select loop (next to
   `state.registry.remove_connection(conn_id);` ~line 401), add:

```rust
    // Abandon any restore creates still queued on the spawn gate for this
    // connection (RCA hardening: never spawn a PTY for a client that is
    // gone). Redundant with the sender drop at return; explicit for clarity.
    let _ = create_cancel_tx.send(true);
```

3. Thread `create_cancel_rx` down: add
   `create_cancel_rx: &tokio::sync::watch::Receiver<bool>` as a parameter of
   `handle_client_text` and pass `&create_cancel_rx` at the call site.

4. Replace the restore branch of the dispatch arm (Task 5, Step 3.3) with:

```rust
            if create.restore == Some(true) {
                // restore:true bypasses the per-connection rate limiter —
                // neither checked nor recorded (legacy `if (!m.restore)`) —
                // and goes through the server-wide restore-spawn gate on a
                // spawned task (spawn-to-settled permit, cancellable).
                crate::create_gate::spawn_gated_restore_create(
                    create,
                    state,
                    conn_sink,
                    create_cancel_rx.clone(),
                );
                true
            } else {
```

- [ ] **Step 5: Run — expect pass**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: all tests in the file PASS.

- [ ] **Step 6: Full crate suite + quality gates**

Run: `cargo test -p freshell-ws && cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: all green, no new warnings. Known nuance to note (not fix): on the
gated path the strict same-connection `terminal.created` → `terminals.changed`
frame order is now best-effort (both drain through the connection loop from
two channels); the creating connection enqueues `created` strictly first, and
other connections already had this property. The Task 10 continuity smoke
covers the client-visible behavior.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws
git commit \
  -m "feat(freshell-ws): route restore creates through the spawn-to-settled gate" \
  -m "- restore:true creates now run on a spawned task holding a RestoreSpawnGate permit from before the PTY spawn until terminal.created + broadcasts are queued (spec: permit spans the async create, not a sync call)
- Per-connection watch cancel signal: loop exit (disconnect/shutdown) unblocks queued restore creates without spawning
- QueueFull -> RATE_LIMITED (client retry ladder), Timeout -> PTY_SPAWN_FAILED; zero-permit wiring proof + bypass + queued-settle acceptance tests" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate; cargo test -p freshell-ws (all green); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Cancellation acceptance tests — disconnect + shutdown drain

These are the spec's two REQUIRED cancellation outcomes, proven end-to-end
against the real server. They exercise machinery Task 6 built; if either
fails, fix the implementation (do not weaken the test).

**Files:**
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs` (two new tests)

**Interfaces:**
- Consumes: `spawn_server` harness (Task 5), `RestoreSpawnGate` counters
  (Task 2), the returned `shutdown` Notify (Task 5 harness).
- Produces: nothing new.

- [ ] **Step 1: Write the disconnect test, run it (RED-or-GREEN gate)**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_create_is_abandoned_on_disconnect_without_spawning() {
    // Zero-permit gate + long timeout: the restore create parks in the queue.
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    // connect + hello
    send_text(&mut client, &create_frame("doomed", true)).await;

    // Wait until the create is actually queued on the gate.
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 1, "restore create must be queued");

    // Client disconnects while queued.
    drop(client);

    // The queued create must unblock as Cancelled — not sit out its 30s
    // timeout, and not spawn.
    for _ in 0..200 {
        if gate.cancellations() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(gate.cancellations(), 1, "disconnect must cancel the queued create");
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
}
```

Run: `cargo test -p freshell-ws --test restore_spawn_gate queued_restore_create_is_abandoned`
Expected: PASS if Task 6 is correct. If it FAILS, debug the cancel plumbing
(most likely: the watch sender outliving the loop, or the select loop not
exiting on `drop(client)` — check the `Some(Err(_))`/`None` arms) and fix
until green.

- [ ] **Step 2: Write the shutdown-drain test, run it**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_creates_drain_without_spawning_on_shutdown() {
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, shutdown, gate) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    // connect + hello
    send_text(&mut client, &create_frame("draining-1", true)).await;
    send_text(&mut client, &create_frame("draining-2", true)).await;

    for _ in 0..200 {
        if gate.queued_total() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 2, "both restore creates must be queued");

    // Server-side graceful shutdown: every connection loop closes 4009,
    // which must drain the queued creates without spawning.
    shutdown.notify_waiters();

    // The client observes the 4009 close frame.
    let close = next_close_frame(&mut client).await;
    assert_eq!(close.code, 4009_u16.into());

    for _ in 0..200 {
        if gate.cancellations() == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    assert_eq!(gate.cancellations(), 2, "shutdown must drain the queue");
    assert_eq!(registry.kill_all(), 0, "no PTY may have been spawned");
}
```

(`next_close_frame` reads frames until `Message::Close(Some(frame))` — a
small helper next to `next_json_of_type`; the 4009 close-code convention is
asserted the same way `keepalive.rs`-family tests read close frames.)

Run: `cargo test -p freshell-ws --test restore_spawn_gate queued_restore_creates_drain`
Expected: PASS (same debug-until-green rule as Step 1).

- [ ] **Step 3: Full crate suite + quality gates**

Run: `cargo test -p freshell-ws && cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws/tests/restore_spawn_gate.rs
git commit \
  -m "test(freshell-ws): prove queued restore creates cancel on disconnect and shutdown" \
  -m "- Disconnect while queued: gate reports 1 cancellation, registry spawns 0 PTYs
- notify_waiters shutdown: client sees 4009, both queued creates drain without spawning
- These are the two flaw classes of the abandoned Node attempt, now pinned by real-socket tests" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate (all green); cargo test -p freshell-ws; cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 8: `shutdown_forensics.rs` — /proc parent-chain walker

**Files:**
- Create: `crates/freshell-server/src/shutdown_forensics.rs`
- Modify: `crates/freshell-server/src/main.rs` (one `mod` line)

**Interfaces:**
- Consumes: `std::fs`, `tracing` only. No new deps (`nix` stays out; tokio
  `signal` feature is already enabled — no Cargo.toml change in this plan).
- Produces (Task 9 relies on):
  - `pub fn log_shutdown_forensics(signal: &str)` — synchronous, bounded
    (≤11 tiny /proc reads), never panics, never blocks on anything but local
    pseudo-filesystem reads; degrades to `parent_chain="unavailable"` on
    platforms without /proc (macOS/Windows compile and run fine — no cfg
    gating needed in this module; the walker is platform-agnostic by return
    value, matching the Node reference).

- [ ] **Step 1: Write the module with tests (RED via unregistered module)**

Create `crates/freshell-server/src/shutdown_forensics.rs`:

```rust
//! Shutdown forensics: attribute external signals (WSL-outage RCA
//! 2026-07-06 §6.4; design reference: `server/shutdown-forensics.ts` on the
//! `fix/wsl-crash-hardening` branch).
//!
//! The 2026-07-06 WSL outages killed the server with external SIGTERMs whose
//! sender could not be identified after the fact. On shutdown we log the
//! parent-process chain: a chain already reparented to pid 1 indicates the
//! login-session host died (RCA candidate A), while a live parent chain plus
//! a SIGTERM indicates a directed kill.
//!
//! Best-effort by construction: pure sync `std::fs` reads of tiny /proc
//! files, bounded hops, no retries, no timers, no awaits — it can never
//! delay or block shutdown. On platforms without /proc the walker returns
//! `None` instead of erroring (macOS/Windows builds compile and degrade
//! gracefully; no conditional compilation needed here).

use std::path::Path;

#[derive(Debug, PartialEq, Eq)]
pub struct ProcessChainEntry {
    pub pid: i64,
    pub comm: String,
}

/// Parse a `/proc/<pid>/stat` line: `pid (comm) state ppid ...`.
/// `comm` may itself contain spaces and parentheses, so it is delimited by
/// the FIRST `(` and the LAST `)`.
fn parse_proc_stat(content: &str) -> Option<(i64, String, i64)> {
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    if close < open {
        return None;
    }
    let pid: i64 = content[..open].trim().parse().ok()?;
    let comm = content[open + 1..close].to_string();
    let mut rest = content[close + 1..].split_whitespace();
    let _state = rest.next()?;
    let ppid: i64 = rest.next()?.parse().ok()?;
    Some((pid, comm, ppid))
}

/// Walk the ppid chain starting at `start_pid`, reading `<proc_root>/<pid>/stat`.
/// Returns entries starting with the process itself, following parents up to
/// pid 1 or `max_hops` parent hops. Returns `None` when the starting process
/// cannot be read (e.g. no /proc on non-Linux); returns a TRUNCATED chain
/// when a parent disappears mid-walk (that is data, not an error).
fn collect_parent_chain(
    proc_root: &Path,
    start_pid: i64,
    max_hops: usize,
) -> Option<Vec<ProcessChainEntry>> {
    let read_stat =
        |pid: i64| std::fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok();

    let first = parse_proc_stat(&read_stat(start_pid)?)?;
    let mut chain = vec![ProcessChainEntry {
        pid: first.0,
        comm: first.1,
    }];
    let mut pid = first.0;
    let mut ppid = first.2;
    let mut hops = 0;
    while hops < max_hops && pid != 1 && ppid >= 1 {
        let Some(raw) = read_stat(ppid) else { break };
        let Some(parsed) = parse_proc_stat(&raw) else { break };
        chain.push(ProcessChainEntry {
            pid: parsed.0,
            comm: parsed.1,
        });
        pid = parsed.0;
        ppid = parsed.2;
        hops += 1;
    }
    Some(chain)
}

/// Format `12345:freshell-server <- 4242:systemd <- 1:init` (walks toward init).
fn format_chain(chain: &[ProcessChainEntry]) -> String {
    chain
        .iter()
        .map(|e| format!("{}:{}", e.pid, e.comm))
        .collect::<Vec<_>>()
        .join(" <- ")
}

/// Emit the single structured shutdown-forensics record. Never panics.
pub fn log_shutdown_forensics(signal: &str) {
    let chain = collect_parent_chain(Path::new("/proc"), std::process::id() as i64, 10);
    let parent_chain = match &chain {
        Some(entries) => format_chain(entries),
        None => "unavailable".to_string(),
    };
    tracing::info!(
        event = "shutdown_forensics",
        signal = %signal,
        parent_chain = %parent_chain,
        "shutdown forensics: parent chain walks toward init; a chain already \
         reparented to pid 1 indicates the login-session host died, a live \
         chain plus SIGTERM indicates a directed kill"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_stat(root: &Path, pid: i64, comm: &str, ppid: i64) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).expect("mkdir");
        // Real /proc stat shape: `pid (comm) state ppid pgrp ...`
        std::fs::write(dir.join("stat"), format!("{pid} ({comm}) S {ppid} 0 0 0"))
            .expect("write stat");
    }

    #[test]
    fn parses_plain_stat_line() {
        let parsed = parse_proc_stat("42 (bash) S 7 42 42 0").expect("parse");
        assert_eq!(parsed, (42, "bash".to_string(), 7));
    }

    #[test]
    fn comm_with_spaces_and_parens_uses_first_open_and_last_close() {
        let parsed =
            parse_proc_stat("99 (tmux: server (v3)) S 12 99 99 0").expect("parse");
        assert_eq!(parsed, (99, "tmux: server (v3)".to_string(), 12));
    }

    #[test]
    fn garbage_stat_returns_none() {
        assert!(parse_proc_stat("").is_none());
        assert!(parse_proc_stat("no parens here").is_none());
        assert!(parse_proc_stat(") reversed ( 1 2").is_none());
        assert!(parse_proc_stat("x (comm) S notanumber").is_none());
    }

    #[test]
    fn walks_chain_to_init() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_stat(tmp.path(), 300, "freshell-server", 200);
        write_stat(tmp.path(), 200, "bash", 100);
        write_stat(tmp.path(), 100, "sshd", 1);
        write_stat(tmp.path(), 1, "systemd", 0);
        let chain = collect_parent_chain(tmp.path(), 300, 10).expect("chain");
        let comms: Vec<&str> = chain.iter().map(|e| e.comm.as_str()).collect();
        assert_eq!(comms, vec!["freshell-server", "bash", "sshd", "systemd"]);
        assert_eq!(chain.last().expect("last").pid, 1);
    }

    #[test]
    fn missing_start_pid_returns_none() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(collect_parent_chain(tmp.path(), 12345, 10).is_none());
    }

    #[test]
    fn missing_parent_truncates_chain_instead_of_erroring() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_stat(tmp.path(), 300, "freshell-server", 200);
        // pid 200 does not exist: mid-walk failure.
        let chain = collect_parent_chain(tmp.path(), 300, 10).expect("chain");
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].comm, "freshell-server");
    }

    #[test]
    fn max_hops_bounds_the_walk() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // A pathological 20-deep chain; only max_hops=3 parents get walked.
        for pid in 0..20i64 {
            write_stat(tmp.path(), 1000 + pid, &format!("p{pid}"), 1000 + pid + 1);
        }
        let chain = collect_parent_chain(tmp.path(), 1000, 3).expect("chain");
        assert_eq!(chain.len(), 4, "start entry + 3 hops");
    }

    #[test]
    fn format_chain_walks_toward_init() {
        let chain = vec![
            ProcessChainEntry { pid: 300, comm: "freshell-server".into() },
            ProcessChainEntry { pid: 1, comm: "systemd".into() },
        ];
        assert_eq!(format_chain(&chain), "300:freshell-server <- 1:systemd");
    }
}
```

Note: `tempfile` must be a dev-dependency of `freshell-server`. Check
`crates/freshell-server/Cargo.toml` `[dev-dependencies]` — the SAFE-11 test
already uses tempdir-style isolation; if `tempfile` is not listed, add
`tempfile = "3"` to `[dev-dependencies]` (dev-only, permitted).

- [ ] **Step 2: Run — expect RED (module not registered)**

Run: `cargo test -p freshell-server shutdown_forensics`
Expected: 0 tests run.

- [ ] **Step 3: Register the module**

In `crates/freshell-server/src/main.rs`, in the alphabetized `mod` block
(lines 19-38), insert between `mod settings_store;` and `mod tabs_snapshots;`:

```rust
mod shutdown_forensics;
```

- [ ] **Step 4: Run — expect pass**

Run: `cargo test -p freshell-server shutdown_forensics`
Expected: `8 passed`. (A `dead_code` warning on `log_shutdown_forensics` is
expected until Task 9 wires it; if clippy flags it, add `#[allow(dead_code)]`
on `log_shutdown_forensics` with a `// consumed by shutdown_signal in the
next commit` comment and remove it in Task 9.)

- [ ] **Step 5: Quality gates**

Run: `cargo fmt --all && cargo clippy -p freshell-server --all-targets`
Expected: no new warnings (subject to the dead-code note above).

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-server
git commit \
  -m "feat(freshell-server): add shutdown-forensics /proc parent-chain walker" \
  -m "- Pure std::fs stat parser (first-open/last-close comm delimiting) + bounded ppid walk (max 10 hops, truncate on mid-walk failure, None when /proc absent)
- log_shutdown_forensics emits one tracing event=shutdown_forensics line with signal + pid:comm chain; sync, bounded, never panics, never delays shutdown
- Injectable proc root for tests (tempfile fixtures); non-Linux degrades to parent_chain=unavailable with no cfg gating" \
  -m "Verification: cargo test -p freshell-server shutdown_forensics (8 passed); cargo fmt --all -- --check; cargo clippy -p freshell-server --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 9: SIGHUP arm + forensics wiring + real-binary acceptance test

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (`shutdown_signal`, ~lines 800-850)
- Create: `crates/freshell-server/tests/sighup_forensics.rs`

**Interfaces:**
- Consumes: `shutdown_forensics::log_shutdown_forensics` (Task 8);
  `tokio::signal::unix::SignalKind::hangup()` (tokio `signal` feature already
  enabled — NO Cargo change); `libc` (already a `cfg(unix)` dependency of
  `freshell-server`) for `libc::kill` in the test.
- Produces: SIGHUP now triggers the same graceful shutdown as SIGTERM/SIGINT
  (axum `with_graceful_shutdown` → 4009 WS drain → `registry.kill_all()` →
  exit 0), and every shutdown signal logs one `shutdown_forensics` line
  BEFORE any teardown step.

- [ ] **Step 1: Write the failing integration test (RED)**

Create `crates/freshell-server/tests/sighup_forensics.rs`. Clone the harness
from `crates/freshell-server/tests/safe11_term22_shutdown_reaping.rs`: copy
its `discover_server_binary()` (verbatim below for reference), `find_sibling`,
stderr-drain helper, isolated tempdir-home env setup, ephemeral-port boot, and
`/api/health` readiness poll. The new test differs only in the signal sent
and the log assertion:

```rust
//! WSL-outage RCA §6.4 acceptance: SIGHUP (what a dying terminal/session
//! host sends) triggers a GRACEFUL shutdown — previously it killed the
//! process with no log at all — and the shutdown emits one attributable
//! forensics line. Black-box against the real binary (freshell-server is
//! [[bin]]-only), the safe11_term22_shutdown_reaping.rs harness convention.
#![cfg(unix)]

use std::path::PathBuf;
use std::process::Command;

// discover_server_binary()/find_sibling copied from
// tests/safe11_term22_shutdown_reaping.rs:37-53 (FRESHELL_SERVER_BIN env
// override -> sibling of the test binary -> `cargo build --bin
// freshell-server` fallback).
fn discover_server_binary() -> PathBuf {
    if let Some(explicit) = std::env::var_os("FRESHELL_SERVER_BIN") {
        return PathBuf::from(explicit);
    }
    let suffix = std::env::consts::EXE_SUFFIX;
    if let Some(found) = find_sibling(suffix) {
        return found;
    }
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let status = Command::new(env!("CARGO"))
        .args(["build", "--bin", "freshell-server"])
        .current_dir(&manifest_dir)
        .status()
        .expect("spawn `cargo build --bin freshell-server`");
    assert!(status.success(), "cargo build --bin freshell-server failed");
    find_sibling(suffix).expect("freshell-server binary not found even after building it")
}

#[tokio::test(flavor = "multi_thread")]
async fn sighup_triggers_graceful_shutdown_and_logs_forensics() {
    let binary = discover_server_binary();
    let home = tempfile::tempdir().expect("tempdir home");
    // Boot exactly as safe11_term22_shutdown_reaping.rs does: same env vars
    // (isolated home, ephemeral PORT, AUTH_TOKEN), same /api/health poll.
    let mut child = /* spawn + wait-for-health, copied from safe11 */;
    let pid = child.id() as i32;

    // SIGHUP the server (a process this test spawned itself).
    unsafe {
        assert_eq!(libc::kill(pid, libc::SIGHUP), 0, "kill(SIGHUP) failed");
    }

    // Graceful exit with status 0 within the 5s hard-timeout window.
    let status = wait_with_timeout(&mut child, std::time::Duration::from_secs(5));
    assert!(status.success(), "SIGHUP must produce a graceful 0 exit, got {status:?}");

    // One forensics line landed in the JSONL server log before teardown.
    let log_path = home
        .path()
        .join(".freshell")
        .join("logs")
        .join("rust-server.jsonl");
    let log = std::fs::read_to_string(&log_path)
        .unwrap_or_else(|e| panic!("read {}: {e}", log_path.display()));
    let forensics_line = log
        .lines()
        .find(|l| l.contains("shutdown_forensics"))
        .expect("a shutdown_forensics line must be logged on SIGHUP");
    assert!(forensics_line.contains("SIGHUP"), "line must name the signal: {forensics_line}");
    assert!(
        forensics_line.contains("parent_chain"),
        "line must carry the parent chain: {forensics_line}"
    );
}
```

Implementer notes: (a) copy `find_sibling`, the spawn/env block, the health
poll, and a `wait_with_timeout` (poll `child.try_wait()` in a loop) from
`safe11_term22_shutdown_reaping.rs` — that file is the authoritative harness
for env-var names (which var sets the isolated home) and boot flags; adjust
`log_path` to whatever home variable that harness sets if it uses
`FRESHELL_HOME` rather than `HOME`. (b) `libc` is available to this crate's
integration tests via the existing `[target.'cfg(unix)'.dependencies] libc`.

- [ ] **Step 2: Run — expect FAIL (SIGHUP kills the process, no log line)**

Run: `scripts/sandbox-test.sh "cargo test -p freshell-server --test sighup_forensics"`
(host fallback per Global Constraints: `cargo test -p freshell-server --test sighup_forensics`)
Expected: FAIL — the child dies from unhandled SIGHUP (non-zero exit /
signal death) and no `shutdown_forensics` line exists.

- [ ] **Step 3: Implement the SIGHUP arm + forensics call**

In `crates/freshell-server/src/main.rs`, replace the body of
`shutdown_signal` (~lines 802-850; the const, watchdog, notify, and 250 ms
flush are UNCHANGED — only the arms and the two lines after the select
change):

```rust
async fn shutdown_signal(notify_ws: Arc<tokio::sync::Notify>) {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };

    #[cfg(unix)]
    let terminate = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    // RCA 2026-07-06 §6.4: SIGHUP is what a dying terminal/session host
    // sends; without a handler the process dies immediately with no
    // shutdown log at all.
    #[cfg(unix)]
    let hangup = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::hangup()) {
            Ok(mut sig) => {
                sig.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let hangup = std::future::pending::<()>();

    let signal_name: &'static str = tokio::select! {
        _ = ctrl_c => "SIGINT",
        _ = terminate => "SIGTERM",
        _ = hangup => "SIGHUP",
    };

    // Forensics FIRST, before any teardown step, so the record survives even
    // if teardown hangs. Sync + bounded (a handful of tiny /proc reads) —
    // it cannot meaningfully delay arming the watchdog below.
    shutdown_forensics::log_shutdown_forensics(signal_name);

    // SAFE-11 fail-safe watchdog: ... (existing code below this point is
    // UNCHANGED: tokio::spawn watchdog -> notify_ws.notify_waiters() ->
    // 250ms sleep)
```

If Task 8 added a temporary `#[allow(dead_code)]` on
`log_shutdown_forensics`, remove it now.

- [ ] **Step 4: Run — expect pass**

Run: `scripts/sandbox-test.sh "cargo test -p freshell-server --test sighup_forensics"`
(host fallback as above)
Expected: PASS.

- [ ] **Step 5: Regression: the existing SIGTERM reaping suite must stay green**

Run: `scripts/sandbox-test.sh "cargo test -p freshell-server --test safe11_term22_shutdown_reaping"`
(host fallback as above)
Expected: PASS — SIGTERM behavior unchanged (plus it now logs forensics too).

- [ ] **Step 6: Full crate suite + quality gates**

Run: `cargo test -p freshell-server && cargo fmt --all && cargo clippy -p freshell-server --all-targets`
Expected: all green, no new warnings.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-server
git commit \
  -m "feat(freshell-server): handle SIGHUP gracefully and log shutdown forensics" \
  -m "- shutdown_signal gains a cfg(unix) SignalKind::hangup() arm; select now yields the signal name (SIGINT/SIGTERM/SIGHUP)
- One shutdown_forensics tracing line (signal + /proc pid:comm parent chain) emitted before the watchdog, WS 4009 drain, and registry reaping
- Real-binary acceptance test: SIGHUP -> exit 0 within 5s + forensics line in rust-server.jsonl; safe11 SIGTERM suite stays green
- No Cargo changes: tokio signal feature and libc were already present" \
  -m "Verification: cargo test -p freshell-server --test sighup_forensics (sandbox); cargo test -p freshell-server --test safe11_term22_shutdown_reaping (sandbox); cargo test -p freshell-server; cargo fmt --all -- --check; cargo clippy -p freshell-server --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 10: Workspace verification sweep

**Files:**
- Modify: only whatever the checks flag (expected: nothing).

**Interfaces:**
- Consumes: everything above. Produces: a green workspace.

- [ ] **Step 1: Formatting + lints across the workspace**

Run: `cargo fmt --all -- --check && cargo clippy --workspace --all-targets`
Expected: clean / no new warnings. Fix any fallout (formatting only via
`cargo fmt --all`).

- [ ] **Step 2: Full workspace test run**

Run: `cargo test --workspace`
Expected: all green. (If any suite in the workspace is kill/destructive-
flagged, run it via `scripts/sandbox-test.sh "cargo test -p <crate>"` per
Global Constraints.)

- [ ] **Step 3: Continuity smoke (client-visible restore behavior)**

Run: `npm run smoke:continuity`
Expected: PASS within ~5 minutes. This is the end-user-story check that the
restore flow (the thing the gate throttles) still restores every tab against
the frozen client, covering the Task 6 frame-ordering nuance.

- [ ] **Step 4: Commit (only if fixes were needed)**

If Steps 1-3 required changes:

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add -A crates
git commit \
  -m "fix(rust): workspace verification fallout for wsl crash hardening" \
  -m "- <describe each fix in one bullet>" \
  -m "Verification: cargo fmt --all -- --check; cargo clippy --workspace --all-targets (no new warnings); cargo test --workspace (all green); npm run smoke:continuity (pass)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

If nothing needed fixing, no commit — record the check results in the task
notes instead.

---

## Spec Coverage Map (self-review record)

| Spec requirement | Covering task(s) | Production proof |
|---|---|---|
| Bound concurrent restore-flagged creates | 2, 3, 6 | zero-permit wiring proof + bypass test (real socket) |
| FIFO fairness | 2 | `drains_fifo_in_arrival_order` unit test on tokio's fair semaphore |
| Default concurrency 4, env `TERMINAL_RESTORE_SPAWN_CONCURRENCY` (repo `TERMINAL_*` convention) | 1, 3 | `config_defaults` + `config_from_env_overrides_and_zero_falls_back`; wired once at boot in `main.rs` |
| Permit held across the ASYNC create, spawn → registered/settled (not a sync wrapper) | 6 | permit scope = the spawned task around `handle_create` (spawn → created frame + broadcasts); `restore_create_holds_permit_until_settled` + zero-permit proof kill the inert-gate failure mode |
| Cancellation: disconnect abandons queued create without spawning | 2, 6, 7 | `queued_restore_create_is_abandoned_on_disconnect_without_spawning` (real socket, registry count 0) |
| Cancellation: shutdown drains queued creates without spawning | 6, 7 | `queued_restore_creates_drain_without_spawning_on_shutdown` (4009 + registry count 0) |
| Non-restore creates bypass the gate, covered by per-connection rate limiting | 5, 6 | bypass asserted in the zero-permit test; limiter proven by `third_non_restore_create_in_window_is_rate_limited` |
| Prior art examined; reuse + documented divergences | Global Constraints | divergence rationale recorded (spawn-to-settled, cancellable, restore-only scope, env names) |
| SIGHUP as graceful-shutdown trigger | 9 | real-binary SIGHUP → exit 0 test |
| Forensics: signal received + /proc parent-chain (pid → ppid → comm up to init) | 8, 9 | unit fixtures (parser, walk, truncation, max hops) + JSONL line assertion in the SIGHUP test |
| Non-Linux builds compile and degrade gracefully | 8, 9 | walker is platform-agnostic by return value (`None` → "unavailable"); signal arms use the existing `#[cfg(unix)]`/`#[cfg(not(unix))]` pairing |
| Forensics best-effort, never delays/blocks shutdown | 8, 9 | sync bounded reads, no timers/awaits, emitted before the watchdog; SIGTERM regression suite still exits within 5s |
| Repo conventions, TDD, fmt+clippy clean, standard checks | every task + 10 | per-task gates + workspace sweep + continuity smoke |

There are **no unresolved coverage gaps**: every spec requirement above has a
covering task with a production-observable proof; nothing is deferred to
"known limitations" or "future work".

Placeholder scan: no TBD/TODO/"similar to Task N" remain; the two
"copy-from-file" directives (test harness boilerplate from
`session_identity_frames.rs` and `safe11_term22_shutdown_reaping.rs`) point
at existing in-repo files by exact path and line range, which the executing
implementer reads directly. Type-consistency pass done: `CreateProtectConfig`
field names (`restore_spawn_*`), `RestoreSpawnGate::acquire(timeout, &mut
watch::Receiver<bool>)`, `SpawnGateError::{QueueFull, Timeout, Cancelled}`,
`CreateOutput::{Socket, Channel}`, `handle_create(create, out, state)`,
`log_shutdown_forensics(&str)` are used identically across Tasks 1-10.
