# Opencode By-Id Sqlite Existence Fallback Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Stop freshell restarts from declaring rebound opencode panes "dead sessions" when the session row exists on disk, by adding an opencode by-id sqlite existence fallback to the production existence probe.

**Architecture:** `IndexExistenceProbe` (crates/freshell-server/src/existence.rs) answers `exists()` from the warm `SessionIndex` snapshot, whose opencode listing filters `parent_id IS NULL` and drops NULL/empty-`directory` rows — so a rebound CHILD session id (or a directory-less root) is DB-present yet index-invisible, and the probe answers a false `Absent`. Combined with the rebind ledger making `ever_observed()` true, reconcile derives `DeadSession{session_not_on_disk}` instead of `Respawn`, and chain-correction (rung 2b) poisons the superseded root's claim too. The fix mirrors the existing claude raw-file fallback: an injected locator closure (`OpencodeSessionLocator`) re-checks a warm-index `Absent` for provider `"opencode"` by id against `opencode.db` — the SAME truth the attach arm (`opencode --session <id>` → session.get by id, children included) trusts. The raw sqlite query lives in `freshell-sessions` (which already has runtime rusqlite); the server maps read errors to `Unknown`, never `Absent`.

**Tech Stack:** Rust (workspace crates `freshell-sessions`, `freshell-server`, tests touching `freshell-ws` APIs), rusqlite 0.31 (bundled), tokio tests; one opt-in TypeScript/Vitest real-provider contract test.

## Global Constraints

- Base: `origin/main` @ `90c027a4`. Work only in this worktree (`.worktrees/opencode-existence-fallback`).
- The local branch `spike/child-session-restart` (commit `d505ad0c`) is reference material only: quarry it, do NOT merge it, do NOT push it.
- Rust server only. No Node server work. No client changes expected.
- Strict TDD red-green-refactor for every task (repo rule, AGENTS.md — authoritative).
- Quality gates (CI parity): `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace` all clean.
- Known pre-existing flake: `crates/freshell-ws` test target `auto_resume_e2e.rs` under load — retry once before treating as a regression.
- Coordinated npm suite is required only if client/server TypeScript is touched — it should not be. The Task 4 file is an opt-in `test/integration/real/` vitest file (skipped by default, not part of the coordinated suite); run just that file directly.
- Do NOT create a PR (handled outside this workflow). Pushing the branch is fine.
- NEVER restart the live Rust server on port 3002. No live-server validation is needed for this plan; if a live check is ever wanted, use a scratch port (`scripts/launch-rust.sh --port 3499`).
- rusqlite 0.31 (bundled) is a runtime dependency of `freshell-sessions` and a dev-dependency of `freshell-server`. Do NOT add a runtime rusqlite dependency to `freshell-server` — the production query belongs in `freshell-sessions`.
- Commits must use the git identity `Dan Shapiro <3732858+danshapiro@users.noreply.github.com>` (repo/global config already provides this; do not override it).
- Busy timeout for the new by-id query: 250ms — deliberately NOT the listing's 5000ms (`exists()` is sync on the reconcile path; N panes × 5s is unacceptable).
- LOAD-BEARING error semantics: missing DB file ⇒ `Absent` is fine (no opencode ever ran); ANY other failure to open/read the DB (lock contention, corruption, io error) ⇒ `Unknown`, NEVER `Absent`. `Unknown` makes reconcile defer (`Error{index_warming}` + the handler's single bounded deferral) and re-derive; Absent-on-error would recreate the bug under WAL lock contention. (Empirically validated with the workspace-pinned rusqlite 0.31.0: `busy_timeout(250)` bounds every lock scenario — max observed 251.53ms, all failures surface as `Err`, no hang, no false-empty result; see the load-bearing ledger.)
- Load-bearing validation (2026-07-29, ledger: `.worktrees/.the-usual-logs/opencode-existence-fallback/load-bearing-ledger.md`): verified against real opencode v1.18.9 — the attach arm is by-id (`resumeArgs ["--session","{{sessionId}}"]`, `extensions/opencode/freshell.json:10`), and opencode's `Session.get` resolves children, directory-less roots, AND ARCHIVED sessions (no `time_archived` filter in `Session.get`; a live attach to an archived session succeeded). FALSIFIED-and-fixed: the by-id query carries NO `time_archived IS NULL` filter — archived rows answer "found" (attach parity). Accepted limitation (parity with the listing, not a regression): opencode uses `opencode-<channel>.db` on non-standard channels and honors an `OPENCODE_DB` env override; both the listing and this fallback probe `<data_home>/opencode.db`, so non-standard channels behave exactly as today.
- Explicitly OUT of scope (rejected by adversarial review — do not implement): living-ancestor/chain-fallback in reconcile; signal-lane guards or child→root translation at rebind time; including children in the SessionIndex listing (the listing's root-only query MUST stay root-only); any ledger migration/repair; Node server or client code.
- Deliberately skipped (allowed by spec): per-derive-pass memoization of fallback hits. The probe has no per-derivation-pass notion, so threading one through would complicate the `SessionExistenceProbe` contract for a micro-optimization; the chain case's double probe costs one extra 250ms-bounded read-only query. Spec pin 6 says "skip if it complicates anything" — it does.

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `crates/freshell-sessions/src/parse/opencode.rs` | Modify | Add `session_exists_by_id(data_home, id) -> Result<bool, OpencodeReadError>` + 250ms busy-timeout const. All opencode SQL stays in this one module. |
| `crates/freshell-sessions/src/parse.rs` (or `parse/mod.rs`) | Modify (only if needed) | Re-export `session_exists_by_id` the same way `default_opencode_data_home` is re-exported (skip if the module already does `pub use opencode::*` or `pub mod opencode` reached via `parse::`). |
| `crates/freshell-sessions/tests/opencode_exists_by_id.rs` | Create | Integration tests for the raw by-id query semantics (child row, directory-less root, archived, missing id, missing DB file, unreadable DB, schema without `time_archived`). |
| `crates/freshell-server/src/existence.rs` | Modify | `OpencodeDbAnswer` enum, `OpencodeSessionLocator` type, probe field + builder, fallback logic in `exists()`, production `opencode_db_locator()` ctor, module-doc bullet; probe unit tests (quartet + DB-semantics through the probe) and the promoted end-to-end spike test. |
| `crates/freshell-server/src/main.rs` | Modify (~lines 595-598) | Chain `.with_opencode_session_locator(...)` after the existing `.with_claude_transcript_locator(...)` at the single probe construction site. |
| `test/integration/real/coding-cli-session-contract.test.ts` | Modify | New opt-in test in the existing opencode `describe` lane: real opencode resolves a CHILD session id via `--session` (the attach-arm premise). |

**Read the spike first:** `git show spike/child-session-restart:crates/freshell-server/src/existence.rs` — its test `spike_child_session_rebound_pane_restart_verdict` (asserting the BAD verdicts against unfixed code, proven RED at commit `d505ad0c`) is the seed for Task 3's promoted test.

**Key existing types/signatures you will consume (defined on `origin/main`, not in this plan):**

- `crates/freshell-ws/src/existence.rs`: `pub enum SessionExistence { Present, Absent, Unknown, ProviderUnavailable }`; `pub trait SessionExistenceProbe: Send + Sync { fn exists(&self, provider: &str, session_id: &str) -> SessionExistence; fn ever_observed(&self, provider: &str, session_id: &str) -> bool; }`
- `crates/freshell-server/src/existence.rs`: `pub type ClaudeTranscriptLocator = Arc<dyn Fn(&str) -> Option<PathBuf> + Send + Sync>;` (line ~42); `IndexExistenceProbe::new(index: Arc<SessionIndex>, ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>, provider_roots: HashMap<String, PathBuf>) -> Self` (~:70); `with_claude_transcript_locator(mut self, locator) -> Self` (~:86); the claude fallback lives in the warm `Some(items)` arm of `exists()` (~:156-170); the observed-set feed is `self.observed.lock().expect("observed set lock").insert(format!("{provider}:{session_id}"))` (~:163-166).
- `crates/freshell-sessions/src/parse/opencode.rs`: `pub fn default_opencode_data_home() -> PathBuf` (~:374); `pub struct OpencodeReadError(pub String)`-shaped error (used as `OpencodeReadError(e.to_string())`); `const OPENCODE_DB_BUSY_TIMEOUT_MS` (=5000, ~:19); connections open with `Connection::open_with_flags(&db_path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI)` after an `exists()` pre-check on the path; the DB file is `<data_home>/opencode.db`. If `OpencodeReadError`'s field is not pub or its constructor shape differs, match whatever `list_sessions` (~:284-310) does — same module, same error type.
- `crates/freshell-sessions/src/directory_index.rs`: `OpencodeSource::new(data_home: PathBuf)`, `ClaudeSource::new(home: PathBuf)`, `SessionSource`, `SessionIndex::with_ttl_and_cache_path(Vec<Arc<dyn SessionSource>>, Duration, Option<_>)`, `index.warm().await`, `IndexedSession { provider, session_id, .. }` with `.key()` = `"{provider}:{session_id}"`.
- `crates/freshell-ws/src/pane_ledger.rs`: `PaneLedger::new(Option<PathBuf>)`, `record_pending(terminal_id, provider, cwd, now_ms)`, `resolve_pending(&BindingWrite{ provider, session_id, terminal_id, mode, cwd, create_request_id, now_ms })`, `load_binding(provider, session_id)`, `RowState::{Bound, Retired}`, `RetiredReason::Superseded`, `ever_bound(provider, session_id)`.
- `crates/freshell-ws/src/reconcile.rs`: `derive_verdicts(&ReconcileDeps{ registry, identity, existence, pane_ledger, fresh_agent }, &[ReconcilePane]) -> Vec<PaneVerdict>`; `Present` ⇒ `Respawn` (with `corrected: Some(true)` iff the server ref differs from the claim); `Absent` + `ever_observed` ⇒ `DeadSession{"session_not_on_disk"}`; `Unknown` ⇒ `Error{"index_warming"}`.
- `crates/freshell-protocol`: `ReconcileVerdict::{Respawn, DeadSession, Fresh, Error, ...}` (fieldless enum); `PaneVerdict { pane_key, verdict, terminal_id, session_ref: Option<SessionLocator>, corrected: Option<bool>, reason: Option<String>, duplicate }`; `SessionLocator { provider, session_id }`; `ReconcilePane { pane_key, kind, mode, create_request_id, terminal_id, server_instance_id, session_ref, resume_session_id, status }`.

---

### Task 1: `session_exists_by_id` in freshell-sessions

The raw by-id sqlite lookup, living beside all other opencode SQL. Query: `SELECT 1 FROM session WHERE id = ?1` — deliberately NO `parent_id` filter (children are attachable via `opencode --session <id>`), NO `directory` filter (directory-less roots are real rows the listing drops at mapping), and NO `time_archived` filter. An archived filter was originally planned for listing parity, but load-bearing validation FALSIFIED its premise against real opencode v1.18.9: `Session.get` (session.ts:542-546) has no archived filter — archived filtering exists only in the list surface (`listGlobal`, session.ts:564) — and a live TUI attach to an archived session succeeded (see `reports/validator-V1.md` in the logs dir). Attach parity is this fix's governing principle: filtering archived rows would answer Absent for attachable sessions, the exact false-dead-session bug class this plan removes. So archived rows answer "found", pinned by test. Schema variance: the query references only `id`, so a legacy DB lacking `time_archived` answers normally (pinned by test) — strictly fewer `Err` paths than the listing, which treats `time_archived` as a schema invariant.

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (add one const + one pub fn near `default_opencode_data_home`, ~line 374)
- Modify (only if needed): the `parse` module file that re-exports `default_opencode_data_home`
- Test: `crates/freshell-sessions/tests/opencode_exists_by_id.rs` (new)

**Interfaces:**
- Consumes: `OpencodeReadError`, `Connection`, `OpenFlags` (already imported in `parse/opencode.rs`).
- Produces: `pub fn session_exists_by_id(data_home: &Path, session_id: &str) -> Result<bool, OpencodeReadError>`, reachable as `freshell_sessions::parse::session_exists_by_id` (Task 2 calls it by that path). Semantics: `Ok(true)` = a row with this id exists (archived included — attach parity); `Ok(false)` = no such row OR no DB file; `Err` = any read failure.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-sessions/tests/opencode_exists_by_id.rs`:

```rust
//! Existence-probe by-id lookups against a temp `opencode.db` — the raw
//! query behind the server probe's opencode fallback (rebind dead-session
//! fix). Pins:
//! - CHILD rows (`parent_id` set) and directory-less ROOT rows are found
//!   (the attach arm `opencode --session <id>` resolves both; the listing
//!   hides both);
//! - ARCHIVED rows are found too: opencode's `Session.get` has no
//!   `time_archived` filter and a live attach to an archived session
//!   succeeds (validated against opencode v1.18.9) — the query matches
//!   the ATTACH arm, not the listing;
//! - unknown ids are not found;
//! - a missing DB file is a benign "not found" (no opencode ever ran);
//! - an unreadable DB is a hard `Err` (the probe maps it to Unknown,
//!   NEVER Absent);
//! - a legacy schema lacking `time_archived` still answers by id (the
//!   query references only `id`).

use freshell_sessions::parse::session_exists_by_id;

fn temp_data_home(tag: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-exists-by-id-{tag}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    std::fs::create_dir_all(&dir).expect("mkdir temp data home");
    dir
}

/// Same schema shape as tests/opencode_sqlite.rs `create_full_schema`
/// (and the spike fixture): full modern schema including `parent_id`
/// and `time_archived`.
fn seed_schema(data_home: &std::path::Path) -> rusqlite::Connection {
    let conn =
        rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT,
            title TEXT,
            time_created INTEGER,
            time_updated INTEGER,
            time_archived INTEGER,
            project_id TEXT,
            parent_id TEXT
         );
         CREATE TABLE part (session_id TEXT, data TEXT);
         CREATE TABLE message (session_id TEXT, data TEXT);",
    )
    .expect("create schema");
    conn
}

/// Insert one session row. `directory`, `parent_id`, `time_archived` are
/// the three axes these tests vary.
fn insert_row(
    conn: &rusqlite::Connection,
    id: &str,
    directory: Option<&str>,
    parent_id: Option<&str>,
    time_archived: Option<i64>,
) {
    conn.execute(
        "INSERT INTO session VALUES (?1, ?2, 'T', 1000, 5000, ?4, NULL, ?3)",
        rusqlite::params![id, directory, parent_id, time_archived],
    )
    .expect("insert session row");
}

#[test]
fn child_row_with_parent_id_is_found() {
    let home = temp_data_home("child");
    let conn = seed_schema(&home);
    insert_row(&conn, "ses_root0000000000000000000000", Some("/tmp/p"), None, None);
    insert_row(
        &conn,
        "ses_child000000000000000000000",
        Some("/tmp/p"),
        Some("ses_root0000000000000000000000"),
        None,
    );
    assert!(
        session_exists_by_id(&home, "ses_child000000000000000000000").expect("query ok"),
        "a CHILD row (parent_id set) IS on disk — no parent_id filter"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn directory_less_root_row_is_found() {
    let home = temp_data_home("dirless");
    let conn = seed_schema(&home);
    insert_row(&conn, "ses_dirless0000000000000000000", None, None, None);
    assert!(
        session_exists_by_id(&home, "ses_dirless0000000000000000000").expect("query ok"),
        "a NULL-directory ROOT row IS on disk — no directory filter"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn archived_row_is_found_attach_parity() {
    // FALSIFIED-and-fixed premise: opencode's Session.get has NO archived
    // filter (session.ts:542-546; archived filtering exists only in the
    // list surface) and a live attach to an archived session succeeds.
    // The probe must agree with the ATTACH arm — filtering archived rows
    // would answer Absent for an attachable session (the bug class this
    // fix removes).
    let home = temp_data_home("archived");
    let conn = seed_schema(&home);
    insert_row(&conn, "ses_arch0000000000000000000000", Some("/tmp/p"), None, Some(9999));
    assert!(
        session_exists_by_id(&home, "ses_arch0000000000000000000000").expect("query ok"),
        "archived rows ARE attachable (`opencode --session <id>` resumes them) — found"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn unknown_id_is_not_found() {
    let home = temp_data_home("unknown-id");
    let conn = seed_schema(&home);
    insert_row(&conn, "ses_root0000000000000000000000", Some("/tmp/p"), None, None);
    assert!(!session_exists_by_id(&home, "ses_missing0000000000000000000").expect("query ok"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn missing_db_file_is_not_found_not_an_error() {
    // Data home exists but opencode.db does not: opencode never ran here.
    let home = temp_data_home("no-db");
    assert!(!session_exists_by_id(&home, "ses_root0000000000000000000000").expect("benign"));
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn unreadable_db_is_an_error_never_not_found() {
    // A DIRECTORY where the DB file should be: `exists()` passes, the
    // read-only open fails — the corruption/io-error class, distinct from
    // "no DB file". Callers map Err to Unknown, never Absent.
    let home = temp_data_home("unreadable");
    std::fs::create_dir_all(home.join("opencode.db")).expect("mkdir dir-as-db");
    assert!(
        session_exists_by_id(&home, "ses_root0000000000000000000000").is_err(),
        "an unreadable DB must be a hard error, not a quiet 'not found'"
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn schema_missing_time_archived_still_answers_by_id() {
    // The by-id query references only `id`, so — unlike the listing, which
    // treats `time_archived` as a schema invariant and errors on a DB
    // lacking it — a legacy schema still answers normally. Pins that the
    // query has strictly fewer failure modes than the listing.
    let home = temp_data_home("old-schema");
    let conn =
        rusqlite::Connection::open(home.join("opencode.db")).expect("open fixture db");
    conn.execute_batch(
        "CREATE TABLE session (
            id TEXT PRIMARY KEY,
            directory TEXT,
            title TEXT,
            time_created INTEGER,
            time_updated INTEGER
         );",
    )
    .expect("create legacy schema");
    conn.execute(
        "INSERT INTO session VALUES ('ses_old00000000000000000000000', '/tmp/p', 'T', 1, 2)",
        [],
    )
    .expect("insert");
    assert!(
        session_exists_by_id(&home, "ses_old00000000000000000000000").expect("query ok"),
        "the query references only `id` — a legacy schema without \
         time_archived answers normally"
    );
    let _ = std::fs::remove_dir_all(&home);
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/opencode-existence-fallback && cargo test -p freshell-sessions --test opencode_exists_by_id`

Expected: FAIL to compile with `unresolved import freshell_sessions::parse::session_exists_by_id` (or `cannot find function`). A compile error against a not-yet-written function is the RED state.

- [ ] **Step 3: Implement `session_exists_by_id`**

In `crates/freshell-sessions/src/parse/opencode.rs`, add near `default_opencode_data_home` (~line 374). Reuse the file's existing imports (`Connection`, `OpenFlags`, `OpencodeReadError` are all already in scope in this module):

```rust
/// Busy timeout for the existence probe's by-id lookup. Deliberately much
/// shorter than `OPENCODE_DB_BUSY_TIMEOUT_MS` (5000ms): `exists()` runs
/// synchronously on the reconcile path, once per pane — N panes x 5s of
/// WAL lock contention would stall every restart. A still-locked DB is a
/// transient read failure (`Err` => the probe answers Unknown and
/// reconcile's bounded deferral retries), not evidence of absence.
const EXISTENCE_BY_ID_BUSY_TIMEOUT_MS: u64 = 250;

/// Existence-probe by-id lookup: does `<data_home>/opencode.db` hold a
/// `session` row with this id?
///
/// Deliberately NO `parent_id` filter — the attach arm
/// (`opencode --session <id>` -> session.get by id) resolves CHILD
/// sessions the root-filtered listing hides — NO `directory` filter
/// (directory-less roots are real, attachable rows the listing drops at
/// mapping) — and NO `time_archived` filter: opencode's `Session.get`
/// has no archived filter and a live attach to an archived session
/// succeeds (validated against v1.18.9), so archived rows answer
/// `Ok(true)`. The query matches the ATTACH arm, not the listing: any
/// filter the attach arm lacks would answer "absent" for an attachable
/// session — the false-dead-session bug class this function removes.
/// Schema note: only `id` is referenced, so legacy schemas lacking
/// `time_archived` answer normally.
///
/// - `Ok(false)` for a missing DB file (opencode never ran here) or no
///   matching row;
/// - `Err` for ANY read failure (lock contention, corruption, io error,
///   schema variance). LOAD-BEARING: callers must treat `Err` as
///   "unknown", never "absent" — an absent-on-error would let WAL lock
///   contention adjudicate live sessions dead.
pub fn session_exists_by_id(
    data_home: &Path,
    session_id: &str,
) -> Result<bool, OpencodeReadError> {
    let db_path = data_home.join("opencode.db");
    if !db_path.exists() {
        return Ok(false);
    }
    let conn = Connection::open_with_flags(
        &db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    conn.busy_timeout(std::time::Duration::from_millis(
        EXISTENCE_BY_ID_BUSY_TIMEOUT_MS,
    ))
    .map_err(|e| OpencodeReadError(e.to_string()))?;
    match conn.query_row(
        "SELECT 1 FROM session WHERE id = ?1",
        rusqlite::params![session_id],
        |_| Ok(()),
    ) {
        Ok(()) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(OpencodeReadError(e.to_string())),
    }
}
```

If `Path` is not already imported at the top of the module, use `std::path::Path` in the signature. If `OpencodeReadError` cannot be constructed as `OpencodeReadError(e.to_string())`, copy the exact construction used by `list_sessions` in the same file (~line 300) — it maps rusqlite errors to this error type already.

- [ ] **Step 4: Make it reachable as `freshell_sessions::parse::session_exists_by_id`**

Check how `default_opencode_data_home` is exported (it is called as `freshell_sessions::parse::default_opencode_data_home()` from `main.rs`): open the `parse` module file (`crates/freshell-sessions/src/parse.rs` or `crates/freshell-sessions/src/parse/mod.rs`). If it re-exports opencode items by name (e.g. `pub use opencode::{default_opencode_data_home, ...};`), add `session_exists_by_id` to that list. If it uses `pub use opencode::*;` or the path already resolves, no change is needed.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p freshell-sessions --test opencode_exists_by_id`

Expected: PASS — 7 tests, 0 failures. Note: first build in this worktree is a cold compile; allow several minutes.

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-sessions --all-targets -- -D warnings
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/tests/opencode_exists_by_id.rs
# plus the parse module file if Step 4 changed it
git commit -m "feat(sessions): opencode by-id existence query for the probe fallback"
```

Expected: clippy clean; commit succeeds.

---

### Task 2: Probe fallback, production locator, and main.rs wiring

Add the opencode fallback to `IndexExistenceProbe`, exactly analogous to the claude raw-file fallback: fires ONLY when the warm-index scan says `Absent` AND `provider == "opencode"`; a hit feeds the monotone observed-set the same way (existence.rs ~:159-167); an unreadable DB answers `Unknown`; the cold-index arm is untouched. The production locator wraps Task 1's query and is wired at the single construction site in `main.rs`. Wiring lands in this task so the new builder is never dead code between commits (`cargo clippy --workspace --all-targets -- -D warnings` lints the bin target, where an unused pub builder in a bin crate warns).

**Files:**
- Modify: `crates/freshell-server/src/existence.rs` (type + enum near line 42, field ~:66, `new()` ~:80, builder ~:86, fallback in `exists()` ~:170, module-doc bullet ~:22, tests appended to `mod tests`)
- Modify: `crates/freshell-server/src/main.rs` (~lines 595-598, the `.with_claude_transcript_locator(...)` chain)
- Test: `crates/freshell-server/src/existence.rs` `mod tests` (bin unittest target)

**Interfaces:**
- Consumes: `freshell_sessions::parse::session_exists_by_id` (Task 1); `freshell_sessions::directory_index::OpencodeSource` (tests); existing probe internals (`self.observed`, `KNOWN_PROVIDERS`).
- Produces (Task 3 and main.rs rely on these exact names):
  - `pub enum OpencodeDbAnswer { Present, Absent, Unreadable }`
  - `pub type OpencodeSessionLocator = Arc<dyn Fn(&str) -> OpencodeDbAnswer + Send + Sync>;`
  - `pub fn IndexExistenceProbe::with_opencode_session_locator(mut self, locator: OpencodeSessionLocator) -> Self`
  - `pub fn opencode_db_locator(data_home: PathBuf) -> OpencodeSessionLocator`
  - Test helpers in `mod tests`: `temp_opencode_data_home(tag: &str) -> PathBuf`, `seed_opencode_db(data_home: &Path, rows: &[(&str, Option<&str>, Option<&str>, Option<i64>)])` (tuple = id, directory, parent_id, time_archived), `opencode_probe_over(data_home: &Path) -> (IndexExistenceProbe, Arc<SessionIndex>)`.

- [ ] **Step 1: Write the failing tests**

Append to `mod tests` in `crates/freshell-server/src/existence.rs`. Also extend the tests-module import line `use freshell_sessions::directory_index::{ClaudeSource, SessionSource};` to include `OpencodeSource`.

First the helpers (mirroring `temp_claude_home` / `probe_over` / `direct_locator_over` just above them):

```rust
    fn temp_opencode_data_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "freshell-existence-opencode-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).expect("mkdir opencode data home");
        dir
    }

    /// Same schema shape as crates/freshell-sessions/tests/opencode_sqlite.rs
    /// `create_full_schema` (and the spike fixture). Row tuple:
    /// (id, directory, parent_id, time_archived).
    fn seed_opencode_db(
        data_home: &std::path::Path,
        rows: &[(&str, Option<&str>, Option<&str>, Option<i64>)],
    ) {
        let conn = rusqlite::Connection::open(data_home.join("opencode.db"))
            .expect("open fixture db");
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY,
                directory TEXT,
                title TEXT,
                time_created INTEGER,
                time_updated INTEGER,
                time_archived INTEGER,
                project_id TEXT,
                parent_id TEXT
             );
             CREATE TABLE part (session_id TEXT, data TEXT);
             CREATE TABLE message (session_id TEXT, data TEXT);",
        )
        .expect("create schema");
        for (id, directory, parent_id, time_archived) in rows {
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'T', 1000, 5000, ?4, NULL, ?3)",
                rusqlite::params![id, directory, parent_id, time_archived],
            )
            .expect("insert session row");
        }
    }

    fn opencode_probe_over(
        data_home: &std::path::Path,
    ) -> (IndexExistenceProbe, Arc<SessionIndex>) {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(OpencodeSource::new(data_home.to_path_buf())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        (
            IndexExistenceProbe::new(
                Arc::clone(&index),
                None,
                HashMap::from([("opencode".to_string(), data_home.to_path_buf())]),
            ),
            index,
        )
    }
```

Then the tests (the quartet mirroring the claude fallback tests, plus the DB-semantics cases through the probe):

```rust
    /// Rebind fix RED: a CHILD session row (parent_id set) IS in
    /// opencode.db, but the listing's `parent_id IS NULL` root filter hides
    /// it from the index — the probe must answer Present via the by-id DB
    /// fallback, because the attach arm (`opencode --session <id>`) would
    /// resolve it.
    #[tokio::test]
    async fn child_opencode_session_row_on_disk_is_present_not_absent() {
        let home = temp_opencode_data_home("child-row");
        seed_opencode_db(
            &home,
            &[
                ("ses_root0000000000000000000000", Some("/tmp/p"), None, None),
                (
                    "ses_child000000000000000000000",
                    Some("/tmp/p"),
                    Some("ses_root0000000000000000000000"),
                    None,
                ),
            ],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Present,
            "the row exists on disk (the attach arm would resolve it) — the \
             probe must agree with the by-id DB check, not the root-filtered index"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Fallback-Present feeds the monotone observed-set (module-doc
    /// invariant), same as the claude fallback, so a LATER genuine deletion
    /// still derives loud dead_session even without a ledger.
    #[tokio::test]
    async fn opencode_fallback_present_feeds_ever_observed() {
        let home = temp_opencode_data_home("fallback-observed");
        seed_opencode_db(
            &home,
            &[
                ("ses_root0000000000000000000000", Some("/tmp/p"), None, None),
                (
                    "ses_child000000000000000000000",
                    Some("/tmp/p"),
                    Some("ses_root0000000000000000000000"),
                    None,
                ),
            ],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Present
        );
        assert!(
            probe.ever_observed("opencode", "ses_child000000000000000000000"),
            "a fallback hit is an on-disk observation and must feed ever_observed"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// HAZARD GUARD (must not regress): an id GENUINELY absent from the DB
    /// stays Absent even with the locator installed — the fallback must
    /// never weaken positive denial.
    #[tokio::test]
    async fn genuinely_missing_opencode_id_stays_absent_with_locator_installed() {
        let home = temp_opencode_data_home("hazard-guard");
        seed_opencode_db(
            &home,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_missing0000000000000000000"),
            SessionExistence::Absent,
            "no row anywhere: warm-index Absent AND by-id miss => Absent"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The fallback is OPENCODE-scoped (mirror of
    /// `codex_absent_never_consults_the_claude_locator`): a claude Absent
    /// must stay Absent even when the installed opencode locator would
    /// answer Present for any id.
    #[tokio::test]
    async fn claude_absent_never_consults_the_opencode_locator() {
        let home = temp_claude_home("claude-opencode-gate");
        let (probe, index) = probe_over(&home);
        let probe = probe
            .with_opencode_session_locator(Arc::new(|_sid: &str| OpencodeDbAnswer::Present));
        index.warm().await;
        assert_eq!(
            probe.exists("claude", "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d"),
            SessionExistence::Absent,
            "the by-id DB fallback is provider-gated to opencode only"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// Same gate for codex.
    #[tokio::test]
    async fn codex_absent_never_consults_the_opencode_locator() {
        let home = temp_claude_home("codex-opencode-gate");
        let (probe, index) = probe_over(&home);
        let probe = probe
            .with_opencode_session_locator(Arc::new(|_sid: &str| OpencodeDbAnswer::Present));
        index.warm().await;
        assert_eq!(
            probe.exists("codex", "thread-1"),
            SessionExistence::Absent,
            "the by-id DB fallback is provider-gated to opencode only"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A ROOT row with NULL directory is returned by the listing SQL but
    /// dropped at mapping (parse/opencode.rs ~:314-317) — index-invisible
    /// yet DB-present. The fallback must find it.
    #[tokio::test]
    async fn directory_less_opencode_root_row_is_present_via_fallback() {
        let home = temp_opencode_data_home("dirless-root");
        seed_opencode_db(
            &home,
            &[("ses_dirless0000000000000000000", None, None, None)],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_dirless0000000000000000000"),
            SessionExistence::Present,
            "directory-less roots are real attachable rows the listing drops"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// PINNED: an archived row (time_archived set) is PRESENT via the
    /// fallback — attach parity. The listing excludes archived rows
    /// (parse/opencode.rs:204, `time_archived IS NULL`), but opencode's
    /// attach arm resolves them: `Session.get` has NO archived filter and
    /// a live `opencode --session <archived-id>` attach succeeds
    /// (load-bearing validation against v1.18.9). Answering Absent here
    /// would kill the bookmark of an attachable session — the exact bug
    /// class this fix removes.
    #[tokio::test]
    async fn archived_opencode_row_is_present_attach_parity() {
        let home = temp_opencode_data_home("archived");
        seed_opencode_db(
            &home,
            &[("ses_arch0000000000000000000000", Some("/tmp/p"), None, Some(9999))],
        );
        let (probe, index) = opencode_probe_over(&home);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(home.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_arch0000000000000000000000"),
            SessionExistence::Present,
            "archived rows are index-invisible but attachable — the probe \
             must agree with the attach arm"
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// LOAD-BEARING: an unreadable DB (here: a DIRECTORY where the file
    /// should be — the corruption/io-error class) answers Unknown, NEVER
    /// Absent. Absent-on-error would recreate the dead-session bug under
    /// WAL lock contention. Reconcile turns Unknown into
    /// error{index_warming} + its single bounded deferral, then re-derives.
    /// The index is warmed over a separate GOOD home so the warm-snapshot
    /// arm (where the fallback lives) is actually exercised.
    #[tokio::test]
    async fn unreadable_opencode_db_answers_unknown_never_absent() {
        let good = temp_opencode_data_home("unreadable-good");
        seed_opencode_db(
            &good,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let broken = temp_opencode_data_home("unreadable-broken");
        std::fs::create_dir_all(broken.join("opencode.db")).expect("mkdir dir-as-db");
        let (probe, index) = opencode_probe_over(&good);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(broken.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Unknown,
            "read failure is honest ignorance — reconcile defers and retries; \
             it must never become a false Absent"
        );
        let _ = std::fs::remove_dir_all(&good);
        let _ = std::fs::remove_dir_all(&broken);
    }

    /// A MISSING DB file is a normal Absent (opencode never ran here) —
    /// distinct from the unreadable case above.
    #[tokio::test]
    async fn missing_opencode_db_file_stays_absent() {
        let good = temp_opencode_data_home("missing-db-good");
        seed_opencode_db(
            &good,
            &[("ses_root0000000000000000000000", Some("/tmp/p"), None, None)],
        );
        let empty = temp_opencode_data_home("missing-db-empty");
        let (probe, index) = opencode_probe_over(&good);
        let probe = probe.with_opencode_session_locator(opencode_db_locator(empty.clone()));
        index.warm().await;
        assert_eq!(
            probe.exists("opencode", "ses_child000000000000000000000"),
            SessionExistence::Absent
        );
        let _ = std::fs::remove_dir_all(&good);
        let _ = std::fs::remove_dir_all(&empty);
    }
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p freshell-server --bin freshell-server existence`

Expected: FAIL to compile — `with_opencode_session_locator`, `opencode_db_locator`, `OpencodeDbAnswer` not found. That is the RED state.

- [ ] **Step 3: Implement the fallback**

In `crates/freshell-server/src/existence.rs`:

**(a)** Module-doc bullet — append after the existing claude bullet (module doc lines ~17-22):

```rust
//! * warm snapshot `Absent` for provider `opencode` with a session locator
//!   installed => re-checked BY ID against `opencode.db` (rebind
//!   dead-session fix): child rows (`parent_id` set), directory-less
//!   roots, and archived rows are DB-present yet index-invisible — the
//!   listing is root-filtered, drops cwd-less rows, and excludes archived
//!   — while the attach arm (`opencode --session <id>`, session.get by
//!   id, which has none of those filters) resolves them all. Row present
//!   => `Present`; unreadable DB => `Unknown`, never `Absent`.
```

**(b)** Types — after the `ClaudeTranscriptLocator` type alias (~line 42):

```rust
/// Answer from the injected opencode by-id DB check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpencodeDbAnswer {
    /// A `session` row with the id exists in `opencode.db` (archived
    /// included — the attach arm's session.get has no archived filter).
    Present,
    /// No such row — including "no DB file at all" (opencode never ran here).
    Absent,
    /// The DB exists but could not be read (WAL lock contention, corruption,
    /// io error, schema variance). LOAD-BEARING: the probe maps this to
    /// `Unknown`, NEVER `Absent` — Absent-on-error would adjudicate live
    /// sessions dead under transient lock contention.
    Unreadable,
}

/// Injected by-id opencode DB check, mirroring [`ClaudeTranscriptLocator`]
/// (kata 09v1 pattern: the probe must agree with the ATTACH ARM). Opencode's
/// attach arm is `opencode --session <id>` — session.get by id, children
/// included — while the index listing is root-filtered
/// (`parent_id IS NULL`, parse/opencode.rs) and drops directory-less rows.
/// A closure (not a direct call) keeps this probe unit-testable; precedent:
/// `claude_transcript_locator` above.
pub type OpencodeSessionLocator = Arc<dyn Fn(&str) -> OpencodeDbAnswer + Send + Sync>;
```

**(c)** Struct field — after `claude_transcript_locator` (~line 66):

```rust
    /// Opencode by-id fallback (rebind dead-session fix): a session row can
    /// be in opencode.db yet index-invisible — the listing filters
    /// `parent_id IS NULL` (children hidden), drops NULL/empty
    /// `directory` rows (some roots hidden), and excludes archived rows
    /// (which the attach arm still resolves) — so the warm snapshot answers
    /// a false Absent while the attach arm (`opencode --session <id>`)
    /// would resolve it. When set, a warm-index Absent for provider
    /// "opencode" is re-checked by id against the DB before being
    /// finalized. `None` (tests, callers that never set it) keeps the pure
    /// index answer.
    opencode_session_locator: Option<OpencodeSessionLocator>,
```

**(d)** In `new()` (~line 80), add `opencode_session_locator: None,` to the struct literal.

**(e)** Builder — after `with_claude_transcript_locator` (~line 89):

```rust
    /// Builder-style: install the by-id sqlite fallback for opencode (see
    /// the field doc). Chained at the single production construction site
    /// in main.rs.
    pub fn with_opencode_session_locator(mut self, locator: OpencodeSessionLocator) -> Self {
        self.opencode_session_locator = Some(locator);
        self
    }
```

**(f)** Production locator ctor — after the `impl IndexExistenceProbe` block (free function in the module):

```rust
/// Production opencode locator: by-id check against
/// `<data_home>/opencode.db` via
/// `freshell_sessions::parse::session_exists_by_id` — read-only open, 250ms
/// busy timeout (NOT the listing's 5000ms; `exists()` is sync on the
/// reconcile path), no archived/parent/directory filters (attach parity:
/// opencode's session.get has none of them). Missing DB file => `Absent`
/// (opencode never ran); any read error => `Unreadable` (=> the probe
/// answers `Unknown`).
pub fn opencode_db_locator(data_home: PathBuf) -> OpencodeSessionLocator {
    Arc::new(move |session_id: &str| {
        match freshell_sessions::parse::session_exists_by_id(&data_home, session_id) {
            Ok(true) => OpencodeDbAnswer::Present,
            Ok(false) => OpencodeDbAnswer::Absent,
            Err(_) => OpencodeDbAnswer::Unreadable,
        }
    })
}
```

**(g)** Fallback logic in `exists()` — in the warm `Some(items)` arm, insert between the closing brace of the `if provider == "claude" { ... }` block (~line 170) and the final `SessionExistence::Absent` (~line 171):

```rust
                // Opencode by-id fallback (rebind dead-session fix): the
                // index listing is root-filtered (`parent_id IS NULL`,
                // parse/opencode.rs) and drops directory-less rows, so a
                // rebound CHILD session id — or a cwd-less root — is
                // DB-present yet index-invisible and the warm snapshot
                // answers a false Absent, while the attach arm
                // (`opencode --session <id>` -> session.get by id, no
                // parent/directory/archived filters) resolves it. The two
                // arms must agree: before finalizing Absent for
                // opencode, consult the SAME by-id DB truth. An unreadable
                // DB (WAL lock contention, corruption) is honest Unknown —
                // reconcile's bounded deferral retries — NEVER Absent. The
                // listing's root-only query itself stays intact for History.
                if provider == "opencode" {
                    if let Some(locator) = &self.opencode_session_locator {
                        match locator(session_id) {
                            OpencodeDbAnswer::Present => {
                                // A fallback hit is an on-disk observation:
                                // feed the monotone observed-set (module-doc
                                // invariant), same as the claude arm above.
                                self.observed
                                    .lock()
                                    .expect("observed set lock")
                                    .insert(format!("{provider}:{session_id}"));
                                return SessionExistence::Present;
                            }
                            OpencodeDbAnswer::Unreadable => {
                                return SessionExistence::Unknown;
                            }
                            OpencodeDbAnswer::Absent => {}
                        }
                    }
                }
                SessionExistence::Absent
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p freshell-server --bin freshell-server existence`

Expected: PASS — all existing existence tests plus the 9 new ones, 0 failures.

- [ ] **Step 5: Wire the production locator in main.rs**

In `crates/freshell-server/src/main.rs`, at the probe construction site inside the `WsState { .. }` literal (~lines 548-600), the chain currently ends:

```rust
                .with_claude_transcript_locator(std::sync::Arc::new(|session_id: &str| {
                    freshell_freshagent::locate_transcript(session_id)
                })),
```

Change it to (move the comma to the new last call):

```rust
                .with_claude_transcript_locator(std::sync::Arc::new(|session_id: &str| {
                    freshell_freshagent::locate_transcript(session_id)
                }))
                // Opencode rebind fix: the SAME by-id DB truth the attach arm
                // trusts (`opencode --session <id>` resolves children and
                // directory-less roots the root-filtered listing hides), so
                // reconcile and attach can never disagree about whether an
                // opencode session exists. Points at the SAME data home the
                // OpencodeSource above uses. Unreadable DB => Unknown
                // (bounded deferral), never a false dead_session.
                .with_opencode_session_locator(existence::opencode_db_locator(
                    freshell_sessions::parse::default_opencode_data_home(),
                )),
```

Run: `cargo check -p freshell-server`

Expected: compiles clean.

- [ ] **Step 6: Format, lint, commit**

```bash
cargo fmt --all
cargo clippy -p freshell-server --all-targets -- -D warnings
git add crates/freshell-server/src/existence.rs crates/freshell-server/src/main.rs
git commit -m "fix(server): opencode by-id DB fallback in the existence probe"
```

Expected: clippy clean; commit succeeds.

---

### Task 3: Promote the spike test as the end-to-end proof, then full verification

Promote `spike_child_session_rebound_pane_restart_verdict` (branch `spike/child-session-restart`, commit `d505ad0c`) into the tree with its assertions FLIPPED to the fixed behavior. The spike, committed on that branch, is the historical RED proof against unfixed code: child claim → `DeadSession{session_not_on_disk}`, stale root claim → chain-corrected to the child and ALSO dead. The promoted test asserts the fix: child claim → `Respawn` at the child; stale superseded-root claim → `Respawn` at the child with `corrected: Some(true)`; control never-rebound root → `Respawn`. It is the only test exercising real probe + real ledger + real `derive_verdicts` together. Fetch the original with `git show spike/child-session-restart:crates/freshell-server/src/existence.rs` if you want to diff against the adaptation below (do not merge or push that branch).

**Files:**
- Modify: `crates/freshell-server/src/existence.rs` (one test appended to `mod tests`)
- Test: same file

**Interfaces:**
- Consumes: `opencode_db_locator` (Task 2); `seed_opencode_db` is NOT used here — the test keeps the spike's inline fixture so it stays a self-contained end-to-end artifact; `freshell_ws::{pane_ledger, reconcile, identity}`, `freshell_terminal::TerminalRegistry`, `freshell_protocol::{ReconcilePane, ReconcileVerdict, SessionLocator}`, `freshell_sessions::directory_index::OpencodeSource` (all function-local `use`, as in the spike).
- Produces: nothing consumed later — this is the acceptance proof.

- [ ] **Step 1: Write the promoted test**

Append to `mod tests` in `crates/freshell-server/src/existence.rs`:

```rust
    /// END-TO-END proof of the opencode rebind dead-session fix (promoted
    /// from spike/child-session-restart @ d505ad0c, which proved the RED
    /// state against unfixed code: the child claim derived
    /// DeadSession{session_not_on_disk} and chain-correction buried the
    /// superseded root too). After a pane is rebound (signal lane) to a
    /// CHILD session id, a restart must Respawn it — and a stale claim for
    /// the superseded ROOT must chain-correct (rung 2b) to the child and
    /// Respawn there.
    ///
    /// Real components end-to-end — NO fakes for the probe, index, listing,
    /// ledger, locator, or verdict derivation:
    ///   real `OpencodeSource` over a temp `opencode.db` -> real
    ///   `SessionIndex` -> real `IndexExistenceProbe` with the production
    ///   `opencode_db_locator` + real `PaneLedger` (post-rebind state via
    ///   `resolve_pending`, the SAME API the signal rebind lane's write hook
    ///   calls) -> real `freshell_ws::reconcile::derive_verdicts` with
    ///   restart-empty terminal/identity registries.
    #[tokio::test]
    async fn child_session_rebound_pane_restart_yields_respawn() {
        use freshell_protocol::{ReconcilePane, ReconcileVerdict, SessionLocator};
        use freshell_sessions::directory_index::OpencodeSource;
        use freshell_terminal::TerminalRegistry;
        use freshell_ws::identity::TerminalIdentityRegistry;
        use freshell_ws::pane_ledger::{BindingWrite, PaneLedger, RetiredReason, RowState};
        use freshell_ws::reconcile::{derive_verdicts, ReconcileDeps};

        // Opencode-shaped ids: ses_ + 26 alphanumerics.
        const ROOT: &str = "ses_root0000000000000000000000";
        const CHILD: &str = "ses_child000000000000000000000"; // parent_id = ROOT
        const ROOT2: &str = "ses_root2222222222222222222222"; // control: never rebound

        // -- 1. Temp opencode data home: root + child (subagent) rows ------
        let base = std::env::temp_dir().join(format!(
            "freshell-child-restart-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let data_home = base.join("opencode");
        std::fs::create_dir_all(&data_home).expect("mkdir opencode data home");
        let cwd_dir = base.join("proj");
        std::fs::create_dir_all(&cwd_dir).expect("mkdir cwd");
        let cwd = cwd_dir.to_string_lossy().to_string();
        {
            // Same schema shape as crates/freshell-sessions/tests/
            // opencode_sqlite.rs `create_full_schema` (includes parent_id).
            let conn =
                rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
            conn.execute_batch(
                "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
                 CREATE TABLE session (
                    id TEXT PRIMARY KEY,
                    directory TEXT,
                    title TEXT,
                    time_created INTEGER,
                    time_updated INTEGER,
                    time_archived INTEGER,
                    project_id TEXT,
                    parent_id TEXT
                 );
                 CREATE TABLE part (session_id TEXT, data TEXT);
                 CREATE TABLE message (session_id TEXT, data TEXT);",
            )
            .expect("create schema");
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'Root', 1000, 5000, NULL, NULL, NULL)",
                rusqlite::params![ROOT, cwd],
            )
            .expect("insert root");
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'Child (subagent)', 2000, 6000, NULL, NULL, ?3)",
                rusqlite::params![CHILD, cwd, ROOT],
            )
            .expect("insert child");
            conn.execute(
                "INSERT INTO session VALUES (?1, ?2, 'Root 2', 1000, 4000, NULL, NULL, NULL)",
                rusqlite::params![ROOT2, cwd],
            )
            .expect("insert root2");
        }

        // -- 2. Real SessionIndex over the real OpencodeSource -------------
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(OpencodeSource::new(data_home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));

        // -- 3. Real PaneLedger with the post-rebind state ------------------
        // Faithful reproduction of the signal lane's writes, via the SAME
        // API `ledger_resolve_identity` calls (`resolve_pending`), in the
        // production order: pending marker at spawn -> first-bind resolution
        // to ROOT -> signal rebind to CHILD (child bound row FIRST, then
        // ROOT retired as Superseded{supersededBy}).
        let ledger_root = base.join("ledger");
        std::fs::create_dir_all(&ledger_root).expect("mkdir ledger root");
        let ledger = Arc::new(PaneLedger::new(Some(ledger_root)));
        ledger
            .record_pending("t-pane1", "opencode", Some(&cwd), 1_000)
            .expect("pending marker");
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: ROOT,
                terminal_id: "t-pane1",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                now_ms: 2_000,
            })
            .expect("first bind: root");
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: CHILD,
                terminal_id: "t-pane1",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                now_ms: 3_000,
            })
            .expect("signal rebind: child");
        // Control pane: ROOT2 bound to its own terminal, never superseded.
        ledger
            .resolve_pending(&BindingWrite {
                provider: "opencode",
                session_id: ROOT2,
                terminal_id: "t-pane2",
                mode: "opencode",
                cwd: Some(&cwd),
                create_request_id: None,
                now_ms: 2_500,
            })
            .expect("control bind: root2");

        // Sanity: the ledger holds the exact post-rebind shape the signal
        // lane produces (old row Retired/Superseded -> child; child Bound).
        let old = ledger
            .load_binding("opencode", ROOT)
            .expect("root row exists");
        assert_eq!(old.state, RowState::Retired);
        assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
        assert_eq!(
            old.superseded_by.as_ref().map(|l| l.session_id.as_str()),
            Some(CHILD)
        );
        let new = ledger
            .load_binding("opencode", CHILD)
            .expect("child row exists");
        assert_eq!(new.state, RowState::Bound);

        // -- 4. Real probe: index + ledger + PRODUCTION opencode locator ---
        let probe = IndexExistenceProbe::new(
            Arc::clone(&index),
            Some(Arc::clone(&ledger)),
            HashMap::from([("opencode".to_string(), data_home.clone())]),
        )
        .with_opencode_session_locator(opencode_db_locator(data_home.clone()));

        // Cold-index path stays honest Unknown — the fallback lives ONLY in
        // the warm-snapshot arm and must never manufacture answers before
        // the index publishes.
        assert_eq!(
            probe.exists("opencode", CHILD),
            SessionExistence::Unknown,
            "cold index answers Unknown, never a guessed Absent or a \
             fallback-manufactured Present"
        );

        index.warm().await;

        // -- 5. Probe answers after restart ---------------------------------
        assert_eq!(
            probe.exists("opencode", ROOT),
            SessionExistence::Present,
            "root session (parent_id NULL) is listed by the opencode source"
        );
        assert_eq!(
            probe.exists("opencode", CHILD),
            SessionExistence::Present,
            "THE FIX: the child row is hidden from the listing by the \
             `parent_id IS NULL` root filter, but the by-id DB fallback \
             finds it — the probe now agrees with the attach arm"
        );
        assert!(probe.ever_observed("opencode", CHILD));

        // -- 6. Restart-shaped reconcile through the REAL derivation --------
        // Empty registries: no terminal survives a server restart.
        let registry = TerminalRegistry::new();
        let identity = TerminalIdentityRegistry::new();
        let deps = ReconcileDeps {
            registry: &registry,
            identity: &identity,
            existence: &probe,
            pane_ledger: &ledger,
            fresh_agent: None,
        };
        let pane = |n: u32, sid: &str| ReconcilePane {
            pane_key: format!("pane-{n}"),
            kind: Some("terminal".to_string()),
            mode: Some("opencode".to_string()),
            create_request_id: Some(format!("cr-{n}")),
            terminal_id: Some(format!("t-pane{n}")),
            server_instance_id: None,
            session_ref: Some(SessionLocator {
                provider: "opencode".to_string(),
                session_id: sid.to_string(),
            }),
            resume_session_id: None,
            status: None,
        };
        let verdicts = derive_verdicts(
            &deps,
            &[
                pane(1, CHILD), // the rebound pane presenting its child bookmark
                pane(2, ROOT2), // control: a plain root-session pane
                pane(3, ROOT),  // a stale claim for the superseded ROOT
            ],
        );

        // (a) The rebound pane's child bookmark survives: Respawn AT the child.
        assert_eq!(
            verdicts[0].verdict,
            ReconcileVerdict::Respawn,
            "child-rebound pane after restart: got {:?} (reason {:?})",
            verdicts[0].verdict,
            verdicts[0].reason
        );
        assert_eq!(
            verdicts[0]
                .session_ref
                .as_ref()
                .map(|l| l.session_id.as_str()),
            Some(CHILD)
        );

        // (b) Control: a never-rebound root-session pane stays Respawn.
        assert_eq!(
            verdicts[1].verdict,
            ReconcileVerdict::Respawn,
            "control root pane after restart: got {:?} (reason {:?})",
            verdicts[1].verdict,
            verdicts[1].reason
        );
        assert_eq!(
            verdicts[1]
                .session_ref
                .as_ref()
                .map(|l| l.session_id.as_str()),
            Some(ROOT2)
        );

        // (c) The stale superseded-ROOT claim is chain-corrected (ledger
        // rung 2b) to the child terminus — which the fallback now finds —
        // so it Respawns AT the child, marked corrected. No more chain
        // poisoning: one rebind no longer buries both bookmarks.
        assert_eq!(
            verdicts[2].verdict,
            ReconcileVerdict::Respawn,
            "stale superseded-root claim after restart: got {:?} (reason {:?})",
            verdicts[2].verdict,
            verdicts[2].reason
        );
        assert_eq!(
            verdicts[2]
                .session_ref
                .as_ref()
                .map(|l| l.session_id.as_str()),
            Some(CHILD),
            "the superseded ROOT claim resolves to the CHILD chain terminus"
        );
        assert_eq!(
            verdicts[2].corrected,
            Some(true),
            "the server overrode the differing client claim"
        );

        let _ = std::fs::remove_dir_all(&base);
    }
```

- [ ] **Step 2: Run the promoted test**

Run: `cargo test -p freshell-server --bin freshell-server existence::tests::child_session_rebound_pane_restart_yields_respawn`

Expected: PASS. (Its RED counterpart is commit `d505ad0c` on `spike/child-session-restart`, which asserts the inverse verdicts and passed against unfixed code — the defect proof. If THIS test fails, the fix is wrong: debug the fix, do not weaken the assertions. If the `verdicts[2].corrected` assertion specifically fails while verdict and session_ref pass, inspect `corrected_flag` in `crates/freshell-ws/src/reconcile.rs` (~:94-99: `Some(true)` iff claim present AND server ref present AND different) and fix the test's expectation only if the production semantics genuinely differ — record why in the test comment.)

- [ ] **Step 3: Full workspace verification**

```bash
cargo fmt --all --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
```

Expected: all clean. `cargo test --workspace` is long (cold target dir: tens of minutes); use a generous timeout. Known pre-existing flake: the `freshell-ws` test target `auto_resume_e2e` under load — if it alone fails, retry once (`cargo test -p freshell-ws --test auto_resume_e2e`) before treating it as a regression. `cargo test` is not coordinator-gated (no npm coordination needed).

- [ ] **Step 4: Commit**

```bash
git add crates/freshell-server/src/existence.rs
git commit -m "test(server): end-to-end proof — rebound child opencode pane survives restart"
```

Expected: commit succeeds.

---

### Task 4: Opt-in real-provider contract test — the attach-arm premise

The fix's premise is that opencode's attach arm resolves CHILD session ids: `opencode --session <id>` → session.get by id, children included. Validate it against the REAL opencode binary, following the existing `test/integration/real/` pattern (opt-in via `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1`, skipped by default). **HALT RULE: if the real binary REFUSES a child session id (the final assertion fails on a genuine refusal, not a flake), STOP the plan and surface it loudly — the fix's premise would be wrong and Tasks 1-3 must not ship on it.**

This file is TypeScript, but it is an opt-in external-provider contract test (not client/server TS): the coordinated npm suite is NOT required; run only this file.

**Files:**
- Modify: `test/integration/real/coding-cli-session-contract.test.ts` (add one `it(...)` inside the existing opencode `describe` lane, ~lines 576-710)
- Test: same file (vitest, `config/vitest/vitest.server.config.ts`)

**Interfaces:**
- Consumes: the existing harness `test/helpers/coding-cli/real-session-contract-harness.js` — `ProbeWorkspace.create`, `seedOpencodeHomes`, `startOpencodeServe`, `waitForOpencodeDbSession`, `waitForJsonLine`, `requireAvailableBinary` (already imported at the top of the test file). The gate variables `opencodeProbe`, `realProviderContractsEnabled`, `opencodeBinary` and the `describeOpencode` lane already exist in the file.
- Produces: nothing consumed later — external-behavior validation.

- [ ] **Step 1: Read the existing opencode lane and harness signatures**

Read `test/integration/real/coding-cli-session-contract.test.ts` (the `describeOpencode` block, ~lines 576-710) and the exports used from `test/helpers/coding-cli/real-session-contract-harness.js` — specifically the exact signatures/return shapes of `startOpencodeServe`, `waitForOpencodeDbSession`, `ProbeWorkspace` (spawn/cleanup methods), and how the existing opencode test tears down. The code in Step 2 is normative for structure and assertions; match call signatures to what the harness actually exports.

- [ ] **Step 2: Write the failing (skipped-by-default) test**

Add inside the existing `describeOpencode(...)` block, after the last existing `it(...)`:

```ts
    // Attach-arm premise of freshell's opencode existence fallback
    // (crates/freshell-server/src/existence.rs): `opencode run --session <id>`
    // resolves session ids by id — INCLUDING child sessions (parent_id set),
    // which opencode's own list surfaces hide. If this test genuinely fails
    // (opencode refuses a child id), the fallback's premise is wrong: STOP
    // and surface, do not ship the fallback on it.
    it('resolves a CHILD session id (parent_id set) via --session', async () => {
      const opencodePath = requireAvailableBinary(opencodeBinary, opencodeProbe)
      const workspace = await ProbeWorkspace.create('opencode-child-attach')
      try {
        const homes = await seedOpencodeHomes(workspace)
        const runEnv = {
          XDG_DATA_HOME: homes.dataHome,
          XDG_CONFIG_HOME: homes.configHome,
        }

        // 1. Create a ROOT session with the real CLI.
        const rootRun = await workspace.spawnProcess(
          opencodePath,
          [
            'run',
            'Reply with exactly: child-attach-root-ok',
            '--format',
            'json',
            '--dangerously-skip-permissions',
          ],
          { env: runEnv },
        )
        const rootStep = await waitForJsonLine(rootRun, (value) => value?.type === 'step_start', 60_000)
        const rootSessionId = rootStep.sessionID as string
        expect(rootSessionId).toMatch(/^ses_/)
        expect((await rootRun.waitForExit(60_000)).code).toBe(0)

        // 2. Create a real CHILD session (parent_id = root) via the real
        //    opencode server API — the same session.create surface the TUI's
        //    subagent/task flows use.
        const serve = await startOpencodeServe(workspace, runEnv)
        const createResponse = await fetch(`${serve.baseUrl}/session`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ parentID: rootSessionId, title: 'child-attach-probe' }),
        })
        expect(createResponse.ok).toBe(true)
        const created = await createResponse.json() as { id: string }
        const childSessionId = created.id
        expect(childSessionId).toMatch(/^ses_/)
        expect(childSessionId).not.toBe(rootSessionId)

        // 3. Verify the child row landed in sqlite with parent_id = root.
        const childRow = await waitForOpencodeDbSession(homes.dbPath, childSessionId)
        expect(childRow.parent_id ?? childRow.parentID).toBe(rootSessionId)

        // 4. THE PREMISE: the real CLI resolves the CHILD id via --session.
        const childRun = await workspace.spawnProcess(
          opencodePath,
          [
            'run',
            '--session',
            childSessionId,
            'Reply with exactly: child-attach-ok',
            '--format',
            'json',
            '--dangerously-skip-permissions',
          ],
          { env: runEnv },
        )
        const childStep = await waitForJsonLine(childRun, (value) => value?.type === 'step_start', 60_000)
        expect(childStep.sessionID).toBe(childSessionId)
        expect((await childRun.waitForExit(60_000)).code).toBe(0)
      } finally {
        await workspace.cleanup()
      }
    }, 300_000)
```

Adapt mechanics to the file's actual conventions found in Step 1: if `startOpencodeServe` returns a differently-named base-URL field or requires stop/teardown, follow the existing opencode test's usage; if `waitForOpencodeDbSession` returns camelCase columns, keep the `parent_id ?? parentID` tolerance or match its actual shape; if `ProbeWorkspace` cleanup is named differently (e.g. `dispose`), use that. If the installed opencode's serve API does not accept `parentID` on `POST /session` (check its OpenAPI document at `${serve.baseUrl}/doc` before concluding), child creation is not scriptable: per the locked scope decision, REMOVE this test, and record the rationale (what was attempted, what the API offered) in the commit message and in a comment where the test would have been. Do NOT fake the child by inserting a sqlite row yourself — a synthetic row validates nothing about the real attach arm.

- [ ] **Step 3: Verify the gated-off (default) path**

Run: `npm run test:vitest -- run test/integration/real/coding-cli-session-contract.test.ts --config config/vitest/vitest.server.config.ts`

Expected: the always-run "lab note" tests pass; every opencode/codex/claude provider lane (including the new test) reports SKIPPED (env gate off). No failures.

- [ ] **Step 4: Attempt the opt-in real run**

Run: `FRESHELL_RUN_REAL_PROVIDER_CONTRACTS=1 npm run test:vitest -- run test/integration/real/coding-cli-session-contract.test.ts --config config/vitest/vitest.server.config.ts`

Expected, in order of preference:
- opencode binary + auth available: the new test PASSES (premise validated). If it FAILS because opencode refuses the child id: **HALT the plan and surface** (see task preamble).
- opencode binary unavailable or unauthenticated in this environment: the lane self-skips with its reason in the describe title. Record honestly in the task notes that the premise test exists but could not be executed here — do not claim validation.

- [ ] **Step 5: Commit**

```bash
git add test/integration/real/coding-cli-session-contract.test.ts
git commit -m "test(real): opencode resolves child session ids via --session (fallback premise)"
```

Expected: commit succeeds. (If Step 2's infeasibility branch was taken, the commit instead carries the rationale comment and message.)

---

## Self-Review (performed at plan-writing time)

**1. Spec coverage.**
- By-id fallback, warm-Absent + provider-gated, locator-injected, wired in main.rs at the same data home as OpencodeSource → Task 2 (spec pin 1). ✔
- Query with no parent_id/directory/archived filters. DEVIATION FROM THE ORIGINAL SPEC PIN, evidence-forced: the spec's archived ⇒ Absent pin assumed the attach arm refuses archived sessions; load-bearing validation FALSIFIED that against real opencode v1.18.9 (`Session.get` has no archived filter — session.ts:542-546 vs listGlobal :564 — and a live attach to an archived session succeeded; reports/validator-V1.md). The spec's overriding principle ("the SAME truth the attach arm trusts") therefore requires archived ⇒ Present, pinned by tests at both layers. Schema variance: the query references only `id`, so legacy schemas lacking `time_archived` answer normally (pinned) → Tasks 1-2 (spec pin 2, arm-agreement principle preserved). ✔
- Error semantics: missing file ⇒ Absent; any read failure ⇒ Unknown never Absent; read-only open; 250ms busy timeout → Tasks 1-2 (spec pin 3). ✔
- Fallback hit feeds monotone observed-set → Task 2 test `opencode_fallback_present_feeds_ever_observed` (spec pin 4). ✔
- Provider gating with claude AND codex mirrors of `codex_absent_never_consults_the_claude_locator` → Task 2 (spec pin 5). ✔
- Memoization → explicitly skipped with rationale in Global Constraints (spec pin 6 allows). ✔
- Red tests 1-6 from the spec: promoted spike (Task 3), quartet (Task 2), directory-less root (Tasks 1+2), archived pinned as Present/attach-parity (Tasks 1+2, per the falsified-A5 deviation above), unreadable ⇒ Unknown + missing file ⇒ Absent (Tasks 1+2), real-provider contract with halt rule (Task 4). ✔
- Out-of-scope exclusions restated in Global Constraints so no task drifts into them. ✔

**1b. No silent deferrals.** The production outcome — a rebound child pane surviving a freshell restart as `Respawn` — is proven by Task 3's end-to-end test using the REAL index, listing, ledger, production locator, and verdict derivation over a real sqlite file (no fakes). Task 2's two closure doubles exist only in the provider-gating tests (`OpencodeDbAnswer::Present` for a foreign provider), where a double is the point: proving the locator is never consulted; every Present/Absent/Unknown path is tested through the production `opencode_db_locator`. The one requirement not always executable locally is Task 4's real-binary run (external CLI availability); it is spec-sanctioned as opt-in with an explicit halt-on-refusal rule and an honest-reporting step, not a silent deferral. No UNRESOLVED COVERAGE GAPS.

**2. Placeholder scan.** No TBD/TODO/"handle edge cases"/"similar to Task N" items. Task 4 Step 2 contains one bounded adapt-to-harness instruction and one spec-sanctioned infeasibility branch; both state exactly what to check and what to do. All code steps show complete code.

**3. Type consistency.** `OpencodeDbAnswer::{Present, Absent, Unreadable}`, `OpencodeSessionLocator`, `with_opencode_session_locator`, `opencode_db_locator(PathBuf)`, `session_exists_by_id(&Path, &str) -> Result<bool, OpencodeReadError>` are used with identical names/signatures across Tasks 1-3; `SessionExistence` variants and `PaneVerdict` fields match `origin/main` definitions (verified against the current sources). Task 2's helper tuple order (id, directory, parent_id, time_archived) matches its INSERT binding (`?1, ?2, ... ?4 ... ?3`) — note `?3`=parent_id, `?4`=time_archived, params in tuple order.
