# Clippy Debt Zero-Out Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make `cargo clippy --workspace --all-targets -- -D warnings` exit 0 for the entire freshell Rust workspace, with zero behavior changes, and add a CI guard so the debt cannot silently regrow.

**Architecture:** This is a behavior-preserving chore, not a feature. The "red" is the failing clippy invocation (34 errors, inventory below, captured at base commit `4835de63`). Fixes land in small commits grouped by crate/lint-family: (1) migrate two test-only `static std::sync::Mutex<()>` env-serialization locks in `freshell-freshagent` to `tokio::sync::Mutex` — the exact convention the repo already uses in `crates/freshell-ws/tests/freshagent_claude_kill_interrupt.rs:50` — which fixes all 27 `await_holding_lock` errors AND deletes 7 pre-existing `#[allow(clippy::await_holding_lock)]` suppressions; (2) delete provably-dead code in `freshell-server` (dead since its only consumer was deliberately removed in commit `24ecdb8e` as a parity fix); (3) mechanical one-line lint fixes; (4) a new `.github/workflows/rust-clippy.yml` (there is currently NO cargo invocation anywhere in `.github/` — nothing to append to, so a new workflow is the trivial, non-disruptive option).

**Tech Stack:** Rust 1.96 stable (workspace `rust-version = "1.96"`), tokio 1.52.3 (`tokio::sync::Mutex::const_new` is `const fn` — works in a `static`), cargo clippy/fmt, GitHub Actions (`dtolnay/rust-toolchain@stable`, `Swatinem/rust-cache@v2`), gh CLI.

## Global Constraints

- **Base:** branch `clippy-debt` in worktree `/home/dan/code/freshell/.worktrees/clippy-debt`, branched from origin/main @ `4835de63`. All commands in this plan run from that worktree root unless stated otherwise.
- **Behavior-preserving:** zero production logic edits beyond deletions of provably-dead code; every test that passed before must pass after. Do not blanket-`#[allow]` lints away. A targeted `#[allow]` with a one-line justification is the exception, not the pattern (this plan needs **zero** new allows and **deletes 7** existing ones).
- **Final gates (all must pass):** `cargo clippy --workspace --all-targets -- -D warnings` exit 0; `cargo clippy -p freshell-codex --all-targets --features real-transport -- -D warnings` exit 0; `cargo test --workspace` green; `cargo fmt --all --check` clean; coordinated JS suite green (`FRESHELL_TEST_SUMMARY="clippy debt chore" npm test`).
- **`--all-targets` is mandatory** in every clippy invocation — without it, `#[cfg(test)]` code is not linted and 28 of the 34 findings vanish.
- **AGENTS.md hazards (mandatory):** NEVER restart the user's self-hosted freshell server; NEVER use broad kill patterns; broad JS test runs wait for the shared coordinator gate (`npm run test:status` to inspect; WAIT if held, never kill a foreign holder). Do NOT run `cargo build --release -p freshell-server` — the release binary is what `run-rust-server.sh` serves; debug-profile `cargo clippy`/`cargo test` are safe.
- **Disk:** the worktree's cargo target dir will use several GB — fine; do not delete anything outside this worktree.
- **PR policy:** PR creation for this chore branch IS pre-approved. When all gates are green: push, open PR titled `chore: zero out workspace clippy debt`, `gh pr checks --watch`, self-merge per repo norm, report PR number + merge commit. If PR checks fail, report rather than force.
- **Docs:** README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working/agent doc. No new markdown docs.

---

## Red Baseline (captured at `4835de63`)

`cargo clippy --workspace --all-targets -- -D warnings` → **exit 101**, 34 lint errors:

| # | Lint | Location |
|---|------|----------|
| 1–21 | `clippy::await_holding_lock` | `crates/freshell-freshagent/src/codex.rs` lines 3754, 3796, 3835, 3864, 3997, 4111, 4149, 4184, 4222, 4267, 4324, 4383, 4446, 4514, 4578, 4627, 4765, 4814, 4898, 5488, 5516 (col 13, all byte-identical `let _guard = ENV_LOCK.lock().unwrap_or_else(\|e\| e.into_inner());`) |
| 22–26 | `clippy::await_holding_lock` | `crates/freshell-freshagent/src/claude.rs` lines 1142, 1173, 1203, 1240, 1333 (byte-identical, `CLAUDE_ENV_LOCK`) |
| 27 | `clippy::await_holding_lock` | `crates/freshell-freshagent/src/snapshot.rs:286` (same `ENV_LOCK` via `crate::codex::tests::ENV_LOCK`, 3-line chained form) |
| 28 | `clippy::let_and_return` | `crates/freshell-freshagent/src/opencode_ws.rs:1192` |
| 29 | `dead_code` (constant `DEFAULT_CLI_DETECTION_SPECS`) | `crates/freshell-server/src/extensions.rs:43` |
| 30 | `dead_code` (method `has_cli`) | `crates/freshell-server/src/extensions.rs:196` |
| 31 | `dead_code` (methods `get`, `get_all`) | `crates/freshell-server/src/session_metadata.rs:115` |
| 32 | `clippy::filter_next` (`.filter(..).next_back()` → `.rfind(..)`) | `crates/freshell-server/src/terminals.rs:731` |
| 33 | `clippy::bool_assert_comparison` | `crates/freshell-server/src/settings.rs:90` |
| 34–36 | `clippy::cloned_ref_to_slice_refs` (×3) | `crates/freshell-server/src/extensions.rs` 548:43, 576:42, 592:45 |

(Errors 29–31 come from the plain `bin "freshell-server"` unit; 32 is production code; everything else is `#[cfg(test)]` code that only lints under `--all-targets`.)

Already verified clean at base (must stay clean): `cargo clippy -p freshell-codex --all-targets --features real-transport -- -D warnings` → exit 0 (fixed in #532), and `cargo clippy -p freshell-opencode --all-targets --features real-transport -- -D warnings` → exit 0.

Related pre-existing suppressions that this plan **deletes**: `#[allow(clippy::await_holding_lock)]` in `codex.rs` at lines 3100, 5080, 5147, 5227, 5289, 5339, 5423 — all guarding the identical `ENV_LOCK` pattern.

---

### Task 1: Verify the red baseline

**Files:**
- None modified (verification only).

**Interfaces:**
- Consumes: worktree at `4835de63`, branch `clippy-debt`.
- Produces: confirmed red baseline matching the inventory above; later tasks measure progress against it.

- [ ] **Step 1: Confirm worktree and branch**

Run: `cd /home/dan/code/freshell/.worktrees/clippy-debt && git branch --show-current && git log --oneline -1 origin/main`
Expected: branch `chore/clippy-debt`; origin/main tip is `4835de63` (if origin/main moved, note it but do NOT rebase mid-plan — the inventory was verified at `4835de63`).

- [ ] **Step 2: Run the failing gate and capture output**

Run: `cargo clippy --workspace --all-targets -- -D warnings 2>&1 | tail -20; echo "exit: ${PIPESTATUS[0]}"`
Expected: exit 101 (FAIL). Error mix per the Red Baseline table: `could not compile freshell-freshagent (lib test) due to 28 previous errors`, `could not compile freshell-server ...` messages. If the counts differ materially from the table (e.g. new lints appeared from a toolchain bump), record the delta and fix those sites too using the same rules of engagement — the gate is exit 0, not "fix exactly 34".

- [ ] **Step 3: Verify the feature-gated crates are clean at base**

Run: `cargo clippy -p freshell-codex --all-targets --features real-transport -- -D warnings; echo "exit: $?"`
Run: `cargo clippy -p freshell-opencode --all-targets --features real-transport -- -D warnings; echo "exit: $?"`
Expected: both exit 0.

No commit for this task.

---

### Task 2: Migrate `codex::tests::ENV_LOCK` to `tokio::sync::Mutex` (fixes 22 errors, deletes 7 allows)

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` (definition near line 4976; 28 async call sites; 7 `#[allow]` deletions)
- Modify: `crates/freshell-freshagent/src/snapshot.rs:286-291` (cross-module use)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:1992-1994` (sync `#[test]` use — NOT clippy-flagged but breaks compilation if left)
- Test: existing inline `#[cfg(test)]` modules in the same files (no new tests — this is a test-harness refactor pinned by the existing suite)

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `pub(crate) static ENV_LOCK: tokio::sync::Mutex<()>` in `codex::tests` (same name/path — `snapshot.rs` and `terminal_tabs.rs` reach it as `crate::codex::tests::ENV_LOCK`). Task 3 mirrors this transform for `CLAUDE_ENV_LOCK`; it does not depend on this task's code.

**Why this fix and not `#[allow]`:** the lock payload is `()` — it is a pure mutual-exclusion token serializing tests that mutate process-global env vars (`CODEX_CMD`, `FAKE_CODEX_APP_SERVER_BEHAVIOR`). The guard must span the whole test body by design (dropping it early would reintroduce the `set_var` race the lock exists to prevent), so "restructure to drop the guard before awaiting" is not applicable. Holding a **tokio** mutex across await is exactly what it's designed for, and the repo already established this convention in `crates/freshell-ws/tests/freshagent_claude_kill_interrupt.rs:50`. One flagged site (`codex.rs:4324`) runs on a `multi_thread` runtime where a held `std` guard genuinely parks an OS worker thread — this fix removes a real hazard, not just a lint. `tokio::sync::Mutex` does not poison, which is exactly what the existing `unwrap_or_else(|e| e.into_inner())` was hand-rolling; behavior (exclusion scope, recovery-after-panicking-test) is preserved.

- [ ] **Step 1: Change the static's type**

In `crates/freshell-freshagent/src/codex.rs` (inside `#[cfg(test)] pub(crate) mod tests`, near line 4976), change:

```rust
    pub(crate) static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
```

to:

```rust
    pub(crate) static ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
```

Keep the doc comment above it unchanged. (`const_new` is a `pub const fn` in the workspace's tokio 1.52.3; the `sync` feature is already enabled in `crates/freshell-freshagent/Cargo.toml` deps and dev-deps.)

- [ ] **Step 2: Rewrite all 28 async acquisitions in codex.rs**

All 28 lines (the 21 flagged sites: 3754, 3796, 3835, 3864, 3997, 4111, 4149, 4184, 4222, 4267, 4324, 4383, 4446, 4514, 4578, 4627, 4765, 4814, 4898, 5488, 5516 — plus the 7 previously-`#[allow]`ed sites at the tests following lines 3100, 5080, 5147, 5227, 5289, 5339, 5423) are byte-identical. Replace every occurrence in `codex.rs` of:

```rust
        let _guard = ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
```

with:

```rust
        let _guard = ENV_LOCK.lock().await;
```

Verify the count first: `grep -c 'ENV_LOCK.lock().unwrap_or_else' crates/freshell-freshagent/src/codex.rs` must print `28`. After the replace, `grep -c 'ENV_LOCK.lock().await' crates/freshell-freshagent/src/codex.rs` must print `28` and the `unwrap_or_else` grep must print `0`.

- [ ] **Step 3: Delete the 7 now-dead `#[allow(clippy::await_holding_lock)]` attribute lines**

In `codex.rs` at (pre-edit) lines 3100, 5080, 5147, 5227, 5289, 5339, 5423: delete ONLY the attribute line `    #[allow(clippy::await_holding_lock)]`. KEEP the neighbouring `// Intentional: `_guard` is held across every `.await` ... BY DESIGN ...` comments — the rationale (whole-body serialization) is still true and valuable; only the suppression is now unnecessary. Verify: `grep -c 'allow(clippy::await_holding_lock)' crates/freshell-freshagent/src/codex.rs` prints `0`.

- [ ] **Step 4: Fix the cross-module site in snapshot.rs**

In `crates/freshell-freshagent/src/snapshot.rs` (test `unknown_codex_thread_is_404_with_lost_session_code`, lines 289-291), change:

```rust
        let _guard = crate::codex::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());
```

to:

```rust
        let _guard = crate::codex::tests::ENV_LOCK.lock().await;
```

- [ ] **Step 5: Fix the synchronous `#[test]` site in terminal_tabs.rs**

In `crates/freshell-freshagent/src/terminal_tabs.rs` (test `requested_powershell_shell_spawns_the_configured_powershell_program_on_wsl`, lines 1992-1994) — a sync fn cannot `.await`, so use `blocking_lock()`. Change:

```rust
        let _env_guard = crate::codex::tests::ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
```

to:

```rust
        let _env_guard = crate::codex::tests::ENV_LOCK.blocking_lock();
```

This is safe: `blocking_lock()` panics only when called from *within* a runtime context; here it is acquired on a plain test thread BEFORE `runtime.block_on(...)` is entered (holding it across `block_on` is fine). Note this test is WSL-gated (`is_wsl_env_live()` early-return), so execution won't prove it on most machines — **compilation is the gate**.

- [ ] **Step 6: Clippy the crate — expect exactly the Task 3/4 errors to remain**

Run: `cargo clippy -p freshell-freshagent --all-targets -- -D warnings 2>&1 | grep -E '^error' | sort | uniq -c`
Expected: exactly 6 lint errors remain — 5 × `await_holding_lock` (claude.rs, Task 3) + 1 × let-binding-return (opencode_ws.rs, Task 4). Zero errors mentioning codex.rs, snapshot.rs, or terminal_tabs.rs.

- [ ] **Step 7: Run the crate's lib tests (needs `node` on PATH — several tests spawn a fake Node app-server)**

Run: `cargo test -p freshell-freshagent --lib`
Expected: PASS, zero failures, same test count as a pre-change run (do NOT add `--test-threads=1` to "fix" anything — the lock is the serialization contract; default parallelism is part of what's being proven).

- [ ] **Step 8: Commit**

```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/snapshot.rs crates/freshell-freshagent/src/terminal_tabs.rs
git commit -m "style(freshagent): migrate codex tests' ENV_LOCK to tokio::sync::Mutex

Fixes 22 clippy::await_holding_lock errors and deletes the 7 existing
#[allow(clippy::await_holding_lock)] suppressions guarding the same
pattern. Matches the convention already used by
freshell-ws/tests/freshagent_claude_kill_interrupt.rs. Behavior
preserved: same whole-test-body env serialization; tokio's
non-poisoning lock is exactly what unwrap_or_else(into_inner) was
hand-rolling. Sync tests use blocking_lock()."
```

---

### Task 3: Migrate `claude::tests::CLAUDE_ENV_LOCK` to `tokio::sync::Mutex` (fixes 5 errors)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` (definition near line 997; 5 async sites at 1142, 1173, 1203, 1240, 1333; 1 sync site near line 976)
- Test: existing `#[cfg(test)] mod tests` in `claude.rs`

**Interfaces:**
- Consumes: nothing from Task 2 (same transform, independent static — `CLAUDE_ENV_LOCK` is private to `claude::tests`).
- Produces: nothing later tasks rely on.

- [ ] **Step 1: Change the static's type**

In `crates/freshell-freshagent/src/claude.rs` near line 997, change:

```rust
    static CLAUDE_ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
```

to:

```rust
    static CLAUDE_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
```

Keep the doc comment unchanged.

- [ ] **Step 2: Rewrite the 5 async acquisitions**

Replace every occurrence in `claude.rs` of:

```rust
        let _guard = CLAUDE_ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner());
```

with:

```rust
        let _guard = CLAUDE_ENV_LOCK.lock().await;
```

Verify counts before/after with `grep -c 'CLAUDE_ENV_LOCK.lock().unwrap_or_else' crates/freshell-freshagent/src/claude.rs` (before: `6` — 5 async + 1 sync; after replacing only in the async tests: the sync one at ~line 976 is handled in Step 3). Practical approach: replace all 6, then fix the sync one per Step 3. Note two of these guards intentionally span a `tokio::join!` (line 1173) and a 10-second sleep-poll loop (line 1333) — that whole-body span is the fixture contract (`FakeClaudeSidecarEnv::install()`'s `Drop` unsets the env vars, so the guard must outlive `env`); do not shrink it.

- [ ] **Step 3: Fix the synchronous `#[test]` site**

In `claude.rs`, test `sidecar_entry_resolves_to_the_vendored_package` (near line 976, a sync `#[test]`), the acquisition must become:

```rust
        let _guard = CLAUDE_ENV_LOCK.blocking_lock();
```

(Keep the `// Guard against the dedup tests' concurrent FRESHELL_CLAUDE_SIDECAR mutation ...` comment above it.)

- [ ] **Step 4: Clippy the crate — expect exactly 1 error to remain**

Run: `cargo clippy -p freshell-freshagent --all-targets -- -D warnings 2>&1 | grep -E '^error' | sort | uniq -c`
Expected: exactly 1 lint error remains: the `let` binding return in `opencode_ws.rs:1192` (Task 4). Zero mentioning claude.rs.

- [ ] **Step 5: Run the crate's lib tests**

Run: `cargo test -p freshell-freshagent --lib claude::tests::`
Expected: PASS, zero failures.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "style(freshagent): migrate CLAUDE_ENV_LOCK to tokio::sync::Mutex

Fixes the 5 remaining clippy::await_holding_lock errors. Same
transform and rationale as the codex ENV_LOCK migration; the sync
sidecar-entry test uses blocking_lock()."
```

---

### Task 4: Fix `let_and_return` in `opencode_ws.rs` (fixes 1 error; crate goes clean)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs:1188-1201` (test `handle_create_duplicate_request_id_preserves_materialized_session_state`)
- Test: existing `#[cfg(test)] mod tests` in `opencode_ws.rs`

**Interfaces:**
- Consumes: nothing.
- Produces: `freshell-freshagent` fully clippy-clean — Tasks 5+ only touch `freshell-server` and CI.

- [ ] **Step 1: Apply clippy's suggested fix**

Change (current code, lines ~1188-1201):

```rust
        let real_session_id = {
            let sessions = st.sessions.lock().await;
            let session_arc = sessions
                .get(placeholder)
                .expect("placeholder session tracked after create")
                .clone();
            drop(sessions);
            let guard = session_arc.lock().await;
            let id = guard
                .real_session_id
                .clone()
                .expect("send must have materialized a durable session");
            id
        };
```

to (drop the `let id = ...; id` binding — the expression becomes the block tail):

```rust
        let real_session_id = {
            let sessions = st.sessions.lock().await;
            let session_arc = sessions
                .get(placeholder)
                .expect("placeholder session tracked after create")
                .clone();
            drop(sessions);
            let guard = session_arc.lock().await;
            guard
                .real_session_id
                .clone()
                .expect("send must have materialized a durable session")
        };
```

(`session_arc` is a `tokio::sync::Mutex`, so `guard` draws no `await_holding_lock` lint; the `.clone()` ends the borrow at the tail expression. Zero behavior change.)

- [ ] **Step 2: Clippy the crate — expect fully clean**

Run: `cargo clippy -p freshell-freshagent --all-targets -- -D warnings; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 3: Run the crate's lib tests**

Run: `cargo test -p freshell-freshagent --lib`
Expected: PASS, zero failures.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "style(freshagent): let expression be block tail in opencode_ws test (clippy let_and_return)"
```

---

### Task 5: Resolve `freshell-server` dead code (fixes 3 errors)

**Files:**
- Modify: `crates/freshell-server/src/extensions.rs` (delete const at lines 37-49 incl. doc comment; fix intra-doc link at line 212; delete `has_cli` at lines 195-200; re-point test assertion at line 538)
- Modify: `crates/freshell-server/src/session_metadata.rs` (gate `get`/`get_all` + the `HashMap` import to `#[cfg(test)]`)
- Test: existing `#[cfg(test)]` modules in both files

**Interfaces:**
- Consumes: nothing.
- Produces: nothing later tasks rely on.

**Verdicts (evidence gathered pre-plan; do not reflexively pub-export or allow):**
- `DEFAULT_CLI_DETECTION_SPECS` → **genuinely dead, delete.** Zero code references workspace-wide. Its only consumer (a fallback in `cli_detection_specs`) was deliberately deleted in commit `24ecdb8e` as a parity bug fix (the fallback made `availableClis` a 5-key map where the JS original serves `{}`). The live spec source is `extensions/*/freshell.json` manifests via `ExtensionRegistry::scan` → `cli_detection_specs()` → `main.rs:477`. The const is already stale (missing `amplifier`). In JS it survives only as a default parameter (`server/platform.ts:97-103`) — Rust has no analogue.
- `has_cli` → **dead in production, delete.** Sole surviving caller is one test assert (`extensions.rs:538`); its production caller was the same deleted fallback; the crate is bin-only so no external consumer can exist. The test assertion is re-pointed at the live `discovered_cli_names()` method with a strictly stronger check (see Step 3 justification).
- `get`/`get_all` on `SessionMetadataStore` → **intentionally-not-yet-ported API, test-only today: gate with `#[cfg(test)]`.** The type is live (`new` ← `main.rs:635`, `set` ← the `POST /api/session-metadata` handler); exactly these two accessors have no production caller yet — the JS original's read callers (`session-indexer.ts:1370`'s `getAll()` join) are not ported. `get` is the read-back oracle for 7 of the module's 18 tests, so deletion would force tests to re-implement the store's parsing — strictly worse. `#[cfg(test)]` beats `#[allow(dead_code)]` because the day a production caller lands, the compiler forces the attribute off rather than letting an allow rot.

- [ ] **Step 1: Delete `DEFAULT_CLI_DETECTION_SPECS`**

In `crates/freshell-server/src/extensions.rs`, delete the constant AND its doc comment — the whole block from line 37 (`/// \`DEFAULT_CLI_DETECTION_SPECS\` (\`server/platform.ts:97-103\`) — the built-in CLI`) through line 49 (`];`):

```rust
/// `DEFAULT_CLI_DETECTION_SPECS` (`server/platform.ts:97-103`) — the built-in CLI
/// set behind `detectAvailableClis`'s JS *default parameter*. NOT used on the
/// server boot path: `server/index.ts` always passes its extension-derived
/// `cliDetectionSpecs` array (possibly empty), so this set never applies there
/// (pinned by a cwd-neutral live probe, 2026-07-12: `availableClis: {}` when no
/// `extensions/` dir is present). Kept for reference parity with `platform.ts`.
pub const DEFAULT_CLI_DETECTION_SPECS: &[(&str, &str, &str)] = &[
    ("claude", "CLAUDE_CMD", "claude"),
    ("codex", "CODEX_CMD", "codex"),
    ("opencode", "OPENCODE_CMD", "opencode"),
    ("gemini", "GEMINI_CMD", "gemini"),
    ("kimi", "KIMI_CMD", "kimi"),
];
```

Leave `const MANIFEST_FILE: &str = "freshell.json";` (line 35) and the `// ── Manifest schema ...` comment untouched. The type is a bare tuple slice — nothing else is orphaned; all `use` lines in the file are consumed elsewhere.

- [ ] **Step 2: De-link the rustdoc intra-doc reference (companion edit — without it `cargo doc` breaks)**

In the same file, the doc comment on `discovered_cli_names` (lines 211-212) links to the deleted constant. Change:

```rust
    /// The names of GENUINELY discovered CLI extension manifests -- NO
    /// [`DEFAULT_CLI_DETECTION_SPECS`] fallback. This is the source for
```

to plain backticks (preserving the explanatory prose):

```rust
    /// The names of GENUINELY discovered CLI extension manifests -- NO
    /// `DEFAULT_CLI_DETECTION_SPECS` fallback (the JS default-parameter set in
    /// `server/platform.ts:97-103`; the Rust mirror was deleted as dead code). This is the source for
```

Keep the rest of that doc comment's sentence intact. The other prose mentions (lines 17, 232, 605) are plain backticks already — leave them.

- [ ] **Step 3: Delete `has_cli` and re-point its one test assertion**

Delete the method (extensions.rs lines 195-200):

```rust
    /// Whether any CLI extension was discovered.
    pub fn has_cli(&self) -> bool {
        self.entries
            .iter()
            .any(|e| e.manifest.category == "cli" && e.manifest.cli.is_some())
    }
```

In the test `scan_discovers_cli_manifests_and_dedups_first_wins` (extensions.rs:538), replace:

```rust
        assert!(reg.has_cli());
```

with:

```rust
        // Strictly stronger than the deleted has_cli(): proves WHICH CLI manifests
        // were discovered, not just that one exists (scan() sorts subdir names, so
        // root's "claude-code" + "opencode" yield ["claude", "opencode"]; root2's
        // dup is dropped).
        assert_eq!(reg.discovered_cli_names(), vec!["claude", "opencode"]);
```

Justification for touching a test in a behavior-preserving chore: the old assertion's only purpose was exercising the now-dead method; the replacement asserts a strict superset of the same property ("CLI manifests discovered, dup dropped") via the live production method `discovered_cli_names()` (`extensions.rs:220-226`, fed to `SettingsStore::load` from `main.rs`). No production behavior changes; test coverage strictly increases.

- [ ] **Step 4: Gate `get`/`get_all` to `#[cfg(test)]`**

In `crates/freshell-server/src/session_metadata.rs`, add `#[cfg(test)]` plus a justification line to both accessors (lines 114-142). `get` becomes:

```rust
    /// `get(provider, sessionId)` (`session-metadata-store.ts:102-106`).
    ///
    /// Test-only today: the port's production surface is the write path
    /// (`POST /api/session-metadata` -> `set`). The reference's read callers
    /// (`session-indexer.ts:1370`'s `getAll()` join) are not ported yet; when
    /// that lands, the compiler will force this gate off.
    #[cfg(test)]
    pub async fn get(&self, provider: &str, session_id: &str) -> Option<Value> {
```

and `get_all` becomes:

```rust
    /// `getAll()` (`session-metadata-store.ts:113-122`): flattened `provider:sessionId` →
    /// entry map.
    ///
    /// Test-only today — see `get` above.
    #[cfg(test)]
    pub async fn get_all(&self) -> HashMap<String, Value> {
```

Method bodies unchanged.

- [ ] **Step 5: Fix the now-conditional `HashMap` import (the trap)**

`HashMap` is imported at the top of `session_metadata.rs` and used ONLY by `get_all` — after Step 4 the non-test build would emit `unused_imports` under `-D warnings`. First verify: `grep -n 'HashMap' crates/freshell-server/src/session_metadata.rs`. If `HashMap` appears only in the import line, `get_all`'s signature/body, and test code, then gate the import. If the import line is `use std::collections::HashMap;` on its own line, change it to:

```rust
#[cfg(test)]
use std::collections::HashMap;
```

If instead `HashMap` is part of a grouped import (e.g. `use std::collections::{HashMap, ...};`), remove `HashMap` from the group and add the two lines above separately. (If the `#[cfg(test)]`-gated import collides with a `use super::*;` in the test module, drop the top-level import entirely and write `std::collections::HashMap` fully qualified in `get_all`'s signature and body — either form satisfies the lint; prefer whichever compiles without warnings.)

- [ ] **Step 6: Clippy the crate — expect only the Task 6 errors to remain**

Run: `cargo clippy -p freshell-server --all-targets -- -D warnings 2>&1 | grep -E '^error' | sort | uniq -c`
Expected: exactly 5 lint errors remain — 1 × `filter(..).next_back()`, 1 × `assert_eq!` literal bool, 3 × `slice::from_ref` (all Task 6). Zero `dead_code` errors.

- [ ] **Step 7: Verify docs build (proves the intra-doc link fix)**

Run: `cargo doc -p freshell-server --no-deps 2>&1 | grep -i "warning" ; echo "exit: $?"`
Expected: no `broken_intra_doc_links` warning (grep finds nothing; grep exit 1 is the good outcome).

- [ ] **Step 8: Run the affected test modules**

Run: `cargo test -p freshell-server extensions:: session_metadata::`
Expected: PASS — 8 extensions tests + 18 session_metadata tests, zero failures.

- [ ] **Step 9: Commit**

```bash
git add crates/freshell-server/src/extensions.rs crates/freshell-server/src/session_metadata.rs
git commit -m "refactor(server): resolve dead_code lints in extensions + session_metadata

- Delete DEFAULT_CLI_DETECTION_SPECS: dead since 24ecdb8e deleted its
  only consumer as a parity fix; live specs come from extension
  manifests. De-link the rustdoc reference to it.
- Delete has_cli (production caller deleted in the same commit);
  re-point its one test assert at the live discovered_cli_names()
  with a strictly stronger assertion.
- Gate SessionMetadataStore::{get,get_all} (+ HashMap import) to
  #[cfg(test)]: faithful-port read API whose JS-side callers
  (session-indexer getAll join) are not ported yet."
```

---

### Task 6: Fix `freshell-server` misc lints (fixes 5 errors; workspace goes clean)

**Files:**
- Modify: `crates/freshell-server/src/terminals.rs:731-737` (production code)
- Modify: `crates/freshell-server/src/settings.rs:90` (test)
- Modify: `crates/freshell-server/src/extensions.rs:548,576,592` (tests)
- Test: existing tests in the same files

**Interfaces:**
- Consumes: Task 5's committed `extensions.rs` (line numbers below are pre-Task-5; locate by content, not line number).
- Produces: full workspace clippy-clean; Task 7 (CI) can now add a green gate.

- [ ] **Step 1: `terminals.rs` — `.filter(..).next_back()` → `.rfind(..)` (the only PRODUCTION code change in this plan)**

In `fn last_emitted_line` (terminals.rs:726-745), change:

```rust
    let last = stripped
        .replace('\r', "\n")
        .split('\n')
        .map(str::trim)
        .filter(|l| !is_shell_prompt_line(l))
        .filter(|l| !l.is_empty())
        .next_back()?
        .to_string();
```

to:

```rust
    let last = stripped
        .replace('\r', "\n")
        .split('\n')
        .map(str::trim)
        .filter(|l| !is_shell_prompt_line(l))
        .rfind(|l| !l.is_empty())?
        .to_string();
```

Semantics identical: `rfind(pred)` on a `DoubleEndedIterator` returns the last element matching the predicate — exactly what `.filter(pred).next_back()` did. Existing `terminals.rs` tests pin the behavior.

- [ ] **Step 2: `settings.rs` — bool assert**

In test `default_network_is_unconfigured_loopback` (settings.rs:90), change:

```rust
        assert_eq!(s.network.configured, false);
```

to:

```rust
        assert!(!s.network.configured);
```

Line 91 (`assert_eq!(s.network.host, NetworkHost::Loopback);`) stays as-is.

- [ ] **Step 3: `extensions.rs` — three `slice::from_ref` sites (all in `#[cfg(test)]`)**

Site 1, test `client_registry_matches_frozen_shape_for_claude` (~line 548):

```rust
        let reg = ExtensionRegistry::scan(&[root.clone()]);
```
→
```rust
        let reg = ExtensionRegistry::scan(std::slice::from_ref(&root));
```

Site 2, test `client_registry_includes_terminal_behavior_and_model_for_opencode` (~line 576):

```rust
        let e = &ExtensionRegistry::scan(&[root.clone()]).to_client_registry()[0];
```
→
```rust
        let e = &ExtensionRegistry::scan(std::slice::from_ref(&root)).to_client_registry()[0];
```

Site 3, test `detection_specs_from_extensions_use_command_and_env_var` (~line 592):

```rust
        let specs = ExtensionRegistry::scan(&[root.clone()]).cli_detection_specs();
```
→
```rust
        let specs = ExtensionRegistry::scan(std::slice::from_ref(&root)).cli_detection_specs();
```

**Do NOT touch** the two-element `ExtensionRegistry::scan(&[root.clone(), root2.clone()])` in `scan_discovers_cli_manifests_and_dedups_first_wins` (~line 536) — it is correctly unflagged (`from_ref` only handles single elements). `from_ref` borrows, so each test's later `std::fs::remove_dir_all(&root)` still compiles.

- [ ] **Step 4: Clippy the crate, then the whole workspace — expect clean**

Run: `cargo clippy -p freshell-server --all-targets -- -D warnings; echo "exit: $?"`
Expected: exit 0.
Run: `cargo clippy --workspace --all-targets -- -D warnings; echo "exit: $?"`
Expected: exit 0. **This is the moment the headline gate goes green.** If any error remains, it is a site outside this plan's inventory — fix it under the same rules of engagement before committing.

- [ ] **Step 5: Run the affected tests**

Run: `cargo test -p freshell-server terminals:: settings:: extensions::`
Expected: PASS — 14 + 1 + 8 tests, zero failures.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/terminals.rs crates/freshell-server/src/settings.rs crates/freshell-server/src/extensions.rs
git commit -m "style(server): rfind over filter+next_back, bool assert, slice::from_ref in tests

Workspace 'cargo clippy --workspace --all-targets -- -D warnings' is
now fully green. last_emitted_line's rfind rewrite is semantically
identical (rfind == filter(pred).next_back() on a DoubleEndedIterator)
and pinned by the existing terminals tests."
```

---

### Task 7: Add CI guard so the debt cannot regrow

**Files:**
- Create: `.github/workflows/rust-clippy.yml`

**Interfaces:**
- Consumes: a green `cargo clippy --workspace --all-targets -- -D warnings` (Task 6) — every command this workflow runs must already pass locally before this task commits.
- Produces: a CI check named `Rust Clippy / clippy` that Task 9's `gh pr checks --watch` will include.

**Context:** `.github/workflows/` contains only Node/Electron workflows (`typecheck-client.yml`, `electron-build.yml`, `electron-release.yml`) — NO cargo invocation exists anywhere in CI today, and no job has a Rust toolchain or cargo cache to append to. A new self-contained workflow is therefore the trivial, non-disruptive option (it cannot break existing checks). It mirrors `typecheck-client.yml`'s trigger/permissions/concurrency shape. `crates/freshell-tauri` needs GTK/WebKit system libs to compile on `ubuntu-latest` — one apt-get step buys true full-workspace coverage rather than an `--exclude` carve-out. The two default-off `real-transport` features get an explicit second step (`--all-targets` does not imply `--all-features`), and `cargo fmt --all --check` rides along since rustfmt is free once the toolchain is installed.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/rust-clippy.yml` with exactly:

```yaml
name: Rust Clippy

on:
  push:
    branches:
      - main
  pull_request:

permissions:
  contents: read

concurrency:
  group: rust-clippy-${{ github.ref }}
  cancel-in-progress: true

jobs:
  clippy:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
        with:
          components: clippy, rustfmt

      - uses: Swatinem/rust-cache@v2

      # freshell-tauri (Tauri v2 / WRY) needs GTK+WebKit system libs to compile
      # on ubuntu-latest; installing them keeps the gate truly --workspace.
      - name: Install Tauri system dependencies
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev \
            libjavascriptcoregtk-4.1-dev librsvg2-dev \
            libayatana-appindicator3-dev pkg-config build-essential

      - name: cargo fmt
        run: cargo fmt --all --check

      - name: cargo clippy (workspace)
        run: cargo clippy --workspace --all-targets -- -D warnings

      # --all-targets does not imply --all-features: the real-transport
      # backends are default-off and would otherwise go unlinted.
      - name: cargo clippy (feature-gated backends)
        run: |
          cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings
          cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
```

- [ ] **Step 2: Verify locally that every command the workflow runs is green**

Run (from the worktree root):

```bash
cargo fmt --all --check && \
cargo clippy --workspace --all-targets -- -D warnings && \
cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings && \
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings && \
echo ALL-GREEN
```

Expected: prints `ALL-GREEN`. If `cargo fmt --all --check` fails, run `cargo fmt --all`, re-run the affected crates' tests (`cargo test -p <crate>`), and amend the formatting into a dedicated `style: cargo fmt` commit BEFORE committing the workflow — the workflow must never land ahead of its own gate passing.

- [ ] **Step 3: Sanity-check the YAML parses**

Run: `python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/rust-clippy.yml')); print('yaml ok')"`
Expected: `yaml ok`. (If PyYAML is unavailable: `node -e "const fs=require('fs');console.log('exists', fs.existsSync('.github/workflows/rust-clippy.yml'))"` and rely on the PR's Actions tab in Task 9 — a malformed workflow shows as a workflow-parse failure there, which Task 9's check-watch would surface.)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/rust-clippy.yml
git commit -m "ci: add rust clippy + fmt workflow

The Rust workspace previously had zero CI coverage; this guard keeps
'cargo clippy --workspace --all-targets -- -D warnings' (plus fmt and
the default-off real-transport features) from silently regrowing debt."
```

---

### Task 8: Full final gates

**Files:**
- None modified (verification only; fixes only if a gate fails).

**Interfaces:**
- Consumes: all prior commits.
- Produces: evidence that the branch is mergeable; Task 9 depends on every gate here being green.

- [ ] **Step 1: Workspace clippy gate**

Run: `cargo clippy --workspace --all-targets -- -D warnings; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 2: Feature-gated clippy stays clean**

Run: `cargo clippy -p freshell-codex --all-targets --features real-transport -- -D warnings && cargo clippy -p freshell-opencode --all-targets --features real-transport -- -D warnings; echo "exit: $?"`
Expected: exit 0.

- [ ] **Step 3: Full Rust test suite**

Run: `cargo test --workspace` (allow up to ~15 minutes; several freshagent tests spawn Node fixture subprocesses — `node` must be on PATH)
Expected: all crates PASS, zero failures. `freshell-server` contributes 332 tests (328 bin-unit + 4 integration). If any test fails, STOP and fix within the rules of engagement (behavior-preserving; test assertions unchanged except the one justified swap in Task 5) — do not proceed to the PR with a red suite.

- [ ] **Step 4: Formatting gate**

Run: `cargo fmt --all --check; echo "exit: $?"`
Expected: exit 0 (Task 7 Step 2 already enforced this; this is the final confirmation).

- [ ] **Step 5: Coordinated JS suite (repo rule: this chore didn't touch JS, but the gate is mandatory)**

Run: `npm run test:status` — inspect the shared coordinator gate. If another agent holds it, WAIT (poll `npm run test:status`; never kill a foreign holder).
Then run: `FRESHELL_TEST_SUMMARY="clippy debt chore" npm test` (allow up to ~30 minutes)
Expected: suite green (matches the pre-existing baseline — this branch touches no JS). If failures appear, compare against `npm run test:status`'s advisory baseline: pre-existing failures unrelated to this branch should be reported in the PR body, not "fixed" here; any failure plausibly caused by this branch means STOP and investigate (there should be none — no JS files change).

- [ ] **Step 6: Working tree clean**

Run: `git status --short`
Expected: empty output (no uncommitted changes, no stray artifacts). If build/log artifacts appeared inside the worktree, remove them; do not commit them.

No commit for this task.

---

### Task 9: Push, PR, watch checks, self-merge, report

**Files:**
- None modified.

**Interfaces:**
- Consumes: green gates from Task 8; the `Rust Clippy` workflow from Task 7 (it will run on this very PR — the guard proving itself is the point).
- Produces: merged PR on `main`; final report of PR number + merge commit.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin chore/clippy-debt
```

- [ ] **Step 2: Open the PR (pre-approved by the user for this chore branch)**

```bash
gh pr create \
  --title "chore: zero out workspace clippy debt" \
  --body "$(cat <<'EOF'
## Summary
Makes `cargo clippy --workspace --all-targets -- -D warnings` fully green (was: 34 errors at base 4835de63) and adds a CI workflow so the debt cannot silently regrow. Behavior-preserving: no production logic changes beyond deletion of provably-dead code; the only production code edit is a semantics-identical `filter(..).next_back()` → `rfind(..)` rewrite.

- **freshell-freshagent (28 errors):** migrated the two test-only env-serialization locks (`ENV_LOCK`, `CLAUDE_ENV_LOCK`) from `std::sync::Mutex<()>` to `tokio::sync::Mutex<()>` — the convention `freshell-ws`'s integration tests already use. Fixes all 27 `await_holding_lock` errors and DELETES the 7 pre-existing `#[allow(clippy::await_holding_lock)]` suppressions (net: zero suppressions). Plus one `let_and_return` fix.
- **freshell-server (8 errors):** deleted `DEFAULT_CLI_DETECTION_SPECS` and `has_cli` (dead since commit 24ecdb8e deliberately removed their only consumer as a parity fix); gated the not-yet-ported `SessionMetadataStore::{get,get_all}` read API to `#[cfg(test)]`; `rfind` rewrite; bool-assert and 3× `slice::from_ref` test lints.
- **CI:** new `.github/workflows/rust-clippy.yml` (fmt + workspace clippy + real-transport feature clippy). The Rust workspace previously had zero CI coverage.

## Verification
- `cargo clippy --workspace --all-targets -- -D warnings` → exit 0
- `cargo clippy -p freshell-codex --all-targets --features real-transport -- -D warnings` → exit 0 (stays clean post-#532); same for freshell-opencode
- `cargo test --workspace` → green
- `cargo fmt --all --check` → clean
- Coordinated JS suite (`FRESHELL_TEST_SUMMARY="clippy debt chore" npm test`) → green (no JS touched)
EOF
)"
```

- [ ] **Step 3: Watch checks**

```bash
gh pr checks --watch
```

Expected: all checks pass, including the new `Rust Clippy / clippy` job (its first run is cache-cold — the apt + full build may take most of the 30-minute budget; subsequent runs are cached). **If any check fails: STOP and report the failure (PR number, failing check, log excerpt) — do not force-merge, do not bypass.** A failure in the new workflow itself (e.g. an ubuntu package name drift for the Tauri deps) may be fixed with a follow-up commit to this branch, then re-watch; anything else, report.

- [ ] **Step 4: Self-merge per repo norm and report**

```bash
gh pr merge --merge --delete-branch
git fetch origin main
git log --oneline -1 origin/main
```

Expected: merge succeeds. Report: PR number (from Step 2 output) and the merge commit SHA (from the final `git log` line).

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- Workspace clippy fully green → Tasks 2-6 (all 34 inventoried errors have an exact fix), gate in Tasks 6/8. ✓
- Re-run clippy first to get the exact current list → done pre-plan AND Task 1 re-verifies (with an explicit instruction to fix any toolchain-drift extras under the same rules). ✓
- freshell-codex real-transport stays clean → Task 1 Step 3 + Task 8 Step 2 + CI step. ✓
- No blanket allows; MutexGuard restructure rules → zero new allows, 7 deleted; the tokio-mutex migration is the honest restructure for a `()` token whose guard IS the exclusion (clone-out-of-lock is inapplicable — nothing to clone). ✓
- dead_code triage (delete / fix cfg / justify — no reflexive pub-export or allow) → Task 5 gives per-item verdicts with evidence. ✓
- Zero behavior changes; same test assertions → only exception is the single justified assertion swap forced by deleting `has_cli` (Task 5 Step 3, strictly stronger, via a live method); all other tests untouched. ✓
- Red committed in the plan doc; small commits grouped by crate/lint; per-commit crate tests + clippy → Red Baseline section; Tasks 2-6 each end with crate clippy + tests + commit. ✓
- Final gates incl. coordinated npm test with FRESHELL_TEST_SUMMARY and gate-wait → Task 8. ✓
- CI guard consideration → Task 7 adds it (trivial because it's a new self-contained workflow; nothing existing is modified). ✓
- Repo rules (no server restart, no broad kills, disk, worktree) → Global Constraints + Task 8 Step 5. ✓
- PR policy (pre-approved, title, checks --watch, self-merge, report number + merge commit, report-not-force on failure) → Task 9. ✓

**1b. No silent deferrals:** the deliverable is observable directly: the exact gate commands exit 0 on the branch and in CI on the real PR. No stubs/mocks stand in for any outcome. The one intentionally-deferred item — porting the JS session-indexer `getAll()` join that would give `get`/`get_all` production callers — is NOT a requirement of this chore's spec (the spec's option (c) explicitly allows "intentionally-not-yet-used API → justify"); the `#[cfg(test)]` gate + doc comment is that justification, and the compiler mechanically un-gates it when the port lands.

**2. Placeholder scan:** no TBDs; every code step shows the exact before/after code; every run step has the exact command and expected outcome. One deliberate conditional (Task 5 Step 5: grouped vs standalone `HashMap` import) gives the concrete edit for each of the two possible current shapes rather than guessing — both branches are fully specified.

**3. Type consistency:** `ENV_LOCK`/`CLAUDE_ENV_LOCK` keep their names, visibility (`pub(crate)`/private), and module paths — cross-file users (`snapshot.rs`, `terminal_tabs.rs`) compile against the same paths. `blocking_lock()`/`lock().await` match `tokio::sync::Mutex`'s API in tokio 1.52.3. `discovered_cli_names()` returns `Vec<String>`, comparable with `vec!["claude", "opencode"]` via `assert_eq!` (`String: PartialEq<&str>`). `std::slice::from_ref(&root)` yields `&[PathBuf]` matching `scan(dirs: &[PathBuf])`.
