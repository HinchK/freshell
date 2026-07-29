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
    let conn = rusqlite::Connection::open(data_home.join("opencode.db")).expect("open fixture db");
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
    insert_row(
        &conn,
        "ses_root0000000000000000000000",
        Some("/tmp/p"),
        None,
        None,
    );
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
    insert_row(
        &conn,
        "ses_arch0000000000000000000000",
        Some("/tmp/p"),
        None,
        Some(9999),
    );
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
    insert_row(
        &conn,
        "ses_root0000000000000000000000",
        Some("/tmp/p"),
        None,
        None,
    );
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
    let conn = rusqlite::Connection::open(home.join("opencode.db")).expect("open fixture db");
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
