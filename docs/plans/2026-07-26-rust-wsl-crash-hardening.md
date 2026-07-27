# Rust WSL Crash Hardening Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Bound restore-storm PTY spawns with a cancellable, spawn-to-settled
concurrency gate in `freshell-ws`, and make `freshell-server` handle SIGHUP
gracefully while logging best-effort shutdown forensics (signal + /proc
parent-chain) so external kills become attributable.

**Motivation & success criteria (per the 2026-07-06 WSL-outage RCA; validated
2026-07-26, load-bearing-assumption pass, report V6):** The three 2026-07-06
fleet deaths were WSL session teardown caused by wslservice-internal
corruption (the WSL 2.6.3 `CollectCrashDumps()` OOB-read bug class — RCA
§3.1/§3.3), NOT guest resource pressure: the RCA explicitly rules resource/
port pressure "falsified as crash cause; real as chronic issue". Track 1's
gate therefore does NOT prevent — and must never be framed as preventing —
what killed WSL. It is the RCA's own endorsed fix (§6.3) for the CHRONIC
restore-stampede problem: a ~20-tab fleet respawning ~50–70 agent processes
in the same instant, the mechanism behind the post-reboot UDP-port-exhaustion
spike (Tcpip event 4266, fired 2.5 min after boot during fleet restore).
**Track 1 success metric: elimination of the boot-time Tcpip 4266 event and
bounded, orderly stampede draining — not crash prevention.** The actual
outage remediations — a systemd user service with lingering (RCA §6.1) and
WSL ≥ 2.7.3 or `maxCrashDumpCount=-1` (RCA §6.2) — are environmental/
out-of-repo and are NOT part of this plan. Track 2 makes external kills
attributable after the fact.

**Architecture:** Two independent hardening tracks against the WSL-outage RCA
(`docs/plans/2026-07-06-wsl-outage-rca.md` on the `fix/wsl-crash-hardening`
worktree). Track 1 adds four new modules to `crates/freshell-ws`
(`create_limit.rs` config + per-connection rate limiter, `spawn_gate.rs`
server-wide FIFO semaphore gate with cancellable acquire, `create_gate.rs`
the spawned gated-create path, `create_dedupe.rs` server-wide
requestId→terminal dedupe guard — legacy parity, Task 7b) and reroutes `restore:true` creates through a
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
- Checks that must pass before every commit — judged as a DELTA against the
  recorded baseline below, never as absolute "all green":
  - `cargo fmt --all -- --check` (fully clean after Task 1 Step 0's one-time
    baseline fix)
  - `cargo clippy --workspace --all-targets` (no NEW warnings vs the 60
    recorded baseline warnings)
  - `cargo test -p <touched crates>` (workspace-wide in the final task): no
    NEW failures vs the 2 recorded baseline failures.
- **Recorded baseline (2026-07-26, HEAD a7dc03f4 — validator report V7):**
  - `cargo fmt --all -- --check` FAILS with exactly 1 diff: a stray blank
    line at `crates/freshell-sessions/src/directory_index.rs:898` (fixed as
    a standalone pre-commit in Task 1 Step 0).
  - `cargo clippy --workspace --all-targets` passes with **60 baseline
    warnings**.
  - `cargo test -p freshell-ws -p freshell-server` = **468 passed / 2
    failed / 1 ignored**. Known failures: (1)
    `codex_session_ref_resume::codex_create_derives_resume_from_session_ref`
    — environmental (no node_modules in this worktree → `tsx` unresolvable);
    can never pass here; (2)
    `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref`
    — deterministic pre-existing defect (reproduced in isolation; times out
    waiting for `terminal.created`). Failure (2) sits on the exact
    `terminal.created` frame path this plan touches — it MUST be triaged
    BEFORE the final integration task (Task 10 Step 0) so this plan's
    changes are not confused with it.
  - Every "all green" / "all tests pass" phrase in this plan therefore means
    "no regressions vs this recorded baseline".
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
- Gating the `POST /api/tabs-sync/restore` continuity pipeline (ledger
  decision ACC-1). Verified fact (V1): the historical storm mechanism IS the
  frozen client's WS `terminal.create restore:true` stampede — the client
  folds `restore:true` into the WS create payload
  (`src/components/TerminalView.tsx:2761` computes the flag, `:2793` sends
  it) and mounts every persisted tab at once (RCA §6.3). The WS gate fully
  covers that mechanism. It does NOT, however, cover every restore-flagged
  spawn: `POST /api/tabs-sync/restore`
  (`crates/freshell-server/src/tabs_snapshots.rs:820-826` →
  `freshell_freshagent::terminal_tabs::create_terminal_or_content_tab_deferred`
  → `registry.create` at `crates/freshell-freshagent/src/terminal_tabs.rs:867`)
  spawns restore PTYs entirely outside `freshell-ws`. That pipeline is
  DELIBERATELY DE-SCOPED: it is operator-triggered, serialized under
  `restore_lock` (`tabs_snapshots.rs:32-35`, `:493`), fenced per pane by a
  screenshot ack (`:296-315`), and refuses unless exactly one browser is
  connected (`:499`) — structurally not storm-shaped. Recorded deviation:
  the RCA (§6.3) prescribes the gate "in the terminal registry" (which would
  also cover REST + tabs-sync); this plan places it in `freshell-ws` to keep
  the blast radius in one crate (`freshell-terminal` is contractually
  tokio-free). Future option, if REST/tabs-sync spawn volume ever grows:
  move the gate into `TerminalRegistry::create`.
- Plain REST spawn paths (`POST /api/tabs`, `/split`, `/respawn` via
  `freshell-freshagent`) carry no `restore` flag and are low-volume
  operator/automation actions; they share the ACC-1 de-scope rationale above.
- Moving `registry.create` onto `spawn_blocking` (prior art did this) is not
  required by the spec and enlarges blast radius (exit-hook + borrow rework);
  the gate bounds how many blocking spawns can pile up, which is the spec's
  requirement. Measured basis (V4): inline blocking at concurrency 4 is safe
  on ≥4-worker runtimes (this server uses plain `#[tokio::main]`, workers =
  num_cpus); on ≤2-core machines a simultaneous burst adds ~2× the spawn
  duration of latency to unrelated timers — acceptable, but revisit if WSL
  PTY spawn latency ≫10ms is ever observed.
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
| `crates/freshell-ws/src/create_dedupe.rs` | Create | `CreateDedupe`: server-wide requestId→terminal dedupe guard with in-flight sentinel (legacy `createdByRequestId` parity, Task 7b) |
| `crates/freshell-ws/src/lib.rs` | Modify | `pub mod` declarations; `WsState` gains `create_protect` + `spawn_gate` + `shutdown_started` (Task 3) and `create_dedupe` (Task 7b); `state()` test helper updated |
| `crates/freshell-ws/src/terminal.rs` | Modify | pub(crate) visibility for `WsSink`/`send`; `handle_create`/`send_create_error` take `CreateOutput`; per-connection cancel watch + rate-limit + dispatch branch in `run`/`handle_client_text` |
| `crates/freshell-server/src/main.rs` | Modify | Boot wiring of config + gate; SIGHUP arm + forensics call in `shutdown_signal()`; `mod shutdown_forensics;` |
| `crates/freshell-server/src/shutdown_forensics.rs` | Create | `/proc` stat parser + parent-chain walker (injectable proc root) + `log_shutdown_forensics` |
| `crates/freshell-ws/tests/restore_spawn_gate.rs` | Create | Real-socket integration proof: gating, bypass, rate limit, disconnect cancellation, shutdown drain, shutdown-race no-orphan, storm ordering, requestId dedupe |
| `crates/freshell-ws/tests/*.rs` (11 existing files) | Modify | Add the new `WsState` fields (three in Task 3, one more in Task 7b) to each literal |
| `crates/freshell-server/tests/sighup_forensics.rs` | Create | Real-binary integration proof: SIGHUP → graceful exit 0 + forensics JSONL line |

Known `WsState` literal sites the compiler will flag (add the new fields to
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

- [ ] **Step 0: One-time baseline fmt pre-commit**

The recorded baseline (Global Constraints) has exactly one
`cargo fmt --all -- --check` diff: a stray blank line at
`crates/freshell-sessions/src/directory_index.rs:898`. Fix it now as a
standalone pre-commit so every later fmt gate is meaningful: run
`cargo fmt --all`, confirm the only change is that blank line, and commit it
alone (`style(freshell-sessions): drop stray blank line flagged by rustfmt`,
with the standard footer paragraphs). From this point on,
`cargo fmt --all -- --check` must be fully clean.

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
- FIFO precision (A7/V4, tokio pinned =1.52.3, empirically probed): Semaphore
  FIFO, `try_acquire` no-barge, and no-permit-leak on cancel-after-assignment
  are all confirmed. Note: FIFO is first-POLL order — correct for this
  spawn-task-per-create design; never build `acquire` futures eagerly and
  poll them out of order (e.g. a reordered FuturesUnordered), or queue order
  follows poll order instead of arrival order.

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
- Produces: three new `WsState` fields every later task reads:
  - `pub create_protect: crate::create_limit::CreateProtectConfig`
  - `pub spawn_gate: std::sync::Arc<crate::spawn_gate::RestoreSpawnGate>`
  - `pub shutdown_started: std::sync::Arc<std::sync::atomic::AtomicBool>`
    (the shutdown latch the gated-create path checks — A10, Tasks 6/7)

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
    /// Latched `true` the instant a shutdown signal is received (before the
    /// WS notify — wired in Task 7). Gated restore creates re-check it
    /// around `registry.create` so a create racing shutdown never leaves a
    /// live PTY that `kill_all`'s one-shot id snapshot
    /// (`freshell-terminal/src/registry.rs:889-892`) would miss (A10/V3).
    pub shutdown_started: std::sync::Arc<std::sync::atomic::AtomicBool>,
```

- [ ] **Step 2: Let the compiler find every construction site (RED)**

Run: `cargo test -p freshell-ws -p freshell-server --no-run`
Expected: FAIL with `missing fields create_protect, spawn_gate and
shutdown_started` errors at every `WsState { ... }` literal (the sites listed
in File Structure).

- [ ] **Step 3: Fix the production site in `main.rs`**

In `crates/freshell-server/src/main.rs`, immediately BEFORE the
`let ws_state = WsState {` literal (~line 351), add:

```rust
    // Resolved ONCE so the rate-limit knobs and the gate the handlers consult
    // are guaranteed to come from the same env snapshot.
    let create_protect = freshell_ws::create_limit::CreateProtectConfig::from_env();
    // Shutdown latch shared with shutdown_signal (Task 7 wires the setter).
    let shutdown_started = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
```

and inside the literal, after `term09: freshell_ws::backpressure::Term09Config::from_env(),`:

```rust
        create_protect,
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::RestoreSpawnGate::from_config(
            &create_protect,
        )),
        shutdown_started: std::sync::Arc::clone(&shutdown_started),
```

Keep the `shutdown_started` local binding alive in `main` — Task 7 passes a
clone into `shutdown_signal`.

- [ ] **Step 4: Fix every test/helper construction site**

At every other flagged `WsState { ... }` literal (the `fn state()` helper in
`lib.rs`, both `state_with_bus()` helpers in `terminal.rs`, and the 11
`tests/*.rs` files), add the same two lines (inside `freshell-ws` use
`crate::` paths; in `tests/*.rs` use `freshell_ws::` paths):

```rust
        create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::RestoreSpawnGate::new(4, 64)),
        shutdown_started: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
```

Re-run `cargo test -p freshell-ws -p freshell-server --no-run` until it
compiles clean.

- [ ] **Step 5: Run the full crate test suites — expect pass (no behavior change yet)**

Run: `cargo test -p freshell-ws && cargo test -p freshell-server`
Expected: no NEW failures vs the recorded baseline (468 passed / 2 known
failures / 1 ignored — see Global Constraints).

- [ ] **Step 6: Quality gates**

Run: `cargo fmt --all && cargo clippy --workspace --all-targets`
Expected: no new warnings.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws crates/freshell-server
git commit \
  -m "feat(freshell-ws): carry create-protection config and restore-spawn gate on WsState" \
  -m "- WsState gains create_protect + spawn_gate (one gate per server process, Arc-shared across connections) + shutdown_started (A10 shutdown latch, consumed by the gated create path)
- main.rs resolves CreateProtectConfig::from_env() once at boot, next to the term09 wiring
- All test WsState literals updated (lib.rs state(), terminal.rs state_with_bus x2, 11 tests/*.rs)" \
  -m "Verification: cargo test -p freshell-ws; cargo test -p freshell-server (no new failures vs the recorded baseline); cargo fmt --all -- --check; cargo clippy --workspace --all-targets (no new warnings)." \
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
Expected: no NEW failures vs the recorded baseline (the pre-existing
terminal.rs inline suites and all 11 integration files behave exactly as at
baseline — including the 2 known baseline failures, see Global Constraints).

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
  -m "Verification: cargo test -p freshell-ws (no new failures vs recorded baseline; +1 new test); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
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
/// knobs. Returns (ws_url, registry, shutdown_notify, gate, shutdown_started).
async fn spawn_server(
    create_protect: CreateProtectConfig,
    gate: RestoreSpawnGate,
) -> (
    String,
    freshell_terminal::TerminalRegistry,
    std::sync::Arc<tokio::sync::Notify>,
    std::sync::Arc<RestoreSpawnGate>,
    std::sync::Arc<std::sync::atomic::AtomicBool>,
) {
    let gate = std::sync::Arc::new(gate);
    let shutdown = std::sync::Arc::new(tokio::sync::Notify::new());
    let shutdown_started =
        std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // ... construct WsState exactly as session_identity_frames.rs does,
    //     except:
    //         shutdown: std::sync::Arc::clone(&shutdown),
    //         create_protect,
    //         spawn_gate: std::sync::Arc::clone(&gate),
    //         shutdown_started: std::sync::Arc::clone(&shutdown_started),
    // ... axum router + serve exactly as session_identity_frames.rs ...
    (ws_url, registry, shutdown, gate, shutdown_started)
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
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
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
Expected: no new failures vs the recorded baseline; no new warnings.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws
git commit \
  -m "feat(freshell-ws): per-connection terminal.create rate limit with restore bypass" \
  -m "- Legacy parity (ws-handler.ts:2376-2389): 10 creates / 10s sliding window per connection, rejects cost no budget, RATE_LIMITED error frame feeds the frozen client's retry ladder
- restore:true creates bypass the limiter (they are bounded by the restore-spawn gate)
- New real-socket acceptance test: third create in window is rejected, only two PTYs exist" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate; cargo test -p freshell-ws (no new failures vs recorded baseline); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
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
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
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
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
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

#[tokio::test(flavor = "multi_thread")]
async fn gated_create_racing_shutdown_leaves_no_live_pty() {
    // A10 (V3, FALSIFIED): main's registry.kill_all() snapshots the id set
    // ONCE (registry.rs:889-892) with no re-sweep; a detached gated create
    // survives the axum drain and its registry insert can land AFTER the
    // snapshot. The registry-Drop fallback does NOT hold (the PTY reader
    // thread's exit hook owns a registry Arc — terminal.rs:1047,
    // pty.rs:464/512 — circular), and the 5s watchdog exits via
    // std::process::exit(1), skipping Drops. So the gated path itself must
    // re-check the shutdown latch around handle_create.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, _gate, shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(1, 64)).await;
    // connect + hello

    // Shutdown has begun (exactly what main.rs latches before the WS
    // notify — Task 7 Step 2b) while the restore create is about to run:
    shutdown_started.store(true, std::sync::atomic::Ordering::SeqCst);
    send_text(&mut client, &create_frame("late", true)).await;

    // Give the gated task time to (wrongly) spawn and settle.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    assert_eq!(
        registry.kill_all(),
        0,
        "a create racing shutdown must not leave a live PTY"
    );
}
```

- [ ] **Step 2: Run — expect FAIL**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: `restore_creates_are_gated_and_non_restore_bypass` FAILS (the
restore create currently succeeds inline — the gate is never consulted) and
`gated_create_racing_shutdown_leaves_no_live_pty` FAILS (the create succeeds
and leaves one live PTY despite the latched shutdown).

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
        // A10 shutdown-race pre-check (V3): kill_all snapshots ids once
        // (registry.rs:889-892); if shutdown already began, nothing has been
        // spawned yet — abandon instead of inserting a PTY the snapshot will
        // never visit.
        if state.shutdown_started.load(std::sync::atomic::Ordering::SeqCst) {
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %create.request_id,
                "restore_create_abandoned_for_shutdown"
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
        let request_id = create.request_id.clone();
        let _ = crate::terminal::handle_create(create, &mut out, &state).await;
        // A10 shutdown-race post-check (V3): shutdown may have begun DURING
        // the create, after main's kill_all snapshot. The server is reaping
        // everything anyway, so an idempotent kill_all here reaps our own
        // just-inserted terminal (and any other late insert). Belt to the
        // pre-check's braces; main.rs adds a drain re-sweep too (Task 7
        // Step 2b).
        if state.shutdown_started.load(std::sync::atomic::Ordering::SeqCst) {
            let killed = state.registry.kill_all();
            tracing::info!(
                target: "freshell_ws::spawn_gate",
                request_id = %request_id,
                killed,
                "restore_create_settled_during_shutdown_reaped"
            );
        }
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
Expected: no new failures vs the recorded baseline; no new warnings. Known nuance to note (not fix): on the
gated path the strict same-connection `terminal.created` → `terminals.changed`
frame order is now best-effort (both drain through the connection loop from
two channels); the creating connection enqueues `created` strictly first, and
other connections already had this property. The storm-shaped ordering test
(Task 7 Step 2c) is the primary client-visible evidence; the npm continuity
smoke (Task 10 Step 3) is optional best-effort corroboration on a
provisioned machine.

**Validation notes folded into this task (2026-07-26 load-bearing pass):**
- (A2/V2 — HARD REQUIREMENT) Gate error frames (RATE_LIMITED on queue-full,
  PTY_SPAWN_FAILED on timeout) MUST echo the client's `requestId`: the frozen
  client matches errors on `msg.requestId === reqId`
  (src/components/TerminalView.tsx:3995-3999) and silently ignores frames
  without it — the pane wedges in 'creating'. The error-path tests in this
  task and Task 7 assert `err["requestId"]`; keep those assertions. The
  client's RATE_LIMITED retry ladder is exactly 38s (2+4+8+12+12s;
  TerminalView.tsx:155-157, 2798-2815) with the FIRST retry after 2s — the
  gate (and the Task 7b dedupe guard) must tolerate an immediate
  same-requestId re-request.
- (A21/V8 — DESIGN INVARIANT) The created-before-output guarantee on the
  Channel reply path is CAUSAL, not structural: create never auto-attaches
  (`freshell-terminal/src/registry.rs:548` — `subscribers: HashMap::new()`),
  output flows only through attach-registered subscribers, and the client
  attaches only after receiving `created` — a client round-trip the
  connection loop's unbiased `select!` cannot reorder. NEVER add create-time
  auto-attach or create-time replay to the channel-reply path, or output can
  hit the wire before `created`.
- (A5/V3) The spawned task needs `'static` captures — `state.clone()` above
  covers it (WsState is Clone; all fields Arc-backed).
- (A5/V3) Concurrent opencode creates sharing a cwd now contend on an O_EXCL
  file lock with blocking `thread::sleep` retries on tokio workers
  (mcp_inject.rs:329-375) — keep the default gate concurrency small (4 is
  fine).
- (A9/V3) The per-connection cancel sender drops when `run()` RETURNS —
  i.e. AFTER `registry.remove_connection` — so do not assume
  cancel-before-remove ordering (benign: create never subscribes).
- (A19/V3) A create settling after its client disconnected leaves a detached
  background terminal, reaped by the idle sweep (default 15 min) — or never,
  if `autoKillIdleMinutes <= 0`. Accepted by design; do not "fix" it here.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws
git commit \
  -m "feat(freshell-ws): route restore creates through the spawn-to-settled gate" \
  -m "- restore:true creates now run on a spawned task holding a RestoreSpawnGate permit from before the PTY spawn until terminal.created + broadcasts are queued (spec: permit spans the async create, not a sync call)
- Per-connection watch cancel signal: loop exit (disconnect/shutdown) unblocks queued restore creates without spawning
- QueueFull -> RATE_LIMITED (client retry ladder), Timeout -> PTY_SPAWN_FAILED, both echoing the client requestId; zero-permit wiring proof + bypass + queued-settle acceptance tests
- A10 shutdown-race guard: gated path re-checks WsState.shutdown_started before and after handle_create; a create racing shutdown leaves no live PTY (new test)" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate; cargo test -p freshell-ws (no new failures vs recorded baseline); cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Cancellation + shutdown-race + storm acceptance — disconnect, shutdown drain, kill_all re-sweep, storm ordering

Steps 1-2 are the spec's two REQUIRED cancellation outcomes, proven
end-to-end against the real server. Step 2b wires the A10 shutdown latch +
`kill_all` re-sweep into `main.rs`; Step 2c is the storm-shaped ordering
test that serves as the plan's PRIMARY client-visible acceptance evidence
(ledger decision ACC-2). These exercise machinery Task 6 built; if a test
fails, fix the implementation (do not weaken the test).

**Files:**
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs` (three new tests)
- Modify: `crates/freshell-server/src/main.rs` (shutdown latch wiring +
  `kill_all` re-sweep — A10)

**Interfaces:**
- Consumes: `spawn_server` harness (Task 5), `RestoreSpawnGate` counters
  (Task 2), the returned `shutdown` Notify + `shutdown_started` latch
  (Task 5 harness / Task 3 field).
- Produces: `shutdown_signal(notify_ws, shutdown_started)` signature Task 9
  preserves.

- [ ] **Step 1: Write the disconnect test, run it (RED-or-GREEN gate)**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn queued_restore_create_is_abandoned_on_disconnect_without_spawning() {
    // Zero-permit gate + long timeout: the restore create parks in the queue.
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
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
    let (ws_url, registry, shutdown, gate, _shutdown_started) =
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

- [ ] **Step 2b: Wire the shutdown latch + `kill_all` re-sweep in `main.rs` (A10)**

Task 3 added `WsState.shutdown_started` and Task 6 made the gated path check
it; this step makes production shutdown actually set it and adds the
defense-in-depth re-sweep:

1. Change `shutdown_signal`'s signature to also take the latch and set it
   FIRST, before the watchdog/notify (Task 9 later rewrites this function's
   signal arms and keeps this line):

```rust
async fn shutdown_signal(
    notify_ws: Arc<tokio::sync::Notify>,
    shutdown_started: Arc<std::sync::atomic::AtomicBool>,
) {
    // ... existing signal futures + select ...
    // Latch BEFORE any teardown step: gated creates consult this around
    // registry.create (create_gate.rs, Task 6) so a create racing shutdown
    // never leaves a live PTY.
    shutdown_started.store(true, std::sync::atomic::Ordering::SeqCst);
    // ... existing watchdog + notify_ws.notify_waiters() + 250ms sleep ...
}
```

   Pass `std::sync::Arc::clone(&shutdown_started)` (the Task 3 binding in
   `main`) at the call site.

2. In `main()` teardown, immediately after the existing
   `registry.kill_all()` call (~`main.rs:769`), add the re-sweep:

```rust
    // A10 re-sweep (V3): kill_all() snapshots the id set ONCE
    // (registry.rs:889-892); a detached gated create settling during the
    // drain can insert AFTER that snapshot, and neither registry-Drop (the
    // PTY reader thread's exit hook holds a registry Arc — terminal.rs:1047,
    // pty.rs:464/512, circular) nor the watchdog's std::process::exit(1)
    // (skips Drops) would ever reap it. Give in-flight create tasks a short
    // settling window, then sweep again. Second line of defense behind
    // create_gate.rs's shutdown_started checks.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    let _ = registry.kill_all();
```

Run: `cargo test -p freshell-ws --test restore_spawn_gate && cargo test -p freshell-server`
Expected: gate suite green including
`gated_create_racing_shutdown_leaves_no_live_pty` (Task 6); freshell-server
shows no NEW failures vs the recorded baseline. The safe11 SIGTERM reaping
suite must stay green (the re-sweep adds a bounded 300ms + an idempotent
kill, well inside the 5s watchdog).

- [ ] **Step 2c: Storm-shaped ordering + no-duplicates test (ACC-2 primary evidence)**

The npm continuity smoke is only 3-tab, asserts NO frame ordering, and is
unrunnable in this worktree (V7: no node_modules; needs provider CLIs +
`~/.codex/auth.json`) — so THIS Rust-side test is the primary acceptance
evidence for storm-shaped restores:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn restore_storm_drains_bounded_with_per_terminal_ordering() {
    // N restore creates > gate limit: every create must settle with its own
    // requestId, exactly once, with no duplicate PTYs; and no terminal may
    // emit output before the client attaches (the A21 causal invariant —
    // create never auto-attaches, registry.rs:548).
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(2, 64)).await;
    // connect + hello

    const N: usize = 12; // > gate limit 2: forces real FIFO queueing
    for i in 0..N {
        send_text(&mut client, &create_frame(&format!("storm-{i}"), true)).await;
    }

    // Drain N terminal.created frames. While draining, FAIL on any
    // terminal.output / terminal.outputBatch frame — nothing is attached
    // yet, so output before attach would break the A21 invariant. (Use a
    // next_json_of_type variant that panics on output-family frames.)
    let mut seen = std::collections::HashMap::<String, String>::new();
    for _ in 0..N {
        let created = next_json_of_type(&mut client, "terminal.created").await;
        let req = created["requestId"].as_str().expect("requestId").to_string();
        let tid = created["terminalId"].as_str().expect("terminalId").to_string();
        assert!(
            seen.insert(req, tid).is_none(),
            "duplicate terminal.created for one requestId"
        );
    }
    assert_eq!(seen.len(), N, "every requestId settled exactly once");
    assert!(
        seen.keys().all(|k| k.starts_with("storm-")),
        "only the storm requestIds replied"
    );
    assert!(
        gate.queued_total() >= (N as u64) - 2,
        "with 2 permits the storm must actually queue FIFO behind the gate"
    );

    // Per-terminal created -> attach -> output: attach ONE storm terminal
    // (copy the attach frame shape from session_identity_frames.rs) and
    // assert terminal.attach.ready arrives for that terminalId — output for
    // it may only follow now.
    // ... attach + read terminal.attach.ready for the chosen terminalId ...

    assert_eq!(registry.kill_all(), N, "exactly N PTYs, no duplicates");
}
```

Run: `cargo test -p freshell-ws --test restore_spawn_gate restore_storm_drains`
Expected: PASS (debug-until-green; the gate + causal attach ordering already
guarantee this if Tasks 2-6 are correct).

- [ ] **Step 3: Full crate suite + quality gates**

Run: `cargo test -p freshell-ws && cargo fmt --all && cargo clippy --workspace --all-targets`
Expected: no new failures vs the recorded baseline; no new warnings.

- [ ] **Step 4: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws/tests/restore_spawn_gate.rs crates/freshell-server/src/main.rs
git commit \
  -m "test(freshell-ws): prove queued restore creates cancel on disconnect and shutdown" \
  -m "- Disconnect while queued: gate reports 1 cancellation, registry spawns 0 PTYs
- notify_waiters shutdown: client sees 4009, both queued creates drain without spawning
- These are the two flaw classes of the abandoned Node attempt, now pinned by real-socket tests
- A10: shutdown_signal latches WsState.shutdown_started first; main() re-sweeps registry.kill_all() after a 300ms settle window (kill_all snapshots ids once, registry.rs:889-892)
- Storm test (ACC-2 primary evidence): 12 restore creates through a 2-permit gate all settle exactly once, no duplicates, no output before attach" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate; cargo test -p freshell-ws; cargo test -p freshell-server; cargo fmt --all -- --check; cargo clippy --workspace --all-targets (no new warnings; no new failures vs recorded baseline)." \
  -m "🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7b: requestId dedupe guard for `terminal.create` (legacy parity — A20)

**Why (A20/V8, FALSIFIED):** the Rust server has NO requestId dedupe —
`handle_create` mints a fresh terminalId unconditionally
(`crates/freshell-ws/src/terminal.rs:748`), and the omission is
self-documented in code (`terminal.rs:805-807`). The legacy server dedupes
via `createdByRequestId` + `REPAIR_PENDING_SENTINEL`
(`server/ws-handler.ts:2167-2172`, `:2436`). The frozen client re-sends
in-flight creates with the SAME requestId on every reconnect (V2:
`src/components/TerminalView.tsx:4227-4262` onReconnect re-drive +
`src/lib/ws-client.ts:128,196-205` inFlightCreates resend) — and this plan's
abandon-without-reply cancellation (Task 6) makes that resend MORE common.
Without a guard, each resend spawns a duplicate PTY and orphans the original
as a detached background session — exactly the resource regression the gate
exists to fight.

**Scope note:** server-global map keyed by requestId (the client resends on
a NEW connection after reconnect, so a per-connection map would never see
the original entry; server-global with legacy-equivalent eviction — entries
dropped on create failure and, lazily, when the settled terminal no longer
exists — matches the frozen client's expectations). RequestIds are
client-generated UUIDs, so cross-client collision is not a concern.

**Files:**
- Create: `crates/freshell-ws/src/create_dedupe.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (`pub mod` line + `WsState` gains
  `create_dedupe`)
- Modify: `crates/freshell-ws/src/terminal.rs` (dispatch arm + `settle` call
  in `handle_create`)
- Modify: `crates/freshell-ws/src/create_gate.rs` (`clear_if_in_flight`
  hooks on every non-settled exit of the gated path)
- Modify: every `WsState { ... }` literal the compiler flags (same site list
  as Task 3)
- Modify: `crates/freshell-ws/tests/restore_spawn_gate.rs` (two new tests)

**Interfaces:**
- Consumes: `WsState`, `handle_create` (Task 4 shape), the gated path
  (Task 6), `ServerMessage`.
- Produces:
  - `pub struct CreateDedupe` with
    `pub fn begin(&self, request_id: &str, is_live: impl Fn(&str) -> bool) -> DedupeDecision`,
    `pub fn settle(&self, request_id: &str, terminal_id: &str, created: &ServerMessage)`,
    `pub fn clear_if_in_flight(&self, request_id: &str)`
  - `pub enum DedupeDecision { Proceed, DuplicateInFlight, DuplicateSettled(ServerMessage) }`
  - `WsState` field `pub create_dedupe: std::sync::Arc<crate::create_dedupe::CreateDedupe>`

- [ ] **Step 1: Write the failing integration tests (RED)**

Append to `crates/freshell-ws/tests/restore_spawn_gate.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn same_requestid_resend_returns_existing_terminal() {
    // A20: the frozen client re-sends terminal.create with the SAME
    // requestId on reconnect (TerminalView.tsx:4227-4262; ws-client.ts
    // inFlightCreates). The server must answer with the EXISTING terminal,
    // not spawn a duplicate.
    let cfg = CreateProtectConfig::default();
    let (ws_url, registry, _shutdown, _gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(4, 64)).await;
    // connect + hello
    send_text(&mut client, &create_frame("dup", true)).await;
    let first = next_json_of_type(&mut client, "terminal.created").await;
    let tid = first["terminalId"].as_str().expect("terminalId").to_string();

    send_text(&mut client, &create_frame("dup", true)).await;
    let second = next_json_of_type(&mut client, "terminal.created").await;
    assert_eq!(second["requestId"], "dup");
    assert_eq!(
        second["terminalId"],
        tid.as_str(),
        "same-requestId resend must return the EXISTING terminal"
    );
    assert_eq!(registry.kill_all(), 1, "exactly one PTY for one requestId");
}

#[tokio::test(flavor = "multi_thread")]
async fn duplicate_while_queued_does_not_double_spawn() {
    // Zero-permit gate + long timeout: the first create parks in the gate
    // queue; a duplicate arriving meanwhile must be swallowed by the
    // InFlight sentinel (the queued original will answer), never enqueued
    // as a second spawn.
    let cfg = CreateProtectConfig {
        restore_spawn_timeout_ms: 30_000,
        ..CreateProtectConfig::default()
    };
    let (ws_url, registry, _shutdown, gate, _shutdown_started) =
        spawn_server(cfg, RestoreSpawnGate::new(0, 64)).await;
    // connect + hello
    send_text(&mut client, &create_frame("dup-q", true)).await;
    for _ in 0..200 {
        if gate.queued_total() == 1 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    assert_eq!(gate.queued_total(), 1, "first create must be queued");

    send_text(&mut client, &create_frame("dup-q", true)).await;
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    assert_eq!(
        gate.queued_total(),
        1,
        "duplicate must not enqueue a second gated create"
    );
    assert_eq!(registry.kill_all(), 0, "no PTY spawned for either copy");
}
```

Run: `cargo test -p freshell-ws --test restore_spawn_gate same_requestid`
Expected: FAIL — today the resend spawns a second PTY with a new terminalId
(`registry.kill_all()` returns 2) and the queued duplicate enqueues a second
gated create.

- [ ] **Step 2: Write the dedupe module (RED via unregistered module)**

Create `crates/freshell-ws/src/create_dedupe.rs`:

```rust
//! Server-wide `terminal.create` requestId -> terminal dedupe guard
//! (legacy parity: `server/ws-handler.ts` `createdByRequestId` map —
//! declaration :469, lookup :2167-2172, REPAIR_PENDING_SENTINEL :2436).
//! The Rust port had no equivalent (fresh UUIDs minted unconditionally,
//! terminal.rs:748; omission self-documented at :805-807), and the frozen
//! client re-sends unanswered creates with the SAME requestId on every
//! reconnect — without this guard every resend spawns a duplicate PTY and
//! orphans the original as a detached background session.
//!
//! Eviction semantics (legacy-equivalent):
//! - failed create -> the wrapper calls `clear_if_in_flight` (legacy
//!   sentinel cleanup, ws-handler.ts:2460)
//! - killed/exited terminal -> lazily evicted at lookup time via the
//!   `is_live` probe (legacy deletes on kill, ws-handler.ts:2286/:2372)

use std::collections::HashMap;
use std::sync::Mutex;

use freshell_protocol::ServerMessage;

enum Entry {
    /// A create with this requestId is currently gated/queued/in flight.
    InFlight,
    /// The create settled: replay this exact `terminal.created` frame.
    Settled {
        terminal_id: String,
        created: ServerMessage,
    },
}

pub enum DedupeDecision {
    /// First sighting (or stale settled entry evicted): proceed to create.
    Proceed,
    /// A create with this requestId is in flight: drop this duplicate
    /// silently — the in-flight one will answer with this requestId.
    DuplicateInFlight,
    /// Already settled and the terminal is live: re-send the stored
    /// `terminal.created` frame instead of spawning.
    DuplicateSettled(ServerMessage),
}

#[derive(Default)]
pub struct CreateDedupe {
    entries: Mutex<HashMap<String, Entry>>,
}

impl CreateDedupe {
    /// Look up `request_id`, registering an InFlight sentinel on `Proceed`.
    pub fn begin(
        &self,
        request_id: &str,
        is_live: impl Fn(&str) -> bool,
    ) -> DedupeDecision {
        let mut map = self.entries.lock().expect("create_dedupe lock");
        match map.get(request_id) {
            Some(Entry::InFlight) => DedupeDecision::DuplicateInFlight,
            Some(Entry::Settled {
                terminal_id,
                created,
            }) => {
                if is_live(terminal_id) {
                    DedupeDecision::DuplicateSettled(created.clone())
                } else {
                    // Terminal was killed/exited: evict and treat as fresh.
                    map.insert(request_id.to_string(), Entry::InFlight);
                    DedupeDecision::Proceed
                }
            }
            None => {
                map.insert(request_id.to_string(), Entry::InFlight);
                DedupeDecision::Proceed
            }
        }
    }

    /// Record a successful create (called where `handle_create` builds and
    /// sends the `terminal.created` frame).
    pub fn settle(&self, request_id: &str, terminal_id: &str, created: &ServerMessage) {
        self.entries.lock().expect("create_dedupe lock").insert(
            request_id.to_string(),
            Entry::Settled {
                terminal_id: terminal_id.to_string(),
                created: created.clone(),
            },
        );
    }

    /// Drop the InFlight sentinel if (and only if) the create did NOT
    /// settle — gate rejection, cancellation, shutdown abandon, or
    /// handle_create failure. Settled entries stay: that IS the dedupe.
    /// This is what lets the client's 2s RATE_LIMITED retry (same
    /// requestId) proceed as a fresh create.
    pub fn clear_if_in_flight(&self, request_id: &str) {
        let mut map = self.entries.lock().expect("create_dedupe lock");
        if matches!(map.get(request_id), Some(Entry::InFlight)) {
            map.remove(request_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn created_frame() -> ServerMessage {
        // Cheapest constructible variant; the guard treats it opaquely.
        ServerMessage::Pong // adjust like Task 4's CreateOutput test if needed
    }

    #[test]
    fn first_begin_proceeds_and_registers_sentinel() {
        let d = CreateDedupe::default();
        assert!(matches!(d.begin("r1", |_| true), DedupeDecision::Proceed));
        assert!(matches!(
            d.begin("r1", |_| true),
            DedupeDecision::DuplicateInFlight
        ));
    }

    #[test]
    fn settled_entry_replays_frame_while_live() {
        let d = CreateDedupe::default();
        let _ = d.begin("r1", |_| true);
        d.settle("r1", "t1", &created_frame());
        assert!(matches!(
            d.begin("r1", |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }

    #[test]
    fn dead_terminal_evicts_settled_entry() {
        let d = CreateDedupe::default();
        let _ = d.begin("r1", |_| true);
        d.settle("r1", "t1", &created_frame());
        assert!(matches!(d.begin("r1", |_| false), DedupeDecision::Proceed));
    }

    #[test]
    fn clear_if_in_flight_removes_sentinel_but_not_settled() {
        let d = CreateDedupe::default();
        let _ = d.begin("r1", |_| true);
        d.clear_if_in_flight("r1");
        assert!(matches!(d.begin("r1", |_| true), DedupeDecision::Proceed));
        d.settle("r1", "t1", &created_frame());
        d.clear_if_in_flight("r1");
        assert!(matches!(
            d.begin("r1", |_| true),
            DedupeDecision::DuplicateSettled(_)
        ));
    }
}
```

Run: `cargo test -p freshell-ws create_dedupe` — expect 0 tests (module not
registered). RED confirmed.

- [ ] **Step 3: Register module + `WsState` field**

1. `crates/freshell-ws/src/lib.rs`: add `pub mod create_dedupe;`
   alphabetically, and add to `WsState` (after `create_protect`):

```rust
    /// Server-wide requestId -> terminal dedupe for `terminal.create`
    /// (legacy `createdByRequestId` parity — see
    /// [`crate::create_dedupe::CreateDedupe`]).
    pub create_dedupe: std::sync::Arc<crate::create_dedupe::CreateDedupe>,
```

2. Let the compiler flag every `WsState { ... }` literal (same sites as
   Task 3, plus the Task 5 harness) and add
   `create_dedupe: std::sync::Arc::new(freshell_ws::create_dedupe::CreateDedupe::default()),`
   (`crate::` paths inside the crate; `main.rs` uses the `freshell_ws::`
   path). Re-run `cargo test -p freshell-ws -p freshell-server --no-run`
   until clean; then `cargo test -p freshell-ws create_dedupe` — expect
   `4 passed`.

- [ ] **Step 4: Wire the guard into the create paths**

1. `terminal.rs` dispatch arm — at the very TOP of
   `ClientMessage::TerminalCreate(create)`, BEFORE the restore branch and
   the rate limiter (a deduped resend costs no limiter budget, matching
   legacy's cached-binding return):

```rust
        ClientMessage::TerminalCreate(create) => {
            match state
                .create_dedupe
                .begin(&create.request_id, |tid| state.registry.exists(tid))
            {
                crate::create_dedupe::DedupeDecision::DuplicateSettled(created) => {
                    // Re-send the original terminal.created (same requestId,
                    // same terminalId) — never spawn a duplicate.
                    let mut out = crate::create_gate::CreateOutput::Socket(ws_tx);
                    return out.send(&created).await;
                }
                crate::create_dedupe::DedupeDecision::DuplicateInFlight => {
                    // The in-flight create will answer this requestId.
                    return true;
                }
                crate::create_dedupe::DedupeDecision::Proceed => {}
            }
            // ... existing restore-gate / rate-limit branches (Tasks 5-6),
            //     unchanged, follow here ...
```

   If `TerminalRegistry` has no public liveness lookup, add a trivial
   `pub fn exists(&self, id: &str) -> bool` to
   `crates/freshell-terminal/src/registry.rs` (registry-lock + HashMap
   `contains_key` — read-only, no tokio, honors the crate contract).

2. `terminal.rs` `handle_create` — at the single success point where the
   `created` frame is built (before `out.send(&created)`, ~:1215-1226):

```rust
    state
        .create_dedupe
        .settle(&create.request_id, &terminal_id, &created);
```

3. Non-restore inline path: after `handle_create` returns, call
   `state.create_dedupe.clear_if_in_flight(&create.request_id);` (no-op on
   success — the entry is Settled; removes the sentinel on failure).

4. Gated path (`create_gate.rs`): call
   `state.create_dedupe.clear_if_in_flight(&request_id)` on EVERY
   non-settled exit — the Cancelled return, the error-frame return
   (QueueFull/Timeout — required so the client's 2s same-requestId retry
   is not swallowed), the shutdown pre-check abandon, and after
   `handle_create` returns (covers create failure; Task 6 already cloned
   `request_id`).

- [ ] **Step 5: Run — expect pass**

Run: `cargo test -p freshell-ws --test restore_spawn_gate`
Expected: both Step 1 tests PASS; all earlier gate tests still pass.

- [ ] **Step 6: Full crate suite + quality gates**

Run: `cargo test -p freshell-ws && cargo fmt --all && cargo clippy -p freshell-ws --all-targets`
Expected: no new failures vs the recorded baseline; no new warnings.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-ws crates/freshell-terminal
git commit \
  -m "feat(freshell-ws): dedupe terminal.create by requestId (legacy parity)" \
  -m "- A20: frozen client re-sends in-flight creates with the same requestId on every reconnect; without a guard each resend spawned a duplicate PTY and orphaned the original
- CreateDedupe: server-global requestId map with InFlight sentinel; settled entries replay the original terminal.created; lazy eviction when the terminal is gone; sentinel cleared on gate rejection/cancel/failure so the client retry ladder still works
- Legacy parity: createdByRequestId + REPAIR_PENDING_SENTINEL (server/ws-handler.ts:2167-2172, 2436)" \
  -m "Verification: cargo test -p freshell-ws --test restore_spawn_gate; cargo test -p freshell-ws create_dedupe (4 passed); cargo test -p freshell-ws; cargo fmt --all -- --check; cargo clippy -p freshell-ws --all-targets (no new warnings; no new failures vs recorded baseline)." \
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
  - `pub fn record_boot_parent_chain()` — captures the boot-time parent
    chain once, for signal-time comparison (A15/V5 subreaper correction)
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
//! parent-process chain and compare it against the BOOT-TIME chain.
//! Discriminator (V5, measured on WSL2): orphans reparent to the
//! session-leader SUBREAPER "Relay" — NOT pid 1 — and reparenting completes
//! BEFORE the SIGHUP handler runs (8/8 trials; walk ~0.2ms). So the signal
//! is "parent CHANGED vs the boot-time parent / parent is a
//! subreaper-family process (Relay/init/systemd)" — never a literal
//! `ppid == 1` check. A changed parent indicates the login-session host
//! died (RCA candidate A); an unchanged live chain plus SIGTERM indicates a
//! directed kill.
//!
//! Best-effort by construction: pure sync `std::fs` reads of tiny /proc
//! files, bounded hops, no retries, no timers, no awaits — it can never
//! delay or block shutdown. On platforms without /proc the walker returns
//! `None` instead of erroring (macOS/Windows builds compile and degrade
//! gracefully; no conditional compilation needed here).

use std::path::Path;
use std::sync::OnceLock;

/// Boot-time parent chain, captured once at startup (Task 9 calls
/// [`record_boot_parent_chain`] from `main` right after logging init).
static BOOT_PARENT_CHAIN: OnceLock<String> = OnceLock::new();

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

/// Capture the boot-time parent chain for signal-time comparison.
/// Idempotent; call once from `main` after logging init (Task 9).
pub fn record_boot_parent_chain() {
    let _ = BOOT_PARENT_CHAIN.get_or_init(|| {
        match collect_parent_chain(Path::new("/proc"), std::process::id() as i64, 10) {
            Some(entries) => format_chain(&entries),
            None => "unavailable".to_string(),
        }
    });
}

/// Emit the single structured shutdown-forensics record. Never panics.
/// MUST stay at INFO or above: the default EnvFilter is `info` (A14/V5),
/// and the line only lands if `logging::init` succeeded at boot.
pub fn log_shutdown_forensics(signal: &str) {
    let chain = collect_parent_chain(Path::new("/proc"), std::process::id() as i64, 10);
    let parent_chain = match &chain {
        Some(entries) => format_chain(entries),
        None => "unavailable".to_string(),
    };
    let boot_parent_chain = BOOT_PARENT_CHAIN
        .get()
        .cloned()
        .unwrap_or_else(|| "unrecorded".to_string());
    tracing::info!(
        event = "shutdown_forensics",
        signal = %signal,
        parent_chain = %parent_chain,
        boot_parent_chain = %boot_parent_chain,
        "shutdown forensics: compare parent_chain to boot_parent_chain. A \
         CHANGED parent (typically a subreaper-family adopter: Relay/init/\
         systemd — on WSL2 orphans reparent to the Relay subreaper, NOT \
         pid 1) indicates the original parent/login-session host died; an \
         unchanged live chain plus SIGTERM indicates a directed kill"
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

    #[test]
    fn record_boot_parent_chain_is_idempotent() {
        record_boot_parent_chain();
        let first = super::BOOT_PARENT_CHAIN.get().cloned();
        assert!(first.is_some(), "boot chain must be recorded");
        record_boot_parent_chain();
        assert_eq!(super::BOOT_PARENT_CHAIN.get().cloned(), first);
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
Expected: `9 passed`. (A `dead_code` warning on `log_shutdown_forensics` is
expected until Task 9 wires it; if clippy flags it, add `#[allow(dead_code)]`
on `log_shutdown_forensics` with a `// consumed by shutdown_signal in the
next commit` comment and remove it in Task 9.)

- [ ] **Step 5: Quality gates**

Run: `cargo fmt --all && cargo clippy -p freshell-server --all-targets`
Expected: no new warnings (subject to the dead-code note above).

**Validation notes folded into this task (2026-07-26 load-bearing pass):**
- (A14/V5) The logging pipeline is a hand-rolled synchronous
  `JsonLayer`/`RotatingWriter` (write_all+flush on the caller's thread; NO
  tracing-appender) — no extra flush/fsync work is needed here. BUT the
  forensics line must be emitted at INFO or above (default EnvFilter is
  `info`) and `logging::init` must have succeeded at boot, or the line goes
  nowhere.
- (A15/V5, measured) On WSL2, orphans reparent to the session-leader
  subreaper "Relay" — NOT pid 1 — and reparenting completes BEFORE the
  SIGHUP handler runs (8/8 trials; walk latency ~0.2ms, 50-250× under
  budget). Hence the boot-chain comparison above; never reintroduce a
  literal `ppid == 1` discriminator. (pid 1 remains only as a WALK
  TERMINATOR in `collect_parent_chain`, which is fine.)

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-server
git commit \
  -m "feat(freshell-server): add shutdown-forensics /proc parent-chain walker" \
  -m "- Pure std::fs stat parser (first-open/last-close comm delimiting) + bounded ppid walk (max 10 hops, truncate on mid-walk failure, None when /proc absent)
- log_shutdown_forensics emits one tracing event=shutdown_forensics line with signal + pid:comm chain + boot-time chain comparison; sync, bounded, never panics, never delays shutdown
- Discriminator is parent-changed-vs-boot / subreaper family (WSL2 orphans reparent to Relay, not pid 1 — V5 measured); record_boot_parent_chain captures the baseline at startup
- Injectable proc root for tests (tempfile fixtures); non-Linux degrades to parent_chain=unavailable with no cfg gating" \
  -m "Verification: cargo test -p freshell-server shutdown_forensics (9 passed); cargo fmt --all -- --check; cargo clippy -p freshell-server --all-targets (no new warnings)." \
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
    assert!(
        forensics_line.contains("boot_parent_chain"),
        "line must carry the boot-time chain for comparison: {forensics_line}"
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
async fn shutdown_signal(
    notify_ws: Arc<tokio::sync::Notify>,
    shutdown_started: Arc<std::sync::atomic::AtomicBool>, // Task 7 latch — keep
) {
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

    // Latch FIRST (Task 7 wired this — keep it before any teardown): gated
    // creates consult this flag around registry.create.
    shutdown_started.store(true, std::sync::atomic::Ordering::SeqCst);

    // Forensics FIRST, before any teardown step, so the record survives even
    // if teardown hangs. Sync + bounded (a handful of tiny /proc reads) —
    // it cannot meaningfully delay arming the watchdog below.
    shutdown_forensics::log_shutdown_forensics(signal_name);

    // SAFE-11 fail-safe watchdog: ... (existing code below this point is
    // UNCHANGED: tokio::spawn watchdog -> notify_ws.notify_waiters() ->
    // 250ms sleep)
```

Also add, in `main()` immediately after `logging::init(...)` succeeds:

```rust
    // Boot-time parent chain for the shutdown-forensics comparison (V5:
    // WSL2 orphans reparent to the Relay subreaper, not pid 1 — the
    // discriminator is parent-changed-vs-boot, so the boot chain must be
    // captured now).
    shutdown_forensics::record_boot_parent_chain();
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
Expected: no new failures vs the recorded baseline; no new warnings.

**Validation notes folded into this task (2026-07-26 load-bearing pass):**
- (A12/V6) 2 of the 3 RCA kill events were catchable external SIGTERMs — the
  handler demonstrably ran ("Shutting down..."). The 17:29:04 death is
  unattributed and possibly uncatchable (no shutdown log). Recommended
  follow-up, NOT part of this plan: an unclean-shutdown marker — write a
  marker file at boot, remove it on clean exit, log at the next boot if it
  is still present — to attribute SIGKILL-class deaths.
- (A13/V5) Footnote: installing the SIGHUP handler defeats inherited SIG_IGN
  (nohup) — signal-hook-registry replaces the disposition unconditionally
  and never chains SIG_IGN. Verified: no supported Rust-server launch mode
  relies on nohup survival; the deprecated port/vm-bridge nohup pattern is
  not a supported deployment mode.

- [ ] **Step 7: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add crates/freshell-server
git commit \
  -m "feat(freshell-server): handle SIGHUP gracefully and log shutdown forensics" \
  -m "- shutdown_signal gains a cfg(unix) SignalKind::hangup() arm; select now yields the signal name (SIGINT/SIGTERM/SIGHUP)
- One shutdown_forensics tracing line (signal + /proc pid:comm parent chain + boot-time chain) emitted before the watchdog, WS 4009 drain, and registry reaping
- record_boot_parent_chain wired at boot; discriminator is parent-changed-vs-boot / subreaper family (WSL2 orphans reparent to Relay, never a literal ppid==1 check)
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
- Consumes: everything above. Produces: a workspace with no regressions vs
  the recorded baseline (Global Constraints).

- [ ] **Step 0: Triage the known deterministic baseline failure FIRST**

`session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref`
fails deterministically at the recorded baseline (V7: reproduced in
isolation; times out waiting for `terminal.created`) — and it sits on the
exact `terminal.created` frame path this plan modified. Before judging the
sweep, triage it: reproduce at the pre-plan base commit (a clean worktree of
the base branch) to confirm it predates this work, and record the finding in
the task notes. If this plan's changes altered its behavior (e.g. turned a
timeout into a different failure), treat that as a regression and fix it.
If it is purely pre-existing, annotate it and EXCLUDE it — together with the
node_modules-gated `codex_session_ref_resume` failure — from the pass/fail
judgment below.

- [ ] **Step 1: Formatting + lints across the workspace**

Run: `cargo fmt --all -- --check && cargo clippy --workspace --all-targets`
Expected: fmt fully clean (the single baseline diff was fixed in Task 1
Step 0); clippy shows no NEW warnings vs the 60 recorded baseline warnings.
Fix any fallout (formatting only via `cargo fmt --all`).

- [ ] **Step 2: Full workspace test run**

Run: `cargo test --workspace`
Expected: no NEW failures vs the recorded baseline — 468+new passed; only
the two known baseline failures may remain (the env-gated
`codex_session_ref_resume` one, and the Step 0-triaged
`session_identity_frames` one if confirmed pre-existing). (If any suite in
the workspace is kill/destructive-flagged, run it via
`scripts/sandbox-test.sh "cargo test -p <crate>"` per Global Constraints.)

- [ ] **Step 3: OPTIONAL continuity smoke (best-effort, provisioned machine only)**

The PRIMARY client-visible acceptance evidence for storm-shaped restores is
the Rust-side `restore_storm_drains_bounded_with_per_terminal_ordering`
test (Task 7 Step 2c) — ledger decision ACC-2. The npm smoke is DOWNGRADED
to optional corroboration: it is 3-tab only (not storm-shaped), asserts zero
frame ordering (outcome-only polling), and is UNRUNNABLE in this worktree
(no node_modules; npm install not permitted; requires real
codex/amplifier/claude CLIs and a readable `~/.codex/auth.json`).

If — and only if — a provisioned machine is available:
Run: `npm run smoke:continuity`
Expected: PASS within ~5 minutes (end-user-story corroboration that the
restore flow still restores every tab against the frozen client). If no
such machine is available, record "smoke skipped: unprovisioned worktree
(ACC-2)" in the task notes and rely on the Task 7 Step 2c evidence.

- [ ] **Step 4: Commit (only if fixes were needed)**

If Steps 0-3 required changes:

```bash
cd /home/dan/code/freshell/.worktrees/rust-tauri-port/.worktrees/rust-wsl-crash-hardening
git add -A crates
git commit \
  -m "fix(rust): workspace verification fallout for wsl crash hardening" \
  -m "- <describe each fix in one bullet>" \
  -m "Verification: cargo fmt --all -- --check; cargo clippy --workspace --all-targets (no new warnings vs 60-warning baseline); cargo test --workspace (no new failures vs recorded baseline); npm run smoke:continuity (optional — pass or skipped-unprovisioned per ACC-2)." \
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
| Same-requestId create idempotency (frozen-client reconnect resend; legacy `createdByRequestId` parity) | 7b | `same_requestid_resend_returns_existing_terminal` + `duplicate_while_queued_does_not_double_spawn` (real socket) |
| Shutdown race: no orphaned PTY from an in-flight gated create (A10) | 3, 6, 7 | `gated_create_racing_shutdown_leaves_no_live_pty` + shutdown latch + main.rs `kill_all` re-sweep |
| Storm-shaped restore acceptance (ACC-2 primary evidence) | 7 | `restore_storm_drains_bounded_with_per_terminal_ordering` (N=12 > gate limit, no duplicates, no output before attach) |
| Forensics discriminator correct on WSL2 (subreaper, not pid 1) | 8, 9 | boot-chain capture + comparison fields in the forensics line; `record_boot_parent_chain` test |
| Repo conventions, TDD, fmt+clippy clean vs recorded baseline, standard checks | every task + 10 | per-task delta-vs-baseline gates + workspace sweep + Task 7 storm test (npm smoke optional best-effort) |

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
`CreateDedupe::{begin, settle, clear_if_in_flight}`,
`log_shutdown_forensics(&str)` / `record_boot_parent_chain()` are used
identically across Tasks 1-10 (incl. 7b).

Validation traceability (2026-07-26 load-bearing-assumption pass; ledger at
`.the-usual-logs/rust-wsl-crash-hardening/load-bearing-ledger.md`): A1
(non-goals rewritten, tabs-sync de-scoped — ACC-1), A6 (Track 1 reframed to
chronic-stampede/Tcpip-4266 success metric), A10 (shutdown latch + re-sweep,
Tasks 3/6/7), A16 (smoke downgraded, Rust storm test added — ACC-2), A17
(recorded-baseline delta gates + Task 10 Step 0 triage), A20 (Task 7b dedupe
guard); verified-with-caveat notes folded into Tasks 2, 6, 8, 9 and the
non-goals section.
