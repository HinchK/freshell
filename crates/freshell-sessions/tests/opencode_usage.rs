//! Bounded last-step-finish usage extraction from opencode.db — the numbers
//! opencode's own compaction trigger reads (`session/overflow.ts`
//! `isOverflow({ tokens: lastFinished.tokens, ... })`, verified against the
//! v1.18.31 source). Fixture DBs mirror the REAL schema shape (session.model
//! JSON column; message/part linkage + time as REAL columns; role/type/
//! tokens inside the JSON `data` column) — same convention as
//! tests/opencode_first_message.rs.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};

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

fn create_schema(conn: &Connection) {
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
            parent_id TEXT,
            model TEXT
         );
         CREATE TABLE message (
            id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (
            id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT,
            time_created INTEGER NOT NULL, time_updated INTEGER, data TEXT);",
    )
    .unwrap();
}

fn insert_session(conn: &Connection, id: &str, title: &str, model: Option<&str>) {
    conn.execute(
        "INSERT INTO session VALUES (?1, '/repo/x', ?2, 1000, 5000, NULL, NULL, NULL, ?3)",
        rusqlite::params![id, title, model],
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
    // Real-schema fidelity: parts carry time_created (NOT NULL) +
    // time_updated. The usage WALK orders messages by time_created and a
    // message's parts by id; tests insert in story order, so a monotonic
    // counter mirrors "later insert = newer part" (the order lexicographic
    // ids would give).
    static PART_TIME: AtomicI64 = AtomicI64::new(1000);
    let time_created = PART_TIME.fetch_add(1, Ordering::SeqCst);
    conn.execute(
        "INSERT INTO part VALUES (?1, ?2, ?3, ?4, ?4, ?5)",
        rusqlite::params![id, message_id, session_id, time_created, data],
    )
    .unwrap();
}

const STEP_FINISH_FULL: &str = r#"{"reason":"stop","type":"step-finish","tokens":{"total":215242,"input":215,"output":434,"reasoning":1,"cache":{"write":0,"read":214592}},"cost":0}"#;
const STEP_FINISH_NO_TOTAL: &str = r#"{"reason":"stop","type":"step-finish","tokens":{"input":100,"output":50,"reasoning":7,"cache":{"write":10,"read":900}},"cost":0}"#;
const MODEL_JSON: &str =
    r#"{"id":"glm-5.3-vision-background","providerID":"lunaroute","variant":"default"}"#;

fn list_one(dir: &Path) -> freshell_sessions::parse::OpencodeSession {
    let provider = OpencodeProvider::new(dir.to_path_buf());
    let listing = provider.list_sessions(42).expect("read ok");
    assert_eq!(listing.sessions.len(), 1);
    listing.sessions.into_iter().next().unwrap()
}

#[test]
fn session_with_model_and_step_finish_extracts_usage() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "user");
    insert_message(&conn, "msg_2", "ses_1", 200, "assistant");
    insert_part(&conn, "prt_2", "msg_2", "ses_1", STEP_FINISH_FULL);
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(
        s.model.as_deref(),
        Some("lunaroute/glm-5.3-vision-background")
    );
    assert_eq!(
        s.last_usage,
        Some(freshell_sessions::parse::OpencodeStepUsage {
            total: Some(215242),
            input: 215,
            output: 434,
            cache_read: 214592,
            cache_write: 0,
        })
    );
}

#[test]
fn latest_assistant_step_finish_wins_even_with_trailing_user_message() {
    // the lastFinished semantic: a trailing (synthetic tool-result) user
    // message after the final assistant step must not hide the usage
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(
        &conn,
        "prt_1",
        "msg_1",
        "ses_1",
        r#"{"reason":"tool-calls","type":"step-finish","tokens":{"total":1000,"input":10,"output":20,"cache":{"write":0,"read":970}}}"#,
    );
    insert_message(&conn, "msg_2", "ses_1", 200, "assistant");
    insert_part(&conn, "prt_2", "msg_2", "ses_1", STEP_FINISH_FULL);
    // trailing user (tool result) — newer than the last assistant
    insert_message(&conn, "msg_3", "ses_1", 300, "user");
    insert_part(
        &conn,
        "prt_3",
        "msg_3",
        "ses_1",
        r#"{"type":"text","text":"tool output","synthetic":true}"#,
    );
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage.as_ref().unwrap().total, Some(215242));
}

#[test]
fn in_flight_trailing_step_falls_back_to_previous_finished_step() {
    // The falsifier (live-DB proven, reports/load-bearing-strategist.md §2):
    // the newest assistant message is a RUNNING step — step-start/reasoning
    // parts only, NO step-finish. The meter must read the PREVIOUS finished
    // step's usage (opencode's `lastFinished`), not degrade to None.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(
        &conn,
        "prt_1",
        "msg_1",
        "ses_1",
        r#"{"reason":"stop","type":"step-finish","tokens":{"total":1000,"input":10,"output":20,"cache":{"write":0,"read":970}}}"#,
    );
    // the RUNNING newest step: assistant message with NO step-finish part
    insert_message(&conn, "msg_2", "ses_1", 200, "assistant");
    insert_part(&conn, "prt_2", "msg_2", "ses_1", r#"{"type":"step-start"}"#);
    insert_part(
        &conn,
        "prt_3",
        "msg_2",
        "ses_1",
        r#"{"type":"reasoning","text":"thinking"}"#,
    );
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage.as_ref().unwrap().total, Some(1000));
}

#[test]
fn usage_walk_caps_at_64_probes_and_degrades_to_none() {
    // 70 assistant messages; the ONLY step-finish sits on the OLDEST
    // (msg_000, time 100). The walk probes newest-first and must stop at
    // the 64-probe cap WITHOUT reaching msg_000 — None here proves the
    // cap fired (without it, the walk would find the old step-finish and
    // return Some(999)). A bounded, logged miss.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    for i in 0..70 {
        let id = format!("msg_{i:03}");
        insert_message(&conn, &id, "ses_1", 100 + i, "assistant");
        if i == 0 {
            insert_part(
                &conn,
                "prt_000",
                &id,
                "ses_1",
                r#"{"reason":"stop","type":"step-finish","tokens":{"total":999,"input":9,"output":9,"cache":{"write":0,"read":972}}}"#,
            );
        } else {
            insert_part(
                &conn,
                &format!("prt_{i:03}"),
                &id,
                "ses_1",
                r#"{"type":"step-start"}"#,
            );
        }
    }
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage, None);
}

#[test]
fn usage_walk_finds_a_finish_on_the_64th_candidate() {
    // The cap boundary (plan-review round-3 finding 3): the cap counts
    // consecutive MISSES, so a step-finish on the 64th probed candidate
    // must still be FOUND — 63 trailing unfinished steps, then the
    // finished one. (63 misses → probes=63 < 64 → the 64th probe runs.)
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    for i in 0..64 {
        let id = format!("msg_{i:03}");
        insert_message(&conn, &id, "ses_1", 100 + i, "assistant");
        if i == 0 {
            insert_part(
                &conn,
                "prt_000",
                &id,
                "ses_1",
                r#"{"reason":"stop","type":"step-finish","tokens":{"total":777,"input":7,"output":7,"cache":{"write":0,"read":763}}}"#,
            );
        } else {
            insert_part(
                &conn,
                &format!("prt_{i:03}"),
                &id,
                "ses_1",
                r#"{"type":"step-start"}"#,
            );
        }
    }
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.last_usage.as_ref().unwrap().total, Some(777));
}

#[test]
fn missing_tokens_total_falls_back_to_parsed_fields() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_NO_TOTAL);
    drop(conn);
    let s = list_one(&dir);
    let usage = s.last_usage.expect("usage present");
    assert_eq!(usage.total, None);
    assert_eq!(usage.input, 100);
    assert_eq!(usage.output, 50);
    assert_eq!(usage.cache_read, 900);
    assert_eq!(usage.cache_write, 10);
}

#[test]
fn session_without_model_skips_usage_lookup() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", None);
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(&conn, "prt_1", "msg_1", "ses_1", STEP_FINISH_FULL);
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model, None);
    assert_eq!(s.last_usage, None);
}

#[test]
fn malformed_model_json_degrades_to_none_without_breaking_listing() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(r#"{"id": }"#));
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model, None);
    assert_eq!(s.last_usage, None);
}

#[test]
fn no_step_finish_yields_none() {
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    create_schema(&conn);
    insert_session(&conn, "ses_1", "Named", Some(MODEL_JSON));
    insert_message(&conn, "msg_1", "ses_1", 100, "assistant");
    insert_part(
        &conn,
        "prt_1",
        "msg_1",
        "ses_1",
        r#"{"type":"text","text":"partial turn, no finish yet"}"#,
    );
    drop(conn);
    let s = list_one(&dir);
    assert!(s.model.is_some());
    assert_eq!(s.last_usage, None);
}

#[test]
fn legacy_schema_without_model_column_stays_listable() {
    // opencode_sqlite.rs's older fixtures have no session.model column; the
    // listing SELECT must tolerate it (NULL AS model), never fail.
    let dir = TmpDir::new();
    let conn = Connection::open(dir.join("opencode.db")).unwrap();
    conn.execute_batch(
        "CREATE TABLE project (id TEXT PRIMARY KEY, worktree TEXT);
         CREATE TABLE session (
            id TEXT PRIMARY KEY, directory TEXT, title TEXT,
            time_created INTEGER, time_updated INTEGER, time_archived INTEGER,
            project_id TEXT, parent_id TEXT
         );
         CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT);
         CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, data TEXT);",
    )
    .unwrap();
    conn.execute(
        "INSERT INTO session VALUES ('ses_1', '/repo/x', 'Named', 1000, 5000, NULL, NULL, NULL)",
        [],
    )
    .unwrap();
    drop(conn);
    let s = list_one(&dir);
    assert_eq!(s.model, None);
    assert_eq!(s.last_usage, None);
}
