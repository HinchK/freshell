# Attach-Viewport Follow-Ups Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Complete the three deferred follow-ups from the TERM-07 attach-viewport work: clear the pre-existing `freshell-platform` clippy baseline, port Node's exact dimension floor/range semantics to the Rust resize/attach/spawn paths, and extract the duplicated `freshell-ws` integration-test harness into a shared `tests/common/` module.

**Architecture:** Three independent workstreams on top of the unmerged `fix/rust-attach-viewport` branch code (already present in this worktree's history). Follow-up 2 ports Node's dimension handling at the three layers where Node actually implements it: reject-out-of-range at the WS protocol boundary (Zod parity), floor-at-2 in geometry bookkeeping (broker parity), and falsy-coalesce defaults at spawn (`opts.cols || 120` parity). Follow-up 3 establishes the standard Cargo `tests/common/mod.rs` convention (the workspace has no existing test-sharing convention — this creates it).

**Tech Stack:** Rust (cargo, clippy, rustfmt), tokio + axum + tokio-tungstenite 0.24 integration tests, serde/serde_json wire protocol.

## Global Constraints

- **Base branch:** this worktree (`/home/dan/code/freshell/.worktrees/attach-viewport-followups`, branch `fix/attach-viewport-followups`) is forked from `fix/rust-attach-viewport` (HEAD `55f58545`). NEVER rebase onto or fork from `origin/main` — the code these follow-ups modify exists only on this branch lineage.
- **Rust-only:** never modify `server/` (Node), `shared/`, or `src/` (client). All changes live under `crates/`.
- **Node parity values (copied verbatim from Node source):**
  - Protocol bounds (`shared/ws-protocol.ts:344-345, 364-365`): `cols: z.number().int().min(2).max(1000)`, `rows: z.number().int().min(2).max(500)` — enforcement is **reject** with `INVALID_MESSAGE` (`server/ws-handler.ts:1856-1858`), not clamp.
  - Geometry bookkeeping floor (`server/terminal-stream/broker.ts:672-673`): `Math.max(2, Math.floor(Number.isFinite(cols) ? cols : 80))` / `Math.max(2, Math.floor(Number.isFinite(rows) ? rows : 24))`.
  - Spawn defaults (`server/terminal-registry.ts:1572-1573`): `const cols = opts.cols || 120`, `const rows = opts.rows || 30` — falsy-coalesce (0 → default), NOT a floor (1 passes through).
- **Known baseline test failures (gate = no NEW failures, these 2 stay failing):**
  1. `freshell-ws` test `codex_session_ref_resume` — `PTY_SPAWN_FAILED: Unable to resolve MCP dependency "tsx"` (worktree lacks `node_modules/`; do not chase in Rust code).
  2. `freshell-ws` test `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref` — deterministic timeout, pre-existing on the base branch.
- **Standard verification commands** (from `docs/plans/2026-07-24-rust-attach-viewport.md:870-875`; there is no justfile/Makefile/CI for Rust):
  - `cargo test -p freshell-platform`, `cargo test -p freshell-terminal`, `cargo test -p freshell-ws`
  - `cargo fmt --all --check`
  - `cargo clippy -p freshell-platform -p freshell-terminal -p freshell-ws --all-targets -- -D warnings`
- **Lint policy:** fix the code, never `#[allow]` — with ONE justified exception: `#![allow(dead_code)]` at the top of `tests/common/mod.rs` is the idiomatic Rust pattern for shared integration-test modules (each test binary compiles the whole module; unused helpers per-binary are expected by design).
- **Repo rules:** Red-Green-Refactor TDD for behavior changes; never restart the self-hosted Freshell server; no `gh pr create` without explicit user approval; ≤1K lines/file where feasible (`spawn.rs` is already at 1071 lines — do not grow it; new tests go in a `#[path]`-included sibling file, the repo's established convention, see `cli_launch.rs:540`, `mcp_inject.rs:672`).
- **Commit convention:** Conventional Commits with `(rust)` scope, e.g. `fix(rust): ...`, `refactor(rust): ...`.
- **JS/Vitest suite:** NOT required — Rust-only diff ("Rust checks are NOT gated by the JS coordinator").

**Explicitly out of scope (recorded, not silently dropped — none are spec requirements):**
- Migrating the other 11 `freshell-ws` test files to `tests/common/` (`term09_output_queue.rs` uses a different socket type `WebSocketStream<TcpStream>` via socket2 and needs generic helpers; the rest are cheap follow-ups once the module exists). The spec requires migrating the attach-viewport tests + the donor file only.
- Node's `status !== 'running'` guard missing from Rust `TerminalRegistry::resize` (`terminal-registry.ts:4027` vs `registry.rs:1004`) — a real parity gap discovered during investigation, but it is not floor semantics and is not in the spec's scope. Recorded here for a future follow-up.

---

### Task 1: Clear the freshell-platform clippy baseline

The baseline has 7 clippy warnings in `freshell-platform` (6 in the lib target — the "6 pre-existing lint errors" recorded by the prior work — plus 1 more in the lib-test target that `--all-targets` surfaces). All become errors under the repo-standard `-- -D warnings` invocation. All have mechanical, clippy-suggested fixes. No behavior change — the existing test suite is the regression net.

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch.rs:318`
- Modify: `crates/freshell-platform/src/spawn.rs:288,509-511`
- Modify: `crates/freshell-platform/src/network.rs:415`
- Modify: `crates/freshell-platform/src/mcp_inject_tests.rs:3`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing other tasks rely on (independent workstream).

- [ ] **Step 1: Reproduce the baseline failures (RED)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/attach-viewport-followups
cargo clippy -p freshell-platform --all-targets -- -D warnings
```
Expected: FAIL (exit 101) with exactly these 7 errors:
- `cli_launch.rs:318` — `manual_pattern_char_comparison`
- `spawn.rs:288` — `nonminimal_bool`
- `spawn.rs:509`, `spawn.rs:510`, `spawn.rs:511` — `doc_lazy_continuation` (×3)
- `network.rs:415` — `trim_split_whitespace`
- `mcp_inject_tests.rs:3` — `doc_lazy_continuation` (lib-test target)

- [ ] **Step 2: Fix `cli_launch.rs:318` (manual_pattern_char_comparison)**

Change line 318 from:
```rust
            .find(|c| matches!(c, '/' | ':' | '?' | '#'))
```
to:
```rust
            .find(['/', ':', '?', '#'])
```
(`str::find` accepts a `[char; N]` pattern directly — this is clippy's own suggestion.)

- [ ] **Step 3: Fix `spawn.rs:288` (nonminimal_bool)**

Change line 288 from:
```rust
    if !(crate::detect::is_windows_like(host_os, is_wsl_env) && !in_wsl_with_linux_shell) {
```
to:
```rust
    if !crate::detect::is_windows_like(host_os, is_wsl_env) || in_wsl_with_linux_shell {
```
(De Morgan equivalence — `!(A && !B) == !A || B`. Semantics identical.)

- [ ] **Step 4: Fix `spawn.rs:509-511` (doc_lazy_continuation ×3)**

These three `///` lines are continuations of a doc list item and need two-space indentation (clippy's suggested fix). Change:
```rust
/// same `resolveUnixShellCwd`, so a claude/codex/opencode terminal lands in the
/// requested directory with `CLAUDECODE` stripped (which the reference notes is
/// required or child Claude refuses to start).
```
to:
```rust
///   same `resolveUnixShellCwd`, so a claude/codex/opencode terminal lands in the
///   requested directory with `CLAUDECODE` stripped (which the reference notes is
///   required or child Claude refuses to start).
```
(Look at the preceding line ~508 first: if these lines are actually meant as a standalone paragraph rather than a list-item continuation, the alternative fix is inserting a bare `///` blank line before line 509 — either resolves the lint; pick whichever preserves the rendered meaning.)

- [ ] **Step 5: Fix `network.rs:415` (trim_split_whitespace)**

Change line 415 from:
```rust
        let mut parts = line.trim().split_whitespace();
```
to:
```rust
        let mut parts = line.split_whitespace();
```
(`split_whitespace` already ignores leading/trailing whitespace — identical semantics.)

- [ ] **Step 6: Fix `mcp_inject_tests.rs:3` (doc_lazy_continuation)**

Change line 3 from:
```rust
//! Split out to respect the campaign's ≤1K-lines-per-file limit.
```
to:
```rust
//!   Split out to respect the campaign's ≤1K-lines-per-file limit.
```
(Same lint as Step 4; same alternative applies — a bare `//!` blank line above line 3 if it reads as its own paragraph.)

- [ ] **Step 7: Verify clippy is clean (GREEN)**

Run:
```bash
cargo clippy -p freshell-platform --all-targets -- -D warnings
```
Expected: PASS (exit 0, zero warnings).

- [ ] **Step 8: Verify no behavior change**

Run:
```bash
cargo test -p freshell-platform
cargo fmt --all --check
```
Expected: all tests PASS (this crate was green on the baseline); fmt check PASS.

- [ ] **Step 9: Commit**

```bash
git add crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/spawn.rs crates/freshell-platform/src/network.rs crates/freshell-platform/src/mcp_inject_tests.rs
git commit -m "fix(rust): clear freshell-platform clippy baseline (7 pre-existing warnings)"
```

---

### Task 2: Extract shared freshell-ws integration-test harness (`tests/common/`)

`crates/freshell-ws/tests/attach_viewport_resize.rs` (AVR, the new TERM-07 tests) and `crates/freshell-ws/tests/session_identity_frames.rs` (SIF, the donor) contain **175 byte-for-byte identical lines** of harness code (verified: `AVR:8-182` == `SIF:17-191`; a `diff` of the two ranges shows only the module-doc hunk and the divergence point). No sharing convention exists anywhere in the workspace — this task establishes the standard Cargo idiom: `tests/common/mod.rs` (subdirectories of `tests/` are NOT compiled as test binaries, so this needs no `Cargo.toml` change).

**Pure refactor: zero behavior change.** Helper bodies move verbatim; the receipt is that both test binaries produce identical results before and after (including SIF's one known-failing test).

**Files:**
- Create: `crates/freshell-ws/tests/common/mod.rs`
- Modify: `crates/freshell-ws/tests/attach_viewport_resize.rs` (delete lines 8–323, add `mod common;`)
- Modify: `crates/freshell-ws/tests/session_identity_frames.rs` (delete lines 17–217, add `mod common;`)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (Task 5 relies on these, re-exported from `common`): `pub const AUTH_TOKEN: &str`, `pub fn test_settings_value() -> serde_json::Value`, `pub fn sleeper_cli_spec(name: &str) -> freshell_platform::CliCommandSpec`, `pub async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry)`, `pub type TestWs = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>`, `pub async fn connect_and_capture_inventory(url: &str) -> (TestWs, serde_json::Value)`, `pub async fn create_shell_terminal(ws: &mut TestWs, request_id: &str) -> String`, `pub async fn drain_until_marker_or_deadline(ws: &mut TestWs, marker: &str, deadline: tokio::time::Instant) -> (String, bool, bool)`, `pub async fn attach_with(ws: &mut TestWs, terminal_id: &str, attach_request_id: &str, intent: &str, cols: u16, rows: u16, expected_session_ref: Option<serde_json::Value>)`, `pub async fn wait_for_attach_ready(ws: &mut TestWs, attach_request_id: &str)`, `pub async fn send_input(ws: &mut TestWs, terminal_id: &str, data: &str)`, `pub async fn next_frame_of_type(ws: &mut TestWs, wanted: &str) -> serde_json::Value`, `pub fn session_ref_of(frame: &serde_json::Value) -> Option<serde_json::Value>`.

- [ ] **Step 1: Record the baseline (GREEN before)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/attach-viewport-followups
cargo test -p freshell-ws --test attach_viewport_resize --test session_identity_frames 2>&1 | tail -30
```
Expected: `attach_viewport_resize` — 3 passed. `session_identity_frames` — 2 passed, 1 failed (`fresh_claude_create_frames_carry_preallocated_session_ref`, the known baseline timeout — see Global Constraints). Save this output; Step 6 must match it exactly.

- [ ] **Step 2: Create `crates/freshell-ws/tests/common/mod.rs`**

File header (write this verbatim), followed by the moved items:

```rust
//! Shared integration-test harness for `freshell-ws` WS tests.
//!
//! Extracted verbatim from `attach_viewport_resize.rs` and
//! `session_identity_frames.rs`, whose harness sections were byte-identical
//! copies. Compiled into each test binary that declares `mod common;` —
//! helpers unused by a given binary are expected, hence the file-level
//! `dead_code` allow (the idiomatic pattern for `tests/common/mod.rs`).
#![allow(dead_code)]
```

Then MOVE the following items, byte-for-byte (do not edit bodies), from the source files, adding `pub` to each item declaration (`pub const`, `pub fn`, `pub async fn`, `pub type`):

| Item | Move from (exact lines) |
|---|---|
| `use` block | `attach_viewport_resize.rs:9-16` |
| `const AUTH_TOKEN` | `attach_viewport_resize.rs:18` |
| `fn test_settings_value()` | `attach_viewport_resize.rs:20-38` |
| `fn sleeper_cli_spec(name: &str)` | `attach_viewport_resize.rs:40-76` |
| `async fn spawn_server()` | `attach_viewport_resize.rs:78-139` |
| `type TestWs` | `attach_viewport_resize.rs:141-142` |
| `async fn connect_and_capture_inventory(url)` | `attach_viewport_resize.rs:144-181` |
| `async fn create_shell_terminal(ws, request_id)` | `attach_viewport_resize.rs:183-218` |
| `async fn drain_until_marker_or_deadline(ws, marker, deadline)` | `attach_viewport_resize.rs:220-263` |
| `async fn attach_with(ws, id, rid, intent, cols, rows, expected_session_ref)` | `attach_viewport_resize.rs:265-288` |
| `async fn wait_for_attach_ready(ws, rid)` | `attach_viewport_resize.rs:290-310` |
| `async fn send_input(ws, id, data)` | `attach_viewport_resize.rs:312-323` |
| `async fn next_frame_of_type(ws, wanted)` | `session_identity_frames.rs:192-208` |
| `fn session_ref_of(frame)` | `session_identity_frames.rs:210-217` |

Keep doc comments attached to their items. Do NOT rename anything, change temp-file prefixes, tighten bounds, or add builders — verbatim move only (zero behavior change is the acceptance gate; the report-noted `sleeper_cli_spec` temp-path scheme is pre-existing behavior and stays as-is).

- [ ] **Step 3: Migrate `attach_viewport_resize.rs`**

Keep lines 1–7 (the module doc) unchanged. Replace everything from line 8 through line 323 (the blank line + all helpers, up to but NOT including the first `#[tokio::test]` at line 325) with:

```rust
mod common;
use common::*;
```

Then keep the original `use` block imports that the TEST BODIES themselves still need (the three tests at lines 325+ may call `SinkExt`/`StreamExt` methods, `serde_json::json!`, `Duration`, `WsMessage`, etc. directly). Procedure: after the edit, run
```bash
cargo test -p freshell-ws --test attach_viewport_resize --no-run
```
and (a) re-add any import the compiler reports as missing, (b) remove any import it warns is unused. End state: compiles with zero warnings.

- [ ] **Step 4: Migrate `session_identity_frames.rs`**

Keep lines 1–16 (the module doc) unchanged. Replace lines 17 through 217 (all helpers, up to but NOT including the first `#[tokio::test]` at line 219) with:

```rust
mod common;
use common::*;
```

Same import-fixup procedure:
```bash
cargo test -p freshell-ws --test session_identity_frames --no-run
```
End state: compiles with zero warnings.

- [ ] **Step 5: Verify the whole crate's test targets still compile**

Run:
```bash
cargo test -p freshell-ws --no-run
```
Expected: PASS. (Other test files are untouched — `tests/common/` is additive; files without `mod common;` are unaffected.)

- [ ] **Step 6: Run the migrated tests (GREEN after — must match Step 1 exactly)**

Run:
```bash
cargo test -p freshell-ws --test attach_viewport_resize --test session_identity_frames 2>&1 | tail -30
```
Expected: identical results to Step 1 — AVR 3 passed; SIF 2 passed, 1 failed (the same known-baseline test, `fresh_claude_create_frames_carry_preallocated_session_ref`). Any OTHER failure means the refactor changed behavior: stop and fix before proceeding.

- [ ] **Step 7: Lint and format**

Run:
```bash
cargo clippy -p freshell-ws --all-targets -- -D warnings
cargo fmt --all
cargo fmt --all --check
```
Expected: clippy PASS (the `#![allow(dead_code)]` header covers per-binary unused helpers); fmt clean.

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-ws/tests/common/mod.rs crates/freshell-ws/tests/attach_viewport_resize.rs crates/freshell-ws/tests/session_identity_frames.rs
git commit -m "refactor(rust): extract shared freshell-ws integration-test harness into tests/common"
```

---

### Task 3: Spawn geometry falsy-coalesce parity (`opts.cols || 120`)

Node's spawn path (`terminal-registry.ts:1572-1573`) uses `opts.cols || 120` / `opts.rows || 30` — JavaScript falsy-coalesce, so `0` falls back to the default while every non-zero value (including `1`) passes through unclamped. Rust's three spawn-spec builders use `cols.unwrap_or(DEFAULT_COLS)`, so `Some(0)` produces a 0-column PTY where Node self-heals to 120. Port the exact falsy semantics via one shared helper. (This is the only spawn-path divergence; there is deliberately NO floor-of-2 at spawn — Node has none.)

**Files:**
- Modify: `crates/freshell-platform/src/spawn.rs` (helper near `DEFAULT_COLS` at :102-103; call sites at :368-369, :538-539, :582-583; `#[path]` test-mod hook at end of file)
- Test: `crates/freshell-platform/src/spawn_dims_tests.rs` (new, `#[path]`-included — keeps `spawn.rs` from growing past its already-over-limit 1071 lines, following the repo's `cli_launch.rs:540` / `mcp_inject.rs:672` convention)

**Interfaces:**
- Consumes: `pub const DEFAULT_COLS: u16 = 120;` / `pub const DEFAULT_ROWS: u16 = 30;` (existing, `spawn.rs:102-103`).
- Produces: `pub fn dim_or_default(dim: Option<u16>, default: u16) -> u16` in `freshell_platform::spawn` (used only within `spawn.rs`'s three builders; no other task consumes it).

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-platform/src/spawn_dims_tests.rs`:

```rust
//! Node-parity tests for spawn geometry defaulting.
//!
//! Reference: `terminal-registry.ts:1572-1573` — `const cols = opts.cols || 120`,
//! `const rows = opts.rows || 30`. `||` is a falsy-coalesce, not a clamp: `0`
//! (the only falsy `u16`) falls back to the default; every non-zero value —
//! including values below the resize floor — passes through unchanged.

use super::{dim_or_default, DEFAULT_COLS, DEFAULT_ROWS};

#[test]
fn none_falls_back_to_default() {
    assert_eq!(dim_or_default(None, DEFAULT_COLS), 120);
    assert_eq!(dim_or_default(None, DEFAULT_ROWS), 30);
}

#[test]
fn zero_is_falsy_and_falls_back_to_default() {
    // Node: `0 || 120` → 120. The old Rust `unwrap_or` produced 0 here.
    assert_eq!(dim_or_default(Some(0), DEFAULT_COLS), 120);
    assert_eq!(dim_or_default(Some(0), DEFAULT_ROWS), 30);
}

#[test]
fn one_passes_through_because_spawn_has_no_floor() {
    // Node: `1 || 120` → 1 (truthy). Spawn is falsy-coalesce only, never a clamp.
    assert_eq!(dim_or_default(Some(1), DEFAULT_COLS), 1);
    assert_eq!(dim_or_default(Some(1), DEFAULT_ROWS), 1);
}

#[test]
fn normal_values_pass_through() {
    assert_eq!(dim_or_default(Some(95), DEFAULT_COLS), 95);
    assert_eq!(dim_or_default(Some(41), DEFAULT_ROWS), 41);
}
```

Then hook the module in at the very end of `crates/freshell-platform/src/spawn.rs`:

```rust
#[cfg(test)]
#[path = "spawn_dims_tests.rs"]
mod spawn_dims_tests;
```

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run:
```bash
cargo test -p freshell-platform spawn_dims_tests
```
Expected: FAIL to compile — `cannot find function `dim_or_default``.

- [ ] **Step 3: Implement the helper and wire the three builders (GREEN)**

In `crates/freshell-platform/src/spawn.rs`, directly below the `DEFAULT_COLS`/`DEFAULT_ROWS` constants (:102-103), add:

```rust
/// Node-parity spawn geometry defaulting (`terminal-registry.ts:1572-1573`:
/// `opts.cols || 120`, `opts.rows || 30`). JavaScript `||` is a
/// falsy-coalesce, not a clamp: `0` (the only falsy `u16`) falls back to the
/// default, and every non-zero value passes through unchanged — there is no
/// minimum floor on the spawn path in Node, so there is none here.
pub fn dim_or_default(dim: Option<u16>, default: u16) -> u16 {
    match dim {
        None | Some(0) => default,
        Some(v) => v,
    }
}
```

Then replace all three `unwrap_or` call-site pairs:

In `build_spawn_spec` (:368-369), change:
```rust
    let cols = cols.unwrap_or(DEFAULT_COLS);
    let rows = rows.unwrap_or(DEFAULT_ROWS);
```
to:
```rust
    let cols = dim_or_default(cols, DEFAULT_COLS);
    let rows = dim_or_default(rows, DEFAULT_ROWS);
```

In `build_cli_spawn_spec` (:538-539), change:
```rust
        cols: cols.unwrap_or(DEFAULT_COLS),
        rows: rows.unwrap_or(DEFAULT_ROWS),
```
to:
```rust
        cols: dim_or_default(cols, DEFAULT_COLS),
        rows: dim_or_default(rows, DEFAULT_ROWS),
```

In `build_windows_cli_spawn_spec` (:582-583), change:
```rust
    let cols = cols.unwrap_or(DEFAULT_COLS);
    let rows = rows.unwrap_or(DEFAULT_ROWS);
```
to:
```rust
    let cols = dim_or_default(cols, DEFAULT_COLS);
    let rows = dim_or_default(rows, DEFAULT_ROWS);
```

(Verify with `grep -n "unwrap_or(DEFAULT" crates/freshell-platform/src/spawn.rs` that zero call sites remain.)

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
cargo test -p freshell-platform
```
Expected: PASS — the 4 new tests plus the entire existing suite (all live callers pass `None`, so observable spawn behavior is unchanged at 120×30).

- [ ] **Step 5: Lint, format, commit**

Run:
```bash
cargo clippy -p freshell-platform --all-targets -- -D warnings
cargo fmt --all
git add crates/freshell-platform/src/spawn.rs crates/freshell-platform/src/spawn_dims_tests.rs
git commit -m "fix(rust): port Node falsy-coalesce spawn geometry defaults (opts.cols || 120)"
```
Expected: clippy exit 0 (keeps Task 1's win), commit succeeds.

---

### Task 4: Registry geometry floor at 2 (broker bookkeeping parity)

Node's only explicit dimension clamp is in the broker's geometry bookkeeping (`broker.ts:672-673`): `Math.max(2, Math.floor(Number.isFinite(cols) ? cols : 80))` (rows: fallback 24). In Rust, geometry bookkeeping and the PTY resize are unified in `TerminalRegistry::resize` / `resize_for_attach` (`s.cols`/`s.rows` back both `geometry()` and `pty.resize`), and today they store and forward raw values — `0` included. Port the formula at that layer: for `u16` input (always finite, always integral), `Math.max(2, Math.floor(finite ? x : fallback))` reduces exactly to `.max(2)` — the `floor` and non-finite fallback arms are unrepresentable. This is Node's formula applied at the equivalent Rust layer, not an invented clamp.

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (`resize` at :1004-1024, `resize_for_attach` at :1038-1087, new const nearby)
- Test: `crates/freshell-terminal/src/registry.rs` in-file `mod tests` (the crate's established convention — 13 existing resize/geometry tests live there, e.g. `resize_updates_geometry_epoch_only_on_change` at :2657)

**Interfaces:**
- Consumes: existing `TerminalRegistry::geometry(&self, terminal_id: &str) -> Option<(u16, u16, i64)>` (:1092), `reg.insert_headless("T", "S")` test seeding (seeds 120×30, epoch 1), `AttachResizeStatus` enum, `TerminalAttachIntent` enum — all already on this branch.
- Produces: `pub(crate) const MIN_GEOMETRY_DIM: u16 = 2;` in `registry.rs`; floored-at-2 semantics for `resize`/`resize_for_attach` that Task 5's integration layer sits above.

- [ ] **Step 1: Write the failing tests**

Add to the existing `mod tests` in `crates/freshell-terminal/src/registry.rs`, next to the other resize tests (after `resize_updates_geometry_epoch_only_on_change`, :2657-2668, whose style these follow):

```rust
    #[test]
    fn resize_floors_dimensions_at_two_node_broker_parity() {
        // Node: recordTerminalGeometry floors both dims at 2 (broker.ts:672-673).
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        reg.resize("T", 0, 0); // first record: floored to (2,2), no epoch bump
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        reg.resize("T", 1, 1); // floors to (2,2): unchanged, no bump
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        reg.resize("T", 1, 40); // floors to (2,40): real change, bump
        assert_eq!(reg.geometry("T"), Some((2, 40, 2)));
        reg.resize("T", 2, 2); // exact minimum passes through unaltered
        assert_eq!(reg.geometry("T"), Some((2, 2, 3)));
        reg.resize("T", 95, 41); // normal values pass through unaltered
        assert_eq!(reg.geometry("T"), Some((95, 41, 4)));
    }

    #[test]
    fn resize_for_attach_floors_dimensions_at_two_node_broker_parity() {
        let reg = TerminalRegistry::new();
        reg.insert_headless("T", "S");
        let status =
            reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 0, 1);
        assert!(matches!(status, AttachResizeStatus::Resized));
        assert_eq!(reg.geometry("T"), Some((2, 2, 1))); // first record: no bump
        let status =
            reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 1, 2);
        assert!(matches!(status, AttachResizeStatus::Unchanged)); // floored dup
        assert_eq!(reg.geometry("T"), Some((2, 2, 1)));
        let status =
            reg.resize_for_attach("T", 1, TerminalAttachIntent::ViewportHydrate, 95, 41);
        assert!(matches!(status, AttachResizeStatus::Resized));
        assert_eq!(reg.geometry("T"), Some((95, 41, 2)));
    }
```

(If `TerminalAttachIntent`/`AttachResizeStatus` are not already in the tests module's imports, add them the same way the neighboring `resize_for_attach_*` tests at :2706-2807 import them — those tests already reference both types.)

- [ ] **Step 2: Run tests to verify they fail (RED)**

Run:
```bash
cargo test -p freshell-terminal resize_floors_dimensions_at_two_node_broker_parity resize_for_attach_floors_dimensions_at_two_node_broker_parity
```
Expected: both FAIL — e.g. `assertion failed: left == right, left: Some((0, 0, 1)), right: Some((2, 2, 1))` (raw values are currently stored unfloored).

- [ ] **Step 3: Implement the floor (GREEN)**

In `crates/freshell-terminal/src/registry.rs`, add near the top of the impl (just above `resize`, :1004):

```rust
    /// Node-parity geometry floor (`broker.ts:672-673`:
    /// `Math.max(2, Math.floor(Number.isFinite(cols) ? cols : 80))`). For
    /// `u16` input — always finite, always integral — the formula reduces
    /// exactly to `.max(2)`; the `floor` and non-finite-fallback arms are
    /// unrepresentable in the Rust type.
    pub(crate) const MIN_GEOMETRY_DIM: u16 = 2;
```

Then, at the top of `resize`'s body (:1005, before the lock — first lines of the function):
```rust
        let cols = cols.max(Self::MIN_GEOMETRY_DIM);
        let rows = rows.max(Self::MIN_GEOMETRY_DIM);
```

And identically at the top of `resize_for_attach`'s body (:1046, before the lock):
```rust
        let cols = cols.max(Self::MIN_GEOMETRY_DIM);
        let rows = rows.max(Self::MIN_GEOMETRY_DIM);
```

Placement matters: flooring BEFORE the `s.cols == cols && s.rows == rows` comparison matches Node, where `geometryChanged` compares NORMALIZED values against stored normalized values (`broker.ts:676-678`) — so a floored duplicate (e.g. `(1,1)` after `(0,0)`) is "unchanged" and does not bump the epoch. The floored values also flow to `pty.resize(cols, rows)`, so the PTY can never be driven below 2×2 — matching Node, where sub-2 values can never reach `pty.resize` at all (rejected upstream; see Task 5).

- [ ] **Step 4: Run the crate's tests to verify green, no regressions**

Run:
```bash
cargo test -p freshell-terminal
```
Expected: PASS — the 2 new tests plus the entire existing suite (baseline: green; all 13 existing geometry tests use dims ≥ 30, unaffected by the floor).

- [ ] **Step 5: Lint, format, commit**

```bash
cargo clippy -p freshell-terminal --all-targets -- -D warnings
cargo fmt --all
git add crates/freshell-terminal/src/registry.rs
git commit -m "fix(rust): floor recorded terminal geometry at 2 (Node broker parity)"
```
Expected: clippy exit 0, commit succeeds.

---

### Task 5: WS boundary range rejection (Zod parity) + end-to-end proof

Node's authoritative dimension enforcement is the Zod protocol boundary (`shared/ws-protocol.ts:344-345, 364-365`): `terminal.attach` and `terminal.resize` require `cols ∈ [2, 1000]`, `rows ∈ [2, 500]`; out-of-range frames are **rejected** with an `error{code: INVALID_MESSAGE}` frame and never reach the registry (`ws-handler.ts:1856-1858`). Rust currently accepts any `i64` and squashes it with `clamp(0, u16::MAX)` (`terminal.rs:1781-1782, 1818-1819`), so `0`, `1`, `-50`, and `5000` all drive the PTY. Port the reject-not-clamp boundary. (Rust's `ErrorCode::InvalidMessage` already exists at `crates/freshell-protocol/src/common.rs:76` and serializes as `INVALID_MESSAGE`; `handle_tabs_push` already emits it on a runtime path, so this introduces no new error vocabulary.)

Node parity detail: Node's reject sends `requestId: msg?.requestId` — and neither `terminal.attach` nor `terminal.resize` HAS a `requestId` field (attach has `attachRequestId`, which Node does not copy into the error) — so the Rust error carries `request_id: None`. Exact parity, and simpler.

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` — new consts + `terminal_dims_in_range` + `invalid_dims_error` helpers; guard the `TerminalAttach` dispatch arm (:473-476) and `TerminalResize` dispatch arm (:500-503) inside `handle_client_text` (where `ws_tx` is in scope); new in-file `#[cfg(test)]` mod
- Test (integration): `crates/freshell-ws/tests/attach_viewport_resize.rs` — 2 new `#[tokio::test]`s using the Task 2 harness

**Interfaces:**
- Consumes: from Task 2's `common` module — `spawn_server`, `connect_and_capture_inventory`, `create_shell_terminal`, `attach_with`, `wait_for_attach_ready`, `next_frame_of_type` (signatures in Task 2's Produces block). From the existing codebase — `send(ws_tx, &msg).await` helper (`terminal.rs:75-80`), `ServerMessage::Error(ErrorMsg)` (`server_messages.rs:47-48`, `ErrorMsg` at :491-507), `ErrorCode::InvalidMessage` (`common.rs:76`), `crate::now_iso()`, `TerminalRegistry::geometry()`. Task 4's registry floor sits below this boundary as defense-in-depth (mirroring Node, where the broker floor sits below the Zod boundary and is equally unreachable from the wire).
- Produces: `pub(crate)` consts `MIN_TERMINAL_COLS/MAX_TERMINAL_COLS/MIN_TERMINAL_ROWS/MAX_TERMINAL_ROWS` and `pub(crate) fn terminal_dims_in_range(cols: i64, rows: i64) -> bool` in `freshell-ws`'s `terminal.rs`. No later task consumes them.

- [ ] **Step 1: Write the failing unit tests**

Add a new in-file test module at the end of `crates/freshell-ws/src/terminal.rs`, following the crate's convention of narrow `#[cfg(test)]` mods (model: `mod attach_geometry_tests` at :2794, which unit-tests the pure helper `attach_geometry_identity_ok`):

```rust
#[cfg(test)]
mod terminal_dims_range_tests {
    use super::{invalid_dims_error, terminal_dims_in_range};

    #[test]
    fn rejects_zero_and_one_below_node_floor() {
        assert!(!terminal_dims_in_range(0, 24));
        assert!(!terminal_dims_in_range(80, 0));
        assert!(!terminal_dims_in_range(1, 24));
        assert!(!terminal_dims_in_range(80, 1));
        assert!(!terminal_dims_in_range(0, 0));
    }

    #[test]
    fn rejects_negative_values() {
        assert!(!terminal_dims_in_range(-1, 24));
        assert!(!terminal_dims_in_range(80, -50));
    }

    #[test]
    fn accepts_node_minimums_maximums_and_normal_values() {
        assert!(terminal_dims_in_range(2, 2)); // Zod .min(2)
        assert!(terminal_dims_in_range(80, 24));
        assert!(terminal_dims_in_range(95, 41));
        assert!(terminal_dims_in_range(1000, 500)); // Zod .max(1000)/.max(500)
    }

    #[test]
    fn rejects_values_above_node_ceiling() {
        assert!(!terminal_dims_in_range(1001, 500));
        assert!(!terminal_dims_in_range(1000, 501));
        assert!(!terminal_dims_in_range(i64::MAX, 24));
    }

    #[test]
    fn invalid_dims_error_serializes_as_invalid_message() {
        let value = serde_json::to_value(invalid_dims_error(0, -5)).expect("serialize");
        assert_eq!(value["type"], "error");
        assert_eq!(value["code"], "INVALID_MESSAGE");
    }
}
```

- [ ] **Step 2: Run unit tests to verify they fail (RED)**

Run:
```bash
cargo test -p freshell-ws terminal_dims_range_tests
```
Expected: FAIL to compile — `cannot find function `terminal_dims_in_range``.

- [ ] **Step 3: Implement the validator and error helper (GREEN for unit tests)**

In `crates/freshell-ws/src/terminal.rs`, near the other module-level helpers (e.g. just above `handle_resize` at :1817), add:

```rust
/// Node-parity geometry bounds for `terminal.attach` / `terminal.resize`
/// (`shared/ws-protocol.ts:344-345, 364-365`): `cols` must be an integer in
/// `[2, 1000]` and `rows` in `[2, 500]`. Node enforces this at the Zod
/// boundary by REJECTING the frame with `INVALID_MESSAGE`
/// (`ws-handler.ts:1856-1858`) — reject, not clamp — so out-of-range
/// geometry never reaches the registry or the PTY.
pub(crate) const MIN_TERMINAL_COLS: i64 = 2;
pub(crate) const MAX_TERMINAL_COLS: i64 = 1000;
pub(crate) const MIN_TERMINAL_ROWS: i64 = 2;
pub(crate) const MAX_TERMINAL_ROWS: i64 = 500;

pub(crate) fn terminal_dims_in_range(cols: i64, rows: i64) -> bool {
    (MIN_TERMINAL_COLS..=MAX_TERMINAL_COLS).contains(&cols)
        && (MIN_TERMINAL_ROWS..=MAX_TERMINAL_ROWS).contains(&rows)
}

/// The `INVALID_MESSAGE` error frame for an out-of-range geometry reject.
/// `request_id` is `None` for exact Node parity: Node's Zod reject copies
/// `msg?.requestId` (`ws-handler.ts:1858`) and neither attach nor resize has
/// a `requestId` field.
fn invalid_dims_error(cols: i64, rows: i64) -> ServerMessage {
    ServerMessage::Error(ErrorMsg {
        code: ErrorCode::InvalidMessage,
        message: format!(
            "terminal geometry out of range: cols must be in [2, 1000] and rows in [2, 500] (got cols={cols}, rows={rows})"
        ),
        timestamp: crate::now_iso(),
        actual_session_ref: None,
        expected_session_ref: None,
        request_id: None,
        terminal_exit_code: None,
        terminal_id: None,
    })
}
```

The `ErrorMsg` field list above is from `server_messages.rs:491-507`; mirror the existing construction in `handle_kill` (`terminal.rs:1847-1862`) exactly — the compiler flags any field-name drift; keep every optional field `None`. Add whatever `use` items the file doesn't already import (it already imports `ServerMessage`; `ErrorMsg`/`ErrorCode` are already used by `handle_kill`/`handle_tabs_push` in this same file, so likely nothing new is needed).

Run:
```bash
cargo test -p freshell-ws terminal_dims_range_tests
```
Expected: PASS (5 tests).

- [ ] **Step 4: Write the failing integration tests (RED)**

Append to `crates/freshell-ws/tests/attach_viewport_resize.rs` (after the existing three tests; the harness comes from Task 2's `common`; `WsMessage`, `SinkExt`, and `serde_json` usage mirrors the existing tests/helpers in this binary — copy the exact `ws.send(...)` style used inside `common::attach_with`):

```rust
#[tokio::test]
async fn out_of_range_resize_is_rejected_with_invalid_message() {
    // Node parity: terminal.resize cols/rows outside [2,1000]/[2,500] is
    // rejected at the boundary (ws-protocol.ts:364-365, ws-handler.ts:1856-1858)
    // and never reaches the registry — geometry and PTY stay untouched.
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-dims-resize").await;
    attach_with(&mut ws, &terminal_id, "att-dims-resize", "viewport_hydrate", 95, 41, None).await;
    wait_for_attach_ready(&mut ws, "att-dims-resize").await;
    let before = registry.geometry(&terminal_id);
    assert_eq!(before, Some((95, 41, 1)));

    let frame = serde_json::json!({
        "type": "terminal.resize",
        "terminalId": terminal_id,
        "cols": 0,
        "rows": 0,
    });
    ws.send(WsMessage::Text(frame.to_string())).await.expect("send resize");

    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], "INVALID_MESSAGE");
    assert_eq!(registry.geometry(&terminal_id), before, "geometry must be untouched");
}

#[tokio::test]
async fn out_of_range_attach_geometry_is_rejected_with_invalid_message() {
    // Node parity: terminal.attach with cols=1 fails Zod validation, so the
    // ENTIRE attach is rejected — no attach.ready, no resize, no replay.
    let (url, registry) = spawn_server().await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;
    let terminal_id = create_shell_terminal(&mut ws, "req-dims-attach").await;
    let before = registry.geometry(&terminal_id);

    attach_with(&mut ws, &terminal_id, "att-dims-attach", "viewport_hydrate", 1, 41, None).await;

    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], "INVALID_MESSAGE");
    assert_eq!(registry.geometry(&terminal_id), before, "rejected attach must not resize");
}
```

(If the `WsMessage::Text(...)` construction in `common::attach_with` wraps the string differently — e.g. `.into()` — match it exactly; tokio-tungstenite 0.24's `Text` takes a `String`.)

Run:
```bash
cargo test -p freshell-ws --test attach_viewport_resize
```
Expected: the 3 existing tests PASS; the 2 new tests FAIL (`next_frame_of_type` panics with `no error frame within 20 messages` — no rejection exists yet, and in the first test `registry.geometry` will show the degenerate resize went through).

- [ ] **Step 5: Guard the dispatch arms (GREEN)**

In `handle_client_text` in `crates/freshell-ws/src/terminal.rs` (signature at :407-415 — `ws_tx` is in scope in the match arms), wrap the two existing arms. Keep the existing handler invocations byte-for-byte; only wrap them:

`TerminalResize` arm (:500-503):
```rust
        ClientMessage::TerminalResize(resize) => {
            if terminal_dims_in_range(resize.cols, resize.rows) {
                handle_resize(resize, state);
            } else {
                send(ws_tx, &invalid_dims_error(resize.cols, resize.rows)).await;
            }
        }
```

`TerminalAttach` arm (:473-476) — same shape; the existing invocation is `handle_attach(attach, state, conn_id, conn_sink, terminal_output_batch_v1)` (handler signature at :1757-1763) — preserve it and its arguments byte-for-byte as they appear in the current arm (including any `.await`):
```rust
        ClientMessage::TerminalAttach(attach) => {
            if terminal_dims_in_range(attach.cols, attach.rows) {
                handle_attach(attach, state, conn_id, conn_sink, terminal_output_batch_v1).await;
            } else {
                send(ws_tx, &invalid_dims_error(attach.cols, attach.rows)).await;
            }
        }
```

Guarding at the dispatch arm (before any handler logic, terminal lookup, or identity check) matches Node, where Zod validation precedes all message handling. Leave the existing `clamp(0, u16::MAX as i64) as u16` casts at :1781-1782 and :1818-1819 in place — post-validation they only ever see in-range values, and they remain the overflow-safe `i64 → u16` conversion (values are now guaranteed `≤ 1000`, so the cast is lossless).

Run:
```bash
cargo test -p freshell-ws --test attach_viewport_resize
```
Expected: PASS — all 5 tests (3 existing + 2 new).

- [ ] **Step 6: Run the full freshell-ws suite — no new failures**

Run:
```bash
cargo test -p freshell-ws 2>&1 | tail -40
```
Expected: only the 2 known baseline failures (`codex_session_ref_resume` tsx dependency; `session_identity_frames::fresh_claude_create_frames_carry_preallocated_session_ref` timeout). Everything else PASSES. In particular `term09_output_queue` must stay green — its `attach` helper hardcodes `cols: 80, rows: 24`, which is in-range.

- [ ] **Step 7: Lint, format, commit**

```bash
cargo clippy -p freshell-ws --all-targets -- -D warnings
cargo fmt --all
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/attach_viewport_resize.rs
git commit -m "fix(rust): reject out-of-range terminal.attach/resize geometry with INVALID_MESSAGE (Node Zod parity)"
```
Expected: clippy exit 0, commit succeeds.

---

### Task 6: Final validation sweep

Prove all three acceptance criteria on the finished branch. No code changes expected; if anything fails, fix it within this task (smallest change that restores the gate) and commit the fix with an appropriate `fix(rust):`/`style(rust):` message.

**Files:**
- Modify: none expected (verification only).

**Interfaces:**
- Consumes: all prior tasks' commits.
- Produces: a verified branch ready for the review stage.

- [ ] **Step 1: Acceptance 1 — clippy zero errors in freshell-platform (and everywhere touched)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/attach-viewport-followups
cargo clippy -p freshell-platform -p freshell-terminal -p freshell-ws --all-targets -- -D warnings
```
Expected: exit 0, zero warnings.

- [ ] **Step 2: Acceptance 2 — dimension-floor parity tests pass**

Run:
```bash
cargo test -p freshell-terminal resize_floors_dimensions_at_two_node_broker_parity resize_for_attach_floors_dimensions_at_two_node_broker_parity
cargo test -p freshell-platform spawn_dims_tests
cargo test -p freshell-ws terminal_dims_range_tests
cargo test -p freshell-ws --test attach_viewport_resize
```
Expected: all PASS (2 + 4 + 5 unit tests, 5 integration tests).

- [ ] **Step 3: Acceptance 3 — harness dedup with no new failures across the full Rust suite**

Run:
```bash
test -f crates/freshell-ws/tests/common/mod.rs && echo "common exists"
grep -c "async fn spawn_server" crates/freshell-ws/tests/attach_viewport_resize.rs crates/freshell-ws/tests/session_identity_frames.rs crates/freshell-ws/tests/common/mod.rs
cargo test -p freshell-platform
cargo test -p freshell-terminal
cargo test -p freshell-ws 2>&1 | tail -40
```
Expected: `common exists`; `spawn_server` count is `0` in both migrated test files and `1` in `common/mod.rs`; platform and terminal suites fully green; freshell-ws shows ONLY the 2 known baseline failures from Global Constraints.

- [ ] **Step 4: Formatting and working-tree hygiene**

Run:
```bash
cargo fmt --all --check
git status --short
git log --oneline 55f58545..HEAD
```
Expected: fmt check clean; working tree clean (no uncommitted changes, no stray files); the log shows this plan's commits (plan doc + Tasks 1–5, plus any Task 6 fixes).

---

## Self-Review (performed at planning time)

1. **Spec coverage:** Follow-up 1 → Task 1 (all 7 baseline warnings, exceeding the recorded "6" because `--all-targets` surfaces one more in the lib-test target — eliminating them entirely, as required). Follow-up 2 → Tasks 3+4+5 (the investigation found Node's floor is enforced at three layers — spawn falsy-coalesce, broker bookkeeping floor, Zod boundary reject — and each is ported to its exact Rust equivalent with boundary-value tests at 0, 1, 2, normal, and ceiling values; nothing invented). Follow-up 3 → Task 2 (single shared harness, both files migrated; donor is a clean win — 175 byte-identical lines). Acceptance 1/2/3 → Task 6 Steps 1/2/3.
2. **No silent deferrals:** the two out-of-scope items (broader test-file migration; `not_running` guard) are explicitly recorded in Global Constraints and are not spec requirements — the spec bounds migration to "the new attach-viewport tests, plus the donor file", both covered. No stubs, mocks, or fake seams anywhere: integration tests run a real WS server and real shell PTYs.
3. **Type consistency:** `terminal_dims_in_range(cols: i64, rows: i64)` matches the wire types (`TerminalResize`/`TerminalAttach` use `i64`, `client_messages.rs:239-240, 271-272`); registry floor operates on `u16` post-cast; `dim_or_default(Option<u16>, u16) -> u16` matches the three builders' parameters; `geometry() -> Option<(u16, u16, i64)>` assertions use that exact tuple shape; Task 5's integration tests consume exactly the signatures Task 2's Produces block declares.
