# Rust Server-Side Create Protection Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Port the legacy per-connection `terminal.create` sliding-window rate limit (with `restore:true` bypass) into the Rust server, and add a new server-wide bounded-concurrency PTY spawn gate, so the frozen client's existing `RATE_LIMITED` retry ladder becomes live and restart storms can no longer spawn unbounded concurrent PTYs.

**Architecture:** Two small new modules in `crates/freshell-ws` — `create_limit.rs` (per-connection sliding-window limiter + boot config) and `spawn_gate.rs` (server-wide FIFO-fair `tokio::sync::Semaphore` gate with queue-depth cap and acquire timeout) — wired into `handle_create` in `crates/freshell-ws/src/terminal.rs`. The limiter is a per-connection local in `terminal::run` (mirroring `output_queue`); the gate is an `Arc` on `WsState`. The synchronous `registry.create` call is wrapped in `tokio::task::spawn_blocking` while the permit is held (validated necessity: on hosts with `nproc <= spawn_concurrency`, inline blocking spawns would wedge every tokio worker INCLUDING the timer driver, deadlocking the whole server — see Task 4). No protocol change: `ErrorCode::RateLimited` already exists in the frozen enum with zero call sites.

**Tech Stack:** Rust (tokio, axum WS, serde), Playwright e2e (`test/e2e-browser/`), vitest (untouched — no Node server or client changes).

## Global Constraints

- **Scope fence:** you own `crates/freshell-ws/src/terminal.rs` create-path additions, the two new modules, `crates/freshell-ws/src/lib.rs` (WsState fields), `crates/freshell-server/src/main.rs` (boot wiring), test files, and `crates/freshell-terminal/src/registry.rs` ONLY if unavoidable (this plan does NOT touch it — the gate lives in freshell-ws; freshell-terminal stays tokio-free).
- **Do NOT touch:** `activity.rs`/`idle.rs` (Lanes A/B/D), `codex_candidate.rs`/`codex.rs` (Lane D), client `src/` (Lane C — the frozen client ladder must work UNCHANGED against the new server-side limit; if a client change ever seems required, STOP and report instead of changing the client). No kimi/gemini/opencode work.
- **Wire contract (pinned, byte-compatible with legacy `sendError`, `server/ws-handler.ts:1688-1712`):**
  `{"type":"error","code":"RATE_LIMITED","message":"Too many terminal.create requests","timestamp":"<ISO>","requestId":"<echo of create.requestId>"}` — no `retryAfter`, no extra keys (the generated contract `port/contract/ws-server-messages.schema.json` declares `additionalProperties:false` for `messages.error`). The client detects: `msg.type === 'error' && msg.requestId === <its requestId> && msg.code === 'RATE_LIMITED'` (`src/components/TerminalView.tsx:3995-3996`), retries the SAME requestId with delays 2s, 4s, 8s, 12s, 12s (5 attempts, ~38s total patience).
- **Legacy parity numbers (server/ws-handler.ts:240-241, 2376-2389):** limit **10** creates per **10_000 ms** sliding window, per WS connection; env `TERMINAL_CREATE_RATE_LIMIT` / `TERMINAL_CREATE_RATE_WINDOW_MS`; prune predicate strict (`now - t < windowMs` survives); rejected creates consume NO budget (timestamp recorded on accept only); `restore:true` creates neither check nor record (`if (!m.restore)`). **Env-parsing semantics (validated — legacy's edge behavior is a bug we deliberately do NOT copy):** legacy is `Number(env || default)`, so unset/`''` → default, but `'garbage'` → `NaN` → the limiter is silently DISABLED, and `'0'`/`'-5'` (truthy strings) → block ALL non-restore creates. Rust sanitizes instead: unset, unparseable, zero, or negative → default (`.filter(|&v| v > 0)`). Parity holds for the cases that matter (unset and valid positive values); the divergence is documented in `create_limit.rs`'s module doc.
- **Gate semantics (new work, no legacy analogue — verified; do not hunt legacy for one):** restore creates ARE subject to the gate (it is exactly what protects restore storms); every gate wait must resolve far below the client's ~38s ladder patience. (Measured on this host: the permit-hold section — the synchronous spawn — is ~0.3ms, so a 30-create storm drains a concurrency-4 gate in ~10ms of cumulative wait.)
- **KNOWN GAP (validated, accepted, documented — do NOT try to fix in this lane):** `handle_create` is NOT the only production PTY spawn path. `freshell-freshagent`'s `spawn_terminal_pane` (`crates/freshell-freshagent/src/terminal_tabs.rs:866`) calls `registry.create` via three token-authed REST routes — `POST /api/tabs`, `POST /api/panes/{id}/split`, `POST /api/panes/{id}/respawn` — mounted in production at `crates/freshell-server/src/main.rs:669`. These bypass both the limiter and the gate. Rationale for accepting: the restart-storm ingress this plan targets (the WSL-outage RCA scenario) is the WS path, which IS fully covered; freshell-freshagent cannot import freshell-ws (dependency direction — see the existing KNOWN GAP comment near `terminal_tabs.rs:820-840`), so sharing the gate needs a neutral-crate refactor that is out of this lane's scope; and the REST routes are already rate-bounded (not concurrency-bounded) by the unconditional SAFE-02 global HTTP token bucket (300-token burst, 5 req/s sustained — `main.rs:745-749` layers it over the merged freshagent router). Record a follow-up recommendation in the PR description: extend spawn-gate coverage to the REST spawn path via a shared/neutral home for the gate.
- **E2E:** specs spin up their OWN Rust servers via `test/e2e-browser/helpers/rust-server.ts` (`RustServer`, ephemeral ports via `findFreePort`); NEVER ports 3001/3002 (the user's LIVE servers); NEVER restart the user's self-hosted Freshell server; keep `server.stop()` in `finally`. New specs = new files; `test/e2e-browser/playwright.config.ts` gets minimal appends (sibling lanes append too; trivial conflicts fine).
- **TDD:** Red-Green-Refactor for every task; run the failing test and watch it fail before implementing.
- **Coordinated suite etiquette:** `npm test` / `npm run check` wait for the shared coordinator gate; set `FRESHELL_TEST_SUMMARY` for broad runs; if another agent holds the gate, WAIT (four sibling lanes run concurrently). `cargo test` and Playwright e2e are NOT coordinator-gated.
- **PR policy:** NOT yet approved — push the branch, STOP before `gh pr create`, report branch + red→green proof.
- Branch: `feat/rust-create-protection` (already checked out in this worktree, based on `origin/main@2bf579e6`).
- Commit trailer (every commit):
  ```
  🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

  Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>
  ```

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/create_limit.rs` | Create | `CreateProtectConfig` (env-backed knobs for BOTH protections) + `CreateRateLimiter` (pure sliding-window math, injected clock) + `epoch_ms()` |
| `crates/freshell-ws/src/spawn_gate.rs` | Create | `SpawnGate` (semaphore + queue cap + timeout + counters) + `SpawnGateError` |
| `crates/freshell-ws/src/lib.rs` | Modify | `pub mod create_limit; pub mod spawn_gate;` + two new `WsState` fields |
| `crates/freshell-ws/src/terminal.rs` | Modify | rate-limit check in `handle_create` after the §5.4 claim loop (`:940`, see Task 3 Placement decision); gate acquisition around `state.registry.create(...)` (~:1314); thread `&mut CreateRateLimiter` through `run` → `handle_client_text` → `handle_create` |
| `crates/freshell-server/src/main.rs` | Modify | boot wiring: `CreateProtectConfig::from_env()` + `SpawnGate` construction (~:446, next to `term09`) |
| ~17 other `WsState { .. }` literal sites (listed in Task 3) | Modify | add the two new fields with defaults |
| `crates/freshell-ws/tests/common/mod.rs` | Modify | `spawn_server_with_create_protect(cfg)` harness variant |
| `crates/freshell-ws/tests/create_protection.rs` | Create | real-socket integration tests: limit fires, restore bypass, wire-shape pin, gate smoke |
| `test/e2e-browser/specs/create-protection-restore-storm-rust.spec.ts` | Create | 15-pane reload storm → `restartAbrupt()` → limiter fires (non-restore recovery creates) → ladder recovers ALL panes |
| `test/e2e-browser/specs/create-rate-limit-ladder-rust.spec.ts` | Create | non-restore flood → RATE_LIMITED fires → client ladder recovers |
| `test/e2e-browser/specs/create-protection-isolation-rust.spec.ts` | Create | two concurrent RustServers; 2-connection restore storm on one (e2e bypass proof); other unaffected |
| `test/e2e-browser/playwright.config.ts` | Modify | append the three spec regexes to `RUST_ONLY_SPECS` and the `rust-chromium` project's `testMatch` |

Key existing facts (verified against this worktree; PR #530 already merged — these are post-merge line numbers):

- `handle_create` — `crates/freshell-ws/src/terminal.rs:883`: `async fn handle_create(create: TerminalCreate, ws_tx: &mut WsSink, state: &WsState, pane_reconcile_v1: bool) -> bool`. Dispatched from `handle_client_text` (`:406-471`), which is called from the per-connection `tokio::select!` loop in `run` (`:107`, `:233-248`). Creates are serialized per connection (one select loop) — the limiter guards sequential floods on one socket; the gate guards cross-connection parallel spawns.
- `create.restore: Option<bool>` (`freshell-protocol/src/client_messages.rs:195-222`, `#[serde(rename_all = "camelCase")]`).
- Error frames: `send_create_error(ws_tx, ErrorCode, String, &request_id)` at `terminal.rs:1730-1747` builds `ServerMessage::Error(ErrorMsg { code, message, timestamp: crate::now_iso(), request_id: Some(..), .. })`.
- `ErrorCode::RateLimited` exists (`crates/freshell-protocol/src/common.rs:74-97`) with zero call sites — no protocol change needed.
- `state.registry.create(...)` call: `terminal.rs:1314-1359`, shaped `if let Err(err) = state.registry.create(/* 9 args */) { cleanup; return send_create_error(PtySpawnFailed, ...) }`. It is a synchronous blocking call (`crates/freshell-terminal/src/registry.rs:679`).
- Config exemplar: `Term09Config` (`crates/freshell-ws/src/backpressure.rs:51-112`) — struct + `Default` + `from_env()` with private `env_usize`/`env_u64` helpers (`.filter(|&v| v > 0)` — a deliberate sanitization, NOT byte-parity with legacy `Number(env || default)`; see the env-parsing note in Global Constraints) → `WsState.term09` field (`lib.rs:192-193`) → wired at `crates/freshell-server/src/main.rs:446`.
- `tokio = { features = ["sync", ...] }` already in freshell-ws — `Semaphore` needs no Cargo.toml change. tokio's `Semaphore` (workspace pins tokio **1.52.3**; fairness and cancel-safety were verified against that version's source) is FIFO-fair: released permits go to queued waiters in order, and `try_acquire_owned` fails while waiters are queued, so a fast path cannot barge. `timeout(acquire_owned())` is leak-free: a dropped acquire future unlinks its queue slot and returns any raced permit (`Drop for Acquire`, batch_semaphore.rs:686-708). Two cautions: NEVER call `OwnedSemaphorePermit::forget()` (it permanently shrinks gate capacity), and re-verify these guarantees on any future tokio major/minor bump.
- Frozen-client restore semantics after abrupt restart + reload (validated end-to-end, post-PR #531): persisted panes keep `terminalId`, so reload goes attach → `INVALID_TERMINAL_ID` → re-create. Only panes with a durable `sessionRef` (coding-CLI panes) re-create with `restore:true`; plain SHELL panes take the fresh-recovery carve-out (`TerminalView.tsx:4105-4135`, `App.tsx:1015-1040`) and send NON-restore creates (`recoveryIntent: 'fresh_after_restore_unavailable'`, no `restore` key) which the limiter counts — legacy counts them identically (`if (!m.restore)`). Consequence: a 15-shell-pane reload storm DOES trip the limiter and recovers via the client ladder; that is the correct, legacy-parity behavior, and Task 5 asserts exactly that. `recoveryIntent` needs no special handling server-side: Rust checks only `create.restore`.
- Client settings gotcha for e2e (validated): the tab-add button honors the SERVER setting `panes.defaultNewPane`, whose default is `'ask'` → new tabs mount PICKER panes and fire ZERO `terminal.create`s. E2E specs that flood via tab-add MUST seed `settings.panes.defaultNewPane: 'shell'` (exact lowercase) in `<home>/.freshell/config.json` via the fixture's `setupHome` — the wizard-bypass write spread-preserves it (`rust-server.ts:184-195`), the server deep-merges it, and `/api/bootstrap` delivers it. Precedent: `specs/settings-persistence-split.spec.ts:13-46`. Caution: an invalid value silently discards the WHOLE persisted settings tree (`settings_store.rs:1279`) — assert `GET /api/settings` shows `'shell'` before flooding.
- Log observability chain for e2e (validated): fixture sets `FRESHELL_LOG_DIR` → server writes `<logsDir>/rust-server.jsonl`, default `EnvFilter` is `info`, event message strings land verbatim in the `msg` field, and `restartAbrupt()` re-opens append-mode (nothing lost). Hardening: the fixture spreads `process.env`, so an inherited `RUST_LOG=error` would suppress the WARN events — Tasks 5/6 pass `env: { RUST_LOG: 'info' }` explicitly.
- `ErrorMsg` wire shape (validated): all five `Option` fields carry `skip_serializing_if`, envelope is internally tagged — `send_create_error` emits exactly `{type, code, message, timestamp, requestId}`. (Side finding, pre-existing and unrelated: reconcile error codes are missing from the schema's `code` enum; `RATE_LIMITED` IS present.)
- `crates/freshell-server/src/rate_limit.rs` was read and is NOT reusable: it is a process-global HTTP token bucket (not a sliding window, not per-connection), and `freshell-ws` cannot import from `freshell-server` (dependency direction is server → ws). Its injectable-clock test style is the template we copy.
- Do NOT read stale line numbers from the campaign plan for `terminal.rs` — the numbers above are post-#530.

---

### Task 1: `CreateRateLimiter` + `CreateProtectConfig` module

**Files:**
- Create: `crates/freshell-ws/src/create_limit.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod create_limit;` next to the existing `pub mod backpressure;` declaration)

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces (later tasks rely on these exact names):
  - `create_limit::CreateProtectConfig { rate_limit: usize, rate_window_ms: u64, spawn_concurrency: usize, spawn_queue_cap: usize, spawn_timeout_ms: u64 }` with `Default` and `pub fn from_env() -> Self`
  - `create_limit::CreateRateLimiter` with `pub fn new(limit: usize, window_ms: u64) -> Self` and `pub fn try_acquire(&mut self, now_ms: u64) -> bool`
  - `create_limit::epoch_ms() -> u64`

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-ws/src/create_limit.rs` containing ONLY the test module for now (so the red run is a compile failure naming the missing items), or — simpler and equally red — write the full file below WITHOUT the `impl` bodies. Recommended: write the whole file with tests, leave `try_acquire` body as `unimplemented!()`, run, watch the tests fail, then fill in. The complete target file:

```rust
//! Server-side `terminal.create` protection knobs + the per-connection
//! sliding-window rate limiter (legacy parity: `server/ws-handler.ts:240-241,
//! 2376-2389`).
//!
//! Legacy semantics reproduced EXACTLY:
//! - default 10 creates per 10_000 ms sliding window, per WS connection
//! - env `TERMINAL_CREATE_RATE_LIMIT` / `TERMINAL_CREATE_RATE_WINDOW_MS`
//!   (same names; parsing deliberately DIVERGES — see below)
//! - prune predicate is strict: a timestamp survives while `now - t < window`
//! - a REJECTED create consumes no budget (timestamps push on accept only)
//! - `restore:true` creates bypass the limiter entirely (the CALLER enforces
//!   the bypass; this type is bypass-agnostic)
//!
//! Deliberate env-parsing divergence from legacy: legacy is
//! `Number(env || default)`, which silently DISABLES the limiter on an
//! unparseable value (`NaN` comparisons are false) and blocks ALL creates on
//! `'0'`/negatives (truthy strings). We sanitize instead: unset, unparseable,
//! zero, or negative -> default. Parity holds for unset and valid positive
//! values — the cases that matter.
//!
//! The spawn-gate knobs (new Rust-side work, no legacy analogue — see
//! [`crate::spawn_gate`]) live in the same config struct to keep the
//! `WsState` surface change to two fields.

use std::collections::VecDeque;

#[derive(Debug, Clone, Copy)]
pub struct CreateProtectConfig {
    /// Max accepted non-restore `terminal.create` per window, per connection.
    pub rate_limit: usize,
    /// Sliding-window length, ms.
    pub rate_window_ms: u64,
    /// Server-wide max concurrent PTY spawns (spawn-gate permits).
    pub spawn_concurrency: usize,
    /// Max creates queued waiting on the gate before failing loud.
    pub spawn_queue_cap: usize,
    /// Max wait for a spawn-gate permit before failing loud, ms. Must stay
    /// far below the frozen client's ~38s RATE_LIMITED ladder patience.
    pub spawn_timeout_ms: u64,
}

impl Default for CreateProtectConfig {
    fn default() -> Self {
        Self {
            rate_limit: 10,
            rate_window_ms: 10_000,
            spawn_concurrency: 4,
            spawn_queue_cap: 64,
            spawn_timeout_ms: 10_000,
        }
    }
}

/// Sanitizing env parse (same shape as the private helpers in
/// `crate::backpressure`): unset, unparseable, zero, or negative -> default.
/// Deliberately saner than legacy `Number(env || default)` — see module doc.
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
    /// (`server/ws-handler.ts:240-241`); gate names are new Rust-side knobs.
    pub fn from_env() -> Self {
        let d = Self::default();
        Self {
            rate_limit: env_usize("TERMINAL_CREATE_RATE_LIMIT", d.rate_limit),
            rate_window_ms: env_u64("TERMINAL_CREATE_RATE_WINDOW_MS", d.rate_window_ms),
            spawn_concurrency: env_usize("FRESHELL_SPAWN_GATE_CONCURRENCY", d.spawn_concurrency),
            spawn_queue_cap: env_usize("FRESHELL_SPAWN_GATE_QUEUE_CAP", d.spawn_queue_cap),
            spawn_timeout_ms: env_u64("FRESHELL_SPAWN_GATE_TIMEOUT_MS", d.spawn_timeout_ms),
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
        Self { timestamps: VecDeque::new(), limit, window_ms }
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
        // At t=10_000 both accepted stamps (t=0) expire (strict `<`).
        // If the two REJECTIONS had been recorded, capacity would still be 0.
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
    fn config_defaults_match_legacy() {
        let c = CreateProtectConfig::default();
        assert_eq!(c.rate_limit, 10);
        assert_eq!(c.rate_window_ms, 10_000);
        assert_eq!(c.spawn_concurrency, 4);
        assert_eq!(c.spawn_queue_cap, 64);
        assert_eq!(c.spawn_timeout_ms, 10_000);
    }

    #[test]
    fn config_from_env_overrides_and_zero_falls_back() {
        // Single test owns all five vars to avoid parallel-test env races.
        std::env::set_var("TERMINAL_CREATE_RATE_LIMIT", "3");
        std::env::set_var("TERMINAL_CREATE_RATE_WINDOW_MS", "0"); // falsy -> default
        std::env::set_var("FRESHELL_SPAWN_GATE_CONCURRENCY", "2");
        std::env::set_var("FRESHELL_SPAWN_GATE_QUEUE_CAP", "not-a-number");
        std::env::set_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS", "500");
        let c = CreateProtectConfig::from_env();
        std::env::remove_var("TERMINAL_CREATE_RATE_LIMIT");
        std::env::remove_var("TERMINAL_CREATE_RATE_WINDOW_MS");
        std::env::remove_var("FRESHELL_SPAWN_GATE_CONCURRENCY");
        std::env::remove_var("FRESHELL_SPAWN_GATE_QUEUE_CAP");
        std::env::remove_var("FRESHELL_SPAWN_GATE_TIMEOUT_MS");
        assert_eq!(c.rate_limit, 3);
        assert_eq!(c.rate_window_ms, 10_000);
        assert_eq!(c.spawn_concurrency, 2);
        assert_eq!(c.spawn_queue_cap, 64);
        assert_eq!(c.spawn_timeout_ms, 500);
    }
}
```

Then add to `crates/freshell-ws/src/lib.rs`, next to the existing `pub mod backpressure;`:

```rust
pub mod create_limit;
```

- [ ] **Step 2: Run tests to verify they fail**

With `try_acquire` body as `unimplemented!()`:

Run: `cargo test -p freshell-ws create_limit -- --nocapture`
Expected: FAIL — the four limiter tests panic with `not implemented`.

- [ ] **Step 3: Implement `try_acquire`**

Replace `unimplemented!()` with the body shown in Step 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws create_limit`
Expected: PASS (6 tests). Also run `cargo clippy -p freshell-ws -- -D warnings` — clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/create_limit.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(rust): add per-connection terminal.create sliding-window limiter + config"
```

---

### Task 2: `SpawnGate` module

**Files:**
- Create: `crates/freshell-ws/src/spawn_gate.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (add `pub mod spawn_gate;`)

**Interfaces:**
- Consumes: `create_limit::CreateProtectConfig` (only in the convenience constructor).
- Produces (later tasks rely on these exact names):
  - `spawn_gate::SpawnGate` — `pub fn new(concurrency: usize, queue_cap: usize) -> Self`, `pub fn from_config(cfg: &crate::create_limit::CreateProtectConfig) -> Self`, `pub async fn acquire(&self, timeout: std::time::Duration) -> Result<tokio::sync::OwnedSemaphorePermit, SpawnGateError>`, counters `pub fn queued_total(&self) -> u64`, `pub fn queue_rejections(&self) -> u64`, `pub fn timeouts(&self) -> u64`
  - `spawn_gate::SpawnGateError` — `enum { QueueFull, Timeout }` (derives `Debug, Clone, Copy, PartialEq, Eq`)

**Design decisions (pinned):**
- The permit is an RAII `OwnedSemaphorePermit`: dropped on completion, failure, or panic-unwind — no leaked permits on any exit path. NEVER call `permit.forget()` — it permanently shrinks gate capacity. (Fairness + cancel-safety verified against the pinned tokio 1.52.3 source; re-verify on tokio bumps.)
- The timeout applies to permit ACQUISITION (queue wait). The spawn itself runs inside `tokio::task::spawn_blocking` while the permit is held (Task 4) — validated as REQUIRED, not optional: with the spawn inline on worker threads, a host with `nproc <= spawn_concurrency` would have all workers (including tokio's timer driver) wedged by hung spawns, so even the gate timeouts could never fire. With spawn_blocking, a hung spawn occupies 1 of N permits plus a blocking-pool thread, the async workers stay free, and the queue keeps draining through the remaining N-1 permits — that is how "one hung spawn can't block the queue" is satisfied. If ALL permits are wedged, queued waiters time out with a loud error frame instead of hanging forever.
- Accepted residual (documented, do not "fix"): if the gate is saturated ≥30s, a connection with 3+ queued creates can accumulate enough select-loop occupancy (creates are serialized per connection) to miss a keepalive ping tick and be terminated loudly. That only happens when every permit is wedged — exactly when failing loud is correct; the client reconnects and the ladder recovers.
- FIFO fairness comes from tokio's fair `Semaphore` (released permits are handed to the oldest queued waiter; `try_acquire_owned` cannot barge past queued waiters).
- Structured observability: `queued_total`/`queue_rejections`/`timeouts` counters + tracing events `spawn_gate_queued` (info), `spawn_gate_queue_full` (warn), `spawn_gate_timeout` (warn). Event NAMES are the log message string (repo convention, e.g. `terminal_identity_unresolved`) so e2e can grep server logs.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-ws/src/spawn_gate.rs` with the full implementation skeleton and tests; leave `acquire`'s body as `unimplemented!()` for the red run. Complete target file:

```rust
//! Server-wide bounded-concurrency PTY spawn gate (restart-storm protection;
//! prior art: docs/plans/2026-07-06-wsl-outage-rca.md — a ~20-tab fleet
//! respawning 50-70 processes in the same instant).
//!
//! Semantics:
//! - `concurrency` permits bound simultaneous PTY spawns server-wide.
//! - FIFO-fair: tokio's Semaphore hands released permits to the oldest
//!   queued waiter, so restore storms drain in arrival order.
//! - Bounded queue: more than `queue_cap` waiters fails LOUD (`QueueFull`)
//!   instead of queueing unboundedly.
//! - Bounded wait: a waiter that cannot get a permit within the timeout
//!   fails LOUD (`Timeout`). Both bounds must resolve far below the frozen
//!   client's ~38s RATE_LIMITED ladder patience.
//! - RAII: the returned `OwnedSemaphorePermit` releases on drop — every
//!   completion/failure/panic path frees the permit.
//!
//! `restore:true` creates bypass the RATE limiter but NOT this gate — the
//! gate is exactly what protects restore storms.

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
}

#[derive(Debug)]
pub struct SpawnGate {
    semaphore: Arc<Semaphore>,
    queue_cap: usize,
    waiting: AtomicUsize,
    queued_total: AtomicU64,
    queue_rejections: AtomicU64,
    timeouts: AtomicU64,
}

impl SpawnGate {
    pub fn new(concurrency: usize, queue_cap: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(concurrency)),
            queue_cap,
            waiting: AtomicUsize::new(0),
            queued_total: AtomicU64::new(0),
            queue_rejections: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
        }
    }

    pub fn from_config(cfg: &crate::create_limit::CreateProtectConfig) -> Self {
        Self::new(cfg.spawn_concurrency, cfg.spawn_queue_cap)
    }

    /// Acquire a spawn permit, queueing FIFO behind other waiters.
    pub async fn acquire(&self, timeout: Duration) -> Result<OwnedSemaphorePermit, SpawnGateError> {
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
        self.queued_total.fetch_add(1, Ordering::Relaxed);
        tracing::info!(
            target: "freshell_ws::spawn_gate",
            waiting = waiting_before + 1,
            "spawn_gate_queued"
        );

        let acquired =
            tokio::time::timeout(timeout, self.semaphore.clone().acquire_owned()).await;
        self.waiting.fetch_sub(1, Ordering::SeqCst);
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

    pub fn queued_total(&self) -> u64 {
        self.queued_total.load(Ordering::Relaxed)
    }

    pub fn queue_rejections(&self) -> u64 {
        self.queue_rejections.load(Ordering::Relaxed)
    }

    pub fn timeouts(&self) -> u64 {
        self.timeouts.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn bounds_concurrency_to_n_and_all_complete() {
        // Spec requirement: spawn N+K creates, assert max in-flight == N,
        // all complete.
        let gate = Arc::new(SpawnGate::new(2, 64));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let gate = Arc::clone(&gate);
            let in_flight = Arc::clone(&in_flight);
            let max_seen = Arc::clone(&max_seen);
            handles.push(tokio::spawn(async move {
                let permit = gate.acquire(Duration::from_secs(5)).await.expect("permit");
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
        let gate = Arc::new(SpawnGate::new(1, 64));
        let holder = gate.acquire(Duration::from_secs(1)).await.expect("holder");
        let order = Arc::new(tokio::sync::Mutex::new(Vec::<usize>::new()));
        let mut handles = Vec::new();
        for i in 0..4 {
            let gate = Arc::clone(&gate);
            let order = Arc::clone(&order);
            handles.push(tokio::spawn(async move {
                let permit = gate.acquire(Duration::from_secs(5)).await.expect("permit");
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
    }

    #[tokio::test]
    async fn queue_cap_fails_loud() {
        let gate = Arc::new(SpawnGate::new(1, 2));
        let _holder = gate.acquire(Duration::from_secs(1)).await.expect("holder");
        // Two waiters occupy the queue.
        let w1 = { let g = Arc::clone(&gate); tokio::spawn(async move { g.acquire(Duration::from_secs(5)).await }) };
        let w2 = { let g = Arc::clone(&gate); tokio::spawn(async move { g.acquire(Duration::from_secs(5)).await }) };
        tokio::time::sleep(Duration::from_millis(50)).await; // let them enqueue
        // Third waiter overflows the cap: immediate loud failure.
        let res = gate.acquire(Duration::from_secs(5)).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::QueueFull);
        assert_eq!(gate.queue_rejections(), 1);
        drop(_holder);
        assert!(w1.await.expect("join").is_ok());
        assert!(w2.await.expect("join").is_ok());
    }

    #[tokio::test]
    async fn timeout_fails_loud_and_leaks_no_permit() {
        let gate = SpawnGate::new(1, 64);
        let holder = gate.acquire(Duration::from_secs(1)).await.expect("holder");
        let res = gate.acquire(Duration::from_millis(50)).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::Timeout);
        assert_eq!(gate.timeouts(), 1);
        drop(holder);
        // The timed-out wait must not have consumed the permit.
        let again = gate.acquire(Duration::from_millis(500)).await;
        assert!(again.is_ok(), "no leaked permits after a timeout");
    }

    #[tokio::test]
    async fn raii_drop_releases_permit() {
        let gate = SpawnGate::new(1, 64);
        let p = gate.acquire(Duration::from_millis(100)).await.expect("first");
        drop(p);
        let p2 = gate.acquire(Duration::from_millis(100)).await;
        assert!(p2.is_ok(), "dropping the guard frees the permit");
    }
}
```

Add to `crates/freshell-ws/src/lib.rs`:

```rust
pub mod spawn_gate;
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws spawn_gate -- --nocapture`
Expected: FAIL — panics with `not implemented` (acquire stub).

- [ ] **Step 3: Implement `acquire`**

Fill in the body shown in Step 1.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws spawn_gate`
Expected: PASS (5 tests). `cargo clippy -p freshell-ws -- -D warnings` — clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/spawn_gate.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(rust): add FIFO-fair bounded-concurrency spawn gate with queue cap and timeout"
```

---

### Task 3: Wire the rate limiter into the WS create path (end-to-end)

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (two new `WsState` fields)
- Modify: `crates/freshell-ws/src/terminal.rs` (thread limiter param; check in `handle_create` after the §5.4 claim loop — see Placement decision below)
- Modify: `crates/freshell-server/src/main.rs` (boot wiring, ~:409 `WsState` literal / ~:446 next to `term09`)
- Modify: every other `WsState { .. }` literal site (verified list): `crates/freshell-ws/src/lib.rs:682` (unit-test helper `fn state()`), `crates/freshell-ws/src/terminal.rs:2647`, `:2846`, `crates/freshell-ws/src/opencode_association.rs:226`, `crates/freshell-ws/src/amplifier_association.rs:251`, `crates/freshell-ws/tests/common/mod.rs:100`, and `crates/freshell-ws/tests/{codex_session_ref_resume,max_payload,safe08_restore_diagnostics,origin_policy,hello_timeout,pane_reconcile,freshagent_claude_kill_interrupt,keepalive,term09_output_queue,freshagent_claude_attach,codex_managed_launch_e2e,diag01_lifecycle_events}.rs` (find each with `rg -n 'WsState \{' crates/`; the compiler enumerates any missed site as a build error — that is the safety net)
- Modify: `crates/freshell-ws/tests/common/mod.rs` (add `spawn_server_with_create_protect`)
- Test: `crates/freshell-ws/tests/create_protection.rs` (create)

**Interfaces:**
- Consumes: `create_limit::{CreateProtectConfig, CreateRateLimiter, epoch_ms}` (Task 1), `spawn_gate::SpawnGate` (Task 2 — the field is added here so the 19-site churn happens ONCE; the gate is not yet enforced in the handler until Task 4).
- Produces:
  - `WsState` gains exactly two fields:
    ```rust
    /// terminal.create protection knobs (rate limit + spawn gate). See
    /// [`crate::create_limit::CreateProtectConfig`].
    pub create_protect: crate::create_limit::CreateProtectConfig,
    /// Server-wide PTY spawn gate. See [`crate::spawn_gate::SpawnGate`].
    pub spawn_gate: std::sync::Arc<crate::spawn_gate::SpawnGate>,
    ```
  - `handle_client_text` and `handle_create` each gain one parameter: `create_limiter: &mut crate::create_limit::CreateRateLimiter` (both already carry `#[allow(clippy::too_many_arguments)]`).
  - Harness: `pub async fn spawn_server_with_create_protect(cfg: freshell_ws::create_limit::CreateProtectConfig) -> String` in `tests/common/mod.rs`, returning the ws URL like the existing `spawn_server()`.

**Placement decision (pinned, validated against the real code):** the paneReconcileV1 requestId-dedupe is NOT a separate short-circuit at the top of `handle_create` — it lives INSIDE the §5.4 keyed-create claim loop (`terminal.rs:898-937`: the loop opens at `:907`, the dedupe/adopt branch is `:908-927` and early-returns at `:926` without spawning; `:889-896` is only a comment block). So the limiter check goes AFTER the claim loop and BEFORE any terminal id is minted: insert it immediately after the loop's guard hand-off `let _keyed_create_guard = keyed_create_guard;` (`terminal.rs:940`) and before the `terminal_id` mint at `:944`. Consequences, in order: (1) an adoptable duplicate create returns at `:926` before ever reaching the limiter — a deduped create is neither checked nor charged, matching legacy's dedupe-first ordering (pinned by the `adopted_duplicate_create_is_never_charged_or_rejected` test below); (2) a rejected create never mints IDs; (3) a rejected paneReconcileV1 create HAS briefly taken the keyed-create reservation — acceptable and safe, because the `KeyedCreateGuard` is RAII (`terminal.rs:869-878`) and releases on the early return exactly like every other early return in this function, so the client's ladder retry with the same requestId re-reserves cleanly. Honest divergence note vs legacy: legacy dedupes ALL duplicate requestIds before the limiter; Rust's dedupe exists only for paneReconcileV1-negotiating clients, and the frozen client never negotiates it (`ws-client.ts:343`). The frozen client DOES bulk re-send same-requestId creates on reconnect (`TerminalView.tsx:4227-4259` re-drive), and post-restart shell-pane creates are NON-restore (see Key existing facts) — against Rust those re-sends are counted by the limiter and, if rejected, recovered by the client's RATE_LIMITED ladder (same requestId, so the contract stays coherent). The underlying missing frozen-client dedupe (duplicate-PTY hazard when a `terminal.created` is lost to a disconnect) is a PRE-EXISTING Rust gap independent of this plan — do not fix it here; if it surfaces in testing, report it rather than expanding scope.

- [ ] **Step 1: Write the failing integration tests**

Create `crates/freshell-ws/tests/create_protection.rs`. Model the socket helpers on `crates/freshell-ws/tests/term09_output_queue.rs` (hello helper at `:151-173` — send `{"type":"hello","token":AUTH_TOKEN,"protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION}` then consume exactly 4 handshake frames; `create_shell_terminal` at `:229-264`). Copy those helpers verbatim into this file (per-file helper copies are this suite's convention), adjusting only names. The tests:

```rust
mod common;

use std::time::Duration;

use freshell_ws::create_limit::CreateProtectConfig;
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message as WsMessage;

// -- copy connect_and_hello / read helpers from term09_output_queue.rs here --

/// Send one terminal.create; return the first error/created frame whose
/// requestId matches.
async fn send_create_and_await_reply(
    ws: &mut TestWs,
    request_id: &str,
    restore: bool,
) -> serde_json::Value {
    let mut msg = serde_json::json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": "shell",
        "shell": "system",
    });
    if restore {
        msg["restore"] = serde_json::json!(true);
    }
    ws.send(WsMessage::Text(msg.to_string())).await.expect("send terminal.create");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_secs(5), ws.next()).await {
            Ok(Some(Ok(WsMessage::Text(text)))) => {
                let Ok(value) = serde_json::from_str::<serde_json::Value>(&text) else {
                    continue;
                };
                let ty = value.get("type").and_then(|v| v.as_str());
                let rid = value.get("requestId").and_then(|v| v.as_str());
                if (ty == Some("terminal.created") || ty == Some("error")) && rid == Some(request_id) {
                    return value;
                }
            }
            Ok(Some(Ok(_))) => {}
            other => panic!("expected reply for {request_id}, got {other:?}"),
        }
    }
    panic!("no reply for {request_id}");
}

#[tokio::test]
async fn eleventh_create_is_rate_limited_with_exact_wire_shape() {
    // Long window so the test cannot flake on elapsed time.
    let cfg = CreateProtectConfig { rate_limit: 3, rate_window_ms: 600_000, ..Default::default() };
    let url = common::spawn_server_with_create_protect(cfg).await;
    let mut ws = connect_and_hello(&url).await;

    for i in 0..3 {
        let reply = send_create_and_await_reply(&mut ws, &format!("cr-ok-{i}"), false).await;
        assert_eq!(reply["type"], "terminal.created", "create {i} within limit succeeds: {reply}");
    }
    let rejected = send_create_and_await_reply(&mut ws, "cr-over", false).await;
    // The exact contract the frozen client ladder matches on
    // (TerminalView.tsx:3995-3996) + the generated schema's
    // additionalProperties:false key set.
    assert_eq!(rejected["type"], "error");
    assert_eq!(rejected["code"], "RATE_LIMITED");
    assert_eq!(rejected["message"], "Too many terminal.create requests");
    assert_eq!(rejected["requestId"], "cr-over");
    assert!(rejected["timestamp"].is_string());
    let mut keys: Vec<&str> = rejected.as_object().unwrap().keys().map(|k| k.as_str()).collect();
    keys.sort_unstable();
    assert_eq!(keys, vec!["code", "message", "requestId", "timestamp", "type"]);
}

#[tokio::test]
async fn restore_creates_bypass_and_do_not_record() {
    let cfg = CreateProtectConfig { rate_limit: 2, rate_window_ms: 600_000, ..Default::default() };
    let url = common::spawn_server_with_create_protect(cfg).await;
    let mut ws = connect_and_hello(&url).await;

    let r1 = send_create_and_await_reply(&mut ws, "cr-n1", false).await;
    assert_eq!(r1["type"], "terminal.created");

    // 5 restore creates: none may be RATE_LIMITED (shell-mode restore does
    // not hit the claude-only P0.4 restore wall, so these plain-succeed).
    for i in 0..5 {
        let r = send_create_and_await_reply(&mut ws, &format!("cr-restore-{i}"), true).await;
        assert_ne!(r["code"], "RATE_LIMITED", "restore create {i} must bypass: {r}");
        assert_eq!(r["type"], "terminal.created", "restore shell create {i} succeeds: {r}");
    }

    // Budget untouched by the 5 restores: one non-restore slot remains.
    let r2 = send_create_and_await_reply(&mut ws, "cr-n2", false).await;
    assert_eq!(r2["type"], "terminal.created", "restores recorded nothing");
    let r3 = send_create_and_await_reply(&mut ws, "cr-n3", false).await;
    assert_eq!(r3["code"], "RATE_LIMITED", "third non-restore create exceeds limit 2");
}

/// Pins the Placement decision: the paneReconcileV1 dedupe/adopt branch
/// (terminal.rs:908-927, early return :926) runs BEFORE the limiter check,
/// so an adoptable duplicate create is neither checked nor charged even
/// when the budget is exhausted (legacy dedupe-first ordering).
#[tokio::test]
async fn adopted_duplicate_create_is_never_charged_or_rejected() {
    let cfg = CreateProtectConfig { rate_limit: 2, rate_window_ms: 600_000, ..Default::default() };
    let url = common::spawn_server_with_create_protect(cfg).await;
    // paneReconcileV1-negotiated connection: identical to connect_and_hello
    // except the hello adds `"capabilities":{"paneReconcileV1":true}` (an
    // OBJECT, not an array) — copy the shape from the negotiating connect
    // helper in tests/pane_reconcile.rs:130-162 (same 4 handshake frames).
    let mut ws = connect_and_hello_pane_reconcile_v1(&url).await;

    // Two charged creates exhaust the budget; capture the first terminalId.
    let created = send_create_and_await_reply(&mut ws, "cr-dup", false).await;
    assert_eq!(created["type"], "terminal.created");
    let original_id = created["terminalId"].as_str().expect("terminalId").to_string();
    let filler = send_create_and_await_reply(&mut ws, "cr-fill", false).await;
    assert_eq!(filler["type"], "terminal.created");

    // Prove the budget is exhausted: a FRESH requestId is rejected.
    let over = send_create_and_await_reply(&mut ws, "cr-over", false).await;
    assert_eq!(over["code"], "RATE_LIMITED", "fresh create over limit rejects: {over}");

    // The duplicate-requestId re-send (the reconnect re-drive shape) must
    // ADOPT the live terminal — never RATE_LIMITED, never a new spawn —
    // because the adopt branch returns before the limiter is consulted.
    // (Adoption is registry-wide by create_request_id and same-socket safe:
    // registry.newest_live_by_create_request_id, freshell-terminal
    // registry.rs:1516-1521.)
    let adopted = send_create_and_await_reply(&mut ws, "cr-dup", false).await;
    assert_eq!(adopted["type"], "terminal.created", "adopt, not rate limit: {adopted}");
    assert_eq!(adopted["terminalId"], original_id.as_str(), "same live terminal adopted");
}
```

Add the harness variant in `crates/freshell-ws/tests/common/mod.rs` — copy the existing `spawn_server()` body exactly, changing only the two new `WsState` fields:

```rust
pub async fn spawn_server_with_create_protect(
    cfg: freshell_ws::create_limit::CreateProtectConfig,
) -> String {
    // identical to spawn_server(), except the WsState literal sets:
    //   create_protect: cfg,
    //   spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::from_config(&cfg)),
    ...
}
```

(While here, the existing `spawn_server`/`spawn_server_with_specs` get the same two fields with `CreateProtectConfig::default()`.)

- [ ] **Step 2: Run to verify red**

Run: `cargo test -p freshell-ws --test create_protection`
Expected: FAIL — first a compile error (`WsState` has no field `create_protect`); after adding the fields mechanically (Step 3a) but before the handler check (Step 3c), the tests run and FAIL on `assert_eq!(rejected["type"], "error")` because the 4th create succeeds (and `adopted_duplicate_create_is_never_charged_or_rejected` fails on its `cr-over` RATE_LIMITED assertion for the same reason). Watch BOTH failure shapes.

- [ ] **Step 3: Implement**

3a. Add the two `WsState` fields (`lib.rs`, next to `term09`, doc comments as in Interfaces above). Fix every literal site enumerated by the compiler: tests/helpers get

```rust
create_protect: freshell_ws::create_limit::CreateProtectConfig::default(),
spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(4, 64)),
```

(inside the crate use `crate::` paths). In `crates/freshell-server/src/main.rs` (~:446, next to `term09: ...from_env()`):

```rust
create_protect: freshell_ws::create_limit::CreateProtectConfig::from_env(),
spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::from_config(
    &freshell_ws::create_limit::CreateProtectConfig::from_env(),
)),
```

(hoist the `from_env()` result into a local `let create_protect = ...;` above the literal and use it for both fields — call it once).

3b. In `terminal::run` (`terminal.rs`, next to the `output_queue` construction at ~:143-146):

```rust
let mut create_limiter = crate::create_limit::CreateRateLimiter::new(
    state.create_protect.rate_limit,
    state.create_protect.rate_window_ms,
);
```

Thread `&mut create_limiter` through the `handle_client_text` call in the select loop, add `create_limiter: &mut crate::create_limit::CreateRateLimiter` to `handle_client_text`'s signature, and pass it into `handle_create` at the `ClientMessage::TerminalCreate` arm (`:470-471`). Update the two inline-test callers (`terminal.rs:2647`, `:2846` regions) to construct and pass a local limiter.

3c. Immediately AFTER the §5.4 claim loop — insert directly after `let _keyed_create_guard = keyed_create_guard;` (`terminal.rs:940`) and before the terminal id mint at `:944` (see the Placement decision above; the dedupe/adopt branch inside the loop early-returns at `:926` before this check, so adopted duplicates are never charged):

```rust
    // Per-connection create rate limit (legacy parity: ws-handler.ts:2376-2389).
    // restore:true bypasses — neither checked nor recorded (`if (!m.restore)`).
    if create.restore != Some(true)
        && !create_limiter.try_acquire(crate::create_limit::epoch_ms())
    {
        tracing::warn!(
            target: "freshell_ws::create_limit",
            request_id = %create.request_id,
            "terminal_create_rate_limited"
        );
        return send_create_error(
            ws_tx,
            ErrorCode::RateLimited,
            "Too many terminal.create requests".to_string(),
            &create.request_id,
        )
        .await;
    }
```

- [ ] **Step 4: Run to verify green**

Run: `cargo test -p freshell-ws` (full crate — proves the ~19-site churn broke nothing)
Expected: PASS, including both new integration tests.
Run: `cargo test -p freshell-server && cargo clippy --workspace -- -D warnings`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws crates/freshell-server
git commit -m "feat(rust): enforce per-connection terminal.create rate limit with restore bypass"
```

---

### Task 4: Wire the spawn gate around the PTY spawn

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (gate acquisition + error mapping + pure mapping fn + inline unit test)
- Test: `crates/freshell-ws/tests/create_protection.rs` (add gate smoke test + zero-permit wiring-proof test)

**Interfaces:**
- Consumes: `WsState.spawn_gate`, `WsState.create_protect.spawn_timeout_ms` (Task 3), `spawn_gate::SpawnGateError` (Task 2).
- Produces: a pure fn in `terminal.rs` used by the handler and pinned by a unit test:
  ```rust
  /// Map a gate rejection to the client-facing error frame parts.
  /// QueueFull -> RATE_LIMITED so the frozen client's retry ladder converts
  /// overload into backoff-and-retry (by the retry, the queue has drained).
  /// Timeout -> PTY_SPAWN_FAILED: fail loud; the pane shows a launch error.
  fn spawn_gate_error_parts(err: crate::spawn_gate::SpawnGateError) -> (ErrorCode, &'static str) {
      match err {
          crate::spawn_gate::SpawnGateError::QueueFull => {
              (ErrorCode::RateLimited, "Too many terminal.create requests")
          }
          crate::spawn_gate::SpawnGateError::Timeout => {
              (ErrorCode::PtySpawnFailed, "Timed out waiting for a terminal spawn slot")
          }
      }
  }
  ```
  (QueueFull deliberately reuses the pinned RATE_LIMITED message so the client-facing contract stays single-shaped.)

- [ ] **Step 1: Write the failing tests**

1a. Inline unit test (append to an existing `#[cfg(test)] mod` in `terminal.rs`, e.g. the one at `:2209`):

```rust
    #[test]
    fn spawn_gate_error_parts_maps_queue_full_to_rate_limited_and_timeout_to_spawn_failed() {
        let (code, msg) = spawn_gate_error_parts(crate::spawn_gate::SpawnGateError::QueueFull);
        assert!(matches!(code, ErrorCode::RateLimited));
        assert_eq!(msg, "Too many terminal.create requests");
        let (code, msg) = spawn_gate_error_parts(crate::spawn_gate::SpawnGateError::Timeout);
        assert!(matches!(code, ErrorCode::PtySpawnFailed));
        assert_eq!(msg, "Timed out waiting for a terminal spawn slot");
    }
```

1b. Integration smoke in `tests/create_protection.rs` — the gate at concurrency 1 must serialize cross-connection restore storms without breaking any create (deterministic outcome assertion, not a timing assertion; the concurrency BOUND itself is proven by the Task 2 unit tests):

```rust
#[tokio::test]
async fn gate_at_concurrency_one_never_breaks_a_restore_storm() {
    let cfg = CreateProtectConfig {
        spawn_concurrency: 1,
        spawn_queue_cap: 64,
        spawn_timeout_ms: 30_000,
        ..Default::default()
    };
    let url = common::spawn_server_with_create_protect(cfg).await;

    // Two connections firing interleaved restore creates: every one must
    // succeed (restore bypasses the RATE limit but NOT the gate).
    let mut ws_a = connect_and_hello(&url).await;
    let mut ws_b = connect_and_hello(&url).await;
    for i in 0..4 {
        let ra = send_create_and_await_reply(&mut ws_a, &format!("cr-a-{i}"), true).await;
        assert_eq!(ra["type"], "terminal.created", "conn A create {i}: {ra}");
        let rb = send_create_and_await_reply(&mut ws_b, &format!("cr-b-{i}"), true).await;
        assert_eq!(rb["type"], "terminal.created", "conn B create {i}: {rb}");
    }
}
```

1c. The WIRING PROOF, also in `tests/create_protection.rs` — deterministic and non-vacuous: if `handle_create` never consults the gate, every create here plain-succeeds and the test FAILS. A zero-permit gate can never grant, so the first create queues and times out with the pinned Timeout error frame:

```rust
#[tokio::test]
async fn zero_permit_gate_times_out_create_with_pinned_error_frame() {
    // spawn_concurrency: 0 => SpawnGate::from_config builds a 0-permit
    // semaphore (legal: only from_env treats 0 as "fall back to default";
    // a literal config passes 0 straight through from_config -> new).
    // acquire() can therefore never succeed: the create queues (under the
    // 64-cap) and times out after spawn_timeout_ms.
    let cfg = CreateProtectConfig {
        spawn_concurrency: 0,
        spawn_queue_cap: 64,
        spawn_timeout_ms: 250,
        ..Default::default()
    };
    let url = common::spawn_server_with_create_protect(cfg).await;
    let mut ws = connect_and_hello(&url).await;

    let rejected = send_create_and_await_reply(&mut ws, "cr-gate-timeout", false).await;
    assert_eq!(rejected["type"], "error", "gate must reject: {rejected}");
    assert_eq!(rejected["code"], "PTY_SPAWN_FAILED");
    assert_eq!(rejected["message"], "Timed out waiting for a terminal spawn slot");
    assert_eq!(rejected["requestId"], "cr-gate-timeout");

    // restore:true is exempt from the RATE limit but NOT the gate.
    let restore_rejected = send_create_and_await_reply(&mut ws, "cr-gate-restore", true).await;
    assert_eq!(
        restore_rejected["code"], "PTY_SPAWN_FAILED",
        "restore creates go THROUGH the gate: {restore_rejected}"
    );
}
```

- [ ] **Step 2: Run to verify red**

Run: `cargo test -p freshell-ws spawn_gate_error_parts`
Expected: FAIL to compile — `spawn_gate_error_parts` not defined.
Run: `cargo test -p freshell-ws --test create_protection zero_permit_gate`
Expected: FAIL — the gate is not yet consulted by `handle_create`, so both creates plain-succeed (`terminal.created`) and the first `assert_eq!(rejected["type"], "error")` fails. This red run is what makes the wiring proof non-vacuous — capture it in the task log.
(The concurrency-1 smoke test passes already — it pins non-regression once the gate lands; note that in the task log.)

- [ ] **Step 3: Implement**

Add `spawn_gate_error_parts` (code above) near `send_create_error` (`terminal.rs:~1730`). Then insert the acquisition immediately ABOVE the existing `if let Err(err) = state.registry.create(` line (`terminal.rs:1314`):

```rust
    // Server-wide spawn gate (restart-storm protection; WSL-outage RCA prior
    // art). restore creates go THROUGH the gate. RAII permit: released on
    // completion, failure, or unwind when `_spawn_permit` drops at scope end.
    let _spawn_permit = match state
        .spawn_gate
        .acquire(std::time::Duration::from_millis(
            state.create_protect.spawn_timeout_ms,
        ))
        .await
    {
        Ok(permit) => permit,
        Err(err) => {
            let (code, msg) = spawn_gate_error_parts(err);
            return send_create_error(ws_tx, code, msg.to_string(), &create.request_id).await;
        }
    };
```

Then wrap the synchronous `state.registry.create(...)` call at `terminal.rs:1314` in `tokio::task::spawn_blocking`, keeping the SAME error handling shape. This is REQUIRED, not optional (validated): `main.rs` is a bare `#[tokio::main]` (workers = nproc), so on hosts with `nproc <= spawn_concurrency` up to 4 inline blocking spawns would wedge every tokio worker — including the timer driver, so gate timeouts and keepalive ticks could never fire: server-wide deadlock, and a single hung spawn freezes a 1-CPU host entirely. Shape:

```rust
    // The PTY spawn is synchronous; run it on the blocking pool so hung/slow
    // spawns occupy a permit + a blocking thread, never an async worker
    // (on small hosts, N inline blocking spawns would wedge the whole
    // runtime including the timer driver). Permit stays held throughout.
    let registry = state.registry.clone();
    /* clone/move the 9 existing args into the closure */
    let create_result = match tokio::task::spawn_blocking(move || {
        registry.create(/* same 9 args, moved */)
    })
    .await
    {
        Ok(res) => res,
        Err(join_err) => Err(std::io::Error::other(format!(
            "terminal spawn task panicked: {join_err}"
        ))),
    };
    if let Err(err) = create_result {
        /* existing cleanup + send_create_error(PtySpawnFailed, ...) body, unchanged */
    }
```

Adapt mechanically: args that are references get cloned into owned values before the closure (the compiler enumerates them); the `Err` arm's body is the EXISTING cleanup/error code, untouched.

Notes for the implementer:
- The early `return` path is safe: the §5.4 `KeyedCreateGuard` (RAII, `terminal.rs:869-878`) releases the keyed-create reservation on drop, same as every other early-return in this function.
- The permit must cover the spawn_blocking await; the codex-adopt follow-up failure path directly below it (`:1367-1381`) is fine to leave inside the permit scope — the permit drops when `handle_create` returns.
- Accepted residual (do not "fix"): under a fully wedged gate, serialized queued creates can stack select-loop waits past the 30s keepalive window and the storming connection gets terminated loudly — acceptable (fail loud, client reconnects); see Task 2's design decisions.
- Do NOT touch `crates/freshell-terminal/src/registry.rs` — the spawn_blocking wrap lives entirely in `terminal.rs`; freshell-terminal stays tokio-free.

- [ ] **Step 4: Run to verify green**

Run: `cargo test -p freshell-ws`
Expected: PASS — unit map test, zero-permit wiring test, gate smoke, all three Task 3 tests, and all pre-existing tests.
Run: `cargo clippy --workspace -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws
git commit -m "feat(rust): bound concurrent PTY spawns with FIFO spawn gate on the create path"
```

---

### Task 5: E2E — reload-storm spec (15 panes, abrupt restart, limiter fires, ladder recovers ALL panes)

> **Validated premise correction:** after an abrupt restart + reload, plain
> SHELL panes re-create with NON-restore (`recoveryIntent`) creates — only
> sessionRef-bearing (coding-CLI) panes send `restore:true` (see Key existing
> facts). So a 15-shell-pane reload storm legitimately TRIPS the limiter and
> recovers via the frozen client's ladder — on legacy exactly as on Rust.
> This spec asserts that real behavior (positive `terminal_create_rate_limited`
> log grep = non-vacuous; every pane recovers = the ladder works end-to-end).
> The restore-BYPASS e2e proof lives in Task 7's raw-WS restore flood, and at
> the socket level in Task 3's `restore_creates_bypass_and_do_not_record`.

**Files:**
- Create: `test/e2e-browser/specs/create-protection-restore-storm-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append `/create-protection-restore-storm-rust\.spec\.ts$/,` + a one-line justifying comment to BOTH the `RUST_ONLY_SPECS` array (~:92) and the `rust-chromium` project's `testMatch` array — same shape as the `restore-contract-wall-rust` entries; sibling lanes append here too, trivial conflicts fine)

**Interfaces:**
- Consumes: server behavior from Tasks 3-4 (default config: limit 10/10s, gate concurrency 4). Helpers copied per this suite's per-spec-ownership convention from `specs/compound-restart-rust.spec.ts` (`waitForWsReady`, `readServerLogs`) and `specs/restore-contract-wall-rust.spec.ts` (`collectLeaves`, `flushPersistence`, `reloadAndReconnect`).
- Produces: nothing downstream.

- [ ] **Step 1: Write the spec (red: the positive `terminal_create_rate_limited` log assertion only passes once Tasks 3-4 exist — on `origin/main`'s binary the burst is never rate limited, so the spec FAILS its non-vacuous grep; run it against `origin/main`'s binary via `FRESHELL_E2E_RUST_SERVER_BIN` if convenient, otherwise document that Tasks 3-4 landed first and this spec pins them)**

```ts
/**
 * LANE E (create protection): reload-storm contract.
 * 15 shell terminal tabs -> SIGKILL restart (RustServer.restartAbrupt()) ->
 * the reload storm re-creates every pane with NON-restore (recoveryIntent)
 * creates (validated frozen-client behavior post-PR #531), so the 15-burst
 * TRIPS the 10/10s limiter (server log MUST contain
 * terminal_create_rate_limited — non-vacuous) and the frozen client's
 * RATE_LIMITED ladder recovers ALL panes, with the spawn gate (default
 * concurrency 4) active throughout. Owns its RustServer (ephemeral port,
 * never the user's 3001/3002). Helpers copied per per-spec-ownership.
 * Seeds panes.defaultNewPane:'shell' so tab-add mounts terminals directly
 * (default 'ask' would create picker panes and fire ZERO creates).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import type { Page } from '@playwright/test'

const TAB_COUNT = 15

function collectLeaves(node: any): any[] {
  if (!node) return []
  if (node.type === 'leaf') return [node]
  if (node.type === 'split') return (node.children ?? []).flatMap(collectLeaves)
  return []
}

async function waitForWsReady(page: Page, timeoutMs = 60_000): Promise<void> {
  await expect(async () => {
    const status = await page.evaluate(
      () => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
    expect(status).toBe('ready')
  }).toPass({ timeout: timeoutMs })
}

async function readServerLogs(logsDir: string): Promise<string> {
  const files = await fs.readdir(logsDir).catch(() => [] as string[])
  let combined = ''
  for (const f of files) {
    combined += await fs.readFile(path.join(logsDir, f), 'utf8').catch(() => '')
  }
  return combined
}

/** terminalId of every leaf across every tab (poll-friendly). */
async function allLeafTerminalIds(harness: TestHarness): Promise<(string | null)[]> {
  const state = await harness.getState()
  const ids: (string | null)[] = []
  for (const tab of state.tabs.tabs) {
    for (const leaf of collectLeaves(state.panes.layouts[tab.id])) {
      ids.push(leaf?.content?.terminalId ?? null)
    }
  }
  return ids
}

test.describe('Create protection: restore storm (Rust only)', () => {
  test.setTimeout(300_000)

  test('15-pane reload storm survives abrupt restart: limiter fires, ladder recovers all panes', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = new RustServer({
      // An inherited RUST_LOG=error would suppress the WARN events this spec
      // greps for (the fixture spreads process.env) — pin it.
      env: { RUST_LOG: 'info' },
      // Tab-add must mount shell terminals directly; the default
      // panes.defaultNewPane:'ask' creates PICKER panes (zero creates).
      // setupHome runs before the wizard-bypass write, which spread-preserves
      // this seed (rust-server.ts:184-195); it re-runs on every boot, so the
      // full-file write is idempotent. Value must be EXACT lowercase 'shell'
      // (an invalid value silently discards the whole settings tree).
      setupHome: async (homeDir) => {
        const dir = path.join(homeDir, '.freshell')
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { panes: { defaultNewPane: 'shell' } },
        }, null, 2))
      },
    })
    const info: TestServerInfo = await server.start()
    try {
      // Belt-and-suspenders: the seed actually took (converts a silent
      // settings-tree fallback into a crisp failure here).
      const settingsRes = await fetch(`${info.baseUrl}/api/settings`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(((await settingsRes.json()) as any)?.panes?.defaultNewPane).toBe('shell')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page) // also past /api/bootstrap settings hydration

      // With defaultNewPane:'shell' the first tab mounts a terminal directly
      // (no boot picker).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // Storm SETUP under the 10/10s limit: one tab per ~1.2s, waiting for
      // each new tab's terminal before the next (a fresh tab is active on
      // creation, so its terminal mounts immediately).
      const addButton = page.locator('[data-context="tab-add"]')
      for (let i = 1; i < TAB_COUNT; i++) {
        await addButton.click()
        await harness.waitForTabCount(i + 1)
        await expect.poll(async () => {
          const ids = await allLeafTerminalIds(harness)
          return ids.length >= i + 1 && ids.every((id) => id !== null)
        }, { timeout: 30_000 }).toBe(true)
        await page.waitForTimeout(1_200)
      }
      const idsBefore = (await allLeafTerminalIds(harness)) as string[]
      expect(idsBefore).toHaveLength(TAB_COUNT)

      await page.evaluate(() => {
        (window as any).__FRESHELL_TEST_HARNESS__?.dispatch({ type: 'persist/flushNow' })
      })

      // --- SIGKILL + reboot on same home/port/token; reload so the client
      // mounts every persisted tab at once (the RCA thundering herd). ---
      await server.restartAbrupt()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page)

      // ALL panes recover: same tab count, every leaf re-anchors to a NEW
      // live terminal, no pane in error status. Shell panes re-create with
      // NON-restore recoveryIntent creates; the 15-burst exceeds 10/10s, so
      // ~5 get RATE_LIMITED and the frozen ladder retries them (2s/4s/8s
      // cumulative — by ~14s the window has drained). 120s is generous.
      await expect.poll(() => harness.getTabCount(), { timeout: 60_000 }).toBe(TAB_COUNT)
      await expect.poll(async () => {
        const ids = await allLeafTerminalIds(harness)
        return ids.length === TAB_COUNT
          && ids.every((id) => id !== null && !idsBefore.includes(id as string))
      }, { timeout: 120_000 }).toBe(true)
      const state = await harness.getState()
      for (const tab of state.tabs.tabs) {
        for (const leaf of collectLeaves(state.panes.layouts[tab.id])) {
          expect(leaf?.content?.status, `pane in tab ${tab.id}`).not.toBe('error')
        }
      }

      // Non-vacuous proof the limiter actually fired on the reload storm
      // (validated: post-restart shell-pane creates are non-restore, so a
      // 15-burst MUST trip the 10/10s limit) — and the panes above still all
      // recovered, which is the ladder working end-to-end.
      const logs = await readServerLogs(info.logsDir)
      expect(logs).toContain('terminal_create_rate_limited')
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
```

Register in `test/e2e-browser/playwright.config.ts` (both arrays):

```ts
  // LANE E create protection: restore-storm contract; imports RustServer
  // directly for restartAbrupt(). See docs/plans/2026-07-25-rust-create-protection.md
  /create-protection-restore-storm-rust\.spec\.ts$/,
```

- [ ] **Step 2: Run the spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/create-protection-restore-storm-rust.spec.ts`
Expected: PASS (first run is slow: globalSetup rebuilds client+server; the Rust fixture builds `target/release/freshell-server`).
If lazy tab mounting makes background tabs restore only on visit, adapt by clicking through each tab post-reload before the poll (keep the same assertions) — do not weaken assertions.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/create-protection-restore-storm-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): reload storm survives abrupt restart via the frozen client ladder"
```

---

### Task 6: E2E — non-restore flood hits RATE_LIMITED; client ladder recovers

**Files:**
- Create: `test/e2e-browser/specs/create-rate-limit-ladder-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append `/create-rate-limit-ladder-rust\.spec\.ts$/,` + comment to `RUST_ONLY_SPECS` and `rust-chromium` `testMatch`)

**Interfaces:**
- Consumes: Task 3 server behavior; the UNCHANGED client ladder (`TerminalView.tsx` — 5 attempts, 2/4/8/12/12s, same requestId). Reuses this plan's Task 5 helper shapes (`collectLeaves`, `allLeafTerminalIds`, `readServerLogs` — copy into this file, per-spec-ownership).
- Produces: nothing downstream.

- [ ] **Step 1: Write the spec**

```ts
/**
 * LANE E (create protection): the frozen client's RATE_LIMITED retry ladder
 * against the Rust limiter. Rapid tab storm fires 15 non-restore
 * terminal.creates in a burst; the server rejects overflow with the pinned
 * RATE_LIMITED frame; the client ladder (2/4/8/12/12s, same requestId)
 * recovers every pane WITHOUT any client change. Non-vacuous: the server
 * log must contain terminal_create_rate_limited.
 * Seeds panes.defaultNewPane:'shell' (validated: the default 'ask' makes
 * tab-add create PICKER panes — zero terminal.creates, vacuous test).
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'

const TAB_COUNT = 15 // 15 burst creates: 10 accepted, 5 rate-limited

// copy collectLeaves / allLeafTerminalIds / readServerLogs / waitForWsReady
// AND the setupHome defaultNewPane:'shell' seed from Task 5's spec

test.describe('Create rate limit: client ladder recovery (Rust only)', () => {
  test.setTimeout(240_000)

  test('a non-restore create flood is rate limited and the ladder recovers all panes', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = new RustServer({
      env: { RUST_LOG: 'info' }, // an inherited RUST_LOG=error would suppress the WARN grep
      setupHome: /* same defaultNewPane:'shell' seed as Task 5 */,
    })
    const info: TestServerInfo = await server.start()
    try {
      // Seed took (guards the silent settings-tree fallback).
      const settingsRes = await fetch(`${info.baseUrl}/api/settings`, {
        headers: { 'x-auth-token': info.token },
      })
      expect(((await settingsRes.json()) as any)?.panes?.defaultNewPane).toBe('shell')

      await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      await waitForWsReady(page) // settings hydrated before the flood (bootstrap race)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })

      // BURST: rapid clicks, no waiting — every new tab mounts a fresh
      // (non-restore) terminal.create.
      const addButton = page.locator('[data-context="tab-add"]')
      for (let i = 1; i < TAB_COUNT; i++) {
        await addButton.click()
      }
      await harness.waitForTabCount(TAB_COUNT)

      // The limit actually fired (otherwise this test is vacuous).
      await expect.poll(async () => readServerLogs(info.logsDir), { timeout: 30_000 })
        .toContain('terminal_create_rate_limited')

      // Ladder recovery: rejected creates retry at 2s/6s/14s cumulative;
      // by ~14s the 10s window has drained and every pane comes up.
      await expect.poll(async () => {
        const ids = await allLeafTerminalIds(harness)
        return ids.length === TAB_COUNT && ids.every((id) => id !== null)
      }, { timeout: 120_000 }).toBe(true)
      const state = await harness.getState()
      for (const tab of state.tabs.tabs) {
        for (const leaf of collectLeaves(state.panes.layouts[tab.id])) {
          expect(leaf?.content?.status, `pane in tab ${tab.id}`).not.toBe('error')
        }
      }
    } finally {
      await server.stop().catch(() => {})
    }
  })
})
```

Config registration: same two-array append pattern as Task 5, comment:

```ts
  // LANE E create protection: frozen-client RATE_LIMITED ladder vs the Rust
  // limiter. See docs/plans/2026-07-25-rust-create-protection.md
  /create-rate-limit-ladder-rust\.spec\.ts$/,
```

- [ ] **Step 2: Run the spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/create-rate-limit-ladder-rust.spec.ts`
Expected: PASS. If the rapid-click burst fails to exceed 10 creates in 10s on a slow machine (log never contains `terminal_create_rate_limited`), start the server with `env: { TERMINAL_CREATE_RATE_LIMIT: '5' }` in the `RustServer` options and adjust the comment — the assertion set stays identical.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/create-rate-limit-ladder-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): frozen client ladder recovers a rate-limited create flood"
```

---

### Task 7: E2E — two concurrent servers; storming one leaves the other unaffected

**Files:**
- Create: `test/e2e-browser/specs/create-protection-isolation-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (append `/create-protection-isolation-rust\.spec\.ts$/,` + comment to both arrays)

**Interfaces:**
- Consumes: Tasks 3-4 behavior. Raw-WS client copied from `specs/reconcile-handshake-rust.spec.ts:61-165` (`SyntheticClient` — per-spec-ownership: copy, don't import). No two-concurrent-RustServer precedent exists; nothing structurally prevents it (each instance gets its own ephemeral port, mkdtemp HOME, token, process group).
- Produces: nothing downstream.

- [ ] **Step 1: Write the spec**

```ts
/**
 * LANE E (create protection): blast-radius isolation + e2e restore-bypass
 * proof. Two concurrent RustServer instances (first such spec — each has its
 * own ephemeral port, HOME, token, process group). Storm server A with
 * restore:true creates over raw WS from TWO connections (15 each — creates
 * are serialized per connection server-side, so multiple connections are
 * what puts parallel spawn pressure on the gate; the concurrency BOUND
 * itself is pinned by Task 2/4 tests). 15 restore creates per connection
 * inside one 10s window exceeds the 10/10s limit — every one succeeding IS
 * the e2e restore-bypass proof. Meanwhile server B serves a browser session;
 * B's health latency and terminal interactivity must be unaffected.
 */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { test, expect } from '../helpers/fixtures.js'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { TerminalHelper } from '../helpers/terminal-helpers.js'

const STORM_CLIENTS = 2
const CREATES_PER_CLIENT = 15 // > the 10/10s limit: succeeding proves restore bypass

// copy the SyntheticClient class from reconcile-handshake-rust.spec.ts:61-165
// (connect(info) does hello/ready; send(frame); waitFor(match, timeoutMs); close())

test.describe('Create protection: cross-server isolation (Rust only)', () => {
  test.setTimeout(240_000)

  test('storming server A does not degrade server B', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const serverA = new RustServer({})
    const serverB = new RustServer({})
    const infoA: TestServerInfo = await serverA.start()
    const infoB: TestServerInfo = await serverB.start()
    expect(infoA.port).not.toBe(infoB.port)
    try {
      // Browser session on B with one live terminal.
      await page.goto(`${infoB.baseUrl}/?token=${infoB.token}&e2e=1`)
      const harness = new TestHarness(page)
      await harness.waitForHarness()
      await harness.waitForConnection()
      for (const name of ['Shell', 'WSL', 'CMD', 'PowerShell', 'Bash']) {
        const button = page.getByRole('button', { name: new RegExp(`^${name}$`, 'i') })
        if (await button.isVisible().catch(() => false)) { await button.click(); break }
      }
      const terminal = new TerminalHelper(page)
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      await terminal.waitForPrompt({ timeout: 30_000 })

      // Storm A over raw WS from TWO connections (creates are serialized
      // per connection server-side, so cross-connection is what exercises
      // the gate in parallel): restore:true shell creates. 15 per
      // connection inside one 10s window exceeds the 10/10s limit — every
      // one succeeding proves the restore bypass e2e (30 real PTY spawns
      // drain through the gate, default N=4).
      const clients = await Promise.all(
        Array.from({ length: STORM_CLIENTS }, () => SyntheticClient.connect(infoA)),
      )
      const healthSamplesMs: number[] = []
      const storm = (async () => {
        for (const [c, client] of clients.entries()) {
          for (let i = 0; i < CREATES_PER_CLIENT; i++) {
            client.send({
              type: 'terminal.create', requestId: `storm-${c}-${i}`,
              mode: 'shell', shell: 'system', restore: true,
            })
          }
        }
        for (const [c, client] of clients.entries()) {
          for (let i = 0; i < CREATES_PER_CLIENT; i++) {
            const reply = await client.waitFor(
              (f) => (f.type === 'terminal.created' || f.type === 'error')
                && f.requestId === `storm-${c}-${i}`,
              60_000,
            )
            // Restore bypass, proven e2e: no RATE_LIMITED, every spawn lands.
            expect(reply.type, `restore create storm-${c}-${i} bypasses the limiter`)
              .toBe('terminal.created')
          }
        }
      })()
      // Meanwhile sample B's health latency.
      const sampler = (async () => {
        for (let i = 0; i < 10; i++) {
          const t0 = Date.now()
          const res = await fetch(`${infoB.baseUrl}/api/health`, {
            headers: { 'x-auth-token': infoB.token },
          })
          healthSamplesMs.push(Date.now() - t0)
          expect(res.ok).toBe(true)
          await new Promise((r) => setTimeout(r, 300))
        }
      })()
      await Promise.all([storm, sampler])

      // B stayed healthy and interactive during the storm.
      expect(Math.max(...healthSamplesMs)).toBeLessThan(2_000)
      const marker = `ISOLATION-${randomUUID()}`
      await terminal.executeCommand(`echo ${marker}`)
      await terminal.waitForOutput(marker, { timeout: 10_000 })

      for (const client of clients) client.close()
    } finally {
      await serverA.stop().catch(() => {})
      await serverB.stop().catch(() => {})
    }
  })
})
```

Implementer notes: `SyntheticClient.connect` in the source spec sends `protocolVersion: 7` and asserts `paneReconcileV1` in the ready frame — when copying, drop the `capabilities` field and the ready-capability assertion (this spec doesn't need reconcile). If `TerminalHelper`'s constructor/API differs (check `helpers/terminal-helpers.ts:61-123` — `waitForPrompt`/`waitForOutput`/`executeCommand`), adapt the calls, keeping the marker-echo assertion.

Config registration comment:

```ts
  // LANE E create protection: two concurrent RustServers, storm-isolation
  // proof. See docs/plans/2026-07-25-rust-create-protection.md
  /create-protection-isolation-rust\.spec\.ts$/,
```

- [ ] **Step 2: Run the spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/create-protection-isolation-rust.spec.ts`
Expected: PASS. 30 shell PTYs on A (2 connections x 15) drain through the gate (default N=4) in a few seconds — measured spawn latency here is sub-millisecond per permit-hold; both servers stop and reap their own trees in `finally`.

- [ ] **Step 3: Commit**

```bash
git add test/e2e-browser/specs/create-protection-isolation-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): storming one rust server leaves a concurrent server unaffected"
```

---

### Task 8: Full verification + push (STOP before PR)

**Files:** none (verification only; fix-forward commits if anything is red).

- [ ] **Step 1: Rust suites**

Run: `cargo test --workspace` (from the worktree root; timeout generous — real PTY spawns)
Expected: PASS, zero failures.
Run: `cargo clippy --workspace -- -D warnings && cargo fmt --check`
Expected: clean.

- [ ] **Step 2: Coordinated Node suite (waits for the shared gate; four sibling lanes run concurrently — WAIT if held, never kill a foreign holder)**

Run: `FRESHELL_TEST_SUMMARY="lane-e rust create protection: full suite before push" npm run check`
Expected: typecheck PASS + coordinated vitest suites PASS (this lane touched no Node server or client code, so this proves non-regression only).

- [ ] **Step 3: All three e2e specs together**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/create-protection-restore-storm-rust.spec.ts specs/create-rate-limit-ladder-rust.spec.ts specs/create-protection-isolation-rust.spec.ts`
Expected: 3 passed.

- [ ] **Step 4: Push the branch — and STOP**

```bash
git push -u origin feat/rust-create-protection
```

Do NOT run `gh pr create` — PR creation is not yet approved. Report: branch name, commit list, and the red→green proof for each task (failing-test output captured in Step 2 of each task vs final green runs).

---

## Self-Review (performed while writing this plan)

**1. Spec coverage:**
- G6 rate limit, exact legacy semantics (10/10s sliding window, per connection, strict prune, reject-consumes-nothing, `restore:true` bypass, env names, `RATE_LIMITED` code) → Tasks 1, 3.
- Wire shape pinned by a test that read the client handler's contract (`type`/`code`/`requestId` match + exact key set) → Task 3 integration test `eleventh_create_is_rate_limited_with_exact_wire_shape`.
- Limiter in its own small module → Task 1 (`create_limit.rs`). `freshell-server/src/rate_limit.rs` was read; not reusable (wrong crate direction, global token bucket) → parallel module in freshell-ws, as the spec anticipated.
- G12/F11 spawn gate: bounded semaphore (default N=4, env-configurable), FIFO-fair, queue-depth cap fails loud with an error frame, per-spawn timeout, RAII permit release on completion/failure/unwind, structured log + counters on queueing/rejection/timeout → Tasks 2, 4. The synchronous spawn runs under `spawn_blocking` while the permit is held (validated as required — inline blocking spawns would deadlock small hosts; Task 4). Restore creates exempt from the RATE limit but NOT the gate → pinned in Task 3 (bypass test) and Task 4 (restore storm through concurrency-1 gate).
- TDD red tests: limiter window math + restore bypass + wire shape + dedupe-before-limiter (adopted duplicate over an exhausted budget is never charged or rejected) (Tasks 1, 3); gate bounds concurrency with max-in-flight N and all-complete, FIFO order, queue-cap fail-loud, permit release on timeout and drop (Task 2); gate WIRING pinned non-vacuously by the zero-permit timeout test — it fails unless `handle_create` actually consults the gate, and its red run is captured before Task 4's implementation (Task 4).
- E2E: own RustServers/ephemeral ports (all three specs), 15-pane reload storm + `restartAbrupt()` + limiter fires (validated: post-restart shell creates are non-restore) + ladder recovers ALL panes (Task 5), live non-restore flood → RATE_LIMITED → ladder recovery (Task 6), two concurrent servers isolation + raw-WS restore-bypass proof (Task 7), new spec files + minimal config appends (Tasks 5-7). Tab-add floods seed `panes.defaultNewPane:'shell'` (validated: default 'ask' fires zero creates) and pin `RUST_LOG:'info'` for the log greps.
- Repo rules: TDD throughout, coordinated-suite etiquette + `FRESHELL_TEST_SUMMARY` (Task 8), push-then-STOP PR policy (Task 8), never touch the user's live server (constraint + spec `finally` blocks).
- No gaps found; no UNRESOLVED COVERAGE GAP entries needed.

**1b. No silent deferrals:** No stubs or mocks stand in for required behavior anywhere — integration tests use real sockets and real PTYs; e2e uses the real client bundle against the real Rust binary. `spawn_blocking` around `registry.create` was originally deferred but validation FALSIFIED the deferral's premise (inline blocking spawns wedge every worker on hosts with `nproc <= concurrency`, deadlocking the timer driver itself) — it is now production scope in Task 4, and the "one hung spawn can't block the queue" claim is satisfied for real (permit + blocking-pool thread; async workers stay free; waiters time out loud). The two consciously-accepted residuals (saturated-gate keepalive kill; ungated freshagent REST spawn path, rate-bounded by SAFE-02) are documented in Task 2/4 notes and Global Constraints respectively — recorded, not silent.

**2. Placeholder scan:** No TBD/TODO/"add appropriate handling" items. Two "copy from `<file>:<lines>`" references (hello helper, `SyntheticClient`) point at exact existing code the engineer opens and copies verbatim per the suite's stated per-spec-ownership convention — the copy-sources are pinned to file:line.

**3. Type consistency:** `CreateProtectConfig` field names (`rate_limit`, `rate_window_ms`, `spawn_concurrency`, `spawn_queue_cap`, `spawn_timeout_ms`) are identical across Tasks 1/2/3/4; `SpawnGate::{new, from_config, acquire, queued_total, queue_rejections, timeouts}` and `SpawnGateError::{QueueFull, Timeout}` match between Task 2's definition and Task 4's consumers; `try_acquire(&mut self, now_ms: u64) -> bool` matches between Task 1 and Task 3's handler code; `spawn_server_with_create_protect(cfg) -> String` matches between Task 3's harness addition and both integration test files' usage; error messages ("Too many terminal.create requests", "Timed out waiting for a terminal spawn slot") are byte-identical everywhere they appear.
