//! Test-only helper: the crate-wide lock for tests that mutate or read the
//! process-global `CLAUDE_HOME` / `CLAUDE_CONFIG_DIR` environment in the
//! `--bin freshell-server` test binary.
//!
//! Why the lock exists: `session_directory::claude_home` (and the transcript
//! locator's candidate roots) let a process-global `CLAUDE_HOME` WIN over a
//! test's explicit home — the production override parity. So when one test
//! holds `CLAUDE_HOME` pointed at its own temp home, every OTHER test whose
//! production-code path resolves through that resolver inspects a FOREIGN
//! temp home. The final-suite gate observed exactly this race:
//! `claude_unreadable_projects_root_defers` /
//! `claude_unreadable_project_subdir_defers` (`main.rs`) chmod their own
//! `~/.claude/projects` to 000 and assert the tombstone gate DEFERs, but a
//! concurrently running discovery test's `CLAUDE_HOME` (whose projects tree
//! is readable and holds no `sess-1.jsonl`) made the gate answer
//! "definitively absent" and fail the must-DEFER assert. Both fail
//! deterministically solo; the pristine base (6ee5cf4b) was clean only
//! because the mutators — the native route-discovery tests — landed with the
//! unified-agent-names branch, and the ~150 added tests widened the parallel
//! window until the race fired.
//!
//! The discipline (mirroring `sessions_tests.rs`'s pin-roots note and the
//! crate-wide `HOME_ENV_TEST_LOCK` convention):
//!
//! * every test that MUTATES `CLAUDE_HOME`/`CLAUDE_CONFIG_DIR`
//!   process-globally holds this lock for the whole set…restore window (the
//!   restore happens under the guard, before it releases);
//! * every test READER that cannot pin its root directly — one whose
//!   production-code path resolves through `claude_home` (the
//!   `transcript_definitively_absent` family, the `list_claude_sessions`
//!   fixtures) — MUST also hold it: async tests acquire with
//!   `lock().await`, plain `#[test]` fns with `blocking_lock()` (never call
//!   `blocking_lock` from inside a runtime — it panics);
//! * readers that pin their root DIRECTLY — constructing provider sources
//!   from explicit paths instead of `claude_home(&home)`, like
//!   `sessions_tests` — don't need it.
//!
//! Lock order: tests that need BOTH this lock and `HOME_ENV_TEST_LOCK` (the
//! `claude_exact_id_fallback` family mutates `HOME`/`USERPROFILE` too) take
//! `HOME_ENV_TEST_LOCK` FIRST, then this one — never the reverse.

/// The crate-wide `CLAUDE_HOME`/`CLAUDE_CONFIG_DIR` test-env lock. A
/// `tokio::sync::Mutex` because the discovery mutators are async and hold it
/// across `.await` points (a `std` guard there would trip clippy's
/// `await_holding_lock`); sync readers use `blocking_lock()`.
pub(crate) static CLAUDE_ENV_TEST_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
