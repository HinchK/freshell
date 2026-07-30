# REST/Agent-API Spawn Gate (kata enn3) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Close the REST/agent-API spawn-gate bypass (kata `enn3`): the FIFO-fair
bounded-concurrency PTY spawn gate that already protects the WebSocket
`terminal.create` path (PR #532) must also bound the freshagent REST create
pipeline (`POST /api/tabs`, `POST /api/panes/{id}/split`, `POST /api/panes/{id}/respawn`
and the MCP `freshell` tool behind them) — with BOTH doors sharing ONE gate
instance (one global concurrency budget, never two parallel budgets), and the
WS path's behavior unchanged.

**Architecture:** Move the existing `SpawnGate` module verbatim from
`freshell-ws` to `freshell-freshagent` (the neutral home below both consumers —
`freshell-ws` already depends on `freshell-freshagent`, the crate already
carries `tokio` `sync`+`time`, and it has in-tree precedent for hosting a
server-wide coordination primitive: `session_lease::FreshAgentSessionLeases`).
`freshell-ws` keeps a re-export shim so every existing path and `WsState`
literal compiles unchanged. `main.rs` hoists the gate to ONE named `Arc` and
hands the same instance to `WsState` and to `FreshAgentState` via a
ledger-style post-construction setter (`Arc<OnceLock<…>>`, the exact house
pattern `set_identity_sink` used to cross this crate boundary in wave B).
`spawn_terminal_pane` — the single shared spawn seam for all three REST routes —
acquires an RAII permit before any side effect (including the REST-reachable
codex managed-launch sidecar plan), mirroring the WS acquire semantics.

**Tech Stack:** Rust (axum 0.8, tokio 1.x `sync`/`time`, tower `oneshot` test
harness), Playwright e2e (`RustServer` ephemeral-port fixture), cargo
clippy/fmt at pinned toolchain 1.96.0.

## Global Constraints

- Worktree: all work in `/home/dan/code/freshell/.worktrees/rest-spawn-gate`, branch `fix/rest-spawn-gate`, base `3f096412` (origin/main).
- NEVER touch ports 3001/3002 (the user's LIVE servers). NEVER restart the user's self-hosted Freshell server. All test servers on ephemeral ports (`127.0.0.1:0` / `findFreePort()`), constructed via `new RustServer({...})` — NEVER `createE2eServerHandle`.
- NEVER broad-kill processes (`pkill node`, `pkill -f vite`, …); verify a PID belongs to this worktree before stopping it.
- CI-required: `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` (pinned toolchain **1.96.0**; `--all-targets` lints test code too), plus `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings` and the same for `-p freshell-opencode`.
- Coordinated suites: check `npm run test:status` first; if another agent holds the gate, WAIT (never kill a foreign holder). Broad runs as `FRESHELL_TEST_SUMMARY="rest-spawn-gate: <reason>" env -u FRESHELL_BIND_HOST npm test`.
- Every commit carries the trailer:
  `🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)` + blank line + `Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>`
- PR policy: push the branch, STOP before `gh pr create` (not approved). Report branch + red→green proof + kata-closable summary.
- Scope fence (4-lane parallel wave): do NOT touch `crates/freshell-terminal/src/registry.rs` (Lane D1 territory + pinned "freshell-terminal stays tokio-free" constraint), client `src/` (D1/D4), persistence shapes (D4), flake-test files (D3). WS gate semantics unchanged — `crates/freshell-ws/src/terminal.rs` is not modified at all.
- Pinned config knobs (do not change values): spawn concurrency default **4** (`FRESHELL_SPAWN_GATE_CONCURRENCY`), queue cap **64** (`FRESHELL_SPAWN_GATE_QUEUE_CAP`), permit-wait timeout **10_000 ms** (`FRESHELL_SPAWN_GATE_TIMEOUT_MS`). `SpawnGate::new` passes 0 through (0-permit gate = deterministic timeout — tests rely on this).
- Structural limits: ≤1K lines per file for NEW files (`terminal_tabs.rs` is pre-existing at ~3.9K lines; do not restructure it in this lane, just keep additions minimal).

---

## Design decisions (pinned — implementers follow these, reviewers check against them)

**D-A. Gate home = `crates/freshell-freshagent/src/spawn_gate.rs` (verbatim move).**
The dependency direction is `freshell-server → freshell-ws → freshell-freshagent`;
`freshell-freshagent` can never import `freshell-ws` (AD-1 of the
rust-create-protection lane). No neutral `freshell-core` crate exists;
`freshell-terminal` is pinned tokio-free; `freshell-freshagent` already has
tokio `sync`+`time` and `tracing`. Moving ~300 lines beats a new crate
(YAGNI) and beats an `Arc<dyn Trait>` bridge (the gate's API returns a tokio
RAII `OwnedSemaphorePermit`, which is awkward behind a trait object). The
tracing target literal `"freshell_ws::spawn_gate"` is kept byte-identical
after the move so existing log consumers (e2e greps of `rust-server.jsonl`)
keep working; a comment explains the pin.

**D-B. One instance, injected at wiring time.** `main.rs` builds ONE
`Arc<SpawnGate>` from the single `CreateProtectConfig::from_env()` snapshot
and hands the SAME Arc to `WsState.spawn_gate` and to
`FreshAgentState::set_spawn_gate(gate, timeout)`. A post-construction
`Arc<OnceLock<…>>` setter (not a builder) because `create_protect` resolves at
`main.rs:479`, after the last `fresh_agent_state` builder rebinding at
`:409-413` — the exact reason `set_identity_sink` is a setter. `None`
(unwired) = ungated, which keeps every existing `FreshAgentState` unit-test
construction compiling and behaving as before; production always wires it
(proven by the e2e log assertion in Task 8).

**D-C. Acquire scope on REST = whole spawn pipeline, before side effects.**
The permit is acquired in `spawn_terminal_pane` immediately after the D7/D8
`RestSessionRefLease` block closes (~`terminal_tabs.rs:793`), BEFORE
`let terminal_id = …` (~`:795`) — i.e. on the shared path of EVERY mode.
VALIDATED (load-bearing check A1): the codex plan block at `:892` sits
INSIDE the non-shell `else` branch (`if mode == "shell"` at `:807`, `else`
at `:828`) and is preceded by real side effects — `generate_mcp_injection`
at `:839-848` (tmp MCP config writes; opencode bumps the sidecar refcount,
`mcp_inject.rs:509-525`) and the opencode loopback port allocation at
`:852-860` — so an acquire anchored at `:892` would leave shell creates
ungated AND leak MCP config on rejection. The `:793/:795` anchor precedes
all of these. Consequences: (1) gate rejection needs NO cleanup — nothing
has been materialized yet (the `RestSessionRefLease` releases via its own
`Drop`); (2) the REST-reachable codex sidecar launch
(`freshell-codex/src/launch_lifecycle.rs:621`, reached via
`plan_create_with_retry` at `terminal_tabs.rs:892-911` when `mode=="codex"`
and `FRESHELL_CODEX_MANAGED_LAUNCH=1`) is bounded by the same permit — a
REST codex burst can no longer spawn one sidecar+proxy per request at
unbounded concurrency. The permit binding `_spawn_permit` lives to the end
of `spawn_terminal_pane` (RAII drop on every early-return `Err` path and on
completion), mirroring WS.

**D-C latency exposure (validated A2, decision recorded).** With
`FRESHELL_CODEX_MANAGED_LAUNCH=1`, a permit held across
`plan_create_with_retry` can last far longer than the 10s permit-wait:
worst case 5 attempts × `SIDECAR_START_BUDGET` 45s (`launch_lifecycle.rs:64`)
+ 1s linear backoff ≈ 226s; even ONE slow attempt (45s) is 4.5× the wait, so
4 concurrent flag-ON REST codex creates could starve WS creates into
non-retried `PTY_SPAWN_FAILED` timeouts. Alternatives considered:
(a) WS-mirror (plan the launch BEFORE the acquire + rejection-discard
cleanup) — removes the starvation risk but re-opens the unbounded
per-request sidecar storm the kata's "Also noted" aside flags, and imports
the WS cleanup burden; (b) drop-and-reacquire around the plan — double-wait
complexity, breaks FIFO fairness. DECISION: keep the plan under the permit.
`FRESHELL_CODEX_MANAGED_LAUNCH` defaults OFF (requires exactly `"1"`), so
the shipped default has zero exposure; the flag-ON exposure is accepted and
documented here, and MUST be revisited if/when S5 flips the default ON
(likely a separate sidecar budget covering both doors). Task 9's report
carries this forward.

> Tripwire (added 2026-07-29, kata bccd item 5): grep `D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH)` — marker comments sit at the REST call site (`terminal_tabs.rs`) and on the flag const (`launch_plan.rs`) so the default flip cannot ship without hitting this decision.

> **§D-C ADDENDUM — D-C-REVISIT(FRESHELL_CODEX_MANAGED_LAUNCH) RESOLVED (2026-07-30, DEV-0006 S5.e).**
> The flag default flipped ON with two mitigations, replacing the accepted flag-ON exposure:
> (1) a **sidecar planning budget** inside `CodexTerminalLaunchManager::plan_create_with_retry`
> (2 concurrent plans server-wide, 30 s bounded wait, fail-fast) covering both doors;
> (2) the **REST door's acquire moved below the codex plan** (into `settle_gated_create`,
> immediately before the PTY fork), mirroring the WS auto-resume door's plan→acquire→discard
> ordering — a REST codex create no longer holds a spawn permit during planning. Trade-off
> knowingly taken: gate rejection now requires cleanup (codex plan discard + MCP config +
> amplifier-stub GC — the same statements as the PTY-spawn-failure arm), reversing this
> section's "rejection needs NO cleanup" property for the post-plan acquire point.
> RESIDUAL (accepted): WS restore-creates still plan under the caller-held permit
> (`create_gate.rs`); the budget bounds that to ≤2 long holds server-wide. Revisit if a
> restore-fleet incident implicates it. The in-code D-C-REVISIT markers now point here.

**D-D. Codex sidecar evaluation.** (The kata has NO numbered items — its
sidecar mention is the un-numbered aside *"Also noted: the codex-sidecar
launch path bypasses the gate similarly"*, and it is NOT in the kata's
acceptance line. Verified against the kata's full text, retrieved verbatim
from `~/.kata/kata.db`; Task 9's closure summary must quote that actual
sentence so the closer adjudicates against real text.) Two distinct sidecar spawn
sites exist. (a) The REST-reachable managed-launch path — GATED by D-C.
(b) `FreshCodexState::spawn_sidecar` (`codex.rs:1959/2001`) — NOT gated, and
documented why not: it is WS-only (REST `create_tab` rejects every
`agent != "opencode"` with 400 at `lib.rs:1350`), is not a PTY and does not go
through `TerminalRegistry`, is ~one-per-fresh-agent-session, and already
carries its own anti-storm defenses (in-flight guard `codex.rs:117`,
non-resumable negative cache `codex.rs:124-127`, resend guard `codex.rs:145`).
Gating it would also change WS-side semantics, which this lane's fence forbids.
Note: on the WS path the sidecar plan happens BEFORE the WS gate acquire
(`terminal.rs:1473` vs `:1700`) — pre-existing WS behavior, explicitly NOT
changed here (WS-unchanged mandate).

**D-E. REST error shape.** `QueueFull` → **429** with body
`{"status":"error","code":"SPAWN_QUEUE_FULL","message":"Too many concurrent terminal spawns; retry shortly"}`;
`Timeout` → **503** with body
`{"status":"error","code":"SPAWN_TIMEOUT","message":"Timed out waiting for a terminal spawn slot"}`
(via the existing `fail_json_code` envelope — every freshagent error already
uses `{status:"error",message,[code]}`). Caller-tolerance evaluation, pinned:
the SPA does not use these routes (it creates terminals over WS), so blast
radius is the MCP `freshell` tool and the CLI. The MCP bridge
(`server/mcp/http-client.ts:73-83` → `freshell-tool.ts:611-620`) drops the
HTTP status and surfaces only the message text (and prefers a body `error` key
over `message`, which is why we use `code`+`message`, not `error`). Therefore
the retry guidance lives IN the message text. `server/mcp/` is outside this
lane's fence and is not modified.

**D-F. REST PTY spawn moves onto the blocking pool.** The WS lane pinned
(ledger A4) that a gated, synchronous `registry.create` MUST run under
`tokio::task::spawn_blocking`: on a host with `nproc <= spawn_concurrency`,
N inline blocking spawns would wedge every async worker including the timer
driver, so gate timeouts could never fire. Adding the gate to REST without
this wrap would import exactly that wedge mode, so the wrap is in-scope
(Task 4). It lives entirely in `terminal_tabs.rs` — `registry.rs` untouched.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-freshagent/src/spawn_gate.rs` | Create (moved) | The gate: `SpawnGate`, `SpawnGateError`, `WaitingGuard`, counters, inline unit tests — verbatim from `freshell-ws`, minus `from_config` |
| `crates/freshell-freshagent/src/lib.rs` | Modify | `pub mod spawn_gate;` + re-exports; `RestSpawnGate` handle; `spawn_gate` field + `set_spawn_gate` setter + `spawn_gate()` reader on `FreshAgentState`; seam unit tests |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify | Permit acquire in `spawn_terminal_pane`; `spawn_gate_error_response` mapping; `spawn_blocking` wrap of `registry.create`; new tests in the existing `#[cfg(test)]` mod |
| `crates/freshell-ws/src/spawn_gate.rs` | Replace | Re-export shim (`pub use freshell_freshagent::spawn_gate::…`) |
| `crates/freshell-ws/tests/common/mod.rs` | Modify | Replace `SpawnGate::from_config(&cfg)` with `SpawnGate::new(cfg.spawn_concurrency, cfg.spawn_queue_cap)` |
| `crates/freshell-ws/tests/rest_ws_shared_gate.rs` | Create | Integration test: WS + REST share ONE budget |
| `crates/freshell-server/src/main.rs` | Modify | Hoist gate to a named `Arc`; `set_spawn_gate`; `WsState` gets a clone of the same Arc |
| `test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts` | Create | E2E: 16-burst REST creates on own `RustServer`, bounded concurrency observed via logs, WS client stays responsive |
| `test/e2e-browser/playwright.config.ts` | Modify | Register the new spec in `RUST_ONLY_SPECS` AND the `rust-chromium` `testMatch` |

Not touched: `crates/freshell-ws/src/terminal.rs`, `crates/freshell-ws/src/lib.rs`,
`crates/freshell-ws/src/create_limit.rs`, `crates/freshell-terminal/**`,
`server/mcp/**`, client `src/**`.

---

### Task 1: Move `SpawnGate` to `freshell-freshagent` (behavior-preserving refactor)

**Files:**
- Create: `crates/freshell-freshagent/src/spawn_gate.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (module registration + re-export)
- Modify: `crates/freshell-ws/src/spawn_gate.rs` (becomes a re-export shim)
- Modify: `crates/freshell-server/src/main.rs:571-574` (drop `from_config`)
- Modify: `crates/freshell-ws/tests/common/mod.rs` (drop `from_config`)

**Interfaces:**
- Consumes: existing `SpawnGate` API in `crates/freshell-ws/src/spawn_gate.rs` (`new(concurrency: usize, queue_cap: usize) -> Self`, `async fn acquire(&self, timeout: Duration) -> Result<tokio::sync::OwnedSemaphorePermit, SpawnGateError>`, counters `queued_total()/queue_rejections()/timeouts() -> u64`).
- Produces: `freshell_freshagent::spawn_gate::{SpawnGate, SpawnGateError}` — identical API, importable by BOTH `freshell-ws` (via re-export) and `freshell-freshagent` internals. Later tasks use exactly these names.

- [ ] **Step 1: Baseline — confirm the Rust suites and lints are green on base**

Run (inside the worktree; allow ~5–10 min for the first cold build):
```bash
cd /home/dan/code/freshell/.worktrees/rest-spawn-gate
cargo test -p freshell-ws -p freshell-freshagent 2>&1 | tail -20
cargo clippy -p freshell-ws -p freshell-freshagent --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: `test result: ok` for every test binary; clippy exits 0. If NOT green, STOP and report — do not build on a red base.

- [ ] **Step 2: Move the module**

Copy `crates/freshell-ws/src/spawn_gate.rs` (all ~301 lines, including the
inline `#[cfg(test)] mod tests`) to
`crates/freshell-freshagent/src/spawn_gate.rs`, then apply exactly these edits
to the NEW file:

1. **Delete the `from_config` constructor** (it references
   `crate::create_limit::CreateProtectConfig`, a `freshell-ws` type):
   ```rust
   // DELETE this fn (at ~:70-75 of the copied file):
   pub fn from_config(cfg: &crate::create_limit::CreateProtectConfig) -> Self {
       Self::new(cfg.spawn_concurrency, cfg.spawn_queue_cap)
   }
   ```
2. **Extend the module doc** (keep the existing doc lines, append):
   ```rust
   //!
   //! HOME NOTE: this module moved from `freshell-ws` so the freshagent REST
   //! create pipeline can share the ONE server-wide gate (freshell-freshagent
   //! cannot import freshell-ws — dependency direction). freshell-ws re-exports
   //! it; `freshell-server/src/main.rs` mints the single production instance.
   //! The tracing target below stays pinned to the original literal
   //! `freshell_ws::spawn_gate` so existing log consumers (e2e greps of
   //! rust-server.jsonl) keep working across the move.
   ```
3. **Do NOT change anything else** — the `tracing::warn!/info!(target: "freshell_ws::spawn_gate", …)`
   literals, `WaitingGuard`, the counters, and all six unit tests move byte-identically.
   (`SpawnGate::new` keeps its pass-0-through semantics — the WS zero-permit
   integration test depends on it.)

Register the module in `crates/freshell-freshagent/src/lib.rs`, next to the
existing `pub mod identity_sink;` block:
```rust
pub mod spawn_gate;
pub use spawn_gate::{SpawnGate, SpawnGateError};
```

- [ ] **Step 3: Replace the freshell-ws module with a re-export shim**

Replace the ENTIRE contents of `crates/freshell-ws/src/spawn_gate.rs` with:
```rust
//! Moved to `freshell-freshagent` (see docs/plans/2026-07-27-rest-spawn-gate.md):
//! the REST create pipeline must share the ONE server-wide gate and
//! `freshell-freshagent` cannot import this crate (dependency direction —
//! AD-1 of the rust-create-protection lane). This re-export keeps every
//! existing `crate::spawn_gate::*` path and `WsState { spawn_gate: … }`
//! literal compiling unchanged.
pub use freshell_freshagent::spawn_gate::{SpawnGate, SpawnGateError};
```
Leave `crates/freshell-ws/src/lib.rs:39` (`pub mod spawn_gate;`) as is.

- [ ] **Step 4: Fix the two `from_config` call sites**

Find them all first:
```bash
grep -rn "from_config" crates/ --include="*.rs" | grep -i spawn
```
Expected sites (fix each the same way; if grep finds more, fix them identically):

`crates/freshell-server/src/main.rs:571-574` — change
```rust
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::from_config(
            &create_protect,
        )),
```
to
```rust
        spawn_gate: std::sync::Arc::new(freshell_ws::spawn_gate::SpawnGate::new(
            create_protect.spawn_concurrency,
            create_protect.spawn_queue_cap,
        )),
```
(Task 7 will hoist this to a named binding; here we only keep it compiling.)

`crates/freshell-ws/tests/common/mod.rs` (inside `spawn_server_with_create_protect`) — change
```rust
        spawn_gate: Arc::new(SpawnGate::from_config(&cfg)),
```
to
```rust
        // NOTE: SpawnGate::new passes 0 through (no sanitizing) — the
        // zero-permit test in create_protection.rs depends on this.
        spawn_gate: Arc::new(SpawnGate::new(cfg.spawn_concurrency, cfg.spawn_queue_cap)),
```
(Match the file's actual local import style; adjust the path if the helper
uses a fully-qualified name.)

- [ ] **Step 5: Verify the move is behavior-preserving**

```bash
cargo test -p freshell-freshagent spawn_gate 2>&1 | tail -5
cargo test -p freshell-ws 2>&1 | tail -5
cargo clippy -p freshell-ws -p freshell-freshagent -p freshell-server --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --all --check
```
Expected: the six moved gate unit tests
(`bounds_concurrency_to_n_and_all_complete`, `drains_fifo_in_arrival_order`,
`queue_cap_fails_loud`, `timeout_fails_loud_and_leaks_no_permit`,
`cancelled_queued_wait_reclaims_queue_slot`, `raii_drop_releases_permit`) now
PASS in `freshell-freshagent`; the full `freshell-ws` suite — including
`tests/create_protection.rs` (the WS-unchanged regression pin) — PASSES; clippy
and fmt clean.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/spawn_gate.rs crates/freshell-freshagent/src/lib.rs \
        crates/freshell-ws/src/spawn_gate.rs crates/freshell-ws/tests/common/mod.rs \
        crates/freshell-server/src/main.rs
git commit -m "refactor: move SpawnGate to freshell-freshagent (neutral home below both create doors)

Behavior-preserving: freshell-ws re-exports the moved module; tracing
targets and gate semantics byte-identical; from_config inlined at its
two call sites. Groundwork for gating the REST create pipeline (kata enn3).

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 2: The spawn-gate seam on `FreshAgentState`

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (field + handle struct + setter + reader + tests)

**Interfaces:**
- Consumes: `spawn_gate::SpawnGate` from Task 1.
- Produces (used by Tasks 3–7):
  - `pub(crate) struct RestSpawnGate { pub(crate) gate: Arc<spawn_gate::SpawnGate>, pub(crate) timeout: std::time::Duration }` (Clone)
  - `impl FreshAgentState { pub fn set_spawn_gate(&self, gate: Arc<spawn_gate::SpawnGate>, timeout: std::time::Duration); pub(crate) fn spawn_gate(&self) -> Option<RestSpawnGate>; }`

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)]` mod in `crates/freshell-freshagent/src/lib.rs`
(create a small nested `mod spawn_gate_seam_tests` if the file's test mod is
organized that way; follow the file's local convention):

```rust
#[cfg(test)]
mod spawn_gate_seam_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Duration;

    fn bare_state() -> FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
    }

    #[test]
    fn unwired_state_has_no_spawn_gate() {
        assert!(bare_state().spawn_gate().is_none());
    }

    #[test]
    fn set_spawn_gate_is_visible_to_every_clone_and_set_once() {
        let state = bare_state();
        let clone_taken_before_set = state.clone();
        let gate = Arc::new(crate::spawn_gate::SpawnGate::new(4, 64));
        state.set_spawn_gate(Arc::clone(&gate), Duration::from_millis(1234));

        // Clones share the Arc<OnceLock>, so even a clone taken BEFORE the
        // set observes the wiring (the ledger-injection property).
        let wired = clone_taken_before_set.spawn_gate().expect("wired");
        assert!(Arc::ptr_eq(&wired.gate, &gate), "same gate instance");
        assert_eq!(wired.timeout, Duration::from_millis(1234));

        // Second set is ignored (OnceLock).
        let other = Arc::new(crate::spawn_gate::SpawnGate::new(1, 1));
        state.set_spawn_gate(other, Duration::from_millis(1));
        let still = state.spawn_gate().expect("still wired");
        assert!(Arc::ptr_eq(&still.gate, &gate), "first wiring wins");
    }
}
```

- [ ] **Step 2: Run to verify failure**

```bash
cargo test -p freshell-freshagent spawn_gate_seam 2>&1 | tail -10
```
Expected: FAIL to compile — `no method named 'spawn_gate' found` /
`no method named 'set_spawn_gate'` / `cannot find struct RestSpawnGate`.
(A compile error naming the missing seam is this step's red.)

- [ ] **Step 3: Implement the seam**

In `crates/freshell-freshagent/src/lib.rs`:

1. Near the `identity_sink` field declaration on `FreshAgentState` (~`lib.rs:204`), add:
```rust
    /// Server-wide PTY spawn gate — the SAME instance the WS terminal.create
    /// path uses (ONE global concurrency budget; see
    /// docs/plans/2026-07-27-rest-spawn-gate.md). Clone-shared + set-once,
    /// wired post-construction by freshell-server (same shape as
    /// `identity_sink`). `None` = ungated (unwired unit tests keep legacy
    /// behavior; production always wires it).
    spawn_gate: Arc<std::sync::OnceLock<RestSpawnGate>>,
```
2. Next to the struct (top level, near `TerminalLivenessProbe` at ~`lib.rs:63`), add:
```rust
/// Handle pairing the shared gate with the permit-wait timeout
/// (`CreateProtectConfig.spawn_timeout_ms`, resolved once in main.rs so both
/// doors share one env snapshot).
#[derive(Clone)]
pub(crate) struct RestSpawnGate {
    pub(crate) gate: Arc<spawn_gate::SpawnGate>,
    pub(crate) timeout: std::time::Duration,
}
```
3. In `FreshAgentState::new(…)` (~`lib.rs:247`), initialize the field in the
   struct literal alongside `identity_sink`:
```rust
            spawn_gate: Arc::new(std::sync::OnceLock::new()),
```
4. Next to `set_identity_sink` (~`lib.rs:276`), add:
```rust
    /// Wire the server-wide spawn gate (set-once; later calls are no-ops).
    /// `timeout` bounds PERMIT ACQUISITION only, not spawn duration —
    /// identical semantics to the WS door.
    pub fn set_spawn_gate(
        &self,
        gate: Arc<spawn_gate::SpawnGate>,
        timeout: std::time::Duration,
    ) {
        let _ = self.spawn_gate.set(RestSpawnGate { gate, timeout });
    }

    /// The wired spawn gate, if any. `None` = ungated (unwired test states).
    pub(crate) fn spawn_gate(&self) -> Option<RestSpawnGate> {
        self.spawn_gate.get().cloned()
    }
```

- [ ] **Step 4: Run to verify pass**

```bash
cargo test -p freshell-freshagent spawn_gate_seam 2>&1 | tail -5
cargo test -p freshell-freshagent 2>&1 | tail -5
cargo test -p freshell-ws 2>&1 | tail -5
```
Expected: both new tests PASS; both crate suites fully green (the `None`
default keeps every existing construction site — including `freshell-ws`'s six
in-crate `FreshAgentState` constructions — compiling and behaving unchanged).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/lib.rs
git commit -m "feat: spawn-gate seam on FreshAgentState (set-once handle, ledger-style)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 3: Gate the REST spawn path (red-first)

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (acquire + error mapping + tests)
- Test: same file, existing `#[cfg(test)]` mod (this crate has no `tests/` dir — all coverage is inline by convention)

**Interfaces:**
- Consumes: `FreshAgentState::set_spawn_gate` / `spawn_gate()` and `RestSpawnGate` (Task 2); `crate::fail_json_code(status: StatusCode, code: &str, message: String) -> Response` (`lib.rs:1283`, already `pub(crate)`); `spawn_gate::SpawnGateError`.
- Produces: `fn spawn_gate_error_response(err: crate::spawn_gate::SpawnGateError) -> Response` in `terminal_tabs.rs`; the permit acquire inside `spawn_terminal_pane` covering all three routes (`/api/tabs`, `/api/panes/{id}/split`, `/api/panes/{id}/respawn`). Wire shapes pinned: 429 `SPAWN_QUEUE_FULL`, 503 `SPAWN_TIMEOUT` (exact bodies in D-E).

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)]` mod in `terminal_tabs.rs`. Reuse the file's
existing test helpers if equivalents exist (it has a large test mod from
Slice 3a — look for a `post`/router helper before writing new ones); otherwise
add these, modeled verbatim on `pane_ops.rs:935-1020`:

```rust
    // --- REST spawn-gate tests (kata enn3) -------------------------------

    fn gate_test_state() -> crate::FreshAgentState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        crate::FreshAgentState::new(
            std::sync::Arc::new("tok".to_string()),
            std::sync::Arc::new(tx),
        )
        .with_terminal_registry(freshell_terminal::TerminalRegistry::new())
    }

    async fn gate_post(
        router: axum::Router,
        uri: &str,
        body: serde_json::Value,
    ) -> (axum::http::StatusCode, serde_json::Value) {
        use tower::util::ServiceExt;
        let req = axum::http::Request::builder()
            .method("POST")
            .uri(uri)
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(axum::body::Body::from(body.to_string()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        (status, serde_json::from_slice(&bytes).unwrap())
    }

    fn shell_create_body() -> serde_json::Value {
        serde_json::json!({
            "mode": "shell",
            "cwd": std::env::temp_dir().to_string_lossy(),
        })
    }

    #[tokio::test]
    async fn zero_permit_gate_times_out_rest_create_with_503() {
        // 0 permits => acquire can never succeed => deterministic Timeout.
        // The cheapest "gate is actually on the REST path" pin (same trick
        // as crates/freshell-ws/tests/create_protection.rs).
        let state = gate_test_state();
        state.set_spawn_gate(
            std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(0, 64)),
            std::time::Duration::from_millis(100),
        );
        let (status, body) =
            gate_post(crate::router(state), "/api/tabs", shell_create_body()).await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["status"], serde_json::json!("error"));
        assert_eq!(body["code"], serde_json::json!("SPAWN_TIMEOUT"));
        assert_eq!(
            body["message"],
            serde_json::json!("Timed out waiting for a terminal spawn slot")
        );
    }

    #[tokio::test]
    async fn queue_cap_exceeded_rest_create_is_429_spawn_queue_full() {
        // 0 permits AND 0 queue slots => the very first waiter is rejected
        // loudly with QueueFull (no wait at all).
        let state = gate_test_state();
        state.set_spawn_gate(
            std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(0, 0)),
            std::time::Duration::from_secs(5),
        );
        let (status, body) =
            gate_post(crate::router(state), "/api/tabs", shell_create_body()).await;
        assert_eq!(status, axum::http::StatusCode::TOO_MANY_REQUESTS, "{body}");
        assert_eq!(body["status"], serde_json::json!("error"));
        assert_eq!(body["code"], serde_json::json!("SPAWN_QUEUE_FULL"));
        assert_eq!(
            body["message"],
            serde_json::json!("Too many concurrent terminal spawns; retry shortly")
        );
    }

    #[tokio::test]
    async fn split_and_respawn_also_flow_through_the_gate() {
        // Create a real pane while UNGATED (OnceLock unset), then wire a
        // 0-permit gate and prove split AND respawn hit it too — the gate
        // lives in spawn_terminal_pane, the one shared seam.
        let state = gate_test_state();
        let router = crate::router(state.clone());
        let (status, body) =
            gate_post(router.clone(), "/api/tabs", shell_create_body()).await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        let pane_id = body["data"]["paneId"].as_str().expect("paneId").to_string();

        state.set_spawn_gate(
            std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(0, 64)),
            std::time::Duration::from_millis(100),
        );

        let (status, body) = gate_post(
            router.clone(),
            &format!("/api/panes/{pane_id}/split"),
            shell_create_body(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE, "split: {body}");
        assert_eq!(body["code"], serde_json::json!("SPAWN_TIMEOUT"));

        let (status, body) = gate_post(
            router,
            &format!("/api/panes/{pane_id}/respawn"),
            shell_create_body(),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE, "respawn: {body}");
        assert_eq!(body["code"], serde_json::json!("SPAWN_TIMEOUT"));
    }
```

Note: `tower` (with `util`) is already a dev-dependency of this crate; the
`split` body shape may need adjustment if the handler requires extra fields —
mirror whatever the file's existing split tests send. If the respawn route
requires a live pane in a specific state, mirror the existing respawn tests'
setup. The assertion that matters is the 503 `SPAWN_TIMEOUT` shape.

- [ ] **Step 2: Run to verify the tests fail for the RIGHT reason**

```bash
cargo test -p freshell-freshagent zero_permit_gate 2>&1 | tail -15
cargo test -p freshell-freshagent queue_cap_exceeded 2>&1 | tail -15
cargo test -p freshell-freshagent split_and_respawn_also 2>&1 | tail -15
```
Expected: all three FAIL with assertion errors like
`assertion 'left == right' failed … left: 200 OK, right: 503` — proving
today's REST path spawns straight past a wired gate. (This is the kata's red.)

- [ ] **Step 3: Implement the acquire + mapping**

In `crates/freshell-freshagent/src/terminal_tabs.rs`:

1. Add the mapping fn near the other response helpers (e.g. next to
   `codex_launch_error_response` at ~`:544`):
```rust
/// REST mapping of a spawn-gate rejection (WS analogue:
/// `spawn_gate_error_parts` in freshell-ws/src/terminal.rs).
/// QueueFull -> 429: the caller should back off and retry.
/// Timeout   -> 503: spawn capacity unavailable right now.
/// The retry guidance lives in the MESSAGE because the MCP bridge
/// (server/mcp/freshell-tool.ts) surfaces only the message text, not the
/// HTTP status. Body key is `code`+`message` (never `error`) so the MCP
/// http-client's `data.error || data.message` precedence keeps showing the
/// human message.
fn spawn_gate_error_response(err: crate::spawn_gate::SpawnGateError) -> Response {
    match err {
        crate::spawn_gate::SpawnGateError::QueueFull => crate::fail_json_code(
            StatusCode::TOO_MANY_REQUESTS,
            "SPAWN_QUEUE_FULL",
            "Too many concurrent terminal spawns; retry shortly".to_string(),
        ),
        crate::spawn_gate::SpawnGateError::Timeout => crate::fail_json_code(
            StatusCode::SERVICE_UNAVAILABLE,
            "SPAWN_TIMEOUT",
            "Timed out waiting for a terminal spawn slot".to_string(),
        ),
    }
}
```
2. In `spawn_terminal_pane` (declared at `:641`), insert the acquire
   IMMEDIATELY AFTER the D7/D8 `RestSessionRefLease` block closes
   (~`:793`) and BEFORE `let terminal_id = …` (~`:795`) — i.e. after the
   mode/cwd validation, resume-identity checks, and the lease acquisition,
   on the shared path of EVERY mode, and before ANY side effect is
   materialized. Do NOT anchor at the codex plan block (`:892`): it sits
   inside the non-shell `else` branch (shell creates would bypass the
   gate), and `generate_mcp_injection` (`:839`, tmp MCP config writes +
   opencode sidecar refcount) and the opencode port allocation
   (`:852-860`) precede it (rejection would leak MCP config). Validated:
   load-bearing check A1, see D-C.
```rust
    // Server-wide spawn gate — the SAME instance the WS terminal.create path
    // uses (ONE global concurrency budget; wired by freshell-server main.rs;
    // docs/plans/2026-07-27-rest-spawn-gate.md). Placed on the shared path of
    // EVERY mode, before terminal_id minting — i.e. before MCP config
    // generation, opencode port allocation, and the codex managed-launch
    // plan — so the permit also bounds the REST-reachable sidecar spawn and
    // rejection needs NO cleanup (the session-ref lease above releases via
    // its own Drop). RAII:
    // `_spawn_permit` drops on every early-return Err(...) below, on spawn
    // failure, and at fn end — never call `.forget()`. `None` (unwired) =
    // ungated: unit-test states without server wiring keep legacy behavior.
    let _spawn_permit = match state.spawn_gate() {
        Some(rest_gate) => match rest_gate.gate.acquire(rest_gate.timeout).await {
            Ok(permit) => Some(permit),
            Err(err) => return Err(spawn_gate_error_response(err)),
        },
        None => None,
    };
```
   IMPORTANT: bind to `_spawn_permit` (underscore-PREFIXED name), never
   `let _ = …` — the latter drops the permit immediately. Verify while placing
   it that nothing BEFORE the acquire point (i.e. between the lease block and
   your insertion) materializes an external side effect — the invariant is
   "rejection needs no cleanup". (Everything after the acquire, including MCP
   config generation at `:839` and port allocation at `:852-860`, is
   intentionally under the permit.)

- [ ] **Step 4: Run to verify pass + no regressions**

```bash
cargo test -p freshell-freshagent 2>&1 | tail -5
cargo test -p freshell-ws 2>&1 | tail -5
cargo clippy -p freshell-freshagent --all-targets -- -D warnings 2>&1 | tail -3
```
Expected: the three new tests PASS; every pre-existing test in both crates
still PASSES (unwired states are ungated, so all existing REST-route tests are
untouched); clippy clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "feat: REST create pipeline acquires the shared spawn-gate permit (kata enn3)

QueueFull -> 429 SPAWN_QUEUE_FULL, Timeout -> 503 SPAWN_TIMEOUT; RAII
permit held across the whole spawn (incl. the REST-reachable codex
managed-launch plan). Red-first: 0-permit tests proved today's path
ungated (200) before the acquire landed.

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 4: Run the gated REST PTY spawn on the blocking pool

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:1034` region

**Interfaces:**
- Consumes: the `registry.create(…)` call at `terminal_tabs.rs:1034` and its surrounding error handling (`wrap_terminal_spawn_error` → 400 at `:1073`).
- Produces: identical externally-visible behavior; the spawn merely executes under `tokio::task::spawn_blocking` (pinned decision D-F / WS-lane ledger A4). Template: `crates/freshell-ws/src/terminal.rs:1730-1758`.

- [ ] **Step 1: Wrap the spawn**

Change the synchronous call at `terminal_tabs.rs:1034` from the shape
```rust
    if let Err(err) = registry.create(
        &spec,
        &child_env,
        terminal_id.clone(),
        stream_id,
        &mode,
        resume_session_id.as_deref(),
        Some(create_request_id.as_str()),
        None,
        on_exit,
    ) {
        // … existing rollback + 400 error path …
    }
```
to run on the blocking pool (mirroring `terminal.rs:1730-1758`):
```rust
    // The PTY spawn is synchronous; run it on the blocking pool so hung/slow
    // spawns occupy a permit + a blocking thread, never an async worker (WS
    // lane ledger A4: on hosts with nproc <= spawn_concurrency, N inline
    // blocking spawns would wedge the runtime incl. the timer driver, and
    // gate timeouts could never fire). Permit stays held throughout.
    let spawn_registry = registry.clone();
    let spawn_spec = spec.clone();
    let spawn_env = child_env.clone();
    let spawn_terminal_id = terminal_id.clone();
    let spawn_stream_id = stream_id.clone();
    let spawn_mode = mode.clone();
    let spawn_resume = resume_session_id.clone();
    let spawn_request_id = create_request_id.clone();
    let create_result = match tokio::task::spawn_blocking(move || {
        spawn_registry.create(
            &spawn_spec,
            &spawn_env,
            spawn_terminal_id,
            spawn_stream_id,
            &spawn_mode,
            spawn_resume.as_deref(),
            Some(spawn_request_id.as_str()),
            None,
            on_exit,
        )
    })
    .await
    {
        Ok(result) => result,
        // JoinError (incl. panic inside the closure) surfaces as a spawn
        // failure, same as the WS path.
        Err(join_err) => Err(std::io::Error::other(join_err)),
    };
    if let Err(err) = create_result {
        // … existing rollback + 400 error path, unchanged …
    }
```
Adaptation notes for the implementer (you can see the real code; the plan
pins the SHAPE): clone only what the closure needs and what is still used
afterwards — if a value (e.g. `on_exit`) is consumed by the call and unused
later, move it without cloning; if `SpawnSpec` or the env map is not `Clone`,
restructure so they are constructed as owned values moved into the closure
(they are locals built inside this fn). Do NOT touch
`crates/freshell-terminal/src/registry.rs`.

- [ ] **Step 2: Verify with the existing suites (refactor — covered by existing tests)**

```bash
cargo test -p freshell-freshagent 2>&1 | tail -5
cargo clippy -p freshell-freshagent --all-targets -- -D warnings 2>&1 | tail -3
cargo fmt --all --check
```
Expected: all PASS (every existing create/split/respawn test exercises this
call path); clippy + fmt clean. No new test — this is an execution-context
refactor whose observable contract is pinned by the existing route tests plus
Task 5's burst test.

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "refactor: run gated REST PTY spawn under spawn_blocking (A4 parity with WS)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 5: Burst, held-permit, and permit-release tests at the freshagent seam

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (tests only, same test mod as Task 3)

**Interfaces:**
- Consumes: `gate_test_state()`, `gate_post()`, `shell_create_body()` from Task 3; `SpawnGate::{new, acquire, queued_total, queue_rejections, timeouts}`.
- Produces: no new production code. Pins: (1) a 15+ burst drains FIFO through a bounded gate with every request succeeding; (2) a held permit blocks REST until released (end-to-end permit accounting); (3) a failed spawn releases its permit.

- [ ] **Step 1: Write the burst test (kata acceptance: "15+ REST burst bounded")**

```rust
    #[tokio::test(flavor = "multi_thread")]
    async fn fifteen_plus_rest_create_burst_is_bounded_and_all_complete() {
        // Concurrency-1 gate: at most ONE request may hold the spawn permit
        // at a time, so a 16-burst must serialize through the gate — the
        // queued_total counter proves the burst actually queued (bounded
        // in-flight) instead of spawning in parallel, and every request
        // still completes (FIFO drain, nothing dropped).
        let state = gate_test_state();
        let gate = std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(std::sync::Arc::clone(&gate), std::time::Duration::from_secs(30));
        let router = crate::router(state);

        let mut handles = Vec::new();
        for _ in 0..16 {
            let r = router.clone();
            handles.push(tokio::spawn(async move {
                gate_post(r, "/api/tabs", shell_create_body()).await
            }));
        }
        for h in handles {
            let (status, body) = h.await.expect("request task");
            assert_eq!(status, axum::http::StatusCode::OK, "{body}");
        }
        // With 16 near-simultaneous arrivals and 1 permit, the overwhelming
        // majority must have queued. (The fast path skips the counter when
        // the queue is momentarily empty, hence >= 8, not == 15.)
        assert!(
            gate.queued_total() >= 8,
            "burst did not queue through the gate: queued_total={}",
            gate.queued_total()
        );
        assert_eq!(gate.queue_rejections(), 0, "no loud rejections expected");
        assert_eq!(gate.timeouts(), 0, "no permit-wait timeouts expected");
    }
```
(This forks 16 real `/bin/sh` shells — the accepted house technique; the WS
integration and e2e storm tests do the same.)

- [ ] **Step 2: Write the held-permit and permit-release tests**

```rust
    #[tokio::test]
    async fn held_permit_blocks_rest_create_until_released() {
        // End-to-end permit accounting at the REST seam: while the single
        // permit is held (here by the test itself — in production, by the
        // OTHER door), REST creates time out; after release they succeed.
        let state = gate_test_state();
        let gate = std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(1, 64));
        state.set_spawn_gate(std::sync::Arc::clone(&gate), std::time::Duration::from_millis(200));
        let router = crate::router(state);

        let held = gate
            .acquire(std::time::Duration::from_secs(1))
            .await
            .expect("test holds the only permit");
        let (status, body) =
            gate_post(router.clone(), "/api/tabs", shell_create_body()).await;
        assert_eq!(status, axum::http::StatusCode::SERVICE_UNAVAILABLE, "{body}");
        assert_eq!(body["code"], serde_json::json!("SPAWN_TIMEOUT"));

        drop(held);
        let (status, body) = gate_post(router, "/api/tabs", shell_create_body()).await;
        assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    }

    #[tokio::test]
    async fn failed_spawn_releases_its_permit() {
        // Concurrency-1 gate: if a FAILED spawn leaked its permit, the next
        // create could never acquire and would 503. Force the failure with a
        // registered CLI whose command does not exist (model the spec on the
        // file's existing `recording_cli_spec` helper at ~:2465, pointing
        // default_cmd at a nonexistent path instead of a script).
        let broken = {
            let mut spec = recording_cli_spec("brokencli"); // reuse/adapt local helper
            spec.default_cmd = "/nonexistent/definitely-missing-binary".to_string();
            spec
        };
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
        let state = crate::FreshAgentState::new(
            std::sync::Arc::new("tok".to_string()),
            std::sync::Arc::new(tx),
        )
        .with_terminal_registry(freshell_terminal::TerminalRegistry::new())
        .with_cli_commands(std::sync::Arc::new(vec![broken]));
        state.set_spawn_gate(
            std::sync::Arc::new(crate::spawn_gate::SpawnGate::new(1, 64)),
            std::time::Duration::from_millis(500),
        );
        let router = crate::router(state);

        let (status, body) = gate_post(
            router.clone(),
            "/api/tabs",
            serde_json::json!({
                "mode": "brokencli",
                "cwd": std::env::temp_dir().to_string_lossy(),
            }),
        )
        .await;
        assert_eq!(status, axum::http::StatusCode::BAD_REQUEST, "spawn should fail: {body}");

        // The failed spawn's RAII permit must be back: a healthy create
        // succeeds instead of hitting SPAWN_TIMEOUT on the 1-permit gate.
        let (status, body) = gate_post(router, "/api/tabs", shell_create_body()).await;
        assert_eq!(status, axum::http::StatusCode::OK, "permit leaked? {body}");
    }
```
Adaptation notes: match `recording_cli_spec`'s real signature/fields and the
`with_cli_commands` builder's real parameter type (`Arc<Vec<CliCommandSpec>>`
per `lib.rs`). If a nonexistent binary turns out NOT to make
`registry.create` return `Err` (e.g. the PTY layer reports exec failure
asynchronously and the create is a 200), keep the second assertion (healthy
create succeeds — the actual leak pin, which holds either way) and change the
first to accept the observed status with a comment; the leak pin is the
load-bearing assertion.

- [ ] **Step 3: Run — these should pass immediately (Tasks 3–4 implemented the behavior)**

```bash
cargo test -p freshell-freshagent -- fifteen_plus_rest held_permit failed_spawn_releases 2>&1 | tail -8
cargo test -p freshell-freshagent 2>&1 | tail -5
```
Expected: all PASS. If `fifteen_plus_rest…` hangs or times out, the acquire is
deadlocking against the inline spawn — re-check Task 4's `spawn_blocking`
wrap before touching the test.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "test: REST spawn-gate burst, held-permit, and permit-release pins

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 6: WS + REST share ONE budget (integration test)

**Files:**
- Create: `crates/freshell-ws/tests/rest_ws_shared_gate.rs`

**Interfaces:**
- Consumes: `freshell_ws::WsState` literal pattern + server-spawn helpers from `crates/freshell-ws/tests/common/mod.rs` (`spawn_server_with_create_protect` is the closest model — copy its `WsState` construction); `freshell_freshagent::{FreshAgentState, router, SpawnGate}`; `tokio-tungstenite` WS client helpers from `create_protection.rs` (`send_create_and_await_reply` shape).
- Produces: the pinned invariant — ONE gate instance = ONE budget across both doors; saturating from one door starves the other; releasing frees both. This is the "not two parallel budgets that double the effective limit" pin the kata demands.

- [ ] **Step 1: Write the test**

New file `crates/freshell-ws/tests/rest_ws_shared_gate.rs`:

```rust
//! Kata enn3 pin: the WS terminal.create door and the freshagent REST create
//! door share ONE SpawnGate instance — a single global concurrency budget,
//! never two parallel budgets. Real axum server on an ephemeral loopback
//! port serving BOTH routers (the same merge shape as
//! freshell-server/src/main.rs), real WS client, real REST calls, real PTYs.

mod common;

use freshell_freshagent::spawn_gate::SpawnGate;
use std::sync::Arc;
use std::time::Duration;

#[tokio::test(flavor = "multi_thread")]
async fn ws_and_rest_creates_share_one_spawn_budget() {
    // ONE gate, 1 permit, generous queue; short permit-wait timeout so the
    // starved door fails fast and deterministically.
    let gate = Arc::new(SpawnGate::new(1, 64));

    // --- build the combined app (model the WsState literal on
    // --- common::spawn_server_with_create_protect, but with our shared Arc)
    let cfg = freshell_ws::create_limit::CreateProtectConfig {
        spawn_timeout_ms: 300,
        ..Default::default()
    };
    // ws_state: copy the full WsState { .. } literal from common/mod.rs,
    // substituting: create_protect: cfg.clone(), spawn_gate: Arc::clone(&gate).
    // fresh_agent_state: FreshAgentState::new(tok, broadcast) +
    //   .with_terminal_registry(<a TerminalRegistry — its own is fine>);
    //   then fresh_agent_state.set_spawn_gate(Arc::clone(&gate),
    //   Duration::from_millis(cfg.spawn_timeout_ms));
    // app = freshell_ws::router(ws_state)
    //         .merge(freshell_freshagent::router(fresh_agent_state));
    // bind TcpListener 127.0.0.1:0, axum::serve in a spawned task,
    // ws_url = ws://{addr}/ws, base_url = http://{addr}.
    let (ws_url, base_url, auth_token) = spawn_combined_server(cfg, Arc::clone(&gate)).await;

    // 1) Saturate the ONLY permit from OUTSIDE both doors.
    let held = gate.acquire(Duration::from_secs(1)).await.expect("hold the permit");

    // 2) REST door is starved -> 503 SPAWN_TIMEOUT.
    let client = reqwest_like_post(&base_url, "/api/tabs", &auth_token).await;
    assert_eq!(client.status, 503, "REST starved: {}", client.body);
    assert_eq!(client.json["code"], serde_json::json!("SPAWN_TIMEOUT"));

    // 3) WS door is starved by the SAME budget -> PTY_SPAWN_FAILED frame
    //    with the pinned message (unchanged WS wire shape).
    let ws_reply = ws_create_and_await_reply(&ws_url, &auth_token, "req-starved").await;
    assert_eq!(ws_reply["type"], serde_json::json!("error"));
    assert_eq!(ws_reply["code"], serde_json::json!("PTY_SPAWN_FAILED"));
    assert_eq!(
        ws_reply["message"],
        serde_json::json!("Timed out waiting for a terminal spawn slot")
    );

    // 4) Release the permit: BOTH doors recover through the one budget.
    drop(held);
    let client = reqwest_like_post(&base_url, "/api/tabs", &auth_token).await;
    assert_eq!(client.status, 200, "REST recovered: {}", client.body);
    let ws_reply = ws_create_and_await_reply(&ws_url, &auth_token, "req-recovered").await;
    assert_eq!(ws_reply["type"], serde_json::json!("terminal.created"), "{ws_reply}");
}
```

Implementation notes (the helpers are this file's own plumbing — write them
in this file, per-test-file ownership):
- `spawn_combined_server`: copy the body of
  `common::spawn_server_with_create_protect` and (a) substitute
  `spawn_gate: Arc::clone(&gate)` into the `WsState` literal, (b) build a
  `FreshAgentState` sharing the SAME broadcast channel/auth token, call
  `set_spawn_gate(gate, Duration::from_millis(cfg.spawn_timeout_ms))`, and
  (c) `.merge(freshell_freshagent::router(fresh_agent_state))` before binding.
  Return `(ws_url, base_url, token)`.
- `reqwest_like_post`: VERIFIED (load-bearing check A8): `freshell-ws` has NO
  `reqwest`/`hyper`/`tower` dev-dependency, `reqwest` in Cargo.lock is only a
  transitive of `freshell-opencode` (not importable here), and no existing
  `crates/*/tests` file makes real HTTP calls today. So: hand-roll a minimal
  raw `tokio::net::TcpStream` HTTP/1.1 POST with `x-auth-token` and a JSON
  body (`{"mode":"shell","cwd":"<tmp>"}`), kept in this file (tokio `net` is
  already available). Do NOT add new workspace dependencies.
- `ws_create_and_await_reply`: copy the `send_create_and_await_reply` shape
  from `tests/create_protection.rs:74-111` (hello → ready → `terminal.create`
  with a `requestId` → drain frames until `terminal.created`/`error` for that
  requestId, 15s outer deadline).

- [ ] **Step 2: Run to verify (behavior already implemented — this is a pin, expected green; the pin's VALUE is that it fails if anyone ever splits the budget)**

```bash
cargo test -p freshell-ws --test rest_ws_shared_gate 2>&1 | tail -8
```
Expected: PASS. Sanity-check the pin bites: temporarily change the test's
`set_spawn_gate` line to wire a DIFFERENT `SpawnGate::new(1, 64)` instance,
re-run, and confirm step 2's REST assertion now FAILS (REST succeeds on its
own budget while WS starves) — then revert that temporary edit. Record both
outputs as proof the test discriminates.

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-ws/tests/rest_ws_shared_gate.rs
git commit -m "test: pin ONE shared spawn budget across WS and REST create doors

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 7: Production wiring in `main.rs`

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (~`:479` and `:571-574`)

**Interfaces:**
- Consumes: `FreshAgentState::set_spawn_gate` (Task 2); `CreateProtectConfig::from_env()` (already at `main.rs:479`); the `WsState` literal at `main.rs:502-576`.
- Produces: ONE production gate instance flowing to both doors. Proven live by Task 8's e2e.

- [ ] **Step 1: Hoist and share**

Immediately after `let create_protect = freshell_ws::create_limit::CreateProtectConfig::from_env();`
(~`main.rs:479`), add:
```rust
    // Kata enn3: ONE server-wide spawn gate shared by BOTH create doors —
    // WS terminal.create AND the freshagent REST pipeline (/api/tabs,
    // /api/panes/{id}/split, /api/panes/{id}/respawn). A single concurrency
    // budget, never two parallel budgets; pinned by
    // crates/freshell-ws/tests/rest_ws_shared_gate.rs. Post-construction
    // setter (ledger precedent): create_protect resolves here, after the
    // last fresh_agent_state builder rebinding. SpawnGate::new passes the
    // (already env-sanitized) values straight through.
    let spawn_gate = std::sync::Arc::new(freshell_freshagent::spawn_gate::SpawnGate::new(
        create_protect.spawn_concurrency,
        create_protect.spawn_queue_cap,
    ));
    fresh_agent_state.set_spawn_gate(
        std::sync::Arc::clone(&spawn_gate),
        std::time::Duration::from_millis(create_protect.spawn_timeout_ms),
    );
```
Then change the `WsState` literal field (Task 1 left it as an inline
`SpawnGate::new(…)`) to the shared clone:
```rust
        spawn_gate: std::sync::Arc::clone(&spawn_gate),
```
(Type note: `freshell_ws::spawn_gate::SpawnGate` IS
`freshell_freshagent::spawn_gate::SpawnGate` via the Task 1 re-export, so the
field accepts the clone directly.)

- [ ] **Step 2: Verify build + full Rust suite**

```bash
cargo build -p freshell-server 2>&1 | tail -3
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo test --workspace 2>&1 | tail -10
```
Expected: build + clippy clean; workspace tests green (allow ~10–20 min; run
with a generous timeout).

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-server/src/main.rs
git commit -m "feat: wire ONE shared spawn gate into both WS and REST create doors

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 8: E2E — REST burst against a real server

**Files:**
- Create: `test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register in BOTH `RUST_ONLY_SPECS` and the `rust-chromium` project's `testMatch`)

**Interfaces:**
- Consumes: `RustServer` from `test/e2e-browser/helpers/rust-server.ts` (`new RustServer({ env }).start() -> TestServerInfo { port, baseUrl, wsUrl, token, logsDir, … }`); the `SyntheticClient` raw-WS helper pattern from `create-protection-isolation-rust.spec.ts:27-90` (copied into this spec — per-spec-ownership convention); log-grep pattern from `create-protection-restore-storm-rust.spec.ts`.
- Produces: production-wiring proof — a 16-burst of `POST /api/tabs` on a REAL server queues through the gate (log evidence `spawn_gate_queued`), all panes are eventually created, and a concurrent WS client stays responsive.

- [ ] **Step 1: Write the spec**

`test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts` (API+WS only — no
browser page, so none of the storm spec's settings/picker gotchas apply):

```ts
/**
 * Kata enn3 (REST spawn gate): a 16-burst of REST pane creates against a
 * REAL freshell-server must be concurrency-bounded by the SHARED spawn gate
 * (FRESHELL_SPAWN_GATE_CONCURRENCY=1 makes queueing deterministic), every
 * pane must still be created (FIFO drain, nothing dropped), and the server
 * must stay responsive to a concurrent WS client throughout. Owns its
 * RustServer (ephemeral port — NEVER the user's live 3001/3002). Helpers
 * copied per per-spec-ownership. RUST_LOG=info is mandatory: the bounded-
 * concurrency evidence is the spawn_gate_queued INFO event in the server log.
 */
import { test, expect } from '@playwright/test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import os from 'node:os'
import WebSocket from 'ws'
import { RustServer } from '../helpers/rust-server'
import type { TestServerInfo } from '../helpers/test-server'

test.setTimeout(300_000)

// --- SyntheticClient: copy the class body verbatim from
// --- create-protection-isolation-rust.spec.ts:27-90 (connect / send /
// --- waitFor / close). Do not import it — per-spec-ownership.

function readServerLogs(info: TestServerInfo): string {
  return readdirSync(info.logsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .map((f) => readFileSync(join(info.logsDir, f), 'utf8'))
    .join('\n')
}

test('REST create burst is gate-bounded, drains fully, and WS stays responsive', async () => {
  const server = new RustServer({
    // FRESHELL_SPAWN_GATE_TIMEOUT_MS=60000: de-flake, not behavior change —
    // 16 serialized spawns must all acquire within the permit-wait; on a
    // loaded CI host the 10s default leaves little margin (load-bearing
    // check A7). Production defaults (Global Constraints) are untouched.
    env: {
      RUST_LOG: 'info',
      FRESHELL_SPAWN_GATE_CONCURRENCY: '1',
      FRESHELL_SPAWN_GATE_TIMEOUT_MS: '60000',
    },
  })
  const info = await server.start()
  try {
    // WS client connected BEFORE the burst.
    const ws = await SyntheticClient.connect(info)

    // 16 concurrent REST creates.
    const burst = Array.from({ length: 16 }, () =>
      fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: {
          'x-auth-token': info.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ mode: 'shell', cwd: os.tmpdir() }),
      }),
    )

    // While the burst queues through the 1-permit gate, the server keeps
    // answering: health stays ok.
    const health = await fetch(`${info.baseUrl}/api/health`)
    expect(health.ok).toBe(true)

    const responses = await Promise.all(burst)
    for (const res of responses) expect(res.status).toBe(200)

    // Every pane materialized (FIFO drain — nothing dropped).
    const panesRes = await fetch(`${info.baseUrl}/api/panes`, {
      headers: { 'x-auth-token': info.token },
    })
    expect(panesRes.status).toBe(200)
    const panes = (await panesRes.json()) as any
    // Adjust the extraction to the real /api/panes envelope
    // ({status:"ok",data:...}); the assertion is >= 16 panes.
    const paneCount = Array.isArray(panes?.data?.panes)
      ? panes.data.panes.length
      : Array.isArray(panes?.data)
        ? panes.data.length
        : 0
    expect(paneCount).toBeGreaterThanOrEqual(16)

    // Bounded concurrency observed: the burst QUEUED through the gate
    // (non-vacuous: with concurrency 1 and 16 near-simultaneous creates,
    // queueing is guaranteed).
    expect(readServerLogs(info)).toContain('spawn_gate_queued')

    // WS door still works after the REST burst (shared budget drained).
    ws.send({
      type: 'terminal.create',
      requestId: 'ws-after-burst',
      mode: 'shell',
      cwd: os.tmpdir(),
    })
    const created = await ws.waitFor(
      (f: any) =>
        (f.type === 'terminal.created' || f.type === 'error') &&
        f.requestId === 'ws-after-burst',
    )
    expect(created.type).toBe('terminal.created')
    ws.close()
  } finally {
    await server.stop()
  }
})
```
Adaptation notes: match `SyntheticClient`'s real hello/ready handshake
(protocolVersion, token) exactly as copied; match the real `terminal.create`
message shape used by that spec's sibling helpers; adjust the `/api/panes`
envelope extraction to the actual response (assert-fail loudly if the shape is
unrecognized rather than passing vacuously).

- [ ] **Step 2: Register the spec in the Playwright config (BOTH places)**

In `test/e2e-browser/playwright.config.ts`:
1. Append to the `RUST_ONLY_SPECS` array:
```ts
  // Kata enn3: REST spawn-gate burst; owns its RustServer.
  // See docs/plans/2026-07-27-rest-spawn-gate.md
  /rest-spawn-gate-rust\.spec\.ts$/,
```
2. Append the same regex to the `rust-chromium` project's `testMatch` list
(follow the exact style of the existing `create-protection-*-rust` entries).

- [ ] **Step 3: Run the spec (+ the existing create-protection specs as the WS-unchanged e2e pin)**

```bash
cd /home/dan/code/freshell/.worktrees/rest-spawn-gate
npm run test:e2e -- test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts
npm run test:e2e -- test/e2e-browser/specs/create-protection-restore-storm-rust.spec.ts \
  test/e2e-browser/specs/create-rate-limit-ladder-rust.spec.ts \
  test/e2e-browser/specs/create-protection-isolation-rust.spec.ts
```
(Playwright is not coordinator-gated; global-setup builds client+server and
the fixture runs `cargo build --release -p freshell-server` — allow ~15–30 min
cold. `npm ci` + tsx symlink may be needed first if `node_modules` is absent.)
Expected: all four specs PASS.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/rest-spawn-gate-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): REST spawn-gate burst against a real server (kata enn3 acceptance)

🤖 Generated with [Amplifier](https://github.com/microsoft/amplifier)

Co-Authored-By: Amplifier <240397093+microsoft-amplifier@users.noreply.github.com>"
```

---

### Task 9: Final verification, push, and kata-closable report (STOP before PR)

**Files:**
- No source changes (verification + push only).

**Interfaces:**
- Consumes: everything above.
- Produces: green proof across all required gates; pushed branch `fix/rest-spawn-gate`; a kata-closable summary. NO PR (not approved).

- [ ] **Step 1: Full local CI-equivalent**

```bash
cd /home/dan/code/freshell/.worktrees/rest-spawn-gate
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -3
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings 2>&1 | tail -3
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings 2>&1 | tail -3
cargo test --workspace 2>&1 | tail -10
npm run test:port && npm run contract:generate && git diff --exit-code -- port/contract
```
Expected: everything green; the contract diff is empty (this lane changes no
wire schema).

- [ ] **Step 2: Coordinated JS suite**

```bash
npm run test:status
# WAIT if another agent holds the gate — 3 sibling lanes run concurrently.
FRESHELL_TEST_SUMMARY="rest-spawn-gate: final verification" env -u FRESHELL_BIND_HOST npm test
```
Expected: green (this lane touches no TS runtime code except the new e2e spec
and its config registration, so this is a pure regression net).

- [ ] **Step 3: Push and STOP**

```bash
git log --oneline origin/main..HEAD    # sanity: only this lane's commits
git push -u origin fix/rest-spawn-gate
```
Then STOP — do NOT run `gh pr create` (not approved).

- [ ] **Step 4: Report (kata-closable summary)**

Report must include, so kata `enn3` can be closed against its acceptance:
- Branch: `fix/rest-spawn-gate` (base `3f096412`), commit list.
- Red→green proof: the Task 3 Step 2 failing output (0-permit gate → 200
  before the fix) vs the passing runs after; the Task 6 Step 2
  discrimination check (two-instance sabotage → fail, shared instance → pass).
- Acceptance mapping: 15+ REST burst bounded → Task 5 burst test +
  Task 8 e2e (all 16 created, `spawn_gate_queued` in logs, concurrency 1);
  WS unchanged → `terminal.rs` untouched, full `freshell-ws` suite +
  the three existing create-protection e2e specs green, shared-budget test
  pins ONE instance; queue-cap → loud 429 `SPAWN_QUEUE_FULL`; permit released
  on failure/timeout → Task 5 pins; codex sidecar → REST-reachable
  managed-launch path gated by permit placement (D-C), WS-only
  `spawn_sidecar` documented as not-applicable (D-D).

---

## Self-Review (performed while authoring — results)

**1. Spec coverage.**
- Gate acquirable from both doors via neutral home / house-style injection → Tasks 1, 2, 7 (D-A, D-B).
- REST pipeline acquires a permit around its PTY spawn, same FIFO fairness / queue-depth fail-loud / per-spawn timeout / RAII release → Task 3 (the moved gate is byte-identical, so FIFO/queue/timeout semantics are inherited, not reimplemented); RAII pins in Task 5.
- Codex-sidecar path evaluated → gated where REST-reachable, documented why not elsewhere (D-C/D-D; wired into the Task 9 report).
- WS behavior unchanged + ONE shared budget verified and pinned → Task 1 Step 5 (full WS suite), Task 6 (shared-budget integration test + discrimination check), Task 8 Step 3 (existing WS e2e specs), `terminal.rs` untouched.
- TDD red-first at the freshagent seam → Task 3 Step 2 red (200 today).
- Combined WS+REST one-budget test → Task 6.
- Queue-cap loud error with honest REST shape + caller-tolerance evaluation → Task 3 + D-E.
- Permit released on spawn failure/timeout → Task 5.
- E2E on own RustServer, ephemeral ports, never 3001/3002, bounded-concurrency evidence, concurrent WS client responsive → Task 8.
- Repo rules (clippy -D warnings, coordinated suites, commit trailer, push-then-stop) → Global Constraints + Tasks 1–9 steps.
- No gaps found; no UNRESOLVED COVERAGE GAP entries needed.

**1b. No silent deferrals.** No stubs/mocks stand in for required behavior:
the seam tests fork real PTYs (house practice), Task 6 runs a real socket
server, Task 8 proves the real binary's production wiring end-to-end. The
`None = ungated` default is not a deferral: production always wires the gate
(Task 7), and Task 8's log assertion proves the gate is live in the shipped
wiring. The MCP bridge's status-dropping is explicitly out of fence and
mitigated in-message (D-E) — a documented design decision, not a deferral of
this kata's requirement.

**2. Placeholder scan.** No TBD/TODO/"handle errors appropriately" steps; every
code step shows code. Steps that direct the implementer to "mirror the
existing helper" also pin the exact source location and the load-bearing
assertion, with fallback behavior specified (Task 5 Step 2, Task 6 Step 1,
Task 8 Step 1).

**1c. Load-bearing validation amendments (Stage 2, post-authoring).** The
assumption ledger (`.worktrees/.the-usual-logs/rest-spawn-gate/load-bearing-ledger.md`)
verified 6 assumptions and falsified 2; the falsified ones are fixed above:
- A1 (falsified): the original acquire anchor (`:892`, the codex plan block)
  was inside the non-shell `else` branch and AFTER real side effects. D-C and
  Task 3 Step 3 now pin the corrected anchor (~`:793/:795`, shared path of
  every mode, before `generate_mcp_injection`). Task 3's tests (shell-mode
  0-permit 503s) discriminate: they would fail against the old anchor.
- A2 (falsified for the flag-ON world): permit-hold across
  `plan_create_with_retry` can reach ~226s worst-case vs the 10s wait. D-C
  now records the exposure, the alternatives considered, and the decision
  (flag defaults OFF; revisit at S5 default-flip).
- Verified: kata text matches the plan's acceptance mapping (retrieved
  verbatim; "kata item 2" wording corrected in D-D); CLI surfaces `message`
  on non-2xx with no retry loop and exits cleanly (D-E holds, CLI prints
  `message` only — never `code`); no caller fetch timeout < 10s (undici
  headersTimeout default 300s; bare global fetch in both clients);
  `spawn_gate_queued` is the literal INFO message string, serialized verbatim
  as `"msg"` by JsonLayer and passes the RUST_LOG=info filter (Task 8's grep
  is valid; it fires only on the contended path — guaranteed by
  concurrency 1 × 16-burst); Task 6's harness is assemblable (WsState literal
  provably constructible from tests/, zero route overlap on merge, WS Timeout
  wire strings confirmed verbatim at `terminal.rs:2441-2444`) with the
  hand-rolled HTTP client now pinned (no reqwest/hyper dev-deps exist);
  fn-end RAII permit hold is cheap for the shipped default config (post-create
  tail is sync in-memory work; the ≤500ms pid-death confirm is an error-path
  rarity; only flag-ON managed codex holds across unbounded awaits — covered
  by the A2 decision).
- Accepted residual risks: A7 (burst-timing thresholds; mitigated with the
  Task 8 explicit 60s test timeout env and Task 5's tolerant `>= 8`
  threshold), A10 (knob sizing predates the second door; knobs stay
  env-tunable and failures are loud, so inadequacy is observable — combined
  WS+REST load re-derivation deferred, kata does not require it).

**3. Type consistency.** `SpawnGate::new(usize, usize)`, `acquire(&self, Duration) -> Result<OwnedSemaphorePermit, SpawnGateError>`, counters `-> u64` — used identically in Tasks 1–8. `set_spawn_gate(Arc<SpawnGate>, Duration)` / `spawn_gate() -> Option<RestSpawnGate>` consistent across Tasks 2, 3, 6, 7. Error codes `SPAWN_QUEUE_FULL`(429)/`SPAWN_TIMEOUT`(503) and message strings identical in Task 3 impl, Task 3/5 tests, Task 6, and D-E.
