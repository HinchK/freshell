# REST Claude Pane Session Identity Parity Implementation Plan (kata hbsa)

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Claude panes created via the REST agent API (`POST /api/tabs`, `POST /api/panes/:id/split`, `POST /api/panes/:id/respawn`) acquire full session identity at create time — preallocated `--session-id` in argv, pre-spawn pane-ledger binding (PIN 2), `TerminalIdentityRegistry` row, and a real `sessionRef` on every reporting surface — exactly like the WS `terminal.create` fresh-claude path, so REST panes are resumable and visible to the A13 live-owner guard.

**Architecture:** Three moves. (1) Extract the WS fresh-claude preallocation *predicate* into `freshell-platform` (both crates already depend on it) and mint the UUID on the REST path, flipping `LaunchIntent` to `Start` so `claude --session-id <uuid>` lands in argv — this alone populates the registry row, `paneContent.sessionRef`, and `GET /api/terminals` rung 0. (2) Bridge the crate boundary for the two write-side identity homes (`TerminalIdentityRegistry` + `PaneLedger`, both `freshell-ws`-owned and unreachable from `freshell-freshagent`) with a new `PaneIdentityBinder` trait defined in `freshell-terminal` (same seam pattern as the existing read-only `SessionIdentityLookup`), implemented in `freshell-ws`, injected in `freshell-server::main`. (3) Regression tests at the merged REST+WS server level proving resume identity, A13 refusal, and SessionStart signal consumption, plus pinning tests for the codex/opencode REST lanes.

**Tech Stack:** Rust (toolchain pinned 1.96.0), axum, tokio, `async-trait`, `uuid`; existing test harnesses in `crates/freshell-ws/tests/common/mod.rs` and `crates/freshell-freshagent/src/terminal_tabs.rs mod tests`.

**Baseline:** branch `fix/rest-terminal-session-identity` in worktree `/home/dan/code/freshell/.worktrees/rest-terminal-session-identity`, branched from `origin/main` @ `4c04dc9c`. All file:line references below are against that commit.

## Global Constraints

- **NEVER touch the production Rust server on port 3002.** It sweeps `~/.freshell/session-signals/` every ~1s and holds the pane-ledger flock. Tests MUST use isolated temp dirs: construct `ClaudeSignalWatcher::new(<temp dir>)` (never `default_root()`), `PaneLedger::new(Some(<temp dir>))` or `PaneLedger::disabled()` (never `new_locked`), and never `std::env::set_var("HOME", ..)`.
- Red-green-refactor TDD; run the failing test before implementing.
- `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` must pass (toolchain 1.96.0).
- Contract freeze diff-clean: **no new WS frames, no WS contract changes.** Verify with `npm run test:port && npm run contract:generate && git diff --exit-code -- port/contract` and `cargo test -p freshell-protocol --locked`.
- Coordinated JS runs only: `npm ci` in the worktree first (known environmental failure otherwise), then `FRESHELL_TEST_SUMMARY="rest terminal session identity regression" npm run check`.
- Do NOT regress: A13 live-owner guard, D7/D8 leases, one-writer invariant, PIN 2 pre-spawn binding scoping (eaa25b7d: the pre-spawn *write* gate and the spawn-failure *delete* gate must be the SAME predicate, fresh-claude-preallocs only), act-then-delete drain disposition (#578), deterministic signal ordering (#575), hello/HelloTracker, salvage-hardening (#573), codex self-healing (#574), opencode existence-fallback (#579).
- The WS fresh-claude path (`crates/freshell-ws/src/terminal.rs:1630-1661`, `:2194-2236`, `:2453-2538`, `:2597-2609`) is the reference implementation — reuse its code where the crate graph allows (the shared predicate), mirror it exactly where it does not (the binder). No forced refactors beyond that.
- Fresh-claude preallocation must NOT claim a D8 sessionRef lease (`create_session_locator` doctrine, `terminal.rs:1163-1178`) — the minted id is freshly minted, carries no concurrent-duplicate shape, and must not route through the lease path. On REST this is automatic: the D7/D8 block at `terminal_tabs.rs:961-1038` keys off `accepted_session_ref`, which is `None` for a minted id. Keep it that way.
- Ledger write failures never block a create — log and proceed (best-effort durability, mirrors `surface_write_failure` policy).
- Kata: tracked as kata issue hbsa. Do NOT close it from within this workflow; the controller closes it after the branch lands.
- Do NOT create a PR — stop after pushing the branch.
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working/agent doc. Create no other markdown files.
- There is a pre-existing **untracked** file `docs/superpowers/plans/2026-07-29-rest-terminal-session-identity.md` in the worktree from a different (codex-scoped) workflow. Leave it untracked; never `git add -A` — stage files explicitly in every commit.

## Node Parity Decision (Required Outcome 5 — resolved, no Node code changes)

The repo's parity conventions require **Rust-only** work here:

- Root `AGENTS.md:68`: the Node server "still exists but is not what the user runs day-to-day."
- `port/AGENTS.md`: "Fix bugs; do not replicate them" — fixes land in the port (Rust), with the original's behavior logged, not mirrored.
- Direct precedent: the PIN 2 pre-spawn binding work (`c12e7d71`/`eaa25b7d`) and the REST spawn gate ("A4 parity with WS", `docs/plans/2026-07-27-rest-spawn-gate.md`) — the closest analogues to this fix — landed Rust-only. `docs/plans/2026-07-29-rebind-salvage-hardening.md:49-50` says "OUT OF SCOPE: the Node/TypeScript server (exists, not production — add NO Node server functionality)"; `docs/plans/2026-07-29-opencode-existence-fallback.md:18` says "Rust server only. No Node server work."
- Node's ledger doesn't exist (the pane-identity ledger is Rust-only, P1.8), so most of this fix has no Node counterpart to mirror anyway.

What Requirement 5 therefore reduces to in this plan: (a) zero `server/` changes; (b) the frozen WS contract stays diff-clean (verified in Task 8); (c) the stale code comment in `terminal_tabs.rs:1327-1335` that cites `router.ts` as justification for the legacy split is rewritten when the split is fixed (Task 2), so the Node lineage is no longer cited as load-bearing.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-platform/src/cli_launch.rs` | Modify | New shared pure predicate `should_preallocate_fresh_claude(..)` + unit tests (truth table). Single source of the "fresh claude" policy for both doors. |
| `crates/freshell-ws/src/terminal.rs` | Modify | `handle_create` adopts the shared predicate (behavior-preserving swap of `terminal.rs:1630-1637`). |
| `crates/freshell-terminal/src/registry.rs` | Modify | New `PaneIdentityBinder` trait next to `SessionIdentityLookup` (`registry.rs:638-641`) — the write-side seam. |
| `crates/freshell-terminal/Cargo.toml` | Modify | Add `async-trait` dependency (workspace version). |
| `crates/freshell-ws/src/pane_identity_binder.rs` | Create | `LedgerPaneIdentityBinder` — the production impl over `TerminalIdentityRegistry` + `Arc<PaneLedger>`, mirroring `terminal.rs:2211-2236`, `:2281-2292`, `:2487-2538`. In-module unit tests with tempdir ledger. |
| `crates/freshell-ws/src/lib.rs` | Modify | `pub mod pane_identity_binder;` |
| `crates/freshell-freshagent/src/terminal_tabs.rs` | Modify | UUID mint after `derive_resume_identity` (`:767`); `claude_fresh_prealloc` threading through `GatedSettleInputs`; `LaunchIntent` conditional (`:1335`); binder call sites (pre-spawn, failure-delete, post-spawn); `tab_create_missing_session_identity` condition update (`:1792-1805`); unit tests in `mod tests`. |
| `crates/freshell-freshagent/src/lib.rs` | Modify | `FreshAgentState.pane_identity: Option<Arc<dyn PaneIdentityBinder>>` + `with_pane_identity_binder(..)` builder (mirror `with_session_identity`, `lib.rs:455-461`). |
| `crates/freshell-server/src/main.rs` | Modify | Wire `LedgerPaneIdentityBinder` into the freshagent state (next to the `with_session_identity` wiring at `main.rs:286`). |
| `crates/freshell-ws/tests/rest_claude_identity.rs` | Create | End-to-end merged REST+WS server tests: resume identity survives signal destruction (4a), A13 refusal of WS resume of a REST-live session (4b), SessionStart signal consumed Acted (4c), REST resume-direction ledger/identity writes. |
| `crates/freshell-ws/tests/rest_locator_identity.rs` | Create | Requirement 3 pinning tests: REST-created codex and opencode panes end with identity row + Bound ledger row (and a pending marker at create). |
| `crates/freshell-ws/tests/pane_ledger_restore.rs` | Modify (if red) | Reconcile the REST-resume "only footprint is a live registry row" premise (`:237-302`) with the new behavior. |

Dependency direction (why the trait lives in `freshell-terminal`): `freshell-freshagent` cannot depend on `freshell-ws` (circular — stated at `terminal_tabs.rs:1401-1409`). Both depend on `freshell-terminal` and `freshell-platform`. `freshell-server` depends on everything and does the wiring. This is exactly the `SessionIdentityLookup` precedent.

---

### Task 1: Shared fresh-claude preallocation predicate

**Files:**
- Modify: `crates/freshell-platform/src/cli_launch.rs` (new pub fn + `mod tests` additions)
- Modify: `crates/freshell-platform/src/lib.rs` (re-export, matching how `CliCommandSpec` is re-exported)
- Modify: `crates/freshell-ws/src/terminal.rs:1630-1637` (adopt the helper)

**Interfaces:**
- Consumes: nothing new.
- Produces: `freshell_platform::should_preallocate_fresh_claude(mode: &str, restore: Option<bool>, has_session_ref: bool, resume_session_id: Option<&str>) -> bool` — used by Task 2 (REST) and by the WS handler from this task onward.

- [ ] **Step 1: Write the failing unit tests**

In `crates/freshell-platform/src/cli_launch.rs`, inside the existing `#[cfg(test)] mod tests` (or a new one if the file keeps tests elsewhere — follow the file's existing convention):

```rust
#[test]
fn fresh_claude_preallocation_predicate_truth_table() {
    use super::should_preallocate_fresh_claude as pred;
    // The three-part freshness predicate from the WS reference
    // (crates/freshell-ws/src/terminal.rs:1630-1637): mode == "claude"
    // AND restore != Some(true) AND no sessionRef AND no non-empty
    // resumeSessionId.
    assert!(pred("claude", None, false, None));
    assert!(pred("claude", Some(false), false, None));
    // Empty resume id is treated as absent (matches the WS
    // `.filter(|s| !s.is_empty()).is_none()` shape).
    assert!(pred("claude", None, false, Some("")));
    // Any disqualifier kills the mint:
    assert!(!pred("claude", Some(true), false, None)); // restore create
    assert!(!pred("claude", None, true, None)); // wire sessionRef present
    assert!(!pred("claude", None, false, Some("29a53649-0000-4000-8000-000000000000"))); // resume
    // Only claude mints with Start intent; other providers never do here:
    assert!(!pred("shell", None, false, None));
    assert!(!pred("codex", None, false, None));
    assert!(!pred("amplifier", None, false, None));
    assert!(!pred("opencode", None, false, None));
    assert!(!pred("gemini", None, false, None));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p freshell-platform fresh_claude_preallocation_predicate_truth_table -- --exact`
Expected: FAIL to compile — `should_preallocate_fresh_claude` not defined.

- [ ] **Step 3: Implement the predicate**

In `crates/freshell-platform/src/cli_launch.rs` (top-level, near `resolve_coding_cli_command`):

```rust
/// LIVE-PATH LAW (specs/coding-cli.md §2.1(3)): fresh claude ALWAYS gets a
/// server-preallocated `--session-id`. This is the single shared "is this
/// create a fresh claude that must mint its own session id?" predicate,
/// used by BOTH doors — the WS `terminal.create` handler
/// (`freshell-ws/src/terminal.rs`) and the REST spawn pipeline
/// (`freshell-freshagent/src/terminal_tabs.rs`) — so the two cannot drift
/// (kata hbsa: the REST door skipped preallocation entirely, leaving
/// un-resumable panes invisible to the A13 live-owner guard).
///
/// The caller that gets `true` mints `Uuid::new_v4()`, sets
/// `LaunchIntent::Start` (claude's manifest has `create_session_args`),
/// and marks the create as a fresh prealloc for PIN 2 gating (eaa25b7d).
pub fn should_preallocate_fresh_claude(
    mode: &str,
    restore: Option<bool>,
    has_session_ref: bool,
    resume_session_id: Option<&str>,
) -> bool {
    mode == "claude"
        && restore != Some(true)
        && !has_session_ref
        && resume_session_id.filter(|s| !s.is_empty()).is_none()
}
```

Re-export from `crates/freshell-platform/src/lib.rs` the same way `CliCommandSpec` is re-exported (add `should_preallocate_fresh_claude` to the existing `pub use` for the `cli_launch` module).

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p freshell-platform fresh_claude_preallocation_predicate_truth_table -- --exact`
Expected: PASS

- [ ] **Step 5: Adopt the helper in the WS handler (behavior-preserving)**

In `crates/freshell-ws/src/terminal.rs:1630-1637`, replace the inline predicate:

```rust
        let should_preallocate_fresh_claude = mode == "claude"
            && create.restore != Some(true)
            && create.session_ref.is_none()
            && create
                .resume_session_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .is_none();
```

with:

```rust
        // Shared with the REST spawn pipeline (kata hbsa) — one predicate,
        // two doors: freshell_platform::should_preallocate_fresh_claude.
        let should_preallocate_fresh_claude = freshell_platform::should_preallocate_fresh_claude(
            &mode,
            create.restore,
            create.session_ref.is_some(),
            create.resume_session_id.as_deref(),
        );
```

Do not touch anything else in the `if mode != "shell"` block — the amplifier sibling (`should_preallocate_fresh_amplifier`) and the `claude_fresh_prealloc = true` assignment at `:1660` stay exactly as they are.

- [ ] **Step 6: Run the WS regression suite to prove no drift**

Run:
```bash
cargo test -p freshell-ws --test claude_session_rebind
cargo test -p freshell-ws --test live_session_ref_guard
cargo test -p freshell-ws --test pane_ledger_triggers
```
Expected: all PASS (these pin the fresh-claude preallocation, A13 refusal, and eaa25b7d scoping respectively).

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-platform/src/cli_launch.rs crates/freshell-platform/src/lib.rs crates/freshell-ws/src/terminal.rs
git commit -m "refactor(platform): shared fresh-claude preallocation predicate for both create doors"
```

---

### Task 2: REST mint — preallocated `--session-id`, `LaunchIntent::Start`, sessionRef surfaces

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`spawn_terminal_pane` ~`:767`, `GatedSettleInputs` `:1130`, `settle_gated_create` `:1322-1339`, warn site `:1792-1805`, `mod tests`)

**Interfaces:**
- Consumes: `freshell_platform::should_preallocate_fresh_claude` (Task 1).
- Produces: `GatedSettleInputs.claude_fresh_prealloc: bool` — Task 5's binder call sites gate on this exact field (eaa25b7d symmetry). Fresh REST claude creates now carry `resume_session_id = Some(<minted uuid>)` through the whole pipeline: `registry.create(..)` (`:1481-1493`), `registry.set_meta(.., resume_session_id)` (`:1589-1595`), `paneContent.sessionRef` promotion (`:1683-1692`), and `GET /api/terminals` rung 0 (`crates/freshell-server/src/terminals.rs:686-698` reads `entry.resume_session_id` — no change needed there).

- [ ] **Step 1: Write the failing test — fresh REST claude tab preallocates identity**

In `crates/freshell-freshagent/src/terminal_tabs.rs` `mod tests` (starts `:2190`). Mirror the harness of the existing spawning test `create_opencode_tab_fresh_spawns_with_hostname_port_args_and_arms_locator` (`:3321`) for how the test injects a fake CLI spec and captures argv — reuse its helper functions verbatim (same state constructor, same script-writing helper, same argv-capture mechanism), swapping the spec for a claude-named one. The claude spec MUST include `create_session_args: Some(vec!["--session-id".into(), "{{sessionId}}".into()])` — `LaunchIntent::Start` hard-errors without it (`cli_launch.rs:496-510`, `StartIntentUnsupported`).

```rust
#[tokio::test]
async fn create_fresh_claude_tab_preallocates_session_identity() {
    // kata hbsa P1: REST parity with the WS fresh-claude special case.
    // A fresh POST /api/tabs {mode:"claude"} must mint a --session-id,
    // carry it in the registry row, and expose it as paneContent.sessionRef.
    let (state, registry, argv_capture_path) = state_with_claude_capture_spec(); // build per :3321's harness
    let (status, body) = post(
        app(state),
        "/api/tabs",
        serde_json::json!({
            "mode": "claude",
            "cwd": std::env::temp_dir().to_string_lossy(),
        }),
        true,
    )
    .await;
    assert_eq!(status, axum::http::StatusCode::OK, "create failed: {body}");

    // 1. sessionRef surfaced on the create response (paneContent promotion).
    let session_ref = body["data"]["paneContent"]["sessionRef"].clone();
    assert_eq!(session_ref["provider"], serde_json::json!("claude"), "sessionRef: {body}");
    let sid = session_ref["sessionId"].as_str().expect("sessionId string").to_string();
    uuid::Uuid::parse_str(&sid).expect("preallocated id is a canonical UUID");

    // 2. Registry row carries the id (this is GET /api/terminals rung 0,
    //    terminals.rs:686-698 — populating it makes sessionRef real there
    //    with zero changes to terminals.rs).
    let terminal_id = body["data"]["paneContent"]["terminalId"]
        .as_str()
        .expect("terminalId")
        .to_string();
    let row = registry
        .identity_probe_rows()
        .into_iter()
        .find(|r| r.terminal_id == terminal_id)
        .expect("registry row exists");
    assert_eq!(row.resume_session_id.as_deref(), Some(sid.as_str()));

    // 3. argv proof: `claude --session-id <uuid>` (LaunchIntent::Start),
    //    NOT `--resume` and NOT bare argv.
    let argv = wait_for_captured_argv(&argv_capture_path); // per :3321's capture idiom
    let pos = argv.iter().position(|a| a == "--session-id").expect("--session-id in argv");
    assert_eq!(argv.get(pos + 1).map(String::as_str), Some(sid.as_str()));
    assert!(!argv.iter().any(|a| a == "--resume"), "fresh create must not resume: {argv:?}");

    registry.kill(&terminal_id);
}
```

Notes for the implementer:
- If the response JSON shape differs (e.g. `paneContent` nested differently), print `body` from the failing run and adjust the *accessor paths only* — the three assertions (response sessionRef, registry row, argv pair) are the contract.
- If no argv-capture helper exists locally in this `mod tests`, port `write_fake_claude_capture()` from `crates/freshell-ws/tests/claude_session_rebind.rs:53-79` (a `#!/bin/sh` script dumping `"$@"` to `$CLAUDE_ARGV_CAPTURE_PATH` then `exec sleep 300`, chmod 0755, written to `std::env::temp_dir()`), and point the spec's `default_cmd` at it directly (avoid `env_var`/process-global env in this shared test binary if a direct path works).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p freshell-freshagent create_fresh_claude_tab_preallocates_session_identity -- --exact`
Expected: FAIL — `sessionRef` absent from `paneContent` (today's behavior: no mint, `resume_session_id = None`).

- [ ] **Step 3: Implement the mint in `spawn_terminal_pane`**

In `crates/freshell-freshagent/src/terminal_tabs.rs`, immediately after the `derive_resume_identity` call at `:767`:

```rust
    let (mut resume_session_id, accepted_session_ref) = derive_resume_identity(body, &mode)?;

    // Fresh-claude preallocation (kata hbsa): WS parity. The WS door's
    // fresh-claude special case (freshell-ws/src/terminal.rs, LIVE-PATH LAW
    // spec §2.1(3)) mints a server-preallocated --session-id for every fresh
    // claude create; this REST door historically did not (legacy router.ts
    // lineage), leaving REST claude panes un-resumable and invisible to the
    // A13 live-owner guard. Same predicate, same mint, both doors.
    //
    // PIN 2 (eaa25b7d): `claude_fresh_prealloc` marks that THIS create minted
    // the id — the pre-spawn ledger write and its spawn-failure delete (Task 5
    // call sites in settle_gated_create) are BOTH gated on this exact flag,
    // never on `mode == "claude"`.
    let claude_fresh_prealloc = freshell_platform::should_preallocate_fresh_claude(
        &mode,
        body.get("restore").and_then(serde_json::Value::as_bool),
        body.get("sessionRef").is_some(),
        resume_session_id.as_deref(),
    );
    if claude_fresh_prealloc {
        resume_session_id = Some(uuid::Uuid::new_v4().to_string());
    }
```

(`uuid::Uuid::new_v4()` is already in use in this file at `:831` for the amplifier mint — same import path.)

Note the predicate uses `body.get("sessionRef").is_some()` — the raw-field check, exact WS semantics (`create.session_ref.is_none()`), not `accepted_session_ref.is_some()`: a wire `sessionRef` of ANY provider disables the mint on both doors.

Placement matters: this sits BEFORE the amplifier block (`:794-950`) and BEFORE the D7 guard (`:961-990`). The D7/D8 machinery keys off `accepted_session_ref`, which is `None` here, so a minted id claims no lease and trips no guard — matching the WS doctrine that fresh preallocs never route through D8.

- [ ] **Step 4: Thread the flag and flip the launch intent**

1. Add `claude_fresh_prealloc: bool` to `struct GatedSettleInputs` (`:1130`) and to its destructuring at `:1168`; populate it at the `tokio::spawn(settle_gated_create(GatedSettleInputs { .. }))` call site (`:1096`).
2. In `settle_gated_create`, replace `:1322-1339` (the `CliLaunchInputs` literal's intent field and its stale comment):

```rust
            resume_session_id: resume_session_id.as_deref(),
            // WS-parity launch intent (kata hbsa). `Start` selects claude's
            // `create_session_args` template (`--session-id {{sessionId}}`,
            // cli_launch_goldens.rs:52) for the id THIS create minted;
            // everything else is a genuine resume — an accepted `sessionRef`,
            // a legacy `resumeSessionId`, or the fresh-amplifier mint at
            // `spawn_terminal_pane` (:820-831), which deliberately keeps
            // `Resume` (amplifier's manifest has `resume_args` only and
            // `Start` would hard-error `StartIntentUnsupported`,
            // cli_launch.rs:496-510). Mirrors the WS door
            // (freshell-ws/src/terminal.rs fresh-claude special case).
            launch_intent: if claude_fresh_prealloc {
                LaunchIntent::Start
            } else {
                LaunchIntent::Resume
            },
```

This deletes the old "this path never mints its OWN preallocated session id … matches `router.ts`" comment — that legacy split is exactly what this task removes (and its `terminal.rs:749-762` cross-reference was stale anyway).

- [ ] **Step 5: Run the test to verify it passes**

Run: `cargo test -p freshell-freshagent create_fresh_claude_tab_preallocates_session_identity -- --exact`
Expected: PASS

- [ ] **Step 6: Reconcile the `tab_create_missing_session_identity` warn site and its pinned tests**

Run the two existing pinning tests first:

```bash
cargo test -p freshell-freshagent create_fresh_session_provider_tab_without_identity_warns_invariant -- --exact
cargo test -p freshell-freshagent create_tab_with_identity_or_shell_mode_does_not_warn_invariant -- --exact
```

The warn at `:1792-1805` fires when the create *request* carried neither `sessionRef` nor `resumeSessionId`. A fresh claude create still carries neither in the request, but it now HAS identity (the mint). Update the condition to consult the spawn outcome, so the alarm means what it says ("the pane has no identity key"):

```rust
    if is_session_provider_mode(&mode)
        && payload.get("sessionRef").is_none()
        && payload.get("resumeSessionId").is_none()
        // kata hbsa: fresh claude REST creates now mint their own identity
        // (paneContent.sessionRef) — a create that ended up with a real
        // sessionRef is not identity-less, so it must not alarm.
        && payload
            .get("paneContent")
            .and_then(|c| c.get("sessionRef"))
            .is_none()
    {
```

(If `payload` in that function does not embed `paneContent`, gate on the spawn result's sessionRef instead — the `TerminalSpawnResult`/local variable that carried `paneContent` into the payload a few lines earlier in `create_terminal_tab`. The semantic is fixed: *skip the warn when the finished create has a sessionRef*.)

Then fix the tests:
- If `create_fresh_session_provider_tab_without_identity_warns_invariant` used `mode:"claude"`, switch it to a session-provider mode that still has no create-time identity source (`"gemini"`) — the alarm is still correct for those.
- Add a new negative case (same file, next to the existing negative test, reusing its warn-capture mechanism):

```rust
#[tokio::test]
async fn create_fresh_claude_tab_does_not_warn_missing_identity() {
    // kata hbsa: the mint closes the identity gap, so the invariant alarm
    // must stay quiet for fresh claude REST creates.
    // (Same harness as create_tab_with_identity_or_shell_mode_does_not_warn_invariant,
    // with a fresh {mode:"claude"} body and no sessionRef/resumeSessionId.)
    ...
}
```

Run: `cargo test -p freshell-freshagent -- warns_invariant does_not_warn`
Expected: PASS (all three).

- [ ] **Step 7: Run the whole freshagent suite**

Run: `cargo test -p freshell-freshagent`
Expected: PASS. If any existing test pinned "fresh claude REST create has no sessionRef" (search failures for `sessionRef`), flip its expectation deliberately and note it in the commit message — that was the bug's pin, not a contract.

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "fix(freshagent): REST claude creates mint a preallocated --session-id (WS parity, kata hbsa)"
```

---

### Task 3: Split and respawn entry points carry the same identity

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` `mod tests` (tests only — `pane_ops::split_pane` (`pane_ops.rs:156`) and `pane_ops::respawn_pane` (`pane_ops.rs:716`) both funnel through `spawn_terminal_pane`, so Task 2 already fixed them; this task PINS that)

**Interfaces:**
- Consumes: Task 2's mint. The router under test is `crate::router(state)`, which registers `/api/panes/:id/split` and `/api/panes/:id/respawn` (`pane_ops.rs:56-61`).
- Produces: nothing new — regression pins only.

- [ ] **Step 1: Write the failing-or-passing pin tests**

Same harness as Task 2's test (fake claude spec with `create_session_args`; the split/respawn spawns will each need their own argv-capture file if argv is asserted — asserting `sessionRef` + registry row is sufficient here and avoids capture-path races):

```rust
#[tokio::test]
async fn split_pane_claude_preallocates_fresh_session_identity() {
    // kata hbsa P2: POST /api/panes/:id/split shares spawn_terminal_pane,
    // so a claude split must mint its OWN fresh identity (distinct from
    // the source pane's).
    let (state, registry, _capture) = state_with_claude_capture_spec();
    let router = app(state);

    let (status, tab) = post(router.clone(), "/api/tabs",
        serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}), true).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let pane_id = tab["data"]["paneContent"]["paneId"].as_str()
        .or_else(|| tab["data"]["paneId"].as_str())
        .expect("pane id in create response").to_string();
    let first_sid = tab["data"]["paneContent"]["sessionRef"]["sessionId"]
        .as_str().expect("first pane minted").to_string();

    let (status, split) = post(router, &format!("/api/panes/{pane_id}/split"),
        serde_json::json!({"mode":"claude"}), true).await;
    assert_eq!(status, axum::http::StatusCode::OK, "split failed: {split}");
    let split_ref = split["data"]["paneContent"]["sessionRef"].clone();
    assert_eq!(split_ref["provider"], serde_json::json!("claude"), "split sessionRef: {split}");
    let split_sid = split_ref["sessionId"].as_str().expect("split minted").to_string();
    uuid::Uuid::parse_str(&split_sid).expect("canonical UUID");
    assert_ne!(split_sid, first_sid, "split must mint its OWN identity");

    // Registry rows for BOTH panes carry their ids.
    let rows = registry.identity_probe_rows();
    assert_eq!(
        rows.iter().filter(|r| r.resume_session_id.is_some()).count(),
        2,
        "both claude panes carry resume identity: {rows:?}"
    );
    for r in rows { registry.kill(&r.terminal_id); }
}

#[tokio::test]
async fn respawn_pane_claude_ends_with_session_identity() {
    // kata hbsa P2: POST /api/panes/:id/respawn also funnels through
    // spawn_terminal_pane. The pin is the identity GAP being closed: the
    // respawned claude pane must end with a real sessionRef (whether the
    // respawn resumes the prior id or mints fresh is respawn policy, pinned
    // elsewhere — the bug here was ending with NO identity at all).
    let (state, registry, _capture) = state_with_claude_capture_spec();
    let router = app(state);

    let (status, tab) = post(router.clone(), "/api/tabs",
        serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}), true).await;
    assert_eq!(status, axum::http::StatusCode::OK);
    let pane_id = tab["data"]["paneContent"]["paneId"].as_str()
        .or_else(|| tab["data"]["paneId"].as_str())
        .expect("pane id").to_string();

    let (status, respawned) = post(router, &format!("/api/panes/{pane_id}/respawn"),
        serde_json::json!({}), true).await;
    assert_eq!(status, axum::http::StatusCode::OK, "respawn failed: {respawned}");
    let sid = respawned["data"]["paneContent"]["sessionRef"]["sessionId"]
        .as_str().expect("respawned pane has identity").to_string();
    uuid::Uuid::parse_str(&sid).expect("canonical UUID");

    for r in registry.identity_probe_rows() { registry.kill(&r.terminal_id); }
}
```

(Adjust response accessor paths against actual bodies as in Task 2; look at the existing split/respawn tests in `pane_ops.rs`/`terminal_tabs.rs mod tests` for the exact request/response shapes — `pane_ops.rs:1011` shows a helper POSTing `/api/tabs` you can crib.)

- [ ] **Step 2: Run them**

Run: `cargo test -p freshell-freshagent -- split_pane_claude respawn_pane_claude`
Expected: PASS (Task 2 fixed the shared pipeline). If respawn FAILS because `respawn_pane` rebuilds a body that carries the old pane's `sessionRef`/`resumeSessionId` and the prior session is refused by a guard, that's a real finding: fix by letting the respawn body flow through `derive_resume_identity` + the Task 2 mint unchanged (a respawn body WITH identity resumes, one WITHOUT mints) and record the behavior in the test's comment.

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "test(freshagent): pin claude identity mint on REST split and respawn entry points"
```

---

### Task 4: `PaneIdentityBinder` seam + `LedgerPaneIdentityBinder`

**Files:**
- Modify: `crates/freshell-terminal/src/registry.rs` (trait, next to `SessionIdentityLookup` at `:638-641`)
- Modify: `crates/freshell-terminal/Cargo.toml` (add `async-trait` — use the workspace-dep form other crates use, e.g. copy the line from `crates/freshell-freshagent/Cargo.toml`)
- Create: `crates/freshell-ws/src/pane_identity_binder.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (`pub mod pane_identity_binder;`)

**Interfaces:**
- Consumes: `crate::identity::TerminalIdentityRegistry` (`identity.rs:33-56`, methods `upsert`), `crate::pane_ledger::{PaneLedger, BindingWrite}` (`pane_ledger.rs:144-152`, `:358`), the `MARKER_MODES` list + `record_pending` call currently at `terminal.rs:2523-2540`, and `freshell-ws`'s existing `now_ms()` helper (grep `fn now_ms` in the crate; reuse, don't redefine).
- Produces (Task 5 and Task 6 depend on these exact signatures):

```rust
// crates/freshell-terminal/src/registry.rs
#[async_trait::async_trait]
pub trait PaneIdentityBinder: Send + Sync {
    /// PIN 2 durability-before-argv: durable claude binding row written
    /// BEFORE the spawn makes the preallocated id observable. Callers gate
    /// this on their fresh-prealloc flag ONLY (eaa25b7d).
    async fn record_prespawn_claude_binding(
        &self,
        session_id: &str,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    );
    /// Compensating delete when the spawn that minted the id fails.
    /// MUST be gated on the SAME predicate as the record (eaa25b7d).
    async fn delete_prespawn_claude_binding(&self, session_id: &str);
    /// Post-spawn identity registration, mirroring the WS post-spawn block
    /// (freshell-ws/src/terminal.rs): identity row + durable binding for any
    /// non-shell create with a session id; pending marker for the
    /// locator-resolved providers (codex/opencode/amplifier) without one.
    async fn register_create_identity(
        &self,
        terminal_id: &str,
        mode: &str,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    );
}
```

and `freshell_ws::pane_identity_binder::LedgerPaneIdentityBinder::new(identity: TerminalIdentityRegistry, ledger: Arc<PaneLedger>) -> LedgerPaneIdentityBinder` implementing it.

- [ ] **Step 1: Write the failing unit tests for the impl**

Create `crates/freshell-ws/src/pane_identity_binder.rs` starting with tests (temp-dir ledger per the `pane_ledger_tests.rs:9-21` `temp_root` idiom — pid + atomic counter; NEVER a real `$HOME` path):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::pane_ledger::{PaneLedger, RowState};
    use std::sync::Arc;

    fn temp_root(label: &str) -> std::path::PathBuf {
        static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        let dir = std::env::temp_dir()
            .join(format!("pane-identity-binder-{label}-{}-{n}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp root");
        dir
    }

    fn binder(label: &str) -> (LedgerPaneIdentityBinder, Arc<PaneLedger>, crate::identity::TerminalIdentityRegistry, std::path::PathBuf) {
        let dir = temp_root(label);
        let ledger = Arc::new(PaneLedger::new(Some(dir.clone())));
        let identity = crate::identity::TerminalIdentityRegistry::default();
        (LedgerPaneIdentityBinder::new(identity.clone(), Arc::clone(&ledger)), ledger, identity, dir)
    }

    const SID: &str = "29a53649-1111-4222-8333-444455556666";

    #[tokio::test]
    async fn prespawn_binding_writes_a_bound_claude_row_and_delete_removes_it() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        let (b, ledger, _identity, dir) = binder("prespawn");
        b.record_prespawn_claude_binding(SID, "t-rest-1", "claude", Some("/tmp"), Some("req-1")).await;
        let row = ledger.load_binding("claude", SID).expect("pre-spawn row exists (PIN 2)");
        assert_eq!(row.live_terminal_id.as_deref(), Some("t-rest-1"));
        assert_eq!(row.state, RowState::Bound);

        b.delete_prespawn_claude_binding(SID).await;
        assert!(ledger.load_binding("claude", SID).is_none(), "failure-delete removes the row");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn register_create_identity_writes_identity_row_and_binding() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        let (b, ledger, identity, dir) = binder("register");
        b.register_create_identity("t-rest-2", "claude", Some(SID), Some("/tmp"), Some("req-2")).await;
        let row = identity.get("t-rest-2").expect("identity row (the A13/signal-drain prerequisite)");
        assert_eq!(row.provider.as_deref(), Some("claude"));
        assert_eq!(row.session_id.as_deref(), Some(SID));
        let binding = ledger.load_binding("claude", SID).expect("post-spawn binding row");
        assert_eq!(binding.live_terminal_id.as_deref(), Some("t-rest-2"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn register_create_identity_skips_shell_and_marks_pending_for_marker_modes() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        let (b, ledger, identity, dir) = binder("markers");
        // shell: nothing at all
        b.register_create_identity("t-shell", "shell", None, None, None).await;
        assert!(identity.get("t-shell").is_none());
        // codex without an id: pending marker (locator lane resolves later),
        // exactly the WS MARKER_MODES arm (terminal.rs:2523-2540).
        b.register_create_identity("t-codex", "codex", None, Some("/tmp"), Some("req-3")).await;
        assert!(identity.get("t-codex").is_none(), "no premature identity row");
        assert!(ledger.has_pending("t-codex"), "pending marker written"); // use the ledger's actual pending-read API — see pane_ledger.rs `pending/` store and how terminal.rs/pane_ledger_tests assert markers; adjust the accessor name to match.
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn ledger_write_failure_never_panics_the_create() {
        use freshell_terminal::registry::PaneIdentityBinder as _;
        // A disabled ledger (or an unwritable root) must degrade to a warn,
        // never an Err/panic — failure never blocks the create.
        let identity = crate::identity::TerminalIdentityRegistry::default();
        let b = LedgerPaneIdentityBinder::new(identity.clone(), Arc::new(PaneLedger::disabled()));
        b.record_prespawn_claude_binding(SID, "t-x", "claude", None, None).await;
        b.register_create_identity("t-x", "claude", Some(SID), None, None).await;
        // identity row still lands even when durability is degraded:
        assert!(identity.get("t-x").is_some());
    }
}
```

(For the pending-marker assertion: open `crates/freshell-ws/src/pane_ledger.rs` and use whatever read API the existing marker tests use — the store is `pending/<enc(terminalId)>.json`; if no read helper exists, assert the file's existence under `dir.join("pending")` by listing that directory.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cargo test -p freshell-ws pane_identity_binder`
Expected: FAIL to compile — trait and struct don't exist.

- [ ] **Step 3: Implement trait + impl**

1. `crates/freshell-terminal/Cargo.toml`: add `async-trait` (same form as `freshell-freshagent`'s dependency on it).
2. `crates/freshell-terminal/src/registry.rs`: add the trait exactly as specified in **Interfaces** above, directly below `SessionIdentityLookup` (`:638-641`), with a doc comment naming both consumers (REST spawn pipeline) and the producer (`freshell-ws`).
3. `crates/freshell-ws/src/pane_identity_binder.rs`:

```rust
//! Write-side pane-identity seam for the REST spawn pipeline (kata hbsa).
//!
//! `freshell-freshagent` cannot depend on `freshell-ws` (circular), so it
//! cannot write `TerminalIdentityRegistry` rows or `PaneLedger` bindings
//! directly — the exact gap that left REST claude panes un-resumable and
//! invisible to A13. This impl mirrors the WS create path's identity writes
//! (`terminal.rs` PIN2_CLAUDE_PRE_SPAWN_BINDING block, its failure-delete
//! twin, and the post-spawn identity/binding/pending block) behind the
//! `freshell_terminal::registry::PaneIdentityBinder` trait, wired into
//! `FreshAgentState` by `freshell-server::main` (the `SessionIdentityLookup`
//! precedent, read-side twin).
//!
//! Failure policy: ledger writes are best-effort — warn on the
//! `freshell_ws::invariants` target and proceed; a create is never blocked
//! by durability degradation. (The WS rung additionally broadcasts
//! `DurabilityDegraded` via `surface_write_failure`, which needs `&WsState`;
//! this seam has no `WsState`, and log-only is strictly better than the
//! nothing-at-all the REST lane wrote before.)

use std::sync::Arc;

use crate::identity::TerminalIdentityRegistry;
use crate::pane_ledger::{BindingWrite, PaneLedger};

pub struct LedgerPaneIdentityBinder {
    identity: TerminalIdentityRegistry,
    ledger: Arc<PaneLedger>,
}

impl LedgerPaneIdentityBinder {
    pub fn new(identity: TerminalIdentityRegistry, ledger: Arc<PaneLedger>) -> Self {
        Self { identity, ledger }
    }

    fn warn_write_failure(terminal_id: &str, what: &str, err: &std::io::Error) {
        tracing::warn!(
            target: "freshell_ws::invariants",
            terminal_id = %terminal_id,
            error = %err,
            "pane_ledger_write_failed: {what} (REST rung; create proceeds, durability degraded)"
        );
    }
}

#[async_trait::async_trait]
impl freshell_terminal::registry::PaneIdentityBinder for LedgerPaneIdentityBinder {
    async fn record_prespawn_claude_binding(
        &self,
        session_id: &str,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    ) {
        let ledger = Arc::clone(&self.ledger);
        let (sid, tid, m) = (session_id.to_string(), terminal_id.to_string(), mode.to_string());
        let (c, rid) = (cwd.map(str::to_string), create_request_id.map(str::to_string));
        let now = crate::now_ms(); // reuse the crate's existing helper; adjust path to where it lives
        let tid_for_log = tid.clone();
        let result = tokio::task::spawn_blocking(move || {
            ledger.record_binding(&BindingWrite {
                provider: "claude",
                session_id: &sid,
                terminal_id: &tid,
                mode: &m,
                cwd: c.as_deref(),
                create_request_id: rid.as_deref(),
                now_ms: now,
            })
        })
        .await
        .unwrap_or_else(|join_err| Err(std::io::Error::other(join_err)));
        if let Err(err) = result {
            Self::warn_write_failure(&tid_for_log, "pre-spawn claude binding (PIN 2)", &err);
        }
    }

    async fn delete_prespawn_claude_binding(&self, session_id: &str) {
        let ledger = Arc::clone(&self.ledger);
        let sid = session_id.to_string();
        let result = tokio::task::spawn_blocking(move || ledger.delete_binding("claude", &sid))
            .await
            .unwrap_or_else(|join_err| Err(std::io::Error::other(join_err)));
        if let Err(err) = result {
            Self::warn_write_failure("(spawn-failed)", "pre-spawn binding failure-delete", &err);
        }
    }

    async fn register_create_identity(
        &self,
        terminal_id: &str,
        mode: &str,
        resume_session_id: Option<&str>,
        cwd: Option<&str>,
        create_request_id: Option<&str>,
    ) {
        // Mirrors terminal.rs's post-spawn block: identity row + binding for
        // any non-shell create carrying a session id; pending marker for the
        // identity-in-flight providers. Port the bodies from
        // terminal.rs:2453-2540 (terminal_meta_record_for_create semantics,
        // identity.upsert, record_binding, MARKER_MODES/record_pending),
        // substituting self.identity / self.ledger and the warn above for
        // surface_write_failure. Export MARKER_MODES from terminal.rs
        // (`pub(crate) const` -> keep crate-visible and reference it here)
        // rather than duplicating the list.
        if mode == "shell" {
            return;
        }
        if let Some(session_id) = resume_session_id.filter(|s| !s.is_empty()) {
            self.identity.upsert(terminal_id, Some(mode), Some(session_id), cwd, crate::now_ms());
            let ledger = Arc::clone(&self.ledger);
            let (sid, tid, m) = (session_id.to_string(), terminal_id.to_string(), mode.to_string());
            let (c, rid) = (cwd.map(str::to_string), create_request_id.map(str::to_string));
            let now = crate::now_ms();
            let tid_for_log = tid.clone();
            let result = tokio::task::spawn_blocking(move || {
                ledger.record_binding(&BindingWrite {
                    provider: &m.clone(),
                    session_id: &sid,
                    terminal_id: &tid,
                    mode: &m,
                    cwd: c.as_deref(),
                    create_request_id: rid.as_deref(),
                    now_ms: now,
                })
            })
            .await
            .unwrap_or_else(|join_err| Err(std::io::Error::other(join_err)));
            if let Err(err) = result {
                Self::warn_write_failure(&tid_for_log, "post-spawn identity binding", &err);
            }
        } else if crate::terminal::MARKER_MODES.contains(&mode) {
            // PORT (not new design): the pending-marker arm — copy the exact
            // record_pending call from terminal.rs's MARKER_MODES block
            // (:2523-2540): same arguments, wrapped in spawn_blocking, with
            // the warn_write_failure policy above replacing
            // surface_write_failure. Make MARKER_MODES `pub(crate)` in
            // terminal.rs if it is private today.
        }
    }
}
```

The two `...port from terminal.rs...` spots are literal ports: open `crates/freshell-ws/src/terminal.rs:2453-2540`, copy the bodies, substitute `self.identity`/`self.ledger`, and adjust visibility of `MARKER_MODES` (make it `pub(crate)` if it isn't) and `now_ms` (reuse wherever it's defined in the crate). Do NOT re-derive the provider-vs-mode choice — keep exactly what the WS block does (`provider = mode` on the post-spawn write).

4. `crates/freshell-ws/src/lib.rs`: `pub mod pane_identity_binder;`

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-ws pane_identity_binder`
Expected: PASS (4 tests).

- [ ] **Step 5: Full-crate checks for the touched crates**

Run: `cargo test -p freshell-terminal --all-targets && cargo clippy -p freshell-terminal -p freshell-ws --all-targets -- -D warnings`
Expected: PASS, no warnings.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-terminal/Cargo.toml crates/freshell-terminal/src/registry.rs \
        crates/freshell-ws/src/pane_identity_binder.rs crates/freshell-ws/src/lib.rs \
        crates/freshell-ws/src/terminal.rs Cargo.lock
git commit -m "feat(ws,terminal): PaneIdentityBinder seam — write-side identity/ledger bridge for the REST lane"
```

---

### Task 5: Thread the binder through the REST spawn pipeline

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (state field + builder)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (`GatedSettleInputs`, three call sites in `settle_gated_create`, `mod tests`)
- Modify: `crates/freshell-freshagent/Cargo.toml` (add `async-trait` if not already a direct dep)
- Modify: `crates/freshell-server/src/main.rs` (wiring)

**Interfaces:**
- Consumes: `freshell_terminal::registry::PaneIdentityBinder` (Task 4), `GatedSettleInputs.claude_fresh_prealloc` (Task 2), `freshell_ws::pane_identity_binder::LedgerPaneIdentityBinder` (Task 4, wiring only — freshagent code references only the trait).
- Produces: `FreshAgentState::with_pane_identity_binder(self, binder: Arc<dyn freshell_terminal::registry::PaneIdentityBinder>) -> Self`; call ordering inside `settle_gated_create`: `record_prespawn_claude_binding` (fresh preallocs only) → spawn → on failure `delete_prespawn_claude_binding` (same gate) / on success `register_create_identity` (all creates). Task 6's e2e tests and the production wiring rely on this ordering.

- [ ] **Step 1: Write the failing unit tests with a recording fake binder**

In `crates/freshell-freshagent/src/terminal_tabs.rs` `mod tests`:

```rust
#[derive(Default)]
struct RecordingBinder {
    events: std::sync::Mutex<Vec<String>>,
}

impl RecordingBinder {
    fn events(&self) -> Vec<String> {
        self.events.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl freshell_terminal::registry::PaneIdentityBinder for RecordingBinder {
    async fn record_prespawn_claude_binding(
        &self, session_id: &str, terminal_id: &str, _mode: &str,
        _cwd: Option<&str>, _create_request_id: Option<&str>,
    ) {
        self.events.lock().unwrap().push(format!("prespawn:{terminal_id}:{session_id}"));
    }
    async fn delete_prespawn_claude_binding(&self, session_id: &str) {
        self.events.lock().unwrap().push(format!("delete:{session_id}"));
    }
    async fn register_create_identity(
        &self, terminal_id: &str, mode: &str, resume_session_id: Option<&str>,
        _cwd: Option<&str>, _create_request_id: Option<&str>,
    ) {
        self.events.lock().unwrap().push(format!(
            "register:{terminal_id}:{mode}:{}", resume_session_id.unwrap_or("-")
        ));
    }
}

#[tokio::test]
async fn fresh_claude_rest_create_drives_binder_prespawn_then_register() {
    // kata hbsa P1: PIN 2 ordering on the REST rung — durable pre-spawn
    // binding, then spawn, then identity registration.
    let binder = std::sync::Arc::new(RecordingBinder::default());
    let (state, registry, _capture) = state_with_claude_capture_spec();
    let state = state.with_pane_identity_binder(binder.clone());

    let (status, body) = post(app(state), "/api/tabs",
        serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}), true).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    let sid = body["data"]["paneContent"]["sessionRef"]["sessionId"].as_str().unwrap().to_string();
    let tid = body["data"]["paneContent"]["terminalId"].as_str().unwrap().to_string();

    let events = binder.events();
    let prespawn = events.iter().position(|e| e == &format!("prespawn:{tid}:{sid}"))
        .unwrap_or_else(|| panic!("prespawn event missing: {events:?}"));
    let register = events.iter().position(|e| e == &format!("register:{tid}:claude:{sid}"))
        .unwrap_or_else(|| panic!("register event missing: {events:?}"));
    assert!(prespawn < register, "PIN 2: durability before registration: {events:?}");
    assert!(!events.iter().any(|e| e.starts_with("delete:")), "no failure-delete on success");

    registry.kill(&tid);
}

#[tokio::test]
async fn resume_claude_rest_create_registers_identity_without_prespawn_write() {
    // eaa25b7d scoping on the REST rung: a RESUME create never writes the
    // pre-spawn row (it belongs to the prior epoch) but DOES register
    // identity post-spawn — this closes the resume-direction half of the
    // gap (REST resumes previously died at restart: pane_ledger_restore.rs).
    let binder = std::sync::Arc::new(RecordingBinder::default());
    let (state, registry, _capture) = state_with_claude_capture_spec();
    let state = state.with_pane_identity_binder(binder.clone());

    const S: &str = "29a53649-2222-4333-8444-555566667777";
    // Mirror the request shape of the existing passing with-identity create
    // test (create_tab_with_identity_or_shell_mode_does_not_warn_invariant).
    let (status, body) = post(app(state), "/api/tabs",
        serde_json::json!({
            "mode": "claude",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "sessionRef": {"provider": "claude", "sessionId": S},
        }), true).await;
    assert_eq!(status, axum::http::StatusCode::OK, "{body}");
    let tid = body["data"]["paneContent"]["terminalId"].as_str().unwrap().to_string();

    let events = binder.events();
    assert!(!events.iter().any(|e| e.starts_with("prespawn:")),
        "resume creates must not write the pre-spawn row (eaa25b7d): {events:?}");
    assert!(events.contains(&format!("register:{tid}:claude:{S}")), "{events:?}");

    registry.kill(&tid);
}

#[tokio::test]
async fn failed_fresh_claude_spawn_deletes_its_prespawn_binding() {
    // eaa25b7d symmetry: the failure-delete fires with the SAME gate as the
    // write, for the id THIS create minted.
    let binder = std::sync::Arc::new(RecordingBinder::default());
    // A spec whose command cannot spawn: point default_cmd at a
    // nonexistent path (no env_var), same spec shape as the capture spec.
    let (state, _registry) = state_with_broken_claude_spec(); // build alongside state_with_claude_capture_spec
    let state = state.with_pane_identity_binder(binder.clone());

    let (status, _body) = post(app(state), "/api/tabs",
        serde_json::json!({"mode":"claude","cwd": std::env::temp_dir().to_string_lossy()}), true).await;
    assert!(!status.is_success(), "spawn must fail");

    let events = binder.events();
    let prespawn_sid = events.iter().find_map(|e| e.strip_prefix("prespawn:")
        .and_then(|rest| rest.split(':').nth(1)).map(str::to_string))
        .unwrap_or_else(|| panic!("prespawn happened before the spawn attempt: {events:?}"));
    assert!(events.contains(&format!("delete:{prespawn_sid}")),
        "failure-delete for the minted id: {events:?}");
    assert!(!events.iter().any(|e| e.starts_with("register:")), "{events:?}");
}
```

- [ ] **Step 2: Run to verify they fail**

Run: `cargo test -p freshell-freshagent -- drives_binder registers_identity_without_prespawn deletes_its_prespawn`
Expected: FAIL to compile — `with_pane_identity_binder` doesn't exist.

- [ ] **Step 3: Implement state field + builder**

In `crates/freshell-freshagent/src/lib.rs`, next to the `session_identity` field (`lib.rs:142-148`) add:

```rust
    /// Write-side pane-identity seam (kata hbsa): lets the REST spawn
    /// pipeline write TerminalIdentityRegistry rows and PaneLedger bindings
    /// across the freshagent->ws crate boundary. Read-side twin:
    /// `session_identity`. `None` (tests without identity concerns) = the
    /// legacy no-write behavior.
    pub(crate) pane_identity: Option<Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>,
```

initialize `pane_identity: None` in `FreshAgentState::new`, and add the builder next to `with_session_identity` (`:455-461`):

```rust
    pub fn with_pane_identity_binder(
        mut self,
        binder: Arc<dyn freshell_terminal::registry::PaneIdentityBinder>,
    ) -> Self {
        self.pane_identity = Some(binder);
        self
    }
```

- [ ] **Step 4: Implement the three call sites in `settle_gated_create`**

1. Add `pane_identity: Option<Arc<dyn freshell_terminal::registry::PaneIdentityBinder>>` to `GatedSettleInputs` (`:1130`), populate from `state.pane_identity.clone()` at the `tokio::spawn` site (`:1096`), destructure at `:1168`.

2. **Pre-spawn** (between the exit hook construction ending ~`:1462` and the `spawn_blocking` at `:1481`):

```rust
        // PIN2_CLAUDE_PRE_SPAWN_BINDING (REST rung, kata hbsa): durability
        // before observability — the spawn below puts the preallocated id in
        // argv; a SIGKILL right after spawn must still find a durable ledger
        // row. Gated on `claude_fresh_prealloc` ONLY (eaa25b7d: this create
        // minted the id, so the row is provably exclusive; a resume-create's
        // row belongs to the prior epoch). Mirrors
        // freshell-ws/src/terminal.rs's PIN2 block.
        if claude_fresh_prealloc {
            if let (Some(binder), Some(session_id)) =
                (pane_identity.as_ref(), resume_session_id.as_deref())
            {
                binder
                    .record_prespawn_claude_binding(
                        session_id,
                        &terminal_id,
                        &mode,
                        cwd.as_deref(),
                        Some(&create_request_id),
                    )
                    .await;
            }
        }
```

(Use the locally destructured variable names — `terminal_id`/`cwd`/`create_request_id` exist under whatever names `GatedSettleInputs` destructures them to at `:1168`; keep the argument *meanings* fixed.)

3. **Spawn-failure arm** (inside the error branch of the `create_result` match after `:1481-1493`, before the error is returned):

```rust
            // PIN 2 compensating delete — SAME gate as the write (eaa25b7d).
            if claude_fresh_prealloc {
                if let (Some(binder), Some(session_id)) =
                    (pane_identity.as_ref(), resume_session_id.as_deref())
                {
                    binder.delete_prespawn_claude_binding(session_id).await;
                }
            }
```

4. **Post-spawn** (after `registry.set_meta(..)` at `:1589-1595`, next to `arm_locators_for_fresh_pane` at `:1602-1608`):

```rust
        // Identity registration (kata hbsa): identity row + durable binding
        // for any create with a session id (fresh mint OR resume — the
        // resume half is what made REST-resumed claude panes die at
        // restart), pending marker for the locator-resolved providers.
        // The identity row is the prerequisite for BOTH the A13 live-owner
        // guard's identity arm and the SessionStart signal drain acting
        // (claude_signal.rs retains signals for identity-less panes forever).
        if let Some(binder) = pane_identity.as_ref() {
            binder
                .register_create_identity(
                    &terminal_id,
                    &mode,
                    resume_session_id.as_deref(),
                    cwd.as_deref(),
                    Some(&create_request_id),
                )
                .await;
        }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p freshell-freshagent -- drives_binder registers_identity_without_prespawn deletes_its_prespawn`
Expected: PASS. Then `cargo test -p freshell-freshagent` — full crate PASS.

- [ ] **Step 6: Wire production in `freshell-server::main`**

In `crates/freshell-server/src/main.rs`, find where the freshagent state is built with `.with_session_identity(..)` (`main.rs:286`) and where the WS `TerminalIdentityRegistry` and `Arc<PaneLedger>` locals are constructed (they're the same values passed into `WsState`). Chain:

```rust
        .with_pane_identity_binder(std::sync::Arc::new(
            freshell_ws::pane_identity_binder::LedgerPaneIdentityBinder::new(
                identity.clone(),          // the SAME registry WsState.identity uses
                std::sync::Arc::clone(&pane_ledger), // the SAME ledger WsState.pane_ledger uses
            ),
        ))
```

(Match the actual local variable names in `main.rs`. Sharing the same instances is the whole point — REST-written rows must be visible to the WS guard/drain and vice versa.)

Run: `cargo build -p freshell-server`
Expected: compiles clean.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs \
        crates/freshell-freshagent/Cargo.toml crates/freshell-server/src/main.rs Cargo.lock
git commit -m "feat(freshagent): REST creates write identity rows and ledger bindings via PaneIdentityBinder (kata hbsa)"
```

---

### Task 6: End-to-end regression tests on a merged REST+WS server

**Files:**
- Create: `crates/freshell-ws/tests/rest_claude_identity.rs`
- Modify (only if red): `crates/freshell-ws/tests/pane_ledger_restore.rs:237-302`

**Interfaces:**
- Consumes: everything from Tasks 1–5; harness idioms from `crates/freshell-ws/tests/rest_ws_shared_gate.rs:31-96` (merged `freshell_ws::router` + `freshell_freshagent::router` on one listener, shared auth token / broadcast bus / `TerminalRegistry`) and `crates/freshell-ws/tests/common/mod.rs` (`connect_and_capture_inventory`, `next_frame_of_type`, `session_ref_of`, `sleeper_cli_spec`, `AUTH_TOKEN`).
- Produces: the Required-Outcome-4 regression suite (4a, 4b, 4c) + REST-resume durable-identity pin.

- [ ] **Step 1: Write the test file (all tests red until reviewed against actual harness details, then green)**

`crates/freshell-ws/tests/rest_claude_identity.rs`. Whole file `#[cfg(unix)]`-gated (established style). Skeleton — the spawn helper merges the two routers exactly like `rest_ws_shared_gate.rs` does, EXTENDED with: a temp-dir `PaneLedger` (shared `Arc` into `WsState` and the binder), the real `LedgerPaneIdentityBinder` chained onto the freshagent state via `.with_pane_identity_binder(..)` AND `.with_session_identity(..)` + `.with_terminal_registry(..)` as `rest_ws_shared_gate.rs`/`main.rs` do, and a returned `WsState` clone (copy the `spawn_server_with_specs_and_state` / `spawn_server_returning_state` pattern for how `WsState` is built and returned):

```rust
#![cfg(unix)]
//! kata hbsa regression suite: REST-created claude panes carry full session
//! identity (Required Outcomes P1/2/4). Isolation rules (AGENTS.md + the
//! live 3002 server): temp-dir signal root via ClaudeSignalWatcher::new,
//! temp-dir lock-free PaneLedger::new, synchronous drains only.

mod common;

use std::sync::Arc;
use std::time::Duration;
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

struct Harness {
    base_url: String,       // http://{addr}
    ws: common::TestWs,     // connected + hello'd
    registry: freshell_terminal::TerminalRegistry,
    ws_state: freshell_ws::WsState, // adjust path/visibility per spawn_server_with_specs_and_state
    ledger: Arc<freshell_ws::pane_ledger::PaneLedger>,
    ledger_dir: std::path::PathBuf,
    signal_root: std::path::PathBuf,
}

async fn spawn_merged_server() -> Harness {
    // 1. temp roots (pid + nanos, per pane_ledger_restore.rs:13-24)
    // 2. claude spec = common::sleeper_cli_spec("claude") (already has
    //    create_session_args, stays Running)
    // 3. Build WsState exactly as spawn_server_with_ledger does
    //    (common/mod.rs:424-500) so WsState.identity / WsState.pane_ledger
    //    are OUR instances.
    // 4. Freshagent state: FreshAgentState::new(shared token, shared
    //    broadcast tx)
    //      .with_terminal_registry(registry.clone())
    //      .with_session_identity(Arc::new(identity.clone()))
    //      .with_pane_identity_binder(Arc::new(
    //          freshell_ws::pane_identity_binder::LedgerPaneIdentityBinder::new(
    //              identity.clone(), Arc::clone(&ledger))))
    //    (mirror rest_ws_shared_gate.rs:31-96 for the merge + listener).
    // 5. Router: freshell_ws router .merge(freshell_freshagent::router(..)),
    //    TcpListener 127.0.0.1:0, axum::serve in tokio::spawn.
    // 6. connect_and_capture_inventory(&ws_url).
    //
    // PORT (not new design): the body of this fn is rest_ws_shared_gate.rs's
    // spawn helper (:31-96) with common::spawn_server_with_ledger's
    // WsState-with-real-ledger construction (common/mod.rs:424-500) folded
    // in, returning the extra handles named in `Harness`. Copy those two
    // sources; do not invent new wiring.
}

async fn rest_create_claude(h: &Harness) -> (String, String) {
    // PORT: rest_ws_shared_gate.rs's raw HTTP POST helper, verbatim —
    // POST /api/tabs {"mode":"claude","cwd":<temp dir>} with x-auth-token.
    // Returns (terminal_id, session_id) read from the response's
    // paneContent.sessionRef, panicking with the full body on any miss.
}

/// 4a — a REST-created claude pane has a USABLE RESUME IDENTITY that does
/// not depend on any signal file existing: preallocated id in the registry
/// row, identity row, durable Bound ledger binding, sessionRef in the
/// create response — with the signal directory EMPTY throughout.
#[tokio::test(flavor = "multi_thread")]
async fn rest_created_claude_pane_has_durable_resume_identity_without_signals() {
    let h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;
    uuid::Uuid::parse_str(&sid).expect("canonical UUID");

    // "even if every signal file is destroyed by an external actor":
    // there are zero signal files — identity must already be complete.
    assert_eq!(std::fs::read_dir(&h.signal_root).unwrap().count(), 0);

    // identity row (A13 arm 1 + signal-drain prerequisite)
    let row = h.ws_state.identity.get(&tid).expect("identity row exists at create");
    assert_eq!(row.provider.as_deref(), Some("claude"));
    assert_eq!(row.session_id.as_deref(), Some(sid.as_str()));

    // registry row (GET /api/terminals rung 0)
    let reg = h.registry.identity_probe_rows().into_iter()
        .find(|r| r.terminal_id == tid).expect("registry row");
    assert_eq!(reg.resume_session_id.as_deref(), Some(sid.as_str()));

    // durable ledger binding, and it survives a "restart" (fresh PaneLedger
    // over the same dir re-reads disk — the pane_ledger_restore.rs idiom).
    let binding = h.ledger.load_binding("claude", &sid).expect("Bound row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid.as_str()));
    let reread = freshell_ws::pane_ledger::PaneLedger::new(Some(h.ledger_dir.clone()));
    assert!(reread.load_binding("claude", &sid).is_some(), "binding durable across restart");

    h.registry.kill(&tid);
}

/// 4b — A13: a WS resume (terminal.create restore:true + wire sessionRef)
/// of a session that is LIVE inside a REST-created pane is REFUSED loudly.
/// This is the exact drill violation: two live claude CLIs on one session id.
#[tokio::test(flavor = "multi_thread")]
async fn ws_resume_of_session_live_in_rest_pane_is_refused_a13() {
    let mut h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;

    h.ws.send(WsMessage::Text(json!({
        "type": "terminal.create",
        "requestId": "req-a13-rest-live-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true,
        "sessionRef": { "provider": "claude", "sessionId": sid },
    }).to_string())).await.unwrap();

    // expect_refusal_for: port verbatim from live_session_ref_guard.rs —
    // panics on terminal.created for this requestId, returns the error frame.
    let err = expect_refusal_for(&mut h.ws, "req-a13-rest-live-1").await;
    assert_eq!(err["code"], json!("RESTORE_UNAVAILABLE"), "exact wire code: {err}");
    assert!(err["message"].as_str().unwrap().contains(&sid),
        "message names the live session: {err}");

    // no duplicate spawn: the REST pane is still the only claude terminal
    let rows = h.registry.identity_probe_rows();
    assert_eq!(rows.len(), 1, "no second claude CLI on session {sid}: {rows:?}");
    assert_eq!(rows[0].terminal_id, tid);

    h.registry.kill(&tid);
}

/// 4c — the SessionStart signal for a REST pane is CONSUMED (Acted), not
/// retained forever: the confirmation no-op arm requires the identity row
/// that REST creates now write.
#[tokio::test(flavor = "multi_thread")]
async fn rest_pane_session_start_signal_is_consumed_not_retained() {
    let h = spawn_merged_server().await;
    let (tid, sid) = rest_create_claude(&h).await;

    let watcher = freshell_ws::claude_signal::ClaudeSignalWatcher::new(h.signal_root.clone());
    std::fs::write(
        h.signal_root.join(format!("{tid}__1.json")),
        format!(r#"{{"session_id":"{sid}","source":"startup","hook_event_name":"SessionStart"}}"#),
    ).expect("write signal file");

    freshell_ws::claude_signal::drain_and_rebind_claude(&h.ws_state, &watcher).await;
    tokio::task::yield_now().await;

    // Acted (same-id confirmation no-op) => file deleted. Before this fix
    // the pane had no identity row => Retain forever (the drill's retained
    // signal in ~/.freshell/session-signals/claude/).
    assert_eq!(std::fs::read_dir(&h.signal_root).unwrap().count(), 0,
        "signal consumed, not retained");
    // identity unchanged by the confirmation
    assert_eq!(h.ws_state.identity.get(&tid).unwrap().session_id.as_deref(), Some(sid.as_str()));

    h.registry.kill(&tid);
}

/// Resume direction (Required Outcome 2): a REST claude create WITH a
/// sessionRef now writes the identity row and a durable ledger binding
/// (previously: live registry row only — died at restart).
#[tokio::test(flavor = "multi_thread")]
async fn rest_claude_resume_create_writes_identity_row_and_ledger_binding() {
    let h = spawn_merged_server().await;
    // Fresh REST pane mints S, then kill it so S is no longer live-owned.
    let (tid1, sid) = rest_create_claude(&h).await;
    h.registry.kill(&tid1);
    // wait until the row leaves Running so the D7 guard admits the resume
    // (poll identity_probe_rows status with a bounded deadline).

    // REST resume of S: POST /api/tabs {"mode":"claude","sessionRef":{...}}.
    // rest_create_claude_with_session_ref = rest_create_claude with a
    // {"sessionRef":{"provider":"claude","sessionId": sid}} field added to
    // the body — same raw-POST helper, same return shape.
    let (tid2, sid2) = rest_create_claude_with_session_ref(&h, &sid).await;
    assert_eq!(sid2, sid);
    let row = h.ws_state.identity.get(&tid2).expect("resume writes the identity row");
    assert_eq!(row.session_id.as_deref(), Some(sid.as_str()));
    let binding = h.ledger.load_binding("claude", &sid).expect("resume writes the binding row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid2.as_str()));

    h.registry.kill(&tid2);
}
```

Fill the two `todo!()` helpers by porting the cited code (`rest_ws_shared_gate.rs:31-96` for the merged server + raw HTTP POST; `common/mod.rs:424-500` for the ledger-carrying `WsState`; `spawn_server_returning_state` in `claude_session_rebind.rs:126-199` for returning `WsState`). If `WsState.identity` / field visibilities block direct reads from an integration test, use the public probes instead: `registry.identity_probe_rows()` for the registry row and `state.identity.session_ref_for(&tid)` if exposed, or add a `#[doc(hidden)] pub` accessor — prefer the least-visibility change that unblocks the assertion. If the resume test's D7/existence rungs refuse the resume for a reason unrelated to this fix (e.g. a claude-transcript existence probe), keep the fresh-direction assertions and move the resume-direction assertion down to the Task 5 recording-binder unit test as the pin — but only after reading the refusal message and confirming it is an existence-probe refusal, not an identity regression.

- [ ] **Step 2: Run the suite**

Run: `cargo test -p freshell-ws --test rest_claude_identity`
Expected: all PASS. (These are green-on-arrival pins for Tasks 2+5's behavior — the value is that they fail loudly if anyone reintroduces the split. Verify each is a REAL pin by spot-reverting: `git stash` nothing — instead temporarily flip the `launch_intent` conditional in `terminal_tabs.rs` back to bare `LaunchIntent::Resume`, rerun, confirm 4a/4b/4c go red, restore.)

- [ ] **Step 3: Reconcile `pane_ledger_restore.rs:237-302`**

Run: `cargo test -p freshell-ws --test pane_ledger_restore`
That test pins the OLD reality ("a claude resumed via the freshagent REST … its ONLY footprint is a live registry row" — dies at restart). If it constructs the footprint by hand (direct registry writes), it still passes — update only its comment to note the REST lane now also writes ledger rows (the hand-built shape now models ledger-write *failure*, still a valid degraded case). If it drives the REST router and goes red because a binding row now exists, flip its expectations to pin the NEW reality: the REST-resumed pane's binding row exists and survives the simulated restart.
Expected after reconciliation: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/tests/rest_claude_identity.rs crates/freshell-ws/tests/pane_ledger_restore.rs
git commit -m "test(ws): e2e pins — REST claude identity durability, A13 refusal of REST-live sessions, signal consumption (kata hbsa)"
```

---

### Task 7: Pin the codex/opencode REST identity lanes (Required Outcome 3)

**Files:**
- Create: `crates/freshell-ws/tests/rest_locator_identity.rs`

**Interfaces:**
- Consumes: the Task 6 merged-server harness (copy the spawn helper — tests/ files don't share code except `common`; extract shared pieces into `tests/common/mod.rs` ONLY if they're identical, following how other helpers landed there); codex locator harness idioms from `common::spawn_server_with_specs_activity_and_codex_locator(.., codex_sessions_root)` (`common/mod.rs:578`) and `crates/freshell-ws/tests/codex_fork_rebind.rs` (fake rollout files); opencode signal idioms from `crates/freshell-ws/src/opencode_signal.rs` (first-bind arm `:290-297`, fanout `:394-420`) and `opencode_switch_rebind.rs`.
- Produces: end-to-end pins that a REST-created codex/opencode pane ends with BOTH the identity row and a durable Bound ledger row. (The exploration found the arm and the sweep pinned separately on opposite sides of the crate boundary, but no end-to-end pin — that blind spot is exactly how the claude gap survived.)

- [ ] **Step 1: Write the opencode pin (signal lane — fully drivable in-process)**

```rust
/// REQ 3 pin: a fresh REST opencode pane, first-bound by its plugin signal,
/// ends with identity row + durable ledger binding (not just sessionRef
/// surface). Drives opencode's first-bind arbitration arm
/// (opencode_signal.rs:290-297) exactly as the plugin would.
#[tokio::test(flavor = "multi_thread")]
async fn rest_created_opencode_pane_binds_identity_row_and_ledger() {
    let h = spawn_merged_server_with_opencode_spec().await; // sleeper spec named "opencode"
    let (tid, _) = rest_create(&h, "opencode").await; // fresh: no sessionRef in response yet

    // The Task 5 binder wrote the pending marker at create (MARKER_MODES arm):
    assert!(pending_marker_exists(&h, &tid), "pending marker for locator-resolved provider");

    // Forge the plugin signal and drive the opencode drain synchronously
    // (mirror opencode_switch_rebind.rs for the watcher construction,
    // signal-file format, and the pub drain entry point — opencode's
    // equivalents of ClaudeSignalWatcher::new / drain_and_rebind_claude).
    const S: &str = "ses_rest_opencode_pin_0001"; // use a VALID opencode id shape per opencode_switch_rebind.rs
    write_opencode_signal(&h, &tid, S);
    drive_opencode_drain(&h).await;

    let row = h.ws_state.identity.get(&tid).expect("identity row");
    assert_eq!(row.provider.as_deref(), Some("opencode"));
    assert_eq!(row.session_id.as_deref(), Some(S));
    let binding = h.ledger.load_binding("opencode", S).expect("Bound ledger row");
    assert_eq!(binding.live_terminal_id.as_deref(), Some(tid.as_str()));
    assert!(!pending_marker_exists(&h, &tid), "resolve_pending consumed the marker");

    h.registry.kill(&tid);
}
```

- [ ] **Step 2: Write the codex pin (locator lane)**

```rust
/// REQ 3 pin: a fresh REST codex pane resolved by the codex locator sweep
/// ends with identity row + durable ledger binding. Codex identity is
/// Enter-anchored (codex_association.rs:6-11) — the test feeds the submit
/// via the REST send-keys surface, then forges the rollout file the sweep
/// correlates, mirroring codex_fork_rebind.rs / the
/// spawn_server_with_specs_activity_and_codex_locator harness (150ms sweep,
/// fake codex_sessions_root).
#[tokio::test(flavor = "multi_thread")]
async fn rest_created_codex_pane_binds_identity_row_and_ledger() {
    // Same merged harness + codex locator wired the way
    // spawn_server_with_specs_activity_and_codex_locator wires it, sharing
    // the locator Arc into BOTH WsState and FreshAgentState (main.rs:390-411
    // is the production shape).
    ...
    // 1. REST create {mode:"codex"} -> pending marker exists.
    // 2. POST the send-keys route with an Enter (terminal_tabs.rs:1985
    //    note_submit ordering) — find the exact REST route in
    //    terminal_tabs::maybe_send_keys's callers.
    // 3. Forge the rollout file under codex_sessions_root with thread id T
    //    (copy the fixture format from codex_fork_rebind.rs).
    // 4. Await the sweep (bounded poll, <=5s) until identity.get(tid) is Some.
    // 5. Assert identity row {provider:"codex", session_id:T} and
    //    ledger.load_binding("codex", T) Bound with live_terminal_id == tid,
    //    and the pending marker consumed.
}
```

If wiring the codex locator into the merged REST+WS harness proves disproportionate (the locator sweep task, activity hub, and sessions root are heavy), the fallback pin — still end-to-end across the boundary that matters — is: REST create codex pane → pending marker exists → call the resolution tail directly (`freshell_ws::codex_identity`'s apply path is crate-private, so instead call `crate::pane_ledger::ledger_resolve_identity`-equivalent via the public drain used by `pane_ledger_triggers.rs`) → identity row + Bound row + marker consumed. Choose the full-locator version if `codex_fork_rebind.rs` shows it's <100 lines of harness; otherwise take the fallback and say so in the test comment. Either way the REST-side create → marker → resolved-binding chain is pinned in one test.

- [ ] **Step 3: Run**

Run: `cargo test -p freshell-ws --test rest_locator_identity`
Expected: PASS. If the opencode first-bind arm refuses because the Task 5 binder's pending marker changed the arm's admission logic (it admits "no identity row + live never-bound pane" — a pending *ledger* marker doesn't touch identity rows, so it shouldn't), investigate before changing any drain logic: the drains are pinned by #573/#578 tests and must not regress.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/tests/rest_locator_identity.rs
git commit -m "test(ws): pin REST codex/opencode create -> identity row + ledger binding end to end"
```

---

### Task 8: Full verification gates and branch push

**Files:** none (verification + push only; fix anything that surfaces, in the task where it belongs)

**Interfaces:**
- Consumes: everything above.
- Produces: a pushed `fix/rest-terminal-session-identity` branch, all gates green. NO PR.

- [ ] **Step 1: Rust gates (CI-exact)**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
cargo test --workspace
```
Expected: all green. `cargo test --workspace` is the broad run; if unrelated pre-existing failures appear, confirm they fail identically on the base commit (`git stash && git checkout 4c04dc9c -- . && ...` is NOT needed — just run the same test in a clean second worktree of `4c04dc9c` or check CI history) and leave them; fix only what this branch broke.

- [ ] **Step 2: Contract freeze (no WS drift — this fix is REST-side + spawn-side)**

```bash
npm ci
npm run test:port
npm run contract:generate && git diff --exit-code -- port/contract
cargo test -p freshell-protocol --locked
```
Expected: `git diff --exit-code` clean — zero contract changes.

- [ ] **Step 3: Coordinated JS suite**

```bash
FRESHELL_TEST_SUMMARY="rest terminal session identity regression (kata hbsa)" npm run check
```
Expected: green. (Waits for the shared coordinator gate if another agent holds it — wait, never kill a foreign holder.)

- [ ] **Step 4: Push the branch (no PR)**

```bash
git status --short   # must show ONLY the untracked docs/superpowers/plans/... file
git log --oneline origin/main..HEAD
git push -u origin fix/rest-terminal-session-identity
```
Expected: branch pushed. STOP — do not open a PR, do not close kata hbsa (the controller does both).

---

## Requirements → Task Coverage Map

| Spec requirement | Covered by |
|---|---|
| P1 mint preallocated UUID + `--session-id` argv | Tasks 1–2 (argv asserted in Task 2 Step 1) |
| P1 pre-spawn ledger binding (PIN 2, eaa25b7d scoping) | Tasks 4–5 (write + failure-delete, same gate; ordering pinned in Task 5 Step 1) |
| P1 identity row registration | Tasks 4–5 (unit) + Task 6 4a (e2e) |
| P1 sessionRef exposed (REST response, `GET /api/terminals` rung 0, `paneContent`) | Task 2 (response + registry row = rung 0 input; `terminals.rs` needs no change) |
| P1 SessionStart signal consumed as confirmation | Task 6 4c |
| 2 split + respawn entry points | Task 3 (shared `spawn_terminal_pane`, pinned) |
| 2 other entry points audit | Exploration verdict encoded in File Structure: all four REST entry points funnel through `spawn_terminal_pane` (`terminal_tabs.rs:704`); the deferred-restore variant (`:203`) has zero Rust callers today and inherits the fix through `create_terminal_tab` when wired |
| 2 REST resume direction identity-row/ledger gap | Task 5 (register on resume) + Task 6 resume test + Task 6 Step 3 (`pane_ledger_restore.rs` reconciliation) |
| 3 codex/opencode verification + pinning tests | Task 7 (identity row + ledger + pending marker, end to end) |
| 4a resume identity survives signal destruction | Task 6 `rest_created_claude_pane_has_durable_resume_identity_without_signals` |
| 4b A13 refusal of WS resume of REST-live session | Task 6 `ws_resume_of_session_live_in_rest_pane_is_refused_a13` |
| 4c signal Acted, not retained | Task 6 `rest_pane_session_start_signal_is_consumed_not_retained` |
| 5 Node parity | "Node Parity Decision" section: conventions require Rust-only; WS contract verified frozen in Task 8 Step 2; `router.ts`-lineage comment removed in Task 2 Step 4 |
| Constraints: fmt/clippy/tests/contract/JS/push-no-PR | Task 8 |
| Constraint: never touch port 3002 / real `$HOME` | Global Constraints + every test uses constructor-injected temp dirs |
