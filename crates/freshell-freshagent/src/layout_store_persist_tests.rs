//! Tests for the layout-store persistence half (kata b8ke Task 10
//! round-2 review): M1's parent-directory fsync, and M2's offloaded
//! ordered writer (write landing, mutation order, lock-freedom across the
//! in-flight write, and the dead-writer inline fallback).

use super::*;
use crate::layout_store::LayoutStore;
use freshell_protocol::UiLayoutSync;
use serde_json::{json, Value};

/// One tab, one claude-terminal leaf (`p1`-style fixture).
fn one_pane_sync(pane_id: &str, tab_id: &str) -> UiLayoutSync {
    serde_json::from_value(json!({
        "tabs": [{ "id": tab_id, "title": "Persist" }],
        "activeTabId": tab_id,
        "layouts": {
            tab_id: {
                "type": "leaf",
                "id": pane_id,
                "content": { "kind": "terminal", "mode": "claude" },
            },
        },
        "activePane": { tab_id: pane_id },
        "timestamp": 1,
    }))
    .expect("UiLayoutSync parses")
}

fn unique_dir(label: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!(
        "freshell-task10r2-{label}-{}-{}",
        std::process::id(),
        uuid::Uuid::new_v4().simple()
    ));
    std::fs::create_dir_all(&dir).expect("temp dir");
    dir
}

// ── M1: the parent-directory fsync ──────────────────────────────────────────

/// M1: the atomic replace fsyncs the PARENT DIRECTORY after the rename
/// (the `tabs_persist.rs` idiom) — without it the file's contents are
/// durable but the directory entry pointing at it may not be.
#[test]
#[cfg(unix)]
fn persist_fsyncs_the_parent_directory_after_the_rename() {
    let dir = unique_dir("m1-attempt");
    let path = dir.join("layout-store.json");
    let store = LayoutStore::with_persistence(path.clone());
    let before = persist_test_hooks::parent_fsync_attempts();
    store.update_from_ui(&one_pane_sync("p1", "t1"), "c");
    assert!(
        persist_test_hooks::parent_fsync_attempts() > before,
        "the atomic replace must fsync the parent dir so the rename itself is durable"
    );
    assert!(path.exists(), "the write landed: {}", path.display());
    let _ = std::fs::remove_dir_all(&dir);
}

/// M1's best-effort contract: a parent-fsync failure (injected, the
/// `tabs_persist.rs` seam idiom) warn-logs and NEVER blocks the write —
/// the rename already succeeded, so the file is present, valid, and loads.
#[test]
#[cfg(unix)]
fn parent_dir_fsync_failure_is_best_effort_and_never_blocks_the_persist() {
    let dir = unique_dir("m1-inject");
    let path = dir.join("layout-store.json");
    persist_test_hooks::inject_parent_fsync_failure(&dir);
    let store = LayoutStore::with_persistence(path.clone());
    store.update_from_ui(&one_pane_sync("p1", "t1"), "c");
    let raw = std::fs::read_to_string(&path).expect("persisted despite the parent-fsync failure");
    let body: Value = serde_json::from_str(&raw).expect("valid JSON");
    assert_eq!(body["version"], json!(1), "{raw}");
    drop(store);
    let reloaded = LayoutStore::with_persistence(path.clone());
    assert_eq!(
        reloaded.find_pane_tab("p1").as_deref(),
        Some("t1"),
        "the write counted despite the injected parent-fsync failure"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ── M2: the offloaded ordered writer ────────────────────────────────────────

/// M2: an offloaded persist is queued, not written inline — it lands once
/// flushed, and a fresh store on the same path loads it (the restart
/// round-trip through the async writer).
#[tokio::test]
async fn offloaded_persists_land_after_flush_and_survive_a_restart() {
    let dir = unique_dir("m2-flush");
    let path = dir.join("layout-store.json");
    {
        let store =
            LayoutStore::with_persistence_offload(path.clone(), tokio::runtime::Handle::current());
        store.update_from_ui(&one_pane_sync("p1", "t1"), "client-a");
        store.flush_persistence().await;
        let raw = std::fs::read_to_string(&path).expect("the flushed write landed");
        let body: Value = serde_json::from_str(&raw).expect("valid JSON");
        assert_eq!(body["clients"][0]["key"], json!("client-a"), "{raw}");
    } // drop = the "restart"

    let reloaded = LayoutStore::with_persistence(path.clone());
    assert_eq!(
        reloaded.find_pane_tab("p1").as_deref(),
        Some("t1"),
        "the reloaded store resolves the pane written by the offload writer"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// M2's ordering guarantee: the enqueue happens under the layout lock and
/// one consumer drains the queue serially, so back-to-back mutations land
/// in mutation order (most-recent sync first) — a reordered writer would
/// persist the stale snapshot last.
#[tokio::test]
async fn offloaded_persists_preserve_mutation_order() {
    let dir = unique_dir("m2-order");
    let path = dir.join("layout-store.json");
    let store =
        LayoutStore::with_persistence_offload(path.clone(), tokio::runtime::Handle::current());
    store.update_from_ui(&one_pane_sync("pA", "tA"), "conn-a");
    store.update_from_ui(&one_pane_sync("pB", "tB"), "conn-b");
    store.flush_persistence().await;
    let raw = std::fs::read_to_string(&path).expect("the flushed writes landed");
    let body: Value = serde_json::from_str(&raw).expect("valid JSON");
    let clients = body["clients"].as_array().expect("clients array");
    assert_eq!(clients.len(), 2, "{raw}");
    assert_eq!(
        clients[0]["key"],
        json!("conn-b"),
        "most-recent sync first: {raw}"
    );
    assert_eq!(
        clients[1]["key"],
        json!("conn-a"),
        "mutation order preserved: {raw}"
    );
    let _ = std::fs::remove_dir_all(&dir);
}

/// M2's core claim, pinned deterministically: while a durable write is
/// held mid-flight (the test gate), the update path does NOT hold the
/// layout lock — a by-id read keeps making progress and observes the
/// in-memory mutation. (Against the pre-M2 code — persist inline under
/// the layout mutex on the mutating thread — the read blocks on the
/// mutex and this test times out red.)
#[tokio::test]
async fn the_update_path_does_not_hold_the_layout_lock_across_the_offloaded_write() {
    let dir = unique_dir("m2-lock");
    let path = dir.join("layout-store.json");
    let store =
        LayoutStore::with_persistence_offload(path.clone(), tokio::runtime::Handle::current());

    let gate = persist_test_hooks::hold_writes();
    let updating = {
        let store = store.clone();
        tokio::task::spawn_blocking(move || {
            store.update_from_ui(&one_pane_sync("p1", "t1"), "client-a");
        })
    };
    // The probe POLLS the layout store: every iteration takes the layout
    // lock, so it only ever resolves while the lock is free — a persist
    // that held the mutex across the stalled write would freeze it here.
    let probing = {
        let store = store.clone();
        tokio::task::spawn_blocking(move || {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
            loop {
                if let Some(tab_id) = store.find_pane_tab("p1") {
                    return Some(tab_id);
                }
                if std::time::Instant::now() > deadline {
                    return None;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        })
    };
    let resolved = tokio::time::timeout(std::time::Duration::from_secs(4), probing)
        .await
        .expect("the layout lock stays free while the durable write is stalled")
        .expect("probe joined");
    assert_eq!(
        resolved.as_deref(),
        Some("t1"),
        "the in-memory mutation landed; only the durable write is in flight"
    );

    drop(gate); // release the stalled write
    updating.await.expect("update joined after the gate opened");
    store.flush_persistence().await;
    let raw = std::fs::read_to_string(&path).expect("the stalled write landed after the flush");
    assert!(raw.contains("\"p1\""), "{raw}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// M2's degraded path: a mutation whose writer is gone (its runtime shut
/// down, so the enqueue fails) falls back to the INLINE write on the
/// mutating thread — the mutation still persists, never silently dropped.
#[tokio::test]
async fn a_dead_writer_falls_back_to_the_inline_write() {
    let dir = unique_dir("m2-orphan");
    let path = dir.join("layout-store.json");
    let store =
        LayoutStore::with_persistence_offload(path.clone(), tokio::runtime::Handle::current());
    // Simulate the writer's runtime dying: replace the queue sender with
    // one whose receiver is already dropped (this also ends the real
    // writer task — its last sender went away).
    let (orphan_tx, orphan_rx) = tokio::sync::mpsc::unbounded_channel::<PersistMsg>();
    drop(orphan_rx);
    store.lock().persist_tx = Some(orphan_tx);

    store.update_from_ui(&one_pane_sync("p1", "t1"), "client-a");
    let raw = std::fs::read_to_string(&path).expect("the inline fallback write landed");
    assert!(raw.contains("\"p1\""), "{raw}");
    let _ = std::fs::remove_dir_all(&dir);
}
