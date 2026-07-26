# Sidebar/Tab-Registry Sync Re-Verification (P1.14) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Re-verify the Incident-4 sidebar contract (correct pane↔session joins: across restarts, for REST-created tabs, for fresh codex terminals, and after recover-my-panes) against the new ledger-backed identity truth, pin each contract case with a test that would have caught Incident 4, and fix the cases that fail by making joins consult the identity registry/ledger per the §4.2 authority chain.

**Architecture:** All fixes are server-side; the client join machinery (`sessionsSlice`, `sidebarSelectors`, `Sidebar.tsx`) is verified but expected unchanged. Three server fixes: (1) `session_directory.rs` join functions gain a `PaneLedger` read fallback so a live terminal whose in-memory identity lacks a `session_id` resolves through the ledger's `Bound` row instead of minting a provisional `terminal:<id>` key (authority chain rung 1 → rung 2); (2) the `sessions.changed` sweep signature gains an identity-registry digest so locator adoptions push a sidebar refetch; (3) the REST `/api/tabs` create path arms the codex locator (it already arms amplifier/opencode), making REST-created codex panes adoptable. Verification is pinned by new Rust unit tests plus one new rust-only Playwright spec covering all four contract cases.

**Tech Stack:** Rust (axum server, crates/freshell-server + freshell-ws + freshell-freshagent), React/Redux client (verified, not modified), Playwright e2e (`test/e2e-browser`), Vitest, cargo test/clippy.

## Global Constraints

- Base: `origin/main @ bf6242a1`. Work only in the worktree `/home/dan/code/freshell/.worktrees/sidebar-registry-sync` on branch `feat/sidebar-registry-sync`.
- SCOPE FENCE (from the lane spec, verbatim intent): you own sidebar/sessions client code (`sessionsSlice`, sidebar components), `crates/freshell-server/src/session_directory.rs`, and sessions-revision push seams. Do NOT touch: client reconcile fold / `TerminalView` / `FreshAgentView` pane-recovery internals (Lane C2 owns those), port/contract tooling + `shared/ws-protocol.ts` (Lane C3), `reconcile*.rs`, ledger WRITES (ledger READS are allowed and required). Read anything. No kimi/gemini work.
  - One narrow, spec-mandated exception (case b/c: "identity now arrives via the B2 locator — is it now fixable with locator identity? If yes, fix it"): minimal codex-locator ARMING on the REST create path in `crates/freshell-freshagent` (Task 4), mirroring the existing amplifier/opencode wiring byte-for-byte in shape. Arming a locator is not a ledger write.
- E2E: own `RustServer` instances via `test/e2e-browser/helpers/rust-server.ts`, ephemeral ports only — NEVER 3001/3002. `await server.stop()` in `finally`.
- NEVER restart the user's self-hosted Freshell server. NEVER use broad kill patterns (`pkill -f`, `pkill node`).
- `cargo clippy --workspace --all-targets -- -D warnings` must pass (required CI).
- Coordinated vitest suites go through the shared gate: set `FRESHELL_TEST_SUMMARY`, check `npm run test:status`, and WAIT if another agent holds the gate (2 sibling lanes run concurrently). Playwright e2e is NOT gated.
- `npm ci` and `ln -s ../node_modules/tsx node_modules/tsx` may be needed in the worktree before vitest runs.
- Red-Green-Refactor TDD. Exception, mandated by this lane's verification-first spec: the e2e tests in Tasks 5–8 are PINNING tests for contract cases that may already hold — a pinning test passing on first run is a valid verification outcome (record PASS in the Verification Report); a failing one triggers that task's prescribed fix.
- PR POLICY: NOT approved. Push the branch, STOP before `gh pr create`. Final report = branch name + Verification Report + red→green proof.
- Check disk before heavy builds (`df -h .`); halt on ENOSPC risk rather than deleting anything outside the worktree.
- TS e2e/server files use NodeNext/ESM — relative imports need `.js` extensions.
- Do not create new end-user markdown docs; this plan doc is a working/agent doc and the Verification Report is appended to it (spec deliverable 3).
- Any new `SidebarSessionItem` field (not expected) must be added to all three memo comparators (`Sidebar.tsx:71`, `:125`, `:822`) or rows won't re-render.

---

## Background (read this first — it is the spec-coverage map)

Incident 4 (docs/plans/2026-07-19-state-sync-resilience-assessment.md): REST-created tabs rendered grey in the sidebar because the pane↔session join was built on client-guessed identity. The §4.2 authority chain (campaign plan, docs/plans/2026-07-24-restart-resilience-architecture-analysis.md:203) orders identity truth: **in-memory registry (live process truth) → ledger `bound` rows (durable server truth) → client claim (proposal only) → tabs-snapshot (rescue mirror)**.

How the sidebar joins today (verified at HEAD `bf6242a1`):

- Client: green vs grey is `item.hasTab` (`src/components/Sidebar.tsx:877`), derived from `collectSessionRefsFromTabs(tabs, panes)` (`src/lib/session-utils.ts:294`) reading canonical `content.sessionRef` on local pane trees. Server running-state arrives via `GET /api/session-directory` and `terminalDirectory`. DOM contract: `[data-session-id]`, `[data-provider]`, `[data-has-tab]`, `[data-is-running]` (`Sidebar.tsx:863-869`).
- Server: `crates/freshell-server/src/session_directory.rs` joins live terminals to indexed session files keyed ONLY on `provider:sessionId`, with `TerminalIdentityRegistry` as its sole identity source (`SessionDirectoryState`, `:66-84`). A live identity with no `session_id` mints a provisional key `terminal:<terminal_id>` (`:735-738`).
- Push: `sessions.changed` is emitted by `freshell_ws::terminal::broadcast_sessions_changed` (`crates/freshell-ws/src/terminal.rs:2292`); the periodic sweep (`crates/freshell-server/src/main.rs:1490`) fires it when `sessions_sweep_signature` (`main.rs:1445`) changes — a signature derived ONLY from disk-indexed sessions, blind to identity-registry changes.

Known defects this plan fixes (found in exploration, each pinned by a task):

1. **Case (c) join:** `session_directory.rs` never consults the `PaneLedger` (authority rung 2). The stale fence comment (`:682-690`) and pinning test (`:949-974`, asserts `joined.len() == 2`) still describe the pre-locator world. → Task 2.
2. **Case (c) push:** locator adoption (`codex_identity.rs:138`) upserts identity + ledger but broadcasts no `sessions.changed`; the sweep signature can't see it either. The collapsed duplicate never renders. → Task 3.
3. **Case (b)/(c) REST:** `arm_locators_for_fresh_pane` (`crates/freshell-freshagent/src/terminal_tabs.rs:458-471`) arms only amplifier + opencode; a codex pane created via `POST /api/tabs` is never armed, so its provisional identity can never be superseded. → Task 4.

Contract-case → task map:

| Spec case | Pinning tests | Fix (if needed) |
|---|---|---|
| (a) restarts | Task 7 (e2e restart cycle, mixed panes) | Tasks 2–3 (server), else record PASS |
| (b) REST/MCP-created tabs (Incident 4) | Task 6 (e2e REST claude+codex resume), existing `remote-tab-linkage-rust.spec.ts` re-run | Task 4 + Task 6 contingency |
| (c) fresh codex duplicate | Task 2 (unit), Task 5 (e2e collapse) | Tasks 2, 3, 4 |
| (d) recover-my-panes | Task 8 (e2e recovery + sidebar assert) | none expected; contingency in Task 8 |

---

## File Structure

- Modify: `crates/freshell-server/src/session_directory.rs` — `SessionDirectoryState.ledger`, `effective_session_id()`, ledger-aware join fns, rewritten residual test, refreshed stale module docs. (Owned by this lane.)
- Modify: `crates/freshell-server/src/main.rs` — wire ledger into `SessionDirectoryState`; identity digest in `sessions_sweep_signature`; `spawn_sessions_sweep` new param; sweep tests. (Sessions-revision push seam — owned.)
- Modify: `crates/freshell-freshagent/src/lib.rs` — `FreshAgentState.codex_locator` field + `with_codex_locator` builder (mirror of amplifier/opencode). (Narrow scope exception.)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` — arm codex locator in `arm_locators_for_fresh_pane`; unit test. (Narrow scope exception.)
- Create: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts` — the four contract-case scenarios.
- Modify: `test/e2e-browser/playwright.config.ts` — register new spec in `RUST_ONLY_SPECS` and the `rust-chromium` project `testMatch`.
- Modify: `docs/plans/2026-07-26-sidebar-registry-sync.md` — Verification Report entries appended per task.

No client source files are expected to change. Tasks 6 and 8 contain explicit contingency instructions if verification proves otherwise (the contingent files — `src/store/sessionsSlice.ts`, `src/store/selectors/sidebarSelectors.ts`, `src/lib/session-utils.ts`, `src/components/Sidebar.tsx` — are owned by this lane).

---

### Task 1: Baseline and harness sanity

**Files:**
- Modify: `docs/plans/2026-07-26-sidebar-registry-sync.md` (Verification Report baseline entry)

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a proven-working build/test harness in the worktree; a `## Verification Report` baseline entry. Later tasks assume `cargo test -p freshell-server` and `npm run test:vitest -- ...` both work here.

- [ ] **Step 1: Confirm worktree, branch, and disk headroom**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/sidebar-registry-sync
git status --short --branch && git log --oneline -1
df -h .
```
Expected: branch `feat/sidebar-registry-sync`, HEAD `bf6242a1` (plus this plan's commit), clean tree. If available disk < 10G, HALT and report (cargo release builds are heavy) — do not delete anything outside the worktree.

- [ ] **Step 2: Node deps + tsx symlink**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/sidebar-registry-sync
[ -d node_modules ] || npm ci
[ -e node_modules/tsx ] || ln -s ../node_modules/tsx node_modules/tsx
```
Expected: exits 0. (The symlink is the documented worktree workaround; skip if `node_modules/tsx` already resolves.)

- [ ] **Step 3: Rust baseline for the two crates this plan touches**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/sidebar-registry-sync
cargo test -p freshell-server session_directory 2>&1 | tail -20
cargo test -p freshell-freshagent 2>&1 | tail -5
```
Expected: both PASS (this is the merged waves A+B baseline). Note the current `session_directory` test count for the report.

- [ ] **Step 4: Targeted client baseline (uncoordinated single-file passthrough)**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/sidebar-registry-sync
FRESHELL_TEST_SUMMARY="P1.14 sidebar-registry-sync baseline" npm run test:vitest -- run --config config/vitest/vitest.config.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/components/SidebarItem.running-state.test.tsx
```
Expected: PASS. If the coordinator gate is held by another agent, WAIT (check `npm run test:status`) — never kill a foreign holder.

- [ ] **Step 5: Record the baseline in the Verification Report**

Append under `## Verification Report` at the bottom of this file:
```markdown
### Baseline (Task 1)
- Worktree feat/sidebar-registry-sync @ bf6242a1: clean.
- cargo test -p freshell-server session_directory: PASS (<N> tests).
- cargo test -p freshell-freshagent: PASS.
- sidebarSelectors + SidebarItem.running-state vitest: PASS.
- Disk headroom: <X>G available.
```

- [ ] **Step 6: Commit**

```bash
git add docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "docs(p1.14): record verification baseline for sidebar-registry-sync"
```

---

### Task 2: Ledger-backed join in session_directory (authority rung 2)

The server-side heart of "joins should consult the identity registry/ledger rather than client-pushed guesses". A live terminal whose in-memory identity has no `session_id` must resolve through the ledger's newest `Bound` row for that terminal before minting a provisional `terminal:<id>` key. This both fixes the running-state join and collapses the codex duplicate whenever a durable binding exists.

**Files:**
- Modify: `crates/freshell-server/src/session_directory.rs` (state at `:66-84`, handler at `:363-414`, join fns at `:706-793`, fence comment at `:673-690`, stale module doc at `:20-34`, tests in `mod join_tests` at `:795-975`)
- Modify: `crates/freshell-server/src/main.rs:698-703` (state construction)

**Interfaces:**
- Consumes: `freshell_ws::pane_ledger::PaneLedger::bound_session_ref_for_terminal(&self, terminal_id: &str) -> Option<SessionLocator>` (`pane_ledger.rs:652`, READ-only); `freshell_ws::identity::TerminalIdentity` (`identity.rs:33-44`); the `Arc<PaneLedger>` minted at `main.rs:434` (the same binding already cloned into `RecoveryInventoryState` at `main.rs:855` — reuse that variable).
- Produces (later tasks and the e2e rely on these exact shapes):
  - `SessionDirectoryState` gains `pub ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>`.
  - `fn effective_session_id(identity: &TerminalIdentity, ledger: Option<&PaneLedger>) -> Option<String>`
  - `fn join_running_state(item: DirItem, identities: &[TerminalIdentity], ledger: Option<&PaneLedger>) -> DirItem`
  - `fn build_live_terminal_session_item(identity: &TerminalIdentity, ledger: Option<&PaneLedger>) -> Option<DirItem>`
  - `fn join_live_terminals(items: Vec<DirItem>, identities: &[TerminalIdentity], ledger: Option<&PaneLedger>) -> Vec<DirItem>`

- [ ] **Step 1: Write the failing tests (RED)**

In `mod join_tests` (`session_directory.rs:795`), add (reuse the existing `file_item` helper; for the `BindingWrite` construction mirror the `write(provider, session_id, terminal_id, now_ms)` helper from `crates/freshell-ws/src/pane_ledger_tests.rs:22` — copy its exact field set):

```rust
fn temp_ledger_root(label: &str) -> std::path::PathBuf {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "session-dir-ledger-{label}-{}-{n}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("create temp ledger root");
    dir
}

/// Authority chain §4.2, rung 1 -> rung 2: an identityless live terminal
/// resolves through the ledger's Bound row instead of minting a
/// provisional `terminal:<id>` key. The indexed file item and the live
/// terminal therefore share one join key and the duplicate collapses.
#[test]
fn ledger_bound_row_resolves_identityless_terminal_to_its_real_session() {
    let reg = TerminalIdentityRegistry::new();
    reg.upsert("term-codex", Some("codex"), None, None, 5000);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(temp_ledger_root("resolve")));
    // BindingWrite: provider "codex", session_id "real-codex-session-id",
    // live_terminal_id "term-codex" -- mirror pane_ledger_tests.rs:22.
    ledger.record_binding(&binding_write("codex", "real-codex-session-id", "term-codex", 4000))
        .expect("ledger write");
    let items = vec![file_item("codex", "real-codex-session-id", 4500)];

    let joined = join_live_terminals(items, &reg.list(), Some(&ledger));

    assert_eq!(joined.len(), 1, "ledger-resolved terminal must merge with its file item");
    assert!(joined[0].is_running);
    assert_eq!(joined[0].running_terminal_id.as_deref(), Some("term-codex"));
    assert!(!joined[0].live_terminal_only);
}

/// Provider mismatch guard: a ledger row for a DIFFERENT provider than the
/// live identity must not be adopted (a codex terminal never wears a
/// claude binding).
#[test]
fn ledger_row_with_mismatched_provider_is_ignored() {
    let reg = TerminalIdentityRegistry::new();
    reg.upsert("term-codex", Some("codex"), None, None, 5000);
    let ledger = freshell_ws::pane_ledger::PaneLedger::new(Some(temp_ledger_root("mismatch")));
    ledger.record_binding(&binding_write("claude", "some-claude-id", "term-codex", 4000))
        .expect("ledger write");

    let joined = join_live_terminals(vec![], &reg.list(), Some(&ledger));

    assert_eq!(joined.len(), 1);
    assert!(joined[0].live_terminal_only, "mismatched ledger row must fall back to provisional");
    assert!(joined[0].session_id.starts_with("terminal:"));
}

/// No ledger / no row: behavior is byte-identical to today (provisional key).
#[test]
fn without_ledger_row_the_provisional_key_behavior_is_unchanged() {
    let reg = TerminalIdentityRegistry::new();
    reg.upsert("term-codex", Some("codex"), None, None, 5000);

    let joined = join_live_terminals(vec![], &reg.list(), None);

    assert_eq!(joined.len(), 1);
    assert!(joined[0].live_terminal_only);
    assert_eq!(joined[0].session_id, "terminal:term-codex");
}
```

Add the small local helper `binding_write(provider, session_id, terminal_id, now_ms) -> BindingWrite<'static>` by copying the field set from `pane_ledger_tests.rs:22` (state `Bound`, `pane_kind: "terminal"`, and whatever mandatory fields that helper sets — keep them identical).

- [ ] **Step 2: Run to verify they fail for the right reason**

Run: `cargo test -p freshell-server session_directory 2>&1 | tail -30`
Expected: compile FAILURE — `join_live_terminals` takes 2 args, `PaneLedger` not imported. (A compile-level RED is the correct failure here: the seam doesn't exist yet.)

- [ ] **Step 3: Implement (GREEN)**

In `session_directory.rs`:

1. Add to `SessionDirectoryState` (`:66-84`):
```rust
    /// Authority chain §4.2 rung 2: durable pane<->session bindings.
    /// READ-only here; `None` in tests/minimal wiring keeps legacy behavior.
    pub ledger: Option<std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>>,
```

2. Add the resolver (next to the join fns, `:700` area):
```rust
/// Resolve a live terminal's session id per the §4.2 authority chain:
/// in-memory identity first (rung 1), then the ledger's newest Bound row
/// for this terminal (rung 2). A ledger row only counts when its provider
/// agrees with the live identity's provider.
fn effective_session_id(
    identity: &freshell_ws::identity::TerminalIdentity,
    ledger: Option<&freshell_ws::pane_ledger::PaneLedger>,
) -> Option<String> {
    if identity.session_id.is_some() {
        return identity.session_id.clone();
    }
    let locator = ledger?.bound_session_ref_for_terminal(&identity.terminal_id)?;
    if identity.provider.as_deref() == Some(locator.provider.as_str()) {
        Some(locator.session_id)
    } else {
        None
    }
}
```

3. Thread `ledger: Option<&PaneLedger>` through the three join fns:
   - `join_running_state` (`:706`): the match predicate becomes
     `identity.provider.as_deref() == Some(item.provider.as_str()) && effective_session_id(identity, ledger).as_deref() == Some(item.session_id.as_str())`.
   - `build_live_terminal_session_item` (`:731`): compute `let effective = effective_session_id(identity, ledger);` then
     `let session_id = effective.clone().unwrap_or_else(|| format!("terminal:{}", identity.terminal_id));` and set `live_terminal_only: effective.is_none()`.
   - `join_live_terminals` (`:770`): accept and forward the param to both callees.

4. Handler (`:404`): pass `state.ledger.as_deref()` into `join_live_terminals` (and to `join_running_state` if called separately in `apply_query` — follow the compiler).

5. Update every existing `join_tests` call site to pass `None` (behavior-preserving), EXCEPT the residual-duplicate test — see Step 5.

6. Wire `main.rs:698-703`: add `ledger: Some(std::sync::Arc::clone(&<pane_ledger_binding>)),` using the same `Arc<PaneLedger>` binding cloned into `RecoveryInventoryState` at `main.rs:855` (minted at `main.rs:434`). If the binding has moved by construction time, clone it earlier as the surrounding code does for other shared handles.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server session_directory 2>&1 | tail -30`
Expected: all PASS, including the three new tests and all pre-existing join tests.

- [ ] **Step 5: Rewrite the stale residual pinning test and stale docs (REFACTOR)**

1. The test at `:949-974` (`codex_fresh_terminal_and_its_eventual_session_file_are_a_documented_residual_duplicate`) pins the OLD contract. Rename it to `codex_fresh_terminal_pre_adoption_duplicate_is_transient_pending_locator_adoption`, keep the `joined.len() == 2` assertion for the no-identity-no-ledger input (pass `None` for the ledger), and rewrite its doc comment: the duplicate is now a TRANSIENT pre-adoption window — the B2 codex locator adopts the identity (`codex_identity.rs`), the ledger fallback (this file) and the identity-aware sweep (`main.rs`) collapse and push it; it is no longer a permanent residual.
2. Update the fence comment at `:682-690` the same way (delete the "this port doesn't associate the two after the fact" claim; describe the rung-1/rung-2 resolution and the transient window).
3. Fix the stale module doc claims at `:20-34` ("claude only", "no live terminal join" — both false since long before this plan; say what the module actually does today).

- [ ] **Step 6: Full crate check + clippy**

Run:
```bash
cargo test -p freshell-server 2>&1 | tail -5
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: PASS / no warnings.

- [ ] **Step 7: Record + commit**

Append to the Verification Report:
```markdown
### Case (c) join, server unit level (Task 2)
- VERIFIED FAILING then FIXED: identityless live terminal + ledger Bound row
  previously produced 2 sidebar items (provisional key); now resolves via
  ledger to 1 running item. RED proof: compile-level (seam absent), then
  assertion-level on first green run.
- Residual pinning test rewritten: pre-adoption duplicate is transient, not permanent.
```

```bash
git add crates/freshell-server/src/session_directory.rs crates/freshell-server/src/main.rs docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "feat(server): session-directory join consults the pane ledger (P1.14, authority rung 2)"
```

---

### Task 3: Identity-aware sessions.changed sweep (the push seam)

Even a perfect join is invisible if nothing pushes. The sweep signature is currently blind to `TerminalIdentityRegistry` changes, so a locator adoption (or any terminal open/close of a coding CLI) never triggers a sidebar refetch. Fold an identity digest into the signature. (This deliberately routes through the existing single emit point `broadcast_sessions_changed` and stays inside the sweep — the documented push seam this lane owns — rather than adding a second producer in the adoption tail.)

**Files:**
- Modify: `crates/freshell-server/src/main.rs` (`sessions_sweep_signature` at `:1445-1450`, `spawn_sessions_sweep` at `:1490-1509`, spawn site at `:664`, gap docs at `:1390-1444`, `mod sessions_sweep_tests` at `:1512`)

**Interfaces:**
- Consumes: `freshell_ws::identity::TerminalIdentityRegistry::list() -> Vec<TerminalIdentity>` (`identity.rs:124`, live-only); the `terminal_identity` registry binding already cloned into `SessionDirectoryState` at `main.rs:703`.
- Produces:
  - `fn sessions_sweep_signature(items: &[IndexedSession], identities: &[TerminalIdentity]) -> (usize, i64, u64)`
  - `fn spawn_sessions_sweep(session_index: Arc<SessionIndex>, ws_state: WsState, identity: TerminalIdentityRegistry, interval: Duration)`
  - Behavioral guarantee Task 5's e2e relies on: a locator adoption changes the signature within one 2s tick → `sessions.changed` → client refetch.

- [ ] **Step 1: Write the failing test (RED)**

In `mod sessions_sweep_tests` (`main.rs:1512`):

```rust
/// The undocumented fourth gap, closed: the sweep signature must move when
/// the identity registry changes -- a locator adoption (session_id appears
/// on a live terminal) alters the session-directory join result, so the
/// sidebar needs a sessions.changed push.
#[test]
fn identity_registry_changes_move_the_sweep_signature() {
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let items: Vec<IndexedSession> = Vec::new();

    let empty = sessions_sweep_signature(&items, &identity.list());

    identity.upsert("term-1", Some("codex"), None, None, 1_000);
    let with_terminal = sessions_sweep_signature(&items, &identity.list());
    assert_ne!(empty, with_terminal, "a new live coding terminal must move the signature");

    identity.upsert("term-1", Some("codex"), Some("thread-a"), None, 2_000);
    let adopted = sessions_sweep_signature(&items, &identity.list());
    assert_ne!(with_terminal, adopted, "locator adoption must move the signature");

    identity.retire("term-1");
    let retired = sessions_sweep_signature(&items, &identity.list());
    assert_ne!(adopted, retired, "terminal exit must move the signature");
}

/// updated_at alone must NOT move the signature -- it changes on every
/// heartbeat-ish upsert and would turn the sweep into a 2s firehose.
#[test]
fn identity_updated_at_alone_does_not_move_the_sweep_signature() {
    let identity = freshell_ws::identity::TerminalIdentityRegistry::new();
    let items: Vec<IndexedSession> = Vec::new();
    identity.upsert("term-1", Some("codex"), Some("thread-a"), None, 1_000);
    let a = sessions_sweep_signature(&items, &identity.list());
    identity.upsert("term-1", Some("codex"), Some("thread-a"), None, 9_000);
    let b = sessions_sweep_signature(&items, &identity.list());
    assert_eq!(a, b);
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-server sessions_sweep 2>&1 | tail -20`
Expected: compile FAILURE (`sessions_sweep_signature` takes 1 arg). Correct RED.

- [ ] **Step 3: Implement (GREEN)**

```rust
// main.rs -- replaces :1445-1450
/// Signature of the session-directory view as the sidebar sees it:
/// disk corpus (count + max activity) PLUS a digest of the live identity
/// registry (terminal_id, provider, session_id triples -- NOT updated_at,
/// see identity_updated_at_alone_does_not_move_the_sweep_signature).
fn sessions_sweep_signature(
    items: &[IndexedSession],
    identities: &[freshell_ws::identity::TerminalIdentity],
) -> (usize, i64, u64) {
    use std::hash::{Hash, Hasher};
    let max_last_activity_at = items.iter().map(|s| s.last_activity_at).max().unwrap_or(0);
    let mut refs: Vec<(&str, &str, &str)> = identities
        .iter()
        .map(|i| (
            i.terminal_id.as_str(),
            i.provider.as_deref().unwrap_or(""),
            i.session_id.as_deref().unwrap_or(""),
        ))
        .collect();
    refs.sort_unstable();
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    refs.hash(&mut hasher);
    (items.len(), max_last_activity_at, hasher.finish())
}
```

`spawn_sessions_sweep` (`:1490`): add param `identity: freshell_ws::identity::TerminalIdentityRegistry`, and compute both the initial and per-tick signatures as `sessions_sweep_signature(&items, &identity.list())`. At the spawn site (`main.rs:664`) pass `terminal_identity.clone()` (the same registry handle used at `:703`). Update the existing sweep tests to the new arity (pass `&TerminalIdentityRegistry::new().list()` i.e. `&[]`-equivalent where identity is irrelevant). Update the KNOWN-GAPS doc block (`:1390-1444`): gap 4 (identity blindness) is now CLOSED here; note the deliberate exclusion of `updated_at` and `cwd` from the digest.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-server sessions_sweep 2>&1 | tail -20` then `cargo test -p freshell-server 2>&1 | tail -5`
Expected: PASS, including `new_older_session_file_is_still_detected_as_a_change` at the new arity.

- [ ] **Step 5: Clippy + commit**

```bash
cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | tail -5
git add crates/freshell-server/src/main.rs docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "feat(server): sessions.changed sweep signature includes the identity registry (P1.14)"
```
Append to the Verification Report:
```markdown
### Case (c) push seam (Task 3)
- VERIFIED FAILING then FIXED: sweep signature was blind to identity
  adoption; now includes a (terminal_id, provider, session_id) digest.
  Adoption/open/close push sessions.changed within one 2s tick.
```

---

### Task 4: Arm the codex locator on the REST /api/tabs create path

A codex pane created via the REST agent API is never armed for locator adoption (only amplifier/opencode are), so its provisional identity is permanent — the strictly-worse variant of the Incident-4 case. Mirror the existing wiring.

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (FreshAgentState fields/builders — locate the existing `with_amplifier_locator`/`with_opencode_locator` definitions and mirror them)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:458-471` (`arm_locators_for_fresh_pane`) + its test module
- Modify: `crates/freshell-server/src/main.rs:358-361` (builder wiring; codex locator constructed at `main.rs:349-350`)

**Interfaces:**
- Consumes: `freshell_sessions::codex_locator::CodexLocator` (`arm` at `codex_locator.rs:166`, `armed_count` at `:152`, `note_submit` at `:212`); the shared `Arc<CodexLocator>` at `main.rs:349-350` (the one the WS sweep `spawn_codex_locator_sweep` uses).
- Produces: `FreshAgentState::with_codex_locator(self, locator: Arc<CodexLocator>) -> Self`; `arm_locators_for_fresh_pane` arms codex. Task 5's e2e scenario 1 (REST-created codex pane collapses to one green row) depends on this.

- [ ] **Step 1: Write the failing test (RED)**

In `terminal_tabs.rs`'s test module, next to the existing create-path tests (e.g. `create_amplifier_tab_with_legacy_resume_synthesizes_session_ref` — mirror how those tests construct a `FreshAgentState`):

```rust
/// P1.14 / Incident-4 hardening: the REST create path must arm the codex
/// locator exactly like amplifier/opencode, or a REST-created codex pane's
/// provisional identity can never be superseded by B2 adoption.
#[test]
fn arm_locators_for_fresh_pane_arms_the_codex_locator() {
    let root = std::env::temp_dir().join(format!("codex-arm-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    let locator = std::sync::Arc::new(
        freshell_sessions::codex_locator::CodexLocator::new(root));
    let state = /* construct the minimal FreshAgentState the sibling
                   create-path tests use */
        .with_codex_locator(locator.clone());

    arm_locators_for_fresh_pane(&state, "term-codex-1", "codex", Some("/tmp/proj"), None);

    assert_eq!(locator.armed_count(), 1, "codex mode must arm the codex locator");
}
```

Copy the `arm(...)` argument shape (arg order, `now_ms`) from the existing amplifier arm call at `terminal_tabs.rs:585` adjusted to `CodexLocator::arm`'s signature (`codex_locator.rs:166`) — cross-check against the WS-path codex arming call in `crates/freshell-ws/src/codex_association.rs` and use the identical shape.

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p freshell-freshagent arm_locators 2>&1 | tail -20`
Expected: compile FAILURE — no `with_codex_locator`, no `codex_locator` field. Correct RED.

- [ ] **Step 3: Implement (GREEN)**

1. `lib.rs`: add field + builder, byte-for-byte mirroring the amplifier pair:
```rust
    codex_locator: Option<std::sync::Arc<freshell_sessions::codex_locator::CodexLocator>>,
```
```rust
    pub fn with_codex_locator(
        mut self,
        locator: std::sync::Arc<freshell_sessions::codex_locator::CodexLocator>,
    ) -> Self {
        self.codex_locator = Some(locator);
        self
    }
```
2. `terminal_tabs.rs:458-471`, extend `arm_locators_for_fresh_pane`:
```rust
    if let Some(locator) = &state.codex_locator {
        locator.arm(terminal_id, mode, true, resume_session_id, cwd /* + now_ms if the signature takes it -- match codex_association.rs */);
    }
```
3. `main.rs:358-361`: chain `.with_codex_locator(codex_locator.clone())` where amplifier/opencode are wired, cloning the `Arc<CodexLocator>` from `main.rs:349-350`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-freshagent 2>&1 | tail -5` and `cargo test -p freshell-server 2>&1 | tail -5`
Expected: PASS.

- [ ] **Step 5: Verify the Enter-anchor path for REST-driven input (verification step with prescribed conditional fix)**

The codex locator is Enter-anchored (`note_submit`, `codex_locator.rs:212`). Verify where `note_submit` is called:
```bash
grep -rn "note_submit" crates/ --include="*.rs" | grep -v "codex_locator.rs\|_tests\|tests/"
```
- If the call sites live on the shared terminal-input/registry write path (reached by BOTH browser keystrokes and REST `POST /api/panes/:id/send-keys`): record "note_submit: shared path, REST covered" in the Verification Report. No change.
- If the call sites are WS-handler-only (REST send-keys never anchors the window): add to the REST `send_keys` handler in `crates/freshell-freshagent` (where the keys are written to the terminal), gated to payloads containing `\r` or `\n`, mirroring the WS path's gating exactly:
```rust
    if mode == "codex" && (keys.contains('\r') || keys.contains('\n')) {
        if let Some(locator) = &state.codex_locator {
            locator.note_submit(&terminal_id, now_ms());
        }
    }
```
  …with a sibling unit test asserting `note_submit` armed-window behavior (mirror the WS-path test if one exists), and record "note_submit: REST path added" in the report. Either branch MUST leave a report entry.

- [ ] **Step 6: Clippy (workspace — this task touched 2 crates) + commit**

```bash
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -5
git add crates/freshell-freshagent crates/freshell-server/src/main.rs docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "feat(freshagent): arm the codex locator on the REST /api/tabs create path (P1.14)"
```
Append to the Verification Report:
```markdown
### Case (b)/(c) REST codex arming (Task 4)
- VERIFIED FAILING then FIXED: REST-created codex panes were never armed for
  B2 locator adoption. Now armed, mirroring amplifier/opencode.
- note_submit REST coverage: <shared path | REST path added> (Step 5 outcome).
```

---

### Task 5: E2E pinning spec — scenario 1: fresh codex duplicate collapses (case c)

Create the new rust-only Playwright spec and its first scenario: a codex pane created via the REST agent API, driven with Enter in the browser, must end as exactly ONE green sidebar row — the provisional live-only row and the indexed rollout row must collapse without a manual refresh. This test fails on `bf6242a1` (duplicate persists) and passes with Tasks 2–4. This is the "would have caught Incident 4" test for the codex shape.

**Files:**
- Create: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add the spec to `RUST_ONLY_SPECS` AND to the `rust-chromium` project's `testMatch`, each with a one-line justification comment, matching every existing entry's style)

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.ts:272` — direct import, so `restart()`/`restartAbrupt()` are non-optional); fixture `test/e2e-browser/fixtures/fake-codex-terminal.mjs` (writes a real rollout on first Enter, argv log var `FAKE_CODEX_TERMINAL_ARGV_LOG`); sidebar DOM contract `[data-session-id][data-provider][data-has-tab]` (`Sidebar.tsx:863-869`); server behavior from Tasks 2–4.
- Produces: the spec file scaffold (serial suite, one shared server, helpers) that Tasks 6–8 extend; scenario name `case-c: fresh codex terminal collapses to a single green row`.

- [ ] **Step 1: Write the spec scaffold + scenario (this IS the failing-test step)**

Create `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`. Per this suite's per-spec-ownership convention, copy these helpers VERBATIM from their donors (cite the donor in a comment above each, as sibling specs do):
- `installFakeCli(binDir, name, source)` — donor `pane-ledger-restart-rust.spec.ts:29`
- `bootAndConnect(page, info)` + `selectShellIfPickerShowing(page)` — donor `remote-tab-linkage-rust.spec.ts:60-86`
- `readArgvLog(logPath)` — donor `remote-tab-linkage-rust.spec.ts:89-93`
- the REST `POST /api/tabs` request shape — donor `remote-tab-linkage-rust.spec.ts:197` (same headers/auth; body swaps provider/mode per scenario)

Structure (fill helper bodies from the donors; everything else below is complete):

```ts
/**
 * P1.14 sidebar/tab-registry sync re-verification (Lane C1).
 * Pins the Incident-4 sidebar contract against ledger-backed identity:
 *  case-c: fresh codex duplicate collapse (this task)
 *  case-b: REST-created tabs are green + dedupe   (Task 6)
 *  case-a: joins survive server restart            (Task 7)
 *  case-d: joins correct after recover-my-panes    (Task 8)
 * Owns a RustServer directly (ephemeral loopback port -- NEVER 3001/3002).
 */
import { test, expect } from '@playwright/test'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { randomUUID } from 'node:crypto'
import { RustServer, type TestServerInfo } from '../helpers/rust-server.js'

const SEEDED_CLAUDE_ID = randomUUID()
const PROJECT_DIR = '/tmp/p114-sidebar-project'

// [copied helpers go here: installFakeCli, bootAndConnect,
//  selectShellIfPickerShowing, readArgvLog -- see donors above]

function buildClaudeSessionJsonl(sessionId: string, cwd: string, title: string): string {
  // Donor shape: session-directory-matrix.spec.ts:36 (buildSessionJsonl).
  // Verify field names against the donor before finalizing.
  const t0 = '2026-07-20T08:00:00.000Z'
  return [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: sessionId, uuid: 'u-0', timestamp: t0, cwd }),
    JSON.stringify({ type: 'user', uuid: 'u-1', parentUuid: 'u-0', timestamp: t0, sessionId, cwd, message: { role: 'user', content: title } }),
    JSON.stringify({ type: 'assistant', uuid: 'u-2', parentUuid: 'u-1', timestamp: t0, sessionId, cwd, message: { role: 'assistant', content: [{ type: 'text', text: `${title} reply` }] } }),
  ].join('\n') + '\n'
}

test.describe.serial('P1.14 sidebar registry sync (rust)', () => {
  test.setTimeout(240_000)
  let server: RustServer
  let info: TestServerInfo
  let sharedRoot: string

  test.beforeAll(async () => {
    sharedRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'p114-sidebar-'))
    const binDir = path.join(sharedRoot, 'bin')
    const fakeClaude = await installFakeCli(binDir, 'claude', 'fake-claude-cli.mjs')
    const fakeCodex = await installFakeCli(binDir, 'codex', 'fake-codex-terminal.mjs')
    server = new RustServer({
      env: {
        CLAUDE_CMD: fakeClaude,
        CODEX_CMD: fakeCodex,
        FAKE_CLAUDE_ARGV_LOG: path.join(sharedRoot, 'claude-argv.jsonl'),
        FAKE_CODEX_TERMINAL_ARGV_LOG: path.join(sharedRoot, 'codex-argv.jsonl'),
      },
      setupHome: async (homeDir: string) => {
        await fs.mkdir(PROJECT_DIR, { recursive: true })
        // enable the providers the scenarios use
        const freshellDir = path.join(homeDir, '.freshell')
        await fs.mkdir(freshellDir, { recursive: true })
        await fs.writeFile(path.join(freshellDir, 'config.json'), JSON.stringify({
          version: 1,
          settings: { codingCli: { enabledProviders: ['claude', 'codex'] } },
        }, null, 2))
        // seed a claude session file for case-b (Task 6)
        const slug = PROJECT_DIR.replace(/\//g, '-')
        const projDir = path.join(homeDir, '.claude', 'projects', slug)
        await fs.mkdir(projDir, { recursive: true })
        await fs.writeFile(
          path.join(projDir, `${SEEDED_CLAUDE_ID}.jsonl`),
          buildClaudeSessionJsonl(SEEDED_CLAUDE_ID, PROJECT_DIR, 'P114 seeded claude session'))
      },
    })
    info = await server.start()
  })

  test.afterAll(async () => {
    await server?.stop()
  })

  test('case-c: fresh codex terminal collapses to a single green row', async ({ page }) => {
    await bootAndConnect(page, info)

    // REST-create a fresh codex terminal tab (no resume id) --
    // request shape: donor remote-tab-linkage-rust.spec.ts:197.
    const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      data: { mode: 'codex', cwd: PROJECT_DIR },
    })
    expect(res.ok()).toBe(true)

    // The driven client shows the pane; type Enter so the fake codex
    // terminal materializes its rollout (Enter-gated, fixture contract).
    await expect(page.locator('.xterm')).toBeVisible({ timeout: 20_000 })
    await page.locator('.xterm').last().click()
    await page.keyboard.press('Enter')

    // THE CONTRACT: eventually exactly ONE codex sidebar row, green, and
    // no provisional `terminal:<id>` row left behind -- WITHOUT a reload
    // (proves the sessions.changed push, Task 3, and adoption, Tasks 2+4).
    await expect(async () => {
      const rows = page.locator('[data-provider="codex"][data-session-id]')
      const count = await rows.count()
      expect(count).toBe(1)
      await expect(rows.first()).toHaveAttribute('data-has-tab', 'true')
      const sessionId = await rows.first().getAttribute('data-session-id')
      expect(sessionId?.startsWith('terminal:')).toBe(false)
    }).toPass({ timeout: 45_000 })
  })
})
```

Row-locator note: assert with `[data-provider="codex"][data-session-id]`; if the sidebar list needs scoping use the list container test id (`data-testid="sidebar-session-list"`, per `Sidebar.tsx:770` area) — verify the exact attribute set in `Sidebar.tsx:863-869` while writing.

Register the spec in `playwright.config.ts`:
- `RUST_ONLY_SPECS`: add `'sidebar-registry-sync-rust.spec.ts'` with comment `// imports RustServer directly; restart()/ledger semantics are rust-only (P1.14)`.
- `rust-chromium` project `testMatch`: add the same filename.

- [ ] **Step 2: Run to verify it fails on the pre-fix behavior — or passes with fixes in place**

Prereq (once per e2e session): `cargo build --release -p freshell-server` happens inside the fixture; the client build happens in global-setup. Run:
```bash
cd /home/dan/code/freshell/.worktrees/sidebar-registry-sync
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/sidebar-registry-sync-rust.spec.ts 2>&1 | tail -30
```
Since Tasks 2–4 are already merged into this branch, expected: PASS. To capture the red→green proof required by the lane deliverable, ALSO run the RED demonstration:
```bash
git stash push -- crates/   # temporarily remove the server fixes
cargo build --release -p freshell-server
FRESHELL_E2E_RUST_SERVER_BIN=$PWD/target/release/freshell-server \
  npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/sidebar-registry-sync-rust.spec.ts 2>&1 | tail -15
git stash pop
cargo build --release -p freshell-server
```
Expected: FAIL on the stashed (pre-fix) binary — the duplicate persists / row count is 2 or the row stays `terminal:<id>`. Record both outcomes (this is the e2e red→green proof). If the stash dance is impractical (e.g. conflicts), an acceptable substitute proof: check out `bf6242a1` of `crates/` in a temp build dir and point `FRESHELL_E2E_RUST_SERVER_BIN` at that binary.

- [ ] **Step 3: Record + commit**

Append to the Verification Report:
```markdown
### Case (c) end-to-end (Task 5)
- Pinning e2e: fresh REST-created codex terminal collapses to ONE green row
  without reload. Result on fixed branch: PASS. Result on bf6242a1 server
  binary: FAIL (<observed symptom>) -- red->green proven.
```

```bash
git add test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts test/e2e-browser/playwright.config.ts docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "test(e2e): pin the codex duplicate-collapse sidebar contract (P1.14 case c)"
```

---

### Task 6: E2E pinning — scenario 2: REST-created tabs are green and dedupe (case b, Incident 4)

The literal Incident-4 re-verification: a tab created via the REST agent API with a resume id must render green (`data-has-tab="true"`), and clicking its sidebar row must focus the existing pane, not open a duplicate. Claude and codex variants (amplifier is already pinned by `remote-tab-linkage-rust.spec.ts`, which is re-run in Task 9).

**Files:**
- Modify: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`
- Contingency only (owned files): `src/lib/session-utils.ts`, `src/store/selectors/sidebarSelectors.ts` + their unit tests

**Interfaces:**
- Consumes: Task 5's scaffold (`server`, `info`, `bootAndConnect`, `SEEDED_CLAUDE_ID`, `PROJECT_DIR`, seeded claude JSONL); harness helpers `waitForTabCount`/`getTabCount` (donor usage: `remote-tab-linkage-rust.spec.ts:253` dedupe assertion).
- Produces: scenario `case-b: REST-created resume tabs are green and dedupe on click`; a seeded codex rollout under the server HOME (constant `SEEDED_CODEX_THREAD_ID`) that Task 7 also asserts on.

- [ ] **Step 1: Write the scenario (pinning test)**

Add to the serial suite, after case-c. Seed a codex rollout at runtime (the index TTL is 1s, so a post-boot seed is picked up; donor shape: `sidebar-click-resume.spec.ts` ~`:175-185`):

```ts
const SEEDED_CODEX_THREAD_ID = randomUUID()

async function seedCodexRollout(homeDir: string, threadId: string, cwd: string): Promise<void> {
  // Donor shape: sidebar-click-resume.spec.ts ~:175-185 -- verify field
  // names (session_meta payload.id/payload.cwd + a message record) there.
  const day = '2026/07/20'
  const dir = path.join(homeDir, '.codex', 'sessions', day)
  await fs.mkdir(dir, { recursive: true })
  const lines = [
    JSON.stringify({ timestamp: '2026-07-20T08:00:00.000Z', type: 'session_meta', payload: { id: threadId, cwd } }),
    JSON.stringify({ timestamp: '2026-07-20T08:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'P114 seeded codex session' }] } }),
  ]
  await fs.writeFile(path.join(dir, `rollout-2026-07-20T08-00-00-${threadId}.jsonl`), lines.join('\n') + '\n')
}

test('case-b: REST-created resume tabs are green and dedupe on click', async ({ page }) => {
  await bootAndConnect(page, info)
  await seedCodexRollout(info.homeDir, SEEDED_CODEX_THREAD_ID, PROJECT_DIR)

  for (const [mode, sessionId] of [
    ['claude', SEEDED_CLAUDE_ID],
    ['codex', SEEDED_CODEX_THREAD_ID],
  ] as const) {
    const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      data: { mode, cwd: PROJECT_DIR, resumeSessionId: sessionId },
    })
    expect(res.ok()).toBe(true)

    const row = page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`)
    // Incident-4 contract: the row exists and is GREEN, not grey.
    await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
    await expect(row).toHaveCount(1)

    // Dedupe contract: clicking the green row focuses the existing pane
    // instead of opening a second tab (donor: remote-tab-linkage:253).
    const tabsBefore = await page.evaluate(() => (window as any).__freshellHarness?.getTabCount?.() ?? -1)
    await row.click()
    await page.waitForTimeout(500)
    const tabsAfter = await page.evaluate(() => (window as any).__freshellHarness?.getTabCount?.() ?? -1)
    expect(tabsAfter).toBe(tabsBefore)
  }
})
```
(Use the harness access idiom the donor spec actually uses — `remote-tab-linkage-rust.spec.ts:253` — if it differs from `window.__freshellHarness`.)

- [ ] **Step 2: Run it**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/sidebar-registry-sync-rust.spec.ts 2>&1 | tail -20
```
Expected: PASS (the Incident-4 fix chain — `terminal_tabs.rs` sessionRef synthesis + the session-utils extractor — landed in earlier waves; this pins it). A pinning test passing immediately is the desired verification outcome here — record PASS.

- [ ] **Step 3: CONTINGENCY — only if a case-b assertion fails**

Diagnose which side guessed:
1. Row missing/grey for claude: inspect the created pane's content in the harness (`getPaneLayout`) — if `sessionRef` is absent and only `resumeSessionId` is present, the REST synthesis regressed. That is server territory (`terminal_tabs.rs`, touched in Task 4) — fix there with a unit test mirroring `create_amplifier_tab_with_legacy_resume_synthesizes_session_ref` for the failing mode.
2. Row grey though the pane HAS `sessionRef`: client join bug in owned code. Write a RED unit test in `test/unit/client/lib/session-utils.test.ts` (donor block `:125` `collectSessionLocatorsFromTabs`) reproducing the exact pane content observed, then fix `extractSessionLocators` (`src/lib/session-utils.ts:107` priority list) so the canonical `sessionRef` wins — never add client-side guessing (no matchScore/cwd heuristics; §4.2: client claims are proposals, the server-written `sessionRef` is the adopted truth).
3. Duplicate tab on click: `findPaneForSession` (`session-utils.ts:376`) scoring — same RED-unit-test-first discipline, donor tests at `session-utils.test.ts:216/301`.
Record whichever branch ran (or "none needed") in the Verification Report.

- [ ] **Step 4: Record + commit**

Append to the Verification Report:
```markdown
### Case (b) REST-created tabs / Incident 4 (Task 6)
- claude REST resume tab: <PASS as-is | FIXED via ...>
- codex REST resume tab: <PASS as-is | FIXED via ...>
- click-dedupe: <PASS | FIXED via ...>
- amplifier variant: covered by remote-tab-linkage-rust.spec.ts (re-run in Task 9).
```

```bash
git add test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "test(e2e): pin Incident-4 REST-created-tab sidebar contract (P1.14 case b)"
```

---

### Task 7: E2E pinning — scenario 3: joins survive a server restart (case a)

After a graceful restart (same home/port/token — the deploy-cycle shape), the reconnected client's sidebar must show the same sessions green with no duplicates: reconcile re-attaches the panes, the identity registry repopulates, and the ledger backstops the gap.

**Files:**
- Modify: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`

**Interfaces:**
- Consumes: Task 6's state (open claude + codex resume tabs from case-b, plus case-c's fresh codex pane); `server.restart()` (`rust-server.ts:322`); reconnect-wait idiom from `server-restart-recovery.spec.ts:106-111` (`getWsReadyState() === 'ready'` poll — copy the exact harness call).
- Produces: scenario `case-a: sidebar joins survive a graceful server restart`.

- [ ] **Step 1: Write the scenario (pinning test)**

```ts
test('case-a: sidebar joins survive a graceful server restart', async ({ page }) => {
  await bootAndConnect(page, info)
  // Panes from case-b/case-c are still open in this serial suite's page state?
  // No -- each test gets a fresh page. Re-establish: open both resume tabs.
  for (const [mode, sessionId] of [
    ['claude', SEEDED_CLAUDE_ID],
    ['codex', SEEDED_CODEX_THREAD_ID],
  ] as const) {
    const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
      headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
      data: { mode, cwd: PROJECT_DIR, resumeSessionId: sessionId },
    })
    expect(res.ok()).toBe(true)
    await expect(page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`))
      .toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })
  }

  // Persist the layout before the restart (donor: remote-tab-linkage:277-285).
  await page.evaluate(() => (window as any).__freshellStore?.dispatch?.({ type: 'persist/flushNow' }))

  await server.restart()
  await page.reload({ waitUntil: 'domcontentloaded' })
  // reconnect wait: copy the exact idiom from server-restart-recovery.spec.ts:106-111

  // THE CONTRACT: every session is green again, exactly once.
  for (const [mode, sessionId] of [
    ['claude', SEEDED_CLAUDE_ID],
    ['codex', SEEDED_CODEX_THREAD_ID],
  ] as const) {
    const row = page.locator(`[data-session-id="${sessionId}"][data-provider="${mode}"]`)
    await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 45_000 })
    await expect(row).toHaveCount(1)
  }
  // No provisional ghosts left over from respawned terminals.
  await expect(page.locator('[data-provider="codex"][data-session-id^="terminal:"]')).toHaveCount(0, { timeout: 45_000 })

  // Respawn proof: the fake claude CLI was relaunched with --resume after restart.
  const entries = await readArgvLog(path.join(sharedRoot, 'claude-argv.jsonl'))
  const resumes = entries.filter((e) => {
    const i = e.argv.indexOf('--resume')
    return i !== -1 && e.argv[i + 1] === SEEDED_CLAUDE_ID
  })
  expect(resumes.length).toBeGreaterThanOrEqual(2) // pre-restart + post-restart
})
```
(Use the store/persist access idiom the donor actually uses at `remote-tab-linkage-rust.spec.ts:277-285` — copy verbatim.)

- [ ] **Step 2: Run it**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/sidebar-registry-sync-rust.spec.ts 2>&1 | tail -20
```
Expected: PASS (reconcile handshake + ledger landed in waves A/B; Tasks 2–3 close the sidebar-visibility seams). If the green-again assertion times out, capture `GET /api/session-directory` (with the auth header) and the harness pane layout into the report BEFORE fixing; the likely seams, in order: (1) sweep didn't push after identity repopulation (Task 3 regression), (2) `join_running_state` missed a ledger-resolved identity (Task 2), (3) reconcile didn't re-attach (Lane C2 territory — if so, record the evidence, do NOT fix reconcile internals here; assert the sidebar contract against whatever reconcile verdict is produced and flag the cross-lane dependency in the report as a FAIL with evidence for the campaign to route).

- [ ] **Step 3: Record + commit**

Append to the Verification Report:
```markdown
### Case (a) restart survival (Task 7)
- claude resume pane green after restart: <PASS | detail>
- codex resume pane green after restart: <PASS | detail>
- no provisional terminal:<id> ghosts: <PASS | detail>
- respawn proven via argv log: <PASS | detail>
```

```bash
git add test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "test(e2e): pin sidebar join survival across server restart (P1.14 case a)"
```

---

### Task 8: E2E pinning — scenario 4: joins correct after recover-my-panes (case d)

After an abrupt restart with lost client layout, the user runs the recover-my-panes flow; recovered panes must join green in the sidebar. This drives the EXISTING recovery UI only (Lane C2 owns its internals — we assert the sidebar contract around it).

**Files:**
- Modify: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts`

**Interfaces:**
- Consumes: `server.restartAbrupt()` (`rust-server.ts:344`); the recovery-flow choreography from `test/e2e-browser/specs/recover-my-panes-rust.spec.ts` (localStorage clearing, recovery offer/accept selectors, disk-settle waits — copy the exact helper blocks it uses; it is the canonical donor at `:43` onward); the claude row from `SEEDED_CLAUDE_ID`.
- Produces: scenario `case-d: recovered panes join green in the sidebar`; completes the four-case pinning matrix.

- [ ] **Step 1: Write the scenario (pinning test)**

Keep this scenario LAST in the serial suite (it destroys local layout). Skeleton — lift the recovery choreography verbatim from the donor:

```ts
test('case-d: recovered panes join green in the sidebar', async ({ page }) => {
  await bootAndConnect(page, info)

  // Open a claude resume pane so there is something to lose + recover.
  const res = await page.request.post(`${info.baseUrl}/api/tabs`, {
    headers: { authorization: `Bearer ${info.token}`, 'content-type': 'application/json' },
    data: { mode: 'claude', cwd: PROJECT_DIR, resumeSessionId: SEEDED_CLAUDE_ID },
  })
  expect(res.ok()).toBe(true)
  await expect(page.locator(`[data-session-id="${SEEDED_CLAUDE_ID}"][data-provider="claude"]`))
    .toHaveAttribute('data-has-tab', 'true', { timeout: 30_000 })

  // [copy from recover-my-panes-rust.spec.ts: wait for the ledger/snapshot
  //  disk writes to settle before the kill -- its exact wait helper]

  await server.restartAbrupt()

  // Lost-client simulation + recovery acceptance:
  // [copy from recover-my-panes-rust.spec.ts: clear the freshell.layout.*
  //  localStorage keys, reload, wait for the recovery offer UI, accept it,
  //  wait for panes to be recreated -- its exact selectors and waits]

  // THE CONTRACT: the recovered session is green again, exactly once.
  const row = page.locator(`[data-session-id="${SEEDED_CLAUDE_ID}"][data-provider="claude"]`)
  await expect(row).toHaveAttribute('data-has-tab', 'true', { timeout: 45_000 })
  await expect(row).toHaveCount(1)
})
```

- [ ] **Step 2: Run the full spec**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium specs/sidebar-registry-sync-rust.spec.ts 2>&1 | tail -20
```
Expected: all four scenarios PASS. If case-d's final assertion fails while the recovery flow itself visibly succeeded (panes exist, terminals running), the gap is the sidebar join for recovered panes: check whether the recovered pane content carries `sessionRef` (harness `getPaneLayout`). If it does and the row is still grey, that is owned client join code — follow Task 6 Step 3's contingency discipline. If the recovery flow itself fails, that is Lane C2 territory: record evidence as FAIL-with-evidence in the report, do not fix recovery internals.

- [ ] **Step 3: Record + commit**

Append to the Verification Report:
```markdown
### Case (d) recover-my-panes (Task 8)
- Recovered claude pane joins green: <PASS | detail>
```

```bash
git add test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "test(e2e): pin sidebar joins after recover-my-panes recovery (P1.14 case d)"
```

---

### Task 9: Full verification, report completion, push

**Files:**
- Modify: `docs/plans/2026-07-26-sidebar-registry-sync.md` (final Verification Report section)

**Interfaces:**
- Consumes: everything above.
- Produces: the lane deliverable — pushed branch, completed verification report (which cases passed as-is, which needed fixes, what remains with justification), red→green proof references.

- [ ] **Step 1: Rust full gate**

```bash
cd /home/dan/code/freshell/.worktrees/sidebar-registry-sync
df -h .   # halt on ENOSPC risk
cargo test --workspace 2>&1 | tail -10
cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -5
```
Expected: PASS / zero warnings.

- [ ] **Step 2: Coordinated vitest suite (gate-aware)**

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="P1.14 sidebar-registry-sync full suite" npm test 2>&1 | tail -20
```
Expected: PASS. WAIT for the gate if held (2 sibling lanes are running).

- [ ] **Step 3: Affected existing e2e re-runs (regression net for the touched seams)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/sidebar-registry-sync-rust.spec.ts \
  specs/remote-tab-linkage-rust.spec.ts \
  specs/server-restart-recovery.spec.ts \
  specs/recover-my-panes-rust.spec.ts \
  specs/sidebar-click-resume.spec.ts 2>&1 | tail -20
```
Expected: all PASS. (These cover the amplifier Incident-4 variant, the generic restart skeleton, the recovery flow this plan asserts around, and sidebar click-resume.)

- [ ] **Step 4: Complete the Verification Report**

Finalize the `## Verification Report` section so it answers the spec's deliverable directly:
- Table of the four contract cases → PASS-as-is / FIXED (with commit shas) / FAIL-with-evidence (cross-lane, routed).
- The fixes list: ledger-backed join (Task 2), identity-aware sweep push (Task 3), REST codex arming (Task 4), plus any contingencies that fired.
- "What remains" with justification. Expected residuals to document honestly (both are outside this lane's contract cases, documented not deferred-from-scope): (1) tabs open ONLY in another client/device still render grey locally — `hasTab` means "open in THIS client"; the registry pane payload carries `sessionRef` (untyped) and a semantics decision (green vs a third state) is a user-facing design call the campaign must make; (2) REST-created terminal identities are never retired on exit (documented at `terminal_tabs.rs:839-853`, a crate-cycle constraint predating this lane).
- Red→green proof pointers: Task 2/3/4 RED steps + Task 5 Step 2's pre-fix binary run.

- [ ] **Step 5: Commit + push, STOP before PR**

```bash
git add docs/plans/2026-07-26-sidebar-registry-sync.md
git commit -m "docs(p1.14): complete sidebar-registry-sync verification report"
git push -u origin feat/sidebar-registry-sync
```
PR POLICY: NOT approved — do NOT run `gh pr create`. Final output: branch name, the Verification Report, and the red→green proof references.

---

## Verification Report

(Appended per task during execution. Baseline in Task 1; cases c/b/a/d in Tasks 2–8; final consolidation in Task 9.)
