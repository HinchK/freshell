# Zero-Turn Claude Existence Fix Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Zero-turn freshclaude sessions (0-byte transcript that exists on disk) must reconcile to `respawn` after an abrupt server restart — never be falsely adjudicated `dead_session` — while genuinely-deleted transcripts still fire the loud `dead_session` hazard guard.

**Architecture:** freshell has two silently inconsistent definitions of "does this claude session exist": the attach/resume arm trusts raw file existence (`crates/freshell-freshagent/src/claude_snapshot.rs::locate_transcript`), while the reconcile-verdict arm consults the warm `SessionIndex`, whose R10b gate (`meta.cwd.as_ref()?` in `crates/freshell-sessions/src/directory_index.rs::parse_claude_file`) excludes any transcript with no parseable cwd line — so a 0-byte zero-turn transcript is confidently reported `Absent`, combined with the ledger's `ever_observed=true` into `GoneObserved` → `DeadSession{session_not_on_disk}`. The fix makes the two arms agree WITHOUT weakening R10b (History still needs real displayable metadata) and WITHOUT touching codex: `IndexExistenceProbe` (in `crates/freshell-server/src/existence.rs`) gains an injected claude-transcript-locator closure; when the warm index answers `Absent` for provider `"claude"`, the probe consults the same raw-file check the attach arm uses before finalizing `Absent` — file exists ⇒ `Present`. `main.rs` injects `freshell_freshagent::locate_transcript` at wiring time (the same injectable-locator pattern as `codex_rollout_locator`), keeping the probe unit-testable with a fake locator and no env manipulation.

**Root cause is PROVEN** (instrumented traces from a systematic-debugging investigation; existence=Absent for a 0-byte transcript on disk with a bound ledger row). Do not re-litigate it; Task 1's RED runs and Task 2's RED unit test are the load-bearing verification of its claims. Note: `kilroy` is a sessionType that maps to provider `"claude"` (same transcript store), so a claude-scoped fix covers it for free. Two alternative shapes were evaluated and rejected: (a) splitting the probe into two methods, "valid listable session" (History, keeps R10b) vs "identity exists on disk" (reconcile, stat-only) — would require a second trait method on `SessionExistenceProbe` and touch every implementor/caller for a distinction only claude needs; the injected fallback is strictly smaller and keeps the trait contract intact. (b) a distinct `PresentUnparsed` variant instead of plain `Present` — rejected because no downstream consumer needs the distinction: `build_snapshot` (`crates/freshell-ws/src/reconcile_freshagent.rs`) maps `E::Present` → `FreshAgentPresence::OnDisk` → verdict `respawn`, which is exactly the desired outcome, and every `SessionExistence` match in that module is deliberately exhaustive with no catch-all — a new variant would force edits (and re-decisions) at every match site for zero behavioral difference.

**Tech Stack:** Rust (cargo workspace: `freshell-server`, `freshell-ws`, `freshell-freshagent`, `freshell-sessions`), Playwright e2e (`test/e2e-browser/`, rust-chromium project), fake claude sidecar fixture (`test/e2e-browser/fixtures/fake-claude-sidecar.mjs`).

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/zero-turn-claude-existence`, branch `fix/zero-turn-claude-existence`, based on current `origin/main` (≥ `53673c2c`). ALL commands below run from this worktree root unless stated otherwise.
- NEVER use ports 3001/3002 (the user's LIVE servers — 3002 is the live Rust server). NEVER restart the user's server. NEVER use broad kill patterns (`pkill -f ...`, `pkill node`). E2e fixtures pick ephemeral ports themselves — never pass a fixed port.
- Broad test runs go through the shared coordinator gate: check `npm run test:status` first; if another agent holds it, WAIT — never kill a foreign holder. Canonical broad-run form: `FRESHELL_TEST_SUMMARY="kata 09v1 zero-turn-claude-existence <phase>" env -u FRESHELL_BIND_HOST npm test`.
- CI gates that must pass: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings` (required CI), `cargo test --workspace`, coordinated `npm test`, `npm run test:port`.
- After ANY Rust edit, rebuild explicitly with `cargo build --release -p freshell-server` before running e2e — the e2e harness only auto-builds when `target/release/freshell-server` is MISSING; it does not detect staleness.
- Do NOT weaken R10b (`meta.cwd.as_ref()?` in `directory_index.rs:291` and its byte-for-byte mirror in `crates/freshell-server/src/session_directory.rs`) — it protects the History sidebar. Do NOT change codex behavior (zero-turn codex genuinely has no rollout file).
- Do NOT build on the scratch worktree `.worktrees/debug-09v1` (branch `debug/09v1`) and do NOT let its `DEBUG09v1`-marked `eprintln!`s leak into this branch. It is read-only evidence, as are `/tmp/09v1-server-stderr.log`, `/tmp/freshell-e2e-rust-NaUAAO/`, `/tmp/09v1-test-run*.log`.
- PR POLICY: do NOT create a PR. Push the branch and stop; landing happens outside this workflow.
- Git identity: commits use `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (already configured — do not override; never write `dan@danshapiro.com` into git config).
- Server TS is NodeNext/ESM: relative imports in `.ts` files must include `.js` extensions.
- README.md is the only end-user markdown doc; this plan under `docs/plans/` is a working/agent doc.
- Keep commits focused and atomic; Red-Green-Refactor for every behavior change.

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-server/src/existence.rs` | Modify | `IndexExistenceProbe`: new optional `claude_transcript_locator` field + builder setter; warm-`Absent` fallback for provider `"claude"`; observed-set feed on fallback hit; module-doc bullet; unit tests (RED→GREEN) |
| `crates/freshell-freshagent/src/claude_snapshot.rs` | Modify | `locate_transcript`: `pub(crate)` → `pub`, doc updated for the new consumer (everything else stays `pub(crate)`) |
| `crates/freshell-freshagent/src/lib.rs` | Modify | Narrow re-export: `pub use claude_snapshot::locate_transcript;` |
| `crates/freshell-server/src/main.rs` | Modify | Wire the real locator into the probe at the single construction site (~`:570`) |
| `crates/freshell-ws/src/reconcile_freshagent.rs` | Modify | Module doc (`:8-18`): add the claude zero-turn asymmetry bullet; update the CLAUDE_CONFIG_DIR WATCH bullet |
| `test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts` | Create | NEW companion e2e: VISIBLE zero-turn freshclaude pane survives abrupt restart |
| `test/e2e-browser/playwright.config.ts` | Modify | Register the new spec in `RUST_ONLY_SPECS` (~`:81-155`) AND `rust-chromium.testMatch` (~`:208-337`) |

Crate dependency note (verified): `freshell-server` already depends on `freshell-freshagent` (`crates/freshell-server/Cargo.toml`, `freshell-freshagent = { path = "../freshell-freshagent" }`), so no cross-crate injection trait is needed — only a visibility promotion. The closure injection into the probe is for decoupling + testability (precedent: `codex_rollout_locator` at `main.rs:482-486`), not to satisfy the dependency graph.

Root-set note (deliberate behavior change, called out for reviewers): the index-backed probe today sees ONE claude root (`CLAUDE_HOME` else `$HOME/.claude` via `session_directory::claude_home`); `locate_transcript` scans the attach arm's full ordered candidate set (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` > `$HOME/.claude`, env-resolved at call time, deduped). Adopting the attach arm's set is the point — the two arms must agree — and it incidentally closes the `CLAUDE_CONFIG_DIR` reader/writer-split WATCH declared in `reconcile_freshagent.rs:17-18` for the reconcile arm (the History index walk still reads one root). Task 5 updates that WATCH comment.

---

### Task 1: Workspace verification + RED baseline (proves the diagnosis end-to-end)

**Files:**
- No source changes. Produces `/tmp/freshell-09v1-prefix-server` (a saved copy of the pre-fix release binary, used by Task 6 for the companion e2e's red-proof).

**Interfaces:**
- Consumes: nothing.
- Produces: a green base suite record, a pre-fix release binary at `/tmp/freshell-09v1-prefix-server`, and a recorded RED failure of the kata's acceptance e2e.

- [ ] **Step 1: Verify the worktree is on current origin/main**

Run:
```bash
cd /home/dan/code/freshell/.worktrees/zero-turn-claude-existence
git fetch origin
git log --oneline -1 origin/main
git merge-base --is-ancestor origin/main HEAD && echo BASE-OK || echo "REBASE NEEDED"
git status --short
```
Expected: `BASE-OK` (origin/main is `53673c2c` or newer and an ancestor of HEAD). If `REBASE NEEDED`: `git rebase origin/main` (the branch has only this plan committed, so it rebases trivially).

- [ ] **Step 2: Verify node_modules and the tsx symlink**

Run:
```bash
ls node_modules/tsx >/dev/null 2>&1 && echo TSX-OK || { npm ci && ln -s ../node_modules/tsx node_modules/tsx 2>/dev/null; echo TSX-FIXED; }
```
Expected: `TSX-OK` (already verified present at plan-writing time) or `TSX-FIXED`.

- [ ] **Step 3: Base suite green (coordinated broad run)**

Run:
```bash
npm run test:status
```
If another agent holds the coordinator gate: WAIT (poll `npm run test:status` every few minutes) — never kill a foreign holder. Then:
```bash
FRESHELL_TEST_SUMMARY="kata 09v1 zero-turn-claude-existence base green" env -u FRESHELL_BIND_HOST npm test
```
Expected: PASS. If the base suite is red on unmodified origin/main, STOP and report the failing command + summary — do not proceed on a red base.

- [ ] **Step 4: Build the pre-fix release binary and save a copy**

Run:
```bash
cargo build --release -p freshell-server
cp target/release/freshell-server /tmp/freshell-09v1-prefix-server
chmod +x /tmp/freshell-09v1-prefix-server
```
Expected: build succeeds; `/tmp/freshell-09v1-prefix-server` exists and is executable. This frozen pre-fix binary is Task 6's red-proof lever for the new companion spec (`FRESHELL_E2E_RUST_SERVER_BIN` fails closed if it is not an executable file).

- [ ] **Step 5: Run the kata's acceptance e2e AS-IS and record the RED**

The acceptance test is `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts` test `'hidden fresh-agent pane recovers after abrupt restart without reveal'`. It creates a freshclaude pane via the fake sidecar (which creates a **0-byte transcript at session create** — `fake-claude-sidecar.mjs` runs `fs.closeSync(fs.openSync(transcriptPath(cliSessionId), 'a'))` on `create`; `appendTranscript` only runs on `send`), sends NO turn, hides the pane, `restartAbrupt()`s the server, and polls for a sidecar-log `create` carrying `resumeSessionId === originalDurable`. Do NOT add a turn to it — zero-turn is the point.

Run:
```bash
npm run test:e2e -- --project=rust-chromium specs/hidden-pane-rebind-rust.spec.ts -g 'hidden fresh-agent pane recovers'
```
Expected: **FAIL** (timeout on the resumed-poll — the server adjudicates the zero-turn session `dead_session{session_not_on_disk}` instead of `respawn`, so the resume `create` never appears in the sidecar log). This RED run is the end-to-end verification of the diagnosis. If it PASSES, STOP: the bug is already fixed on main — report and halt rather than proceeding.

- [ ] **Step 6: Commit (nothing to commit — record only)**

No commit for this task (no file changes). Record the RED output (the failing assertion text) in the task report for the reviewer.

---

### Task 2: Probe fallback in `IndexExistenceProbe` (RED unit tests → implementation → GREEN)

**Files:**
- Modify: `crates/freshell-server/src/existence.rs`

**Interfaces:**
- Consumes: existing `IndexExistenceProbe { index, observed, ledger, provider_roots }`, `SessionExistence::{Present, Absent, Unknown, ProviderUnavailable}` and `SessionExistenceProbe` (both from `crates/freshell-ws/src/existence.rs`), test helpers `temp_claude_home(tag: &str) -> PathBuf`, `write_session(claude_home: &Path, session_id: &str)`, `probe_over(home: &Path) -> (IndexExistenceProbe, Arc<SessionIndex>)` (all already in `existence.rs`'s `#[cfg(test)] mod tests`).
- Produces (Tasks 3 and 6 rely on these exact names/types):
  - `pub type ClaudeTranscriptLocator = std::sync::Arc<dyn Fn(&str) -> Option<std::path::PathBuf> + Send + Sync>;`
  - `impl IndexExistenceProbe { pub fn with_claude_transcript_locator(self, locator: ClaudeTranscriptLocator) -> Self }` (builder-style, consumes and returns `Self`; no change to `IndexExistenceProbe::new`'s signature — existing call sites stay untouched).

- [ ] **Step 1: Write the failing tests**

Append inside the existing `#[cfg(test)] mod tests` block of `crates/freshell-server/src/existence.rs` (after the existing helper fns `temp_claude_home` / `write_session` / `probe_over` / `new_test_probe_with_ledger`; `use super::*;` is already at the top of the module, which brings `Arc`, `HashMap`, `PathBuf`, and — once Step 3 lands — `ClaudeTranscriptLocator` into scope):

```rust
    /// A zero-turn claude transcript: the real CLI creates the file at
    /// session-create time, BEFORE any turn — 0 bytes, no cwd-bearing line,
    /// fails the index's R10b gate — yet `claude --resume <uuid>` works on it.
    fn write_zero_turn_session(claude_home: &std::path::Path, session_id: &str) {
        std::fs::write(
            claude_home
                .join("projects/proj")
                .join(format!("{session_id}.jsonl")),
            "",
        )
        .expect("write zero-turn fixture");
    }

    /// Test locator with the SAME contract as claude_snapshot::locate_transcript
    /// (Some(path) iff the transcript file exists), scoped to the temp home so
    /// tests never touch process-global CLAUDE_* env vars.
    fn direct_locator_over(home: &std::path::Path) -> ClaudeTranscriptLocator {
        let projects = home.join("projects/proj");
        Arc::new(move |session_id: &str| {
            let p = projects.join(format!("{session_id}.jsonl"));
            p.is_file().then_some(p)
        })
    }

    /// Kata 09v1 RED: a zero-turn claude transcript (0-byte file, on disk from
    /// session create) must answer Present, never Absent — the attach arm
    /// resumes it, so reconcile must not adjudicate it dead. Today the R10b
    /// cwd gate excludes it from the index and the warm snapshot answers a
    /// false Absent.
    #[tokio::test]
    async fn zero_turn_claude_transcript_on_disk_is_present_not_absent() {
        let home = temp_claude_home("zero-turn");
        let session_id = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
        write_zero_turn_session(&home, session_id);
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present,
            "the file exists on disk (attach arm would resume it) — the probe \
             must agree with the raw-file check, not the R10b-gated index"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Fallback-Present feeds the monotone observed-set (module-doc invariant:
    /// every read that sees the identity on disk records it), so a LATER
    /// genuine deletion still derives loud dead_session even without a ledger.
    #[tokio::test]
    async fn fallback_present_feeds_ever_observed() {
        let home = temp_claude_home("fallback-observed");
        let session_id = "2b3c4d5e-6f70-4a81-9b2c-3d4e5f607182";
        write_zero_turn_session(&home, session_id);
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(probe.exists("claude", session_id), SessionExistence::Present);
        assert!(
            probe.ever_observed("claude", session_id),
            "a fallback hit is an on-disk observation and must feed ever_observed"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// HAZARD GUARD (must not regress): a transcript GENUINELY absent from
    /// disk stays Absent even with the locator installed — the fallback must
    /// never weaken positive denial. (The Absent + ever_observed ⇒
    /// dead_session derivation itself stays pinned by the existing
    /// `ever_observed_survives_a_restart_via_the_ledger` here, reconcile.rs's
    /// `row4_absent_but_ever_observed_yields_dead_session`, and
    /// reconcile_freshagent.rs's `gone_observed_maps_to_dead_session_not_on_disk`.)
    #[tokio::test]
    async fn genuinely_missing_transcript_stays_absent_with_locator_installed() {
        let home = temp_claude_home("hazard-guard");
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(direct_locator_over(&home));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", "9d8c7b6a-5f4e-4d3c-8b2a-1f0e9d8c7b6a"),
            SessionExistence::Absent,
            "no transcript anywhere: warm-index Absent AND raw-file miss ⇒ Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The fallback is CLAUDE-scoped: zero-turn codex genuinely has no rollout
    /// file (vendor deferred materialization — reconcile_freshagent.rs module
    /// doc), so a codex Absent must stay Absent even when the installed
    /// locator would answer Some for any id.
    #[tokio::test]
    async fn codex_absent_never_consults_the_claude_locator() {
        let home = temp_claude_home("codex-gate");
        let (probe, index) = probe_over(&home);
        let probe = probe.with_claude_transcript_locator(Arc::new(|_sid: &str| {
            Some(std::path::PathBuf::from("/nonexistent/never-used.jsonl"))
        }));
        index.warm().await;
        assert_eq!(
            probe.exists("codex", "thread-1"),
            SessionExistence::Absent,
            "the raw-file fallback is provider-gated to claude only"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:
```bash
cargo test -p freshell-server existence
```
Expected: **compile error** — `with_claude_transcript_locator` and `ClaudeTranscriptLocator` do not exist yet. That compile failure is the first RED. To also capture the BEHAVIORAL red (the load-bearing verification of the diagnosis's R10b-exclusion claim): apply Step 3's sub-steps 3a–3d ONLY (type alias, field, `None` init, setter — API surface with no fallback logic), re-run the same command, and observe `zero_turn_claude_transcript_on_disk_is_present_not_absent` and `fallback_present_feeds_ever_observed` FAIL with `left: Absent, right: Present` while the two guard tests pass. Record that output, then proceed to 3e–3f.

- [ ] **Step 3: Implement the fallback**

In `crates/freshell-server/src/existence.rs`:

3a. Add the type alias after the `KNOWN_PROVIDERS` const (imports `std::path::PathBuf` and `std::sync::Arc` are already at the top of the file):

```rust
/// Injected raw-file transcript check for claude (kata 09v1). Wiring installs
/// `freshell_freshagent::locate_transcript` — the SAME ordered-candidate-roots
/// scan the attach arm trusts (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
/// `$HOME/.claude`) — so reconcile and attach can never disagree about whether
/// a claude transcript exists. A closure (not a direct call) keeps this probe
/// unit-testable without process-global env mutation; precedent:
/// `codex_rollout_locator` (main.rs).
pub type ClaudeTranscriptLocator = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;
```

3b. Add the field to the struct (after `provider_roots`):

```rust
    /// Zero-turn claude fallback (kata 09v1): claude transcripts exist on disk
    /// from session create, BEFORE any turn — but a 0-byte transcript has no
    /// cwd-bearing line, so the index's R10b gate excludes it and the warm
    /// snapshot answers a false Absent while the attach arm would resume it.
    /// When set, a warm-index Absent for provider "claude" is re-checked
    /// against raw file existence before being finalized. `None` (tests,
    /// callers that never set it) keeps the pure index answer.
    claude_transcript_locator: Option<ClaudeTranscriptLocator>,
```

3c. Initialize it in `new()` (add one line to the `Self { ... }` literal; do NOT change `new`'s signature):

```rust
            claude_transcript_locator: None,
```

3d. Add the builder setter to the same `impl IndexExistenceProbe` block (after `new`):

```rust
    /// Builder-style: install the raw-file fallback for claude (see the field
    /// doc). Chained at the single production construction site in main.rs.
    pub fn with_claude_transcript_locator(mut self, locator: ClaudeTranscriptLocator) -> Self {
        self.claude_transcript_locator = Some(locator);
        self
    }
```

3e. Replace the `Some(items)` arm of the `match self.index.peek()` in `exists()` — currently:

```rust
            Some(items) => {
                self.record_observed(&items);
                let hit = items
                    .iter()
                    .any(|s| s.provider == provider && s.session_id == session_id);
                if hit {
                    SessionExistence::Present
                } else {
                    SessionExistence::Absent
                }
            }
```

with:

```rust
            Some(items) => {
                self.record_observed(&items);
                let hit = items
                    .iter()
                    .any(|s| s.provider == provider && s.session_id == session_id);
                if hit {
                    return SessionExistence::Present;
                }
                // Zero-turn claude fallback (kata 09v1): claude transcripts
                // exist on disk from session create, BEFORE any turn — but a
                // 0-byte transcript has no cwd-bearing line, so the index's
                // R10b gate (directory_index.rs::parse_claude_file) excludes
                // it and the warm snapshot answers a false Absent, while the
                // attach arm (claude.rs::handle_attach via
                // claude_snapshot::locate_transcript) trusts raw file
                // existence and resumes it. The two arms must agree: before
                // finalizing Absent for claude, consult the SAME raw-file
                // check. CLAUDE-scoped only — zero-turn codex genuinely has
                // no rollout file (reconcile_freshagent.rs module doc) — and
                // R10b itself stays intact for History listing.
                if provider == "claude" {
                    if let Some(locator) = &self.claude_transcript_locator {
                        if locator(session_id).is_some() {
                            // A fallback hit is an on-disk observation: feed
                            // the monotone observed-set (module-doc invariant)
                            // so a LATER genuine deletion still derives loud
                            // dead_session even without the ledger.
                            self.observed
                                .lock()
                                .expect("observed set lock")
                                .insert(format!("{provider}:{session_id}"));
                            return SessionExistence::Present;
                        }
                    }
                }
                SessionExistence::Absent
            }
```

3f. Extend the module doc (`//!` block at the top of the file): after the existing bullet ending "never a latched stale `Absent` (§9.1 test 13)", add:

```rust
//! * warm snapshot `Absent` for provider `claude` with a transcript locator
//!   installed → re-checked against raw file existence (kata 09v1): a
//!   zero-turn claude transcript exists on disk from session create but has
//!   no cwd line, so the R10b index gate excludes it — file present ⇒
//!   `Present`, so reconcile agrees with the attach arm and never falsely
//!   adjudicates a resumable session dead.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run:
```bash
cargo test -p freshell-server existence
```
Expected: PASS — all 4 new tests AND all 7 pre-existing tests in the module (`ever_observed_survives_a_restart_via_the_ledger`, `unknown_provider_is_absent_never_unknown`, `cold_index_is_unknown_for_known_provider`, `missing_provider_root_is_provider_unavailable_not_unknown`, `existing_but_cold_provider_root_stays_unknown`, `session_written_after_cold_read_resolves_present_on_requery`, `ever_observed_survives_the_session_disappearing_from_disk`). The pre-existing tests all construct the probe WITHOUT a locator, proving default behavior is unchanged.

- [ ] **Step 5: Format, lint, workspace test**

Run:
```bash
cargo fmt
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: all clean/PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/existence.rs
git commit -m "fix(reconcile): raw-file fallback for warm-index Absent on claude (kata 09v1)

A zero-turn claude transcript (0-byte, created at session create) fails
the index's R10b cwd gate, so IndexExistenceProbe answered a false
Absent while the attach arm's raw-file check would resume it -- Absent +
ever_bound ledger row => GoneObserved => dead_session{session_not_on_disk}.
Add an injectable claude transcript locator consulted before finalizing
a warm-index Absent for provider claude. Claude-scoped (zero-turn codex
genuinely has no rollout file); R10b untouched; genuine deletion still
answers Absent (hazard guard tests)."
```

---

### Task 3: Visibility promotion + wiring — the acceptance e2e goes GREEN

**Files:**
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (one `pub(crate) fn` → `pub fn` + doc)
- Modify: `crates/freshell-freshagent/src/lib.rs` (one `pub use` line)
- Modify: `crates/freshell-server/src/main.rs` (chain the setter at the probe construction site, ~`:570`)

**Interfaces:**
- Consumes: `IndexExistenceProbe::with_claude_transcript_locator(self, locator: ClaudeTranscriptLocator) -> Self` (Task 2); `claude_snapshot::locate_transcript(session_id: &str) -> Option<PathBuf>` (existing, currently `pub(crate)`).
- Produces: `freshell_freshagent::locate_transcript(session_id: &str) -> Option<std::path::PathBuf>` — `pub` crate-root re-export (Task 6's gates and any future caller rely on this path).

- [ ] **Step 1: Promote `locate_transcript` to `pub` with an updated doc**

In `crates/freshell-freshagent/src/claude_snapshot.rs`, change the function (currently `pub(crate) fn locate_transcript`) to:

```rust
/// `find_transcript` across every candidate root, in resolution order.
/// Positive denial (attach) and snapshot 404 both require a miss EVERYWHERE.
/// `pub` + re-exported at the crate root (kata 09v1): `freshell-server`'s
/// `IndexExistenceProbe` consults this SAME check before finalizing a
/// warm-index `Absent` for claude — zero-turn transcripts are 0-byte, fail
/// the index's R10b cwd gate, yet ARE resumable, so the reconcile arm and
/// the attach arm must share one definition of "the transcript exists".
pub fn locate_transcript(session_id: &str) -> Option<PathBuf> {
    claude_home_candidates()
        .iter()
        .find_map(|root| find_transcript(root, session_id))
}
```

(Only the visibility keyword and doc change; the body is already exactly this. `find_transcript`, `claude_home_candidates`, `transcript_cwd`, `build_claude_snapshot_json`, `get_claude_snapshot` all stay `pub(crate)` — nothing else in this module should be visible outside the crate. `locate_transcript` already has a built-in path-traversal guard via `find_transcript`, so handing it a client-claimed session id is safe.)

- [ ] **Step 2: Add the narrow crate-root re-export**

In `crates/freshell-freshagent/src/lib.rs`, the module stays `pub(crate) mod claude_snapshot;`. In the `pub use` block (after `pub use claude::FreshClaudeState;`), add:

```rust
// Kata 09v1: the ONE claude_snapshot item visible outside this crate — the
// raw-file existence check freshell-server's IndexExistenceProbe shares with
// the attach arm. Keep the rest of claude_snapshot crate-private.
pub use claude_snapshot::locate_transcript;
```

- [ ] **Step 3: Verify it compiles**

Run:
```bash
cargo check -p freshell-freshagent -p freshell-server
```
Expected: clean (no E0364 — re-exporting a `pub fn` from a `pub(crate)` module is legal).

- [ ] **Step 4: Wire the locator at the single production construction site**

In `crates/freshell-server/src/main.rs`, at the `session_existence` field of the `WsState` literal (~`:570`), the current shape is:

```rust
        session_existence: match &session_index {
            Some(index) => std::sync::Arc::new(existence::IndexExistenceProbe::new(
                std::sync::Arc::clone(index),
                Some(std::sync::Arc::clone(&pane_ledger)),
                session_directory::provider_home()
                    .map(|h| { /* ... provider_roots HashMap ... */ })
                    .unwrap_or_default(),
            )),
            None => std::sync::Arc::new(freshell_ws::existence::NoIndexProbe::default()),
        },
```

Chain the setter onto the `new(...)` call (keep every existing argument and its comments exactly as they are; only wrap):

```rust
            Some(index) => std::sync::Arc::new(
                existence::IndexExistenceProbe::new(
                    std::sync::Arc::clone(index),
                    // (existing ledger arg + comment unchanged)
                    Some(std::sync::Arc::clone(&pane_ledger)),
                    // (existing provider_roots arg + comments unchanged)
                    session_directory::provider_home()
                        .map(|h| { /* ... unchanged ... */ })
                        .unwrap_or_default(),
                )
                // Kata 09v1 zero-turn claude fallback: the SAME raw-file check
                // the attach arm trusts (claude_snapshot ordered candidate
                // roots, CLAUDE_CONFIG_DIR > CLAUDE_HOME > $HOME/.claude), so
                // reconcile and attach can never disagree about whether a
                // claude transcript exists. Degenerate no-roots case (HOME
                // unset etc.): locate_transcript answers None and the probe
                // keeps the pure index answer — identical to pre-fix behavior.
                .with_claude_transcript_locator(std::sync::Arc::new(
                    |session_id: &str| freshell_freshagent::locate_transcript(session_id),
                )),
            ),
```

- [ ] **Step 5: Full Rust gates + rebuild the release binary**

Run:
```bash
cargo fmt
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
cargo build --release -p freshell-server
```
Expected: all clean/PASS; fresh `target/release/freshell-server` (the e2e harness does NOT rebuild a stale binary on its own).

- [ ] **Step 6: The kata's acceptance test goes GREEN — AS-IS, no turn added**

Run:
```bash
npm run test:e2e -- --project=rust-chromium specs/hidden-pane-rebind-rust.spec.ts
```
Expected: **PASS — both tests** (the fresh-agent test that was RED in Task 1 Step 5, and the terminal test which must stay green). This is the kata's acceptance criterion.

- [ ] **Step 7: Commit**

```bash
git add crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/lib.rs crates/freshell-server/src/main.rs
git commit -m "fix(server): wire the attach arm's locate_transcript into the existence probe

Promote claude_snapshot::locate_transcript to pub (narrow crate-root
re-export; the rest of the module stays crate-private) and inject it as
the probe's claude transcript locator at the single construction site.
hidden-pane-rebind-rust.spec.ts 'hidden fresh-agent pane recovers' goes
green AS-IS (zero-turn, no turn added) -- kata 09v1 acceptance."
```

---

### Task 4: Companion e2e — VISIBLE zero-turn freshclaude pane survives abrupt restart

Every other freshclaude-restart e2e sends a turn before restarting (satisfying R10b and masking this bug); the hidden-pane spec was the only zero-turn coverage, which is why the kata was mislabeled as hidden-pane-specific. This task closes the gap with a VISIBLE zero-turn spec. (Its red-proof against the pre-fix binary happens in Task 6 Step 3, after this spec exists and is registered.)

**Files:**
- Create: `test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (two registration points)

**Interfaces:**
- Consumes: `RustServer` (`restartAbrupt()`), `TestHarness`, `openPanePicker`, the fake claude sidecar fixture, and the per-spec helper convention (helpers are COPIED from a donor spec, never imported across specs — see the header of `restore-contract-wall-rust.spec.ts`).
- Produces: a registered rust-only spec that Task 6 runs by path.

- [ ] **Step 1: Create the spec file**

Create `test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts`. Start from the donor `test/e2e-browser/specs/hidden-pane-rebind-rust.spec.ts`: copy VERBATIM its import block and `__dirname`/`FAKE_CLAUDE_SIDECAR_SOURCE` setup (donor lines 49–65) and these per-spec helpers, unchanged: `selectShellIfPickerShowing` (donor :52-62), `waitForWsReady` (:65-72), `seedWallConfig` (:75-97), `bootWall` (:100-114), `findFreshAgentLeaf` (:118-128), `createFreshclaudePane` (:153-182). Do NOT copy `restApiHeaders`/`createTabViaRest`/`revealTab` — this spec never hides the pane, and unused helpers fail lint. Then add this header comment and test body:

```ts
/**
 * FRESHCLAUDE ZERO-TURN RESTART (kata 09v1 regression) -- a VISIBLE
 * freshclaude pane with ZERO turns sent must survive an abrupt server
 * restart (RustServer.restartAbrupt(): SIGKILL + revive on the same
 * home/port/token) and resume in place -- never be adjudicated dead.
 *
 * Why this spec exists: the fake sidecar (like the real claude CLI) creates
 * the transcript file AT SESSION CREATE, before any turn -- a 0-byte .jsonl.
 * That file fails the session index's R10b cwd gate, so pre-fix the
 * reconcile existence probe answered Absent while the attach arm's raw-file
 * check would happily resume it => DeadSession{session_not_on_disk} and the
 * 'Dead sessions' dialog. Every OTHER freshclaude-restart spec sends a turn
 * before restarting (which writes a cwd-bearing line and masks the bug);
 * hidden-pane-rebind-rust.spec.ts covers the HIDDEN zero-turn pane; this
 * spec covers the VISIBLE one. DO NOT add a turn before the restart --
 * zero-turn is the entire point.
 *
 * Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch,
 * because restartAbrupt() exists only on RustServer.
 *
 * Helpers are COPIED from hidden-pane-rebind-rust.spec.ts, not imported,
 * per this suite's per-spec-ownership convention.
 */
```

```ts
test.describe('freshclaude zero-turn restart (kata 09v1)', () => {
  test.setTimeout(180_000)

  test('visible zero-turn freshclaude pane resumes after abrupt restart', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    // Sidecar REQUEST log: the post-restart resume proof reads it.
    const requestLog = path.join(os.tmpdir(), `freshell-e2e-claude-sidecar-${Date.now()}.jsonl`)
    const { server, harness } = await bootWall(page, {
      env: { FRESHELL_CLAUDE_SIDECAR: FAKE_CLAUDE_SIDECAR_SOURCE, FAKE_CLAUDE_SIDECAR_LOG: requestLog },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      // Wait for the boot pane to become a REAL terminal before opening the
      // pane picker (donor guard, hidden-pane-rebind spec).
      await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 30_000 })
      const freshTabId = (await harness.getActiveTabId())!
      await createFreshclaudePane(page, harness, os.tmpdir())
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionId && c?.createRequestId ? true : null
        }, { timeout: 30_000 })
        .not.toBeNull()
      // Wait for the DURABLE identity (sdk.session.init merge writes the
      // canonical UUID to sessionRef.sessionId + resumeSessionId). The fake
      // sidecar mints a RANDOM canonical UUID per process, so gate on the
      // canonical-UUID SHAPE and capture what this run minted.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          return c?.sessionRef?.sessionId ?? c?.resumeSessionId ?? ''
        }, { timeout: 30_000 })
        .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
      const contentBefore = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      const originalDurable = (contentBefore.sessionRef?.sessionId ?? contentBefore.resumeSessionId) as string
      const createRequestIdBefore = contentBefore.createRequestId as string

      // ZERO TURNS, pane stays VISIBLE (no extra tab, no hide): the
      // transcript on disk is the sidecar's create-time 0-byte file --
      // exactly the R10b-excluded shape this regression pins.

      await server.restartAbrupt()
      await waitForWsReady(page)

      // Positive proof (same discriminator as the hidden-pane spec): the
      // sidecar request log must contain a `create` carrying
      // resumeSessionId === originalDurable -- only the restart-parity
      // resume arm emits that, and the initial create carries NO
      // resumeSessionId, so a match is unambiguous post-restart evidence.
      // The parity arm resumes by durable UUID or by the transcript's
      // .jsonl PATH; both carry the durable UUID -- accept either shape.
      await expect
        .poll(async () => {
          const c = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))?.content
          const status = c?.status ?? ''
          const usable = c?.sessionId && ['connected', 'idle', 'running'].includes(status)
          const log = await fs.readFile(requestLog, 'utf-8').catch(() => '')
          const resumed = log
            .split('\n')
            .filter(Boolean)
            .map((l) => JSON.parse(l))
            .some(
              (e) =>
                e.msg?.type === 'create' &&
                typeof e.msg?.resumeSessionId === 'string' &&
                (e.msg.resumeSessionId === originalDurable ||
                  e.msg.resumeSessionId.endsWith(`/${originalDurable}.jsonl`)),
            )
          return usable && resumed ? `resumed:${status}` : null
        }, { timeout: 30_000 })
        .not.toBeNull()

      // Negative proof (the pre-fix failure shape must be gone): the
      // zero-turn session must NOT be adjudicated dead.
      await expect(page.getByRole('dialog', { name: 'Dead sessions' })).toHaveCount(0)
      const state = await harness.getState()
      const deadEntries = state?.panes?.deadSessionAdjudication ?? []
      expect(
        deadEntries.some((e: any) => e?.sessionRef?.sessionId === originalDurable),
        'zero-turn session must not appear in dead-session adjudication',
      ).toBe(false)
      const contentAfter = findFreshAgentLeaf(await harness.getPaneLayout(freshTabId))!.content!
      expect(contentAfter.restoreError?.reason ?? null).not.toBe('durable_artifact_missing')
      // In-place resume: the client's .lost re-create fallback must NOT have
      // fired -- createRequestId stays stable (no duplicate-create storm).
      expect(contentAfter.createRequestId).toBe(createRequestIdBefore)
    } finally {
      await server.stop()
    }
  })
})
```

Notes for the implementer: (a) if TypeScript complains about the `contentBefore`/`contentAfter` property accesses, mirror the donor spec's typing exactly — it performs the same accesses on the same `findFreshAgentLeaf(...)!.content!` value; (b) the `expect(..., message)` two-arg form — if the installed Playwright version rejects a message on a boolean `expect`, drop the message argument; (c) keep ESM `.js` extensions on the helper imports exactly as in the donor.

- [ ] **Step 2: Register the spec in BOTH config lists**

In `test/e2e-browser/playwright.config.ts`:

2a. Add to the `RUST_ONLY_SPECS` array (~`:81-155`), mirroring the existing hidden-pane entry's comment style:

```ts
  // Freshclaude zero-turn restart (kata 09v1): imports RustServer directly
  // for restartAbrupt(); a VISIBLE zero-turn pane must resume, never die.
  /freshclaude-zero-turn-restart-rust\.spec\.ts$/,
```

2b. Add to the `rust-chromium` project's `testMatch` array (~`:208-337`) an entry in the SAME format as the existing `hidden-pane-rebind-rust.spec.ts` entry there (copy that line, substitute the new filename).

- [ ] **Step 3: Run the new spec — GREEN on the fixed binary**

Run:
```bash
npm run test:e2e -- --project=rust-chromium specs/freshclaude-zero-turn-restart-rust.spec.ts
```
Expected: PASS (Task 3's fixed release binary is current). Also verify project routing did not leak: `npm run test:e2e -- --list --project=chromium 2>/dev/null | grep -c zero-turn-restart` should print `0` (the match-all projects must ignore a rust-only spec).

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/freshclaude-zero-turn-restart-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): visible zero-turn freshclaude pane survives abrupt restart (kata 09v1)

Closes the coverage gap that mislabeled 09v1 as hidden-pane-specific:
every other freshclaude-restart spec sends a turn first (writing a
cwd-bearing transcript line and masking the R10b exclusion). This spec
keeps the pane visible, sends zero turns, SIGKILL-restarts, and asserts
in-place resume + no Dead-sessions dialog + stable createRequestId."
```

---

### Task 5: Module docs — record the claude asymmetry so nobody re-extends "acceptable either way"

**Files:**
- Modify: `crates/freshell-ws/src/reconcile_freshagent.rs` (module doc only, `:8-18`)

**Interfaces:**
- Consumes: the shipped fix (Tasks 2–3) — the doc describes real behavior, so it must land after the behavior.
- Produces: nothing programmatic; doc-only.

- [ ] **Step 1: Add the claude bullet and update the WATCH bullet**

In the module doc of `crates/freshell-ws/src/reconcile_freshagent.rs`, after the existing zero-turn-codex bullet (the one ending "zero turns means there is no conversation content to lose."), insert:

```rust
//! - Zero-turn CLAUDE sessions are the OPPOSITE asymmetry (kata 09v1): the
//!   claude CLI creates the transcript file at session-create time, BEFORE
//!   any turn (0 bytes), and `claude --resume <uuid>` works on it — the
//!   attach arm (freshell-freshagent claude_snapshot.rs) depends on exactly
//!   that. But a 0-byte transcript has no cwd-bearing line, so the directory
//!   index's R10b gate excludes it and the warm index answers Absent. The
//!   IndexExistenceProbe (freshell-server existence.rs) therefore falls back
//!   to the attach arm's raw-file check (locate_transcript) before finalizing
//!   Absent for claude ⇒ Present ⇒ OnDisk ⇒ respawn, never dead_session.
//!   Do NOT re-extend the codex "acceptable either way" reasoning to claude:
//!   for claude the file exists and the session IS resumable, so dead_session
//!   would be a false positive, not a harmless no-content verdict.
```

And replace the final WATCH bullet — currently:

```rust
//! - WATCH: CLAUDE_CONFIG_DIR/CLAUDE_HOME reader/writer split (pre-existing
//!   wave-A exposure, out of scope this lane).
```

with:

```rust
//! - WATCH (narrowed by kata 09v1): CLAUDE_CONFIG_DIR/CLAUDE_HOME
//!   reader/writer split — the existence probe's claude Absent-fallback now
//!   reads the attach arm's FULL ordered candidate-root set
//!   (CLAUDE_CONFIG_DIR > CLAUDE_HOME > $HOME/.claude via
//!   locate_transcript), so RECONCILE verdicts no longer depend on the
//!   single-root index walk for file existence. The History index walk
//!   itself still reads one root; that residual listing exposure remains.
```

- [ ] **Step 2: Verify the doc-only change builds and lints**

Run:
```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test -p freshell-ws
```
Expected: all clean/PASS (comment-only change; tests unaffected).

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-ws/src/reconcile_freshagent.rs
git commit -m "docs(reconcile): record the claude zero-turn asymmetry next to the codex reasoning

The module doc explained zero-turn acceptability with codex-only
reasoning (no rollout file until first persisted turn -- 'acceptable
either way'). Claude is the opposite: the transcript exists pre-turn by
design and the attach arm depends on it, so a dead_session there is a
false positive. Also narrow the CLAUDE_CONFIG_DIR WATCH: the existence
probe's fallback now reads the attach arm's full candidate-root set."
```

---

### Task 6: Full gates, wall, red-proof of the companion spec, push

**Files:**
- No source changes expected. Consumes `/tmp/freshell-09v1-prefix-server` (Task 1 Step 4).

**Interfaces:**
- Consumes: everything above, committed.
- Produces: a pushed branch `fix/zero-turn-claude-existence` with all gates green. NO PR.

- [ ] **Step 1: Rust gates**

Run:
```bash
cargo fmt --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```
Expected: all clean/PASS.

- [ ] **Step 2: Coordinated node suites**

Run (`npm run test:status` first; if the coordinator gate is held by another agent, WAIT):
```bash
FRESHELL_TEST_SUMMARY="kata 09v1 zero-turn-claude-existence final gates" env -u FRESHELL_BIND_HOST npm test
npm run test:port
```
Expected: PASS on both.

- [ ] **Step 3: Red-proof the companion spec against the frozen pre-fix binary**

The companion spec must be shown to catch the bug it pins. Run it once against Task 1's saved pre-fix binary (the `FRESHELL_E2E_RUST_SERVER_BIN` override fails closed if the path is not an executable file):

```bash
FRESHELL_E2E_RUST_SERVER_BIN=/tmp/freshell-09v1-prefix-server \
  npm run test:e2e -- --project=rust-chromium specs/freshclaude-zero-turn-restart-rust.spec.ts
```
Expected: **FAIL** (pre-fix server adjudicates the zero-turn session dead — the resumed-poll times out and/or the Dead-sessions dialog assertion trips). Record the failure output in the task report. If it unexpectedly PASSES, the spec is not pinning the bug — STOP and fix the spec (compare against the hidden-pane spec's discriminators) before proceeding.

Then confirm GREEN on the real (fixed) binary:
```bash
cargo build --release -p freshell-server
npm run test:e2e -- --project=rust-chromium specs/freshclaude-zero-turn-restart-rust.spec.ts
```
Expected: PASS.

- [ ] **Step 4: The three headline e2e specs on the fixed release build**

Run:
```bash
npm run test:e2e -- --project=rust-chromium specs/hidden-pane-rebind-rust.spec.ts specs/freshclaude-zero-turn-restart-rust.spec.ts specs/freshclaude-restart-parity-rust.spec.ts
```
Expected: ALL PASS (hidden-pane: 2 tests; zero-turn: 1; parity: 2 — the parity specs send a turn first and exercise the index-hit path, proving the fallback didn't disturb the with-turn flow).

- [ ] **Step 5: The restore-contract-wall stays honest**

Run:
```bash
npm run test:e2e -- --project=rust-chromium specs/restore-contract-wall-rust.spec.ts
```
Expected: suite exits GREEN with **15 passing tests and 3 `test.fail()` pins reported as expected failures** (pins at ~`:1500` P0.1 composed ruler, ~`:1825` P1.8+P1.9 pane-created-<5s, ~`:1949` P1.8 locator-window). **No pin flip is expected from this fix.** Playwright turns an unexpected PASS of a pinned test into a hard failure — if that happens, do NOT delete the pin and do NOT celebrate: investigate WHY this change flipped it (re-run the leg 3x; read the pin's comment block for its flip discipline) and report findings before touching the pin.

- [ ] **Step 6: Push the branch and STOP (no PR)**

Run:
```bash
git log --oneline origin/main..HEAD
git push -u origin fix/zero-turn-claude-existence
```
Expected: the plan commit plus the four task commits (Tasks 2, 3, 4, 5); push succeeds. Do NOT run `gh pr create` or any equivalent — landing happens outside this workflow with the final review verdict.

- [ ] **Step 7: Cleanup**

```bash
rm -f /tmp/freshell-09v1-prefix-server
```
(Leave the read-only investigation artifacts — `/tmp/09v1-*`, `/tmp/freshell-e2e-rust-NaUAAO/`, `.worktrees/debug-09v1` — untouched; they are not this branch's to delete.)

---

## Spec-coverage map (self-review record)

| Spec requirement | Covering task |
|---|---|
| Two arms agree: warm-index `Absent` for claude falls back to the attach arm's raw-file check before finalizing (preferred fix shape) | Tasks 2–3 |
| R10b NOT weakened (History keeps real metadata) | Task 2 (fallback lives in the probe; `parse_claude_file` untouched — constraint restated in Global Constraints) |
| Codex untouched ("acceptable either way" stays correct FOR CODEX) | Task 2 (provider gate + `codex_absent_never_consults_the_claude_locator`) |
| kilroy covered | kilroy is a sessionType mapping to provider `"claude"` (verified: `claude.rs:66`, `snapshot.rs:133`) — the claude-scoped fallback covers it with no extra code |
| Alternative fix shapes evaluated in plan | Architecture section (two-probe-methods split rejected with reasons; injected-closure chosen over direct call for testability, with in-repo precedent) |
| Crate-dependency direction checked; injection-at-wiring if unclean | File Structure note (server→freshagent dep already exists; closure injection kept anyway for testability, precedent `codex_rollout_locator`) |
| Module doc claude-asymmetry bullet | Task 5 |
| Test (1) unit: zero-turn (0-byte + ever_bound) ⇒ respawn never dead_session; true positive stays | Task 2 (probe-level: `zero_turn_..._is_present_not_absent`, `fallback_present_feeds_ever_observed`, `genuinely_missing_..._stays_absent...`; the presence→verdict legs stay pinned by existing `on_disk_maps_to_respawn`, `gone_observed_maps_to_dead_session_not_on_disk`, `row4_absent_but_ever_observed_yields_dead_session`, `ever_observed_survives_a_restart_via_the_ledger` — all rerun in `cargo test --workspace`; end-to-end chain proven by the e2e specs) |
| Test (2) acceptance e2e AS-IS goes green | Task 1 (RED baseline) + Task 3 Step 6 (GREEN) |
| Test (3) NEW visible zero-turn companion e2e | Task 4 (+ Task 6 Step 3 red-proof against the frozen pre-fix binary) |
| Test (4) wall: 15 pass / 3 pins fail-as-expected; investigate any flip | Task 6 Step 5 |
| Repo rules: base green first, coordinator WAIT, ephemeral ports, no 3001/3002, no server restart, no broad kills, gates, push-no-PR | Task 1 Steps 1–3, Global Constraints, Task 6 |
| No stubs/mocks standing in for required behavior | The fake claude sidecar is the suite's ESTABLISHED provider seam (used by the acceptance spec and the wall itself); it reproduces the real CLI's create-time transcript behavior, which is the load-bearing precondition. The Rust-side fake locator closures test the probe's own logic; the REAL `locate_transcript` wiring is exercised end-to-end by Tasks 3/4/6 e2e against the release binary. No requirement is deferred. |
