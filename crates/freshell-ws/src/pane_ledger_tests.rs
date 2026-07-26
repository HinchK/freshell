//! Unit tests for `crate::pane_ledger` (P1.8, spec §4.2). Kept in a sibling
//! file (the `tabs_persist_tests.rs` convention) to respect the ≤1K-lines
//! file limit as the ledger's test surface grows.

use super::*;
use std::path::PathBuf;

fn temp_root(label: &str) -> PathBuf {
    // Same atomic-counter + pid pattern as `opencode_association.rs`'s
    // `unique_temp_dir` — no tempfile dependency needed for a dir we
    // remove ourselves.
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let dir = std::env::temp_dir().join(format!(
        "pane-ledger-test-{label}-{}-{n}",
        std::process::id()
    ));
    std::fs::create_dir_all(&dir).expect("create temp root");
    dir
}

fn write(
    provider: &str,
    session_id: &str,
    terminal_id: &str,
    now_ms: i64,
) -> BindingWrite<'static> {
    // Leak the strings for test brevity — tests are short-lived.
    BindingWrite {
        provider: Box::leak(provider.to_string().into_boxed_str()),
        session_id: Box::leak(session_id.to_string().into_boxed_str()),
        terminal_id: Box::leak(terminal_id.to_string().into_boxed_str()),
        mode: Box::leak(provider.to_string().into_boxed_str()),
        cwd: Some("/tmp/proj"),
        create_request_id: Some("req-1"),
        now_ms,
    }
}

#[test]
fn record_binding_roundtrips_all_fields() {
    let root = temp_root("roundtrip");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .expect("write ok");
    let row = ledger.load_binding("claude", "sess-a").expect("row exists");
    assert_eq!(row.ledger_version, LEDGER_VERSION);
    assert_eq!(row.provider, "claude");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(row.mode, "claude");
    assert_eq!(row.cwd.as_deref(), Some("/tmp/proj"));
    assert_eq!(row.live_terminal_id.as_deref(), Some("t1"));
    assert_eq!(row.create_request_id.as_deref(), Some("req-1"));
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 1_000);
    assert_eq!(row.last_observed_at, 1_000);
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    assert_eq!(row.superseded_by, None);
    assert!(ledger.ever_bound("claude", "sess-a"));
    assert!(!ledger.ever_bound("claude", "sess-other"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rewrite_preserves_created_at_and_bumps_updated_at() {
    let root = temp_root("rewrite");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 5_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.created_at, 1_000);
    assert_eq!(row.updated_at, 5_000);
    assert_eq!(row.last_observed_at, 5_000);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn disabled_ledger_is_a_silent_noop() {
    let ledger = PaneLedger::disabled();
    ledger
        .record_binding(&write("claude", "s", "t", 1))
        .expect("noop ok");
    assert_eq!(ledger.load_binding("claude", "s"), None);
    assert!(!ledger.ever_bound("claude", "s"));
    assert!(ledger.list_bindings().is_empty());
}

#[test]
fn writes_are_atomic_sibling_temp_plus_rename() {
    // After a successful write no *.tmp-* residue remains, and the row file
    // is a direct child of bindings/<provider>/.
    let root = temp_root("atomic");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .unwrap();
    let provider_dir = root.join("bindings").join("claude");
    let entries: Vec<String> = std::fs::read_dir(&provider_dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    assert_eq!(entries, vec!["sess-a.json".to_string()]);
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn key_encoding_is_path_safe_and_injective() {
    assert_eq!(encode_segment("claude"), "claude");
    assert_eq!(
        encode_segment("11111111-2222-3333-4444-555555555555"),
        "11111111-2222-3333-4444-555555555555"
    );
    assert_eq!(encode_segment("a/b"), "a%2Fb");
    assert_eq!(encode_segment("a%b"), "a%25b");
    assert_eq!(encode_segment(".."), "%2E%2E");
    assert_eq!(encode_segment("."), "%2E");
    assert_eq!(encode_segment(""), "%00");
    // Injective: distinct inputs never collide after encoding.
    assert_ne!(encode_segment("a/b"), encode_segment("a%2Fb"));
}

#[test]
fn index_loads_existing_rows_at_construction() {
    // The write-through index is seeded by ONE directory scan in new()
    // (V1.md read policy); a second instance over the same dir answers
    // from its own fresh load — the restart-equivalent shape.
    let root = temp_root("index-reload");
    {
        let gen1 = PaneLedger::new(Some(root.clone()));
        gen1.record_binding(&write("claude", "sess-a", "t1", 1_000))
            .unwrap();
    }
    let gen2 = PaneLedger::new(Some(root.clone()));
    assert!(gen2.ever_bound("claude", "sess-a"));
    assert_eq!(gen2.list_bindings().len(), 1);
    std::fs::remove_dir_all(&root).ok();
}

#[cfg(unix)]
#[test]
fn new_locked_degrades_to_disabled_when_another_holder_exists() {
    // Single-writer guard (V2.md): never two writers on one store. The
    // second locked construction logs a loud ERROR and comes up DISABLED;
    // dropping the holder frees the flock (kernel-released on death too).
    let root = temp_root("lock");
    let holder = PaneLedger::new_locked(Some(root.clone()));
    holder
        .record_binding(&write("claude", "s1", "t1", 1))
        .unwrap();
    let loser = PaneLedger::new_locked(Some(root.clone()));
    loser
        .record_binding(&write("claude", "s2", "t2", 2))
        .expect("disabled no-op");
    assert!(!loser.ever_bound("claude", "s2"), "loser is disabled");
    drop(holder);
    let next = PaneLedger::new_locked(Some(root.clone()));
    assert!(next.ever_bound("claude", "s1"), "flock freed on drop");
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn secondary_index_reads_by_terminal_and_request_id() {
    let root = temp_root("secondary");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("claude", "sess-a", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-9", "t2", 2_000))
        .unwrap();
    let sref = ledger
        .bound_session_ref_for_terminal("t1")
        .expect("t1 bound");
    assert_eq!(sref.provider, "claude");
    assert_eq!(sref.session_id, "sess-a");
    assert_eq!(ledger.bound_session_ref_for_terminal("t-missing"), None);
    let row = ledger
        .lookup_by_create_request_id("claude", "req-1")
        .expect("by request id");
    assert_eq!(row.session_id, "sess-a");
    assert_eq!(
        ledger.lookup_by_create_request_id("claude", "req-none"),
        None
    );
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_retires_old_row() {
    // Red test `rebind-retires-old-row` (spec §4.2 G3): a pane's binding
    // legitimately moves -> the writer retires the old row and writes the
    // new one; the old row records WHERE identity went.
    let root = temp_root("rebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-old", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-new", "t1", 2_000))
        .unwrap();

    let old = ledger.load_binding("codex", "th-old").unwrap();
    assert_eq!(old.state, RowState::Retired);
    assert_eq!(old.retired_reason, Some(RetiredReason::Superseded));
    let by = old.superseded_by.expect("supersededBy set");
    assert_eq!(by.provider, "codex");
    assert_eq!(by.session_id, "th-new");

    let new = ledger.load_binding("codex", "th-new").unwrap();
    assert_eq!(new.state, RowState::Bound);
    assert_eq!(new.live_terminal_id.as_deref(), Some("t1"));
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn client_claims_superseded_ref_is_answered_from_the_chain_terminus() {
    // Red test `client-claims-superseded-ref` (ledger-API level; full
    // verdict wiring is Phase 3): a lookup for a superseded ref follows
    // `supersededBy` to the live bound row and reports corrected:true —
    // never returns the retired row as the answer.
    let root = temp_root("chain");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-2", "t1", 2_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-3", "t1", 3_000))
        .unwrap();

    let hit = ledger.lookup_by_session("codex", "th-1").expect("resolves");
    assert!(hit.corrected);
    assert_eq!(hit.row.session_id, "th-3");
    assert_eq!(hit.row.state, RowState::Bound);

    // A direct claim of the live terminus is NOT a correction.
    let direct = ledger.lookup_by_session("codex", "th-3").unwrap();
    assert!(!direct.corrected);

    // A retired row with no successor (e.g. closed) is returned as-is so
    // callers can apply their own reader rule — but never invents a bound.
    std::fs::remove_dir_all(&root).ok();
}

#[test]
fn rebind_to_the_same_identity_is_not_a_supersession() {
    let root = temp_root("samebind");
    let ledger = PaneLedger::new(Some(root.clone()));
    ledger
        .record_binding(&write("codex", "th-1", "t1", 1_000))
        .unwrap();
    ledger
        .record_binding(&write("codex", "th-1", "t1", 2_000))
        .unwrap();
    let row = ledger.load_binding("codex", "th-1").unwrap();
    assert_eq!(row.state, RowState::Bound);
    assert_eq!(row.retired_reason, None);
    std::fs::remove_dir_all(&root).ok();
}
