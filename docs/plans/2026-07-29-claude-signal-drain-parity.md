# Claude Signal Drain Parity Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Rework the claude signal lane's drain from destructive delete-on-read to act-then-delete with explicit disposition (opencode parity), so a second freshell instance sharing `$HOME` can no longer destroy signals belonging to another instance's panes — plus claude-lane hygiene parity (stale/`.tmp` reaping, reject/refusal logging) and a test pinning that fresh claude panes bind at spawn independently of signals.

**Architecture:** All consumption-semantics changes are confined to `crates/freshell-ws/src/claude_signal.rs`, structurally copying the opencode lane's proven pattern (`opencode_signal.rs`): `drain()` becomes non-destructive for valid signals (reaping only stale files and warn-consuming malformed ones), a private `SignalDisposition { Acted, Retain, Discard }` enum drives per-signal file fate in the consumer loop, and unknown-terminal signals are retained on disk bounded by the existing `STALE_SIGNAL_MAX_AGE` TTL (reused from `opencode_signal.rs` — the one small shared abstraction; the codebase explicitly prefers structural duplication over a generic `SignalLane<P>`, per `opencode_signal.rs:9-10`). Rebind POLICY (guard chain, D7/one-writer, ledger supersede, A7/A13, pinned fan-out order) is unchanged — only file-consumption semantics change.

**Tech Stack:** Rust (tokio, tracing, serde_json, tempfile for tests), cargo workspace. No JS/TS changes. No contract (`port/contract`) changes.

## Findings (P2 answer — the first-bind question, resolved from code)

**Claude initial binding for fresh panes does NOT depend on signal consumption.** The chain, all completed before the `terminal.created` frame is answered:

- `crates/freshell-ws/src/terminal.rs:1621,1645-1650` — `should_preallocate_fresh_claude` → `resume_session_id = Some(Uuid::new_v4())` at spawn (passed as `--session-id`).
- `terminal.rs:2403` — `state.identity.upsert(terminal_id, "claude", <uuid>, cwd, now)` seeds the identity row.
- `terminal.rs:2435` — `pane_ledger.record_binding(...)` awaited (durable-before-answer).
- `terminal.rs:2533` — `terminal.created`'s `session_ref` reads that identity back.

The signal lane is **rebind-only**: `claude_signal.rs` no-ops on the startup signal (same-id A7 guard) because `session_id` equals the preallocated id. Existing tests already pin spawn-time binding (`crates/freshell-ws/tests/session_identity_frames.rs:113` `fresh_claude_create_frames_carry_preallocated_session_ref`; `crates/freshell-ws/tests/pane_ledger_triggers.rs:63` `claude_preallocation_writes_a_binding_row_synchronously`) — but **no test pins that the binding survives when every signal file is destroyed by an external actor**. Task 4 adds that pinning test (the correct behavior needs pinning, not fixing). The drill's `sessionRef: None` observations trace to signal destruction hiding *rebinds* (fixed by Tasks 1–3) and to pane-creation paths outside the WS fresh-create flow (REST/fresh-agent panes, documented as identity-less by design at `terminal.rs:3646-3651`) — the latter is a rebind-policy matter explicitly out of this spec's scope ("this changes only consumption semantics, not rebind policy").

## Disposition mapping (P1 design, mirroring `opencode_signal.rs:445-534`)

| Situation | Disposition | File fate |
|---|---|---|
| No identity row AND no registry row (terminal unknown to this instance — e.g. another instance's pane) | `Retain` | kept on disk; TTL-reaped after `STALE_SIGNAL_MAX_AGE` |
| No identity row; registry row exists but `mode != "claude"` | `Discard` + `claude_signal_ignored` warn | deleted |
| No identity row; registry row IS claude (identity row hasn't landed yet — create race) | `Retain` | kept |
| Identity row with foreign provider | `Discard` + `claude_signal_ignored` warn | deleted |
| Identity row retired | `Acted` (policy unchanged: no retired-pane rebind for claude — deliberate refusal, consumed) | deleted |
| Same-id no-op (A7: startup/compact) | `Acted` (silent — hot path) | deleted |
| Guard refusals (A13 / bound-elsewhere / freshagent D7 / ledger fresh-agent) | `Acted` (existing warns kept; ledger fresh-agent gains a warn) | deleted |
| Successful rebind | `Acted` | deleted |
| Malformed `.json` | warn `claude_signal_rejected` + delete (in `drain()`) | deleted |
| Stale `.json` or orphaned `.tmp` older than TTL | reaped silently (in `drain()`) | deleted |

**Warn-once rationale (P3):** every warning arm above deletes its file in the same pass, so noise is bounded per emitted signal — the same "once-per-file consume" bounding idiom the opencode lane uses for `opencode_signal_ignored`/`opencode_signal_rejected` (`opencode_signal.rs:453-461, 477-485, 180-186`; its own ledger fresh-agent arm is silent, so adding a bounded warn on claude's exceeds sibling parity). The `Retain` arm is deliberately **silent** (mirroring `opencode_signal.rs:450-452`): it re-evaluates every 1s sweep, so any log there would spam; the TTL bounds its lifetime. No `HashSet` tracker is needed — deletion is the bound. Claude has no hello/heartbeat channel (the hook has no plugin-load analogue, documented at `cli_launch.rs:206-217`), so `HelloTracker` does not apply.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/claude-signal-drain-parity`, branch `fix/claude-signal-drain-parity`, based on `origin/main` @ `90c027a4`. Do all work there.
- Red-green-refactor TDD; frequent, focused commits. **Do NOT create a PR — stop after pushing the branch.**
- **NEVER touch the production Rust server on port 3002.** Production is RUNNING the destructive drain right now and sweeps `~/.freshell/session-signals/claude/` every ~1s: **all tests MUST use isolated temp signal directories** (`tempfile::tempdir()` in unit tests, or the integration harness's existing pid-scoped `std::env::temp_dir()` subdirs — both isolated — passed to `ClaudeSignalWatcher::new`), never `default_root()`/the real `$HOME` path — or production will eat test fixtures and tests could eat production's signals.
- Do not regress: #573 salvage-hardening, #574 codex self-healing, #575 polish (deterministic drain ordering, `SignalDisposition` semantics, portable nonce, warn-once fork-ambiguity), hello/HelloTracker semantics, one-writer invariant, A13, D7/D8, "when unsure do nothing".
- Consumption semantics only — rebind policy (guard chain, no first-bind-via-signal, no retired-pane ref move for claude) is unchanged.
- Hook command strings (`CLAUDE_SESSION_START_COMMAND_UNIX`/`_WINDOWS`, `cli_launch.rs:222,230`) are byte-pinned by goldens (`cli_launch_goldens.rs`) — do NOT modify them; `.tmp` cleanup is consumer-side (mirroring `opencode_signal.rs:146-157`).
- Verification gates (run from the worktree root): `test -d node_modules || npm ci --no-audit --no-fund` (cargo tests depend on it); `cargo fmt --all -- --check`; `cargo clippy --workspace --all-targets -- -D warnings`; `cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings`; `cargo test --workspace`; coordinated JS via `npm run check` (never bare vitest); contract freeze via `npm run contract:generate && git diff --exit-code -- port/contract`. Prefix broad test runs with `FRESHELL_TEST_SUMMARY="<reason>"`.
- `docs/plans/` docs are working/agent docs; README.md remains the only end-user markdown doc — do not add other end-user docs.
- **npm-ci precondition (validated):** the `freshell-ws` INTEGRATION tests (e.g. `claude_session_rebind`, `opencode_switch_rebind`) hard-require installed npm deps: pane creation runs MCP injection, which resolves `node_modules/tsx/dist/loader.mjs` from the repo root at runtime (`mcp_inject.rs:110-139`); when it is absent the server replies with a create error and the test fails as `timed out waiting for a terminal.created frame` (common/mod.rs:934) after ~5s. If you see that signature, it is the missing `npm ci`, NOT your change. `cargo test -p freshell-ws --lib` does not need node_modules.

## File Structure

- **Modify: `crates/freshell-ws/src/claude_signal.rs`** (340 lines today; the whole lane — watcher, drain, guard ladder, unit tests — lives here, matching the opencode lane's single-module shape). All Rust production changes land in this one file. It gains: stale-file/`.tmp` reaping and reject-warn in `drain()` (Task 1); `path` on `ClaudeSignal`, the `SignalDisposition` enum, `apply_claude_signal`, and the act-then-delete consumer loop (Task 2); new/updated unit tests (Tasks 1–2).
- **Modify: `crates/freshell-ws/tests/claude_session_rebind.rs`** (600 lines; the lane's integration test, one multi-phase `#[tokio::test]`). Gains Phase 5 (multi-instance retention + TTL reap, Task 3) and Phase 6 (signal-independent first-bind, Task 4), plus comment updates where old assertions described delete-on-read.
- **Read-only reference: `crates/freshell-ws/src/opencode_signal.rs`** — the pattern source; the only change there is none (its `STALE_SIGNAL_MAX_AGE` at `:40` is already `pub(crate)` and is referenced from `claude_signal.rs`, same crate).
- No new files; no writer/hook changes; no protocol/contract changes.

---

### Task 1: Drain hygiene — stale-signal reap, orphaned-`.tmp` reap, reject warn

Bounded-junk parity in `drain()` while keeping today's delete-on-read for valid files (that flips in Task 2 — this task stays green everywhere). Ports `opencode_signal.rs:136-190`'s reap arms and reject warn.

**Files:**
- Modify: `crates/freshell-ws/src/claude_signal.rs` (the `drain()` body at `:81-105` and the `mod tests` block at `:259-340`)

**Interfaces:**
- Consumes: `crate::opencode_signal::STALE_SIGNAL_MAX_AGE` (`pub(crate) const … = Duration::from_secs(600)`, `opencode_signal.rs:40`); `crate::invariants::capture::capture() -> (Arc<Mutex<Vec<CapturedEvent>>>, tracing::subscriber::DefaultGuard)` (`#[cfg(test)] pub(crate)`, `invariants.rs:203` — in-module tests only); `CapturedEvent { message, .. }`.
- Produces: `ClaudeSignalWatcher::drain(&self) -> Vec<ClaudeSignal>` (signature unchanged) now reaps stale `.json`/`.tmp` and warn-logs `claude_signal_rejected` on malformed files. Task 2 builds on this exact body.

- [ ] **Step 1: Write the failing unit tests**

Add to the existing `mod tests` in `crates/freshell-ws/src/claude_signal.rs` (alongside the two existing tests). New helpers use `tempfile::tempdir()` (already a `freshell-ws` dev-dependency — the opencode tests use it):

```rust
    fn write_file(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join(name), body).unwrap();
    }

    /// Backdate a file's mtime past the retention cap (mirrors
    /// opencode_signal.rs::drain_reaps_stale_files_without_emitting).
    fn backdate_past_ttl(path: &std::path::Path) {
        let stale = std::time::SystemTime::now()
            - crate::opencode_signal::STALE_SIGNAL_MAX_AGE
            - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
    }

    #[test]
    fn drain_reaps_stale_files_without_emitting() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "t1__0000000000000000001-1.json",
            r#"{"session_id":"old-id","source":"resume"}"#,
        );
        let path = dir.path().join("t1__0000000000000000001-1.json");
        backdate_past_ttl(&path);
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert!(signals.is_empty(), "stale signals must be reaped, not emitted");
        assert!(!path.exists(), "stale signal file must be deleted (retention cap)");
    }

    #[test]
    fn drain_reaps_stale_tmp_staging_files_but_keeps_fresh_ones() {
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "t1__0000000000000000001-1.tmp", "partial write");
        write_file(dir.path(), "t2__0000000000000000002-1.tmp", "in flight");
        backdate_past_ttl(&dir.path().join("t1__0000000000000000001-1.tmp"));
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert!(signals.is_empty());
        assert!(
            !dir.path().join("t1__0000000000000000001-1.tmp").exists(),
            "orphaned .tmp (writer died before rename) must be reaped on the TTL"
        );
        assert!(
            dir.path().join("t2__0000000000000000002-1.tmp").exists(),
            "fresh in-flight .tmp must be left alone"
        );
    }

    #[test]
    fn drain_on_missing_directory_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let watcher = ClaudeSignalWatcher::new(dir.path().join("never-created"));
        assert!(watcher.drain().is_empty(), "missing root: empty drain, no panic");
    }

    #[test]
    fn drain_warns_on_rejected_files() {
        let (events, _guard) = crate::invariants::capture::capture();
        let dir = tempfile::tempdir().unwrap();
        write_file(dir.path(), "junk__1.json", "not json");
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert!(signals.is_empty());
        assert!(
            !dir.path().join("junk__1.json").exists(),
            "malformed files stay single-shot (consumed)"
        );
        let events = events.lock().unwrap();
        assert!(
            events
                .iter()
                .any(|e| e.message.contains("claude_signal_rejected")),
            "parse rejects must be warn-logged for detectability (A8)"
        );
    }
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/claude-signal-drain-parity && test -d node_modules || npm ci --no-audit --no-fund; cargo test -p freshell-ws --lib claude_signal`

Expected: FAIL — `drain_reaps_stale_files_without_emitting` and `drain_warns_on_rejected_files` fail (stale file is *emitted* and no warn is logged), `drain_reaps_stale_tmp_staging_files_but_keeps_fresh_ones` fails (orphaned `.tmp` still exists). `drain_on_missing_directory_is_empty` may already pass (the early return exists — it was just untested). The two pre-existing tests still pass.

- [ ] **Step 3: Implement the reap arms and reject warn in `drain()`**

Replace the body of `ClaudeSignalWatcher::drain` (`claude_signal.rs:81-105`) with (delete-on-read for valid files is deliberately KEPT in this task):

```rust
    pub fn drain(&self) -> Vec<ClaudeSignal> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new(); // no dir yet: no claude pane has ever signaled
        };
        let mut paths: Vec<std::path::PathBuf> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            match path.extension().and_then(|e| e.to_str()) {
                Some("json") => paths.push(path),
                Some("tmp") => {
                    // Orphaned atomic-write staging (hook died before the
                    // rename): reap on the shared TTL so junk stays bounded
                    // (mirrors opencode_signal.rs:146-157).
                    let stale = std::fs::metadata(&path)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age > crate::opencode_signal::STALE_SIGNAL_MAX_AGE);
                    if stale {
                        let _ = std::fs::remove_file(&path);
                    }
                }
                _ => {}
            }
        }
        // Deterministic last-write-wins (#575): timestamp-first, width-stable
        // producer nonces make a filename sort emission order.
        paths.sort();
        let mut signals = Vec::new();
        for path in paths {
            let stale = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > crate::opencode_signal::STALE_SIGNAL_MAX_AGE);
            if stale {
                let _ = std::fs::remove_file(&path); // retention cap (D1.1)
                continue;
            }
            match parse_signal_file(&path) {
                Some(sig) => {
                    signals.push(sig);
                    let _ = std::fs::remove_file(&path);
                }
                None => {
                    // A silently-never-firing lane is the failure mode to
                    // avoid (A8 detectability): log rejects before consuming.
                    tracing::warn!(path = %path.display(),
                        "claude_signal_rejected: bad terminal id or session_id, consuming file");
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        signals
    }
```

Also update `drain()`'s doc comment (`claude_signal.rs:68-80`): replace the sentence "In-flight `*.tmp` files (the hook's atomic write staging) are left alone." with "Fresh `*.tmp` staging files are ignored; stale ones (orphaned by a dead hook) are reaped on `STALE_SIGNAL_MAX_AGE`, as are unconsumed `*.json` files older than the same TTL. Malformed files are warn-logged (`claude_signal_rejected`) and deleted." Keep the rest of the comment (nonce/sort rationale) intact.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-ws --lib claude_signal`

Expected: PASS — all 6 unit tests (2 pre-existing + 4 new).

- [ ] **Step 5: Run the lane's integration test (must stay green — semantics unchanged for fresh valid files)**

Run: `cargo test -p freshell-ws --test claude_session_rebind`

Expected: PASS (1 test).

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/claude_signal.rs
git commit -m "fix(claude-signal): reap stale signals and orphaned .tmp staging, warn on rejects"
```

---

### Task 2: Act-then-delete with explicit `SignalDisposition` (the core P1 fix)

`drain()` stops deleting valid files; `ClaudeSignal` carries its `path`; a new module-private `apply_claude_signal` returns `SignalDisposition`; the consumer loop deletes only `Acted`/`Discard` files. Unknown-terminal signals are **retained** — the multi-instance hazard is closed. Foreign-provider signals get `Discard` + warn; the pane-ledger fresh-agent refusal gains a warn (P3). Guard set, guard order, and fan-out order are byte-identical to today, with one validated nuance: today's COMBINED `retired || provider != "claude"` guard (`claude_signal.rs:160-162`) is split into the disposition table's two arms (foreign-provider Discard+warn, then retired Acted) — behavior-preserving for file fate, except a retired+foreign-provider pane now emits the `claude_signal_ignored` warn where it was silent before. That is deliberate (detectability); reviewers should not flag it as drift.

**Files:**
- Modify: `crates/freshell-ws/src/claude_signal.rs` (module `//!` header `:1-14`, `ClaudeSignal` struct `:35-41`, `drain()` valid-file arm, `parse_signal_file` `:110-130`, `drain_and_rebind_claude` `:139-244`, unit tests)
- Modify: `crates/freshell-ws/tests/claude_session_rebind.rs` (two assertion-message/comment updates only — Phase 3's "single-shot" wording and Phase 4's delete-on-read wording; the assertions themselves still hold because refusals map to `Acted` ⇒ deleted)

**Interfaces:**
- Consumes: everything the current guard ladder already calls (`state.identity.get/upsert/find_by_session_including_retired`, `state.registry.live_session_owner/set_meta`, `state.fresh_claude.has_live_session(&str) -> bool` (async), `state.pane_ledger.lookup_by_session`, `crate::pane_ledger::ledger_resolve_identity(...).await`, `crate::codex_identity::broadcast_terminal_session_associated(...)`, `crate::terminal::now_ms()`), plus **one new collaborator**: `state.registry.probe(&str) -> Option<IdentityProbeRow>` (`crates/freshell-terminal/src/registry.rs:1833`; fields `mode: String`, `status`, `resume_session_id`, `cwd`, … — exactly how `apply_opencode_signal` uses it at `opencode_signal.rs:450`).
- Produces (used by Tasks 3–4): `pub struct ClaudeSignal { pub terminal_id: String, pub session_id: String, pub source: Option<String>, pub path: std::path::PathBuf }`; `pub fn ClaudeSignalWatcher::drain(&self) -> Vec<ClaudeSignal>` now **retains** valid files on disk; `pub async fn drain_and_rebind_claude(state: &WsState, watcher: &ClaudeSignalWatcher)` (signature unchanged) applies dispositions and deletes acted/discarded files. New log lines: `claude_signal_ignored: pane belongs to another provider, consuming file`, `claude_signal_ignored: identity row belongs to another provider, consuming file`, `claude_rebind_refused: ledger_fresh_agent_session`.

- [ ] **Step 1: Write the failing unit tests**

In `claude_signal.rs`'s `mod tests`, REPLACE `drain_parses_and_deletes_signal_files` (`:263-288`) with the retention version, and adjust the tail of `drain_returns_signals_sorted_by_filename_oldest_first` (`:290-339`):

```rust
    #[test]
    fn drain_parses_retains_valid_files_and_consumes_rejects() {
        let dir = tempfile::tempdir().unwrap();
        write_file(
            dir.path(),
            "term-a__0000000000000000001-1.json",
            r#"{"session_id":"new-id","source":"resume","cwd":"/tmp/x","hook_event_name":"SessionStart"}"#,
        );
        write_file(dir.path(), "junk__1.json", "not json");
        let watcher = ClaudeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].terminal_id, "term-a");
        assert_eq!(signals[0].session_id, "new-id");
        assert_eq!(signals[0].source.as_deref(), Some("resume"));
        assert_eq!(
            signals[0].path,
            dir.path().join("term-a__0000000000000000001-1.json")
        );
        assert!(
            signals[0].path.exists(),
            "drain must NOT delete valid signal files: act-then-delete is the \
             consumer's job (D1.1) -- a second instance sharing $HOME must not \
             destroy signals it cannot act on"
        );
        assert!(
            !dir.path().join("junk__1.json").exists(),
            "malformed files stay single-shot (consumed)"
        );
        // Retention is stable: a second drain sees the same signal again.
        assert_eq!(watcher.drain().len(), 1, "retained file re-emitted next sweep");
    }
```

In `drain_returns_signals_sorted_by_filename_oldest_first`, replace the final `read_dir(...).count() == 0` assertion (message "Existing delete-on-read semantics are unchanged") with:

```rust
        assert_eq!(
            std::fs::read_dir(dir.path()).unwrap().count(),
            6,
            "valid signals are RETAINED by drain (act-then-delete)"
        );
```

(and delete that dir's files at test end only if the test's temp dir isn't auto-cleaned — `tempfile::tempdir()` auto-cleans, so if this test still uses the hand-rolled `std::env::temp_dir()` dir, migrate it to `tempfile::tempdir()` in this step, mirroring the Task 1 helpers.)

- [ ] **Step 2: Run to verify red**

Run: `cargo test -p freshell-ws --lib claude_signal`

Expected: FAIL — compile error first (`ClaudeSignal` has no `path` field); after fixture compile-fixes, the retention assertions fail (files deleted by drain).

- [ ] **Step 3: Implement — struct, drain retention, disposition enum, ladder, consumer**

3a. Add `path` to the struct (`claude_signal.rs:35-41`):

```rust
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSignal {
    pub terminal_id: String,
    pub session_id: String,
    pub source: Option<String>,
    /// The backing file, retained by `drain()` -- the consumer deletes it
    /// only after acting on or explicitly discarding the signal (D1.1).
    pub path: std::path::PathBuf,
}
```

3b. In `parse_signal_file`, add `path: path.to_path_buf(),` to the `Some(ClaudeSignal { ... })` constructor.

3c. In `drain()`'s valid arm (from Task 1), remove the delete — the arm becomes:

```rust
                // Retained: consumer act-then-deletes (D1.1).
                Some(sig) => signals.push(sig),
```

3d. Add the disposition enum (module-private, above the tests, mirroring `opencode_signal.rs:431-441`):

```rust
/// Outcome of applying one signal: `Acted` (rebind done, same-id no-op, or
/// deliberate guard refusal), `Retain` (might become actionable later, or
/// belongs to another freshell instance sharing $HOME -- keep the file for
/// the next sweep; STALE_SIGNAL_MAX_AGE bounds orphans), `Discard`
/// (permanently unactionable -- consume the file so it neither accumulates
/// nor re-logs; deleting a signal degrades only to no-rebind).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SignalDisposition {
    Acted,
    Retain,
    Discard,
}
```

3e. Extract the entire per-signal body of `drain_and_rebind_claude`'s `for sig in signals` loop (`:155-243`) into a new function, converting each `continue` into an explicit disposition. The guard code, log strings, and fan-out are today's code verbatim except where marked `// NEW`:

```rust
/// One signal through the guard ladder. Returns the file's disposition:
/// `Acted` and `Discard` delete the file; `Retain` keeps it for a later
/// sweep. Mirrors opencode_signal.rs::apply_opencode_signal -- CONSUMPTION
/// semantics only: claude rebind POLICY (no first-bind via signal, no
/// retired-pane ref move) is deliberately unchanged.
async fn apply_claude_signal(state: &WsState, sig: &ClaudeSignal) -> SignalDisposition {
    // Registry row: must be a live claude pane.
    let Some(current) = state.identity.get(&sig.terminal_id) else {
        // NEW: no identity row. Fresh claude panes seed their identity row
        // synchronously at create (terminal.rs preallocation), so this is
        // either a pane belonging to ANOTHER freshell instance sharing
        // $HOME (retain so the owner can consume it) or a transient create
        // race (retain until the row lands). Foreign-provider registry rows
        // are permanently unactionable: discard with a log.
        let Some(entry) = state.registry.probe(&sig.terminal_id) else {
            return SignalDisposition::Retain; // unknown terminal: not ours (yet)
        };
        if entry.mode != "claude" {
            tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
                mode = %entry.mode, source = ?sig.source,
                "claude_signal_ignored: pane belongs to another provider, consuming file");
            return SignalDisposition::Discard;
        }
        return SignalDisposition::Retain; // claude pane whose identity row hasn't landed yet
    };
    if current.provider.as_deref() != Some("claude") {
        // NEW: foreign-provider identity row -- never touch the pane
        // (one-writer / D7) and never actionable (a pane's provider does
        // not change), so consume instead of silently re-reading it.
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            provider = ?current.provider, source = ?sig.source,
            "claude_signal_ignored: identity row belongs to another provider, consuming file");
        return SignalDisposition::Discard;
    }
    if current.retired {
        // Policy unchanged: no retired-pane rebind for claude. A deliberate
        // refusal counts as acted on (consume -- bounded noise).
        return SignalDisposition::Acted;
    }
    if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
        // Load-bearing no-op (A7): SessionStart also fires on `startup`
        // and on EVERY compaction (`compact`) with session_id == bound
        // id -- one signal file per compaction. Same-id signals must
        // stay silent no-ops; keep this guard.
        return SignalDisposition::Acted;
    }
    // A13: the claimed id must have no live owner.
    if let Some(owner) =
        state
            .registry
            .live_session_owner(Some(&state.identity), "claude", &sig.session_id)
    {
        tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
            "claude_rebind_refused: target session already live-owned (A13)");
        return SignalDisposition::Acted;
    }
    // Ledger A8 (retired-inclusive) + freshclaude guard, mirroring codex
    // Guard A/C semantics.
    if let Some(existing) = state
        .identity
        .find_by_session_including_retired("claude", &sig.session_id)
    {
        if existing != sig.terminal_id {
            tracing::warn!(terminal_id = %sig.terminal_id,
                "claude_rebind_refused: session_bound_elsewhere");
            return SignalDisposition::Acted;
        }
    }
    // Cross-kind (D7): a LIVE freshclaude sidecar owning this session is
    // just as much "the one writer on S's JSONL" as a live PTY. The
    // durable ledger guard below is blind to a sidecar whose row hasn't
    // landed yet. Mirrors codex_claim_refused (codex_identity.rs:159).
    if state.fresh_claude.has_live_session(&sig.session_id).await {
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            "claude_rebind_refused: freshagent_live_session");
        return SignalDisposition::Acted;
    }
    if state
        .pane_ledger
        .lookup_by_session("claude", &sig.session_id)
        .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
    {
        // NEW (was a bare continue): warn for detectability -- bounded
        // because the refused file is consumed in the same pass.
        tracing::warn!(terminal_id = %sig.terminal_id, session_id = %sig.session_id,
            "claude_rebind_refused: ledger_fresh_agent_session");
        return SignalDisposition::Acted;
    }
    let previous = current.session_id.clone();
    tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
        source = ?sig.source, "claude_rebind: SessionStart reported a new session id");
    // Same pinned order as the codex tail: identity -> meta -> ledger
    // (awaited) -> associated THEN meta.updated.
    state.identity.upsert(
        &sig.terminal_id,
        Some("claude"),
        Some(&sig.session_id),
        current.cwd.as_deref(),
        now_ms(),
    );
    state.registry.set_meta(
        &sig.terminal_id,
        None,
        None,
        Some("claude".to_string()),
        Some(sig.session_id.clone()),
    );
    crate::pane_ledger::ledger_resolve_identity(
        state,
        &sig.terminal_id,
        "claude",
        &sig.session_id,
        current.cwd.as_deref(),
    )
    .await;
    crate::codex_identity::broadcast_terminal_session_associated(
        state,
        "claude",
        &sig.terminal_id,
        &sig.session_id,
        current.cwd.clone(),
        previous,
    );
    SignalDisposition::Acted
}
```

3f. The consumer loop in `drain_and_rebind_claude` (the `spawn_blocking` prologue at `:139-154` is unchanged) becomes:

```rust
    for sig in signals {
        match apply_claude_signal(state, &sig).await {
            SignalDisposition::Acted | SignalDisposition::Discard => {
                let _ = std::fs::remove_file(&sig.path); // act/discard-then-delete (D1.1)
            }
            // Not actionable YET (or not this instance's pane) => the file
            // stays for a later sweep; STALE_SIGNAL_MAX_AGE bounds it.
            SignalDisposition::Retain => {}
        }
    }
```

3g. Update the module header comment (`claude_signal.rs:1-14`) to state the new contract, e.g. append: "Drain is NON-DESTRUCTIVE for valid signals — the consumer deletes a file only after acting on it (act-then-delete, D1.1, mirroring opencode_signal.rs): a signal for a terminal id unknown to this instance is RETAINED so the owning instance (another freshell server sharing $HOME) can consume it, bounded by opencode_signal's STALE_SIGNAL_MAX_AGE. Foreign-provider signals are warn-logged and consumed (`SignalDisposition::Discard`); orphaned `.tmp` staging is reaped on the same TTL."

- [ ] **Step 4: Run unit tests to verify green**

Run: `cargo test -p freshell-ws --lib claude_signal`

Expected: PASS — 6 tests (`drain_parses_retains_valid_files_and_consumes_rejects`, `drain_returns_signals_sorted_by_filename_oldest_first`, the 4 Task 1 tests).

- [ ] **Step 5: Update integration-test wording, run it**

In `crates/freshell-ws/tests/claude_session_rebind.rs`: Phase 3's `read_dir(signal_root).count() == 0` assertion holds (refusal ⇒ `Acted` ⇒ deleted) — update its message from "the refused signal file must still be consumed (single-shot)" to "a deliberate refusal counts as acted on: the file is consumed (act-then-delete)". Phase 4's file-absence assertion (`:578-580`) carries NO message — its delete-on-read wording lives in the COMMENT just above it (`:574-577`); update that comment with the same act-then-delete wording. No behavioral edits.

Run: `cargo test -p freshell-ws --test claude_session_rebind`

Expected: PASS (1 test — all four phases).

- [ ] **Step 6: Guard the neighbors (no cross-lane regressions), format, lint, commit**

```bash
FRESHELL_TEST_SUMMARY="claude drain parity: cross-lane guard after consumption-semantics change" \
  cargo test -p freshell-ws --test opencode_switch_rebind --test codex_fork_rebind --test cross_kind_liveness
cargo fmt --all
cargo clippy -p freshell-ws --all-targets -- -D warnings
git add crates/freshell-ws/src/claude_signal.rs crates/freshell-ws/tests/claude_session_rebind.rs
git commit -m "fix(claude-signal): act-then-delete drain with explicit disposition (opencode parity)"
```

Expected: all listed tests PASS.

---

### Task 3: Multi-instance retention regression test (P4)

Integration proof that one consumer + signal files owned by unknown terminals = retention across N drain cycles, no frames emitted, and reaping only after the staleness TTL. Mirrors opencode's Phase 9 (`opencode_switch_rebind.rs:867-896`) plus a TTL-reap tail it lacks.

**Files:**
- Modify: `crates/freshell-ws/tests/claude_session_rebind.rs` (append Phase 5 inside the existing `#[tokio::test]` fn — the file's header mandates phases-in-one-fn because phases share process-wide env)

**Interfaces:**
- Consumes: Task 2's retention semantics; the test file's existing `signal_root: PathBuf`, `watcher: ClaudeSignalWatcher`, `state: WsState` bindings, and its existing absence-proof helper (the Phase 3 pattern that asserts no `terminal.session.associated` frame for a terminal id arrives within 1s — reuse that exact helper/pattern; keep the 1s window).
- Produces: nothing consumed by later tasks (pure test).

- [ ] **Step 1: Write the failing phase (red only against pre-Task-2 code — on this branch it should pass; the red proof is Step 2's revert-check)**

Append after Phase 4, before the test's final teardown:

```rust
    // ── Phase 5 — multi-instance retention (P4): a signal naming a terminal
    // id UNKNOWN to this instance (another freshell server sharing $HOME
    // owns that pane) must be RETAINED across drain cycles, never emit a
    // frame, and be reaped only after the staleness TTL.
    let foreign_tid = "some-other-instances-pane";
    let foreign_path = signal_root.join(format!("{foreign_tid}__9000000000000000000-1.json"));
    std::fs::write(
        &foreign_path,
        r#"{"session_id":"11111111-2222-3333-4444-555555555555","source":"resume","hook_event_name":"SessionStart"}"#,
    )
    .expect("write foreign-instance signal");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        foreign_path.exists(),
        "an unknown-terminal signal must be RETAINED on disk (act-then-delete), \
         not destroyed -- a second freshell instance sharing $HOME owns it"
    );
    // Absence proof: no associated frame for the foreign terminal id within
    // 1s (reuse this file's Phase 3 absence-proof helper/pattern verbatim,
    // substituting foreign_tid).
    // <insert the Phase 3 absence assertion here, targeting foreign_tid>
    // Retention is stable across sweeps, not a one-drain artifact.
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        foreign_path.exists(),
        "the retained signal must survive a SECOND drain (stable retention)"
    );
    // Reaped ONLY after the staleness TTL: backdate the mtime past the cap
    // (STALE_SIGNAL_MAX_AGE = 600s, opencode_signal.rs:40 -- pub(crate),
    // not visible to this integration binary, hence the literal; the
    // in-module unit test drain_reaps_stale_files_without_emitting pins the
    // reap against the constant itself).
    let stale = std::time::SystemTime::now() - std::time::Duration::from_secs(11 * 60);
    std::fs::OpenOptions::new()
        .write(true)
        .open(&foreign_path)
        .expect("open retained signal for backdating")
        .set_modified(stale)
        .expect("backdate retained signal");
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    assert!(
        !foreign_path.exists(),
        "an orphaned unknown-terminal signal must be reaped after the staleness TTL"
    );
```

For the absence proof: Phase 3 of this file already asserts "no `associated` frame for tid2 within 1s" — copy that exact code block, replacing the terminal id with `foreign_tid` and the failure message with `"an unknown-terminal signal must never produce an associated frame on this instance"`.

- [ ] **Step 2: Prove the test bites (red proof against the old semantics)**

Temporarily verify the phase fails without Task 2's fix:

```bash
git stash push crates/freshell-ws/src/claude_signal.rs 2>/dev/null || true
git diff HEAD~1 --stat   # confirm which commit holds the Task 2 change
git checkout HEAD~1 -- crates/freshell-ws/src/claude_signal.rs 2>/dev/null || git checkout HEAD~2 -- crates/freshell-ws/src/claude_signal.rs
cargo test -p freshell-ws --test claude_session_rebind
git checkout HEAD -- crates/freshell-ws/src/claude_signal.rs
```

Expected: with the pre-parity `claude_signal.rs`, Phase 5 FAILS at the first `foreign_path.exists()` assertion (the destructive drain ate it). After restoring (`git checkout HEAD -- …`), continue. (If the checkout gymnastics prove awkward, an acceptable alternative red proof: in `drain_and_rebind_claude`'s consumer loop, temporarily change the `SignalDisposition::Retain => {}` arm to also `remove_file(&sig.path)`, observe Phase 5 fail at the first retention assertion, then revert.)

- [ ] **Step 3: Run to verify green on current code**

Run: `cargo test -p freshell-ws --test claude_session_rebind`

Expected: PASS — all five phases.

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-ws/tests/claude_session_rebind.rs
git commit -m "test(claude-signal): multi-instance retention regression (unknown terminals survive drains, TTL-reaped)"
```

---

### Task 4: Pin signal-independent first-bind for fresh claude panes (P2)

The P2 determination (see Findings) is that fresh WS-created claude panes bind at spawn via the preallocated `--session-id`, independent of signals. This task pins it: a fresh claude pane must have a usable sessionRef/resume identity even if every signal file is destroyed by an external actor.

**Files:**
- Modify: `crates/freshell-ws/tests/claude_session_rebind.rs` (append Phase 6 after Phase 5)

**Interfaces:**
- Consumes: the test file's existing pane-creation machinery (Phase 1 creates a claude pane over WS and reads `terminal.created`; Phase 1 also has a `registry_resume_id(tid)`-style helper for reading the bound resume id — reuse both patterns verbatim), `signal_root`, `watcher`, `state`.
- Produces: nothing consumed later (pure test).

- [ ] **Step 1: Write the phase**

Append after Phase 5:

```rust
    // ── Phase 6 — first-bind is signal-independent (P2): a fresh claude
    // pane's resume identity comes from the spawn-time preallocated
    // --session-id (terminal.rs fresh-create path), NOT from signal
    // consumption. Even if an external actor (e.g. another instance's
    // pre-parity destructive sweeper) destroys every signal file, the pane
    // must still carry a usable sessionRef/resume identity.
    //
    // Create a fresh claude pane exactly the way Phase 1 does (no
    // resumeSessionId, no sessionRef, no restore) and capture its
    // terminal.created frame.
    // <reuse Phase 1's create-pane + read-created-frame code, new tid binding>
    let created_ref = /* terminal.created's sessionRef from the frame just read */;
    assert_eq!(created_ref["provider"], "claude");
    let preallocated_id = created_ref["sessionId"]
        .as_str()
        .expect("fresh claude create must carry a preallocated session id")
        .to_string();
    assert_eq!(preallocated_id.len(), 36, "preallocated id is a UUID");
    // External actor destroys EVERY signal file (the pre-fix production
    // sweeper's behavior): wipe the whole signal dir.
    if let Ok(entries) = std::fs::read_dir(&signal_root) {
        for entry in entries.flatten() {
            let _ = std::fs::remove_file(entry.path());
        }
    }
    // Sweep after the destruction: binding must be unaffected.
    freshell_ws::claude_signal::drain_and_rebind_claude(&state, &watcher).await;
    tokio::task::yield_now().await;
    // The pane's resume identity is intact and usable (same read pattern
    // Phase 1 uses to assert registry_resume_id(tid1) == B).
    // <reuse Phase 1's resume-id read helper for the new tid>
    assert_eq!(
        /* resume id read for the new tid */,
        preallocated_id,
        "a fresh claude pane must keep its preallocated resume identity even \
         when every signal file is destroyed by an external actor"
    );
```

The `<reuse Phase 1's …>` markers (pane creation, `created_ref` extraction, resume-id read) are directives to copy this file's own Phase 1 code (pane creation over the already-open WS connection, `terminal.created` frame read, and the registry resume-id assertion helper) — the implementer must inline the real code from Phase 1 with a fresh terminal-id binding, not paraphrase it. The assertions shown above are the phase's deliverable and must appear as written.

- [ ] **Step 2: Run to verify it passes (this pins existing-correct behavior; red proof is the assertion quality)**

Run: `cargo test -p freshell-ws --test claude_session_rebind`

Expected: PASS — all six phases. Sanity-check the red direction by temporarily changing `assert_eq!(...preallocated_id...)` to compare against `"bogus"` and observing the failure message, then reverting (proves the assertion actually reads live state).

- [ ] **Step 3: Commit**

```bash
git add crates/freshell-ws/tests/claude_session_rebind.rs
git commit -m "test(claude-signal): pin signal-independent first-bind for fresh claude panes"
```

---

### Task 5: Full verification gates and branch push

**Files:**
- No source changes expected (fix anything the gates surface, in-place, with focused commits).

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch `fix/claude-signal-drain-parity`. **No PR** (repo rule: stop after pushing).

- [ ] **Step 1: Rust gates**

```bash
cd /home/dan/code/freshell/.worktrees/claude-signal-drain-parity
test -d node_modules || npm ci --no-audit --no-fund
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo clippy -p freshell-opencode --features real-transport --all-targets -- -D warnings
FRESHELL_TEST_SUMMARY="claude signal drain parity: full workspace gate before push" cargo test --workspace
```

Expected: fmt/clippy clean; all workspace tests PASS (this exercises the do-not-regress list: `opencode_switch_rebind`, `codex_fork_rebind`, `cross_kind_liveness`, `session_identity_frames`, `pane_ledger_triggers`, cli_launch goldens, etc.).

- [ ] **Step 2: Contract freeze (must be diff-clean — this change touches no contract)**

```bash
npm run contract:generate && git diff --exit-code -- port/contract
```

Expected: exit code 0, no diff.

- [ ] **Step 3: Coordinated JS gate**

```bash
FRESHELL_TEST_SUMMARY="claude signal drain parity: coordinated JS gate (no JS changes; regression only)" npm run check
```

Expected: PASS (no JS was touched).

- [ ] **Step 4: Push the branch (NO PR)**

```bash
git log --oneline origin/main..HEAD   # expect the plan commit + 4 task commits
git push -u origin fix/claude-signal-drain-parity
```

Expected: branch pushed. Stop here — do not open a PR.

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage:**
- P1(a) unknown-terminal retain + TTL reap → Task 2 (Retain arms) + Task 1 (TTL reap) + Task 3 (regression proof). P1(b) acted ⇒ delete → Task 2 consumer loop. P1(c) malformed/foreign explicit bounded disposition → Task 1 (`claude_signal_rejected` warn+consume) + Task 2 (`Discard`+`claude_signal_ignored` warns). P1(d) deterministic ordering → `paths.sort()` preserved (Task 1 code) and the sorting unit test retained (Task 2 updates only its retention tail). Guard chain/policy preserved → Task 2's ladder is today's guards verbatim, same order, same log strings.
- P2 → Findings section (answer: spawn-time binding is independent of signals; drill's None traces to destroyed rebind signals + out-of-scope REST-pane identity policy) + Task 4 pinning test.
- P3 → `.tmp` orphan reap (Task 1, consumer-side per the opencode pattern; hook strings untouched — byte-pinned goldens); pane-ledger-refusal warn + reject warn with the bounded-by-consumption rationale (Task 2 + "Warn-once rationale" section); verified against main via exploration — #575 gave claude sorted drain + portable nonce + three refusal warns, and what remained missing is exactly what Tasks 1–2 add.
- P4 → Task 3 (survives N=2 drains, no frame, reaped only after TTL; TTL-vs-constant pinned at unit level).
- Constraints: worktree/TDD/no-PR → Global Constraints + Task 5; production-3002 isolation → Global Constraints + every test uses `tempfile::tempdir()`; no forced refactor → single shared constant only, structural copy otherwise.

**1b. No silent deferrals:** No stubs/mocks stand in for required behavior — all tests drive the real drain/ladder against real files and real `WsState` harnesses; the multi-instance hazard is proven by the exact production mechanism (files for terminals this instance doesn't know). No requirement was moved to known-limitations/future-work. The REST-pane identity gap noted in Findings is not a spec requirement (P2 conditions the fix on first-bind *depending on signals*, which it does not) — documented as out of scope per the spec's own "not rebind policy" constraint, not deferred work.

**2. Placeholder scan:** The two `<reuse Phase 1's …>` markers in Task 4 and the `<insert the Phase 3 absence assertion>` marker in Task 3 are directives to inline specific, named, existing code from the same file being edited (with exact phase references and required assertion text supplied) — not TBDs. All other steps carry complete code.

**3. Type consistency:** `ClaudeSignal.path: std::path::PathBuf` (Task 2 Step 3a) matches its uses in Task 2's tests/consumer and Task 3's phase; `SignalDisposition` variants match consumer-loop matches; `apply_claude_signal(state: &WsState, sig: &ClaudeSignal) -> SignalDisposition` (async) matches its call site; `STALE_SIGNAL_MAX_AGE` referenced as `crate::opencode_signal::STALE_SIGNAL_MAX_AGE` in-module (same crate, `pub(crate)`) and as a literal `11 * 60`s backdate in the integration binary (where the constant is invisible), with the constant-accurate unit test noted.
