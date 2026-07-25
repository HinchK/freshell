# Pane-Identity Ledger (P1.8) + Opencode Locator Re-Arm (P1.10) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Build the server-side pane-identity ledger — a durable per-row disk store under `~/.freshell/pane-ledger/` written synchronously at identity events — wire it into all terminal-pane identity write triggers (claude pre-allocation, codex candidate adoption, opencode/amplifier locator resolution, pending markers at spawn, best-effort retire), and ship the three reads in the same slice (inventory sessionRef stamping, ledger-backed `ever_observed`, the claude restore-resolution ladder), plus P1.10: pin opencode locator arming for restore-created panes that lack identity.

**Architecture:** A new `pane_ledger` module in `crates/freshell-ws` holding two row types with different keys and different rights: **binding rows** keyed on server-minted `sessionRef` (provider, sessionId) with `terminalId` as a secondary index, and **pending markers** keyed on `terminalId` that are NEVER promoted or joined — resolution writes a fresh binding row FIRST, then deletes the marker (pinned order). Each row is its own JSON file written via the existing `atomic_write_durable` (temp+rename+fsync). A boot scan quarantines corrupt rows per-row (never per-store), sweeps stale markers, repairs the supersession crash window, and GCs bound rows to tombstones (never deletion; tombstone deletion is conditioned on transcript absence). The ledger is constructed once in `freshell-server::main`, hangs off `WsState` as an `Arc`, and is consulted by three reads that ship in this slice.

**Tech Stack:** Rust (serde/serde_json, tokio, tracing), existing `freshell-ws` test harness (`tests/common/mod.rs`, real axum server on ephemeral loopback ports), Playwright e2e (`RustServer` fixture, fake CLIs).

## Global Constraints

- **Worktree:** all work happens in `/home/dan/code/freshell/.worktrees/pane-identity-ledger`, branch `feat/pane-identity-ledger`, based on `origin/main @ c491aee0`.
- **The spec** is §4.2 of `/home/dan/code/freshell/docs/plans/2026-07-24-restart-resilience-architecture-analysis.md` (UNTRACKED — read via that absolute path; **never commit that file**). Every pinned rule there is a requirement.
- **TDD:** Red-Green-Refactor for every task; never skip the failing-test run, never skip the refactor pass.
- **Store location:** `~/.freshell/pane-ledger/` (user-approved), resolved via `resolve_home()` precedence (`FRESHELL_HOME` → `HOME`) ONCE in `main.rs` and dependency-injected as a path — the module itself never reads env vars.
- **Scope: TERMINAL panes only.** Fresh-agent ledger wiring is a later slice (P1.13). The resume-invocation record for a terminal pane is `{provider, sessionId, mode, cwd}` — everything `resolve_coding_cli_command` needs to re-issue the resume. Extended settings fields (model/sandbox/permissionMode/effort) are fresh-agent resume parameters and land with P1.13 per the campaign roadmap (spec §5 items 8 vs 13) — not stored dormant here (Principle 6).
- **Scope fence — do NOT touch:** freshagent crates' `claude.rs`/`snapshot.rs` (Lane A2), `tabs_persist*`/`tabs_snapshots*`/persistMiddleware (A1/A6 — *calling* the already-`pub` `atomic_write_durable` is fine; do not edit it), `TerminalView`/`FreshAgentView` (A4), `registry.rs` scrollback (A5), `reconcile.rs` verdict-derivation logic (only the `ever_observed` INPUT changes, indirectly, via the probe impl in `freshell-server`). Lane A2 also touches `terminal.rs` (FreshAgentAttach arm) — keep all `terminal.rs` edits confined to the create/identity path (`handle_create` tail, exit/kill hooks, the restore ladder helpers). No kimi/gemini work.
- **Full-verdict wiring is Phase 3:** quarantine-in-verdict (`ledger_quarantined` breadcrumb) and superseded-claim `corrected:true` verdicts are exposed **at the ledger API level** here (chain-terminus lookup, quarantine query, loud ERROR logs); reconcile-verdict plumbing lands with the Phase 3 lane that owns verdict derivation. The frozen client does not yet render `durability.degraded`; the load-bearing pinned property shipped here is that the warning frame is pushed LIVE at failure time (wire-asserted by test), never posthumously.
- **Tests:** `cargo test` and Playwright are NOT coordinator-gated. `npm test`/`npm run check` ARE — set `FRESHELL_TEST_SUMMARY`, check `npm run test:status` first, WAIT if a sibling holds the gate (5 sibling lanes run concurrently).
- **Ports:** never bind or touch 3001/3002. Rust integration tests bind `127.0.0.1:0`; e2e uses `RustServer`'s `findFreePort()`.
- **Process safety:** NEVER restart the user's self-hosted server; never broad kill patterns; record PIDs. Disk is ~36 GB free — on ENOSPC, HALT and report rather than deleting anything outside this worktree.
- **CI gates:** `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are enforced by CI; every task's code must be fmt- and clippy-clean. Rust tests are NOT in CI — local `cargo test` is the only test gate.
- **Structural limits:** ≤1K lines per file (hence `pane_ledger_tests.rs` as a `#[path]` submodule, mirroring `tabs_persist_tests.rs`).
- **PR policy: NOT approved.** Commit locally per task, push the branch at the end, **STOP before `gh pr create`**.
- **Commits:** Conventional Commits with scope (observed convention), one focused commit per task.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/pane_ledger.rs` | Create | The ledger: row types, key encoding, atomic per-row writes, reader rules (chain-terminus, marker-vs-binding), boot scan / GC, write-failure surfacing helpers |
| `crates/freshell-ws/src/pane_ledger_tests.rs` | Create | Unit tests for the ledger (kept out of the main file for the ≤1K-lines limit, `#[path]` submodule like `tabs_persist_tests.rs`) |
| `crates/freshell-ws/src/lib.rs` | Modify | `pub mod pane_ledger;` registration; `WsState.pane_ledger` field; inventory-stamping ledger fallback (~:398-403) |
| `crates/freshell-ws/src/invariants.rs` | Modify | `error_pane_ledger_write_failed` structured ERROR emitter |
| `crates/freshell-protocol/src/server_messages.rs` | Modify | `durability.degraded` server message (live write-failure warning frame) |
| `crates/freshell-ws/src/terminal.rs` | Modify | Create-path write triggers (binding at create, pending marker at spawn), exit/kill ledger hygiene, ledger rung in `resolve_claude_restore_session_id` |
| `crates/freshell-ws/src/codex_candidate.rs` | Modify | Ledger resolution at candidate adoption (`:206-220` bind block) |
| `crates/freshell-ws/src/opencode_association.rs` | Modify | Ledger resolution at locator resolve (`:135-154` bind block); P1.10 restore-re-arm pinning tests |
| `crates/freshell-ws/src/amplifier_association.rs` | Modify | Same ledger resolution hook (trigger (d) coherence: every identity-bearing terminal pane's marker must have a resolver) |
| `crates/freshell-server/src/existence.rs` | Modify | `IndexExistenceProbe` gains a ledger handle; `ever_observed` becomes ledger-backed |
| `crates/freshell-server/src/main.rs` | Modify | Construct `PaneLedger`, run `boot_scan`, spawn periodic GC, pass ledger to the probe and `WsState` |
| `crates/freshell-ws/tests/common/mod.rs` | Modify | `spawn_server_with_ledger` harness variant |
| `crates/freshell-ws/tests/pane_ledger_triggers.rs` | Create | Integration tests: write triggers over real WS + restart-equivalent (second ledger instance on the same dir) |
| `crates/freshell-ws/tests/pane_ledger_restore.rs` | Create | Two-generation integration tests: claude ladder ledger rung, inventory stamping fallback |
| `test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts` | Create | E2E: SIGKILL-within-seconds durability; SIGKILL-inside-locator-window marker survival |
| `test/e2e-browser/playwright.config.ts` | Modify | Register the new spec in BOTH `RUST_ONLY_SPECS` and `rust-chromium`'s `testMatch` |
| Various `WsState { … }` literals (tests) | Modify | Add the new `pane_ledger` field (compiler-driven, Task 5) |

**Red tests named by the spec → where they land:**

| Red test | Task |
|---|---|
| `rebind-retires-old-row` | 2 |
| `client-claims-superseded-ref` (ledger-API chain-terminus) | 2 |
| `pending-resolution-collision` | 3 |
| `SIGKILL-inside-locator-window` (marker durability + boot preservation) | 3 (unit), 9 (integration), 13 (e2e) |
| `crash-between-binding-write-and-marker-delete` | 4 |
| `crash-mid-supersession-two-bound-rows` | 4 |
| `corrupt-ledger-boot` | 4 |
| `SIGKILL-within-5s-of-pane-creation` | 6 (restart-equivalent), 13 (e2e) |
| `ledger-write-failure-surfaces-live` | 7 |
| transcript-deleted-while-down → loud `dead_session` | 11 |

---

### Task 1: Ledger core — schema, atomic binding-row writes, basic reads

**Files:**
- Create: `crates/freshell-ws/src/pane_ledger.rs`
- Create: `crates/freshell-ws/src/pane_ledger_tests.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (mod registration only — the `pub mod` block at `lib.rs:23-39`, alphabetical order)

**Interfaces:**
- Consumes: `freshell_protocol::SessionLocator` (`crates/freshell-protocol/src/common.rs:174-177`, `{provider: String, session_id: String}`, serde camelCase); `crate::tabs_persist::atomic_write_durable(destination: &Path, temporary: &Path, bytes: &[u8]) -> std::io::Result<()>` (already `pub`, `tabs_persist.rs:706-732`).
- Produces (later tasks rely on these exact signatures):
  - `pub const LEDGER_VERSION: u32 = 1;`
  - `pub struct BindingRow { pub ledger_version: u32, pub provider: String, pub session_id: String, pub mode: String, pub cwd: Option<String>, pub live_terminal_id: Option<String>, pub create_request_id: Option<String>, pub created_at: i64, pub updated_at: i64, pub last_observed_at: i64, pub state: RowState, pub retired_reason: Option<RetiredReason>, pub superseded_by: Option<SessionLocator> }`
  - `pub enum RowState { Bound, Retired }`, `pub enum RetiredReason { Superseded, Closed, GcExpired }`
  - `pub struct BindingWrite<'a> { pub provider: &'a str, pub session_id: &'a str, pub terminal_id: &'a str, pub mode: &'a str, pub cwd: Option<&'a str>, pub create_request_id: Option<&'a str>, pub now_ms: i64 }`
  - `pub struct PaneLedger` with `pub fn new(root: Option<PathBuf>) -> Self`, `pub fn disabled() -> Self`, `pub fn record_binding(&self, w: &BindingWrite<'_>) -> std::io::Result<()>`, `pub fn load_binding(&self, provider: &str, session_id: &str) -> Option<BindingRow>`, `pub fn ever_bound(&self, provider: &str, session_id: &str) -> bool`, `pub fn list_bindings(&self) -> Vec<BindingRow>`, `pub fn bound_session_ref_for_terminal(&self, terminal_id: &str) -> Option<SessionLocator>`, `pub fn lookup_by_create_request_id(&self, provider: &str, create_request_id: &str) -> Option<BindingRow>`

- [ ] **Step 0: Baseline green.** Run: `cargo test -p freshell-ws` (from the worktree root; generous timeout — real PTY spawns). Expected: PASS. If the base suite is red, STOP and report — do not build on a red base.

- [ ] **Step 1: Write the failing tests.** Create `crates/freshell-ws/src/pane_ledger_tests.rs`:

```rust
//! Unit tests for `crate::pane_ledger` (P1.8, spec §4.2). Kept in a sibling
//! file (the `tabs_persist_tests.rs` convention) to respect the ≤1K-lines
//! file limit as the ledger's test surface grows.

use super::*;
use std::path::PathBuf;

fn temp_root(label: &str) -> PathBuf {
    // Same atomic-counter + pid pattern as `opencode_association.rs`'s
    // `unique_temp_dir` — no tempfile dependency needed for a dir we
    // remove ourselves.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-test-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp root");
    dir
}

fn write(provider: &str, session_id: &str, terminal_id: &str, now_ms: i64) -> BindingWrite<'static> {
    // Leak the strings for test brevity — tests are short-lived.
    BindingWrite {
        provider: Box::leak(provider.to_string().into_boxed_str()),
        session_id: Box::leak(session_id.to_string().into_boxed_str()),
        terminal_id: Box::leak(terminal_id.to_string().into_boxed_str()),
        mode: Box::leak(provider.to_string().into_boxed_str()),
        cwd: Some("/tmp/proj"),
        create_request_id: Some("req-1"),
        now_ms,
    }
}

#[test]
fn record_binding_roundtrips_all_fields() {
    let root = temp_root("roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .expect("write ok");
    let row = ledger.load_binding("claude", "sess-a").expect("row exists");
    assert_eq!(row.ledger_version, LEDGER_VERSION);
    assert_eq!(row.provider, "claude");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(row.mode, "claude");
    assert_eq!(row.cwd.as_deref(), Some("/tmp/proj"));
    assert_eq!(row.live_terminal_id.as_deref(), Some("t1"));
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 1_000);
    assert_eq!(row.last_observed_at, 1_000);
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    assert_eq!(row.superseded_by, None);
    assert!(ledger.ever_bound("claude", "sess-a"));
    assert!(!ledger.ever_bound("claude", "sess-other"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rewrite_preserves_created_at_and_bumps_updated_at() {
    let root = temp_root("rewrite");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("codex", "th-1", "t1", 1_000)).unwrap();
    ledger.record_binding(&write("codex", "th-1", "t1", 5_000)).unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 5_000);
    assert_eq!(row.last_observed_at, 5_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn disabled_ledger_is_a_silent_noop() {
    let ledger = PaneLedger::disabled();
    ledger.record_binding(&write("claude", "s", "t", 1)).expect("noop ok");
    assert_eq!(ledger.load_binding("claude", "s"), None);
    assert!(!ledger.ever_bound("claude", "s"));
    assert!(ledger.list_bindings().is_empty());
}

#[test]
fn writes_are_atomic_sibling_temp_plus_rename() {
    // After a successful write no *.tmp-* residue remains, and the row file
    // is a direct child of bindings/<provider>/.
    let root = temp_root("atomic");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("claude", "sess-a", "t1", 1_000)).unwrap();
    let provider_dir = root.join("bindings").join("claude");
    let entries: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["sess-a.json".to_string()]);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn key_encoding_is_path_safe_and_injective() {
    assert_eq!(encode_segment("claude"), "claude");
    assert_eq!(
        encode_segment("11111111-2222-3333-4444-555555555555"),
        "11111111-2222-3333-4444-555555555555"
    );
    assert_eq!(encode_segment("a/b"), "a%2Fb");
    assert_eq!(encode_segment("a%b"), "a%25b");
    assert_eq!(encode_segment(".."), "%2E%2E");
    assert_eq!(encode_segment("."), "%2E");
    assert_eq!(encode_segment(""), "%00");
    // Injective: distinct inputs never collide after encoding.
    assert_ne!(encode_segment("a/b"), encode_segment("a%2Fb"));
}

#[test]
fn secondary_index_reads_by_terminal_and_request_id() {
    let root = temp_root("secondary");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("claude", "sess-a", "t1", 1_000)).unwrap();
    ledger.record_binding(&write("codex", "th-9", "t2", 2_000)).unwrap();
    let sref = ledger.bound_session_ref_for_terminal("t1").expect("t1 bound");
    assert_eq!(sref.provider, "claude");
    assert_eq!(sref.session_id, "sess-a");
    assert_eq!(ledger.bound_session_ref_for_terminal("t-missing"), None);
    let row = ledger
        .lookup_by_create_request_id("claude", "req-1")
        .expect("by request id");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(ledger.lookup_by_create_request_id("claude", "req-none"), None);
    std::fs::remove_dir_all(&root).ok();
}
```

- [ ] **Step 2: Run to verify failure.** Run: `cargo test -p freshell-ws pane_ledger`
Expected: FAIL to compile — `pane_ledger` module does not exist (`unresolved import` / `file not found for module`). A compile failure of the new tests IS the red state.

- [ ] **Step 3: Write the implementation.** Create `crates/freshell-ws/src/pane_ledger.rs`:

```rust
//! P1.8 — the server-side pane-identity ledger (restart-resilience campaign
//! §4.2): a small per-row disk store under `<home>/.freshell/pane-ledger/`,
//! written synchronously at identity events with atomic temp+rename
//! (`crate::tabs_persist::atomic_write_durable`).
//!
//! Two row types with different keys and different rights:
//!
//! * **Binding rows** — durable identity facts, keyed on the server-minted
//!   `sessionRef` (provider, sessionId), with `terminalId` as a secondary
//!   index. A binding row is *the resume-invocation record*: it stores
//!   exactly what re-issuing the provider's resume needs (for terminal panes:
//!   provider, sessionId, mode, cwd). Layout:
//!   `bindings/<enc(provider)>/<enc(sessionId)>.json`.
//! * **Pending markers** — evidence that identity establishment was in
//!   flight, keyed on `terminalId` (the only stable server-minted id that
//!   exists pre-identity). NEVER promoted, never joined (G1): resolution
//!   writes a fresh binding row FIRST, then deletes the marker. Layout:
//!   `pending/<enc(terminalId)>.json`.
//!
//! Deliberately NOT stored: scrollback (own store, P2.19), transcripts
//! (provider-owned), layout (client-owned). NOT keyed on `createRequestId`
//! (re-minted on every hydrate today, D4) — stored only as an advisory field.
//!
//! Corruption policy: fail loud PER-ROW, never per-store — an unparsable row
//! is quarantined (renamed aside + logged), never silently dropped, and never
//! causes healthy rows to be skipped.
//!
//! Write-failure policy: a ledger write failure never blocks the
//! create/identity event, but it is never silent — see
//! [`surface_write_failure`].

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use freshell_protocol::SessionLocator;
use serde::{Deserialize, Serialize};

/// Gates schema migration (spec §4.2): rows with a different version are
/// quarantined loudly at boot, never silently reinterpreted.
pub const LEDGER_VERSION: u32 = 1;

/// Bound rows not observed within this TTL are expired TO TOMBSTONES
/// (`retired/gc_expired`), never deleted (spec §4.2 lifecycle).
pub const BOUND_GC_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Tombstones older than this are deleted ONLY once the transcript no longer
/// exists on disk — silent-fresh never returns by timer while the
/// conversation is still recoverable.
pub const TOMBSTONE_GC_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowState {
    Bound,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetiredReason {
    Superseded,
    Closed,
    GcExpired,
}

/// A durable identity fact — see the module doc for the schema contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRow {
    pub ledger_version: u32,
    pub provider: String,
    pub session_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Advisory secondary index — the terminal that last owned this identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_terminal_id: Option<String>,
    /// Advisory, latest-observed (D4: the client re-mints it on hydrate; it
    /// is never an identity join key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_observed_at: i64,
    pub state: RowState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<RetiredReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<SessionLocator>,
}

/// Evidence that identity establishment was in flight (G1: never a binding).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMarker {
    pub ledger_version: u32,
    pub terminal_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub spawned_at: i64,
}

/// One identity event's worth of binding-row input.
pub struct BindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub terminal_id: &'a str,
    pub mode: &'a str,
    pub cwd: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub now_ms: i64,
}

/// A row the boot scan renamed aside because it could not be parsed.
#[derive(Debug, Clone)]
pub struct QuarantinedRow {
    pub original_path: PathBuf,
    pub quarantined_path: PathBuf,
    pub error: String,
}

/// The ledger store. `root: None` ⇒ feature disabled (no resolvable home) —
/// every write is an `Ok(())` no-op and every read answers empty, mirroring
/// the tabs-snapshots `Option`-wrapped-root precedent (`main.rs:709-711`).
pub struct PaneLedger {
    root: Option<PathBuf>,
    /// Serializes read-modify-write cycles (supersession lookup + write).
    lock: Mutex<()>,
    /// Rows quarantined by the boot scan, retained for API surfacing.
    quarantined: RwLock<Vec<QuarantinedRow>>,
}

impl PaneLedger {
    pub fn new(root: Option<PathBuf>) -> Self {
        Self {
            root,
            lock: Mutex::new(()),
            quarantined: RwLock::new(Vec::new()),
        }
    }

    /// A ledger that stores nothing — the test/default construction.
    pub fn disabled() -> Self {
        Self::new(None)
    }

    fn bindings_dir(root: &Path) -> PathBuf {
        root.join("bindings")
    }

    fn pending_dir(root: &Path) -> PathBuf {
        root.join("pending")
    }

    fn binding_path(root: &Path, provider: &str, session_id: &str) -> PathBuf {
        Self::bindings_dir(root)
            .join(encode_segment(provider))
            .join(format!("{}.json", encode_segment(session_id)))
    }

    /// Poison-tolerant lock (the `with_persist_lock` idiom).
    fn guard(&self) -> std::sync::MutexGuard<'_, ()> {
        self.lock.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Record (or refresh) a `bound` row for this identity event.
    pub fn record_binding(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let _guard = self.guard();
        self.record_binding_locked(root, w)
    }

    fn record_binding_locked(&self, root: &Path, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let existing = self.load_binding_at(root, w.provider, w.session_id);
        let created_at = existing.as_ref().map(|r| r.created_at).unwrap_or(w.now_ms);
        if existing
            .as_ref()
            .is_some_and(|r| r.retired_reason == Some(RetiredReason::GcExpired))
        {
            // `retired/gc_expired -> bound` is a LEGAL transition, taken
            // automatically and loudly logged (spec §4.2 lifecycle).
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                provider = %w.provider,
                session_id = %w.session_id,
                "pane_ledger_revived: gc_expired tombstone re-bound by a live identity event"
            );
        }
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            mode: w.mode.to_string(),
            cwd: w.cwd.map(str::to_string),
            live_terminal_id: Some(w.terminal_id.to_string()),
            create_request_id: w.create_request_id.map(str::to_string),
            created_at,
            updated_at: w.now_ms,
            last_observed_at: w.now_ms,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
        };
        self.write_binding(root, &row)
    }

    fn write_binding(&self, root: &Path, row: &BindingRow) -> std::io::Result<()> {
        let dest = Self::binding_path(root, &row.provider, &row.session_id);
        write_row_atomic(&dest, row)
    }

    /// Raw single-row read (no chain following — that is `lookup_by_session`,
    /// Task 2). Steady-state parse failures are skipped with a WARN; the boot
    /// scan is what quarantines.
    pub fn load_binding(&self, provider: &str, session_id: &str) -> Option<BindingRow> {
        let root = self.root.as_ref()?;
        self.load_binding_at(root, provider, session_id)
    }

    fn load_binding_at(&self, root: &Path, provider: &str, session_id: &str) -> Option<BindingRow> {
        let path = Self::binding_path(root, provider, session_id);
        load_row::<BindingRow>(&path)
            .map_err(|err| {
                if !matches!(err, RowLoadError::Missing) {
                    tracing::warn!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        error = %err,
                        "pane_ledger_row_unreadable: skipping row (boot scan quarantines)"
                    );
                }
            })
            .ok()
            .filter(|row: &BindingRow| row.ledger_version == LEDGER_VERSION)
    }

    /// Whether this server has EVER durably bound this identity — bound or
    /// retired, tombstones included. This is the ledger-backed
    /// `ever_observed` input (spec §4.2 reads).
    pub fn ever_bound(&self, provider: &str, session_id: &str) -> bool {
        let Some(root) = &self.root else {
            return false;
        };
        Self::binding_path(root, provider, session_id).is_file()
    }

    /// All parseable binding rows (bound AND retired).
    pub fn list_bindings(&self) -> Vec<BindingRow> {
        let Some(root) = &self.root else {
            return Vec::new();
        };
        self.list_bindings_at(root)
    }

    fn list_bindings_at(&self, root: &Path) -> Vec<BindingRow> {
        let mut out = Vec::new();
        let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) else {
            return out;
        };
        for provider in providers.flatten() {
            let Ok(files) = std::fs::read_dir(provider.path()) else {
                continue;
            };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue; // *.tmp-* and *.quarantined-* residue
                }
                if let Ok(row) = load_row::<BindingRow>(&path) {
                    if row.ledger_version == LEDGER_VERSION {
                        out.push(row);
                    }
                }
            }
        }
        out
    }

    /// Secondary-index read: the newest BOUND row owned by this terminal.
    pub fn bound_session_ref_for_terminal(&self, terminal_id: &str) -> Option<SessionLocator> {
        self.list_bindings()
            .into_iter()
            .filter(|r| {
                r.state == RowState::Bound && r.live_terminal_id.as_deref() == Some(terminal_id)
            })
            .max_by_key(|r| r.updated_at)
            .map(|r| SessionLocator {
                provider: r.provider,
                session_id: r.session_id,
            })
    }

    /// Advisory-index read for the claude restore ladder: the newest row for
    /// this provider whose latest-observed `createRequestId` matches.
    /// Includes `gc_expired` tombstones (auto-resume is a legal transition);
    /// excludes `closed`/`superseded` rows (retired rows are never used to
    /// answer a restore — reader rule, spec §4.2).
    pub fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<BindingRow> {
        self.list_bindings()
            .into_iter()
            .filter(|r| {
                r.provider == provider
                    && r.create_request_id.as_deref() == Some(create_request_id)
                    && (r.state == RowState::Bound
                        || r.retired_reason == Some(RetiredReason::GcExpired))
            })
            .max_by_key(|r| r.updated_at)
    }
}

/// Path-segment encoding: `[A-Za-z0-9._-]` pass through, everything else
/// (including `%`) becomes `%XX` uppercase hex. Injective and containment-
/// safe (no `/`, and the `.`/`..` specials are fully escaped).
pub(crate) fn encode_segment(raw: &str) -> String {
    if raw.is_empty() {
        return "%00".to_string();
    }
    if raw == "." {
        return "%2E".to_string();
    }
    if raw == ".." {
        return "%2E%2E".to_string();
    }
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b'-' => out.push(b as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[derive(Debug)]
pub(crate) enum RowLoadError {
    Missing,
    Io(std::io::Error),
    Parse(String),
}

impl std::fmt::Display for RowLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RowLoadError::Missing => write!(f, "missing"),
            RowLoadError::Io(e) => write!(f, "io: {e}"),
            RowLoadError::Parse(e) => write!(f, "parse: {e}"),
        }
    }
}

pub(crate) fn load_row<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, RowLoadError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RowLoadError::Missing),
        Err(e) => return Err(RowLoadError::Io(e)),
    };
    serde_json::from_slice(&bytes).map_err(|e| RowLoadError::Parse(e.to_string()))
}

/// One row, atomically: sibling temp (PID+millis unique, the `instance_id.rs`
/// idiom) + `atomic_write_durable` (write, fsync, rename, fsync parent).
pub(crate) fn write_row_atomic<T: Serialize>(dest: &Path, row: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(row)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file_name = dest
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "row has no file name"))?;
    let parent = dest
        .parent()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "row has no parent"))?;
    std::fs::create_dir_all(parent)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = parent.join(format!("{file_name}.tmp-{}-{millis}", std::process::id()));
    crate::tabs_persist::atomic_write_durable(dest, &tmp, &bytes)
}

#[cfg(test)]
#[path = "pane_ledger_tests.rs"]
mod tests;
```

Then register the module in `crates/freshell-ws/src/lib.rs` — in the alphabetical `pub mod` block (between `pub mod origin;` and `pub mod reconcile;`):

```rust
pub mod pane_ledger;
```

- [ ] **Step 4: Run to verify pass.** Run: `cargo test -p freshell-ws pane_ledger`
Expected: PASS (6 tests).

- [ ] **Step 5: Refactor + gates.** Re-read the new module for duplication and naming; run `cargo fmt --all` and `cargo clippy -p freshell-ws --all-targets -- -D warnings`. Fix everything.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): pane-identity ledger core - binding rows, atomic per-row writes, basic reads (P1.8)"
```

---

### Task 2: Supersession — retire-never-defend, chain-terminus reader

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs`
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs`

**Interfaces:**
- Consumes: Task 1's `PaneLedger`, `BindingRow`, `RowState`, `RetiredReason`.
- Produces:
  - `pub struct Resolution { pub row: BindingRow, pub corrected: bool }`
  - `pub fn lookup_by_session(&self, provider: &str, session_id: &str) -> Option<Resolution>` — follows the `supersededBy` chain to its terminus; `corrected == true` iff at least one hop was taken.
  - `record_binding` now performs supersession: when the same `terminalId` already owns a DIFFERENT bound identity, the new `bound` row is written FIRST, then the old row is retired (`superseded`, `supersededBy` set) — pinned order (spec §4.2 G3).

- [ ] **Step 1: Write the failing tests.** Append to `crates/freshell-ws/src/pane_ledger_tests.rs`:

```rust
#[test]
fn rebind_retires_old_row() {
    // Red test `rebind-retires-old-row` (spec §4.2 G3): a pane's binding
    // legitimately moves -> the writer retires the old row and writes the
    // new one; the old row records WHERE identity went.
    let root = temp_root("rebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("codex", "th-old", "t1", 1_000)).unwrap();
    ledger.record_binding(&write("codex", "th-new", "t1", 2_000)).unwrap();

    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    let by = old.superseded_by.expect("supersededBy set");
    assert_eq!(by.provider, "codex");
    assert_eq!(by.session_id, "th-new");

    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    assert_eq!(new.live_terminal_id.as_deref(), Some("t1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn client_claims_superseded_ref_is_answered_from_the_chain_terminus() {
    // Red test `client-claims-superseded-ref` (ledger-API level; full
    // verdict wiring is Phase 3): a lookup for a superseded ref follows
    // `supersededBy` to the live bound row and reports corrected:true —
    // never returns the retired row as the answer.
    let root = temp_root("chain");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("codex", "th-1", "t1", 1_000)).unwrap();
    ledger.record_binding(&write("codex", "th-2", "t1", 2_000)).unwrap();
    ledger.record_binding(&write("codex", "th-3", "t1", 3_000)).unwrap();

    let hit = ledger.lookup_by_session("codex", "th-1").expect("resolves");
    assert!(hit.corrected);
    assert_eq!(hit.row.session_id, "th-3");
    assert_eq!(hit.row.state, RowState::Bound);

    // A direct claim of the live terminus is NOT a correction.
    let direct = ledger.lookup_by_session("codex", "th-3").unwrap();
    assert!(!direct.corrected);

    // A retired row with no successor (e.g. closed) is returned as-is so
    // callers can apply their own reader rule — but never invents a bound.
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_to_the_same_identity_is_not_a_supersession() {
    let root = temp_root("samebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("codex", "th-1", "t1", 1_000)).unwrap();
    ledger.record_binding(&write("codex", "th-1", "t1", 2_000)).unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}
```

- [ ] **Step 2: Run to verify failure.** Run: `cargo test -p freshell-ws pane_ledger`
Expected: FAIL — `lookup_by_session` does not exist (compile error), and after adding stubs, `rebind_retires_old_row` fails (old row still `Bound`).

- [ ] **Step 3: Implement.** In `crates/freshell-ws/src/pane_ledger.rs`:

Add the `Resolution` type after `QuarantinedRow`:

```rust
/// A chain-terminus lookup result. `corrected == true` means the caller's
/// claimed ref was superseded and this row is the live successor.
#[derive(Debug, Clone)]
pub struct Resolution {
    pub row: BindingRow,
    pub corrected: bool,
}
```

Extend `record_binding_locked` — replace its body's opening with supersession detection (final body):

```rust
    fn record_binding_locked(&self, root: &Path, w: &BindingWrite<'_>) -> std::io::Result<()> {
        // Supersession (G3, retire-never-defend): if this terminal already
        // owns a DIFFERENT bound identity, the order is pinned — write the
        // new `bound` row FIRST, then retire the old. A crash between the
        // two leaves two bound rows; the boot-scan repair (Task 4) closes
        // that window.
        let previous = self
            .list_bindings_at(root)
            .into_iter()
            .find(|r| {
                r.state == RowState::Bound
                    && r.live_terminal_id.as_deref() == Some(w.terminal_id)
                    && (r.provider != w.provider || r.session_id != w.session_id)
            });

        let existing = self.load_binding_at(root, w.provider, w.session_id);
        let created_at = existing.as_ref().map(|r| r.created_at).unwrap_or(w.now_ms);
        if existing
            .as_ref()
            .is_some_and(|r| r.retired_reason == Some(RetiredReason::GcExpired))
        {
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                provider = %w.provider,
                session_id = %w.session_id,
                "pane_ledger_revived: gc_expired tombstone re-bound by a live identity event"
            );
        }
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            mode: w.mode.to_string(),
            cwd: w.cwd.map(str::to_string),
            live_terminal_id: Some(w.terminal_id.to_string()),
            create_request_id: w.create_request_id.map(str::to_string),
            created_at,
            updated_at: w.now_ms,
            last_observed_at: w.now_ms,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
        };
        self.write_binding(root, &row)?; // new bound row FIRST (pinned)

        if let Some(mut old) = previous {
            old.state = RowState::Retired;
            old.retired_reason = Some(RetiredReason::Superseded);
            old.superseded_by = Some(SessionLocator {
                provider: w.provider.to_string(),
                session_id: w.session_id.to_string(),
            });
            old.updated_at = w.now_ms;
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                terminal_id = %w.terminal_id,
                old_session_id = %old.session_id,
                new_session_id = %w.session_id,
                "pane_ledger_superseded: binding moved; old row retired, never defended"
            );
            self.write_binding(root, &old)?; // THEN retire the old
        }
        Ok(())
    }
```

Add the chain-terminus reader to `impl PaneLedger`:

```rust
    /// Follow the `supersededBy` chain from a claimed ref to its terminus.
    /// Chains cannot cycle (a supersession write always targets a fresh row
    /// and retires its predecessor in the same act) — the hop cap is a
    /// corruption backstop, loud when hit.
    pub fn lookup_by_session(&self, provider: &str, session_id: &str) -> Option<Resolution> {
        let root = self.root.as_ref()?;
        let mut row = self.load_binding_at(root, provider, session_id)?;
        let mut corrected = false;
        let mut hops = 0u32;
        while row.state == RowState::Retired {
            let Some(next) = row.superseded_by.clone() else {
                break; // closed / gc_expired terminus — caller applies its reader rule
            };
            hops += 1;
            if hops > 32 {
                tracing::error!(
                    target: "freshell_ws::pane_ledger",
                    provider = %provider,
                    session_id = %session_id,
                    "pane_ledger_chain_overflow: supersession chain exceeded 32 hops (corruption?)"
                );
                return None;
            }
            let Some(next_row) = self.load_binding_at(root, &next.provider, &next.session_id)
            else {
                break;
            };
            row = next_row;
            corrected = true;
        }
        Some(Resolution { row, corrected })
    }
```

- [ ] **Step 4: Run to verify pass.** Run: `cargo test -p freshell-ws pane_ledger` — Expected: PASS.

- [ ] **Step 5: Refactor + gates.** `cargo fmt --all && cargo clippy -p freshell-ws --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "feat(ws): ledger supersession - retire-never-defend with pinned write order + chain-terminus reader"
```

---

### Task 3: Pending markers — pinned resolution order, collision idempotence

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs`
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs`

**Interfaces:**
- Consumes: Tasks 1–2.
- Produces:
  - `pub fn record_pending(&self, terminal_id: &str, mode: &str, cwd: Option<&str>, now_ms: i64) -> std::io::Result<()>`
  - `pub fn resolve_pending(&self, w: &BindingWrite<'_>) -> std::io::Result<()>` — binding row FIRST, then marker delete; idempotent under collision.
  - `pub fn delete_pending(&self, terminal_id: &str) -> std::io::Result<()>` — missing file is Ok (used by the observed-exit hygiene, Task 6).
  - `pub fn pending_for_terminal(&self, terminal_id: &str) -> Option<PendingMarker>` — applies the reader rule: a marker whose terminalId already has a binding row is STALE and answered `None`.
  - `pub fn list_pending_raw(&self) -> Vec<PendingMarker>` — raw markers for the boot sweep (Task 4) and tests.

- [ ] **Step 1: Write the failing tests.** Append to `pane_ledger_tests.rs`:

```rust
#[test]
fn pending_marker_roundtrips_and_reader_rule_prefers_binding() {
    let root = temp_root("pending");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_pending("t1", "opencode", Some("/tmp/p"), 1_000).unwrap();
    let marker = ledger.pending_for_terminal("t1").expect("marker readable");
    assert_eq!(marker.terminal_id, "t1");
    assert_eq!(marker.mode, "opencode");
    assert_eq!(marker.cwd.as_deref(), Some("/tmp/p"));
    assert_eq!(marker.spawned_at, 1_000);

    // Reader rule (spec §4.2): "binding row wins; a marker whose terminalId
    // already has a binding row is stale."
    ledger.record_binding(&write("opencode", "ses-1", "t1", 2_000)).unwrap();
    assert_eq!(ledger.pending_for_terminal("t1"), None);
    // The raw file still exists until the boot sweep (Task 4) removes it.
    assert_eq!(ledger.list_pending_raw().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn resolve_pending_writes_binding_first_then_deletes_marker() {
    let root = temp_root("resolve");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_pending("t1", "codex", Some("/tmp/p"), 1_000).unwrap();
    ledger.resolve_pending(&write("codex", "th-1", "t1", 2_000)).unwrap();
    assert!(ledger.load_binding("codex", "th-1").is_some());
    assert!(ledger.list_pending_raw().is_empty());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn pending_resolution_collision_is_idempotent() {
    // Red test `pending-resolution-collision` (spec §4.2 / decision 5): a
    // second racing resolution for the same terminalId finds the marker
    // gone or already-bound and no-ops — one binding row, no error.
    let root = temp_root("collision");
    let ledger = std::sync::Arc::new(PaneLedger::new(Some(root.clone())));
    ledger.record_pending("t1", "codex", Some("/tmp/p"), 1_000).unwrap();

    // Sequential double-resolution.
    ledger.resolve_pending(&write("codex", "th-1", "t1", 2_000)).unwrap();
    ledger.resolve_pending(&write("codex", "th-1", "t1", 2_001)).expect("second resolve no-ops");
    assert_eq!(
        ledger.list_bindings().iter().filter(|r| r.session_id == "th-1").count(),
        1
    );

    // Concurrent resolution from two threads (the actual race shape).
    ledger.record_pending("t2", "codex", Some("/tmp/p"), 3_000).unwrap();
    let a = std::sync::Arc::clone(&ledger);
    let b = std::sync::Arc::clone(&ledger);
    let ha = std::thread::spawn(move || a.resolve_pending(&write("codex", "th-2", "t2", 3_001)));
    let hb = std::thread::spawn(move || b.resolve_pending(&write("codex", "th-2", "t2", 3_002)));
    ha.join().unwrap().expect("racer A ok");
    hb.join().unwrap().expect("racer B ok");
    assert_eq!(
        ledger.list_bindings().iter().filter(|r| r.session_id == "th-2").count(),
        1
    );
    assert!(ledger.pending_for_terminal("t2").is_none());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn sigkill_inside_locator_window_leaves_a_durable_marker() {
    // Red test `SIGKILL-inside-locator-window` (unit shape): a marker
    // written pre-resolution survives "process death" (a second PaneLedger
    // instance over the same dir) so a restarted server can answer
    // "fresh by race, not by intent" instead of silent fresh.
    let root = temp_root("sigkill-window");
    {
        let gen1 = PaneLedger::new(Some(root.clone()));
        gen1.record_pending("t1", "opencode", Some("/tmp/p"), 1_000).unwrap();
        // gen1 "dies" here — dropped without resolving.
    }
    let gen2 = PaneLedger::new(Some(root.clone()));
    let marker = gen2.pending_for_terminal("t1").expect("marker survived the crash");
    assert_eq!(marker.mode, "opencode");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn delete_pending_is_a_noop_when_missing() {
    let root = temp_root("del-missing");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.delete_pending("never-existed").expect("missing marker is Ok");
    std::fs::remove_dir_all(&root).ok();
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws pane_ledger` — Expected: FAIL to compile (`record_pending` etc. missing).

- [ ] **Step 3: Implement.** Add to `impl PaneLedger` in `pane_ledger.rs`:

```rust
    fn pending_path(root: &Path, terminal_id: &str) -> PathBuf {
        Self::pending_dir(root).join(format!("{}.json", encode_segment(terminal_id)))
    }

    /// Durable evidence that identity establishment is in flight for this
    /// terminal (spec §4.2): written at spawn of an identity-bearing pane
    /// whose identity is not yet known.
    pub fn record_pending(
        &self,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        now_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let _guard = self.guard();
        let marker = PendingMarker {
            ledger_version: LEDGER_VERSION,
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            cwd: cwd.map(str::to_string),
            spawned_at: now_ms,
        };
        write_row_atomic(&Self::pending_path(root, terminal_id), &marker)
    }

    /// Identity resolved: two independent atomic operations in a PINNED,
    /// load-bearing order — write the sessionRef-keyed binding row FIRST,
    /// then delete the pending marker (spec §4.2, G1/decision 5). A crash
    /// between the two leaves both, which is safe: the reader rule prefers
    /// the binding row and the boot sweep (Task 4) deletes the stale marker.
    /// Idempotent: a second racing resolution finds the marker gone or the
    /// row already bound and no-ops.
    pub fn resolve_pending(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let _guard = self.guard();
        self.record_binding_locked(root, w)?; // binding row FIRST
        Self::remove_pending_file(root, w.terminal_id) // THEN the marker
    }

    /// Best-effort marker removal (missing file == already resolved/GC'd).
    pub fn delete_pending(&self, terminal_id: &str) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let _guard = self.guard();
        Self::remove_pending_file(root, terminal_id)
    }

    fn remove_pending_file(root: &Path, terminal_id: &str) -> std::io::Result<()> {
        match std::fs::remove_file(Self::pending_path(root, terminal_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        }
    }

    /// Reader-rule lookup: `None` when no marker exists OR when a binding
    /// row already covers this terminal ("binding row wins; such a marker is
    /// stale").
    pub fn pending_for_terminal(&self, terminal_id: &str) -> Option<PendingMarker> {
        let root = self.root.as_ref()?;
        let marker = load_row::<PendingMarker>(&Self::pending_path(root, terminal_id))
            .ok()
            .filter(|m: &PendingMarker| m.ledger_version == LEDGER_VERSION)?;
        let has_binding = self
            .list_bindings_at(root)
            .iter()
            .any(|r| r.live_terminal_id.as_deref() == Some(terminal_id));
        if has_binding {
            return None;
        }
        Some(marker)
    }

    /// Raw markers (no reader rule) — boot-sweep + test surface.
    pub fn list_pending_raw(&self) -> Vec<PendingMarker> {
        let Some(root) = &self.root else {
            return Vec::new();
        };
        let mut out = Vec::new();
        let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) else {
            return out;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(marker) = load_row::<PendingMarker>(&path) {
                if marker.ledger_version == LEDGER_VERSION {
                    out.push(marker);
                }
            }
        }
        out
    }
```

- [ ] **Step 4: Run to verify pass.** `cargo test -p freshell-ws pane_ledger` — Expected: PASS.

- [ ] **Step 5: Refactor + gates.** `cargo fmt --all && cargo clippy -p freshell-ws --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "feat(ws): ledger pending markers - pinned binding-first resolution, collision idempotence"
```

---

### Task 4: Boot scan — quarantine, stale-marker sweep, supersession repair, GC-to-tombstone

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs`
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  - `pub struct BootScanReport { pub quarantined: Vec<QuarantinedRow>, pub stale_markers_removed: Vec<String>, pub supersession_repairs: Vec<(SessionLocator, SessionLocator)>, pub gc_tombstoned: Vec<SessionLocator>, pub tombstones_deleted: Vec<SessionLocator> }`
  - `pub fn boot_scan(&self, now_ms: i64, transcript_absent: &dyn Fn(&str, &str) -> bool) -> BootScanReport` — `transcript_absent(provider, session_id)` must return `true` ONLY when the transcript is definitively absent (an `Unknown`/cold index answers `false`, which safely defers tombstone deletion).
  - `pub fn gc(&self, now_ms: i64, transcript_absent: &dyn Fn(&str, &str) -> bool) -> BootScanReport` — the periodic subset (GC-to-tombstone + conditional tombstone deletion only).
  - `pub fn quarantined_rows(&self) -> Vec<QuarantinedRow>` — Phase-3 verdict surfacing consumes this; here it is the API + loud-ERROR surface.

- [ ] **Step 1: Write the failing tests.** Append to `pane_ledger_tests.rs`:

```rust
fn never_absent(_p: &str, _s: &str) -> bool {
    false
}

#[test]
fn corrupt_ledger_boot_quarantines_per_row_never_per_store() {
    // Red test `corrupt-ledger-boot` (spec §4.2): an unparsable row is
    // renamed aside + logged, never silently dropped, and never causes
    // healthy rows to be skipped.
    let root = temp_root("corrupt");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("claude", "sess-good", "t1", 1_000)).unwrap();
    let bad = root.join("bindings").join("claude").join("sess-bad.json");
    std::fs::write(&bad, b"{ not json").unwrap();
    // A future-versioned row is also quarantined (ledgerVersion gates
    // migration), never silently reinterpreted.
    let vnext = root.join("bindings").join("claude").join("sess-vnext.json");
    std::fs::write(&vnext, br#"{"ledgerVersion": 999, "someFutureShape": true}"#).unwrap();

    let report = ledger.boot_scan(2_000, &never_absent);
    assert_eq!(report.quarantined.len(), 2);
    assert!(!bad.exists(), "corrupt row renamed aside");
    assert!(!vnext.exists(), "future-version row renamed aside");
    let provider_dir = root.join("bindings").join("claude");
    let quarantined: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".quarantined-"))
        .collect();
    assert_eq!(quarantined.len(), 2, "renamed aside, not deleted");
    // Healthy rows still served.
    assert!(ledger.load_binding("claude", "sess-good").is_some());
    assert_eq!(ledger.quarantined_rows().len(), 2, "surfaced via API");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn crash_between_binding_write_and_marker_delete_is_repaired_at_boot() {
    // Red test `crash-between-binding-write-and-marker-delete`: both rows
    // present (the safe crash shape the pinned order buys) -> the boot
    // sweep deletes the stale marker; the binding row wins throughout.
    let root = temp_root("crash-window");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_pending("t1", "codex", Some("/tmp/p"), 1_000).unwrap();
    ledger.record_binding(&write("codex", "th-1", "t1", 2_000)).unwrap();
    // (simulates: binding written, crash before marker delete)

    let report = ledger.boot_scan(3_000, &never_absent);
    assert_eq!(report.stale_markers_removed, vec!["t1".to_string()]);
    assert!(ledger.list_pending_raw().is_empty());
    assert!(ledger.load_binding("codex", "th-1").is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn boot_scan_never_sweeps_a_marker_merely_because_the_terminal_is_not_live() {
    // Spec §4.2: pending markers are GC'd only for terminals whose clean
    // exit was observed IN THIS PROCESS EPOCH — never swept at boot just
    // because the terminal isn't currently live. That would erase the
    // fresh-by-race breadcrumb at exactly the boot that needs it.
    let root = temp_root("marker-preserved");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_pending("t1", "opencode", Some("/tmp/p"), 1_000).unwrap();
    let report = ledger.boot_scan(2_000, &never_absent);
    assert!(report.stale_markers_removed.is_empty());
    assert!(ledger.pending_for_terminal("t1").is_some());
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn crash_mid_supersession_two_bound_rows_repaired_by_updated_at_tiebreak() {
    // Red test `crash-mid-supersession-two-bound-rows`: the new bound row
    // was written but the crash landed before the old row was retired ->
    // two bound rows share a pane lineage (liveTerminalId). Boot repair:
    // newer updatedAt wins, older auto-retired as superseded, loudly.
    let root = temp_root("two-bound");
    let ledger = PaneLedger::new(Some(root.clone()));
    // Forge the crash shape directly (record_binding would retire the old).
    for (sid, at) in [("th-old", 1_000i64), ("th-new", 2_000i64)] {
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: "codex".into(),
            session_id: sid.into(),
            mode: "codex".into(),
            cwd: None,
            live_terminal_id: Some("t1".into()),
            create_request_id: None,
            created_at: at,
            updated_at: at,
            last_observed_at: at,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
        };
        write_row_atomic(
            &root.join("bindings").join("codex").join(format!("{sid}.json")),
            &row,
        )
        .unwrap();
    }

    let report = ledger.boot_scan(3_000, &never_absent);
    assert_eq!(report.supersession_repairs.len(), 1);
    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    assert_eq!(old.superseded_by.as_ref().unwrap().session_id, "th-new");
    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn gc_expires_unobserved_bound_rows_to_tombstones_never_deletion() {
    let root = temp_root("gc");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("claude", "sess-old", "t1", 1_000)).unwrap();
    let now = 1_000 + BOUND_GC_TTL_MS + 1;
    let report = ledger.gc(now, &never_absent);
    assert_eq!(report.gc_tombstoned.len(), 1);
    let row = ledger.load_binding("claude", "sess-old").unwrap();
    assert_eq!(row.state, RowState::Retired);
    assert_eq!(row.retired_reason, Some(RetiredReason::GcExpired));
    // NOT deleted — a tombstone.
    assert!(ledger.ever_bound("claude", "sess-old"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn tombstone_deletion_is_conditioned_on_transcript_absence() {
    let root = temp_root("tombstone");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("claude", "sess-x", "t1", 1_000)).unwrap();
    let expire_at = 1_000 + BOUND_GC_TTL_MS + 1;
    ledger.gc(expire_at, &never_absent);
    let delete_at = expire_at + TOMBSTONE_GC_TTL_MS + 1;

    // Transcript still on disk (or unknown) -> tombstone survives forever.
    let report = ledger.gc(delete_at, &never_absent);
    assert!(report.tombstones_deleted.is_empty());
    assert!(ledger.ever_bound("claude", "sess-x"));

    // Definitively absent -> deletion is finally allowed.
    let report = ledger.gc(delete_at, &|_p, _s| true);
    assert_eq!(report.tombstones_deleted.len(), 1);
    assert!(!ledger.ever_bound("claude", "sess-x"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn gc_expired_tombstone_rebinds_on_a_live_identity_event() {
    // Spec §4.2: `retired/gc_expired -> bound` is a LEGAL transition, taken
    // automatically (never-ask-when-we-can-act) and loudly logged.
    let root = temp_root("revive");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger.record_binding(&write("claude", "sess-x", "t1", 1_000)).unwrap();
    ledger.gc(1_000 + BOUND_GC_TTL_MS + 1, &never_absent);
    assert_eq!(
        ledger.load_binding("claude", "sess-x").unwrap().retired_reason,
        Some(RetiredReason::GcExpired)
    );
    let revive_at = 1_000 + BOUND_GC_TTL_MS + 2;
    ledger.record_binding(&write("claude", "sess-x", "t2", revive_at)).unwrap();
    let row = ledger.load_binding("claude", "sess-x").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws pane_ledger` — Expected: FAIL to compile (`boot_scan`/`gc`/`quarantined_rows`/`BootScanReport` missing).

- [ ] **Step 3: Implement.** Add to `pane_ledger.rs`:

```rust
/// What one boot scan / GC pass did — every field is also loudly logged.
#[derive(Debug, Default)]
pub struct BootScanReport {
    pub quarantined: Vec<QuarantinedRow>,
    pub stale_markers_removed: Vec<String>,
    /// (retired old ref, winning new ref) pairs from the crash-window repair.
    pub supersession_repairs: Vec<(SessionLocator, SessionLocator)>,
    pub gc_tombstoned: Vec<SessionLocator>,
    pub tombstones_deleted: Vec<SessionLocator>,
}
```

And to `impl PaneLedger`:

```rust
    /// Boot-time hygiene (spec §4.2): per-row quarantine, stale-marker
    /// sweep, supersession crash-window repair, then a GC pass. Fail loud
    /// per-row, never per-store.
    pub fn boot_scan(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let _guard = self.guard();
        let mut report = BootScanReport::default();

        // 1. Quarantine unparsable / wrong-version rows (bindings + pending).
        self.quarantine_unparsable(&root, now_ms, &mut report);
        {
            let mut q = self.quarantined.write().unwrap_or_else(|p| p.into_inner());
            q.extend(report.quarantined.iter().cloned());
        }

        // 2. Stale-marker sweep: a marker whose terminalId already has a
        //    binding row is stale — the crash-between-write-and-delete shape.
        //    Markers WITHOUT a binding row are PRESERVED (fresh-by-race
        //    evidence), never swept merely because the terminal isn't live.
        let bindings = self.list_bindings_at(&root);
        for marker in self.list_pending_raw_at(&root) {
            let covered = bindings
                .iter()
                .any(|r| r.live_terminal_id.as_deref() == Some(marker.terminal_id.as_str()));
            if covered {
                if Self::remove_pending_file(&root, &marker.terminal_id).is_ok() {
                    tracing::warn!(
                        target: "freshell_ws::pane_ledger",
                        terminal_id = %marker.terminal_id,
                        "pane_ledger_stale_marker_swept: binding row exists; marker was the crash-window residue"
                    );
                    report.stale_markers_removed.push(marker.terminal_id);
                }
            }
        }

        // 3. Supersession crash-window repair: two bound rows on one pane
        //    lineage — newer updatedAt wins, older auto-retired, loud.
        let mut by_terminal: std::collections::HashMap<String, Vec<BindingRow>> =
            std::collections::HashMap::new();
        for row in self.list_bindings_at(&root) {
            if row.state == RowState::Bound {
                if let Some(tid) = &row.live_terminal_id {
                    by_terminal.entry(tid.clone()).or_default().push(row);
                }
            }
        }
        for (terminal_id, mut rows) in by_terminal {
            if rows.len() < 2 {
                continue;
            }
            rows.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
            let winner = SessionLocator {
                provider: rows[0].provider.clone(),
                session_id: rows[0].session_id.clone(),
            };
            for mut loser in rows.into_iter().skip(1) {
                loser.state = RowState::Retired;
                loser.retired_reason = Some(RetiredReason::Superseded);
                loser.superseded_by = Some(winner.clone());
                loser.updated_at = now_ms;
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    terminal_id = %terminal_id,
                    loser_session_id = %loser.session_id,
                    winner_session_id = %winner.session_id,
                    "pane_ledger_supersession_repair: two bound rows on one lineage; newer updatedAt wins"
                );
                let loser_ref = SessionLocator {
                    provider: loser.provider.clone(),
                    session_id: loser.session_id.clone(),
                };
                if self.write_binding(&root, &loser).is_ok() {
                    report.supersession_repairs.push((loser_ref, winner.clone()));
                }
            }
        }

        // 4. GC pass (also runs periodically via `gc`).
        let gc_report = self.gc_locked(&root, now_ms, transcript_absent);
        report.gc_tombstoned = gc_report.gc_tombstoned;
        report.tombstones_deleted = gc_report.tombstones_deleted;
        report
    }

    /// The periodic subset: expire unobserved bound rows TO TOMBSTONES and
    /// delete old tombstones ONLY when the transcript is definitively gone.
    pub fn gc(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let _guard = self.guard();
        self.gc_locked(&root, now_ms, transcript_absent)
    }

    fn gc_locked(
        &self,
        root: &Path,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let mut report = BootScanReport::default();
        for mut row in self.list_bindings_at(root) {
            let sref = SessionLocator {
                provider: row.provider.clone(),
                session_id: row.session_id.clone(),
            };
            match row.state {
                RowState::Bound => {
                    if now_ms - row.last_observed_at > BOUND_GC_TTL_MS {
                        row.state = RowState::Retired;
                        row.retired_reason = Some(RetiredReason::GcExpired);
                        row.updated_at = now_ms;
                        tracing::info!(
                            target: "freshell_ws::pane_ledger",
                            provider = %sref.provider,
                            session_id = %sref.session_id,
                            "pane_ledger_gc_tombstoned: bound row expired to tombstone (never deleted by timer)"
                        );
                        if self.write_binding(root, &row).is_ok() {
                            report.gc_tombstoned.push(sref);
                        }
                    }
                }
                RowState::Retired => {
                    let old_enough = now_ms - row.updated_at > TOMBSTONE_GC_TTL_MS;
                    if old_enough && transcript_absent(&row.provider, &row.session_id) {
                        let path = Self::binding_path(root, &row.provider, &row.session_id);
                        if std::fs::remove_file(&path).is_ok() {
                            tracing::info!(
                                target: "freshell_ws::pane_ledger",
                                provider = %sref.provider,
                                session_id = %sref.session_id,
                                "pane_ledger_tombstone_deleted: transcript gone and tombstone TTL elapsed"
                            );
                            report.tombstones_deleted.push(sref);
                        }
                    }
                }
            }
        }
        report
    }

    fn quarantine_unparsable(&self, root: &Path, now_ms: i64, report: &mut BootScanReport) {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) {
            for provider in providers.flatten() {
                if let Ok(files) = std::fs::read_dir(provider.path()) {
                    candidates.extend(files.flatten().map(|f| f.path()));
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) {
            candidates.extend(files.flatten().map(|f| f.path()));
        }
        for path in candidates {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.contains(".tmp-") {
                // Orphan temp from a crashed write — reap with a WARN (the
                // `sweep_orphan_tmp` discipline).
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    path = %path.display(),
                    "pane_ledger_orphan_tmp_reaped"
                );
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue; // prior quarantine residue
            }
            let error = match load_row::<serde_json::Value>(&path) {
                Err(e) => format!("{e}"),
                Ok(value) => {
                    let version = value.get("ledgerVersion").and_then(|v| v.as_u64());
                    if version == Some(u64::from(LEDGER_VERSION)) {
                        // Version ok — but does it parse as its row type?
                        let is_pending = path.parent().map(|p| p.ends_with("pending")).unwrap_or(false);
                        let typed_ok = if is_pending {
                            serde_json::from_value::<PendingMarker>(value).is_ok()
                        } else {
                            serde_json::from_value::<BindingRow>(value).is_ok()
                        };
                        if typed_ok {
                            continue; // healthy
                        }
                        "row shape does not match its type".to_string()
                    } else {
                        format!("unsupported ledgerVersion {version:?} (gate: {LEDGER_VERSION})")
                    }
                }
            };
            let quarantined_path =
                path.with_file_name(format!("{name}.quarantined-{now_ms}"));
            tracing::error!(
                target: "freshell_ws::pane_ledger",
                path = %path.display(),
                quarantined = %quarantined_path.display(),
                error = %error,
                "pane_ledger_row_quarantined: unparsable row renamed aside (fail loud per-row, never per-store)"
            );
            if std::fs::rename(&path, &quarantined_path).is_ok() {
                report.quarantined.push(QuarantinedRow {
                    original_path: path,
                    quarantined_path,
                    error,
                });
            }
        }
    }

    /// Rows quarantined by this process's boot scan — the Phase-3 verdict
    /// surfacing (`ledger_quarantined` breadcrumb) reads this.
    pub fn quarantined_rows(&self) -> Vec<QuarantinedRow> {
        self.quarantined
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }

    fn list_pending_raw_at(&self, root: &Path) -> Vec<PendingMarker> {
        let mut out = Vec::new();
        let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) else {
            return out;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            if let Ok(marker) = load_row::<PendingMarker>(&path) {
                if marker.ledger_version == LEDGER_VERSION {
                    out.push(marker);
                }
            }
        }
        out
    }
```

Refactor `list_pending_raw` to delegate to `list_pending_raw_at` (same body, root resolved first). Note `boot_scan`/`gc` take `&self` but mutate only files — the `Mutex` guard serializes them against writers.

- [ ] **Step 4: Run to verify pass.** `cargo test -p freshell-ws pane_ledger` — Expected: PASS (all tasks-1-4 tests).

- [ ] **Step 5: Refactor + gates.** Check `pane_ledger.rs` length — if it now exceeds ~1K lines, move `BootScanReport`/scan internals verbatim into a `pane_ledger_scan.rs` submodule (`#[path]`-free, plain `mod pane_ledger_scan;` is NOT needed — prefer keeping one module; only split if over the limit). `cargo fmt --all && cargo clippy -p freshell-ws --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/pane_ledger_tests.rs
git commit -m "feat(ws): ledger boot scan - per-row quarantine, stale-marker sweep, supersession repair, GC-to-tombstone"
```

---

### Task 5: Wiring — WsState field, main.rs construction, boot scan + periodic GC, harness support

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (the `WsState` struct)
- Modify: `crates/freshell-server/src/main.rs`
- Modify: `crates/freshell-ws/tests/common/mod.rs`
- Modify: every `WsState { … }` literal the compiler flags (known: `crates/freshell-ws/src/opencode_association.rs` tests' `state_with_locator`, `crates/freshell-ws/src/amplifier_association.rs` tests, possibly `lib.rs`/`terminal.rs`/`activity.rs` inline tests and other `tests/*.rs` harnesses)

**Interfaces:**
- Consumes: Task 1's `PaneLedger::{new, disabled}`, Task 4's `boot_scan`/`gc`.
- Produces:
  - `WsState.pane_ledger: std::sync::Arc<crate::pane_ledger::PaneLedger>` — every later task's call sites use `state.pane_ledger`.
  - `common::spawn_server_with_ledger(cli_commands: Vec<CliCommandSpec>, ledger_dir: &std::path::Path) -> (String, freshell_terminal::TerminalRegistry)` in `tests/common/mod.rs`.

- [ ] **Step 1: RED — add the field and let the compiler drive.** In `crates/freshell-ws/src/lib.rs`, find the `WsState` struct (fields like `pub identity: crate::identity::TerminalIdentityRegistry` at ~`lib.rs:128`) and add, with a doc comment, keeping neighbors' style:

```rust
    /// P1.8: the durable pane-identity ledger (spec §4.2). Constructed once
    /// in `freshell-server::main` (root `<home>/.freshell/pane-ledger`,
    /// `PaneLedger::disabled()` when no home resolves) and shared with the
    /// existence probe. Arc'd: identity events write it synchronously.
    pub pane_ledger: std::sync::Arc<crate::pane_ledger::PaneLedger>,
```

Run: `cargo check --workspace --all-targets`
Expected: FAIL — every `WsState { … }` literal is missing the field. This IS the red step; the error list is the complete work list.

- [ ] **Step 2: GREEN — update every literal.** For each error site:
  - **Production (`crates/freshell-server/src/main.rs`):** construct the real ledger BEFORE the `WsState` literal, next to where `resolve_home()` output is available (the tabs-snapshots wiring at `main.rs:704-711` is the precedent):

```rust
    // P1.8: the pane-identity ledger (spec §4.2). Root resolved ONCE here;
    // the module itself never reads env vars. No home => disabled no-op,
    // same policy as tabs-snapshots.
    let pane_ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(
        home.as_ref().map(|h| h.join(".freshell").join("pane-ledger")),
    ));
```

    and in the `WsState` literal add `pane_ledger: std::sync::Arc::clone(&pane_ledger),`.
  - **Every test/harness literal:** add `pane_ledger: std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::disabled()),` (inside `freshell-ws` itself use `crate::pane_ledger::PaneLedger::disabled()`).

Run: `cargo check --workspace --all-targets` until clean.

- [ ] **Step 3: Boot scan + periodic GC in `main.rs`.** The existence probe is constructed around `main.rs:425-435`. AFTER the probe exists (its `exists()` is the transcript-truth source) and after `pane_ledger` is constructed, add:

```rust
    // P1.8 boot hygiene: quarantine, stale-marker sweep, supersession
    // repair, GC. `transcript_absent` answers true ONLY on a definitive
    // Absent — a cold index (Unknown) safely defers tombstone deletion.
    {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        let probe_for_scan = std::sync::Arc::clone(&existence_probe);
        let report = pane_ledger.boot_scan(now, &move |provider, session_id| {
            probe_for_scan.exists(provider, session_id)
                == freshell_ws::existence::SessionExistence::Absent
        });
        if !report.quarantined.is_empty() {
            tracing::error!(
                count = report.quarantined.len(),
                "pane_ledger_boot: rows quarantined (see per-row errors above)"
            );
        }
    }

    // P1.8 periodic GC (boot-time + periodic, spec §4.2 lifecycle).
    {
        let ledger = std::sync::Arc::clone(&pane_ledger);
        let probe = std::sync::Arc::clone(&existence_probe);
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(std::time::Duration::from_secs(6 * 60 * 60));
            ticker.tick().await; // the immediate first tick — boot_scan already ran
            loop {
                ticker.tick().await;
                let ledger = std::sync::Arc::clone(&ledger);
                let probe = std::sync::Arc::clone(&probe);
                let _ = tokio::task::spawn_blocking(move || {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis() as i64)
                        .unwrap_or(0);
                    ledger.gc(now, &|provider, session_id| {
                        probe.exists(provider, session_id)
                            == freshell_ws::existence::SessionExistence::Absent
                    });
                })
                .await;
            }
        });
    }
```

    Adapt variable names to what `main.rs` actually calls its probe/home; keep the semantics exactly as written. If the probe is constructed AFTER the `WsState` literal today, construct the ledger first and move the boot-scan block after probe construction — construction order: ledger → probe (Task 11 hands it the ledger) → boot scan.

- [ ] **Step 4: Harness variant.** In `crates/freshell-ws/tests/common/mod.rs`, add next to `spawn_server_with_specs` (`:91`), mirroring its body exactly but parameterizing the ledger:

```rust
/// [`spawn_server_with_specs`], with a REAL pane ledger rooted at
/// `ledger_dir` (P1.8 tests). Two servers pointed at the same dir model a
/// restart.
pub async fn spawn_server_with_ledger(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
    ledger_dir: &std::path::Path,
) -> (String, freshell_terminal::TerminalRegistry) {
    // Body: copy of spawn_server_with_specs with the WsState literal's
    // `pane_ledger` field set to:
    //     std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(
    //         Some(ledger_dir.to_path_buf()),
    //     ))
    // If spawn_server_with_specs delegates to a shared builder, add the
    // ledger as a parameter to that builder instead of duplicating it.
}
```

- [ ] **Step 5: Verify.** Run: `cargo test -p freshell-ws && cargo test -p freshell-server` — Expected: PASS (no behavior change yet; this task is wiring). Then `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add -A crates/
git commit -m "feat(server): construct pane ledger, boot scan + periodic GC, WsState wiring, test harness support"
```

---

### Task 6: terminal.rs write triggers — binding at create, pending marker at spawn, exit/kill hygiene

**Files:**
- Modify: `crates/freshell-protocol/src/server_messages.rs`
- Modify: `crates/freshell-ws/src/invariants.rs`
- Modify: `crates/freshell-ws/src/pane_ledger.rs` (the `surface_write_failure` helper)
- Modify: `crates/freshell-ws/src/terminal.rs`
- Create: `crates/freshell-ws/tests/pane_ledger_triggers.rs`

**Interfaces:**
- Consumes: `handle_create`'s tail (`terminal.rs:1504-1548`: `create_meta_record`, `state.identity.upsert`, `TerminalCreated`), the exit hook closure (`terminal.rs:1305-1340`), `kill_and_broadcast` (`terminal.rs:2106-2116`), `crate::terminal::now_ms`, Task 5's `state.pane_ledger`.
- Produces:
  - Protocol: `ServerMessage::DurabilityDegraded` (tag `"durability.degraded"`) with `pub struct DurabilityDegraded { pub terminal_id: String, pub reason: String, pub message: String }` (camelCase serde).
  - `crate::pane_ledger::surface_write_failure(state: &crate::WsState, terminal_id: &str, result: std::io::Result<()>)` — every ledger write at an identity event goes through this.
  - `crate::invariants::error_pane_ledger_write_failed(terminal_id: &str, err: &std::io::Error)`.
  - Behavior later tasks rely on: a non-shell create writes EITHER a binding row (identity known at spawn: claude pre-allocation, any restore/resume create) OR a pending marker (identity in flight); observed PTY exit deletes the terminal's pending marker; explicit kill additionally retires the binding (`closed`).

- [ ] **Step 1: Write the failing integration tests.** Create `crates/freshell-ws/tests/pane_ledger_triggers.rs`:

```rust
//! P1.8 write-trigger integration tests: a REAL axum server + REAL WS client
//! (shared harness), asserting the on-disk ledger rows that identity events
//! must produce — including across a "restart" (a second PaneLedger instance
//! over the same dir; the crate-level shape of the SIGKILL wall tests).

mod common;
use common::*;

use freshell_ws::pane_ledger::{PaneLedger, RetiredReason, RowState};

fn unique_ledger_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-it-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("ledger dir");
    dir
}

/// Poll (≤5s, the spec's wall) until `check` passes — identity durability
/// must be an event-driven guarantee, not a cadence race.
fn wait_for<F: Fn() -> bool>(check: F, what: &str) {
    for _ in 0..50 {
        if check() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("timed out (5s wall) waiting for {what}");
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_preallocation_writes_a_binding_row_synchronously() {
    // Red test `SIGKILL-within-5s-of-pane-creation`, crate shape: by the
    // time terminal.created is answered, the binding row is on disk — a
    // SIGKILL any moment later cannot lose the identity.
    let dir = unique_ledger_dir("claude-prealloc");
    let (url, registry) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Fresh claude create — the server pre-allocates the session UUID.
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-claude-1",
        "mode": "claude",
        "shell": "bash",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
        .await
        .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    let session_id = created["sessionRef"]["sessionId"].as_str().unwrap().to_string();

    // The row must already be durable (the create handler writes it
    // synchronously before answering).
    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("claude", &session_id)
        .expect("binding row written at create");
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.live_terminal_id.as_deref(), Some(terminal_id.as_str()));
    assert_eq!(row.create_request_id.as_deref(), Some("req-claude-1"));
    assert_eq!(row.mode, "claude");

    // "Restart": a brand-new ledger instance over the same dir still
    // answers — process death cannot lose it.
    drop(ledger);
    let gen2 = PaneLedger::new(Some(dir.clone()));
    assert!(gen2.ever_bound("claude", &session_id));

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn fresh_identity_bearing_pane_gets_a_pending_marker_at_spawn() {
    // Trigger (d): identity in flight (fresh codex — no resume id) ->
    // durable pending marker from spawn until resolution.
    let dir = unique_ledger_dir("codex-pending");
    let (url, registry) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-codex-1",
        "mode": "codex",
        "shell": "bash",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
        .await
        .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    let ledger = PaneLedger::new(Some(dir.clone()));
    let marker = ledger
        .pending_for_terminal(&terminal_id)
        .expect("pending marker written at spawn");
    assert_eq!(marker.mode, "codex");

    // Observed exit IN THIS EPOCH ends the identity-in-flight window: the
    // kill path must delete the marker (spec §4.2 marker GC rule).
    // handle_kill runs synchronously on the dispatch loop — send + await a
    // pong to prove consumption (silence-proof pattern).
    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(kill.to_string()))
        .await
        .unwrap();
    wait_for(
        || ledger.pending_for_terminal(&terminal_id).is_none(),
        "marker deleted on observed kill",
    );

    let _ = registry; // terminal already killed
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_create_writes_binding_and_kill_retires_it_closed() {
    // Trigger (a/e): a resume create (identity known at spawn) writes the
    // binding row; an explicit user kill best-effort retires it `closed` —
    // never load-bearing, but recorded.
    let dir = unique_ledger_dir("resume-retire");
    let (url, _registry) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-codex-2",
        "mode": "codex",
        "shell": "bash",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "sessionRef": { "provider": "codex", "sessionId": "11111111-2222-3333-4444-555555555555" },
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
        .await
        .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();

    let ledger = PaneLedger::new(Some(dir.clone()));
    let row = ledger
        .load_binding("codex", "11111111-2222-3333-4444-555555555555")
        .expect("resume create wrote the binding");
    assert_eq!(row.state, RowState::Bound);

    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": terminal_id });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(kill.to_string()))
        .await
        .unwrap();
    wait_for(
        || {
            ledger
                .load_binding("codex", "11111111-2222-3333-4444-555555555555")
                .is_some_and(|r| {
                    r.state == RowState::Retired
                        && r.retired_reason == Some(RetiredReason::Closed)
                })
        },
        "binding retired closed on user kill",
    );
    std::fs::remove_dir_all(&dir).ok();
}
```

Note for the implementer: mirror the exact create-JSON field spellings from `crates/freshell-ws/tests/codex_candidate_persisted.rs`'s `send_create` helper (`:67`) — if that helper spells fields differently (e.g. `shell` shape), copy its shape verbatim.

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws --test pane_ledger_triggers` — Expected: FAIL — no binding row / marker is written (`expect("binding row written at create")` panics).

- [ ] **Step 3: Implement — protocol message.** In `crates/freshell-protocol/src/server_messages.rs`, add next to the other structs (and the enum variant next to `TerminalMetaUpdated`'s at `:116-117`):

```rust
/// P1.8 write-failure policy (spec §4.2): pushed LIVE at ledger-write
/// failure time so the warning arrives BEFORE the restart it warns about —
/// never a posthumous verdict flag. Frozen clients ignore unknown frame
/// types; rendering lands with the Phase 3 client adoption lane.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurabilityDegraded {
    pub terminal_id: String,
    /// Machine-readable, e.g. "ledger_write_failed".
    pub reason: String,
    /// Human-readable pane warning.
    pub message: String,
}
```

and in the `ServerMessage` enum:

```rust
    #[serde(rename = "durability.degraded")]
    DurabilityDegraded(DurabilityDegraded),
```

- [ ] **Step 4: Implement — invariant + surfacing helper.** In `crates/freshell-ws/src/invariants.rs` (next to `error_claude_restore_unresolved`, `:89-97`):

```rust
/// P1.8 (spec §4.2 write-failure policy): a ledger write failed. The event
/// itself proceeded (fail loud, degrade to status quo) — but this pane may
/// not survive a restart, and the live `durability.degraded` frame was
/// pushed at failure time.
pub(crate) fn error_pane_ledger_write_failed(terminal_id: &str, err: &std::io::Error) {
    tracing::error!(
        target: "freshell_ws::invariants",
        terminal_id = %terminal_id,
        error = %err,
        "pane_ledger_write_failed: identity event could not be durably recorded; \
         durability.degraded pushed live to attached clients"
    );
}
```

In `crates/freshell-ws/src/pane_ledger.rs`:

```rust
/// The write-failure policy (spec §4.2): a ledger write failure NEVER blocks
/// the create/identity event, but it is never silent — structured ERROR +
/// invariant counter + a LIVE `durability.degraded` frame to attached
/// clients, at failure time (a verdict-time flag would be posthumous).
pub(crate) fn surface_write_failure(
    state: &crate::WsState,
    terminal_id: &str,
    result: std::io::Result<()>,
) {
    let Err(err) = result else { return };
    crate::invariants::error_pane_ledger_write_failed(terminal_id, &err);
    let msg = freshell_protocol::ServerMessage::DurabilityDegraded(
        freshell_protocol::DurabilityDegraded {
            terminal_id: terminal_id.to_string(),
            reason: "ledger_write_failed".to_string(),
            message: "This pane's identity could not be durably recorded; it may not survive a server restart.".to_string(),
        },
    );
    if let Ok(frame) = serde_json::to_string(&msg) {
        let _ = state.broadcast_tx.send(frame);
    }
}
```

(If `DurabilityDegraded` is not re-exported from `freshell_protocol`'s root, add it to the crate's existing re-export list.)

- [ ] **Step 5: Implement — create-path triggers.** In `crates/freshell-ws/src/terminal.rs`, in `handle_create`'s tail, immediately AFTER the `if let Some(record) = &create_meta_record { state.identity.upsert(...) }` block (`:1511-1525`) and BEFORE `let created = ServerMessage::TerminalCreated(...)` (`:1526`):

```rust
    // P1.8 (spec §4.2 write triggers): the durable ledger write rides the
    // SAME identity event that seeds the in-memory registry — synchronous,
    // atomic temp+rename, before the create is answered. A failure never
    // blocks the create but is surfaced LIVE (surface_write_failure).
    if let Some(record) = &create_meta_record {
        // Identity known at spawn: claude pre-allocation (trigger a) and
        // every resume/restore create (all providers) — a binding row.
        if let (Some(provider), Some(session_id)) =
            (record.provider.as_deref(), record.session_id.as_deref())
        {
            let result = state.pane_ledger.record_binding(&crate::pane_ledger::BindingWrite {
                provider,
                session_id,
                terminal_id: &record.terminal_id,
                mode: &mode,
                cwd: record.cwd.as_deref(),
                create_request_id: Some(&create.request_id),
                now_ms: now_ms(),
            });
            crate::pane_ledger::surface_write_failure(state, &record.terminal_id, result);
        }
    } else if mode != "shell" {
        // Identity-bearing pane whose identity is still in flight (fresh
        // codex/opencode/amplifier — trigger d): a durable pending marker
        // from spawn until resolution deletes it (binding-first order).
        let result = state.pane_ledger.record_pending(
            &terminal_id_for_meta,
            &mode,
            spec.cwd.as_deref(),
            now_ms(),
        );
        crate::pane_ledger::surface_write_failure(state, &terminal_id_for_meta, result);
    }
```

(`terminal_id_for_meta` and `spec.cwd` are already in scope at that point — see `:1504-1510`; keep whatever local names the file actually uses.)

- [ ] **Step 6: Implement — exit/kill hygiene.** In the natural-exit `on_exit` hook (`terminal.rs:1305-1340`), clone the ledger alongside the other handles (`let pane_ledger = std::sync::Arc::clone(&state.pane_ledger);` next to `let identity = state.identity.clone();` at `:510-512` region) and inside the closure, after `identity.retire(&tid);`:

```rust
            // P1.8: an observed PTY exit in this epoch ends any
            // identity-in-flight window — the marker's job (distinguishing
            // fresh-by-race from fresh-by-intent across a SERVER death) is
            // over. Best-effort; never load-bearing.
            if let Err(err) = pane_ledger.delete_pending(&tid) {
                tracing::warn!(terminal_id = %tid, error = %err, "pane_ledger_marker_delete_failed_on_exit");
            }
```

And in `kill_and_broadcast` (`terminal.rs:2106-2116`), after `state.identity.retire(terminal_id);`:

```rust
        // P1.8 trigger (e): explicit user close — best-effort retire of the
        // binding (`closed`) + marker cleanup. Best-effort by spec: SIGKILL
        // is the tested mode, so retire-on-close must never be load-bearing.
        // `session_ref_for` is retired-INCLUSIVE, so it still answers after
        // the retire() above.
        if let Some(sref) = state.identity.session_ref_for(terminal_id) {
            if let Err(err) =
                state
                    .pane_ledger
                    .retire_closed(&sref.provider, &sref.session_id, now_ms())
            {
                tracing::warn!(terminal_id = %terminal_id, error = %err, "pane_ledger_retire_failed_on_kill");
            }
        }
        if let Err(err) = state.pane_ledger.delete_pending(terminal_id) {
            tracing::warn!(terminal_id = %terminal_id, error = %err, "pane_ledger_marker_delete_failed_on_kill");
        }
```

Add `retire_closed` to `impl PaneLedger` in `pane_ledger.rs`:

```rust
    /// Best-effort retire on observed clean close (trigger e). Missing or
    /// already-retired rows are Ok — this path is never load-bearing.
    pub fn retire_closed(
        &self,
        provider: &str,
        session_id: &str,
        now_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let _guard = self.guard();
        let Some(mut row) = self.load_binding_at(root, provider, session_id) else {
            return Ok(());
        };
        if row.state != RowState::Bound {
            return Ok(());
        }
        row.state = RowState::Retired;
        row.retired_reason = Some(RetiredReason::Closed);
        row.updated_at = now_ms;
        self.write_binding(root, &row)
    }
```

- [ ] **Step 7: Run to verify pass.** `cargo test -p freshell-ws --test pane_ledger_triggers` then the full `cargo test -p freshell-ws` (existing suites must stay green — notably `claude_restore_unavailable.rs` and `codex_candidate_persisted.rs`). Expected: PASS.

- [ ] **Step 8: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 9: Commit.**

```bash
git add crates/freshell-protocol/src/server_messages.rs crates/freshell-ws/src/invariants.rs crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/pane_ledger_triggers.rs
git commit -m "feat(ws): ledger write triggers - binding at create, pending marker at spawn, exit/kill hygiene (P1.8)"
```

---

### Task 7: Write-failure policy — `ledger-write-failure-surfaces-live` red test

**Files:**
- Modify: `crates/freshell-ws/tests/pane_ledger_triggers.rs`

**Interfaces:**
- Consumes: Task 6's `surface_write_failure` wiring and `durability.degraded` frame.
- Produces: proof, on the wire, that the warning arrives at failure time and the create still succeeds.

- [ ] **Step 1: Write the failing test.** Append to `pane_ledger_triggers.rs`:

```rust
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn ledger_write_failure_surfaces_live_and_never_blocks_the_create() {
    // Red test `ledger-write-failure-surfaces-live` (spec §4.2): break the
    // store (read-only dir), create a claude pane. The create MUST succeed
    // (fail loud, degrade to status quo) and a `durability.degraded` frame
    // MUST arrive at failure time — before any restart could make the
    // warning posthumous.
    use std::os::unix::fs::PermissionsExt;
    let dir = unique_ledger_dir("write-fail");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o555)).unwrap();

    let (url, registry) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-fail-1",
        "mode": "claude",
        "shell": "bash",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
        .await
        .unwrap();

    // Both frames arrive; capture order-independently (broadcast vs direct
    // send interleave). next_frame_of_type drops mismatches, so scan for
    // the degraded frame FIRST, then the created frame cannot have been
    // consumed... instead: collect frames until both seen.
    let mut created: Option<serde_json::Value> = None;
    let mut degraded: Option<serde_json::Value> = None;
    for _ in 0..20 {
        let frame = next_any_frame(&mut ws).await; // helper below
        match frame["type"].as_str() {
            Some("terminal.created") => created = Some(frame),
            Some("durability.degraded") => degraded = Some(frame),
            _ => {}
        }
        if created.is_some() && degraded.is_some() {
            break;
        }
    }
    let created = created.expect("create succeeded despite ledger failure");
    let degraded = degraded.expect("durability.degraded pushed LIVE at failure time");
    assert_eq!(degraded["reason"], "ledger_write_failed");
    assert_eq!(degraded["terminalId"], created["terminalId"]);

    let tid = created["terminalId"].as_str().unwrap();
    registry.kill(tid);
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).ok();
    std::fs::remove_dir_all(&dir).ok();
}
```

Add a small local helper at the top of the file (the harness's `next_frame_of_type` drops mismatched frames, which this test cannot afford):

```rust
async fn next_any_frame(
    ws: &mut tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >,
) -> serde_json::Value {
    use futures_util::StreamExt;
    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(10), ws.next())
            .await
            .expect("frame within 10s")
            .expect("stream open")
            .expect("ws ok");
        if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
            return serde_json::from_str(&text).expect("json frame");
        }
    }
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws --test pane_ledger_triggers ledger_write_failure` — Expected: with Task 6 fully done this may already PASS. If it passes immediately, deliberately break `surface_write_failure` (comment out the broadcast) and confirm the test FAILS for the right reason, then restore — the red run must prove the test can catch the regression.

- [ ] **Step 3: Verify pass + full crate.** `cargo test -p freshell-ws` — Expected: PASS.

- [ ] **Step 4: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 5: Commit.**

```bash
git add crates/freshell-ws/tests/pane_ledger_triggers.rs
git commit -m "test(ws): ledger-write-failure-surfaces-live - degraded frame at failure time, create never blocked"
```

---

### Task 8: Codex candidate adoption → ledger resolution

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs` (the shared `ledger_resolve_identity` helper)
- Modify: `crates/freshell-ws/src/codex_candidate.rs`
- Modify: `crates/freshell-ws/tests/codex_candidate_persisted.rs`

**Interfaces:**
- Consumes: the adoption bind block `codex_candidate.rs:204-220` (`identity.upsert` → `registry.set_meta` → `broadcast_terminal_session_associated`), Task 3's `resolve_pending`, Task 6's `surface_write_failure`.
- Produces: `crate::pane_ledger::ledger_resolve_identity(state: &crate::WsState, terminal_id: &str, provider: &str, session_id: &str, cwd: Option<&str>)` — the ONE resolution hook all three association modules share (Task 9 reuses it).

- [ ] **Step 1: Write the failing test.** `crates/freshell-ws/tests/codex_candidate_persisted.rs` runs a single sequential test (`codex_candidate_persisted_guards_and_happy_path`, `:143`) whose harness owns the process env. Extend it minimally:
  1. At the top of the test, before the server spawns, create a ledger dir and switch the spawn to the Task 5 harness variant: `let ledger_dir = std::env::temp_dir().join(format!("codex-adopt-ledger-{}", std::process::id())); std::fs::create_dir_all(&ledger_dir).unwrap();` and replace the `spawn_server_with_specs(...)` call with `spawn_server_with_ledger(<same specs>, &ledger_dir)`. Also send the create with a pending-marker-producing shape (the existing fresh codex create already is one — no resume id).
  2. Immediately after the existing happy-path assertions (the pinned `terminal.session.associated` → `terminal.meta.updated` order + `registry_resume_id(...) == Some(THREAD_A)` block at `:232-247`), add:

```rust
    // P1.8: adoption is an identity event — the ledger must now hold a
    // binding row for THREAD_A, and the spawn-time pending marker must be
    // gone (binding-first pinned order, spec §4.2).
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(ledger_dir.clone()));
    let row = ledger
        .load_binding("codex", THREAD_A)
        .expect("adoption wrote a binding row");
    assert_eq!(row.state, freshell_ws::pane_ledger::RowState::Bound);
    assert_eq!(row.live_terminal_id.as_deref(), Some(tid.as_str()));
    assert!(
        ledger.pending_for_terminal(&tid).is_none(),
        "pending marker resolved away"
    );
    assert!(ledger.list_pending_raw().iter().all(|m| m.terminal_id != tid));
```

  (Use the test's actual local variable names for the terminal id and thread-id const.) Add `std::fs::remove_dir_all(&ledger_dir).ok();` to the test's existing cleanup tail.

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws --test codex_candidate_persisted` — Expected: FAIL at `expect("adoption wrote a binding row")`.

- [ ] **Step 3: Implement the shared helper.** In `crates/freshell-ws/src/pane_ledger.rs`:

```rust
/// The shared post-locator/candidate resolution hook (write trigger b/c):
/// binding row FIRST, then the pending marker is deleted (`resolve_pending`'s
/// pinned order). `create_request_id` is deliberately None here — it is an
/// advisory field captured at create time; resolution never joins on it (D4).
/// Failures never block the identity event; they surface LIVE.
pub(crate) fn ledger_resolve_identity(
    state: &crate::WsState,
    terminal_id: &str,
    provider: &str,
    session_id: &str,
    cwd: Option<&str>,
) {
    let result = state.pane_ledger.resolve_pending(&BindingWrite {
        provider,
        session_id,
        terminal_id,
        mode: provider,
        cwd,
        create_request_id: None,
        now_ms: crate::terminal::now_ms(),
    });
    surface_write_failure(state, terminal_id, result);
}
```

- [ ] **Step 4: Wire the codex hook.** In `crates/freshell-ws/src/codex_candidate.rs`, after the `state.registry.set_meta(...)` call (`:213-219`) and BEFORE `broadcast_terminal_session_associated` (`:220`):

```rust
    // P1.8 (trigger b): the verified adoption is an identity event — durable
    // binding row first, then the spawn-time pending marker is deleted.
    // Synchronous small-file write on the dispatch task, same budget class
    // as guard 4's verify_rollout_path read.
    crate::pane_ledger::ledger_resolve_identity(
        state,
        &msg.terminal_id,
        "codex",
        thread_id,
        row.cwd.as_deref(),
    );
```

- [ ] **Step 5: Run to verify pass.** `cargo test -p freshell-ws --test codex_candidate_persisted` then `cargo test -p freshell-ws`. Expected: PASS (rejected candidates must still write NOTHING — the guards all `return` before the hook, which the existing silence-proof phases keep pinned).

- [ ] **Step 6: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 7: Commit.**

```bash
git add crates/freshell-ws/src/pane_ledger.rs crates/freshell-ws/src/codex_candidate.rs crates/freshell-ws/tests/codex_candidate_persisted.rs
git commit -m "feat(ws): codex candidate adoption writes the ledger binding + resolves the pending marker"
```

---

### Task 9: Opencode + amplifier locator resolution → ledger; P1.10 restore re-arm pinned

**Files:**
- Modify: `crates/freshell-ws/src/opencode_association.rs`
- Modify: `crates/freshell-ws/src/amplifier_association.rs`

**Interfaces:**
- Consumes: Task 8's `ledger_resolve_identity`; the opencode bind block (`opencode_association.rs:135-154`); the amplifier sibling's identical bind block (locate it in `amplifier_association.rs` — same `identity.upsert` → `set_meta` → broadcast shape); the in-file test fixture `state_with_locator` (`opencode_association.rs:220-282`).
- Produces: P1.10 behavior, pinned by test — a restore-created opencode pane that LACKS identity (restore:true with no sessionRef/resumeSessionId) arms the locator, carries a pending marker from spawn, and resolution lands the binding + deletes the marker.

- [ ] **Step 1: Write the failing tests.** In `opencode_association.rs`'s `mod tests`:

  1. Extend `state_with_locator` with a ledger parameter — add a sibling fixture rather than churning every caller:

```rust
    fn state_with_locator_and_ledger(
        data_home: &std::path::Path,
        ledger_dir: &std::path::Path,
    ) -> (crate::WsState, tokio::sync::broadcast::Receiver<String>) {
        let (mut state, rx) = state_with_locator(data_home);
        state.pane_ledger = std::sync::Arc::new(crate::pane_ledger::PaneLedger::new(Some(
            ledger_dir.to_path_buf(),
        )));
        (state, rx)
    }
```

  2. Add the P1.10 pinning test, modeled line-for-line on `drain_and_associate_binds_identity_and_broadcasts_on_location` (`:406` — real PTY via `freshell_platform::build_spawn_spec` + `registry.create`, `set_meta` to opencode mode, `maybe_arm`, `note_possible_submit("\r")`, seeded sqlite `session` row, poll-drain up to 40×100ms):

```rust
    /// P1.10: a RESTORE-created opencode pane that lacks identity must
    /// still arm (restore:true suppresses arming ONLY via an implied
    /// resume_session_id — `OpencodeLocator::arm` checks the resume id,
    /// never a restore flag), and its identity-in-flight window must be
    /// covered by a durable pending marker until resolution deletes it.
    #[tokio::test]
    async fn restore_created_pane_without_identity_arms_and_resolves_into_the_ledger() {
        let home = unique_temp_dir("p110-restore-rearm");
        let ledger_dir = unique_temp_dir("p110-ledger");
        let (state, mut rx) = state_with_locator_and_ledger(&home, &ledger_dir);

        // ... spawn a real PTY registry row exactly as the sibling test
        // does (copy its registry.create + set_meta(mode "opencode",
        // resume None) setup verbatim; terminal id "t1") ...

        // The restore-shaped arm: identity absent, so resume is None — the
        // exact argument shape terminal.rs:1477-1483 produces for a
        // restore:true create that carried no sessionRef.
        maybe_arm(&state, "t1", "opencode", Some(cwd_str), None);
        assert_eq!(state.opencode_locator.as_ref().unwrap().armed_count(), 1);

        // The spawn-time pending marker (written by handle_create in
        // production — Task 6; written directly here because this test
        // drives the module, not the WS handler).
        state
            .pane_ledger
            .record_pending("t1", "opencode", Some(cwd_str), crate::terminal::now_ms())
            .unwrap();

        note_possible_submit(&state, "t1", "\r");
        // ... seed the sqlite session row for the cwd, as the sibling test
        // does, then poll drain_and_associate until identity binds ...

        // Resolution wrote the binding and deleted the marker (pinned order).
        let hit = state
            .pane_ledger
            .lookup_by_session("opencode", &located_session_id)
            .expect("binding row written at resolution");
        assert_eq!(hit.row.live_terminal_id.as_deref(), Some("t1"));
        assert!(state.pane_ledger.pending_for_terminal("t1").is_none());
        assert!(state.pane_ledger.list_pending_raw().is_empty());

        // ... sibling test's cleanup (registry.kill("t1"), remove dirs) ...
    }
```

  (Where the sketch says "copy … verbatim", copy from the sibling test in the same file — it is directly above. `armed_count` exists on the locator; if it is test-gated in `freshell-sessions`, assert arming the way `maybe_arm_arms_a_fresh_opencode_terminal` (`:356`) does instead.)

  3. Amplifier: add the mirror-image ledger assertion to `amplifier_association.rs`'s existing resolve-path test (find the sibling of `drain_and_associate_binds_identity_and_broadcasts_on_location` around `amplifier_association.rs:330-430`; extend its state fixture with a real ledger the same way and assert the binding row + marker deletion). If that file has no full resolve-path test (only `maybe_arm` tests), add the ledger assertion to a new test cloned from the opencode one, or — if a real amplifier resolve fixture is disproportionate — assert at minimum that `ledger_resolve_identity` is called by code inspection parity and cover amplifier's marker lifecycle via the Task 6 integration test (markers are written for ANY non-shell mode). Prefer the real test.

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws opencode_association` — Expected: FAIL at `expect("binding row written at resolution")`.

- [ ] **Step 3: Implement.** In `opencode_association.rs`, inside `drain_and_associate`'s bind block, after `state.registry.set_meta(...)` (`:142-148`) and before `broadcast_terminal_session_associated` (`:149`):

```rust
        // P1.8 (trigger c) + P1.10: locator resolution is an identity event —
        // durable binding row first, then the spawn-time pending marker is
        // deleted. Registry-truth cwd, same as the in-memory binds above.
        crate::pane_ledger::ledger_resolve_identity(
            state,
            &located.terminal_id,
            "opencode",
            &located.session_id,
            entry.cwd.as_deref(),
        );
```

In `amplifier_association.rs`, add the identical call in its bind block with provider `"amplifier"` and that block's registry-entry cwd (trigger (d) coherence: Task 6 writes markers for EVERY identity-bearing mode, so every locator that resolves identity must also resolve the marker).

- [ ] **Step 4: Run to verify pass.** `cargo test -p freshell-ws opencode_association && cargo test -p freshell-ws amplifier_association` then full `cargo test -p freshell-ws`. Expected: PASS.

- [ ] **Step 5: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/opencode_association.rs crates/freshell-ws/src/amplifier_association.rs
git commit -m "feat(ws): opencode/amplifier locator resolution writes the ledger; pin P1.10 restore re-arm"
```

---

### Task 10: Read 1 — inventory sessionRef stamping falls back to the ledger

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (`build_handshake_with_capabilities`, the stamping loop at `:398-403`)
- Create: `crates/freshell-ws/tests/pane_ledger_restore.rs` (first test)

**Interfaces:**
- Consumes: Task 1's `bound_session_ref_for_terminal`, Task 5's harness.
- Produces: inventory rows whose in-memory identity is absent are stamped from the ledger's bound rows (authority chain: in-memory registry → ledger bound rows).

- [ ] **Step 1: Write the failing test.** Create `crates/freshell-ws/tests/pane_ledger_restore.rs`:

```rust
//! P1.8 read-side integration tests: the reads that make the ledger
//! non-dormant (spec §4.2 / Principle 6), exercised across server
//! "generations" sharing one ledger dir.

mod common;
use common::*;

use freshell_ws::pane_ledger::{BindingWrite, PaneLedger};

fn unique_ledger_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-read-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir).expect("ledger dir");
    dir
}

#[tokio::test(flavor = "multi_thread")]
async fn inventory_stamping_falls_back_to_ledger_bound_rows() {
    // Authority chain (spec §4.2 precedence): in-memory registry first,
    // ledger bound rows second. Model the fallback window: a live codex
    // terminal whose in-memory identity is ABSENT (identity arrives only
    // at candidate adoption) but whose binding a ledger already holds.
    let dir = unique_ledger_dir("stamp");
    let (url, registry) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("codex")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Fresh codex: no in-memory identity entry is seeded at create.
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-stamp-1",
        "mode": "codex",
        "shell": "bash",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
        .await
        .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let terminal_id = created["terminalId"].as_str().unwrap().to_string();
    assert!(
        created.get("sessionRef").is_none(),
        "fresh codex has no create-time identity (precondition)"
    );

    // A previous generation resolved this terminal's identity into the
    // ledger (write it via a second handle — the restart-equivalent shape).
    let writer = PaneLedger::new(Some(dir.clone()));
    writer
        .record_binding(&BindingWrite {
            provider: "codex",
            session_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
            terminal_id: &terminal_id,
            mode: "codex",
            cwd: None,
            create_request_id: Some("req-stamp-1"),
            now_ms: 1_000,
        })
        .unwrap();

    // A NEW connection's handshake inventory row must now be stamped from
    // the ledger (in-memory identity is still absent).
    let (_ws2, inventory) = connect_and_capture_inventory(&url).await;
    let row = inventory["terminals"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["terminalId"] == terminal_id.as_str())
        .expect("terminal in inventory");
    assert_eq!(row["sessionRef"]["provider"], "codex");
    assert_eq!(
        row["sessionRef"]["sessionId"],
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
    );

    registry.kill(&terminal_id);
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws --test pane_ledger_restore inventory_stamping` — Expected: FAIL — the inventory row carries no `sessionRef`.

- [ ] **Step 3: Implement.** In `crates/freshell-ws/src/lib.rs`, extend the stamping loop (`:398-403`) to:

```rust
    let mut terminals = state.registry.inventory();
    for terminal in &mut terminals {
        if terminal.session_ref.is_none() {
            terminal.session_ref = state.identity.session_ref_for(&terminal.terminal_id);
        }
        if terminal.session_ref.is_none() {
            // P1.8 (spec §4.2 reads + precedence): the ledger's bound rows
            // are the durable second rung of the identity authority chain —
            // consulted only when live process truth is absent.
            terminal.session_ref = state
                .pane_ledger
                .bound_session_ref_for_terminal(&terminal.terminal_id);
        }
    }
```

- [ ] **Step 4: Run to verify pass.** `cargo test -p freshell-ws --test pane_ledger_restore` then `cargo test -p freshell-ws` (handshake-pinning suites must stay byte-identical for terminals WITH in-memory identity and for shell terminals — the fallback only fills a previously-empty field). Expected: PASS.

- [ ] **Step 5: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/lib.rs crates/freshell-ws/tests/pane_ledger_restore.rs
git commit -m "feat(ws): inventory sessionRef stamping falls back to ledger bound rows (P1.8 read 1)"
```

---

### Task 11: Read 2 — `ever_observed` becomes ledger-backed

**Files:**
- Modify: `crates/freshell-server/src/existence.rs`
- Modify: `crates/freshell-server/src/main.rs` (probe construction)

**Interfaces:**
- Consumes: `IndexExistenceProbe { index, observed }` (`freshell-server/src/existence.rs:28-32`), its `ever_observed` (`:88-93`), Task 1's `ever_bound`, Task 5's `pane_ledger` in `main.rs`.
- Produces: `IndexExistenceProbe::new(index: Arc<SessionIndex>, ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>)` (extend the existing constructor's signature; update its call sites). `ever_observed` returns `true` when the per-boot observed set OR the durable ledger has seen the identity. **Do not touch `reconcile.rs`** — the verdict derivation is unchanged; only this INPUT changes.

- [ ] **Step 1: Write the failing test.** In `crates/freshell-server/src/existence.rs`'s `#[cfg(test)] mod tests` (create one if absent, following the file's conventions):

```rust
    #[test]
    fn ever_observed_survives_a_restart_via_the_ledger() {
        // Spec §4.2 read 2: a transcript deleted while the server was DOWN
        // must yield loud dead_session, not silent fresh. The per-boot
        // observed set is empty after a restart — the ledger is the durable
        // memory. (The Absent+ever_observed => dead_session derivation is
        // already pinned by reconcile.rs's
        // `row4_absent_but_ever_observed_yields_dead_session`; this test
        // covers the INPUT seam.)
        let dir = std::env::temp_dir().join(format!(
            "ledger-everobs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            dir.clone(),
        )));
        // "Generation 1" bound this identity durably.
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: "11111111-2222-3333-4444-555555555555",
                terminal_id: "t1",
                mode: "claude",
                cwd: None,
                create_request_id: None,
                now_ms: 1_000,
            })
            .unwrap();

        // "Generation 2": a brand-new probe with an EMPTY observed set —
        // construct it exactly as main.rs does, over an index whose
        // provider home is an empty temp dir (the transcript is gone).
        let probe = new_test_probe_with_ledger(Some(std::sync::Arc::clone(&ledger)));
        assert!(
            probe.ever_observed("claude", "11111111-2222-3333-4444-555555555555"),
            "durable ledger memory answers across restarts"
        );
        assert!(!probe.ever_observed("claude", "99999999-2222-3333-4444-555555555555"));

        // Without a ledger, the old per-boot behavior is preserved.
        let bare = new_test_probe_with_ledger(None);
        assert!(!bare.ever_observed("claude", "11111111-2222-3333-4444-555555555555"));
        std::fs::remove_dir_all(&dir).ok();
    }
```

Write `new_test_probe_with_ledger` following however the file's existing tests construct an `IndexExistenceProbe` (they exist for `exists()`; mirror their `SessionIndex` fixture). If no such fixture exists, construct the probe with a `SessionIndex` over an empty temp provider home.

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-server existence` — Expected: FAIL to compile (constructor has no ledger parameter) or assert-fail.

- [ ] **Step 3: Implement.** In `crates/freshell-server/src/existence.rs`:

```rust
pub struct IndexExistenceProbe {
    index: Arc<SessionIndex>,
    /// `provider:sessionId` keys ever seen in ANY snapshot this boot.
    observed: Mutex<HashSet<String>>,
    /// P1.8 (spec §4.2 read 2): the durable "ever bound by this server"
    /// memory — survives restarts, so a transcript deleted while the server
    /// was down yields loud dead_session, not silent fresh.
    ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
}
```

Extend the constructor to accept `ledger: Option<Arc<PaneLedger>>` (store it; update every construction site — `main.rs` passes `Some(Arc::clone(&pane_ledger))`, tests pass what they need). Replace `ever_observed`:

```rust
    fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
        if self
            .observed
            .lock()
            .expect("observed set lock")
            .contains(&format!("{provider}:{session_id}"))
        {
            return true;
        }
        self.ledger
            .as_ref()
            .is_some_and(|ledger| ledger.ever_bound(provider, session_id))
    }
```

In `main.rs`, construction order per Task 5: `pane_ledger` first, then the probe with the ledger handle, then the boot scan.

- [ ] **Step 4: Run to verify pass.** `cargo test -p freshell-server && cargo test -p freshell-ws` — Expected: PASS (the `NoIndexProbe` used by all `freshell-ws` tests is untouched; `reconcile.rs` untouched).

- [ ] **Step 5: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-server/src/existence.rs crates/freshell-server/src/main.rs
git commit -m "feat(server): ever_observed consults the pane ledger - deleted-while-down transcripts yield loud dead_session (P1.8 read 2)"
```

---

### Task 12: Read 3 — the claude restore ladder gains the durable-ledger rung

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (`resolve_claude_restore_session_id`, `:1568-1600`)
- Modify: `crates/freshell-ws/tests/pane_ledger_restore.rs`

**Interfaces:**
- Consumes: the existing ladder (rungs: identity registry → registry row, gated on newest-generation-not-Running, `terminal.rs:1581-1600` — its doc comment names this exact seam: "the durable-ledger and disk-scan rungs land in a later slice, P1.8"), Task 1's `lookup_by_create_request_id`, Task 4's revive-on-rebind semantics.
- Produces: rung 3 — the ledger. Preserved judgments: (i) the A13 live-guard stays a HARD stop (a Running newest generation returns `None` before the ledger is consulted — the ledger must never reverse it); (ii) after an explicit user-kill IN THIS PROCESS, the binding is `retired/closed` (Task 6), which `lookup_by_create_request_id` excludes — the kill-then-restore case still fails loud.

- [ ] **Step 1: Write the failing test.** Append to `crates/freshell-ws/tests/pane_ledger_restore.rs`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn claude_restore_resolves_via_the_ledger_across_a_restart() {
    // The P1.8 ladder rung: generation 1 pre-allocates a claude session id
    // and durably records it; generation 2 (fresh process state — the
    // browser-closed / cleared-client shape) receives restore:true with
    // ONLY the createRequestId and must auto-resume via the ledger instead
    // of rejecting with RESTORE_UNAVAILABLE.
    let dir = unique_ledger_dir("ladder");
    use futures_util::SinkExt;

    // --- Generation 1 ---
    let session_id;
    {
        let (url, registry) =
            spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
        let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
        let create = serde_json::json!({
            "type": "terminal.create",
            "requestId": "req-ladder-1",
            "mode": "claude",
            "shell": "bash",
            "cwd": std::env::temp_dir().to_string_lossy(),
        });
        ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
            .await
            .unwrap();
        let created = next_frame_of_type(&mut ws, "terminal.created").await;
        session_id = created["sessionRef"]["sessionId"].as_str().unwrap().to_string();
        // Kill the PTY so generation 1 dies "abruptly" from the ledger's
        // point of view (registry rows don't survive process death anyway;
        // the ledger row must). NOTE: registry.kill models the PROCESS
        // dying with the server — the ledger row stays BOUND because
        // kill_and_broadcast (the user-close path) was never invoked.
        let tid = created["terminalId"].as_str().unwrap();
        registry.kill(tid);
    } // generation 1 dropped — its in-memory identity dies with it

    // --- Generation 2, same ledger dir, fresh everything else ---
    let (url2, _registry2) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws2, _inv2) = connect_and_capture_inventory(&url2).await;
    let restore = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-ladder-1",
        "mode": "claude",
        "shell": "bash",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws2.send(tokio_tungstenite::tungstenite::Message::Text(restore.to_string()))
        .await
        .unwrap();
    let created2 = next_frame_of_type(&mut ws2, "terminal.created").await;
    assert_eq!(
        created2["sessionRef"]["sessionId"].as_str().unwrap(),
        session_id,
        "generation 2 auto-resumed the ledgered identity (never RESTORE_UNAVAILABLE)"
    );
    std::fs::remove_dir_all(&dir).ok();
}

#[tokio::test(flavor = "multi_thread")]
async fn claude_restore_still_fails_loud_when_the_ledger_row_was_closed() {
    // Preserved judgment: an explicit user-kill retires the row `closed`;
    // the ladder's ledger rung must NOT resurrect it — fail loud, exactly
    // like the in-process kill path today.
    let dir = unique_ledger_dir("ladder-closed");
    use futures_util::SinkExt;
    let (url, _registry) =
        spawn_server_with_ledger(vec![sleeper_cli_spec("claude")], &dir).await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    let create = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-closed-1",
        "mode": "claude",
        "shell": "bash",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(create.to_string()))
        .await
        .unwrap();
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid = created["terminalId"].as_str().unwrap().to_string();
    // Explicit USER close (the wire kill path -> retire_closed).
    let kill = serde_json::json!({ "type": "terminal.kill", "terminalId": tid });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(kill.to_string()))
        .await
        .unwrap();
    let _ = next_frame_of_type(&mut ws, "terminals.changed").await;

    // Restore of the killed lineage (same requestId, no client id):
    // the registry row is REMOVED by kill, and the ledger row is `closed`
    // -> RESTORE_UNAVAILABLE, same as today.
    let restore = serde_json::json!({
        "type": "terminal.create",
        "requestId": "req-closed-1",
        "mode": "claude",
        "shell": "bash",
        "restore": true,
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    ws.send(tokio_tungstenite::tungstenite::Message::Text(restore.to_string()))
        .await
        .unwrap();
    let error = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(error["code"], "RESTORE_UNAVAILABLE");
    std::fs::remove_dir_all(&dir).ok();
}
```

(Mirror the exact error-frame field spelling from `crates/freshell-ws/tests/claude_restore_unavailable.rs` — copy its assertion shape.)

- [ ] **Step 2: Run to verify failure.** `cargo test -p freshell-ws --test pane_ledger_restore` — Expected: `claude_restore_resolves_via_the_ledger_across_a_restart` FAILS (generation 2 answers `error{RESTORE_UNAVAILABLE}`); the `closed` test may already pass (it pins existing judgment — keep it).

- [ ] **Step 3: Implement.** Replace `resolve_claude_restore_session_id` (`terminal.rs:1581-1600`) with (keep the existing doc comment, updating its "land in a later slice, P1.8" sentence to note the ledger rung now exists and only the disk-scan rung remains future):

```rust
fn resolve_claude_restore_session_id(state: &WsState, create_request_id: &str) -> Option<String> {
    // Rungs 1-2 (in-process, PR #530) — unchanged, except the early-return
    // structure now falls THROUGH to the ledger when the in-process homes
    // simply have no lineage (a fresh boot), while the A13 live-guard stays
    // a HARD stop the ledger must never reverse.
    if let Some(newest) = state.registry.newest_by_create_request_id(create_request_id) {
        if let Some(row) = state.registry.probe(&newest) {
            if row.status == freshell_protocol::TerminalRunStatus::Running {
                return None; // A13 live-guard: never a second live claude on one session id
            }
            if let Some(sref) = state.identity.session_ref_for(&newest) {
                // Retired entries included -- an exited claude's identity is
                // exactly what a same-lineage restore needs.
                if sref.provider == "claude" {
                    return Some(sref.session_id);
                }
            }
            if row.mode == "claude" {
                if let Some(sid) = row.resume_session_id.filter(|s| !s.is_empty()) {
                    return Some(sid);
                }
            }
        }
    }
    // Rung 3 (P1.8): the durable ledger — the rung that survives restarts.
    // `lookup_by_create_request_id` answers only `bound` rows and
    // `gc_expired` tombstones (auto-resume is a legal transition); a row
    // retired `closed` (user-kill) or `superseded` is never resurrected.
    let row = state
        .pane_ledger
        .lookup_by_create_request_id("claude", create_request_id)?;
    // A13-equivalent guard against the ledger rung: if ANY live terminal
    // currently owns this session id, fail loud rather than double-resume.
    if let Some(owner) = state.identity.find_by_session("claude", &row.session_id) {
        if state
            .registry
            .probe(&owner.terminal_id)
            .is_some_and(|r| r.status == freshell_protocol::TerminalRunStatus::Running)
        {
            return None;
        }
    }
    if row.retired_reason == Some(crate::pane_ledger::RetiredReason::GcExpired) {
        tracing::info!(
            target: "freshell_ws::pane_ledger",
            session_id = %row.session_id,
            "pane_ledger_auto_resume: gc_expired tombstone revived by restore (never-ask-when-we-can-act)"
        );
    }
    Some(row.session_id)
}
```

(`find_by_session` returns `Option<TerminalIdentity>` — `identity.rs:157-166`, live-only, which is exactly the guard's need.)

- [ ] **Step 4: Run to verify pass.** `cargo test -p freshell-ws --test pane_ledger_restore` then FULL `cargo test -p freshell-ws` — `claude_restore_unavailable.rs` (the PR #530 contract) must stay green: its unresolvable cases use identities the ledger has never seen, so the new rung returns `None` and the loud reject is preserved. Expected: PASS.

- [ ] **Step 5: Refactor + gates.** `cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings`.

- [ ] **Step 6: Commit.**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/pane_ledger_restore.rs
git commit -m "feat(ws): claude restore ladder gains the durable-ledger rung (P1.8 read 3)"
```

---

### Task 13: E2E — SIGKILL durability walls

**Files:**
- Create: `test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (register in BOTH `RUST_ONLY_SPECS` and `rust-chromium`'s `testMatch` — missing either means the spec fails under `chromium` or never runs)

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.ts` — `findFreePort()`, mkdtemp'd `$HOME`, `.start()/.restartAbrupt()/.stop()`), `TestHarness`, `openPanePicker` (`helpers/pane-picker.ts`), fake CLIs (`fixtures/fake-claude-cli.mjs`, `fake-codex-cli.mjs`, `fake-opencode-terminal.mjs`) via `CLAUDE_CMD`/`CODEX_CMD`/`OPENCODE_CMD` + copy-then-chmod. Per this suite's per-spec-ownership convention, small helpers are COPIED from `compound-restart-rust.spec.ts`, not imported.
- Produces: the e2e shapes of `SIGKILL-within-5s-of-pane-creation` and `SIGKILL-inside-locator-window`.

- [ ] **Step 1: Write the failing spec.** Create `test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts`:

```ts
/**
 * P1.8 pane-identity ledger — SIGKILL durability walls (spec §4.2).
 *
 * Wall 1 (`SIGKILL-within-5s-of-pane-creation`): by the time a pane exists,
 * its identity row (or pending marker) is on disk — an abrupt SIGKILL
 * moments after creation loses nothing, and the restarted server's boot
 * scan preserves (never quarantines, never sweeps) the evidence.
 *
 * Wall 2 (`SIGKILL-inside-locator-window`): a pane killed mid
 * identity-establishment leaves a durable pending marker that SURVIVES the
 * restart boot scan — fresh-by-race stays distinguishable from
 * fresh-by-intent.
 *
 * Fixture shapes (fake CLIs, temp-home seeding, restart choreography)
 * mirror compound-restart-rust.spec.ts; helpers are copied, not imported,
 * per this suite's per-spec-ownership convention.
 */
// The shared fixture module provides `test`/`expect` with the
// `e2eServerKind` fixture (helpers/fixtures.ts). VERIFY this import against
// the exact line compound-restart-rust.spec.ts uses and match it verbatim.
import { test, expect } from '../helpers/fixtures.js'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { RustServer } from '../helpers/rust-server.js'
import { TestHarness } from '../helpers/test-harness.js'
import { openPanePicker } from '../helpers/pane-picker.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

async function installFakeCli(binDir: string, name: string, source: string): Promise<string> {
  await fs.mkdir(binDir, { recursive: true })
  const target = path.join(binDir, name)
  await fs.copyFile(path.resolve(__dirname, '../fixtures', source), target)
  await fs.chmod(target, 0o755)
  return target
}

function seedConfig() {
  return async (homeDir: string): Promise<void> => {
    const freshellDir = path.join(homeDir, '.freshell')
    await fs.mkdir(freshellDir, { recursive: true })
    await fs.writeFile(
      path.join(freshellDir, 'config.json'),
      JSON.stringify(
        {
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex', 'opencode'] } },
        },
        null,
        2,
      ),
    )
  }
}

async function openCliPane(page: import('@playwright/test').Page, buttonName: RegExp): Promise<void> {
  const picker = await openPanePicker(page)
  await picker.getByRole('button', { name: buttonName }).click({ force: true })
  await page.getByRole('combobox', { name: /Starting directory/i }).press('Enter')
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const out: string[] = []
    for (const entry of await fs.readdir(dir, { recursive: true })) {
      out.push(String(entry))
    }
    return out
  } catch {
    return []
  }
}

/** Poll (5s wall) for a predicate over the ledger dir. */
async function within5s(check: () => Promise<boolean>, what: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`5s durability wall breached: ${what}`)
}

test.describe('pane-identity ledger restart durability', () => {
  test('identity rows are durable within seconds of pane creation and survive SIGKILL', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ledger-e2e-'))
    let capturedHome = ''
    try {
      const argLog = path.join(sharedRoot, 'claude-argv.jsonl')
      const fakeClaude = await installFakeCli(path.join(sharedRoot, 'bin'), 'claude', 'fake-claude-cli.mjs')
      const fakeCodex = await installFakeCli(path.join(sharedRoot, 'bin'), 'codex', 'fake-codex-cli.mjs')
      const seed = seedConfig()
      const server = new RustServer({
        env: { CLAUDE_CMD: fakeClaude, CODEX_CMD: fakeCodex, FAKE_CLAUDE_ARGV_LOG: argLog },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()

        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')

        // Claude pane: identity is pre-allocated at create — the binding
        // row must hit disk within the 5s wall.
        await openCliPane(page, /^Claude$/i)
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'bindings', 'claude'))).some((f) => f.endsWith('.json')),
          'claude binding row on disk',
        )

        // Codex pane: identity in flight — the pending marker must hit
        // disk within the same wall.
        await openCliPane(page, /^Codex$/i)
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'pending'))).some((f) => f.endsWith('.json')),
          'codex pending marker on disk',
        )

        // The claude row records the SAME session id the client saw
        // (the fake claude's argv log carries --session-id <uuid>).
        const argvRaw = await fs.readFile(argLog, 'utf8').catch(() => '')
        const argvEntries = argvRaw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[] })
        const sessionArg = argvEntries.flatMap((e) => {
          const i = e.argv.indexOf('--session-id')
          return i >= 0 ? [e.argv[i + 1]] : []
        })[0]
        expect(sessionArg, 'fake claude received a pre-allocated --session-id').toBeTruthy()
        const claudeRows = await listFiles(path.join(ledgerDir, 'bindings', 'claude'))
        expect(claudeRows.some((f) => f.includes(sessionArg!))).toBe(true)

        // --- THE WALL: SIGKILL moments after creation, then revive. ---
        await server.restartAbrupt()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        // Everything survived the boot scan: the claude binding row is
        // intact, the codex fresh-by-race marker was PRESERVED (never
        // swept merely because the terminal isn't live), and nothing was
        // quarantined.
        const allFiles = await listFiles(ledgerDir)
        expect(allFiles.filter((f) => f.startsWith('pending') && f.endsWith('.json')).length).toBeGreaterThan(0)
        expect(allFiles.some((f) => f.includes('.quarantined-'))).toBe(false)
        const claudeRowsAfter = await listFiles(path.join(ledgerDir, 'bindings', 'claude'))
        expect(claudeRowsAfter.some((f) => f.includes(sessionArg!))).toBe(true)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('SIGKILL inside the opencode locator window leaves a durable fresh-by-race marker', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pane-ledger-locator-'))
    let capturedHome = ''
    try {
      const fakeOpencode = await installFakeCli(path.join(sharedRoot, 'bin'), 'opencode', 'fake-opencode-terminal.mjs')
      const seed = seedConfig()
      const server = new RustServer({
        env: { OPENCODE_CMD: fakeOpencode },
        setupHome: async (homeDir: string) => {
          capturedHome = homeDir
          await seed(homeDir)
        },
      })
      const info = await server.start()
      try {
        await page.goto(`${info.baseUrl}/?token=${info.token}&e2e=1`)
        const harness = new TestHarness(page)
        await harness.waitForHarness()
        await harness.waitForConnection()

        const ledgerDir = path.join(capturedHome, '.freshell', 'pane-ledger')
        const picker = await openPanePicker(page)
        await picker.getByRole('button', { name: /^OpenCode$/i }).click({ force: true })
        await page.getByRole('combobox', { name: /Starting directory for OpenCode/i }).press('Enter')
        await within5s(
          async () => (await listFiles(path.join(ledgerDir, 'pending'))).some((f) => f.endsWith('.json')),
          'opencode pending marker on disk',
        )

        // SIGKILL INSIDE the locator window (no sqlite rows exist for the
        // fake, so identity never resolves — the marker is the only
        // evidence identity was in flight).
        await server.restartAbrupt()
        await expect(async () => {
          const status = await page.evaluate(() => (window as any).__FRESHELL_TEST_HARNESS__?.getWsReadyState())
          expect(status).toBe('ready')
        }).toPass({ timeout: 60_000 })

        // The restarted boot scan PRESERVED the marker (fresh-by-race
        // distinguishable from fresh-by-intent) — and nothing bound it.
        const pending = (await listFiles(path.join(ledgerDir, 'pending'))).filter((f) => f.endsWith('.json'))
        expect(pending.length).toBeGreaterThan(0)
        const bindings = await listFiles(path.join(ledgerDir, 'bindings'))
        expect(bindings.filter((f) => f.endsWith('.json'))).toHaveLength(0)
      } finally {
        await server.stop().catch(() => {})
      }
    } finally {
      await fs.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
```

Implementer notes (bindings to reality — reconcile each against the named source before first run):
  - Copy the exact `test`/`expect` import + fixture line from `compound-restart-rust.spec.ts` (`fixtures-or-base.js` above is a placeholder for whatever that spec imports).
  - `RustServer`'s option names (`env`, `setupHome`) and `restartAbrupt()` are as used at `compound-restart-rust.spec.ts:275-298`.
  - If `fs.readdir(..., { recursive: true })` is unavailable on the repo's Node version, replace `listFiles` with a small manual walk.
  - After a pane-picker create, dismiss/settle any picker state the same way sibling specs do (`selectShellIfPickerShowing` pattern) if the second `openCliPane` cannot find the picker.

- [ ] **Step 2: Register the spec.** In `test/e2e-browser/playwright.config.ts`, add `'pane-ledger-restart-rust.spec.ts'` to `RUST_ONLY_SPECS` AND to the `rust-chromium` project's `testMatch`, following exactly how `compound-restart-rust.spec.ts` appears in both.

- [ ] **Step 3: Run to verify.** Run: `npm run test:e2e -- --project=rust-chromium -g "pane-identity ledger"`
Expected: PASS (the Rust side already exists by this task). If either test fails, the failure is REAL signal about the wiring — debug the server side, do not weaken the assertions. (Playwright e2e is not coordinator-gated.)

- [ ] **Step 4: Commit.**

```bash
git add test/e2e-browser/specs/pane-ledger-restart-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): SIGKILL durability walls for the pane-identity ledger"
```

---

### Task 14: Full verification + push

**Files:** none new (fixes only, if gates fail).

- [ ] **Step 1: Rust gates.**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all green (generous timeout for `cargo test --workspace` — real PTY spawns).

- [ ] **Step 2: Coordinated JS suite** (we touched only e2e TS, but the repo rule is both-coverage + green gates before hand-off):

```bash
npm run test:status   # inspect the holder; WAIT if a sibling lane holds the gate
FRESHELL_TEST_SUMMARY="pane-identity-ledger lane A3 verification" npm test
```

Expected: green (or pre-existing failures documented as such against the base — do not paper over anything this branch caused).

- [ ] **Step 3: E2E.**

```bash
npm run test:e2e -- --project=rust-chromium -g "pane-identity ledger"
```

Expected: PASS.

- [ ] **Step 4: Push the branch. STOP before any PR.**

```bash
git push -u origin feat/pane-identity-ledger
```

PR creation is NOT approved — report the branch name and the proof (test outputs) instead.

---

## Spec coverage map (self-review record)

| Spec §4.2 pinned rule | Covering task(s) |
|---|---|
| Two row types, different keys/rights; markers never promoted/joined (G1) | 1, 3 |
| Pinned order: binding row FIRST, then marker delete; idempotent resolution | 3 (tests: `resolve_pending_writes_binding_first…`, `pending_resolution_collision…`) |
| Marker readable exactly-one-read by terminalId; binding-row-wins reader rule | 3 |
| Markers GC'd only on observed clean exit in-epoch; never swept at boot for not-live | 4 (`boot_scan_never_sweeps…`), 6 (exit/kill deletion) |
| Supersession retires-never-defends; new bound FIRST then retire; boot repair + tiebreak | 2, 4 |
| Reader follows `supersededBy` chain to terminus, `corrected:true`; no cycles | 2 (verdict-level wiring is Phase 3, stated in Global Constraints) |
| GC-to-tombstone; `gc_expired → bound` legal + auto + loud; tombstone delete conditioned on transcript absence | 4, 12 (auto-resume rung) |
| Corruption quarantine: per-row rename-aside + ERROR, healthy rows served, API surface | 4 (`corrupt_ledger_boot…`; verdict breadcrumb is Phase 3, stated) |
| Write-failure: never blocks, live frame at failure time + ERROR + counter | 6, 7 |
| Atomic temp+rename per row; `ledgerVersion` field gates migration | 1, 4 |
| Precedence: in-memory registry → ledger bound rows (→ client claim → snapshot) | 10 (the two server-side rungs; the client-claim/snapshot rungs live in reconcile, Phase 3) |
| Write triggers: (a) claude pre-allocation, (b) codex adoption, (c) opencode resolution, (d) pending at spawn, (e) retire on close | 6, 8, 9 |
| Reads ship in-slice: inventory stamping, `ever_observed`, claude ladder rung | 10, 11, 12 |
| Resume-invocation record (terminal panes: provider/sessionId/mode/cwd) | 1 (schema), Global Constraints (P1.13 boundary for freshagent settings) |
| P1.10: restore-created opencode w/o identity arms + pending marker until resolution | 9 (+6 for the marker) |
| Red tests named by the task | mapping table in File Structure section |
| E2E: SIGKILL walls on own RustServer, ephemeral ports | 13; browser-closed/cleared-client variant is delivered as the two-generation fresh-connection integration tests (10, 12) because the frozen client cannot express verdict-driven recovery until Phase 3 — the server-side behavior ("inventory stamping can still resolve", ladder resolution with only a requestId) is fully proven |

No placeholder patterns remain (checked for TBD/TODO/"handle edge cases"/"similar to Task N"); type names cross-checked: `PaneLedger`, `BindingRow`, `BindingWrite`, `RowState`, `RetiredReason`, `PendingMarker`, `Resolution`, `QuarantinedRow`, `BootScanReport`, `record_binding`, `record_pending`, `resolve_pending`, `delete_pending`, `pending_for_terminal`, `list_pending_raw`, `retire_closed`, `ever_bound`, `load_binding`, `list_bindings`, `lookup_by_session`, `lookup_by_create_request_id`, `bound_session_ref_for_terminal`, `boot_scan`, `gc`, `quarantined_rows`, `surface_write_failure`, `ledger_resolve_identity` are used consistently across Tasks 1–13.



