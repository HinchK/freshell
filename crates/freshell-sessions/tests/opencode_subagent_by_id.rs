//! Unit tests for `session_is_subagent_by_id` — the one-row parent_id
//! classification behind the sidebar's subagent-terminal filtering.

use freshell_sessions::parse::session_is_subagent_by_id;
use rusqlite::Connection;
use std::path::PathBuf;

fn temp_home(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-oc-subagent-byid-{tag}-{}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn seed(home: &std::path::Path, with_parent_id_column: bool) {
    let conn = Connection::open(home.join("opencode.db")).unwrap();
    if with_parent_id_column {
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER
             );
             INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_root', 'p1', NULL, '/repo', 'root', 1, 2, NULL);
             INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_child', 'p1', 'ses_root', '/repo', 'child', 1, 2, NULL);",
        )
        .unwrap();
    } else {
        conn.execute_batch(
            "CREATE TABLE session (
                id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
                time_created INTEGER, time_updated INTEGER, time_archived INTEGER
             );
             INSERT INTO session (id, project_id, directory, title, time_created, time_updated, time_archived)
               VALUES ('ses_flat', 'p1', '/repo', 'flat', 1, 2, NULL);",
        )
        .unwrap();
    }
}

#[test]
fn child_row_is_subagent() {
    let home = temp_home("child");
    seed(&home, true);
    assert_eq!(
        session_is_subagent_by_id(&home, "ses_child").unwrap(),
        Some(true)
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn root_row_is_not_subagent() {
    let home = temp_home("root");
    seed(&home, true);
    assert_eq!(
        session_is_subagent_by_id(&home, "ses_root").unwrap(),
        Some(false)
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn missing_row_is_none() {
    let home = temp_home("missing-row");
    seed(&home, true);
    assert_eq!(session_is_subagent_by_id(&home, "ses_nope").unwrap(), None);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn missing_db_is_none() {
    let home = temp_home("missing-db");
    assert_eq!(session_is_subagent_by_id(&home, "ses_child").unwrap(), None);
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn legacy_schema_without_parent_id_is_some_false() {
    let home = temp_home("legacy");
    seed(&home, false);
    assert_eq!(
        session_is_subagent_by_id(&home, "ses_flat").unwrap(),
        Some(false)
    );
    let _ = std::fs::remove_dir_all(&home);
}

#[test]
fn unreadable_db_is_err() {
    let home = temp_home("corrupt");
    std::fs::write(home.join("opencode.db"), b"not a sqlite file").unwrap();
    assert!(session_is_subagent_by_id(&home, "ses_child").is_err());
    let _ = std::fs::remove_dir_all(&home);
}
