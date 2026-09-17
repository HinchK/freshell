//! Native writeback contract tests (plan Task 3): the finite cycle machine,
//! receipt/outcome folding, worker ownership, and the error classification
//! the adapters must preserve. Everything drives the REAL temp-file store
//! through the strict transaction path plus a deterministic scripted backend
//! whose late effects are applied by DETACHED tasks — an external write
//! continues after the client-side future already gave up, never a future
//! whose drop cancels the effect.

use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use freshell_freshagent::naming::{
    BindNameInput, NameError, NativeNameObservation, NativeNameOrigin, PendingNameInput,
    RenameNameInput, SessionNaming,
};
use freshell_protocol::native_location::{
    NativeAcquisition, NativeEvidenceKind, NativeLocation, NativePersistence,
};
use freshell_protocol::session_names::NameIntent;
use freshell_protocol::session_names::{
    NativeSyncProjection, NativeSyncStatus, SessionNameRef, SessionNameUpdate,
};
use serde_json::Value;

use super::{
    NativeCallResult, NativeNameBackend, NativeNameReadback, NativeNameTarget, NativeOutcomeFold,
    SessionNameWorker,
};
use crate::session_names::SessionNames;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn temp_data_dir() -> tempfile::TempDir {
    tempfile::tempdir().expect("tempdir")
}

fn open_store(dir: &std::path::Path) -> Arc<SessionNames> {
    SessionNames::open(dir.to_path_buf()).expect("open store")
}

fn pending(id: &str) -> SessionNameRef {
    SessionNameRef::Pending { id: id.to_string() }
}

fn session(provider: freshell_protocol::session_names::NamedProvider, id: &str) -> SessionNameRef {
    SessionNameRef::Session {
        provider,
        session_id: id.to_string(),
    }
}

fn claude_location(root: &str, session_id: &str) -> NativeLocation {
    NativeLocation::Claude {
        config_root: root.to_string(),
        transcript_path: Some(format!("{root}/projects/-p/{session_id}.jsonl")),
        project_directory_key: None,
        transcript_cwd: None,
        effective_project_key_override: None,
    }
}

fn verified_acquisition(location: NativeLocation) -> NativeAcquisition {
    NativeAcquisition {
        location,
        evidence: NativeEvidenceKind::SelectedTranscript,
        persistence: NativePersistence::Verified,
    }
}

async fn ensure_pending(
    store: &Arc<SessionNames>,
    handle: &str,
    cwd: Option<&str>,
) -> Result<SessionNameUpdate, NameError> {
    store
        .ensure_pending(PendingNameInput {
            handle: handle.to_string(),
            provider: freshell_protocol::session_names::NamedProvider::Claude,
            cwd: cwd.map(str::to_string),
        })
        .await
}

async fn rename_user(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::User,
            if_revision: None,
        })
        .await
}

async fn rename_automatic(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    name: &str,
) -> Result<SessionNameUpdate, NameError> {
    store
        .rename(RenameNameInput {
            target,
            name: name.to_string(),
            intent: NameIntent::Automatic,
            if_revision: None,
        })
        .await
}

async fn record_acquisition(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    acquisition: NativeAcquisition,
) -> Result<SessionNameUpdate, NameError> {
    store.record_acquisition(target, acquisition).await
}

async fn observe(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
    title: &str,
    location_revision: u64,
) -> Result<SessionNameUpdate, NameError> {
    store
        .observe_native(NativeNameObservation {
            target,
            title: title.to_string(),
            origin: NativeNameOrigin::Snapshot,
            location_revision,
            event_id: None,
        })
        .await
}

async fn native_sync_of(
    store: &Arc<SessionNames>,
    target: SessionNameRef,
) -> Option<NativeSyncProjection> {
    let updates = store.get(vec![target]).await.expect("get succeeds");
    updates.into_iter().next()?.native_sync
}

/// Read the durable document JSON (black-box: receipts/cycles live in the
/// internal sections; the file is the contract).
fn document_json(dir: &std::path::Path) -> Value {
    let bytes = std::fs::read(dir.join("session-names.json")).expect("document exists");
    serde_json::from_slice(&bytes).expect("document parses")
}

// ---------------------------------------------------------------------------
// The deterministic scripted backend
// ---------------------------------------------------------------------------

enum WriteStep {
    /// Confirmed write; the provider applies the attempted title.
    Confirm,
    /// Ambiguous answer, but a DETACHED task applies the attempted title
    /// after `delay_ms` — the external write continues after the client-side
    /// future already gave up.
    AmbiguousLateApply {
        delay_ms: u64,
    },
    /// Ambiguous answer; the write never lands.
    Undelivered,
    Unsupported,
}

/// A deterministic in-memory provider: reads answer the shared provider-side
/// title (so detached late-apply tasks are observable), writes follow the
/// scripted step list. Read/write counters pin the finite allowances.
struct ScriptedBackend {
    reads: AtomicU32,
    writes: AtomicU32,
    provider_title: Arc<Mutex<Option<String>>>,
    steps: Mutex<VecDeque<WriteStep>>,
    /// One-shot read gate: the FIRST read parks until the gate is notified
    /// (tests use this to mutate the store while a cycle is mid-flight —
    /// the worker holds the background guard, never the document lock).
    gate_armed: AtomicBool,
    gate_arrived: Arc<tokio::sync::Notify>,
    gate_open: Arc<tokio::sync::Notify>,
}

impl ScriptedBackend {
    fn new(steps: Vec<WriteStep>) -> Arc<Self> {
        Arc::new(Self {
            reads: AtomicU32::new(0),
            writes: AtomicU32::new(0),
            provider_title: Arc::new(Mutex::new(None)),
            steps: Mutex::new(steps.into_iter().collect()),
            gate_armed: AtomicBool::new(false),
            gate_arrived: Arc::new(tokio::sync::Notify::new()),
            gate_open: Arc::new(tokio::sync::Notify::new()),
        })
    }

    fn arm_read_gate(self: &Arc<Self>) -> Arc<Self> {
        self.gate_armed.store(true, Ordering::SeqCst);
        Arc::clone(self)
    }

    fn reads(&self) -> u32 {
        self.reads.load(Ordering::SeqCst)
    }

    fn writes(&self) -> u32 {
        self.writes.load(Ordering::SeqCst)
    }

    fn set_title(&self, title: Option<&str>) {
        *self.provider_title.lock().unwrap() = title.map(str::to_string);
    }
}

impl NativeNameBackend for ScriptedBackend {
    fn read(&self, _target: NativeNameTarget) -> super::NativeFuture<NativeNameReadback> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        if self.gate_armed.swap(false, Ordering::SeqCst) {
            self.gate_arrived.notify_one();
            let open = Arc::clone(&self.gate_open);
            let provider_title = Arc::clone(&self.provider_title);
            return Box::pin(async move {
                open.notified().await;
                let title = provider_title.lock().unwrap().clone();
                NativeCallResult::Confirmed(NativeNameReadback { title })
            });
        }
        let title = self.provider_title.lock().unwrap().clone();
        Box::pin(async move { NativeCallResult::Confirmed(NativeNameReadback { title }) })
    }

    fn write(&self, attempt: super::NativeNameAttempt) -> super::NativeFuture<()> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        let step = self
            .steps
            .lock()
            .unwrap()
            .pop_front()
            .unwrap_or(WriteStep::Confirm);
        let provider_title = Arc::clone(&self.provider_title);
        Box::pin(async move {
            match step {
                WriteStep::Confirm => {
                    *provider_title.lock().unwrap() = Some(attempt.title.clone());
                    NativeCallResult::Confirmed(())
                }
                WriteStep::AmbiguousLateApply { delay_ms } => {
                    // The provider applies the write LATE via a detached
                    // task: the effect survives even though this client-side
                    // future already answered ambiguous.
                    let title = attempt.title.clone();
                    tokio::spawn(async move {
                        tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                        *provider_title.lock().unwrap() = Some(title);
                    });
                    NativeCallResult::Ambiguous(
                        "scripted timeout; the write may still land".to_string(),
                    )
                }
                WriteStep::Undelivered => NativeCallResult::Undelivered(
                    "scripted connect refusal (provably never dispatched)".to_string(),
                ),
                WriteStep::Unsupported => NativeCallResult::Unsupported(
                    "scripted capability failure (archived)".to_string(),
                ),
            }
        })
    }
}

// ---------------------------------------------------------------------------
// A standard armed series: pending handle → manual rename → verified
// location recorded → the native series is armed.
// ---------------------------------------------------------------------------

/// Seed one pending record with a MANUAL name and a verified claude route at
/// `root`, returning the pending target.
async fn armed_pending(store: &Arc<SessionNames>, handle: &str, root: &str) -> SessionNameRef {
    let target = pending(handle);
    ensure_pending(store, handle, Some("/work/project"))
        .await
        .expect("ensure");
    rename_user(store, target.clone(), "Manual Title")
        .await
        .expect("manual rename");
    record_acquisition(
        store,
        target.clone(),
        verified_acquisition(claude_location(root, handle)),
    )
    .await
    .expect("acquire");
    target
}

// ---------------------------------------------------------------------------
// The finite cycle machine
// ---------------------------------------------------------------------------

/// Ordinary confirmed success: one pre-write read (divergent), one write,
/// one confirming readback — the exact revision synchronizes and the unused
/// remaining cycles pause.
#[tokio::test]
async fn confirmed_write_and_readback_synchronizes_the_exact_revision() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-confirm", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(Some("Something Else"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.reads(), 2, "pre-write read + confirming readback");
    assert_eq!(backend.writes(), 1, "at most one write per cycle");
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series projected");
    assert_eq!(sync.status, NativeSyncStatus::Synced);
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(sync.desired_revision, record.revision, "the exact revision");
    assert_eq!(sync.location_revision, 1, "the verified location revision");
    assert_eq!(
        record.name, "Manual Title",
        "provider failure never rolls back the name"
    );
    // Synchronized series pause their unused cycles: no further work.
    assert!(
        store.native_work_snapshot().is_empty(),
        "synced series hold no ready work"
    );
}

/// The pre-write read already holding the desired value synchronizes without
/// a write (the native already projects the exact name).
#[tokio::test]
async fn matching_pre_write_read_synchronizes_without_a_write() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-match", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![]);
    backend.set_title(Some("Manual Title"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;

    assert_eq!(backend.reads(), 1);
    assert_eq!(backend.writes(), 0, "nothing to reconcile");
    let sync = native_sync_of(&store, target).await.expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Synced);
}

/// Three cycles maximum; failures schedule the retry floors; exhaustion is
/// final across restarts, duplicate events, and location re-checks; and the
/// read allowance never exceeds six.
#[tokio::test]
async fn undelivered_failures_bound_at_three_cycles_six_reads_and_exhaust_permanently() {
    let dir = temp_data_dir();
    // Shrink the 5s/30s retry floors so the bounded-allowance math is
    // observable without wall-clock waits (the production floors are pinned
    // by their constants; this hook only accelerates eligibility).
    crate::session_names::set_test_hooks(
        dir.path(),
        vec![crate::session_names::TestHook::NativeRetryFloorMs(60)],
    );
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-exhaust", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![
        WriteStep::Undelivered,
        WriteStep::Undelivered,
        WriteStep::Undelivered,
    ]);
    backend.set_title(Some("Divergent"));

    // Cycle 1 runs immediately.
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 1);
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(sync.reason.unwrap().contains("connect refusal"));

    // Cycle 2 is not ready until the retry floor elapses.
    assert!(
        store.native_work_snapshot().is_empty(),
        "cycle 2 waits for the retry floor"
    );
    assert!(
        store
            .claim_native_cycle(target.clone(), "r2".to_string())
            .await
            .unwrap()
            .is_none(),
        "not yet due consumes nothing"
    );
    tokio::time::sleep(Duration::from_millis(80)).await;

    // Exhaust cycles 2 and 3 through the real dispatch loop.
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    tokio::time::sleep(Duration::from_millis(80)).await;
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(backend.writes(), 3, "at most three writes per revision");
    assert_eq!(backend.reads(), 3);

    // Cycle 4: exhaustion is final.
    assert!(
        store
            .claim_native_cycle(target.clone(), "r4".to_string())
            .await
            .unwrap()
            .is_none(),
        "exhaustion is final for the revision"
    );
    // No replenishment: duplicate observations, reconnect-style
    // re-acquisition of the SAME location, and repeated work scans never
    // restore consumed counts.
    observe(&store, target.clone(), "Manual Title", 1)
        .await
        .unwrap();
    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location("/h/.claude", "h-exhaust")),
    )
    .await
    .unwrap();
    assert!(
        store
            .claim_native_cycle(target.clone(), "r5".to_string())
            .await
            .unwrap()
            .is_none(),
        "no event replenishes the finite allowance"
    );

    // Restart: exhaustion and the attempted receipts survive; the allowance
    // is still spent.
    let store = open_store(dir.path());
    let target = pending("h-exhaust");
    assert!(
        store
            .claim_native_cycle(target.clone(), "r6".to_string())
            .await
            .unwrap()
            .is_none(),
        "exhaustion is final across restart"
    );
    let doc = document_json(dir.path());
    let native = doc["nativeWrite"]
        .as_object()
        .expect("nativeWrite section")
        .values()
        .next()
        .expect("one series");
    assert_eq!(native["cyclesConsumed"].as_u64(), Some(3));
    assert!(native["settled"].as_bool().unwrap());
    assert_eq!(
        native["attemptedReceipts"].as_array().map(Vec::len),
        Some(3)
    );
    assert_eq!(native["readsConsumed"].as_u64(), Some(3));
    crate::session_names::clear_test_hooks(dir.path());
}

/// A new manual rename mid-flight creates its OWN bounded allowance, and the
/// in-flight cycle's acknowledgement cannot synchronize the newer revision:
/// the document lock is free while the worker parks on the provider, so the
/// rename lands immediately (N+1 accepted while N executes).
#[tokio::test]
async fn rename_during_a_pending_write_gets_its_own_allowance_and_the_old_ack_cannot_sync_it() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-race", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]).arm_read_gate();
    backend.set_title(Some("Divergent"));

    let store_for_cycle = Arc::clone(&store);
    let backend_for_cycle = Arc::clone(&backend);
    let target_for_cycle = target.clone();
    let worker = tokio::spawn(async move {
        super::run_cycle(
            &store_for_cycle,
            backend_for_cycle.as_ref() as &dyn NativeNameBackend,
            &target_for_cycle,
        )
        .await;
    });

    // Wait for the worker to park inside its first read, then rename through
    // the SAME store — the document lock is NOT held by the in-flight cycle.
    backend.gate_arrived.notified().await;
    let renamed = rename_user(&store, target.clone(), "Newer Decision")
        .await
        .expect("the rename lands immediately while N executes");
    assert_eq!(renamed.record.name, "Newer Decision");
    backend.gate_open.notify_one();
    worker.await.unwrap();

    // N's acknowledgement (a confirmed write + matching readback of the OLD
    // desired value) cannot synchronize N+1: the stale fold is provenance.
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_ne!(
        sync.status,
        NativeSyncStatus::Synced,
        "an old acknowledgement cannot sync a newer revision"
    );
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(record.name, "Newer Decision");
    assert_eq!(
        sync.desired_revision, record.revision,
        "the series projects the new decision's revision"
    );
    // The new decision gets its OWN bounded allowance (fresh cycles), and the
    // new series is ready now.
    let claim = store
        .claim_native_cycle(target.clone(), "new-series-1".to_string())
        .await
        .unwrap()
        .expect("the new series has its own allowance");
    assert_eq!(claim.title, "Newer Decision");
}

/// Ambiguity: the write may still land (a detached task applies it late).
/// A later matching readback records `observedCurrent` but the status STAYS
/// unsynced with the uncertainty reason — never proof an older external
/// request cannot still write.
#[tokio::test]
async fn ambiguous_write_matching_readback_records_observed_current_but_stays_unsynced() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-amb", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::AmbiguousLateApply { delay_ms: 10 }]);
    backend.set_title(Some("Divergent"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
    assert!(sync.reason.unwrap().contains("timeout"));

    // The detached provider task applies the write after the fold; a later
    // cycle's matching readback observes the desired title.
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        backend.provider_title.lock().unwrap().as_deref(),
        Some("Manual Title"),
        "the external write continued after the client gave up"
    );
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_ne!(sync.status, NativeSyncStatus::Synced);
    // Fold the matching readback (as the next cycle's read would).
    store
        .fold_native_outcome(
            target.clone(),
            1,
            NativeOutcomeFold::Read {
                observed: Some("Manual Title".to_string()),
                receipt: None,
            },
        )
        .await
        .unwrap();
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(
        sync.status,
        NativeSyncStatus::Unsynced,
        "a matching readback after ambiguity never establishes synced"
    );
    assert_eq!(sync.observed_current, Some(true));
    assert!(sync.reason.unwrap().contains("ambiguous"));
    // The series holds no ready work: ambiguity settled with the matching
    // readback recorded.
    assert!(store.native_work_snapshot().is_empty());
}

/// Undelivered vs ambiguous vs unsupported keep distinct classifications and
/// distinct unsynced reasons — never reduced to a generic timeout.
#[tokio::test]
async fn unsupported_marks_the_series_and_only_a_location_change_rearms_it() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-unsup", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Unsupported]);
    backend.set_title(Some("Divergent"));

    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsupported);
    assert!(sync.reason.unwrap().contains("capability failure"));
    assert!(
        store
            .claim_native_cycle(target.clone(), "r9".to_string())
            .await
            .unwrap()
            .is_none(),
        "unsupported consumes its cycle and holds no ready work"
    );
    assert_eq!(backend.writes(), 1);

    // A differing observation does NOT re-arm an unsupported series (only a
    // genuine capability/lifecycle change does).
    observe(&store, target.clone(), "Totally Different", 1)
        .await
        .unwrap();
    assert!(store
        .claim_native_cycle(target.clone(), "r10".to_string())
        .await
        .unwrap()
        .is_none());

    // A genuine verified-location reacquisition re-arms the REMAINING cycles
    // — without replenishing the consumed one.
    record_acquisition(
        &store,
        target.clone(),
        verified_acquisition(claude_location("/h/.claude-moved", "h-unsup")),
    )
    .await
    .unwrap();
    let claim = store
        .claim_native_cycle(target.clone(), "r11".to_string())
        .await
        .unwrap()
        .expect("remaining cycles re-arm on the new route");
    assert_eq!(claim.cycle, 2, "consumed counts are never replenished");
    assert_eq!(claim.location_revision, 2, "the reacquired route revision");
    let sync = native_sync_of(&store, target.clone())
        .await
        .expect("series");
    assert_eq!(sync.status, NativeSyncStatus::Unsynced);
}

/// After confirmed synchronization, a DIFFERING current-location observation
/// re-arms the remaining cycles (the native moved away); a matching one never
/// schedules work; and exhaustion stays final.
#[tokio::test]
async fn divergent_observation_rearms_a_synced_series_without_replenishing() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-diverge", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![]);
    backend.set_title(Some("Manual Title"));
    super::run_cycle(&store, backend.as_ref() as &dyn NativeNameBackend, &target).await;
    assert_eq!(
        native_sync_of(&store, target.clone()).await.unwrap().status,
        NativeSyncStatus::Synced
    );

    // Matching observation: no work.
    observe(&store, target.clone(), "Manual Title", 1)
        .await
        .unwrap();
    assert!(store.native_work_snapshot().is_empty());

    // Divergent observation: the remaining cycles re-arm at the same route.
    observe(&store, target.clone(), "Externally Retitled", 1)
        .await
        .unwrap();
    let items = store.native_work_snapshot();
    assert_eq!(items.len(), 1, "the differing observation scheduled work");
    assert_eq!(items[0].cycles_consumed, 1, "counts not replenished");

    // But the observation is still an automatic candidate: a manual record
    // is never overwritten by it.
    let record = store
        .get(vec![target.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    assert_eq!(record.name, "Manual Title");
    assert_eq!(
        record.source,
        freshell_protocol::session_names::NameSource::Manual
    );
}

/// A pending series binds onto its durable identity mid-flight: consumed
/// cycles and remaining read allowance TRANSFER, the desired revision
/// rebases to the bound record, and the original attempted receipts are
/// retained.
#[tokio::test]
async fn binding_transfers_cycles_rebases_desired_revision_and_retains_receipts() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-bind", "/h/.claude").await;
    // Charge one cycle through the pre-write read + a confirmed write ack —
    // bind BEFORE the confirming readback lands.
    let claim = store
        .claim_native_cycle(target.clone(), "bind-receipt-1".to_string())
        .await
        .unwrap()
        .expect("claim");
    assert_eq!(claim.cycle, 1);
    assert!(
        store.charge_native_read(target.clone()).await.unwrap(),
        "the read allowance charges"
    );
    store
        .fold_native_outcome(
            target.clone(),
            claim.location_revision,
            NativeOutcomeFold::WriteAcknowledged {
                receipt: claim.receipt_id.clone(),
            },
        )
        .await
        .unwrap();

    let durable = session(
        freshell_protocol::session_names::NamedProvider::Claude,
        "sess-bind",
    );
    store
        .bind_pending(BindNameInput {
            pending: target.clone(),
            target: durable.clone(),
            acquisition: verified_acquisition(claude_location("/h/.claude", "sess-bind")),
        })
        .await
        .expect("verified bind");

    // The bound record carries the transferred series: same consumed count,
    // the desired revision rebased to the NEW record revision.
    let record = store
        .get(vec![durable.clone()])
        .await
        .unwrap()
        .remove(0)
        .record;
    let sync = native_sync_of(&store, durable.clone())
        .await
        .expect("series");
    assert_eq!(sync.desired_revision, record.revision);
    let claim = store
        .claim_native_cycle(durable.clone(), "bind-cycle-2".to_string())
        .await
        .unwrap()
        .expect("the transferred allowance continues");
    assert_eq!(claim.cycle, 2, "consumed cycles transfer, not replenish");
    let doc = document_json(dir.path());
    let native = doc["nativeWrite"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    let receipts = native["attemptedReceipts"].as_array().unwrap();
    assert!(
        receipts
            .iter()
            .any(|r| r.as_str() == Some("bind-receipt-1")),
        "original attempted receipts retained across the bind"
    );
}

/// A restart-discovered interrupted cycle is consumed exactly once: the claim
/// persisted before dispatch survives the reopen, and the next claim mints a
/// fresh unique receipt.
#[tokio::test]
async fn restart_with_an_outstanding_receipt_consumes_the_cycle_once() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-restart", "/h/.claude").await;
    let claim = store
        .claim_native_cycle(target.clone(), "receipt-outstanding".to_string())
        .await
        .unwrap()
        .expect("claim");
    assert_eq!(claim.cycle, 1);
    let location_revision = claim.location_revision;

    // Restart before any dispatch/fold.
    let store = open_store(dir.path());
    let target = pending("h-restart");
    let doc = document_json(dir.path());
    let native = doc["nativeWrite"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap();
    assert_eq!(native["cyclesConsumed"].as_u64(), Some(1));
    let receipts = native["attemptedReceipts"].as_array().unwrap();
    assert!(
        receipts
            .iter()
            .any(|r| r.as_str() == Some("receipt-outstanding")),
        "the outstanding receipt survives the restart as provenance"
    );

    // The interrupted cycle is consumed once: the next claim mints a NEW
    // receipt and charges cycle 2 — never a replay of the stale one.
    let claim2 = store
        .claim_native_cycle(target.clone(), "receipt-next".to_string())
        .await
        .unwrap()
        .expect("the next cycle continues the series");
    assert_eq!(claim2.cycle, 2);
    assert_ne!(claim2.receipt_id, "receipt-outstanding");
    assert_eq!(claim2.location_revision, location_revision);
}

/// Fallback sources never write back and project no native series: only
/// accepted manual and Freshell AI names arm one.
#[tokio::test]
async fn provider_fallbacks_never_arm_a_native_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = pending("h-fallback");
    ensure_pending(&store, "h-fallback", Some("/work/project"))
        .await
        .unwrap();
    // Automatic (provider_ai-rank) suggestion on a directory record: no
    // series is created.
    rename_automatic(&store, target.clone(), "Agent Suggestion")
        .await
        .unwrap();
    assert!(
        store.native_work_snapshot().is_empty(),
        "provider fallbacks are not written back"
    );
    let sync = native_sync_of(&store, target.clone()).await;
    assert!(
        sync.is_none(),
        "no native series is projected for fallback names"
    );
}

/// The worker loop drives armed work end-to-end under the shared background
/// guard: a manual rename arms the series and the running worker converges
/// the provider to the exact desired name.
#[tokio::test]
async fn the_worker_loop_converges_an_armed_series() {
    let dir = temp_data_dir();
    let store = open_store(dir.path());
    let target = armed_pending(&store, "h-worker", "/h/.claude").await;
    let backend = ScriptedBackend::new(vec![WriteStep::Confirm]);
    backend.set_title(Some("Divergent"));

    let worker = SessionNameWorker::start(Arc::clone(&store), backend.clone());
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(sync) = native_sync_of(&store, target.clone()).await {
            if sync.status == NativeSyncStatus::Synced {
                break;
            }
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "the worker must converge the armed series"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    worker.abort();
    assert_eq!(backend.writes(), 1);
    assert_eq!(backend.reads(), 2);
}

/// The selector prefers ready manual-name projection, then the stable
/// name-reference key — the persisted fair-scheduling policy's native half.
#[tokio::test]
async fn the_selector_prefers_manual_projection_then_the_stable_key() {
    let items =
        |source: freshell_protocol::session_names::NameSource, key: &str| super::NativeWorkItem {
            target: pending(key),
            location: claude_location("/h/.claude", key),
            location_revision: 1,
            desired_revision: 1,
            desired_name: "x".to_string(),
            desired_source: source,
            cycles_consumed: 0,
        };
    let a_freshell = items(
        freshell_protocol::session_names::NameSource::FreshellAi,
        "z-late",
    );
    let b_manual = items(
        freshell_protocol::session_names::NameSource::Manual,
        "a-early",
    );
    let c_freshell = items(
        freshell_protocol::session_names::NameSource::FreshellAi,
        "b-early",
    );
    let picked = super::select_next(&[a_freshell.clone(), b_manual.clone(), c_freshell.clone()]);
    assert_eq!(picked.unwrap().target, b_manual.target);
    let picked = super::select_next(&[a_freshell.clone(), c_freshell.clone()]);
    assert_eq!(picked.unwrap().target, c_freshell.target);
}
