//! The durable-persistence half of the layout store (kata b8ke Task 10 +
//! round-2 review M1/M2), split out per the `layout_store_content.rs`
//! precedent to keep `layout_store.rs` under the 1,000-line ceiling.
//!
//! - WRITE (atomic + durable): temp+write+fsync, rename, then a
//!   best-effort parent-directory fsync (M1 — the `tabs_persist.rs` /
//!   `sidecar_store.rs` durable-replace idiom, so the rename itself
//!   survives a power loss). The write runs either INLINE on the mutating
//!   thread (no writer wired: tests, `None`-home runs) or OFF the async
//!   runtime (M2): the snapshot is serialized under the layout lock, the
//!   message is enqueued BEFORE the lock is released (queue order ==
//!   mutation order), and ONE ordered writer task performs each durable
//!   write inside `spawn_blocking` — the repo's A13 discipline
//!   (`terminal.rs` / pane-ledger writes). A ~15ms fsync therefore never
//!   pins an async worker and never runs under the layout mutex.
//! - LOAD: best-effort on construction, unchanged from Task 10 (schema
//!   gate; corrupt/absent → warn + boot empty — never a crash).

use std::collections::HashMap;

use serde_json::{json, Value};

use super::{
    nested_bool_map, nested_string_map, snapshot_value, ClientEntry, LayoutInner, TabRow,
    UiSnapshot,
};
use crate::layout_tree::PaneNode;

/// The persisted-file schema version (kata b8ke Task 10): `{"version": 1,
/// "clients": [{key, snapshot, stale}]}`. No rotation, no migration beyond
/// this field — a future shape change bumps it and loads empty.
const PERSIST_SCHEMA_VERSION: i64 = 1;

/// One message for the ordered persist writer (M2): a serialized snapshot
/// to durably replace the file with, or a flush sentinel (acked strictly
/// after every previously-queued write has landed — same channel, one
/// consumer).
pub(super) enum PersistMsg {
    Write {
        path: std::path::PathBuf,
        body: String,
    },
    Flush(tokio::sync::oneshot::Sender<()>),
}

/// Serialize the multi-client snapshot and dispatch the durable write.
/// Called with the inner lock held, as the LAST step of every snapshot-set
/// mutation (single-process single-writer).
///
/// M2 dispatch: the serialization below IS the "clone under the lock";
/// with a writer wired ([`spawn_offload_writer`], production) the message
/// is enqueued before the caller releases the layout lock — so the
/// single-consumer channel order equals mutation order — and the writer
/// task performs the write inside `spawn_blocking`, off every async
/// worker. Without a writer (tests / `None`-home runs, synchronous
/// contexts only) the write runs inline on the calling thread.
///
/// Best-effort either way: a failure warn-logs and NEVER blocks the
/// mutation that called it (the in-memory store stays authoritative for
/// this boot).
pub(super) fn persist_locked(inner: &LayoutInner) {
    let Some(path) = &inner.persist_path else {
        return;
    };
    let body = json!({
        "version": PERSIST_SCHEMA_VERSION,
        "clients": inner
            .clients
            .iter()
            .map(|entry| json!({
                "key": entry.key,
                "snapshot": snapshot_value(&entry.snapshot),
                "stale": entry.stale,
            }))
            .collect::<Vec<_>>(),
    })
    .to_string();
    if let Some(tx) = &inner.persist_tx {
        let send = tx.send(PersistMsg::Write {
            path: path.clone(),
            body,
        });
        if send.is_ok() {
            return;
        }
        // The writer is gone (its runtime shut down mid-boot): the channel
        // hands the message back — degrade to the inline write below
        // rather than drop this mutation's persist.
        tracing::warn!(
            target: "freshell_freshagent::layout_store",
            path = %path.display(),
            "layout_store_persist_writer_gone: falling back to an inline write"
        );
        if let Err(tokio::sync::mpsc::error::SendError(PersistMsg::Write { path, body })) = send {
            write_persist_file(&path, &body);
        }
        return;
    }
    write_persist_file(path, &body);
}

/// Spawn the ONE ordered persist writer on `runtime` and return its queue
/// sender (M2). The writer drains the channel serially and performs each
/// durable write inside `spawn_blocking` (A13); it exits when the last
/// sender drops. Panics inside a write (there are none by construction —
/// [`write_persist_file`] only warn-logs) would surface here as a warn
/// and lose exactly that one queued write.
pub(super) fn spawn_offload_writer(
    runtime: &tokio::runtime::Handle,
) -> tokio::sync::mpsc::UnboundedSender<PersistMsg> {
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<PersistMsg>();
    runtime.spawn(async move {
        while let Some(msg) = rx.recv().await {
            match msg {
                PersistMsg::Write { path, body } => {
                    if let Err(error) =
                        tokio::task::spawn_blocking(move || write_persist_file(&path, &body)).await
                    {
                        tracing::warn!(
                            target: "freshell_freshagent::layout_store",
                            %error,
                            "layout_store_persist_write_panicked: one queued write lost"
                        );
                    }
                }
                // Acked strictly after every previously-queued write landed.
                PersistMsg::Flush(ack) => {
                    let _ = ack.send(());
                }
            }
        }
    });
    tx
}

/// Enqueue a flush sentinel and wait for its ack: returns once every
/// persist queued before this call has been durably written (graceful
/// shutdown; tests). A dead writer (send fails) returns immediately —
/// there is nothing left to drain.
pub(super) async fn send_flush_and_wait(tx: &tokio::sync::mpsc::UnboundedSender<PersistMsg>) {
    let (ack_tx, ack_rx) = tokio::sync::oneshot::channel();
    if tx.send(PersistMsg::Flush(ack_tx)).is_ok() {
        let _ = ack_rx.await;
    }
}

/// The durable replace shared by the inline and offloaded persist paths:
/// write `path.tmp`, `sync_all`, rename, then best-effort fsync the parent
/// so the rename itself survives a power loss (M1). Failures warn-log and
/// never propagate (the in-memory store stays authoritative for this
/// boot).
fn write_persist_file(path: &std::path::Path, body: &str) {
    // Test seam (the `tabs_persist.rs` injected-failure idiom): lets a
    // test hold the durable write mid-flight.
    #[cfg(test)]
    persist_test_hooks::wait_for_write_gate();
    let write = (|| -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        let mut file = std::fs::File::create(&tmp)?;
        use std::io::Write;
        file.write_all(body.as_bytes())?;
        file.sync_all()?;
        std::fs::rename(&tmp, path)?;
        // M1: the file's contents are durable, but the directory entry
        // pointing at it is not until the parent dir is fsynced. The
        // rename already succeeded, so a failure here is best-effort —
        // warn and still count the write.
        #[cfg(unix)]
        if let Some(parent) = path.parent() {
            if let Err(error) = fsync_parent_dir(parent) {
                tracing::warn!(
                    target: "freshell_freshagent::layout_store",
                    %error,
                    parent = %parent.display(),
                    "layout_store_persist_parent_fsync_failed: the rename may not be durable"
                );
            }
        }
        Ok(())
    })();
    if let Err(error) = write {
        tracing::warn!(
            target: "freshell_freshagent::layout_store",
            %error,
            path = %path.display(),
            "layout_store_persist_failed: keeping the in-memory snapshot"
        );
    }
}

/// The M1 parent-directory fsync. The `#[cfg(test)]` hook counts attempts
/// and surfaces injected failures so the best-effort contract is pinnable.
#[cfg(unix)]
fn fsync_parent_dir(parent: &std::path::Path) -> std::io::Result<()> {
    #[cfg(test)]
    {
        persist_test_hooks::note_parent_fsync_attempt(parent)?;
    }
    std::fs::File::open(parent)?.sync_all()
}

/// Test seams for the persist write path (the `tabs_persist.rs`
/// injected-failure idiom): the write gate holds every durable write
/// mid-flight (proving the layout lock is free while I/O is in flight),
/// and the parent-fsync hooks count attempts / inject failures.
#[cfg(test)]
mod persist_test_hooks {
    use std::collections::HashSet;
    use std::path::{Path, PathBuf};
    use std::sync::{Condvar, LazyLock, Mutex};

    static WRITE_GATE: (Mutex<bool>, Condvar) = (Mutex::new(false), Condvar::new());
    static PARENT_SYNC_ATTEMPTS: Mutex<usize> = Mutex::new(0);
    static INJECTED_PARENT_SYNC_FAILURES: LazyLock<Mutex<HashSet<PathBuf>>> =
        LazyLock::new(|| Mutex::new(HashSet::new()));

    /// Block the calling write until the gate opens (test-only).
    pub(super) fn wait_for_write_gate() {
        let mut held = WRITE_GATE.0.lock().unwrap();
        while *held {
            held = WRITE_GATE.1.wait(held).unwrap();
        }
    }

    /// Hold every durable write until the returned guard drops (also on a
    /// panicking unwind, so a red test never poisons the shared gate).
    pub(super) fn hold_writes() -> WriteGateHold {
        *WRITE_GATE.0.lock().unwrap() = true;
        WriteGateHold
    }

    pub(super) struct WriteGateHold;
    impl Drop for WriteGateHold {
        fn drop(&mut self) {
            *WRITE_GATE.0.lock().unwrap() = false;
            WRITE_GATE.1.notify_all();
        }
    }

    /// Count a parent-fsync attempt and surface an injected failure.
    pub(super) fn note_parent_fsync_attempt(parent: &Path) -> std::io::Result<()> {
        *PARENT_SYNC_ATTEMPTS.lock().unwrap() += 1;
        if INJECTED_PARENT_SYNC_FAILURES
            .lock()
            .unwrap()
            .contains(parent)
        {
            return Err(std::io::Error::other("injected parent fsync failure"));
        }
        Ok(())
    }

    pub(super) fn parent_fsync_attempts() -> usize {
        *PARENT_SYNC_ATTEMPTS.lock().unwrap()
    }

    pub(super) fn inject_parent_fsync_failure(parent: &Path) {
        INJECTED_PARENT_SYNC_FAILURES
            .lock()
            .unwrap()
            .insert(parent.to_path_buf());
    }
}

/// The load half of [`persist_locked`]: parse the persisted clients array
/// back into `inner`. Every loaded entry is marked STALE (post-restart, no
/// connection is live; the change-gated client mirror re-supersedes them on
/// its next sync via the existing subset-eviction rule).
pub(super) fn load_persisted_clients(inner: &mut LayoutInner, body: &Value) {
    if body.get("version").and_then(Value::as_i64) != Some(PERSIST_SCHEMA_VERSION) {
        tracing::warn!(
            target: "freshell_freshagent::layout_store",
            version = ?body.get("version"),
            "layout_store_persist_unsupported_version: booting empty"
        );
        return;
    }
    let Some(clients) = body.get("clients").and_then(Value::as_array) else {
        tracing::warn!(
            target: "freshell_freshagent::layout_store",
            "layout_store_persist_malformed: no clients array, booting empty"
        );
        return;
    };
    for entry in clients {
        let Some(key) = entry.get("key").and_then(Value::as_str) else {
            continue;
        };
        let Some(snapshot_value_json) = entry.get("snapshot") else {
            continue;
        };
        let Some(snapshot) = snapshot_from_value(snapshot_value_json) else {
            continue;
        };
        inner.clients.push(ClientEntry {
            key: key.to_string(),
            snapshot,
            // A restarted server has no live connections — retained, never
            // primary while a live client exists (the stale-entry contract).
            stale: true,
        });
    }
    tracing::info!(
        target: "freshell_freshagent::layout_store",
        entries = inner.clients.len(),
        "layout_store_persist_loaded: registry restored from disk"
    );
}

/// Rebuild one [`UiSnapshot`] from its persisted JSON (the `snapshot_value`
/// round-trip): tabs/activeTabId/layouts (via `PaneNode::parse`)/
/// activePane/paneTitles/paneTitleSetByUser/timestamp.
fn snapshot_from_value(value: &Value) -> Option<UiSnapshot> {
    let obj = value.as_object()?;
    let mut snapshot = UiSnapshot {
        tabs: Vec::new(),
        active_tab_id: obj
            .get("activeTabId")
            .and_then(Value::as_str)
            .map(str::to_string),
        layouts: HashMap::new(),
        active_pane: HashMap::new(),
        pane_titles: nested_string_map(obj.get("paneTitles")),
        pane_title_set_by_user: nested_bool_map(obj.get("paneTitleSetByUser")),
        timestamp: obj.get("timestamp").and_then(Value::as_i64),
    };
    for tab in obj.get("tabs")?.as_array()? {
        // Unified agent names (Task 6): the stable naming-source
        // relationship round-trips the persisted registry the same way
        // `tab_row_value` wrote it — a restart must never drop a tab's
        // name source (the rename-tab route resolves it, never the
        // active pane). Absent on pre-Task-6 files → `None`.
        let name_source = tab.get("nameSource").and_then(|value| {
            serde_json::from_value::<freshell_protocol::session_names::TabNameSource>(value.clone())
                .ok()
        });
        snapshot.tabs.push(TabRow {
            name_source,
            id: tab.get("id")?.as_str()?.to_string(),
            title: tab.get("title").and_then(Value::as_str).map(str::to_string),
            fallback_session_ref: tab.get("fallbackSessionRef").cloned(),
        });
    }
    if let Some(layouts) = obj.get("layouts").and_then(Value::as_object) {
        for (tab_id, node) in layouts {
            // The persistence layer is a verbatim round-trip of what the
            // store itself wrote (`PaneNode::to_value`), so the migration
            // pass is not needed — but running it keeps a hand-edited or
            // legacy-shaped file on the same code path as a live sync.
            let migrated = super::content::migrate_legacy_fresh_agent_node(node);
            if let Some(parsed) = PaneNode::parse(&migrated) {
                snapshot.layouts.insert(tab_id.clone(), parsed);
            }
        }
    }
    if let Some(active_pane) = obj.get("activePane").and_then(Value::as_object) {
        for (tab_id, pane_id) in active_pane {
            if let Some(pane_id) = pane_id.as_str() {
                snapshot
                    .active_pane
                    .insert(tab_id.clone(), pane_id.to_string());
            }
        }
    }
    Some(snapshot)
}

#[cfg(test)]
#[path = "layout_store_persist_tests.rs"]
mod tests;
