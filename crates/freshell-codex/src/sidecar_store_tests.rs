//! Unit tests for the durable codex sidecar record store ([`super`]).
//!
//! Tempfile tempdirs ONLY — no global state, no processes, nothing outside
//! each test's own temp dir. In particular these tests must NEVER touch
//! `~/.freshell/codex-sidecars/` (Node's store), the production
//! `~/.freshell/rust-codex-sidecars/` root (wired in Task 10), or any live
//! process.

use super::*;

fn sample_record(ownership_id: &str) -> CodexSidecarRecord {
    CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: ownership_id.to_string(),
        pid: 4242,
        starttime: 123_456_789,
        cmdline: vec![
            "codex".to_string(),
            "-c".to_string(),
            "features.apps=false".to_string(),
            "app-server".to_string(),
            "--listen".to_string(),
            "ws://127.0.0.1:7777".to_string(),
        ],
        ws_url: "ws://127.0.0.1:7777".to_string(),
        session_id: Some("019810de-1e5f-7db3-9c47-1c2a3b4c5d6e".to_string()),
        terminal_id: None,
        server_instance_id: "srv-1".to_string(),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
        state: SidecarRecordState::Active,
    }
}

fn dir_names(root: &Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(root)
        .expect("read_dir root")
        .map(|e| {
            e.expect("dir entry")
                .file_name()
                .to_string_lossy()
                .into_owned()
        })
        .collect();
    names.sort();
    names
}

#[test]
fn record_roundtrips_through_disk() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let active = sample_record("codex-sidecar-11111111-1111-4111-8111-111111111111");
    // A second record pins the Retained tagged-enum shape and the
    // Option-field round-trip (session_id absent, terminal_id present).
    let retained = CodexSidecarRecord {
        ownership_id: "codex-sidecar-22222222-2222-4222-8222-222222222222".to_string(),
        session_id: None,
        terminal_id: Some("term-9".to_string()),
        state: SidecarRecordState::Retained {
            reason: "server_death_with_live_sidecar".to_string(),
        },
        ..sample_record("")
    };
    store.write(&active).expect("write active");
    store.write(&retained).expect("write retained");

    let mut loaded = store.load_all();
    loaded.sort_by(|a, b| a.ownership_id.cmp(&b.ownership_id));
    assert_eq!(loaded, vec![active, retained]);
}

#[test]
fn write_is_atomic_sibling_tmp_then_rename() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let record = sample_record("codex-sidecar-33333333-3333-4333-8333-333333333333");
    store.write(&record).expect("write");

    // No *.tmp-* residue after a successful write (sibling tmp was renamed
    // into place, tabs_persist.rs:682-708 discipline).
    let names = dir_names(dir.path());
    assert!(
        names.iter().all(|n| !n.contains(".tmp-")),
        "no tmp residue may remain: {names:?}"
    );

    // The destination is `<root>/<ownership_id>.json` and parses back.
    let dest = dir.path().join(format!("{}.json", record.ownership_id));
    let bytes = std::fs::read(&dest).expect("destination file exists");
    let parsed: CodexSidecarRecord =
        serde_json::from_slice(&bytes).expect("destination parses as a record");
    assert_eq!(parsed, record);
}

#[test]
fn disabled_store_is_a_silent_noop() {
    let store = CodexSidecarStore::disabled();
    assert!(!store.is_enabled());
    let record = sample_record("codex-sidecar-44444444-4444-4444-8444-444444444444");
    store.write(&record).expect("disabled write is Ok(())");
    store
        .remove(&record.ownership_id)
        .expect("disabled remove is Ok(())");
    assert!(store.load_all().is_empty());
}

#[test]
fn corrupt_record_is_quarantined_not_fatal() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = CodexSidecarStore::new(dir.path().to_path_buf());
    let healthy = sample_record("codex-sidecar-55555555-5555-4555-8555-555555555555");
    store.write(&healthy).expect("write healthy");
    // Hand-written garbage beside it (fail-loud-per-row policy,
    // pane_ledger.rs module header).
    let garbage = dir.path().join("codex-sidecar-garbage.json");
    std::fs::write(&garbage, b"{ this is not json").expect("write garbage");

    let loaded = store.load_all();
    assert_eq!(loaded, vec![healthy], "the healthy row survives");

    assert!(!garbage.exists(), "the garbage row must be renamed aside");
    let names = dir_names(dir.path());
    assert!(
        names
            .iter()
            .any(|n| n.starts_with("codex-sidecar-garbage.json.quarantined-")),
        "quarantine residue must exist: {names:?}"
    );
}

#[cfg(unix)] // flock is the unix-only single-writer primitive (pane_ledger parity)
#[test]
fn second_locked_open_comes_up_disabled() {
    // Single-writer flock (pane_ledger.rs:236-274): never two writers on one
    // store. flock state rides the open file description, so a second open
    // in the SAME process still contends — no child process needed.
    let dir = tempfile::tempdir().expect("tempdir");
    let root = dir.path().to_path_buf();
    let holder = CodexSidecarStore::new_locked(Some(root.clone()));
    assert!(holder.is_enabled(), "first locked open owns the store");
    let record = sample_record("codex-sidecar-66666666-6666-4666-8666-666666666666");
    holder.write(&record).expect("holder write");

    let loser = CodexSidecarStore::new_locked(Some(root.clone()));
    assert!(!loser.is_enabled(), "second locked open must be DISABLED");
    let loser_record = sample_record("codex-sidecar-77777777-7777-4777-8777-777777777777");
    loser
        .write(&loser_record)
        .expect("disabled write is an Ok(()) no-op");
    assert!(loser.load_all().is_empty(), "disabled loser reads nothing");
    assert!(
        !root
            .join(format!("{}.json", loser_record.ownership_id))
            .exists(),
        "the disabled loser's no-op write left no file behind"
    );
    drop(holder);
}
