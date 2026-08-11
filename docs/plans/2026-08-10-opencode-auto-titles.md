# OpenCode Auto-Titles Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make opencode sessions receive Gemini AI auto-titles (Gap A) and let
opencode's own native session names surface in freshell as provider-generated
titles (Gap B), with the title-precedence ladder (`user > ai >
provider-generated/first-message > dir`) proven by tests.

**Architecture:** Both gaps are data gaps in the `freshell-sessions` crate, not
sweep-logic gaps. The auto-title sweep, ladder, and shadow guard in
`freshell-server` are already provider-agnostic and behave correctly once
opencode sessions carry (1) a `first_user_message` (bounded extraction from
opencode.db's `message`/`part` tables, only for sessions that still need
naming) and (2) `title_source: Some("provider-generated")` when opencode has
already named the session (any title that is not the `New session - <ISO>`
placeholder). No production change to `freshell-server` is needed; it gains
sweep-level tests pinning the reconciliation semantics.

**Tech Stack:** Rust, rusqlite 0.31 (`bundled`, SQLite JSON functions
built-in), tokio tests, trait-injected `FakeGemini` (zero live AI calls).

## Global Constraints

- `server/` and `shared/` are the frozen Node reference for the port oracle —
  they must stay **byte-untouched** (`git diff origin/main --stat -- server/ shared/`
  must be empty at the end).
- `~/.local/share/opencode/opencode.db` is **live production data** (5.7 GB,
  WAL, owned by a running opencode install): read-only always. Manual checks
  use `sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro"` +
  `PRAGMA query_only=ON`. Production code opens with
  `OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI` (existing
  pattern). Never write, never take long locks, never VACUUM/ANALYZE.
- Listing-path cost must stay **bounded** on multi-GB DBs: no unbounded
  `message`/`part` scans in the hot listing query. First-message lookups run
  only for sessions that still need naming (empty or placeholder title) and
  use indexed per-session lookups (measured ~0.09–0.5 ms/session on the real
  5.7 GB DB; re-measure in Task 5 and record).
- First-message text must be normalized via
  `freshell_sessions::text::normalize_first_user_message` (trim, `None` if
  empty, truncate to 4000 chars) so ladder behavior matches other providers.
- Gemini is **never** called live in tests: use the existing trait-injected
  `FakeGemini` harness in `auto_title_sweep.rs` tests. No HTTP-mock crates
  (workspace convention).
- PROCESS SAFETY: never broad-kill; never touch the live freshell server on
  port 3001 or live opencode processes; any test process is killed by PID
  only if this work spawned it. (No test server is expected to be needed.)
- No new dependencies. rusqlite stays `0.31`, features `["bundled"]`.
- CI gates (all must be green): `cargo test --workspace`,
  `cargo clippy --workspace --all-targets -- -D warnings`,
  `cargo fmt --all --check`.
- Client (`src/`) is not touched by this fix — the npm suite is NOT required.
- Normal mainline work: worktree branch `opencode-auto-titles` (already
  created from `origin/main`), PR targets `main`. **STOP after pushing the
  branch — PR creation needs explicit user approval.**
- Work inside the worktree: `/home/dan/code/freshell/.worktrees/opencode-auto-titles`.
  All commands below assume that as the working directory (use
  `git -C /home/dan/code/freshell/.worktrees/opencode-auto-titles ...` if cwd
  is uncertain).
- TDD red-green-refactor for every code change; frequent, focused commits.

## Scope Check

One subsystem (the auto-title data layer feeding one consumer, the sweep) —
one plan. Tasks 1–3 change `freshell-sessions`; Task 4 adds consumer-side
tests in `freshell-server`; Task 5 verifies, measures, and pushes.

## Verified Root Cause (re-verify file:line before coding — line numbers drift)

- `crates/freshell-sessions/src/directory_index.rs:678-710`
  `opencode_session_to_indexed` hardcodes `summary: None, first_user_message:
  None, title_source: None` ("faithful, not a gap" comments).
- `crates/freshell-sessions/src/parse/opencode.rs:193-209` listing SQL reads
  only `session` + `project` (plus marker `EXISTS` probes of `part`/`message`).
- `crates/freshell-server/src/auto_title.rs:129-135` `should_generate_ai`
  requires a non-empty `first_user_message` AND
  `parsed_title_source != Some("provider-generated")`.
- `crates/freshell-server/src/auto_title_sweep.rs:388-406` wraps the Gemini
  spawn in `if let Some(first) = s.first_user_message.clone()` → silent skip.
- `crates/freshell-server/src/auto_title_sweep.rs:483-505`
  `overlay_session_title` shadow guard: an override row loses to the parsed
  title only when parsed source is `"provider-generated"` AND row source is
  `"dir"`/`"first-message"` — never fires for opencode today
  (`title_source: None`).
- Parity pins that must be honestly replaced (not deleted-and-forgotten):
  `directory_index.rs:2738` `opencode_source_preserves_none_first_user_message_parity`
  and the `first_user_message == None` assert inside
  `opencode_source_direct_lists_and_maps_fields` (`directory_index.rs:2714`,
  assert at `:2731`).
- opencode.db real schema (verified read-only on the live 5.7 GB DB):
  `message(id PK, session_id, time_created, time_updated, data)` with index
  `message_session_time_created_id_idx(session_id, time_created, id)`;
  `part(id PK, message_id, session_id, time_created, time_updated, data)` with
  index `part_message_id_id_idx(message_id, id)`. `$.role` lives in message
  JSON `data`; `$.type`/`$.text`/`$.synthetic` live in part JSON `data`.
  **Trap:** synthetic text parts (`"synthetic": true` — opencode-injected
  tool-narration) sort BEFORE the real prompt in ~40% of recent sessions and
  must be filtered. `session.title` is a `TEXT NOT NULL` real column; the
  placeholder shape is `New session - <ISO-8601 ms UTC>` (JS
  `new Date(time_created).toISOString()`, exactly 24 chars after the prefix).

## Design Decisions (locked)

1. **Placeholder-gated extraction.** Fetch `first_user_message` ONLY for
   sessions whose title is empty/placeholder. Named sessions become
   `provider-generated` and the AI stage short-circuits, so they never need a
   first message. This bounds listing cost to the unnamed subset (175 of 2913
   sessions on the live DB ⇒ ~16 ms total, measured).
2. **`summary` stays `None` for opencode.** Nothing in the title ladder
   consumes it, and opencode's `summary_*` columns are diff stats, not text.
   YAGNI.
3. **`title_provider_generated` (bool) and `title_source` (string) express the
   same predicate** (per `parse/claude.rs:526-528` convention) — set both.
4. **Graceful degradation.** Any schema/query failure in the first-message
   lookup yields `None` (session just keeps the dir-placeholder behavior);
   listing never breaks. No new `OpencodeDegrade` variants.
5. **No sweep production changes.** `run_auto_title_pass`,
   `compute_auto_title_patch`, `should_generate_ai`, `overlay_session_title`
   already implement the required semantics; opencode inherits exact
   claude/amplifier provider-generated behavior (including the harmless
   claude-parity dir row that the shadow guard suppresses at display time).
6. **Deviation documentation.** This is deliberate mainline deviation from the
   retired Node reference. Plain code comments document it at each changed
   site; `port/oracle/DEVIATIONS.md` gets a note ONLY if that campaign file
   still exists and pins opencode listing behavior (checked in Task 5).

## File Structure

- Modify: `crates/freshell-sessions/src/parse/opencode.rs` — placeholder
  classifier, bounded first-message lookup, `OpencodeSession.first_user_message`
  field, wiring in `list_sessions`, new unit-test module.
- Modify: `crates/freshell-sessions/src/parse/mod.rs` — add
  `is_opencode_placeholder_title` to the existing `pub use opencode::{...}`
  re-export list.
- Create: `crates/freshell-sessions/tests/opencode_first_message.rs` —
  integration tests through the public `OpencodeProvider::list_sessions` API
  with realistic message/part fixture schema.
- Modify: `crates/freshell-sessions/src/directory_index.rs` —
  `opencode_session_to_indexed` mapping, `IndexedSession::title_source` doc
  comment, replace parity tests, add message-seeding test helper.
- Modify: `crates/freshell-server/src/auto_title_sweep.rs` — **tests only**
  (sweep-level ladder-precedence tests + end-to-end fixture-DB test).

---

### Task 1: Placeholder-title classifier

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs`
- Modify: `crates/freshell-sessions/src/parse/mod.rs`

**Interfaces:**
- Consumes: nothing new.
- Produces: `pub fn is_opencode_placeholder_title(title: &str) -> bool` in
  `parse/opencode.rs`, re-exported as
  `freshell_sessions::parse::is_opencode_placeholder_title`. Task 2 gates the
  message lookup on it; Task 3 classifies provider-generated titles with it.

- [ ] **Step 1: Write the failing tests**

Add a new test module at the bottom of
`crates/freshell-sessions/src/parse/opencode.rs` (alongside the existing
`mod home_dir_tests`):

```rust
#[cfg(test)]
mod placeholder_title_tests {
    use super::is_opencode_placeholder_title;

    #[test]
    fn matches_opencode_default_placeholder() {
        assert!(is_opencode_placeholder_title(
            "New session - 2026-08-10T23:47:23.950Z"
        ));
        assert!(is_opencode_placeholder_title(
            "New session - 1970-01-01T00:00:00.000Z"
        ));
    }

    #[test]
    fn rejects_real_titles_and_near_misses() {
        assert!(!is_opencode_placeholder_title("Syncing repos with remote main"));
        assert!(!is_opencode_placeholder_title("darkforge-plan-review"));
        assert!(!is_opencode_placeholder_title(""));
        // prefix alone is not enough -- a user could name a session this way
        assert!(!is_opencode_placeholder_title("New session - my notes"));
        assert!(!is_opencode_placeholder_title("New session - 2026-08-10"));
        // seconds precision / no ms / no Z -- not toISOString() output
        assert!(!is_opencode_placeholder_title("New session - 2026-08-10T23:47:23Z"));
        // wrong case in prefix
        assert!(!is_opencode_placeholder_title(
            "new session - 2026-08-10T23:47:23.950Z"
        ));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions placeholder_title_tests -- --nocapture`
Expected: FAIL to compile with "cannot find function `is_opencode_placeholder_title`".

- [ ] **Step 3: Write the implementation**

Add near the other pub helpers in `parse/opencode.rs` (e.g. below
`THREE_VIEWS_MARKER_SQL_PATTERN`):

```rust
/// opencode's own default title for a session it has not yet named:
/// `New session - <ISO-8601 UTC ms>`, e.g.
/// `New session - 2026-08-10T23:47:23.950Z` -- JS
/// `new Date(time_created).toISOString()`, always exactly 24 chars after
/// the prefix. A NON-placeholder title is a real opencode session name
/// (opencode retitles sessions itself after the first exchange); the
/// directory index surfaces those as provider-generated. Deliberate
/// mainline deviation: the retired Node reference never classified
/// opencode titles at all.
pub fn is_opencode_placeholder_title(title: &str) -> bool {
    let Some(rest) = title.strip_prefix("New session - ") else {
        return false;
    };
    let b = rest.as_bytes();
    const DIGITS: [usize; 17] = [
        0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18, 20, 21, 22,
    ];
    b.len() == 24
        && b[4] == b'-'
        && b[7] == b'-'
        && b[10] == b'T'
        && b[13] == b':'
        && b[16] == b':'
        && b[19] == b'.'
        && b[23] == b'Z'
        && DIGITS.iter().all(|&i| b[i].is_ascii_digit())
}
```

In `crates/freshell-sessions/src/parse/mod.rs`, add
`is_opencode_placeholder_title` to the existing re-export (keep alphabetical
position within the list):

```rust
pub use opencode::{
    default_opencode_data_home, is_opencode_placeholder_title,
    opencode_session_row_by_id, run_opencode_listing_query, session_exists_by_id,
    session_is_subagent_by_id, OpencodeByIdError, OpencodeByIdRow, OpencodeDegrade,
    OpencodeListing, OpencodeListingResult, OpencodeProvider, OpencodeReadError,
    OpencodeSession, OpencodeSessionRow, THREE_VIEWS_MARKER_SQL_PATTERN,
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions placeholder_title_tests -- --nocapture`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/src/parse/mod.rs
git commit -m "feat(sessions): recognize opencode's 'New session - <ISO>' placeholder titles"
```

---

### Task 2: Bounded first-user-message extraction in the opencode lister

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs`
- Create: `crates/freshell-sessions/tests/opencode_first_message.rs`

**Interfaces:**
- Consumes: `is_opencode_placeholder_title(&str) -> bool` (Task 1);
  `crate::text::normalize_first_user_message(content: &str) -> Option<String>`
  (existing, `crates/freshell-sessions/src/text.rs:98`, pub).
- Produces: `OpencodeSession` gains `pub first_user_message: Option<String>`
  (populated by `OpencodeProvider::list_sessions` only for sessions needing
  naming; Task 3 copies it into `IndexedSession`). Private helper
  `fn first_user_message_for_session(conn: &Connection, session_id: &str) -> Option<String>`.

- [ ] **Step 1: Write the failing integration tests**

Create `crates/freshell-sessions/tests/opencode_first_message.rs` with this
exact content:

```rust
//! Bounded first-user-message extraction from opencode.db message/part rows.
//!
//! Fixture DBs mirror the REAL opencode schema shape for `message`/`part`
//! (id / message_id / session_id / time_created as real columns; role /
//! type / text / synthetic inside the JSON `data` column). Built with a
//! writable connection, then read via the READ-ONLY parser -- same
//! convention as tests/opencode_sqlite.rs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use freshell_sessions::parse::OpencodeProvider;
use rusqlite::Connection;

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// A real temp dir that removes itself on drop (the fixture DBs live under it).
struct TmpDir(PathBuf);
impl TmpDir {
    fn new() -> Self {
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "freshell-sessions-ocfum-{}-{n}-{nanos}",
            std::process::id()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TmpDir(dir)
    }
}
impl std::ops::Deref for TmpDir {
    type Target = Path;
    fn deref(&self) -> &Path {
        &self.0
    }
}
impl Drop for TmpDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const PLACEHOLDER: &str = "New session - 2026-08-10T23:47:23.950Z";

/// Real-shape schema: message/part carry id + linkage + time as REAL columns
/// (matching the live opencode.db), with role/type/text/synthetic in JSON.
fn create_schema_with_messages(conn: &Connection) {
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
         CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
    )
    .unwrap();
}

fn insert_session(conn: &Connection, id: &str, title: &str) {
    conn.execute(
        "INSERT INTO session VALUES (?1, '/repo/x', ?2, 1000, 5000, NULL, NULL, NULL)",
        rusqlite::params![id, title],
    )
    .unwrap();
}

fn insert_message(conn: &Connection, id: &str, session_id: &str, time_created: i64, role: &str) {
    conn.execute(
        "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, session_id, time_created, format!("{{\"role\":\"{role}\"}}")],
    )
    .unwrap();
}

fn insert_part(conn: &Connection, id: &str, message_id: &str, session_id: &str, data: &str) {
    conn.execute(
        "INSERT INTO part VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, message_id, session_id, data],
    )
    .unwrap();
}

fn list_first(dir: &Path) -> freshell_sessions::parse::OpencodeSession {
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider.list_sessions(42).expect("read ok");
    assert_eq!(listing.sessions.len(), 1);
    listing.sessions.into_iter().next().unwrap()
}

#[test]
fn placeholder_session_extracts_first_user_message_skipping_synthetic_parts() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema_with_messages(&conn);
    insert_session(&conn, "ses_1", PLACEHOLDER);
    // assistant message sorts EARLIER -- must be skipped (role filter)
    insert_message(&conn, "msg_0", "ses_1", 50, "assistant");
    insert_part(
        &conn,
        "prt_0",
        "msg_0",
        "ses_1",
        r#"{"type":"text","text":"assistant text"}"#,
    );
    insert_message(&conn, "msg_1", "ses_1", 100, "user");
    // synthetic text part sorts BEFORE the real prompt -- must be skipped
    insert_part(
        &conn,
        "prt_1",
        "msg_1",
        "ses_1",
        r#"{"type":"text","text":"Called the Read tool","synthetic":true}"#,
    );
    // non-text part -- must be skipped
    insert_part(
        &conn,
        "prt_2",
        "msg_1",
        "ses_1",
        r#"{"type":"file","text":"not-a-text-part"}"#,
    );
    insert_part(
        &conn,
        "prt_3",
        "msg_1",
        "ses_1",
        r#"{"type":"text","text":"  This is a quick naming test  "}"#,
    );
    // a LATER user message must not win
    insert_message(&conn, "msg_2", "ses_1", 200, "user");
    insert_part(
        &conn,
        "prt_4",
        "msg_2",
        "ses_1",
        r#"{"type":"text","text":"second message"}"#,
    );
    drop(conn);
    let s = list_first(&dir);
    // trimmed by normalize_first_user_message
    assert_eq!(
        s.first_user_message.as_deref(),
        Some("This is a quick naming test")
    );
}

#[test]
fn named_session_skips_message_lookup_entirely() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema_with_messages(&conn);
    insert_session(&conn, "ses_1", "Fix login flow");
    // message rows EXIST, but a non-placeholder title must not pay the
    // per-session lookup (this is the bounded-listing guarantee)
    insert_message(&conn, "msg_1", "ses_1", 100, "user");
    insert_part(
        &conn,
        "prt_1",
        "msg_1",
        "ses_1",
        r#"{"type":"text","text":"hello"}"#,
    );
    drop(conn);
    let s = list_first(&dir);
    assert_eq!(s.first_user_message, None);
    assert_eq!(s.title.as_deref(), Some("Fix login flow"));
}

#[test]
fn placeholder_session_with_no_messages_yields_none() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema_with_messages(&conn);
    insert_session(&conn, "ses_1", PLACEHOLDER);
    drop(conn);
    let s = list_first(&dir);
    assert_eq!(s.first_user_message, None);
}

#[test]
fn legacy_schema_without_message_columns_degrades_to_none_without_error() {
    // tests/opencode_sqlite.rs's minimal marker-shape tables: message/part
    // WITHOUT id/message_id/time_created columns. The lookup must fail
    // soft (None) -- never break the listing.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );
         CREATE TABLE part (session_id TEXT, data TEXT);
         CREATE TABLE message (session_id TEXT, data TEXT);",
    )
    .unwrap();
    insert_session(&conn, "ses_1", PLACEHOLDER);
    conn.execute(
        "INSERT INTO message VALUES ('ses_1', '{\"role\":\"user\"}')",
        [],
    )
    .unwrap();
    drop(conn);
    let s = list_first(&dir);
    assert_eq!(s.first_user_message, None);
}

#[test]
fn first_user_message_is_normalized_to_4000_chars() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema_with_messages(&conn);
    insert_session(&conn, "ses_1", PLACEHOLDER);
    insert_message(&conn, "msg_1", "ses_1", 100, "user");
    let long = "x".repeat(4321);
    insert_part(
        &conn,
        "prt_1",
        "msg_1",
        "ses_1",
        &format!(r#"{{"type":"text","text":"{long}"}}"#),
    );
    drop(conn);
    let s = list_first(&dir);
    assert_eq!(
        s.first_user_message.as_deref().map(|m| m.chars().count()),
        Some(4000)
    );
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions --test opencode_first_message`
Expected: FAIL to compile with "no field `first_user_message` on type
`OpencodeSession`" (or similar missing-field error).

- [ ] **Step 3: Implement — struct field, lookup helper, wiring**

In `crates/freshell-sessions/src/parse/opencode.rs`:

(3a) Add the field to `OpencodeSession` (currently `opencode.rs:546-555`):

```rust
    /// First real (non-synthetic) user-message text, normalized via
    /// `crate::text::normalize_first_user_message`. Populated ONLY for
    /// sessions that still need naming (empty or `New session - <ISO>`
    /// placeholder titles) -- a bounded per-session indexed lookup, never
    /// a full message/part scan (opencode.db can be multi-GB). Feeds the
    /// first-message/AI rungs of freshell's auto-title ladder. Deliberate
    /// mainline deviation from the retired Node reference, which never
    /// read message content for opencode listings.
    pub first_user_message: Option<String>,
```

(3b) Add the lookup helper (near `run_opencode_listing_query`):

```rust
/// Bounded per-session lookup: the first text part of the earliest
/// user-role message. Uses the live schema's real indexed columns
/// (`message(session_id, time_created, id)` via
/// `message_session_time_created_id_idx`; `part(message_id, id)` via
/// `part_message_id_id_idx`) -- EXPLAIN QUERY PLAN shows index searches,
/// no scans. Measured on a production 5.7 GB opencode.db (126k messages /
/// 486k parts): ~0.09-0.5 ms per session; all 175 placeholder sessions in
/// ~16 ms total. (Task 5 of docs/plans/2026-08-10-opencode-auto-titles.md
/// re-measures and updates these numbers.)
///
/// Filters opencode-synthetic text parts (`$.synthetic = true` --
/// tool-call narration that sorts before the real prompt). Degrades to
/// `None` on ANY schema/query error: older opencode schemas without
/// `message.id`/`part.message_id` columns must not break listing.
const FIRST_USER_MESSAGE_SQL: &str = "\
    WITH first_user AS (\
        SELECT m.id FROM message m \
        WHERE m.session_id = ?1 AND json_extract(m.data, '$.role') = 'user' \
        ORDER BY m.time_created, m.id LIMIT 1\
    ) \
    SELECT json_extract(p.data, '$.text') \
    FROM part p JOIN first_user f ON p.message_id = f.id \
    WHERE json_extract(p.data, '$.type') = 'text' \
      AND coalesce(json_extract(p.data, '$.synthetic'), 0) = 0 \
      AND json_extract(p.data, '$.text') IS NOT NULL \
    ORDER BY p.id LIMIT 1";

fn first_user_message_for_session(conn: &Connection, session_id: &str) -> Option<String> {
    let mut stmt = conn.prepare_cached(FIRST_USER_MESSAGE_SQL).ok()?;
    let text: Option<String> = stmt
        .query_row(rusqlite::params![session_id], |row| row.get(0))
        .ok()?;
    text.as_deref()
        .and_then(crate::text::normalize_first_user_message)
}
```

(3c) Wire into the `list_sessions` mapping loop (currently
`opencode.rs:332-353`; `conn` is in scope there):

```rust
        for row in result.rows {
            let cwd = match row.cwd {
                Some(ref c) if !c.is_empty() => c.clone(),
                _ => continue,
            };
            let project_path =
                meaningful_worktree(row.project_path).unwrap_or_else(|| cwd.clone());
            let is_three_views = row.has_three_views_marker == Some(1);
            // Bounded first-message extraction: ONLY for sessions that still
            // need naming (empty/placeholder title). Named sessions surface
            // opencode's own title (provider-generated) and never need the
            // lookup, so listing cost scales with the small unnamed subset,
            // not with DB size.
            let needs_naming = row
                .title
                .as_deref()
                .map(|t| t.trim().is_empty() || is_opencode_placeholder_title(t))
                .unwrap_or(true);
            let first_user_message = if needs_naming {
                first_user_message_for_session(&conn, &row.session_id)
            } else {
                None
            };
            sessions.push(OpencodeSession {
                session_id: row.session_id,
                project_path,
                cwd,
                title: row.title,
                created_at: row.created_at,
                last_activity_at: row.last_activity_at.unwrap_or(now_ms),
                is_subagent: if is_three_views { Some(true) } else { None },
                is_non_interactive: if is_three_views { Some(true) } else { None },
                first_user_message,
            });
        }
```

Note: `first_user_message_for_session(&conn, &row.session_id)` borrows
`row.session_id` BEFORE it is moved into the struct — keep that order. The
listing connection already has the 5000 ms busy timeout set by
`run_opencode_query_inner`; the helper reuses that connection. If any other
code constructs `OpencodeSession` literally, the compiler will point at it —
set `first_user_message: None` there with a one-line comment (only the
listing path pays for extraction).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions --test opencode_first_message`
Expected: PASS (5 tests).

Run: `cargo test -p freshell-sessions`
Expected: PASS overall EXCEPT possibly compile errors in
`directory_index.rs` if it constructs `OpencodeSession` anywhere — fix those
with `first_user_message: None` as above. The existing
`opencode_source_preserves_none_first_user_message_parity` test still passes
(its fixture has no realistic message tables and `directory_index.rs` still
maps `first_user_message: None` until Task 3).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/parse/opencode.rs crates/freshell-sessions/tests/opencode_first_message.rs
git commit -m "feat(sessions): bounded first-user-message extraction for unnamed opencode sessions"
```

---

### Task 3: Index mapping — surface native titles as provider-generated, pass first message through

**Files:**
- Modify: `crates/freshell-sessions/src/directory_index.rs` (function
  `opencode_session_to_indexed` at `:678-710`; `IndexedSession::title_source`
  doc comment at `:99-109`; tests in the `// ── Batch C: OpencodeSource ──`
  region at `:2682+`)

**Interfaces:**
- Consumes: `OpencodeSession.first_user_message` (Task 2);
  `crate::parse::is_opencode_placeholder_title` (Task 1).
- Produces: opencode `IndexedSession` rows with:
  `first_user_message: Option<String>` (pass-through),
  `title_source: Some("provider-generated")` + `title_provider_generated: true`
  iff the stored title is a real (non-placeholder, non-blank) opencode name.
  Consumed by the sweep (`SweepSession` mapping), the REST provider-generated
  short-circuit (`sessions.rs:364-377`), and the display-time suppression
  (`resolve.rs:529-545`) — all existing code, no changes there.

- [ ] **Step 1: Write the failing tests (and honestly replace the parity pins)**

In `directory_index.rs`'s test module (Batch C region):

(1a) DELETE `opencode_source_preserves_none_first_user_message_parity`
(`:2737-2751`) and replace it with the two tests below. The old test pinned
Node parity (`first_user_message` always `None`), which starved the
first-message/AI ladder rungs forever — the dir placeholder held for every
opencode session. These tests pin the NEW mainline behavior instead.

(1b) Add a message-seeding helper next to `opencode_data_home_with_sessions`
(`:2684-2712`):

```rust
    /// Seeds `message`/`part` rows (real-schema column shape: id + linkage +
    /// time as real columns, role/type/text/synthetic in JSON `data`) for a
    /// fixture db created by `opencode_data_home_with_sessions`.
    fn seed_opencode_user_message(
        data_home: &std::path::Path,
        session_id: &str,
        msg_id: &str,
        time_created: i64,
        role: &str,
        parts: &[(&str, &str)], // (part_id, data_json)
    ) {
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE IF NOT EXISTS part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO message VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                msg_id,
                session_id,
                time_created,
                format!("{{\"role\":\"{role}\"}}")
            ],
        )
        .unwrap();
        for (part_id, data) in parts {
            conn.execute(
                "INSERT INTO part VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![part_id, msg_id, session_id, data],
            )
            .unwrap();
        }
    }
```

(1c) The two replacement tests:

```rust
    #[test]
    fn opencode_placeholder_title_populates_first_user_message() {
        // Replaces `opencode_source_preserves_none_first_user_message_parity`.
        // The Node-parity None starved the first-message/AI ladder rungs
        // forever (the dir placeholder held for every opencode session).
        // Mainline behavior: placeholder-titled sessions carry their first
        // user message so freshell's Gemini stage can name them.
        let data_home = opencode_data_home_with_sessions(
            "opencodesrc-fum",
            &[(
                "ses_fum",
                "/repo/f",
                "New session - 2026-08-10T23:47:23.950Z",
                1000,
                5000,
            )],
        );
        seed_opencode_user_message(
            &data_home,
            "ses_fum",
            "msg_1",
            100,
            "user",
            &[(
                "prt_1",
                r#"{"type":"text","text":"  This is a quick naming test  "}"#,
            )],
        );
        let items = OpencodeSource::new(data_home.clone()).scan();
        assert_eq!(items.len(), 1);
        // normalized (trimmed) via normalize_first_user_message
        assert_eq!(
            items[0].first_user_message.as_deref(),
            Some("This is a quick naming test")
        );
        // a placeholder title is NOT a provider name
        assert_eq!(items[0].title_source, None);
        assert!(!items[0].title_provider_generated);
        std::fs::remove_dir_all(&data_home).ok();
    }

    #[test]
    fn opencode_native_title_maps_to_provider_generated_and_skips_message_fetch() {
        let data_home = opencode_data_home_with_sessions(
            "opencodesrc-native",
            &[("ses_named", "/repo/n", "Fix login flow", 1000, 5000)],
        );
        // Message rows exist, but a named session must NOT pay the
        // per-session lookup (bounded listing cost) -- and must surface
        // opencode's own name as provider-generated so the AI stage
        // short-circuits and the sweep's shadow guard lets it win over
        // stale dir/first-message override rows.
        seed_opencode_user_message(
            &data_home,
            "ses_named",
            "msg_1",
            100,
            "user",
            &[("prt_1", r#"{"type":"text","text":"hello"}"#)],
        );
        let items = OpencodeSource::new(data_home.clone()).scan();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title.as_deref(), Some("Fix login flow"));
        assert_eq!(
            items[0].title_source.as_deref(),
            Some("provider-generated")
        );
        assert!(items[0].title_provider_generated);
        assert_eq!(items[0].first_user_message, None);
        std::fs::remove_dir_all(&data_home).ok();
    }
```

(1d) Update `opencode_source_direct_lists_and_maps_fields` (`:2714-2735`):
its fixture titles the session `"Session A"` (non-placeholder), so extend its
assertions (replacing the bare `first_user_message == None` parity assert and
its rationale comment):

```rust
        // "Session A" is a real (non-placeholder) opencode name: surfaced as
        // provider-generated; no message lookup is paid for named sessions.
        assert_eq!(items[0].title_source.as_deref(), Some("provider-generated"));
        assert!(items[0].title_provider_generated);
        assert_eq!(items[0].first_user_message, None);
        assert_eq!(items[0].summary, None);
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p freshell-sessions directory_index -- --nocapture`
Expected: FAIL — `opencode_placeholder_title_populates_first_user_message`
fails on `first_user_message` (None vs Some) and both new tests fail on
`title_source`; `opencode_source_direct_lists_and_maps_fields` fails on the
new `title_source` assert. (If the old parity test still exists, the compile
fails first — delete it as instructed in Step 1a.)

- [ ] **Step 3: Implement the mapping change**

Replace `opencode_session_to_indexed` (`directory_index.rs:678-710`) with:

```rust
fn opencode_session_to_indexed(s: crate::parse::OpencodeSession) -> IndexedSession {
    // A non-placeholder opencode title is opencode's OWN session name
    // (opencode retitles sessions itself after the first exchange).
    // Surface it as provider-generated so the auto-title ladder yields to
    // it: `should_generate_ai` short-circuits (freshell-server/auto_title.rs)
    // and the sweep's shadow guard lets it win over stale dir/first-message
    // override rows (auto_title_sweep.rs::overlay_session_title). Deliberate
    // mainline deviation from the retired Node reference, which never
    // populated titleSource or firstUserMessage for opencode.
    let provider_named = s.title.as_deref().is_some_and(|t| {
        !t.trim().is_empty() && !crate::parse::is_opencode_placeholder_title(t)
    });
    IndexedSession {
        session_id: s.session_id,
        provider: "opencode".to_string(),
        project_path: s.project_path,
        title: s.title,
        // bool twin of `title_source` -- same predicate, kept consistent
        // (see parse/claude.rs's identical convention).
        title_provider_generated: provider_named,
        // The opencode direct-lister has no text summary to offer (the
        // session table's summary_* columns are diff stats) -- None.
        summary: None,
        // Populated by the parse layer ONLY for sessions that still need
        // naming (bounded lookup) -- feeds the first-message/AI rungs.
        first_user_message: s.first_user_message,
        title_source: provider_named.then(|| "provider-generated".to_string()),
        last_activity_at: s.last_activity_at,
        created_at: s.created_at,
        // `OpencodeSession::cwd` is always present (`list_sessions` already
        // skips rows without one) — R10b is a structural non-issue here.
        cwd: Some(s.cwd),
        // The opencode direct-lister reads no git facts from the db -- None,
        // faithful to `listSessionsDirect`.
        git_branch: None,
        is_subagent: s.is_subagent.unwrap_or(false),
        is_non_interactive: s.is_non_interactive.unwrap_or(false),
        // SESSION-07: opencode is direct-listed from one sqlite db, not a
        // per-session file -- there is no stable path to scan, so this
        // provider is un-searchable at the `userMessages`/`fullText` tiers
        // (title-tier metadata search is unaffected).
        source_file: None,
    }
}
```

Also update the `IndexedSession::title_source` doc comment
(`directory_index.rs:99-109`) — it is the contract-of-record for the field.
Replace the opencode bullet:

```rust
    /// - **opencode**: `"provider-generated"` iff the stored session title is
    ///   a real name (not blank and not the `New session - <ISO>` default
    ///   placeholder) -- opencode names sessions itself after the first
    ///   exchange. `None` for placeholder-titled sessions (those instead
    ///   carry `first_user_message` for the first-message/AI rungs).
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-sessions`
Expected: PASS (all crate tests, including the two new tests, the updated
`opencode_source_direct_lists_and_maps_fields`, and the untouched opencode
change-token/read-error tests).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-sessions/src/directory_index.rs
git commit -m "feat(sessions): surface opencode native titles as provider-generated and pass first message to the index"
```

---

### Task 4: Sweep-level ladder tests (freshell-server, tests only)

**Files:**
- Modify: `crates/freshell-server/src/auto_title_sweep.rs` (the
  `#[cfg(test)] mod tests` at `:552+` only — no production code changes)

**Interfaces:**
- Consumes (all existing, in-module): test helpers `sweep_state(dir, ai_key)`
  (`:591-613`), `spawn_headless_terminal_for_test(&registry, tid)`
  (`:557-589`), `session(provider, id, cwd, first) -> SweepSession`
  (`:625-635`), `FakeGemini` (`:614-624`, default reply `Ok("AI Title")`);
  production fns `run_auto_title_pass(&state, &[SweepSession]) -> bool` and
  `overlay_session_title(&Map, &str, Option<&str>, Option<&str>) -> Option<String>`;
  from Task 3: `IndexedSession` rows produced by `OpencodeSource` (used in the
  end-to-end test via `freshell_sessions::directory_index::{SessionIndex, OpencodeSource}`).
- Produces: regression tests pinning the opencode auto-title reconciliation.

**Honesty note on TDD:** tests (a)–(d) and the overlay test are green on
arrival — the sweep is provider-agnostic and the production gaps were in the
data layer, whose red-green cycles lived in Tasks 2–3. These tests pin the
reconciliation semantics against future provider-specific regressions (the
spec explicitly requires sweep-level coverage). Test (e) is the wire-through
proof: it would fail without Tasks 1–3 (`first_user_message` would be `None`
and `titleSource` would hold at `"dir"` forever — the exact live bug).

- [ ] **Step 1: Add the overlay ladder test (ai > provider-generated)**

Add to the pure-sync overlay tests (near `:640`):

```rust
    #[test]
    fn opencode_ai_override_row_wins_over_late_provider_title() {
        // Ladder: ai > provider-generated. A Gemini title freshell already
        // wrote is NOT clobbered when opencode later names the session
        // (the shadow guard only suppresses dir/first-message rows).
        let mut overrides = serde_json::Map::new();
        overrides.insert(
            "opencode:s1".into(),
            json!({ "titleOverride": "Gemini Title", "titleSource": "ai" }),
        );
        let title = overlay_session_title(
            &overrides,
            "opencode:s1",
            Some("Opencode Title"),
            Some("provider-generated"),
        );
        assert_eq!(title.as_deref(), Some("Gemini Title"));
    }
```

- [ ] **Step 2: Add sweep tests (a)–(d)**

Add to the async tests in the same module:

```rust
    #[tokio::test]
    async fn opencode_first_message_holds_dir_then_finalizes_ai() {
        // Gap A regression (docs/plans/2026-08-10-opencode-auto-titles.md):
        // an opencode session with a first user message must reach the
        // Gemini stage instead of holding the dir placeholder forever.
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("opencode"), Some("s1"), Some("/x/glowforge"), 1);
        let s = [session(
            "opencode",
            "s1",
            "/x/glowforge",
            Some("This is a quick naming test"),
        )];
        run_auto_title_pass(&state, &s).await;
        // pass 1: dir placeholder persisted (never first-message when AI on)
        let row = state
            .settings
            .session_overrides()
            .get("opencode:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "dir");
        // AI one-shot lands asynchronously; wait for it
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state
                .settings
                .session_overrides()
                .get("opencode:s1")
                .cloned()
                .unwrap();
            if row["titleSource"] == "ai" {
                break;
            }
        }
        let row = state
            .settings
            .session_overrides()
            .get("opencode:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "AI Title");
        assert_eq!(row["titleSource"], "ai");
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn opencode_provider_named_session_short_circuits_ai() {
        // Gap B: a session opencode already named must surface that name
        // and never spawn Gemini -- even when a first message is present
        // (should_generate_ai's provider-generated conjunct).
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("opencode"), Some("s1"), Some("/x/proj"), 1);
        for _pass in 0..2 {
            // mirror spawn_auto_title_sweep's mapping: title is overlay-applied
            let overrides = state.settings.session_overrides();
            let title = overlay_session_title(
                &overrides,
                "opencode:s1",
                Some("Fix login flow"),
                Some("provider-generated"),
            );
            let mut s = session("opencode", "s1", "/x/proj", Some("hello"));
            s.title = title;
            s.title_source = Some("provider-generated".into());
            run_auto_title_pass(&state, &[s]).await;
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        // no Gemini: nothing pending, no ai row (a dir row is claude-parity
        // behavior for provider-generated sessions and is shadow-suppressed)
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
        if let Some(row) = state.settings.session_overrides().get("opencode:s1") {
            assert_ne!(row["titleSource"], "ai");
        }
        // the provider name is what lands on the live terminal
        assert_eq!(
            state.registry.title_of(tid).as_deref(),
            Some("Fix login flow")
        );
    }

    #[tokio::test]
    async fn opencode_stale_dir_override_yields_to_late_provider_title() {
        // The live-bug state: a dir placeholder row already persisted
        // (written while the session was unnamed) must not shadow
        // opencode's own retitle once it lands.
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("opencode"), Some("s1"), Some("/x/glowforge"), 1);
        state
            .settings
            .patch_session_override(
                "opencode:s1",
                &[
                    ("titleOverride", Some(json!("glowforge"))),
                    ("titleSource", Some(json!("dir"))),
                ],
            )
            .await;
        let overrides = state.settings.session_overrides();
        let title = overlay_session_title(
            &overrides,
            "opencode:s1",
            Some("Quick naming test"),
            Some("provider-generated"),
        );
        // shadow guard: the stale dir row loses to the provider title
        assert_eq!(title.as_deref(), Some("Quick naming test"));
        let mut s = session("opencode", "s1", "/x/glowforge", None);
        s.title = title;
        s.title_source = Some("provider-generated".into());
        run_auto_title_pass(&state, &[s]).await;
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
        assert_eq!(
            state.registry.title_of(tid).as_deref(),
            Some("Quick naming test")
        );
    }

    #[tokio::test]
    async fn opencode_user_rename_wins_over_provider_title_and_ai() {
        let dir = tempfile::tempdir().unwrap();
        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("opencode"), Some("s1"), Some("/x/proj"), 1);
        state
            .settings
            .patch_session_override(
                "opencode:s1",
                &[
                    ("titleOverride", Some(json!("My Name"))),
                    ("titleSource", Some(json!("user"))),
                ],
            )
            .await;
        let overrides = state.settings.session_overrides();
        let title = overlay_session_title(
            &overrides,
            "opencode:s1",
            Some("Provider Title"),
            Some("provider-generated"),
        );
        // user rows are never shadowed
        assert_eq!(title.as_deref(), Some("My Name"));
        let mut s = session("opencode", "s1", "/x/proj", Some("hello"));
        s.title = title;
        s.title_source = Some("provider-generated".into());
        run_auto_title_pass(&state, &[s]).await;
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        let row = state
            .settings
            .session_overrides()
            .get("opencode:s1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "My Name");
        assert_eq!(row["titleSource"], "user");
        assert!(state.pending_ai_titles.lock().unwrap().is_empty());
    }
```

- [ ] **Step 3: Add the end-to-end fixture-DB test (e)**

Same test module (freshell-server already depends on rusqlite —
`crates/freshell-server/Cargo.toml:118`):

```rust
    #[tokio::test]
    async fn opencode_fixture_db_end_to_end_dir_then_ai() {
        // Acceptance #1 wire-through: fixture opencode.db -> OpencodeSource
        // -> SessionIndex snapshot -> the sweep's SweepSession mapping ->
        // fake-Gemini title. Fails without the freshell-sessions data fixes
        // (first_user_message stays None and titleSource holds at "dir").
        let dir = tempfile::tempdir().unwrap();
        let data_home = dir.path().join("opencode-data");
        std::fs::create_dir_all(&data_home).unwrap();
        let conn = rusqlite::Connection::open(data_home.join("opencode.db")).unwrap();
        conn.execute_batch(
            "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
             CREATE TABLE session (
                id TEXT PRIMARY KEY, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
                project_id TEXT, parent_id TEXT
             );
             CREATE TABLE message (
                id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
             CREATE TABLE part (
                id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session VALUES ('ses_1', '/x/glowforge',
                'New session - 2026-08-10T23:47:23.950Z', 1000, 5000, NULL, NULL, NULL)",
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO message VALUES ('msg_1', 'ses_1', 100, '{"role":"user"}')"#,
            [],
        )
        .unwrap();
        conn.execute(
            r#"INSERT INTO part VALUES ('prt_1', 'msg_1', 'ses_1',
                '{"type":"text","text":"This is a quick naming test"}')"#,
            [],
        )
        .unwrap();
        drop(conn);

        let sources: Vec<
            std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
        > = vec![std::sync::Arc::new(
            freshell_sessions::directory_index::OpencodeSource::new(data_home),
        )];
        let index = freshell_sessions::directory_index::SessionIndex::new(sources);
        let items = index.snapshot().await;
        assert_eq!(items.len(), 1);
        assert_eq!(
            items[0].first_user_message.as_deref(),
            Some("This is a quick naming test")
        );

        let (state, _rx) = sweep_state(dir.path(), Some("key"));
        let tid = "term-1";
        spawn_headless_terminal_for_test(&state.registry, tid);
        state
            .identity
            .upsert(tid, Some("opencode"), Some("ses_1"), Some("/x/glowforge"), 1);
        // mirror spawn_auto_title_sweep's IndexedSession -> SweepSession mapping
        let overrides = state.settings.session_overrides();
        let sessions: Vec<SweepSession> = items
            .iter()
            .map(|s| {
                let key = s.key();
                let title = overlay_session_title(
                    &overrides,
                    &key,
                    s.title.as_deref(),
                    s.title_source.as_deref(),
                );
                SweepSession {
                    provider: s.provider.clone(),
                    session_id: s.session_id.clone(),
                    cwd: s.cwd.clone(),
                    title,
                    first_user_message: s.first_user_message.clone(),
                    title_source: s.title_source.clone(),
                    git_branch: s.git_branch.clone(),
                }
            })
            .collect();
        run_auto_title_pass(&state, &sessions).await;
        let row = state
            .settings
            .session_overrides()
            .get("opencode:ses_1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "dir"); // placeholder ADVANCES...
        for _ in 0..50 {
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            let row = state
                .settings
                .session_overrides()
                .get("opencode:ses_1")
                .cloned()
                .unwrap();
            if row["titleSource"] == "ai" {
                break;
            }
        }
        let row = state
            .settings
            .session_overrides()
            .get("opencode:ses_1")
            .cloned()
            .unwrap();
        assert_eq!(row["titleOverride"], "AI Title"); // ...to the Gemini title
        assert_eq!(row["titleSource"], "ai");
    }
```

Adjustment latitude (verify, don't guess): if `SessionSource` is not the
exact pub trait name for `SessionIndex::new`'s element type, use the exact
signature at `directory_index.rs` (~`:850-930`) — `main.rs:643-655` shows the
production construction to mirror. Everything else must stay as written.

- [ ] **Step 4: Run the new tests**

Run: `cargo test -p freshell-server auto_title_sweep -- --nocapture`
Expected: PASS (all pre-existing sweep tests + 6 new tests).

- [ ] **Step 5: Sanity-check the wire-through test actually depends on the new data layer**

Run:
```bash
git stash -- crates/freshell-sessions && \
cargo test -p freshell-server opencode_fixture_db_end_to_end_dir_then_ai; \
git stash pop
```
Expected: with the freshell-sessions changes stashed, the test FAILS at the
`first_user_message` assert (proving it exercises the fix); after
`git stash pop` re-run `cargo test -p freshell-server opencode_fixture_db_end_to_end_dir_then_ai`
and it PASSES. (If the stash picks up nothing because commits already landed,
skip this step — the red state was already proven task-by-task in Tasks 2–3.
Note: Tasks 2–3 commit their changes, so expect to use the skip path; the
stash check only applies if running with uncommitted freshell-sessions edits.)

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-server/src/auto_title_sweep.rs
git commit -m "test(server): pin opencode auto-title ladder (dir->ai, provider short-circuit, shadow guard, user wins)"
```

---

### Task 5: Full verification, measured cost, deviation note, push

**Files:**
- Modify: `crates/freshell-sessions/src/parse/opencode.rs` (update the
  measured-cost numbers in the `FIRST_USER_MESSAGE_SQL` doc comment)
- Possibly modify: `port/oracle/DEVIATIONS.md` (ONLY if it exists and pins
  opencode listing behavior)

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: green CI gates, documented measured cost, pushed branch.

- [ ] **Step 1: Run the crate suites and the workspace gates**

```bash
cargo test -p freshell-sessions -p freshell-server
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
```
Expected: all PASS / no output from fmt. (Workspace tests prove no clobber
regressions in the claude/codex suites — acceptance #3.) Fix any clippy/fmt
findings in the files this plan touched and amend the relevant commit or add
a `fix(clippy)`/`style` commit.

- [ ] **Step 2: Measure the real cost on the production DB (READ-ONLY)**

Run (bash; read-only URI + query_only; do NOT run as root; never write):

```bash
sqlite3 "file:$HOME/.local/share/opencode/opencode.db?mode=ro" <<'SQL'
PRAGMA query_only=ON;
.timer on
-- how many sessions would pay the lookup on this corpus
SELECT count(*) FROM session
WHERE time_archived IS NULL AND parent_id IS NULL
  AND (title LIKE 'New session - %' OR trim(title) = '');
-- total cost of the bounded lookup across ALL of them
WITH needing AS (
  SELECT id FROM session
  WHERE time_archived IS NULL AND parent_id IS NULL
    AND (title LIKE 'New session - %' OR trim(title) = '')
)
SELECT count(*), sum(fm IS NOT NULL) FROM (
  SELECT (
    SELECT json_extract(p.data,'$.text')
    FROM part p
    WHERE p.message_id = (
      SELECT m.id FROM message m
      WHERE m.session_id = needing.id
        AND json_extract(m.data,'$.role') = 'user'
      ORDER BY m.time_created, m.id LIMIT 1)
      AND json_extract(p.data,'$.type') = 'text'
      AND coalesce(json_extract(p.data,'$.synthetic'), 0) = 0
    ORDER BY p.id LIMIT 1
  ) AS fm FROM needing
);
-- confirm the plan uses the indexes (no table scans)
EXPLAIN QUERY PLAN
SELECT json_extract(p.data,'$.text')
FROM part p
WHERE p.message_id = (
  SELECT m.id FROM message m
  WHERE m.session_id = 'ses_011ed1951ffeIM2g2Zc5p7ch3l'
    AND json_extract(m.data,'$.role') = 'user'
  ORDER BY m.time_created, m.id LIMIT 1)
  AND json_extract(p.data,'$.type') = 'text'
  AND coalesce(json_extract(p.data,'$.synthetic'), 0) = 0
ORDER BY p.id LIMIT 1;
SQL
```

Expected shape (prior read-only measurement on this machine): ~175 sessions
needing naming; total lookup time ~0.016 s (~0.09 ms/session); EQP shows
`SEARCH m USING INDEX message_session_time_created_id_idx` and
`SEARCH p USING INDEX part_message_id_id_idx` (no `SCAN`). If the numbers
differ materially, they are still acceptable as long as total time stays
well under ~1 s and the EQP shows index searches — otherwise stop and rework
the query before proceeding.

- [ ] **Step 3: Record the measured numbers**

Update the `FIRST_USER_MESSAGE_SQL` doc comment in
`crates/freshell-sessions/src/parse/opencode.rs` with the numbers actually
measured in Step 2 (session count, total time, per-session time, DB size,
date measured). This documents acceptance #4 in the code itself.

- [ ] **Step 4: Deviation note (conditional)**

```bash
test -f port/oracle/DEVIATIONS.md && grep -n -i "opencode" port/oracle/DEVIATIONS.md | head -20 || echo "no campaign deviations file - code comments suffice"
```
ONLY if the file exists AND documents opencode listing/auto-title parity
expectations, append (matching the file's existing entry format) a note:

> **opencode auto-titles (mainline, post-port):** `parse/opencode.rs` now
> extracts a bounded `first_user_message` for placeholder-titled sessions and
> `directory_index.rs` classifies non-placeholder opencode titles as
> `provider-generated`. Node reference behavior (always `None`) was a
> verified functional gap: opencode sessions could never be AI-titled and
> native opencode names were permanently shadowed by the dir placeholder.

Otherwise skip — the code comments added in Tasks 1–3 already document the
deviation.

- [ ] **Step 5: Prove the frozen trees are untouched, then commit**

```bash
git diff origin/main --stat -- server/ shared/   # MUST print nothing
git status --short                                # only expected files
git add crates/freshell-sessions/src/parse/opencode.rs
test -f port/oracle/DEVIATIONS.md && git add port/oracle/DEVIATIONS.md || true
git commit -m "docs(sessions): record measured first-message lookup cost on production-size opencode.db"
```

- [ ] **Step 6: Push the branch and STOP**

```bash
git push -u origin opencode-auto-titles
```

**STOP here. Do NOT create a PR — PR creation requires explicit user
approval (repo rule).**

---

## Acceptance Criteria Traceability

1. Live opencode session with a first user message gets a Gemini auto-title
   (dir placeholder advances instead of holding) → Task 4 tests (a) + (e);
   data layer proven in Tasks 2–3.
2. opencode-named session surfaces its name as provider-generated and the AI
   stage short-circuits → Task 3 test
   `opencode_native_title_maps_to_provider_generated_and_skips_message_fetch`
   + Task 4 test (b); the REST short-circuit (`sessions.rs:364-377`) and
   display suppression (`resolve.rs:529-545`) key off the same
   `title_source` value and are already generically tested.
3. Ladder precedence user > ai > provider proven → Task 4 tests (d), the
   overlay `ai`-wins test, and (c) for provider-over-dir; no clobber
   regressions for other providers → full workspace suite in Task 5.
4. Listing-path performance bounded + measured cost documented → Task 2
   gating + `named_session_skips_message_lookup_entirely` + Task 5 Steps 2–3.
5. Workspace tests + clippy `-D warnings` + fmt green; `server/` and
   `shared/` untouched → Task 5 Steps 1 and 5.
6. Branch pushed; STOP before PR → Task 5 Step 6.
