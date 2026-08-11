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
        rusqlite::params![
            id,
            session_id,
            time_created,
            format!("{{\"role\":\"{role}\"}}")
        ],
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
