# Fresh-Agent Verdicts + Settings-From-Ledger Resume (Lane B4) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Bring fresh-agent panes (freshcodex / freshopencode / freshclaude / kilroy) into the server-side pane-reconcile verdict system, persist a resume-invocation record (model, sandbox, permissionMode, effort, cwd) in the pane-identity ledger at every fresh-agent identity event, reapply those settings automatically on every resume path, and broadcast a user-visible degradation frame when codex crash-respawn discards conversation memory.

**Architecture:** A `PaneIdentitySink` trait defined in `freshell-freshagent` (which cannot depend on `freshell-ws`) is implemented in `freshell-server` over the existing `Arc<PaneLedger>` and injected into the three provider states at wiring time — this solves the wave-A crate-boundary deferral without hoisting the ledger module. `BindingRow` gains optional resume-settings fields under `LEDGER_VERSION 1` (no version bump). Reconcile gains a new sync-safe module `reconcile_freshagent.rs`: an async snapshot of fresh-agent liveness/existence is built in `handle_pane_reconcile` (which is async) *before* the sync `derive_verdicts` runs inside `catch_unwind`; the only `reconcile.rs` changes are one `ReconcileDeps` field, one match arm, and inverting one unit test. The new arm is gated behind a NEW hello capability `paneReconcileFreshAgentV1` so the frozen client (which never sends it) is completely unaffected.

**Tech Stack:** Rust (tokio, serde, axum WS), Playwright e2e (rust-chromium project), fake CLI/sidecar fixtures (Node).

## Global Constraints

- Base: `origin/main @ 2dfbba58`; all work in worktree `/home/dan/code/freshell/.worktrees/freshagent-verdicts-resume`.
- CI Rust gate (must stay green after every task): `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`.
- Rust tests: `cargo test -p <crate>` locally (no cargo test in CI, run anyway).
- Coordinated node suites: check `npm run test:status` first; run `FRESHELL_TEST_SUMMARY="B4 freshagent-verdicts-resume" env -u FRESHELL_BIND_HOST npm test`; if the coordinator gate is held by another agent, WAIT (3 sibling lanes run concurrently — never kill a foreign holder).
- E2E: own `RustServer` instances on ephemeral ports only. NEVER ports 3001/3002. NEVER touch the user's self-hosted server. No broad kill patterns.
- SCOPE FENCE — do NOT touch: the rest of `crates/freshell-ws/src/reconcile.rs` beyond the single dispatch arm + one `ReconcileDeps` field + inverting the `unsupported_kind` unit test (Lane B1 owns the rest, incl. retry-verdict deletion — a trivial merge conflict at the arm is expected and fine); `crates/freshell-ws/src/existence.rs` (B1; read-only use is fine); codex_candidate/rollout locator (B2); tabs_snapshots + recovery UI (B3); ALL client code (`src/`, ws-client, App.tsx) — client folding of fresh-agent verdicts is the NEXT wave. No kimi/gemini work.
- `LEDGER_VERSION` stays `1`. All new `BindingRow` fields are `Option` with `skip_serializing_if` — no `deny_unknown_fields`, no required non-defaulted fields.
- Ledger writes are sync + fsync: async call sites MUST wrap them in `tokio::task::spawn_blocking` (module doc `pane_ledger.rs:34-43`).
- TypeScript (e2e specs): NodeNext/ESM — relative imports include `.js` where the repo convention requires (spec files follow the sibling specs' import style).
- Alarm/degradation frames use `freshAgent.error` event codes that are NOT `INVALID_SESSION_ID` and do NOT start with `RESTORE_` (that combination renders the persistent amber `role="alert"` banner in today's frozen client, `src/lib/fresh-agent-ws.ts:307-318` → `FreshAgentView.tsx:2046`).
- PR POLICY: NOT approved. Push the branch, STOP before `gh pr create`.
- ~78GB disk free — halt on ENOSPC.
- Reference (read-only context, do not commit): campaign plan at `/home/dan/code/freshell/docs/plans/2026-07-24-restart-resilience-architecture-analysis.md` (untracked, absolute path).

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/pane_ledger.rs` | Modify | `BindingRow` optional resume-settings fields; `FreshAgentBindingWrite` + `record_fresh_agent_binding` upsert |
| `crates/freshell-freshagent/src/identity_sink.rs` | Create | `PaneIdentitySink` trait, `FreshAgentSettings`, `FreshAgentBindingUpsert`, `FakeIdentitySink` (cfg(test)) |
| `crates/freshell-freshagent/src/lib.rs` | Modify | `pub mod identity_sink;` + re-exports |
| `crates/freshell-freshagent/src/codex.rs` | Modify | sink field/setter; ledger writes at identity events; settings-from-ledger on R1/R2/R3; degradation frame |
| `crates/freshell-freshagent/src/opencode_ws.rs` | Modify | sink field/setter; pending + binding writes; settings-from-ledger resume |
| `crates/freshell-freshagent/src/claude.rs` | Modify | sink field/setter; binding write at `sdk.session.init`; settings-from-ledger resume |
| `crates/freshell-server/src/identity_sink.rs` | Create | `LedgerIdentitySink: PaneIdentitySink` over `Arc<PaneLedger>` |
| `crates/freshell-server/src/main.rs` | Modify | construct + inject the sink into the three states |
| `crates/freshell-ws/src/reconcile_freshagent.rs` | Create | snapshot types, async snapshot builder, pure verdict mapping, respawn cap, dedupe |
| `crates/freshell-ws/src/reconcile.rs` | Modify (minimal) | one `ReconcileDeps` field + one match arm + invert one unit test |
| `crates/freshell-ws/src/lib.rs` | Modify | `mod reconcile_freshagent;`, `paneReconcileFreshAgentV1` capability parse/echo, `WsState.fresh_agent_respawn_counts` |
| `crates/freshell-ws/src/terminal.rs` | Modify | thread capability bool; build fresh-agent snapshot in `handle_pane_reconcile` |
| `crates/freshell-ws/tests/pane_reconcile_freshagent.rs` | Create | direct-WS integration tests for the fresh-agent arm |
| `test/e2e-browser/fixtures/coding-cli/…/fake-app-server.mjs` (`test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`) | Modify | crash-on-marker behavior knob |
| `test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts` | Create | per-provider settings-survive-restart + codex degradation banner |
| `test/e2e-browser/playwright.config.ts` | Modify | register new spec in `RUST_ONLY_SPECS` + `rust-chromium` `testMatch` |
| `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` | Modify | flip/narrow the P1.13 freshopencode pin |

---

### Task 1: Ledger schema — resume-invocation record fields + fresh-agent upsert

**Files:**
- Modify: `crates/freshell-ws/src/pane_ledger.rs`
- Test: inline `#[cfg(test)] mod` in the same file (follow the existing test module, e.g. `record_binding_roundtrips_all_fields`)

**Interfaces:**
- Consumes: existing `BindingRow`, `RowState`, `PaneLedger` internals (`record_binding` at `pane_ledger.rs:315` is the structural donor).
- Produces (later tasks rely on these EXACT names):
  - `BindingRow` new pub fields: `pane_kind: Option<String>`, `model: Option<String>`, `sandbox: Option<String>`, `permission_mode: Option<String>`, `effort: Option<String>` (serde camelCase: `paneKind`, `model`, `sandbox`, `permissionMode`, `effort`).
  - `pub struct FreshAgentBindingWrite<'a>` (fields below).
  - `pub fn PaneLedger::record_fresh_agent_binding(&self, w: &FreshAgentBindingWrite<'_>) -> std::io::Result<()>`.

- [ ] **Step 1: Write the failing tests**

Add to the existing `#[cfg(test)]` module in `pane_ledger.rs` (reuse the module's existing temp-root helper — the same one `record_binding_roundtrips_all_fields` uses):

```rust
#[test]
fn fresh_agent_binding_roundtrips_settings_and_pane_kind() {
    let (ledger, _tmp) = test_ledger(); // the module's existing temp-root constructor helper
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite {
            provider: "codex",
            session_id: "thread-1",
            mode: "freshcodex",
            cwd: Some("/home/u/proj"),
            create_request_id: Some("req-1"),
            model: Some("gpt-5.3-codex"),
            sandbox: Some("workspace-write"),
            permission_mode: Some("on-request"),
            effort: Some("high"),
            now_ms: 1_000,
        })
        .unwrap();
    let row = ledger.load_binding("codex", "thread-1").expect("row");
    assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    assert_eq!(row.model.as_deref(), Some("gpt-5.3-codex"));
    assert_eq!(row.sandbox.as_deref(), Some("workspace-write"));
    assert_eq!(row.permission_mode.as_deref(), Some("on-request"));
    assert_eq!(row.effort.as_deref(), Some("high"));
    assert_eq!(row.cwd.as_deref(), Some("/home/u/proj"));
    assert_eq!(row.created_at, 1_000);
}

#[test]
fn fresh_agent_binding_upsert_preserves_created_at_and_refreshes_settings() {
    let (ledger, _tmp) = test_ledger();
    let base = FreshAgentBindingWrite {
        provider: "opencode",
        session_id: "ses_abc",
        mode: "freshopencode",
        cwd: Some("/w"),
        create_request_id: None,
        model: Some("m1"),
        sandbox: None,
        permission_mode: None,
        effort: Some("low"),
        now_ms: 1_000,
    };
    ledger.record_fresh_agent_binding(&base).unwrap();
    ledger
        .record_fresh_agent_binding(&FreshAgentBindingWrite { model: Some("m2"), effort: None, now_ms: 2_000, ..base })
        .unwrap();
    let row = ledger.load_binding("opencode", "ses_abc").expect("row");
    assert_eq!(row.created_at, 1_000, "upsert must preserve created_at");
    assert_eq!(row.updated_at, 2_000);
    assert_eq!(row.model.as_deref(), Some("m2"));
    assert_eq!(row.effort, None, "settings are a full snapshot, not a merge");
}

#[test]
fn old_terminal_rows_without_settings_fields_still_deserialize() {
    // A wave-A row serialized before this change has none of the new fields.
    let json = r#"{"ledgerVersion":1,"provider":"claude","sessionId":"s1","mode":"claude",
        "createdAt":1,"updatedAt":1,"lastObservedAt":1,"state":"bound"}"#;
    let row: BindingRow = serde_json::from_str(json).expect("old row must parse");
    assert_eq!(row.pane_kind, None);
    assert_eq!(row.model, None);
}
```

Note: for `FreshAgentBindingWrite` to support `..base` struct update, derive `Clone` and `Copy` is impossible (`&str` refs are Copy — `#[derive(Clone, Copy)]` works since all fields are `&str`/`Option<&str>`/`i64`). Derive `Debug, Clone, Copy`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws fresh_agent_binding`
Expected: COMPILE ERROR (`FreshAgentBindingWrite` and `record_fresh_agent_binding` not defined; `pane_kind` no field). A compile failure is the RED state for new-API tests.

- [ ] **Step 3: Implement**

(a) Append to `BindingRow` (after `superseded_by`), matching the existing serde style:

```rust
    /// "fresh-agent" for fresh-agent rows (P1.13); absent on terminal rows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pane_kind: Option<String>,
    /// Resume-invocation record (campaign plan §4.2): exactly what the
    /// provider-native resume command needs. Updated when the user changes
    /// them. All optional under LEDGER_VERSION 1 — no version bump.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
```

Fix every `BindingRow { … }` literal the compiler now flags (inside `record_binding`, `resolve_pending`, tests, etc.) by adding `pane_kind: None, model: None, sandbox: None, permission_mode: None, effort: None`.

(b) Add next to `BindingWrite`:

```rust
/// One fresh-agent identity event's worth of binding-row input (P1.13).
/// Settings are a FULL snapshot: callers always know the current values,
/// so writes replace rather than merge.
#[derive(Debug, Clone, Copy)]
pub struct FreshAgentBindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub mode: &'a str,
    pub cwd: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub model: Option<&'a str>,
    pub sandbox: Option<&'a str>,
    pub permission_mode: Option<&'a str>,
    pub effort: Option<&'a str>,
    pub now_ms: i64,
}
```

(c) Implement `record_fresh_agent_binding` by duplicating the structure of `record_binding` (`pane_ledger.rs:315`) — same disabled-root no-op, same in-memory index update, same atomic temp+rename+fsync persist path via the module's existing private row-persist helper — with these differences:
- Upsert keyed `(provider, session_id)`: if a row exists, keep its `created_at`; otherwise `created_at = w.now_ms`.
- Always set: `state: RowState::Bound`, `retired_reason: None`, `pane_kind: Some("fresh-agent".into())`, `updated_at = w.now_ms`, `last_observed_at = w.now_ms`, `live_terminal_id: None` (fresh-agent panes have no terminal), full settings snapshot from `w` (`model/sandbox/permission_mode/effort/cwd`), `create_request_id` from `w` (preserve the existing row's value when `w.create_request_id` is `None`), `superseded_by: None`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws pane_ledger`
Expected: PASS (all three new tests plus every pre-existing pane_ledger test).

- [ ] **Step 5: Quality gate + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/pane_ledger.rs
git commit -m "feat(ledger): resume-invocation record fields + fresh-agent binding upsert (P1.13)"
```

---

### Task 2: `PaneIdentitySink` trait in freshell-freshagent + state wiring points

**Files:**
- Create: `crates/freshell-freshagent/src/identity_sink.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (module decl + re-export)
- Modify: `crates/freshell-freshagent/src/codex.rs`, `crates/freshell-freshagent/src/opencode_ws.rs`, `crates/freshell-freshagent/src/claude.rs` (field + setter only in this task)
- Test: `#[cfg(test)]` in `identity_sink.rs`

**Interfaces:**
- Consumes: nothing repo-specific (leaf abstraction; `freshell-freshagent` must NOT gain a dependency on `freshell-ws`).
- Produces (exact, used by Tasks 3-10):

```rust
pub struct FreshAgentSettings {
    pub model: Option<String>,
    pub sandbox: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
}
pub struct FreshAgentBindingUpsert {
    pub provider: String,
    pub session_id: String,
    pub mode: String,
    pub create_request_id: Option<String>,
    pub resolves_pending: Option<String>,
    pub settings: FreshAgentSettings,
}
pub trait PaneIdentitySink: Send + Sync {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>);
    fn record_binding(&self, upsert: FreshAgentBindingUpsert);
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings>;
}
```
- Produces on each of `FreshCodexState`, `FreshOpencodeState`, `FreshClaudeState`:
  - `pub fn set_identity_sink(&self, sink: std::sync::Arc<dyn PaneIdentitySink>)`
  - private `fn identity_sink(&self) -> Option<std::sync::Arc<dyn PaneIdentitySink>>`

- [ ] **Step 1: Write the failing test**

Create `crates/freshell-freshagent/src/identity_sink.rs` with ONLY the test module first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn fake_sink_records_and_serves_settings() {
        let fake = Arc::new(FakeIdentitySink::default());
        fake.record_pending("freshopencode-r1", "freshopencode", Some("/w"));
        fake.record_binding(FreshAgentBindingUpsert {
            provider: "opencode".into(),
            session_id: "ses_1".into(),
            mode: "freshopencode".into(),
            create_request_id: Some("r1".into()),
            resolves_pending: Some("freshopencode-r1".into()),
            settings: FreshAgentSettings {
                model: Some("m".into()),
                sandbox: None,
                permission_mode: None,
                effort: Some("low".into()),
                cwd: Some("/w".into()),
            },
        });
        let s = fake.load_settings("opencode", "ses_1").expect("settings");
        assert_eq!(s.model.as_deref(), Some("m"));
        assert_eq!(s.effort.as_deref(), Some("low"));
        assert_eq!(fake.pendings.lock().unwrap().len(), 1);
        assert_eq!(fake.bindings.lock().unwrap().len(), 1);
        assert!(fake.load_settings("opencode", "nope").is_none());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-freshagent identity_sink`
Expected: COMPILE ERROR (types not defined).

- [ ] **Step 3: Implement the module**

Full content of `identity_sink.rs` above the test module:

```rust
//! P1.13 crate-boundary bridge: fresh-agent identity events flow OUT of this
//! crate through this trait; `freshell-server` implements it over the pane
//! ledger (this crate must not depend on `freshell-ws`, where the ledger
//! lives — the dependency edge runs the other way).

use std::sync::Arc;

/// Resume-invocation record (campaign plan §4.2): exactly what the
/// provider-native resume command needs.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct FreshAgentSettings {
    pub model: Option<String>,
    pub sandbox: Option<String>,
    pub permission_mode: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
}

/// One fresh-agent identity event. Settings are a FULL snapshot (replace,
/// not merge). `resolves_pending` names a pending marker (placeholder id)
/// this binding supersedes.
#[derive(Debug, Clone, PartialEq)]
pub struct FreshAgentBindingUpsert {
    pub provider: String,
    pub session_id: String,
    pub mode: String,
    pub create_request_id: Option<String>,
    pub resolves_pending: Option<String>,
    pub settings: FreshAgentSettings,
}

/// Fire-and-forget writes (implementations must not block the caller;
/// ledger fsync work belongs on `spawn_blocking`), memory-fast reads.
pub trait PaneIdentitySink: Send + Sync {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>);
    fn record_binding(&self, upsert: FreshAgentBindingUpsert);
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings>;
}

pub type SharedPaneIdentitySink = Arc<dyn PaneIdentitySink>;

/// In-memory sink for tests, crate-wide.
#[cfg(test)]
#[derive(Default)]
pub(crate) struct FakeIdentitySink {
    pub pendings: std::sync::Mutex<Vec<(String, String, Option<String>)>>,
    pub bindings: std::sync::Mutex<Vec<FreshAgentBindingUpsert>>,
    pub settings: std::sync::Mutex<std::collections::HashMap<(String, String), FreshAgentSettings>>,
}

#[cfg(test)]
impl FakeIdentitySink {
    pub fn seed(&self, provider: &str, session_id: &str, s: FreshAgentSettings) {
        self.settings.lock().unwrap().insert((provider.into(), session_id.into()), s);
    }
}

#[cfg(test)]
impl PaneIdentitySink for FakeIdentitySink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) {
        self.pendings.lock().unwrap().push((placeholder_id.into(), mode.into(), cwd.map(Into::into)));
    }
    fn record_binding(&self, upsert: FreshAgentBindingUpsert) {
        self.settings
            .lock()
            .unwrap()
            .insert((upsert.provider.clone(), upsert.session_id.clone()), upsert.settings.clone());
        self.bindings.lock().unwrap().push(upsert);
    }
    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        self.settings.lock().unwrap().get(&(provider.into(), session_id.into())).cloned()
    }
}
```

In `lib.rs`: `pub mod identity_sink;` and `pub use identity_sink::{FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, SharedPaneIdentitySink};`

On EACH of the three states (`FreshCodexState`, `FreshOpencodeState`, `FreshClaudeState`) add a clone-shared, set-once field (states are cloned into consumer tasks, so the `OnceLock` must sit behind an `Arc`):

```rust
identity_sink: std::sync::Arc<std::sync::OnceLock<SharedPaneIdentitySink>>,
```

Initialize `identity_sink: Arc::new(OnceLock::new())` in each constructor, and add to each state:

```rust
pub fn set_identity_sink(&self, sink: SharedPaneIdentitySink) {
    let _ = self.identity_sink.set(sink);
}
fn identity_sink(&self) -> Option<SharedPaneIdentitySink> {
    self.identity_sink.get().cloned()
}
```

(Precedent for the post-construction setter: `TerminalRegistry::set_activity_observer`, wired at `freshell-server/src/main.rs:408`. Clippy will demand `#[allow(dead_code)]` or usage — the private getter is used starting Task 4; if clippy `-D warnings` flags it in this task, mark the getter `pub(crate)` and add a `// used by identity-event tasks` comment rather than suppressing.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent identity_sink && cargo test -p freshell-freshagent`
Expected: PASS, no regressions.

- [ ] **Step 5: Quality gate + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/identity_sink.rs crates/freshell-freshagent/src/lib.rs \
        crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs \
        crates/freshell-freshagent/src/claude.rs
git commit -m "feat(freshagent): PaneIdentitySink trait - crate-boundary bridge for the pane ledger (P1.13)"
```

---

### Task 3: `LedgerIdentitySink` in freshell-server + main.rs injection

**Files:**
- Create: `crates/freshell-server/src/identity_sink.rs`
- Modify: `crates/freshell-server/src/main.rs`
- Test: `#[cfg(test)]` in `crates/freshell-server/src/identity_sink.rs`

**Interfaces:**
- Consumes: `PaneLedger::{record_pending, record_fresh_agent_binding, delete_pending, load_binding}` (Task 1), `freshell_freshagent::{PaneIdentitySink, FreshAgentBindingUpsert, FreshAgentSettings}` (Task 2).
- Produces: `pub struct LedgerIdentitySink; pub fn LedgerIdentitySink::new(ledger: Arc<PaneLedger>) -> Self`.

- [ ] **Step 1: Write the failing test**

In the new file's test module (async because writes hop through `spawn_blocking`):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use freshell_freshagent::{FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink};
    use std::sync::Arc;
    use std::time::Duration;

    #[tokio::test(flavor = "multi_thread")]
    async fn writes_through_to_ledger_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf())));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "codex".into(),
            session_id: "t1".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            settings: FreshAgentSettings {
                model: Some("gpt-5.3-codex".into()),
                sandbox: Some("workspace-write".into()),
                permission_mode: Some("on-request".into()),
                effort: None,
                cwd: Some("/w".into()),
            },
        });
        // record_binding is fire-and-forget via spawn_blocking: poll.
        let mut got = None;
        for _ in 0..50 {
            if let Some(s) = sink.load_settings("codex", "t1") { got = Some(s); break; }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let s = got.expect("binding visible within 1s");
        assert_eq!(s.model.as_deref(), Some("gpt-5.3-codex"));
        assert_eq!(s.sandbox.as_deref(), Some("workspace-write"));
        let row = ledger.load_binding("codex", "t1").unwrap();
        assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    }
}
```

(If `tempfile` is not already a dev-dependency of `freshell-server`, add it to `[dev-dependencies]` — check how the existing `existence.rs` tests create temp dirs and reuse that helper instead if one exists.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-server identity_sink`
Expected: COMPILE ERROR (module/type not defined).

- [ ] **Step 3: Implement**

`crates/freshell-server/src/identity_sink.rs`:

```rust
//! Server-side implementation of the fresh-agent identity bridge (P1.13):
//! freshell-freshagent cannot see the ledger (crate cycle), so main.rs
//! injects this adapter at wiring time.

use freshell_freshagent::{FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink};
use freshell_ws::pane_ledger::{FreshAgentBindingWrite, PaneLedger};
use std::sync::Arc;

pub struct LedgerIdentitySink {
    ledger: Arc<PaneLedger>,
}

impl LedgerIdentitySink {
    pub fn new(ledger: Arc<PaneLedger>) -> Self {
        Self { ledger }
    }
}

fn now_ms() -> i64 {
    // Match the timestamp convention main.rs already uses for ledger writes
    // (see the boot-scan / record_binding call sites in main.rs).
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl PaneIdentitySink for LedgerIdentitySink {
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) {
        let ledger = self.ledger.clone();
        let (p, m, c) = (placeholder_id.to_string(), mode.to_string(), cwd.map(str::to_string));
        tokio::task::spawn_blocking(move || {
            if let Err(e) = ledger.record_pending(&p, &m, c.as_deref(), now_ms()) {
                tracing::warn!(error = %e, placeholder = %p, "pane_ledger.fresh_agent.pending_write_failed");
            }
        });
    }

    fn record_binding(&self, upsert: FreshAgentBindingUpsert) {
        let ledger = self.ledger.clone();
        tokio::task::spawn_blocking(move || {
            let w = FreshAgentBindingWrite {
                provider: &upsert.provider,
                session_id: &upsert.session_id,
                mode: &upsert.mode,
                cwd: upsert.settings.cwd.as_deref(),
                create_request_id: upsert.create_request_id.as_deref(),
                model: upsert.settings.model.as_deref(),
                sandbox: upsert.settings.sandbox.as_deref(),
                permission_mode: upsert.settings.permission_mode.as_deref(),
                effort: upsert.settings.effort.as_deref(),
                now_ms: now_ms(),
            };
            if let Err(e) = ledger.record_fresh_agent_binding(&w) {
                tracing::warn!(error = %e, provider = %upsert.provider, session = %upsert.session_id,
                    "pane_ledger.fresh_agent.binding_write_failed");
            }
            if let Some(p) = upsert.resolves_pending.as_deref() {
                if let Err(e) = ledger.delete_pending(p) {
                    tracing::warn!(error = %e, placeholder = %p, "pane_ledger.fresh_agent.pending_delete_failed");
                }
            }
        });
    }

    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        // Reads are memory-only against the write-through index — safe inline.
        let row = self.ledger.load_binding(provider, session_id)?;
        Some(FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
        })
    }
}
```

In `main.rs`: add `mod identity_sink;`, then AFTER the ledger is constructed (`main.rs:426-429`) inject into the three provider states (they are constructed earlier, at `main.rs:209/219/234/239` — the post-construction setter exists precisely for this ordering):

```rust
let fresh_agent_identity_sink: freshell_freshagent::SharedPaneIdentitySink =
    std::sync::Arc::new(identity_sink::LedgerIdentitySink::new(pane_ledger.clone()));
fresh_codex.set_identity_sink(fresh_agent_identity_sink.clone());
fresh_claude.set_identity_sink(fresh_agent_identity_sink.clone());
fresh_opencode.set_identity_sink(fresh_agent_identity_sink.clone());
```

(Use the actual local variable names from main.rs — the states are the ones placed into `WsState` fields `fresh_codex` / `fresh_claude` / `fresh_opencode`; if `WsState` is already constructed by line 426, call the setters on the state handles before they're moved, or via `state.fresh_codex.set_identity_sink(...)` — the field is `Arc<OnceLock>` so either handle works. `pane_ledger` in main.rs may be a value, not `Arc` — wrap once: `let pane_ledger = Arc::new(pane_ledger);` mirroring how `session_existence` receives it at `main.rs:440-449`, adapting the `WsState` field if it takes the Arc.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server identity_sink && cargo test -p freshell-server`
Expected: PASS.

- [ ] **Step 5: Quality gate + commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-server/src/identity_sink.rs crates/freshell-server/src/main.rs \
        crates/freshell-server/Cargo.toml
git commit -m "feat(server): wire pane ledger into fresh-agent states via LedgerIdentitySink (P1.13)"
```

---

### Task 4: Codex — ledger writes at every identity event

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs`
- Test: inline `#[cfg(test)]` tests in `codex.rs` (harness: `ENV_LOCK` + `configure_fake_codex_cmd` at `codex.rs:4975/4979`, `create_real_fake_session` at `:4988`)

**Interfaces:**
- Consumes: `FakeIdentitySink` / `set_identity_sink` (Task 2). `CodexSession` fields (`codex.rs:163-199`): `model: String`, `effort: Option<String>`, `cwd: Option<String>`, `sandbox: Option<String>`, `permission_mode: Option<String>`.
- Produces: private helper `fn record_codex_binding(&self, session_id: &str, create_request_id: Option<&str>, model: &str, sandbox: Option<&str>, permission_mode: Option<&str>, effort: Option<&str>, cwd: Option<&str>)` on `FreshCodexState`, called at all five identity sites. Codex ledger rows use `provider: "codex"`, `mode: "freshcodex"`.

- [ ] **Step 1: Write the failing test**

Add near the existing create tests (using the module's existing fake-app-server harness — model the setup on the test at `codex.rs:5145`'s sibling create tests / `create_real_fake_session`):

```rust
#[tokio::test(flavor = "multi_thread")]
async fn create_records_fresh_agent_binding_with_settings() {
    let _guard = ENV_LOCK.lock().await;
    configure_fake_codex_cmd(/* default behavior json the existing create tests use */);
    let (state, _bus) = state_with_bus();
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(fake.clone());

    // Drive a real create through the fake app server, requesting explicit
    // settings — reuse create_real_fake_session, passing model/sandbox if it
    // accepts them, otherwise inline the same freshAgent.create the existing
    // create tests send, with:
    //   model: "gpt-5.3-codex", sandbox: "workspace-write",
    //   permissionMode: "on-request", effort: "high", cwd: <tmp dir>
    let thread_id = create_real_fake_session(&state /* …with settings… */).await;

    let bindings = fake.bindings.lock().unwrap();
    let b = bindings.iter().find(|b| b.session_id == thread_id).expect("binding row written at thread/start");
    assert_eq!(b.provider, "codex");
    assert_eq!(b.mode, "freshcodex");
    assert_eq!(b.settings.model.as_deref(), Some("gpt-5.3-codex"));
    assert_eq!(b.settings.sandbox.as_deref(), Some("workspace-write"));
    assert_eq!(b.settings.permission_mode.as_deref(), Some("on-request"));
    assert_eq!(b.settings.effort.as_deref(), Some("high"));
}
```

(The comment lines describe which existing helper to reuse — the implementer replaces them with the harness's real invocation, keeping the four explicit settings values and all five assertions exactly as written. The existing create tests in `codex.rs` show the exact `freshAgent.create` message shape; wire params are camelCase: `requestId`, `sessionType`, `cwd`, `model`, `permissionMode`, `sandbox`, `effort`, `resumeSessionId`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-freshagent create_records_fresh_agent_binding`
Expected: FAIL — `bindings` is empty (no ledger write exists yet).

- [ ] **Step 3: Implement**

(a) Add the shared helper on `FreshCodexState`:

```rust
fn record_codex_binding(
    &self,
    session_id: &str,
    create_request_id: Option<&str>,
    model: &str,
    sandbox: Option<&str>,
    permission_mode: Option<&str>,
    effort: Option<&str>,
    cwd: Option<&str>,
) {
    let Some(sink) = self.identity_sink() else { return };
    sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
        provider: "codex".into(),
        session_id: session_id.into(),
        mode: "freshcodex".into(),
        create_request_id: create_request_id.map(Into::into),
        resolves_pending: None,
        settings: crate::identity_sink::FreshAgentSettings {
            model: if model.is_empty() { None } else { Some(model.into()) },
            sandbox: sandbox.map(Into::into),
            permission_mode: permission_mode.map(Into::into),
            effort: effort.map(Into::into),
            cwd: cwd.map(Into::into),
        },
    });
}
```

(b) Call it immediately after each of the five `sessions.insert` construction sites, passing that site's just-inserted values:
1. `finish_create` (`codex.rs:603-619`) — the healthy create; `session_id` = `started.thread_id` (durable at create, born at `codex.rs:398`); `create_request_id` = the create message's `requestId`.
2. `handle_create_resume` (R1, `codex.rs:462`…).
3. `ensure_session_alive` (R2, `codex.rs:1064`…) — refresh write, same id.
4. `ensure_session_resumable` (R3, `codex.rs:1675`…) — refresh write (its settings become real in Task 5).
5. `respawn_as_new_thread_after_crash` (`codex.rs:1283`, re-key at `:1325-1347`) — NEW row under the new thread id (`codex.rs:1307`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent codex`
Expected: PASS (new test + all existing codex tests).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/codex.rs
git commit -m "feat(codex): write fresh-agent ledger binding rows at every identity event (P1.13)"
```

---

### Task 5: Codex — settings-from-ledger on all three resume paths + SETTINGS_RESET alarm

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs`
- Test: inline `#[cfg(test)]` in `codex.rs`

**Interfaces:**
- Consumes: `identity_sink().load_settings("codex", id)` (Task 2); fake app server request recorder (`appendThreadOperationLogPath` → JSONL `{method, threadId, params}` per `thread/*` RPC, `fake-app-server.mjs:360-374`; behavior via `FAKE_CODEX_APP_SERVER_BEHAVIOR`).
- Produces: private `fn emit_fresh_agent_error(&self, session_id: &str, code: &str, message: &str)` on `FreshCodexState`; alarm code string `"SETTINGS_RESET"` (shared vocabulary with Tasks 8 and 10).

**Known defect being fixed:** `ensure_session_resumable` (`codex.rs:1675`, restart/reload path — reached from attach-untracked `:1017` and REST snapshot `:1584`) resumes with `model/sandbox/approval_policy = None` (`:1721-1727`) and registers `model: String::new(), effort/sandbox/permission_mode: None` (`:1791-1799`); every post-restart turn silently runs on defaults forever.

- [ ] **Step 1: Write the failing tests**

```rust
#[tokio::test(flavor = "multi_thread")]
async fn resume_after_restart_reapplies_settings_from_ledger() {
    let _guard = ENV_LOCK.lock().await;
    // Behavior JSON: thread/resume succeeds; include appendThreadOperationLogPath
    // pointing at a temp file (the existing consumer of this knob is
    // test/integration/server/codex-session-flow.test.ts:497 — copy the JSON shape).
    let op_log = tempfile::NamedTempFile::new().unwrap();
    configure_fake_codex_cmd(/* behavior json with appendThreadOperationLogPath = op_log.path() */);
    let (state, _bus) = state_with_bus();
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    fake.seed("codex", "thread-9", crate::identity_sink::FreshAgentSettings {
        model: Some("gpt-5.3-codex".into()),
        sandbox: Some("workspace-write".into()),
        permission_mode: Some("on-request".into()),
        effort: Some("high".into()),
        cwd: Some("/w".into()),
    });
    state.set_identity_sink(fake.clone());

    // Simulate the restart path exactly as the existing R3 tests do
    // (handle_attach_unknown_session_* at codex.rs:3751/3793/3832/3862):
    // attach to "thread-9" which is NOT in the in-memory map.
    // <invoke the same entry point those tests use>

    // (1) The registered session carries the recovered settings:
    let sessions = state.sessions.lock().await;
    let s = sessions.get("thread-9").expect("session registered");
    assert_eq!(s.model, "gpt-5.3-codex");
    assert_eq!(s.sandbox.as_deref(), Some("workspace-write"));
    assert_eq!(s.permission_mode.as_deref(), Some("on-request"));
    assert_eq!(s.effort.as_deref(), Some("high"));
    drop(sessions);

    // (2) The thread/resume RPC itself carried them (the wire is the contract):
    let log = std::fs::read_to_string(op_log.path()).unwrap();
    let resume_line = log.lines().find(|l| l.contains("\"thread/resume\"")).expect("thread/resume logged");
    let entry: serde_json::Value = serde_json::from_str(resume_line).unwrap();
    assert_eq!(entry["params"]["model"], "gpt-5.3-codex");
    assert_eq!(entry["params"]["sandbox"], "workspace-write");
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_with_no_ledger_record_emits_settings_reset_alarm() {
    let _guard = ENV_LOCK.lock().await;
    configure_fake_codex_cmd(/* resume-succeeds behavior */);
    let (state, mut bus_rx) = state_with_bus(); // subscribe to the broadcast bus
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default()); // deliberately empty
    state.set_identity_sink(fake);

    // Same R3 entry point as above for an untracked "thread-x".

    // Drain broadcast frames (bounded) and find the alarm:
    let mut found = false;
    while let Ok(frame) = tokio::time::timeout(std::time::Duration::from_secs(2), bus_rx.recv()).await {
        let Ok(text) = frame else { break };
        if text.contains("SETTINGS_RESET") { found = true; break; }
    }
    assert!(found, "missing-record resume must broadcast a SETTINGS_RESET freshAgent.error");
}
```

(The `<invoke the same entry point those tests use>` comments direct the implementer to the exact donor tests at `codex.rs:3751-3862`; the assertions are the contract and must remain exactly as written. If `sessions` is not directly readable from tests, reuse whatever accessor those donor tests use to inspect registered sessions.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-freshagent resume_after_restart_reapplies_settings`
Expected: FAIL — registered session has `model == ""` and the op-log resume params lack model/sandbox. The alarm test FAILS with no SETTINGS_RESET frame.

- [ ] **Step 3: Implement**

(a) Alarm helper on `FreshCodexState` — deliver through the same broadcast path the consumer already uses to forward sidecar-originated `freshAgent.error` events to clients (locate the consumer's event forwarding; the frame on the wire must be byte-compatible with a sidecar-produced error event so the frozen client's banner path fires). The event payload is exactly:

```json
{ "type": "freshAgent.error", "sessionId": "<id>", "code": "<code>", "message": "<message>" }
```

```rust
fn emit_fresh_agent_error(&self, session_id: &str, code: &str, message: &str) {
    // Build the envelope the same way the consumer forwards sidecar events
    // (same outer frame the client's fresh-agent-ws.ts event router reads),
    // with the payload above, and send it via self.broadcast / broadcast_tx.
}
```

(b) `ensure_session_resumable` (R3): before issuing `thread/resume`, load the record:

```rust
let recovered = self.identity_sink().and_then(|s| s.load_settings("codex", durable_id));
if recovered.is_none() {
    tracing::warn!(session = %durable_id, "freshagent.codex.settings_record_missing");
    self.emit_fresh_agent_error(
        durable_id,
        "SETTINGS_RESET",
        "Session settings could not be recovered after restart - the agent is running with default model and permissions. Reconfirm your settings.",
    );
}
let rec = recovered.unwrap_or_default();
```

Then replace the three `None`s at `:1721-1727` with `rec.model` / `rec.sandbox` / `rec.permission_mode` (the resume request's approval-policy param) — and pass `rec.effort` wherever the healthy create passes effort. Replace the blank registration at `:1791-1799` with `model: rec.model.clone().unwrap_or_default(), sandbox: rec.sandbox.clone(), permission_mode: rec.permission_mode.clone(), effort: rec.effort.clone(), cwd: <existing cwd source>.or(rec.cwd.clone())`. Delete the stale comment claiming `handle_send` repairs settings (it only reads, `:733-777`). The Task-4 `record_codex_binding` call at this site now persists the recovered values.

(c) `ensure_session_alive` (R2): where it forwards stored settings, add a ledger fallback for the blank case:

```rust
let (model, sandbox, permission_mode, effort) = if session_model.is_empty() {
    let rec = self.identity_sink().and_then(|s| s.load_settings("codex", durable_id)).unwrap_or_default();
    (rec.model.unwrap_or_default(), rec.sandbox, rec.permission_mode, rec.effort)
} else {
    (session_model, session_sandbox, session_permission_mode, session_effort)
};
```

(d) `handle_create_resume` (R1): the client's explicit params win; ledger fills gaps:

```rust
let rec = self.identity_sink().and_then(|s| s.load_settings("codex", resume_id)).unwrap_or_default();
let model = msg_model.or(rec.model);
let sandbox = msg_sandbox.or(rec.sandbox);
let permission_mode = msg_permission_mode.or(rec.permission_mode);
let effort = msg_effort.or(rec.effort);
let cwd = msg_cwd.or(rec.cwd);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent codex`
Expected: PASS (both new tests + all existing codex tests, including the existing R2/R3 fallback tests — if an existing test pinned the blank-registration behavior, update its assertions to the new contract and say so in the commit body).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/codex.rs
git commit -m "fix(codex): resume paths reapply model/sandbox/permission/effort from the ledger record (P1.13 §2.6c)"
```

---

### Task 6: Codex — crash-respawn degradation frame (memory loss is user-visible)

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs`
- Test: extend the existing crash tests (`send_after_crash_falls_back_to_mint_new_thread…` at `codex.rs:5145`, siblings at `:5224/:4625`)

**Interfaces:**
- Consumes: `emit_fresh_agent_error` (Task 5), `record_codex_binding` (Task 4).
- Produces: alarm code string `"THREAD_MEMORY_LOST"`.

**Known defect being fixed:** `respawn_as_new_thread_after_crash` (`codex.rs:1283`) silently discards conversation memory — the only signal is `tracing::warn!(… "freshagent.crash_recovery.minted_new")` at `:1362-1366`, server-log only.

- [ ] **Step 1: Write the failing test**

Extend (or clone-and-extend) `send_after_crash_falls_back_to_mint_new_thread…` (`codex.rs:5145`): after driving the crash-respawn, drain the broadcast bus and assert a `THREAD_MEMORY_LOST` frame was emitted with the NEW thread id, AFTER the `freshAgent.session.materialized` frame:

```rust
// … existing test body up to the respawn assertion, keeping a bus receiver …
let mut saw_materialized = false;
let mut degradation_after_materialized = false;
while let Ok(frame) = tokio::time::timeout(std::time::Duration::from_secs(2), bus_rx.recv()).await {
    let Ok(text) = frame else { break };
    if text.contains("freshAgent.session.materialized") { saw_materialized = true; }
    if text.contains("THREAD_MEMORY_LOST") {
        assert!(saw_materialized, "degradation frame must follow materialized (client re-keys on it)");
        assert!(text.contains(&new_thread_id), "frame must target the NEW thread id");
        degradation_after_materialized = true;
        break;
    }
}
assert!(degradation_after_materialized, "crash respawn must broadcast a user-visible degradation frame");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-freshagent send_after_crash`
Expected: FAIL — no `THREAD_MEMORY_LOST` frame.

- [ ] **Step 3: Implement**

In `respawn_as_new_thread_after_crash`, in the gap between the map re-key (`:1325-1347`) and the existing `warn!` (`:1348-1361`), keep the `warn!`, and AFTER the `FreshAgentSessionMaterialized` broadcast (`:1368`) add:

```rust
self.emit_fresh_agent_error(
    &new_thread_id,
    "THREAD_MEMORY_LOST",
    "Codex crashed and this pane was restarted as a new thread. The agent no longer has memory of the earlier conversation in this pane.",
);
```

(Order matters: the frozen client re-keys its session state on `materialized` (`fresh-agent-ws.ts:143-160`); emitting the error first would target a session id the client no longer tracks. The non-`RESTORE_` error branch also clears streaming and forces `running → idle` — safe here, the turn is already dead. The Task-4 binding write for the new thread id sits at the same site.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent codex`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/codex.rs
git commit -m "feat(codex): user-visible THREAD_MEMORY_LOST degradation frame on crash respawn (P1.13 §2.6b)"
```

---

### Task 7: Opencode — pending marker + binding writes + settings-change updates

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs`
- Test: inline `#[cfg(test)]` using the existing in-crate trait fakes (`FakeHttp` etc. at `opencode_ws.rs:866-1076`, harnesses `:1080-1111`)

**Interfaces:**
- Consumes: `set_identity_sink`/`FakeIdentitySink` (Task 2). Sites: create `handle_create` (`opencode_ws.rs:243-247`, placeholder `freshopencode-<requestId>` at `:245`); materialization (durable `ses_*` id assigned `:359`, cwd upgraded `:360-364`, `freshAgent.session.materialized` broadcast `:373-384`); settings commit in `handle_send` (`session.model = model; session.effort = effort;` at `:397-398`).
- Produces: opencode ledger rows use `provider: "opencode"`, `mode: "freshopencode"`.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn materialization_resolves_pending_into_binding_with_settings() {
    // Harness: same FakeHttp setup the existing materialization test uses.
    let (state, /* … */) = harness(/* … */);
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(fake.clone());

    // Create with settings, then first send (materializes ses_*):
    // freshAgent.create { requestId: "r1", sessionType: "freshopencode",
    //                     cwd: "/w", model: "big-model", effort: "high" }
    // then freshAgent.send — reuse the existing test's driver.

    // Pending was recorded at create under the placeholder:
    let pendings = fake.pendings.lock().unwrap();
    assert!(pendings.iter().any(|(id, mode, _)| id.starts_with("freshopencode-") && mode == "freshopencode"));
    drop(pendings);

    // Binding recorded at materialization, resolving the pending:
    let bindings = fake.bindings.lock().unwrap();
    let b = bindings.iter().find(|b| b.session_id.starts_with("ses_")).expect("binding at materialization");
    assert_eq!(b.provider, "opencode");
    assert_eq!(b.settings.model.as_deref(), Some("big-model"));
    assert_eq!(b.settings.effort.as_deref(), Some("high"));
    assert!(b.settings.cwd.is_some(), "cwd captured (upgraded from created.directory)");
    assert!(b.resolves_pending.as_deref().unwrap_or("").starts_with("freshopencode-"));
}

#[tokio::test]
async fn send_with_changed_settings_refreshes_the_binding() {
    // Same harness; after materialization, send again with
    // settings: { model: "small-model", effort: "low" } (FreshAgentSendSettings,
    // consumed per-turn at opencode_ws.rs:315-327).
    // Assert the LAST recorded binding for the ses_* id carries the new values:
    let bindings = fake.bindings.lock().unwrap();
    let b = bindings.iter().rev().find(|b| b.session_id.starts_with("ses_")).unwrap();
    assert_eq!(b.settings.model.as_deref(), Some("small-model"));
    assert_eq!(b.settings.effort.as_deref(), Some("low"));
}
```

(Driver plumbing comes from the existing tests in this file — e.g. the materialization/send tests around the harnesses at `:1080-1111` and `:1795-1819`; the assertions stand as written.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-freshagent opencode_ws -- materialization_resolves_pending send_with_changed_settings`
Expected: FAIL — no pendings, no bindings recorded.

- [ ] **Step 3: Implement**

1. `handle_create` (`:243-247`): after registering the placeholder session:
```rust
if let Some(sink) = self.identity_sink() {
    sink.record_pending(&placeholder_id, "freshopencode", session_cwd.as_deref());
}
```
2. Materialization (`:359-369`, right after the durable id is assigned and cwd upgraded, before/alongside the `materialized` broadcast):
```rust
if let Some(sink) = self.identity_sink() {
    sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
        provider: "opencode".into(),
        session_id: durable_id.clone(),
        mode: "freshopencode".into(),
        create_request_id: Some(request_id.clone()),
        resolves_pending: Some(placeholder_id.clone()),
        settings: crate::identity_sink::FreshAgentSettings {
            model: session.model.clone(),
            sandbox: None,
            permission_mode: None,
            effort: session.effort.clone(),
            cwd: session.cwd.clone(),
        },
    });
}
```
(Adapt local variable names at the site; opencode has no sandbox/permission concepts — always `None`.)
3. `handle_send` commit (`:397-398`): after `session.model = model.clone(); session.effort = effort.clone();`, if the session id is durable (`starts_with("ses_")`), record a refresh binding (same construction as above with `resolves_pending: None`, `create_request_id: None`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent opencode_ws`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "feat(opencode): pending marker at create, binding row at ses_* materialization, refresh on settings change (P1.13)"
```

---

### Task 8: Opencode — settings-from-ledger resume

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `load_settings("opencode", id)` (Task 2); `emit`-style broadcast via `FreshOpencodeState::broadcast` (`opencode_ws.rs:194-196`); alarm code `"SETTINGS_RESET"` (same vocabulary as Task 5).
- Site: `resume_durable_session` (`opencode_ws.rs:662-696`) — sole caller `handle_attach` (`:598-600`).

**Known defect being fixed:** `resume_durable_session` builds `OpencodeSession::new(session_id, cwd.map(...), None, None)` at `:681` — model and effort hard-`None`; `cwd` comes from the attach message, not the session's real directory; the serve `GET /session/:id` body is fetched then discarded at `:678` (`let _ = info;`).

- [ ] **Step 1: Write the failing tests**

Clone the key resume test `attach_unknown_session_resumes_a_durable_serve_session_not_in_the_local_map` (`opencode_ws.rs:1523-1588`) into:

```rust
#[tokio::test]
async fn resume_durable_session_reapplies_settings_from_ledger() {
    // Same RealisticServeHttp harness as the donor test.
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    fake.seed("opencode", DURABLE_ID, crate::identity_sink::FreshAgentSettings {
        model: Some("big-model".into()),
        sandbox: None,
        permission_mode: None,
        effort: Some("high".into()),
        cwd: Some("/real/project".into()),
    });
    state.set_identity_sink(fake);

    // Drive the same attach the donor test drives.

    let sessions = state.sessions.lock().await;
    let s = sessions.get(DURABLE_ID).expect("resumed").lock().await;
    assert_eq!(s.model.as_deref(), Some("big-model"));
    assert_eq!(s.effort.as_deref(), Some("high"));
    assert_eq!(s.cwd.as_deref(), Some("/real/project"), "cwd from the record, not the attach message");
}

#[tokio::test]
async fn resume_without_record_emits_settings_reset_and_uses_serve_directory() {
    // Same harness; NO seed. RealisticServeHttp's GET /session/:id returns a
    // directory — assert it is now used instead of being discarded, and that
    // a SETTINGS_RESET freshAgent.error frame was broadcast.
    // (bus subscription pattern as in Task 5's alarm test)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-freshagent resume_durable_session_reapplies`
Expected: FAIL — model/effort are `None`, cwd is the attach message's.

- [ ] **Step 3: Implement**

In `resume_durable_session` (`:662-696`):

```rust
let recovered = self.identity_sink().and_then(|s| s.load_settings("opencode", &session_id));
if recovered.is_none() {
    tracing::warn!(session = %session_id, "freshagent.opencode.settings_record_missing");
    self.emit_fresh_agent_error(
        &session_id,
        "SETTINGS_RESET",
        "Session settings could not be recovered after restart - the agent is running with default model and effort. Reconfirm your settings.",
    );
}
let rec = recovered.unwrap_or_default();
// :678 — stop discarding the serve body; parse its `directory` field:
let serve_dir = info_directory; // extract from `info` instead of `let _ = info;`
let cwd = rec.cwd.clone().or(serve_dir).or(attach_msg_cwd);
let session = OpencodeSession::new(session_id.clone(), cwd, rec.model.clone(), rec.effort.clone());
```

(`emit_fresh_agent_error` is a small helper mirroring Task 5's codex helper — same name, same `freshAgent.error` payload shape — built on `FreshOpencodeState::broadcast`. Model/effort take effect on the next turn because opencode sends them per-turn in the `prompt_async` body, `serve.rs:936-953` — the session fields are the source those sends read, plus Task 7's refresh keeps the ledger current.) After a successful resume, record a refresh binding (Task 7 construction, `resolves_pending: None`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent opencode_ws`
Expected: PASS (donor test still green — it asserted resume works, not that settings are empty; if it pinned `None` settings, update it to the new contract and note that in the commit body).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "fix(opencode): resume reapplies model/effort/cwd from the ledger record (P1.13 §2.7b)"
```

---

### Task 9: Claude — binding writes at `sdk.session.init` (settings threaded to the consumer)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs`
- Test: inline `#[cfg(test)]` using `FakeClaudeSidecarEnv` (`claude.rs:1518-1578`) + `CLAUDE_ENV_LOCK` (`:1463`)

**Interfaces:**
- Consumes: Task 2 sink. Sites: healthy create request built inline in `handle_create` (`claude.rs:216-225`, keys `cwd`, `model`, `permissionMode`, `effort`, `resumeSessionId`); `sdk.session.init` handled in `spawn_consumer`'s task (cliSessionId recorded into `cli_index`, `claude.rs:605-618`; in scope there: `broadcast_tx`, `sessions`, `cli_index` clones at `:593-595`).
- Produces: `spawn_consumer` gains two params: `mode: String` (from `session_type_str`, `claude.rs:700-705` — preserves the `"freshclaude"` vs `"kilroy"` flavour; provider is always `"claude"`, `claude.rs:66`) and `settings: crate::identity_sink::FreshAgentSettings`. All `spawn_consumer` call sites updated.

- [ ] **Step 1: Write the failing test**

Model on the existing create tests that use `FakeClaudeSidecarEnv`:

```rust
#[tokio::test(flavor = "multi_thread")]
async fn session_init_records_binding_with_create_settings() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::new(/* as the donor create test does */);
    let (state, /* … */) = /* donor harness */;
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    state.set_identity_sink(fake.clone());

    // Drive freshAgent.create with:
    //   sessionType: "kilroy", model: "opus-x", permissionMode: "plan",
    //   effort: "high", cwd: <tmp>
    // and wait for sdk.session.init to be consumed (donor tests show the wait).

    let bindings = fake.bindings.lock().unwrap();
    let b = bindings.last().expect("binding at sdk.session.init");
    assert_eq!(b.provider, "claude");
    assert_eq!(b.mode, "kilroy", "sessionType flavour preserved in the row");
    assert!(b.session_id.len() > 0, "keyed by cliSessionId");
    assert_eq!(b.settings.model.as_deref(), Some("opus-x"));
    assert_eq!(b.settings.permission_mode.as_deref(), Some("plan"));
    assert_eq!(b.settings.effort.as_deref(), Some("high"));
    assert!(b.settings.cwd.is_some());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-freshagent session_init_records_binding`
Expected: FAIL — no bindings recorded.

- [ ] **Step 3: Implement**

1. In `handle_create`: build `let settings = crate::identity_sink::FreshAgentSettings { model: msg.model.clone(), sandbox: None, permission_mode: msg.permission_mode.clone(), effort: msg.effort.clone(), cwd: resolved_cwd.clone() };` (claude has no sandbox concept — always `None`; use the resolved cwd the create request actually sends at `:216-225`). Pass `session_type_str(&msg).to_string()` and `settings` into `spawn_consumer`.
2. In `spawn_consumer`'s `sdk.session.init` arm (`:605-618`), after `cli_index` is updated:
```rust
if let Some(sink) = identity_sink.clone() { // clone the Option<Arc> into the task alongside broadcast_tx/sessions/cli_index
    sink.record_binding(crate::identity_sink::FreshAgentBindingUpsert {
        provider: "claude".into(),
        session_id: cli_session_id.clone(),
        mode: mode.clone(),
        create_request_id: None,
        resolves_pending: None,
        settings: settings.clone(),
    });
}
```
3. Update every `spawn_consumer` call site (create and resume paths) — the resume path passes the settings it resolves in Task 10; until Task 10 lands, pass `FreshAgentSettings::default()` there so this task compiles and its test passes.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent claude`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/claude.rs
git commit -m "feat(claude): record fresh-agent binding row with create settings at sdk.session.init (P1.13)"
```

---

### Task 10: Claude — settings-from-ledger resume

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `load_settings("claude", durable)` (Task 2); the fake sidecar spawn log — the scripted Node fake logs the WHOLE create-request JSON per spawn to `FRESHELL_TEST_CLAUDE_SPAWN_LOG` (`claude.rs:1474-1516`), so asserting reapplied settings needs no new plumbing.
- Site: `resume_for_attach` (`claude.rs:470-562`; signature `(&self, msg: &FreshAgentAttach, durable: &str) -> Result<(), ResumeClaudeError>`; sole caller `handle_attach` `:454` under the `resuming` single-flight). The Null-settings create request is built at `:502-511` (`"model": Null, "permissionMode": Null, "effort": Null`) — an independent duplicate of the create-path `json!` at `:216-225`.

**Known defect being fixed:** `ClaudeSession` (`claude.rs:112-134`) tracks no settings at all; resume-in-place sends Nulls, so a restarted freshclaude/kilroy pane silently reverts model/permissionMode/effort.

- [ ] **Step 1: Write the failing tests**

Model on the existing resume tests (`claude.rs:1154-1304`, `:1797-1871`):

```rust
#[tokio::test(flavor = "multi_thread")]
async fn resume_for_attach_reapplies_settings_from_ledger() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::new(/* donor resume-test setup, with a spawn log */);
    let (state, /* … */) = /* donor harness */;
    let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
    fake.seed("claude", DURABLE, crate::identity_sink::FreshAgentSettings {
        model: Some("opus-x".into()),
        sandbox: None,
        permission_mode: Some("plan".into()),
        effort: Some("high".into()),
        cwd: None,
    });
    state.set_identity_sink(fake);

    // Drive the donor resume flow (attach to DURABLE with a transcript on disk).

    let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
    let create_req: serde_json::Value = /* parse the create-request JSON the fake logged, as the donor tests do */;
    assert_eq!(create_req["model"], "opus-x");
    assert_eq!(create_req["permissionMode"], "plan");
    assert_eq!(create_req["effort"], "high");
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_without_record_emits_settings_reset_and_sends_nulls() {
    // Same flow, no seed: assert the spawn-logged create request has null
    // model/permissionMode/effort (today's behavior preserved as fallback)
    // AND a SETTINGS_RESET freshAgent.error frame was broadcast
    // (bus subscription pattern from Task 5).
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-freshagent resume_for_attach_reapplies`
Expected: FAIL — logged create request has nulls despite the seeded record.

- [ ] **Step 3: Implement**

In `resume_for_attach`, before building the create request at `:502-511`:

```rust
let recovered = self.identity_sink().and_then(|s| s.load_settings("claude", durable));
if recovered.is_none() {
    tracing::warn!(session = %durable, "freshagent.claude.settings_record_missing");
    self.emit_fresh_agent_error(
        durable,
        "SETTINGS_RESET",
        "Session settings could not be recovered after restart - the agent is running with default model and permissions. Reconfirm your settings.",
    );
}
let rec = recovered.unwrap_or_default();
```

Replace the three `Null`s: `"model": rec.model, "permissionMode": rec.permission_mode, "effort": rec.effort` (`serde_json::json!` serializes `None` as `null`, preserving today's fallback wire shape exactly). Keep the existing deliberate cwd handling (`:487-497`) as the primary, with `rec.cwd` as a final fallback only if both existing sources are absent. Pass `mode:` derived via the existing `session_type_str` helper (`claude.rs:700-705`) applied to the attach message's sessionType (defaulting to `"freshclaude"` when absent) and `settings: rec.clone()` into this path's `spawn_consumer` call (Task 9 threading), so the re-init re-records the row under any new cliSessionId. `emit_fresh_agent_error` is the same helper shape as Task 5's, built on claude's direct broadcast (`claude.rs:173-177`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent claude`
Expected: PASS (existing resume tests `:1154-1304`/`:1797-1871` still green — they assert transcript parity, not null settings; if any pinned the nulls, update to the new contract, noted in the commit body).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-freshagent/src/claude.rs
git commit -m "fix(claude): resume-in-place reapplies model/permissionMode/effort from the ledger record (P1.13)"
```

---

### Task 11: `paneReconcileFreshAgentV1` capability — parse, thread, echo

**Files:**
- Modify: `crates/freshell-ws/src/lib.rs` (parse at the hello handler — sibling pattern `terminalOutputBatchV1` at `lib.rs:592-597`; `paneReconcileV1` at `:574-578`; ready echo where `paneReconcileV1` is echoed)
- Modify: `crates/freshell-ws/src/terminal.rs` (`terminal::run` signature + `handle_pane_reconcile` param)
- Test: `crates/freshell-ws/tests/pane_reconcile_freshagent.rs` (new file — first two tests)

**Interfaces:**
- Consumes: hello/ready handshake, `terminal::run(…, pane_reconcile_v1, …)` threading.
- Produces: capability string `"paneReconcileFreshAgentV1"`; `handle_pane_reconcile(…, pane_reconcile_fresh_agent_v1: bool, …)`. Test harness helper `connect(url, pane_reconcile_v1, fresh_agent_v1) -> (TestWs, ready)`.

- [ ] **Step 1: Write the failing test**

Create `crates/freshell-ws/tests/pane_reconcile_freshagent.rs`. Copy the harness from `crates/freshell-ws/tests/pane_reconcile.rs` (`spawn_server()` at `:62-125` — full `WsState` literal, `NoIndexProbe`, `PaneLedger::disabled()`, ephemeral `127.0.0.1:0` axum; `connect()` at `:133-165`; `next_frame_of_type()`; `reconcile_request()`), with `connect` extended:

```rust
async fn connect(url: &str, pane_reconcile_v1: bool, fresh_agent_v1: bool) -> (TestWs, serde_json::Value) {
    // identical to the donor, but:
    // hello["capabilities"] = json!({
    //     "paneReconcileV1": pane_reconcile_v1,
    //     "paneReconcileFreshAgentV1": fresh_agent_v1,
    // });
}

#[tokio::test]
async fn ready_echoes_fresh_agent_capability_when_negotiated() {
    let server = spawn_server().await;
    let (_ws, ready) = connect(&server.url, true, true).await;
    assert_eq!(ready["capabilities"]["paneReconcileFreshAgentV1"], serde_json::json!(true));
}

#[tokio::test]
async fn without_the_capability_fresh_agent_kind_stays_invalid_unsupported() {
    let server = spawn_server().await;
    let (mut ws, _ready) = connect(&server.url, true, false).await; // frozen-client shape
    let verdicts = reconcile_request(&mut ws, serde_json::json!([{
        "paneKey": "p1", "kind": "fresh-agent",
        "sessionRef": {"provider": "claude", "sessionId": "s-1"}
    }])).await;
    assert_eq!(verdicts[0]["verdict"], "invalid");
    assert_eq!(verdicts[0]["reason"], "unsupported_kind");
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws --test pane_reconcile_freshagent`
Expected: first test FAILS (ready has no `paneReconcileFreshAgentV1`); second PASSES already (it pins the frozen-client protection — keep it as the permanent regression guard).

- [ ] **Step 3: Implement**

In `lib.rs`, next to the `paneReconcileV1` parse (`:574-578`), same raw-JSON pattern as `terminalOutputBatchV1` (`:592-597`):

```rust
let pane_reconcile_fresh_agent_v1 = value
    .get("capabilities")
    .and_then(|c| c.get("paneReconcileFreshAgentV1"))
    .and_then(|v| v.as_bool())
    .unwrap_or(false);
```

Echo `paneReconcileFreshAgentV1: true` in `ready.capabilities` when negotiated (same conditional style as `paneReconcileV1` — omitted entirely when false). Thread the bool through `terminal::run` into `handle_pane_reconcile` (parameter only in this task; used in Task 13).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --test pane_reconcile_freshagent && cargo test -p freshell-ws`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/lib.rs crates/freshell-ws/src/terminal.rs \
        crates/freshell-ws/tests/pane_reconcile_freshagent.rs
git commit -m "feat(ws): paneReconcileFreshAgentV1 capability - parsed, threaded, echoed; frozen client unaffected"
```

---

### Task 12: `reconcile_freshagent` — pure verdict mapping (sync, catch_unwind-safe)

**Files:**
- Create: `crates/freshell-ws/src/reconcile_freshagent.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (`pub(crate) mod reconcile_freshagent;` — make it `pub` if the integration tests need the types; they do for the snapshot in Task 13, so declare `pub mod reconcile_freshagent;`)
- Test: unit tests inline in the new module

**Interfaces:**
- Consumes: `freshell_protocol` types `ReconcilePane`, `PaneVerdict`, `ReconcileVerdict`, `SessionLocator` (verdict wire names: `attach`/`respawn`/`fresh`/`dead_session`/`invalid`; `PaneVerdict` fields `pane_key`, `verdict`, `terminal_id`, `session_ref`, `corrected`, `reason`, `retry_after_ms`, `duplicate` — optionals absent, never null).
- Produces (exact, used by Task 13):

```rust
pub const FRESH_AGENT_RESPAWN_CAP: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FreshAgentPresence { Live, OnDisk, GoneObserved, NeverObserved, Unknown }

#[derive(Debug, Clone, PartialEq)]
pub struct FreshAgentPaneFacts {
    pub presence: FreshAgentPresence,
    pub duplicate_of: Option<String>, // paneKey of the earlier pane claiming the same session
    pub respawn_exhausted: bool,
}

#[derive(Debug, Default)]
pub struct FreshAgentReconcileSnapshot {
    pub facts: std::collections::HashMap<String /* paneKey */, FreshAgentPaneFacts>,
}

pub fn verdict_for_pane(snapshot: Option<&FreshAgentReconcileSnapshot>, pane: &ReconcilePane) -> PaneVerdict
```

- [ ] **Step 1: Write the failing unit tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    // helpers: fn pane(key: &str, sref: Option<(&str, &str)>) -> ReconcilePane { … kind: Some("fresh-agent".into()) … }
    //          fn snap(entries: &[(&str, FreshAgentPresence, Option<&str>, bool)]) -> FreshAgentReconcileSnapshot { … }

    #[test]
    fn no_snapshot_means_capability_off_and_stays_invalid_unsupported() {
        let v = verdict_for_pane(None, &pane("p", Some(("claude", "s"))));
        assert_eq!(v.verdict, ReconcileVerdict::Invalid);
        assert_eq!(v.reason.as_deref(), Some("unsupported_kind"));
    }

    #[test]
    fn missing_session_ref_is_fresh_no_recoverable_identity() {
        let s = snap(&[]);
        let v = verdict_for_pane(Some(&s), &pane("p", None));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("no_recoverable_identity"));
    }

    #[test]
    fn live_maps_to_attach_with_session_ref_echoed() {
        let s = snap(&[("p", FreshAgentPresence::Live, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Attach);
        assert_eq!(v.session_ref.as_ref().unwrap().session_id, "t1");
        assert_eq!(v.terminal_id, None, "fresh-agent panes have no terminal id");
    }

    #[test]
    fn on_disk_maps_to_respawn() {
        let s = snap(&[("p", FreshAgentPresence::OnDisk, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("opencode", "ses_1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
        assert_eq!(v.session_ref.as_ref().unwrap().session_id, "ses_1");
    }

    #[test]
    fn gone_observed_maps_to_dead_session_not_on_disk() {
        let s = snap(&[("p", FreshAgentPresence::GoneObserved, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("claude", "gone"))));
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("session_not_on_disk"));
        assert_eq!(v.session_ref.as_ref().unwrap().session_id, "gone", "claimed identity echoed for the error UI");
    }

    #[test]
    fn never_observed_maps_to_fresh_identity_never_observed() {
        let s = snap(&[("p", FreshAgentPresence::NeverObserved, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("claude", "never"))));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("identity_never_observed"));
    }

    #[test]
    fn unknown_prefers_respawn_over_memory_loss() {
        // Cost asymmetry: respawn on a gone session degrades gracefully via the
        // providers' native not-found fallbacks; fresh on a live-on-disk session
        // loses conversation memory permanently.
        let s = snap(&[("p", FreshAgentPresence::Unknown, None, false)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "warm"))));
        assert_eq!(v.verdict, ReconcileVerdict::Respawn);
    }

    #[test]
    fn duplicate_claim_yields_fresh_with_duplicate_marker() {
        let s = snap(&[("p2", FreshAgentPresence::OnDisk, Some("p1"), false)]);
        let v = verdict_for_pane(Some(&s), &pane("p2", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::Fresh);
        assert_eq!(v.reason.as_deref(), Some("duplicate_session_claim"));
        assert_eq!(v.duplicate.as_deref(), Some("p1"));
    }

    #[test]
    fn respawn_exhausted_yields_dead_session() {
        let s = snap(&[("p", FreshAgentPresence::OnDisk, None, true)]);
        let v = verdict_for_pane(Some(&s), &pane("p", Some(("codex", "t1"))));
        assert_eq!(v.verdict, ReconcileVerdict::DeadSession);
        assert_eq!(v.reason.as_deref(), Some("respawn_exhausted"));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws reconcile_freshagent`
Expected: COMPILE ERROR (module doesn't exist).

- [ ] **Step 3: Implement**

```rust
//! Fresh-agent pane verdicts (P1.13, campaign §4.3): same verdict vocabulary
//! as terminals — attach (tracked live) / respawn (resumable via
//! provider-native resume) / dead_session (positively gone) / fresh — no new
//! states. All async work (session maps, probes) happens in the snapshot
//! builder (Task 13); this module is pure + sync so it stays legal inside
//! derive_verdicts' catch_unwind.

use freshell_protocol::/* the same paths reconcile.rs imports for */ {PaneVerdict, ReconcilePane, ReconcileVerdict};

pub const FRESH_AGENT_RESPAWN_CAP: u32 = 3;
// … types exactly as the Interfaces block above …

fn base(pane: &ReconcilePane, verdict: ReconcileVerdict) -> PaneVerdict {
    PaneVerdict {
        pane_key: pane.pane_key.clone(),
        verdict,
        terminal_id: None,
        session_ref: None,
        corrected: None,
        reason: None,
        retry_after_ms: None,
        duplicate: None,
    }
}

pub fn verdict_for_pane(snapshot: Option<&FreshAgentReconcileSnapshot>, pane: &ReconcilePane) -> PaneVerdict {
    let Some(snapshot) = snapshot else {
        // Capability not negotiated: the frozen client keeps today's contract.
        let mut v = base(pane, ReconcileVerdict::Invalid);
        v.reason = Some("unsupported_kind".into());
        return v;
    };
    let Some(sref) = pane.session_ref.clone() else {
        let mut v = base(pane, ReconcileVerdict::Fresh);
        v.reason = Some("no_recoverable_identity".into());
        return v;
    };
    let Some(facts) = snapshot.facts.get(&pane.pane_key) else {
        let mut v = base(pane, ReconcileVerdict::Fresh);
        v.reason = Some("no_recoverable_identity".into());
        return v;
    };
    if let Some(winner) = &facts.duplicate_of {
        let mut v = base(pane, ReconcileVerdict::Fresh);
        v.reason = Some("duplicate_session_claim".into());
        v.duplicate = Some(winner.clone());
        return v;
    }
    match facts.presence {
        FreshAgentPresence::Live => {
            let mut v = base(pane, ReconcileVerdict::Attach);
            v.session_ref = Some(sref);
            v
        }
        FreshAgentPresence::OnDisk | FreshAgentPresence::Unknown => {
            if facts.respawn_exhausted {
                let mut v = base(pane, ReconcileVerdict::DeadSession);
                v.reason = Some("respawn_exhausted".into());
                v.session_ref = Some(sref);
                v
            } else {
                let mut v = base(pane, ReconcileVerdict::Respawn);
                v.session_ref = Some(sref);
                v
            }
        }
        FreshAgentPresence::GoneObserved => {
            let mut v = base(pane, ReconcileVerdict::DeadSession);
            v.reason = Some("session_not_on_disk".into());
            v.session_ref = Some(sref);
            v
        }
        FreshAgentPresence::NeverObserved => {
            let mut v = base(pane, ReconcileVerdict::Fresh);
            v.reason = Some("identity_never_observed".into());
            v
        }
    }
}
```

(Import paths: mirror whatever `reconcile.rs` uses for `PaneVerdict`/`ReconcileVerdict`/`ReconcilePane` — they live in `server_messages.rs`/`client_messages.rs` re-exports. The tiny private `base` constructor is deliberately duplicated from `reconcile.rs:68` rather than making B1's helpers pub.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws reconcile_freshagent`
Expected: PASS (9 unit tests).

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws/src/reconcile_freshagent.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(ws): reconcile_freshagent - pure fresh-agent verdict mapping with dedupe + respawn cap"
```

---

### Task 13: Snapshot builder, `has_live_session`, dispatch arm, integration tests

**Files:**
- Modify: `crates/freshell-ws/src/reconcile_freshagent.rs` (builder), `crates/freshell-ws/src/terminal.rs` (`handle_pane_reconcile`), `crates/freshell-ws/src/lib.rs` (`WsState` field), `crates/freshell-ws/src/reconcile.rs` (ONE field + ONE arm + invert one unit test — nothing else)
- Modify: `crates/freshell-freshagent/src/codex.rs`, `opencode_ws.rs`, `claude.rs` (one `has_live_session` method each)
- Test: `crates/freshell-ws/tests/pane_reconcile_freshagent.rs` (extend)

**Interfaces:**
- Consumes: `SessionExistenceProbe` (`crates/freshell-ws/src/existence.rs:23-44`, READ-ONLY — B1 owns the file): `enum SessionExistence { Present, Absent, Unknown }`; sync `fn exists(&self, provider: &str, session_id: &str) -> SessionExistence` and `fn ever_observed(&self, provider: &str, session_id: &str) -> bool`. `PaneLedger::ever_bound`. Task 12 types. `ReconcileDeps` (`reconcile.rs:28-32`: `registry`, `identity`, `existence`), built at `terminal.rs:1932-1936`.
- Produces:
  - `pub async fn FreshCodexState::has_live_session(&self, session_id: &str) -> bool` (map contains id AND `!exited.load(SeqCst)`), `pub async fn FreshOpencodeState::has_live_session(&self, session_id: &str) -> bool` (sessions map contains the durable key — it is keyed by placeholder AND durable id, `opencode_ws.rs:96`), `pub async fn FreshClaudeState::has_live_session(&self, session_id: &str) -> bool` (`cli_index` durable → mapkey → sessions contains, `claude.rs:81-86`).
  - `pub async fn reconcile_freshagent::build_snapshot(state: &WsState, panes: &[ReconcilePane]) -> FreshAgentReconcileSnapshot`.
  - `WsState.fresh_agent_respawn_counts: std::sync::Arc<std::sync::Mutex<std::collections::HashMap<(String, String), u32>>>` (per-boot, in-memory).
  - `ReconcileDeps.fresh_agent: Option<&'a FreshAgentReconcileSnapshot>`.

- [ ] **Step 1: Write the failing integration tests**

Extend `crates/freshell-ws/tests/pane_reconcile_freshagent.rs`. Add a scripted probe (the trait is public in freshell-ws) and pass it into `spawn_server` (extend the donor's `spawn_server` to accept a probe + a real temp-root `PaneLedger`, exposing both on the returned `Server` — same pattern as it already exposes `registry`/`identity`):

```rust
#[derive(Default)]
struct StubProbe {
    answers: std::sync::Mutex<std::collections::HashMap<(String, String), freshell_ws::existence::SessionExistence>>,
    observed: std::sync::Mutex<std::collections::HashSet<(String, String)>>,
}
impl freshell_ws::existence::SessionExistenceProbe for StubProbe {
    fn exists(&self, provider: &str, session_id: &str) -> freshell_ws::existence::SessionExistence {
        self.answers.lock().unwrap()
            .get(&(provider.into(), session_id.into()))
            .copied()
            .unwrap_or(freshell_ws::existence::SessionExistence::Unknown)
    }
    fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
        self.observed.lock().unwrap().contains(&(provider.into(), session_id.into()))
    }
}

#[tokio::test]
async fn fresh_agent_verdicts_cover_the_four_states() {
    let probe = std::sync::Arc::new(StubProbe::default());
    probe.answers.lock().unwrap().insert(("codex".into(), "resumable".into()), SessionExistence::Present);
    probe.answers.lock().unwrap().insert(("claude".into(), "deleted".into()), SessionExistence::Absent);
    probe.observed.lock().unwrap().insert(("claude".into(), "deleted".into()));
    probe.answers.lock().unwrap().insert(("opencode".into(), "never".into()), SessionExistence::Absent);
    let server = spawn_server_with_probe(probe).await;
    let (mut ws, _ready) = connect(&server.url, true, true).await;
    let verdicts = reconcile_request(&mut ws, serde_json::json!([
        { "paneKey": "a", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "resumable"} },
        { "paneKey": "b", "kind": "fresh-agent", "sessionRef": {"provider": "claude", "sessionId": "deleted"} },
        { "paneKey": "c", "kind": "fresh-agent", "sessionRef": {"provider": "opencode", "sessionId": "never"} },
        { "paneKey": "d", "kind": "fresh-agent" }
    ])).await;
    assert_eq!(verdicts[0]["verdict"], "respawn", "killed-server-but-resumable");
    assert_eq!(verdicts[0]["sessionRef"]["sessionId"], "resumable");
    assert_eq!(verdicts[1]["verdict"], "dead_session", "transcript deleted");
    assert_eq!(verdicts[1]["reason"], "session_not_on_disk");
    assert_eq!(verdicts[2]["verdict"], "fresh", "never existed");
    assert_eq!(verdicts[2]["reason"], "identity_never_observed");
    assert_eq!(verdicts[3]["verdict"], "fresh");
    assert_eq!(verdicts[3]["reason"], "no_recoverable_identity");
    // terminal panes in the same request still work (mixed-kind request):
}

#[tokio::test]
async fn live_fresh_agent_session_gets_attach() {
    // Donor: crates/freshell-ws/tests/freshagent_claude_attach.rs — spawn the
    // server with FRESHELL_CLAUDE_SIDECAR pointing at its fake sidecar script,
    // drive freshAgent.create over the WS, await sdk.session.init / the
    // created frame carrying the cliSessionId, THEN:
    let verdicts = reconcile_request(&mut ws, serde_json::json!([
        { "paneKey": "live", "kind": "fresh-agent",
          "sessionRef": {"provider": "claude", "sessionId": cli_session_id} }
    ])).await;
    assert_eq!(verdicts[0]["verdict"], "attach");
    assert_eq!(verdicts[0]["sessionRef"]["sessionId"], cli_session_id);
    assert!(verdicts[0].get("terminalId").is_none());
}

#[tokio::test]
async fn duplicate_session_claims_dedupe_within_one_request() {
    // probe: ("codex","t1") Present
    let verdicts = reconcile_request(&mut ws, serde_json::json!([
        { "paneKey": "first",  "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "t1"} },
        { "paneKey": "second", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "t1"} }
    ])).await;
    assert_eq!(verdicts[0]["verdict"], "respawn");
    assert_eq!(verdicts[1]["verdict"], "fresh");
    assert_eq!(verdicts[1]["reason"], "duplicate_session_claim");
    assert_eq!(verdicts[1]["duplicate"], "first");
}

#[tokio::test]
async fn respawn_cap_turns_the_fourth_answer_into_dead_session() {
    // probe: ("codex","cap") Present; 4 sequential single-pane requests:
    for i in 0..4 {
        let verdicts = reconcile_request(&mut ws, serde_json::json!([
            { "paneKey": "p", "kind": "fresh-agent", "sessionRef": {"provider": "codex", "sessionId": "cap"} }
        ])).await;
        if i < 3 {
            assert_eq!(verdicts[0]["verdict"], "respawn", "answer {i}");
        } else {
            assert_eq!(verdicts[0]["verdict"], "dead_session");
            assert_eq!(verdicts[0]["reason"], "respawn_exhausted");
        }
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-ws --test pane_reconcile_freshagent`
Expected: COMPILE ERROR first (`spawn_server_with_probe`, `has_live_session` missing), then after harness plumbing: verdicts come back `invalid/unsupported_kind` — the arm doesn't exist yet.

- [ ] **Step 3: Implement**

(a) `has_live_session` on the three provider states (signatures in Interfaces; bodies are two-line map lookups under the states' own locks — for codex also require `!session.exited.load(std::sync::atomic::Ordering::SeqCst)`).

(b) `WsState` field `fresh_agent_respawn_counts` (type above, `Default`-initialized). Fix every `WsState { … }` literal the compiler flags (main.rs, `tests/pane_reconcile.rs`, `tests/common/mod.rs`, other test files) with `fresh_agent_respawn_counts: Default::default()`.

(c) `build_snapshot` in `reconcile_freshagent.rs`:

```rust
pub async fn build_snapshot(
    state: &crate::WsState,
    panes: &[ReconcilePane],
) -> FreshAgentReconcileSnapshot {
    let mut facts = std::collections::HashMap::new();
    let mut claimed: std::collections::HashMap<(String, String), String> = std::collections::HashMap::new();
    for pane in panes.iter().filter(|p| p.kind.as_deref() == Some("fresh-agent")) {
        let Some(sref) = pane.session_ref.as_ref() else { continue }; // verdict fn answers no_recoverable_identity
        let key = (sref.provider.clone(), sref.session_id.clone());
        if let Some(winner) = claimed.get(&key) {
            facts.insert(pane.pane_key.clone(), FreshAgentPaneFacts {
                presence: FreshAgentPresence::Unknown,
                duplicate_of: Some(winner.clone()),
                respawn_exhausted: false,
            });
            continue;
        }
        claimed.insert(key.clone(), pane.pane_key.clone());
        let live = match sref.provider.as_str() {
            "codex" => state.fresh_codex.has_live_session(&sref.session_id).await,
            "claude" => state.fresh_claude.has_live_session(&sref.session_id).await,
            "opencode" => state.fresh_opencode.has_live_session(&sref.session_id).await,
            _ => false,
        };
        use crate::existence::SessionExistence as E;
        let presence = if live {
            FreshAgentPresence::Live
        } else {
            match state.session_existence.exists(&sref.provider, &sref.session_id) {
                E::Present => FreshAgentPresence::OnDisk,
                E::Absent => {
                    if state.session_existence.ever_observed(&sref.provider, &sref.session_id) {
                        FreshAgentPresence::GoneObserved
                    } else {
                        FreshAgentPresence::NeverObserved
                    }
                }
                E::Unknown => {
                    // The ledger is positive evidence the session existed.
                    if state.pane_ledger.ever_bound(&sref.provider, &sref.session_id) {
                        FreshAgentPresence::OnDisk
                    } else {
                        FreshAgentPresence::Unknown
                    }
                }
            }
        };
        let respawn_exhausted = if matches!(presence, FreshAgentPresence::OnDisk | FreshAgentPresence::Unknown) {
            let mut counts = state.fresh_agent_respawn_counts.lock().expect("respawn counts poisoned");
            let c = counts.entry(key).or_insert(0);
            *c += 1;
            *c > FRESH_AGENT_RESPAWN_CAP
        } else {
            false
        };
        facts.insert(pane.pane_key.clone(), FreshAgentPaneFacts { presence, duplicate_of: None, respawn_exhausted });
    }
    FreshAgentReconcileSnapshot { facts }
}
```

(Adapt the `state.pane_ledger` access to how `WsState` actually holds the ledger — direct field per `pane_ledger: :476` in main.rs wiring. Cap semantics: each respawn-candidate ANSWER burns one attempt per (provider, sessionId) per boot; after `FRESH_AGENT_RESPAWN_CAP` answers, `dead_session{respawn_exhausted}` — mirroring the terminal wall's protection so a client stuck in a respawn loop cannot spin forever.)

(d) `terminal.rs` `handle_pane_reconcile` (before the `catch_unwind` at `:1932`):

```rust
let fresh_agent_snapshot = if pane_reconcile_fresh_agent_v1
    && request.panes.iter().any(|p| p.kind.as_deref() == Some("fresh-agent"))
{
    Some(crate::reconcile_freshagent::build_snapshot(state, &request.panes).await)
} else {
    None
};
```

and add `fresh_agent: fresh_agent_snapshot.as_ref()` to the `ReconcileDeps` literal.

(e) `reconcile.rs` — the WHOLE diff (plus the field):

```rust
// in ReconcileDeps:
    pub fresh_agent: Option<&'a crate::reconcile_freshagent::FreshAgentReconcileSnapshot>,

// in verdict_for_pane's kind match (before the Some(_) arm):
        Some("fresh-agent") => {
            return crate::reconcile_freshagent::verdict_for_pane(deps.fresh_agent, pane)
        }
```

and invert the inline unit test at `reconcile.rs:545-550` that used the literal `"fresh-agent"` as its `unsupported_kind` negative example — switch its kind to `"browser"` (still unsupported) so it keeps guarding the same contract. Any other `ReconcileDeps` literals in reconcile.rs unit tests gain `fresh_agent: None`. NOTHING ELSE in reconcile.rs changes (B1 owns it; a trivial merge conflict at the arm is expected and fine). Update the `kind` doc comment at `client_messages.rs:361` (`/// v1: "terminal" only …`) to mention `"fresh-agent"` behind `paneReconcileFreshAgentV1`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws && cargo test -p freshell-freshagent && cargo test -p freshell-server`
Expected: PASS — all new integration tests, all existing reconcile tests (including `tests/pane_reconcile.rs` and protocol tests) still green.

- [ ] **Step 5: Commit**

```bash
cargo fmt --all && cargo clippy --workspace --all-targets -- -D warnings
git add crates/freshell-ws crates/freshell-freshagent crates/freshell-server
git commit -m "feat(ws): fresh-agent panes enter the reconcile verdict system behind paneReconcileFreshAgentV1 (P1.13 §4.3)"
```

---

### Task 14: E2E — settings survive restart (3 providers) + codex crash degradation banner

**Files:**
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (crash knob)
- Create: `test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to BOTH `RUST_ONLY_SPECS` (~line 90) and the `rust-chromium` project `testMatch` (~line 250))

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.ts`): `start()`, `restartAbrupt()` (SIGKILL + reboot on same home/port/token), `{env, setupHome}` options. `bootWall(page, {env, setupHome})` from the wall spec's helper pattern. Fakes: `CODEX_CMD="node <fake-app-server.mjs>"` + `FAKE_CODEX_APP_SERVER_BEHAVIOR` (JSON, supports `appendThreadOperationLogPath` → JSONL `{method, threadId, params}`); `OPENCODE_CMD` + `FAKE_OPENCODE_AUDIT_LOG`; `FRESHELL_CLAUDE_SIDECAR` + `FAKE_CLAUDE_SIDECAR_LOG` (JSONL of every inbound message). REST agent API: `POST /api/tabs` with `agent`/`model`/`effort` params; `POST /api/panes/:id/send-keys`.
- Primary donor spec: `test/e2e-browser/specs/freshclaude-restart-parity-rust.spec.ts:212-310` — copy its boot, pane-creation, send, restart, and re-attach patterns verbatim; the NEW content of each test is its final assertion block, given below in full.

- [ ] **Step 1: Add the crash knob to the codex fake (test infra, no prod code)**

In `fake-app-server.mjs`, where inbound prompt/turn requests are handled, honor a new behavior field:

```js
// behavior.crashOnPromptMarker: if the inbound turn text contains this
// marker, hard-exit to simulate a sidecar crash mid-session.
if (behavior.crashOnPromptMarker && promptText.includes(behavior.crashOnPromptMarker)) {
  process.exit(1);
}
```

- [ ] **Step 2: Write the four e2e tests (they fail against pre-fix behavior only where the fix is server-side; write them to assert the FIXED contract)**

`freshagent-settings-resume-rust.spec.ts` — one `test.describe` with four tests, each booting its own `RustServer` on an ephemeral port with the provider's fake wired via env (donor patterns), each cleaning up in `finally`/`afterEach`:

1. **`codex: restart → attach resumes with the user's model, not defaults`**
   - Boot with `CODEX_CMD` fake + behavior including `appendThreadOperationLogPath: <tmp>/codex-ops.jsonl` and a resume-succeeds script.
   - Create a codex fresh-agent pane WITH an explicit model (donor pane-creation pattern; if the creation surface in the donor doesn't carry model, use the REST agent API: `POST ${baseUrl}/api/tabs` with `{ agent: 'codex', model: 'gpt-5.3-codex' }` and the auth token).
   - Send one message; wait for the reply (donor wait pattern).
   - `await server.restartAbrupt()`; `await page.reload()`; wait for the pane to re-attach (donor wait).
   - Assertion block:
   ```ts
   const ops = fs.readFileSync(opLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
   const resume = ops.find((o) => o.method === 'thread/resume')
   expect(resume, 'restart must resume the durable thread').toBeTruthy()
   expect(resume.params.model, 'resume must carry the recorded model, not null').toBe('gpt-5.3-codex')
   ```
   (Sandbox/permissionMode reapplication is pinned at the Rust layer in Task 5 — the creation surface here only carries `model`/`effort`.)

2. **`opencode: restart → attach → next send carries the recorded model/effort`**
   - Boot with `OPENCODE_CMD` fake + `FAKE_OPENCODE_AUDIT_LOG`.
   - Create an opencode pane with `{ agent: 'opencode', model: 'big-model', effort: 'high' }`; send once (materializes `ses_*`); `restartAbrupt()`; reload; wait for re-attach; send a second message.
   - Assertion block:
   ```ts
   const audit = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
   const prompts = audit.filter((e) => e.path && String(e.path).includes('/message')) // the prompt_async POSTs (match the fake's actual audit shape)
   const afterRestart = prompts[prompts.length - 1]
   expect(JSON.stringify(afterRestart), 'post-restart send must carry the recorded model').toContain('big-model')
   expect(JSON.stringify(afterRestart), 'post-restart send must carry the recorded effort').toContain('high')
   ```

3. **`claude: restart → attach resume request carries model/permissionMode`**
   - Boot with `FRESHELL_CLAUDE_SIDECAR` fake + `FAKE_CLAUDE_SIDECAR_LOG` (exactly the donor's env, `rust-server.ts` + donor `:212-310`).
   - Create a freshclaude pane with an explicit model (donor creation; REST `{ agent: 'claude', model: 'opus-x' }` if the donor path doesn't carry model); send once; `restartAbrupt()`; reload; wait for the resume (donor wait — it already proves transcript parity).
   - Assertion block:
   ```ts
   const msgs = fs.readFileSync(sidecarLogPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
   const resumeCreate = msgs.filter((m) => m.msg && m.msg.resumeSessionId).pop()
   expect(resumeCreate, 'restart must issue a resume create').toBeTruthy()
   expect(resumeCreate.msg.model, 'resume must carry the recorded model, not null').toBe('opus-x')
   ```

4. **`codex: crash respawn shows a visible memory-loss notice`**
   - Boot with the codex fake, behavior `{ crashOnPromptMarker: 'CRASH_NOW', … }` and a follow-up behavior (rewritten between spawns, as the Rust tests do via the behavior file) whose `thread/resume` answers not-found so the respawn mints a new thread.
   - Create a codex pane; send `CRASH_NOW` (sidecar exits); send another message (triggers crash-recovery respawn).
   - Assertion block:
   ```ts
   const banner = page.getByRole('alert').filter({ hasText: 'no longer has memory' })
   await expect(banner, 'memory loss must be user-visible, not just a server warn').toBeVisible({ timeout: 15000 })
   ```

- [ ] **Step 3: Register the spec and run it**

Add `'freshagent-settings-resume-rust.spec.ts'` to `RUST_ONLY_SPECS` and the `rust-chromium` `testMatch` in `playwright.config.ts`.

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium freshagent-settings-resume-rust`
Expected: ALL FOUR PASS (the server-side fixes landed in Tasks 4-10/13). If a test fails, that is a real defect in the preceding tasks — fix the production code, not the assertion.

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs \
        test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts \
        test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): per-provider settings survive restart + codex crash memory-loss banner (P1.13)"
```

---

### Task 15: Restore-contract-wall pin flip + full gates

**Files:**
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`

**Interfaces:**
- Consumes: the P1.13-tagged pin at `:1017-1020` inside test `freshopencode: SIGKILL restore keeps the ses_* identity and rehydrates history` (`:1001`): `test.fail(e2eServerKind === 'rust', 'P1.8/P1.13 (§2.7): post-reload freshopencode pane re-mints a freshopencode-* placeholder instead of rebinding the surviving ses_* session')`. Pin-flip discipline: a flip DELETES the `test.fail(...)` line (Playwright makes unexpected-pass a hard failure); if the test still fails for a reason OUTSIDE this lane (client folding is next wave), NARROW the reason instead (the `9dc032b7` flavor) — never widen. The aggregate RULER pin (`:1333`, `:1339-1357`) is NOT flipped by this lane.

- [ ] **Step 1: Run the pinned test as-is**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium restore-contract-wall-rust -g "freshopencode: SIGKILL restore keeps"
```

- If it reports an UNEXPECTED PASS (the pin now fails the run): the server-side fixes flipped it — go to Step 2a.
- If it still fails inside the pin: read the failure; if the residual cause is client-side re-mint folding (next wave's scope), go to Step 2b.

- [ ] **Step 2a: Flip — delete the pin**

Delete the `test.fail(e2eServerKind === 'rust', 'P1.8/P1.13 …')` line (and its `EXPECTED-FAIL WALL PIN` comment block's stale reason — replace the comment with a dated `HISTORY:` note: fixed by this lane's settings-from-ledger resume, per the flip pattern in `restore-matrix.spec.ts:1695-1716`). Re-run the command from Step 1. Expected: PASS.

- [ ] **Step 2b: Narrow — server side fixed, client folding pending**

Update the pin's reason string to: `'P1.8 (§2.7, client folding — next wave): server resume now reapplies the ledger record (P1.13 done); post-reload client still re-mints a freshopencode-* placeholder'` and update the pin comment's dated observation + FLIP clause to name the client-folding lane. Re-run Step 1's command; expected: the pinned test is an expected failure (suite green).

- [ ] **Step 3: Full verification gates**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
npm run test:status   # wait politely if a sibling holds the gate
FRESHELL_TEST_SUMMARY="B4 freshagent-verdicts-resume full gate" env -u FRESHELL_BIND_HOST npm test
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  freshagent-settings-resume-rust restore-contract-wall-rust freshclaude-restart-parity-rust
```
Expected: everything green (wall pins that are not ours remain expected-fails).

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "test(wall): flip/narrow P1.13 freshopencode settings pin - fresh-agent resume record live"
```

---

## Verification Summary (what proves the user stories)

| Requirement (spec) | Proving test |
|---|---|
| Ledger rows at codex thread/start, opencode session.materialized (+pending before), claude sdk.session.init | Tasks 4/7/9 Rust tests |
| Resume-invocation record persisted + updated on user change (§4.2) | Task 1 round-trip; Task 7 `send_with_changed_settings_refreshes_the_binding` |
| Codex resume-after-restart runs with user's model/sandbox (defect §2.6c) | Task 5 wire-level op-log test + Task 14 e2e test 1 |
| Opencode resume keeps model/effort/cwd (defect §2.7b) | Task 8 Rust test + Task 14 e2e test 2 |
| Claude resume keeps model/permissionMode/effort | Task 10 spawn-log test + Task 14 e2e test 3 |
| "settings reset — reconfirm" breadcrumb = missing-record ALARM only | Tasks 5/8/10 SETTINGS_RESET alarm tests (frame emitted ONLY when the record is absent) |
| reconcile accepts kind:fresh-agent with attach/respawn/dead_session/fresh | Task 12 unit + Task 13 direct-WS tests (live / killed-resumable / transcript-deleted / never-existed) |
| Dedupe + respawn caps for fresh agents | Task 13 `duplicate_session_claims…` + `respawn_cap_turns_the_fourth…` |
| Capability-gated; frozen client unaffected | Task 11 `without_the_capability…` (permanent regression guard) |
| Codex crash-respawn degradation frame, user-visible TODAY | Task 6 broadcast test + Task 14 e2e banner test |
| Flip P1.13-tagged wall pins this lane fixes | Task 15 |
