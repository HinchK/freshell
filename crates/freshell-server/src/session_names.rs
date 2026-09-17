//! Durable canonical coding-agent name authority (unified-agent-names plan,
//! Task 1).
//!
//! One version-1 document (`session-names.json` in the configured Freshell
//! data directory) holds every piece of naming state: `documentGeneration`,
//! `nextRevision`, accepted records, pending→durable redirects, internal
//! native locations/location revisions, generation state, native-write state,
//! the fair-scheduling cursor and migration receipts. Every persisted
//! mutation — including initialization, bookkeeping and receipts without
//! visible text changes — advances `documentGeneration`.
//!
//! Strict cross-process transaction policy: a stable private sidecar
//! (`.session-names.lock`, opened create+read+write, never replaced or
//! unlinked) is `try_lock`ed on a fresh private handle per transaction,
//! retrying contention for at most one monotonic second before
//! [`NameError::LockUnavailable`]. Under that lock the complete current
//! document is re-read and validated, any newly encountered generation's
//! durability is reconciled (file + parent sync) before adoption or
//! mutation, the decision is applied, and the replacement is written with
//! `freshell_ws::tabs_persist::atomic_write_durable` (sibling temp, file
//! sync, rename, Unix parent sync) BEFORE the read model swaps and anything
//! publishes. Pre-replace failures leave the old state intact
//! ([`NameError::Persistence`]); post-replace uncertainty fences the writer
//! and every other participant until durability reconciliation succeeds
//! ([`NameError::CommitUncertain`]). A missing document initializes only a
//! store with no established view — for an established store a vanished
//! document fences every operation instead of silently reinitializing over
//! accepted names. The executing blocking-IO owner retains its guard until
//! completion even if an outer caller stops waiting (transactions run on
//! detached `spawn_blocking` tasks).
//!
//! `session.name.updated` publishes only after successful commit/adoption,
//! in local generation order (publication happens while the lock is held).
//! Neither settings dirty-merging nor a process mutex is sufficient — two
//! real processes serialize through the file lock alone.
//!
//! Task 2 constructs this store in `main.rs`; Tasks 3–4 consume
//! [`SessionNames::try_background_guard`] for the serial worker.

// Unified agent names Task 2: the store is constructed and wired in `main`
// (routes/sinks/tick/publisher), so no module-level dead-code allow remains.
// The Tasks 3–4 seams below (`offer`'s automatic-name path, the generation
// series, the background worker guard) carry item-level allows until their
// wiring tasks land.
//
// `NameError::Conflict` deliberately carries the accepted record so route
// callers can answer a CAS conflict with the current winner instead of an
// invisible overwrite — the large Err payload is the design (same rationale
// as `terminal_tabs.rs`'s `Response`).
#![allow(clippy::result_large_err)]

use std::collections::BTreeMap;
use std::fs::TryLockError;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::{Duration, Instant};

use freshell_freshagent::naming::{
    BindNameInput, NameActivity, NameActivityReason, NameError, NameFuture, NativeNameObservation,
    NativeNameOrigin, PendingNameInput, RenameNameInput, SessionNaming,
};
use freshell_protocol::native_location::{NativeAcquisition, NativeLocation, NativePersistence};
use freshell_protocol::session_names::{
    NameIntent, NameRevision, NameSource, NamedProvider, SessionNameRecord, SessionNameRedirect,
    SessionNameRef, SessionNameUpdate, MAX_NAME_REVISION,
};
use freshell_ws::tabs_persist::atomic_write_durable;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::auto_title::basename_segment;

#[cfg(test)]
#[path = "session_names_tests.rs"]
mod tests;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DOCUMENT_VERSION: u32 = 1;
const DOCUMENT_FILE_NAME: &str = "session-names.json";
const DOCUMENT_TMP_NAME: &str = ".session-names.json.tmp";
const LOCK_FILE_NAME: &str = ".session-names.lock";
const WORKER_LOCK_FILE_NAME: &str = ".session-names-worker.lock";
/// Contention retry cadence for the strict document lock.
const LOCK_POLL_INTERVAL: Duration = Duration::from_millis(10);
/// The bounded monotonic retry budget before `LockUnavailable`.
const LOCK_RETRY_BUDGET: Duration = Duration::from_secs(1);
/// Hard accepted-name cap: 200 Unicode scalar values.
const MAX_NAME_SCALARS: usize = 200;
/// Generation series exhaust after three consumed starts.
const MAX_GENERATION_STARTS: u32 = 3;
/// Broadcast history retained for slow subscribers (lag recovers by refresh).
const NAME_BROADCAST_CAPACITY: usize = 4096;

// ---------------------------------------------------------------------------
// Document schema (version 1)
// ---------------------------------------------------------------------------

/// Verified routing evidence for one naming target. `location_revision` is
/// assigned by the store whenever verified evidence changes — independent of
/// the visible name revision and never a public identity namespace.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VerifiedLocation {
    pub location: NativeLocation,
    pub location_revision: NameRevision,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredLocation {
    #[serde(skip_serializing_if = "Option::is_none")]
    verified: Option<VerifiedLocation>,
    /// Live routing hint retained without binding; never a verified route.
    #[serde(skip_serializing_if = "Option::is_none")]
    prospective: Option<NativeLocation>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum GenerationStatus {
    Idle,
    Eligible,
    InFlight,
    Exhausted,
}

/// Per-record durable generation series: status, series id, input fingerprint,
/// bounded first-message excerpt, persisted attempt identities/start times,
/// consumed count, nextDue and exhaustion time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GenerationState {
    status: GenerationStatus,
    series_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    input_fingerprint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    excerpt: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attempt_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attempt_starts: Vec<i64>,
    #[serde(default)]
    consumed: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    next_due: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    exhausted_at: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum NativeSyncStatus {
    #[default]
    Pending,
    Synced,
    Unsynced,
    Unsupported,
}

/// Provenance record of the last native observation (never a name authority).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredObservation {
    origin: String,
    location_revision: NameRevision,
    #[serde(skip_serializing_if = "Option::is_none")]
    event_id: Option<String>,
    at: i64,
    /// An old-location observation: retained, never treated as current.
    stale: bool,
}

/// Per-record native writeback state: desired revision/name/source, attempted
/// location and receipts, consumed cycles/reads, and last-observation
/// provenance. Task 3 drives the cycle machine; Task 1 owns the durable
/// schema and the bind-transfer policy.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NativeWriteState {
    status: NativeSyncStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_revision: Option<NameRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    desired_source: Option<NameSource>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempted_location: Option<NativeLocation>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempted_location_revision: Option<NameRevision>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt_id: Option<String>,
    #[serde(default)]
    cycles_consumed: u32,
    #[serde(default)]
    reads_consumed: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    attempted_receipts: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_confirmed_receipt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    unsynced_reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_observation: Option<StoredObservation>,
}

/// Persisted fair-scheduling cursor (Task 3/4's serial worker alternates
/// generation/native classes when both have ready work).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SchedulingCursor {
    #[serde(skip_serializing_if = "Option::is_none")]
    last_class: Option<String>,
}

/// Migration receipts (Task 7 fills; the schema exists from day one so the
/// document never needs a destructive reshape).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct MigrationReceipts {
    #[serde(default)]
    completed: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    acknowledged_candidate_ids: Vec<String>,
}

/// Retained losing evidence (bind collisions, migration losers). A recovery
/// copy only — never an active competing override.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryEntry {
    record: SessionNameRecord,
    #[serde(skip_serializing_if = "Option::is_none")]
    evidence: Option<serde_json::Value>,
    retained_at: i64,
    reason: String,
}

/// The version-1 name document. Core fields (version, generation, revision
/// cursor, records, redirects) are required; internal bookkeeping sections
/// default when absent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDocument {
    version: u32,
    document_generation: u64,
    next_revision: NameRevision,
    records: BTreeMap<String, SessionNameRecord>,
    redirects: BTreeMap<String, SessionNameRedirect>,
    #[serde(default)]
    locations: BTreeMap<String, StoredLocation>,
    #[serde(default)]
    generation: BTreeMap<String, GenerationState>,
    #[serde(default)]
    native_write: BTreeMap<String, NativeWriteState>,
    #[serde(default)]
    scheduling_cursor: SchedulingCursor,
    #[serde(default)]
    migration: MigrationReceipts,
    #[serde(default)]
    recovery: BTreeMap<String, RecoveryEntry>,
}

impl StoredDocument {
    /// The pre-initialization shape: generation 0 is never written; the first
    /// committed transaction persists generation 1.
    fn initial() -> Self {
        Self {
            version: DOCUMENT_VERSION,
            document_generation: 0,
            next_revision: 1,
            records: BTreeMap::new(),
            redirects: BTreeMap::new(),
            locations: BTreeMap::new(),
            generation: BTreeMap::new(),
            native_write: BTreeMap::new(),
            scheduling_cursor: SchedulingCursor::default(),
            migration: MigrationReceipts::default(),
            recovery: BTreeMap::new(),
        }
    }

    /// Allocate the next JS-safe monotonically increasing revision.
    fn allocate_revision(&mut self) -> Result<NameRevision, NameError> {
        let revision = self.next_revision;
        if revision > MAX_NAME_REVISION {
            return Err(NameError::Persistence(
                "name revision budget exhausted (JS-safe ceiling)".into(),
            ));
        }
        self.next_revision = revision + 1;
        Ok(revision)
    }

    /// Follow a pending→durable redirect (one hop; redirects only ever point
    /// at durable session refs). Returns the resolved ref plus the traversed
    /// redirect.
    fn resolve_ref(
        &self,
        target: &SessionNameRef,
    ) -> (SessionNameRef, Option<SessionNameRedirect>) {
        let key = name_ref_key(target);
        if let Some(redirect) = self.redirects.get(&key) {
            return (redirect.to.clone(), Some(redirect.clone()));
        }
        (target.clone(), None)
    }

    fn record_at(&self, key: &str) -> Option<&SessionNameRecord> {
        self.records.get(key)
    }
}

/// The stable encoded key for a naming ref — the JSON encoding of a
/// discriminated tuple (`["pending","<id>"]` /
/// `["session","<provider>","<sessionId>"]`), mirroring the TS
/// `sessionNameRefKey`. Never colon-splits opaque provider session IDs.
pub(crate) fn name_ref_key(target: &SessionNameRef) -> String {
    match target {
        SessionNameRef::Pending { id } => {
            serde_json::to_string(&serde_json::json!(["pending", id]))
                .expect("pending ref key serializes")
        }
        SessionNameRef::Session {
            provider,
            session_id,
        } => serde_json::to_string(&serde_json::json!([
            "session",
            provider.as_str(),
            session_id
        ]))
        .expect("session ref key serializes"),
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn digest_bytes(bytes: &[u8]) -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher.finalize().into()
}

// ---------------------------------------------------------------------------
// Transaction plumbing
// ---------------------------------------------------------------------------

/// What a transaction decided.
enum Decision<T> {
    /// No persisted state changed; the (possibly newly adopted) document is
    /// returned unchanged.
    Read(T),
    /// Persist: advance `documentGeneration`, durably replace, then publish
    /// the listed records in order.
    Write { value: T, publish: Vec<PublishSpec> },
}

/// One record to broadcast after a successful commit (`changed` reflects the
/// accepted record vs the store's previously established state).
struct PublishSpec {
    key: String,
    changed: bool,
}

/// Context handed to every decision closure.
struct TxnMeta {
    now_ms: i64,
}

/// The adopted read model: the parsed document plus a digest of the exact
/// bytes it was adopted from (equal-generation-different-content detection).
struct Adopted {
    document: StoredDocument,
    digest: [u8; 32],
}

struct NamesCore {
    data_dir: PathBuf,
    doc_path: PathBuf,
    tmp_path: PathBuf,
    lock_path: PathBuf,
    worker_lock_path: PathBuf,
    view: RwLock<Arc<Adopted>>,
    tx: broadcast::Sender<SessionNameUpdate>,
}

impl NamesCore {
    fn current_view(&self) -> Arc<Adopted> {
        self.view.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    fn set_view(&self, document: StoredDocument, digest: [u8; 32]) {
        *self.view.write().unwrap_or_else(|p| p.into_inner()) =
            Arc::new(Adopted { document, digest })
    }

    fn publish(&self, updates: Vec<SessionNameUpdate>) {
        for update in updates {
            let _ = self.tx.send(update);
        }
    }
}

/// The durable name authority. `Arc`-shared; all methods are safe under
/// concurrency — the sidecar file lock is the only serialization point.
pub struct SessionNames {
    core: Arc<NamesCore>,
}

/// Ownership of the `.session-names-worker.lock` sidecar (Tasks 3–4): one
/// actual ready background operation across cooperating same-home processes
/// holds it. Acquire worker THEN document, never the reverse. The guard
/// never acquires the document lock, cannot be cloned, and is never
/// released through a detached timeout — it lives until its owner drops it.
// Tasks 3–4 seam: no caller until the background worker lands.
#[allow(dead_code)]
pub(crate) struct BackgroundGuard {
    _file: std::fs::File,
}

impl std::fmt::Debug for BackgroundGuard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("BackgroundGuard")
    }
}

impl SessionNames {
    /// Open (or initialize) the name document in `data_dir`, reconciling the
    /// current document's durability before success. Construction in
    /// `main.rs` is Task 2; legacy import is Task 7.
    pub fn open(data_dir: PathBuf) -> Result<Arc<Self>, NameError> {
        std::fs::create_dir_all(&data_dir).map_err(|e| {
            NameError::Persistence(format!(
                "cannot create session-names data dir {}: {e}",
                data_dir.display()
            ))
        })?;
        let canonical = std::fs::canonicalize(&data_dir).map_err(|e| {
            NameError::Persistence(format!(
                "cannot canonicalize session-names data dir {}: {e}",
                data_dir.display()
            ))
        })?;
        let (tx, _rx) = broadcast::channel(NAME_BROADCAST_CAPACITY);
        let core = Arc::new(NamesCore {
            doc_path: canonical.join(DOCUMENT_FILE_NAME),
            tmp_path: canonical.join(DOCUMENT_TMP_NAME),
            lock_path: canonical.join(LOCK_FILE_NAME),
            worker_lock_path: canonical.join(WORKER_LOCK_FILE_NAME),
            data_dir: canonical,
            view: RwLock::new(Arc::new(Adopted {
                document: StoredDocument::initial(),
                digest: [0; 32],
            })),
            tx,
        });
        // Reconcile/initialize the current document before success — the same
        // strict path every transaction takes (this is a blocking boot call).
        run_txn_sync(&core, |_doc, _meta| {
            // Initialization is itself a persisted mutation: an absent
            // document is written at generation 1 (the runner forces the
            // write when the file was missing); an existing document is
            // reconciled and adopted.
            Ok(Decision::Read(()))
        })?;
        Ok(Arc::new(Self { core }))
    }

    /// Live canonical-name updates: own commits and adopted external changes,
    /// published in local generation order. Lag recovers by refresh/diff.
    pub fn subscribe(&self) -> broadcast::Receiver<SessionNameUpdate> {
        self.core.tx.subscribe()
    }

    /// Try to take the background worker lock (Tasks 3–4). `Ok(None)` means
    /// another cooperating process holds it; lock failures are errors.
    // Tasks 3–4 seam: no caller until the background worker lands.
    #[allow(dead_code)]
    pub(crate) fn try_background_guard(&self) -> Result<Option<BackgroundGuard>, NameError> {
        let file = open_lock_file(&self.core.worker_lock_path)?;
        match file.try_lock() {
            Ok(()) => Ok(Some(BackgroundGuard { _file: file })),
            Err(TryLockError::WouldBlock) => Ok(None),
            Err(TryLockError::Error(e)) => Err(NameError::LockUnavailable(format!(
                "worker lock error: {e}"
            ))),
        }
    }

    /// Internal automatic/migration offer seam: arbitrary callers cannot
    /// reach this through HTTP (routes land in Task 2 and never accept
    /// `freshell_ai`/`legacy_protected` from clients).
    // Tasks 3–4 seam: the automatic-name pipeline (first-message/AI offers)
    // is the next wiring task.
    #[allow(dead_code)]
    pub(crate) fn offer(
        &self,
        target: SessionNameRef,
        name: String,
        source: NameSource,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            offer_decision(doc, meta, &target, &name, source)
        }))
    }

    /// The common full-document adoption path before all name-dependent
    /// reads and reconnect snapshots: re-read the entire document under the
    /// lock (never an mtime shortcut), reconcile an unfamiliar generation's
    /// durability, adopt it, and publish the delta to subscribers. Returns
    /// every record as updates (bootstrap/snapshot shape: each carries the
    /// full redirect list).
    pub(crate) fn refresh_current(&self) -> NameFuture<Vec<SessionNameUpdate>> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, _meta| {
            let updates: Vec<SessionNameUpdate> = doc
                .records
                .keys()
                .filter_map(|key| update_for_key(doc, key, false, RedirectScope::All))
                .collect();
            Ok(Decision::Read(updates))
        }))
    }

    /// Durable generation work-claim seam (Task 4's worker dispatches through
    /// this): persist an attempt's start before any provider call, consuming
    /// one of the bounded three starts and exhausting the series at the cap.
    // Tasks 3–4 seam: the generation worker lands next.
    #[allow(dead_code)]
    pub(crate) fn claim_generation_start(
        &self,
        target: SessionNameRef,
        attempt_id: String,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            claim_generation_start_decision(doc, meta, &target, &attempt_id)
        }))
    }

    /// Durable generation completion seam (Task 4's worker folds answers
    /// through this): accept a Freshell AI answer only if that same series is
    /// current and the accepted source is below Freshell AI.
    // Tasks 3–4 seam: the generation worker lands next.
    #[allow(dead_code)]
    pub(crate) fn complete_generation(
        &self,
        target: SessionNameRef,
        series_id: String,
        answer: String,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            complete_generation_decision(doc, meta, &target, &series_id, &answer)
        }))
    }
}

impl SessionNaming for SessionNames {
    fn get(&self, refs: Vec<SessionNameRef>) -> NameFuture<Vec<SessionNameUpdate>> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, _meta| {
            let mut updates = Vec::new();
            for target in &refs {
                let (resolved, traversed) = doc.resolve_ref(target);
                let key = name_ref_key(&resolved);
                if let Some(mut update) = update_for_key(doc, &key, false, RedirectScope::None) {
                    if let Some(redirect) = traversed {
                        update.redirects.push(redirect);
                    }
                    updates.push(update);
                }
            }
            Ok(Decision::Read(updates))
        }))
    }

    fn ensure_pending(&self, input: PendingNameInput) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            ensure_pending_decision(doc, meta, input)
        }))
    }

    fn bind_pending(&self, input: BindNameInput) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            bind_pending_decision(doc, meta, input)
        }))
    }

    fn rename(&self, input: RenameNameInput) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            rename_decision(doc, meta, input)
        }))
    }

    fn activity(&self, input: NameActivity) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            activity_decision(doc, meta, input)
        }))
    }

    fn observe_native(&self, input: NativeNameObservation) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            observe_native_decision(doc, meta, input)
        }))
    }

    fn record_acquisition(
        &self,
        target: SessionNameRef,
        acquisition: NativeAcquisition,
    ) -> NameFuture<SessionNameUpdate> {
        let core = Arc::clone(&self.core);
        Box::pin(spawn_txn(core, move |doc, meta| {
            record_acquisition_decision(doc, meta, &target, acquisition)
        }))
    }
}

// ---------------------------------------------------------------------------
// Naming publisher (Task 2 wiring)
// ---------------------------------------------------------------------------

/// Unified agent names (Task 2): the naming publisher task body — every
/// committed update (this process's own writes and adopted external ones)
/// reaches WS clients as the canonical `session.name.updated` frame, refreshes
/// the registry display caches of every terminal bound to the record (title
/// write-through), and invalidates the session directory (`sessions.changed`)
/// so renamed rows re-read immediately. Extracted from `main`'s spawned
/// block so the subscription-lag recovery is testable against the real store.
///
/// Subscription-lag recovery (plan rule 8): a `Lagged` recv — a burst of
/// commits overran the broadcast history while this task was slow —
/// re-adopts the full document (`refresh_current`, a strict Read that does
/// NOT re-publish to the channel) and re-diffs EVERY record through the
/// same push, so a missed frame cannot leave a registry display cache or a
/// WS client stale until the record changes again. A `Closed` channel ends
/// the task — never a busy-loop.
pub(crate) async fn run_naming_publisher(
    names: Arc<SessionNames>,
    mut updates: broadcast::Receiver<SessionNameUpdate>,
    registry: freshell_terminal::TerminalRegistry,
    broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    sessions_revision: Arc<std::sync::atomic::AtomicI64>,
) {
    async fn push(
        registry: &freshell_terminal::TerminalRegistry,
        broadcast_tx: &tokio::sync::broadcast::Sender<String>,
        sessions_revision: &std::sync::atomic::AtomicI64,
        update: SessionNameUpdate,
    ) {
        for terminal_id in registry.terminals_bound_to(&update.record.name_ref) {
            registry.update_session_name(&terminal_id, &update.record);
        }
        let frame = freshell_protocol::ServerMessage::SessionNameUpdated(
            freshell_protocol::session_names::SessionNameUpdated {
                record: update.record.clone(),
                document_generation: update.document_generation,
                redirects: update.redirects.clone(),
                changed: update.changed,
            },
        );
        if let Ok(serialized) = serde_json::to_string(&frame) {
            let _ = broadcast_tx.send(serialized);
        }
        let revision = sessions_revision.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
        let _ = broadcast_tx.send(
            serde_json::json!({ "type": "sessions.changed", "revision": revision }).to_string(),
        );
    }

    loop {
        match updates.recv().await {
            Ok(update) => {
                push(&registry, &broadcast_tx, &sessions_revision, update).await;
            }
            Err(broadcast::error::RecvError::Lagged(missed)) => {
                tracing::warn!(
                    target: "freshell_server::session_names",
                    op = "publisher_lag",
                    name_ref = "-",
                    revision = 0,
                    class = "lagged",
                    missed = missed,
                    "session_names.operation_failed: publisher lagged behind {missed} \
                     update(s); re-adopting the document and re-diffing every record"
                );
                match names.refresh_current().await {
                    Ok(recovered) => {
                        for update in recovered {
                            push(&registry, &broadcast_tx, &sessions_revision, update).await;
                        }
                    }
                    Err(error) => {
                        tracing::warn!(
                            target: "freshell_server::session_names",
                            op = "refresh_current",
                            name_ref = "-",
                            revision = 0,
                            class = %error.code(),
                            "session_names.operation_failed: {error}"
                        );
                    }
                }
            }
            Err(broadcast::error::RecvError::Closed) => {
                // The store is gone (its Arc dropped with it): the publisher
                // ends.
                break;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Transaction runner
// ---------------------------------------------------------------------------

async fn spawn_txn<T, F>(core: Arc<NamesCore>, f: F) -> Result<T, NameError>
where
    T: Send + 'static,
    F: FnOnce(&mut StoredDocument, &TxnMeta) -> Result<Decision<T>, NameError> + Send + 'static,
{
    // The blocking-IO owner retains its guard until completion even if
    // the caller stops waiting: dropping this handle detaches the
    // spawn_blocking task, which runs to completion on its own.
    let handle = tokio::task::spawn_blocking(move || run_txn_sync(&core, f));
    match handle.await {
        Ok(result) => result,
        Err(join_err) => Err(NameError::Persistence(format!(
            "naming transaction task failed: {join_err}"
        ))),
    }
}

fn run_txn_sync<T, F>(core: &NamesCore, f: F) -> Result<T, NameError>
where
    F: FnOnce(&mut StoredDocument, &TxnMeta) -> Result<Decision<T>, NameError>,
{
    let _guard = acquire_document_lock(&core.lock_path)?;
    test_hold_once(&core.data_dir);

    let raw = std::fs::read(&core.doc_path);
    let (mut document, raw_digest, first_init) = match raw {
        Ok(bytes) => {
            let digest = digest_bytes(&bytes);
            (parse_document(&bytes)?, digest, false)
        }
        Err(e) if e.kind() == ErrorKind::NotFound => {
            // A missing document is initialization ONLY for a store with no
            // established view. Once a snapshot has been adopted, a vanished
            // document is external data loss: silently reinitializing would
            // permanently discard every accepted name (and a cooperating
            // second process could adopt the empty lineage). Fence instead
            // and keep the established view.
            if core.current_view().document.document_generation > 0 {
                return Err(NameError::Persistence(
                    "the session-names document vanished while this store held an established view; refusing to reinitialize over it"
                        .into(),
                ));
            }
            (StoredDocument::initial(), [0u8; 32], true)
        }
        Err(e) => {
            return Err(NameError::Persistence(format!(
                "cannot read session-names document {}: {e}",
                core.doc_path.display()
            )))
        }
    };

    if !first_init {
        let prior = core.current_view();
        if document.document_generation < prior.document.document_generation {
            return Err(NameError::Persistence(
                "session-names document generation decreased".into(),
            ));
        }
        if document.document_generation == prior.document.document_generation
            && raw_digest != prior.digest
        {
            return Err(NameError::Persistence(
                "session-names document changed content at an equal generation".into(),
            ));
        }
        if document.document_generation != prior.document.document_generation {
            reconcile_durability(&core.doc_path, &core.data_dir)?;
        }
    }

    let meta = TxnMeta { now_ms: now_ms() };
    let decision = f(&mut document, &meta)?;

    match decision {
        Decision::Read(value) => {
            if first_init {
                // Initialization is a persisted mutation: establish the
                // document at generation 1 (no visible records to publish).
                document.document_generation += 1;
                let bytes = serialize_document(&document)?;
                let digest = digest_bytes(&bytes);
                write_durable(core, &document, &bytes, digest)?;
                return Ok(value);
            }
            adopt_if_newer(core, document, raw_digest, true);
            Ok(value)
        }
        Decision::Write { value, publish } => {
            document.document_generation += 1;
            let bytes = serialize_document(&document)?;
            let digest = digest_bytes(&bytes);
            write_durable(core, &document, &bytes, digest)?;
            // Publish while the lock is still held: local generation order.
            let updates = materialize_publish(&document, &publish);
            core.publish(updates);
            Ok(value)
        }
    }
}

/// Serialize, then durably replace — classifying pre-replace failure (old
/// state intact) from post-replace uncertainty. On any write failure the
/// previously established snapshot is retained and nothing publishes.
fn write_durable(
    core: &NamesCore,
    document: &StoredDocument,
    bytes: &[u8],
    digest: [u8; 32],
) -> Result<(), NameError> {
    if test_pre_replace_failure(&core.data_dir) {
        return Err(NameError::Persistence(
            "injected pre-replace failure: the previous document is intact".into(),
        ));
    }
    if let Err(err) = atomic_write_durable(&core.doc_path, &core.tmp_path, bytes) {
        // Classify: did the replacement land despite the reported error?
        let installed = peek_generation(&core.doc_path);
        if installed == Some(document.document_generation) {
            return Err(NameError::CommitUncertain(format!(
                "the document replacement landed but durability is unproven: {err}"
            )));
        }
        return Err(NameError::Persistence(format!(
            "durable document replacement failed (previous document intact): {err}"
        )));
    }
    if test_post_replace_failure(&core.data_dir) {
        return Err(NameError::CommitUncertain(
            "injected post-replace failure: the replacement may not be durable".into(),
        ));
    }
    core.set_view(document.clone(), digest);
    Ok(())
}

/// Swap the read model to a newer adopted document and publish the delta.
/// A stale (older-generation) adoption is refused: queued stale projections
/// can never overwrite newer state.
fn adopt_if_newer(
    core: &NamesCore,
    document: StoredDocument,
    digest: [u8; 32],
    publish_delta: bool,
) -> bool {
    let prior = core.current_view();
    if document.document_generation <= prior.document.document_generation {
        return false;
    }
    let delta = delta_updates(&prior.document, &document);
    core.set_view(document, digest);
    if publish_delta {
        core.publish(delta);
    }
    true
}

/// The adopted-change delta: records whose revision changed or appeared,
/// plus each record's current inbound redirects.
fn delta_updates(prior: &StoredDocument, next: &StoredDocument) -> Vec<SessionNameUpdate> {
    let mut updates = Vec::new();
    for (key, record) in &next.records {
        let changed = match prior.records.get(key) {
            None => true,
            Some(old) => old.revision != record.revision || old.source != record.source,
        };
        if changed {
            if let Some(update) = update_for_key(next, key, true, RedirectScope::ToRecord) {
                updates.push(update);
            }
        }
    }
    updates
}

fn materialize_publish(document: &StoredDocument, specs: &[PublishSpec]) -> Vec<SessionNameUpdate> {
    specs
        .iter()
        .filter_map(|spec| {
            update_for_key(document, &spec.key, spec.changed, RedirectScope::ToRecord)
        })
        .collect()
}

#[derive(Clone, Copy)]
enum RedirectScope {
    /// No redirects.
    None,
    /// Redirects pointing AT this record (own-commit/commit-delta shape).
    ToRecord,
    /// The document's full redirect list (bootstrap/snapshot shape).
    All,
}

fn update_for_key(
    document: &StoredDocument,
    key: &str,
    changed: bool,
    scope: RedirectScope,
) -> Option<SessionNameUpdate> {
    let record = document.record_at(key)?;
    let redirects = match scope {
        RedirectScope::None => Vec::new(),
        RedirectScope::ToRecord => document
            .redirects
            .values()
            .filter(|r| name_ref_key(&r.to) == key)
            .cloned()
            .collect(),
        RedirectScope::All => document.redirects.values().cloned().collect(),
    };
    Some(SessionNameUpdate {
        record: record.clone(),
        document_generation: document.document_generation,
        redirects,
        changed,
    })
}

fn serialize_document(document: &StoredDocument) -> Result<Vec<u8>, NameError> {
    serde_json::to_vec(document).map_err(|e| {
        NameError::Persistence(format!("cannot serialize session-names document: {e}"))
    })
}

fn parse_document(bytes: &[u8]) -> Result<StoredDocument, NameError> {
    let document: StoredDocument = serde_json::from_slice(bytes)
        .map_err(|e| NameError::Persistence(format!("session-names document is corrupt: {e}")))?;
    if document.version != DOCUMENT_VERSION {
        return Err(NameError::Persistence(format!(
            "session-names document version {} is unsupported (expected {DOCUMENT_VERSION})",
            document.version
        )));
    }
    if document.document_generation == 0 {
        return Err(NameError::Persistence(
            "session-names document generation must be at least 1".into(),
        ));
    }
    if document.next_revision == 0 {
        return Err(NameError::Persistence(
            "session-names revision cursor must be at least 1".into(),
        ));
    }
    Ok(document)
}

/// Minimal generation peek used to classify pre- vs post-replace failures.
fn peek_generation(doc_path: &Path) -> Option<u64> {
    let bytes = std::fs::read(doc_path).ok()?;
    let value: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    value.get("documentGeneration")?.as_u64()
}

fn open_lock_file(path: &Path) -> Result<std::fs::File, NameError> {
    std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|e| {
            NameError::LockUnavailable(format!("cannot open sidecar lock {}: {e}", path.display()))
        })
}

/// Acquire the strict document lock: a fresh private handle per transaction,
/// retrying contention for at most one monotonic second. The sidecar is
/// never replaced or unlinked — its inode lives as long as the data dir.
fn acquire_document_lock(path: &Path) -> Result<std::fs::File, NameError> {
    let file = open_lock_file(path)?;
    let deadline = Instant::now() + LOCK_RETRY_BUDGET;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(NameError::LockUnavailable(
                        "session-names document lock stayed busy for the bounded retry budget"
                            .into(),
                    ));
                }
                std::thread::sleep(LOCK_POLL_INTERVAL);
            }
            Err(TryLockError::Error(e)) => {
                return Err(NameError::LockUnavailable(format!(
                    "session-names document lock error: {e}"
                )))
            }
        }
    }
}

/// Reconcile an unfamiliar generation's durability under the sidecar before
/// adopting or mutating from it: the installed file and its parent directory
/// are synced on THIS machine. Failure is uncertainty, never adoption.
fn reconcile_durability(doc_path: &Path, _data_dir: &Path) -> Result<(), NameError> {
    if test_fail_reconcile(_data_dir) {
        return Err(NameError::CommitUncertain(
            "injected reconciliation failure: the installed document's durability is unproven"
                .into(),
        ));
    }
    let file = std::fs::File::open(doc_path).map_err(|e| {
        NameError::CommitUncertain(format!(
            "cannot open the installed document for durability reconciliation: {e}"
        ))
    })?;
    file.sync_all().map_err(|e| {
        NameError::CommitUncertain(format!(
            "cannot sync the installed document for durability reconciliation: {e}"
        ))
    })?;
    drop(file);
    #[cfg(unix)]
    {
        let parent = std::fs::File::open(doc_path.parent().unwrap_or_else(|| Path::new(".")))
            .map_err(|e| {
                NameError::CommitUncertain(format!(
                    "cannot open the data dir for durability reconciliation: {e}"
                ))
            })?;
        parent.sync_all().map_err(|e| {
            NameError::CommitUncertain(format!(
                "cannot sync the data dir for durability reconciliation: {e}"
            ))
        })?;
    }
    // No extra Windows directory-sync guarantee is asserted (the platform
    // durability contract of `atomic_write_durable`).
    Ok(())
}

// ---------------------------------------------------------------------------
// Test hooks (compiled only into the test binary; keyed by data dir so
// parallel test threads never cross-contaminate)
// ---------------------------------------------------------------------------

#[cfg(test)]
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum TestHook {
    PreReplace,
    PostReplace,
    FailReconcile,
    HoldLock(u64),
}

/// Readiness sentinel written by `HoldLock` hooks while the document lock is
/// held: cooperating cross-process tests synchronize on proven lock
/// ownership instead of a fixed post-spawn delay.
#[cfg(test)]
const LOCK_HELD_SENTINEL_NAME: &str = ".session-names-lock-held";

#[cfg(test)]
pub(crate) fn set_test_hooks(data_dir: &Path, hooks: Vec<TestHook>) {
    test_hook_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .insert(data_dir.to_path_buf(), std::sync::Mutex::new(hooks));
}

#[cfg(test)]
pub(crate) fn clear_test_hooks(data_dir: &Path) {
    test_hook_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .remove(data_dir);
}

#[cfg(test)]
fn test_hook_registry(
) -> &'static std::sync::Mutex<BTreeMap<PathBuf, std::sync::Mutex<Vec<TestHook>>>> {
    static REGISTRY: std::sync::OnceLock<
        std::sync::Mutex<BTreeMap<PathBuf, std::sync::Mutex<Vec<TestHook>>>>,
    > = std::sync::OnceLock::new();
    REGISTRY.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
}

#[cfg(test)]
fn take_matching_hook(data_dir: &Path, predicate: impl Fn(&TestHook) -> bool) -> Option<TestHook> {
    let registry = test_hook_registry()
        .lock()
        .unwrap_or_else(|p| p.into_inner());
    let bucket = registry.get(data_dir)?;
    let mut hooks = bucket.lock().unwrap_or_else(|p| p.into_inner());
    let index = hooks.iter().position(predicate)?;
    // HoldLock fires once; failure injections persist until cleared so a
    // whole write window stays broken deterministically.
    if matches!(hooks[index], TestHook::HoldLock(_)) {
        Some(hooks.remove(index))
    } else {
        Some(hooks[index].clone())
    }
}

fn test_hold_once(_data_dir: &Path) {
    #[cfg(test)]
    {
        if let Some(TestHook::HoldLock(ms)) =
            take_matching_hook(_data_dir, |h| matches!(h, TestHook::HoldLock(_)))
        {
            write_lock_held_sentinel(_data_dir);
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
}

/// Write the lock-held readiness sentinel from inside a held transaction
/// (right after lock acquisition). A failed write only degrades a test's
/// synchronization — it never fails the transaction under test.
#[cfg(test)]
fn write_lock_held_sentinel(data_dir: &Path) {
    let sentinel = data_dir.join(LOCK_HELD_SENTINEL_NAME);
    if let Err(err) = std::fs::write(&sentinel, b"held") {
        eprintln!(
            "cannot write session-names lock-held sentinel {}: {err}",
            sentinel.display()
        );
    }
}

fn test_pre_replace_failure(data_dir: &Path) -> bool {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::PreReplace)).is_some()
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        false
    }
}

fn test_post_replace_failure(data_dir: &Path) -> bool {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::PostReplace)).is_some()
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        false
    }
}

fn test_fail_reconcile(data_dir: &Path) -> bool {
    #[cfg(test)]
    {
        take_matching_hook(data_dir, |h| matches!(h, TestHook::FailReconcile)).is_some()
    }
    #[cfg(not(test))]
    {
        let _ = data_dir;
        false
    }
}

// ---------------------------------------------------------------------------
// Acceptance helpers
// ---------------------------------------------------------------------------

/// Resolve a target through redirects and require its record to exist,
/// returning its stable key and the current record.
fn required_record(
    document: &StoredDocument,
    target: &SessionNameRef,
) -> Result<(String, SessionNameRecord), NameError> {
    let (resolved, _) = document.resolve_ref(target);
    let key = name_ref_key(&resolved);
    let record = document
        .record_at(&key)
        .cloned()
        .ok_or_else(|| NameError::NotFound(format!("no naming record for {key}")))?;
    Ok((key, record))
}

/// The unchanged-winner answer shape for Read decisions.
fn read_update(document: &StoredDocument, key: &str) -> SessionNameUpdate {
    update_for_key(document, key, false, RedirectScope::ToRecord).expect("the winner resolves")
}

/// The commit-decision shape: the post-commit value update plus the publish
/// list (records publish only when their accepted value changed;
/// bookkeeping-only generations publish nothing).
fn commit_decision(
    document: &StoredDocument,
    key: &str,
    changed: bool,
) -> Decision<SessionNameUpdate> {
    let value = update_after_commit(document, key, changed, RedirectScope::ToRecord)
        .expect("the record resolves");
    let publish = if changed {
        vec![PublishSpec {
            key: key.to_string(),
            changed: true,
        }]
    } else {
        Vec::new()
    };
    Decision::Write { value, publish }
}

/// Contract rank for new operations:
/// manual > legacy_protected > freshell_ai > provider_ai > first_message >
/// directory. `legacy_protected` preserves a migration-protected label above
/// every automatic source and below a proven manual name; only migration
/// assigns it, and it never claims human origin.
fn source_rank(source: NameSource) -> u8 {
    match source {
        NameSource::Directory => 0,
        NameSource::FirstMessage => 1,
        NameSource::ProviderAi => 2,
        NameSource::FreshellAi => 3,
        NameSource::LegacyProtected => 4,
        NameSource::Manual => 5,
    }
}

/// Sources that stop automatic generation and reject late automatic output.
fn source_is_protected(source: NameSource) -> bool {
    matches!(
        source,
        NameSource::Manual | NameSource::LegacyProtected | NameSource::FreshellAi
    )
}

/// Trim surrounding whitespace; reject an empty/control-bearing name or one
/// over 200 Unicode scalar values with a visible 400-class error. Names are
/// otherwise kept as entered (the short-AI-title normalization is NOT applied
/// here).
fn validate_name(raw: &str) -> Result<String, NameError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(NameError::InvalidName(
            "a session name cannot be empty or whitespace-only".into(),
        ));
    }
    if trimmed.chars().count() > MAX_NAME_SCALARS {
        return Err(NameError::InvalidName(format!(
            "a session name cannot exceed {MAX_NAME_SCALARS} characters"
        )));
    }
    if trimmed.chars().any(char::is_control) {
        return Err(NameError::InvalidName(
            "a session name cannot contain control characters".into(),
        ));
    }
    Ok(trimmed.to_string())
}

/// The immediate `ensure_pending` fallback: the existing directory-basename
/// derivation for a usable cwd, otherwise the provider display label —
/// always at directory rank. A pathological basename (control characters or
/// oversize) is validated away before it can reach a record: the
/// always-valid provider label is used instead.
fn directory_fallback_name(cwd: Option<&str>, provider: &NamedProvider) -> String {
    let label = provider.display_label().to_string();
    let candidate = cwd
        .and_then(basename_segment)
        .unwrap_or_else(|| label.clone());
    validate_name(&candidate).unwrap_or(label)
}

/// The first-message fallback title (the existing 50-char extraction).
fn first_message_fallback(message: &str) -> Option<String> {
    let title = freshell_sessions::text::extract_title_from_message(message, 50);
    if title.is_empty() {
        None
    } else {
        Some(title)
    }
}

/// Bounded first-message excerpt retained for generation (existing prompt cap).
fn excerpt_of(message: &str) -> String {
    message
        .chars()
        .take(crate::ai_title::PROMPT_MESSAGE_CHAR_CAP)
        .collect()
}

/// Input fingerprint for duplicate-activity folding: a digest of the bounded
/// excerpt — stable across duplicate event delivery.
fn fingerprint_message(message: &str) -> String {
    digest_bytes(excerpt_of(message).as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// An update stamped with the generation this transaction is about to commit
/// (Write-decision values only; Read values carry the current generation).
fn update_after_commit(
    document: &StoredDocument,
    key: &str,
    changed: bool,
    scope: RedirectScope,
) -> Option<SessionNameUpdate> {
    update_for_key(document, key, changed, scope).map(|update| SessionNameUpdate {
        document_generation: document.document_generation + 1,
        ..update
    })
}

/// The acceptance rule core: an automatic offer only RAISES rank (equal-rank
/// automatic observations preserve the accepted value); an explicit user
/// rename always wins and may change any record or promote the same text to
/// manual. Returns whether the offer was accepted.
fn offer_mut(
    document: &mut StoredDocument,
    key: &str,
    name: String,
    source: NameSource,
    now: i64,
) -> Result<bool, NameError> {
    let Some(record) = document.record_at(key).cloned() else {
        return Err(NameError::NotFound(format!("no naming record for {key}")));
    };
    if source == NameSource::Manual {
        let revision = document.allocate_revision()?;
        document.records.insert(
            key.to_string(),
            SessionNameRecord {
                name_ref: record.name_ref,
                name,
                source,
                revision,
                manual_revision: Some(revision),
                renamed_at: Some(now),
                legacy_origin: None,
            },
        );
        return Ok(true);
    }
    if source_rank(source) > source_rank(record.source) {
        let revision = document.allocate_revision()?;
        document.records.insert(
            key.to_string(),
            SessionNameRecord {
                name_ref: record.name_ref,
                name,
                source,
                revision,
                manual_revision: None,
                renamed_at: None,
                legacy_origin: None,
            },
        );
        return Ok(true);
    }
    Ok(false)
}

/// Record/advance verified routing evidence. `location_revision` is assigned
/// whenever the verified evidence CHANGES; identical evidence is a no-op.
/// Returns whether the verified evidence changed.
fn apply_verified_location(
    document: &mut StoredDocument,
    key: &str,
    location: NativeLocation,
) -> bool {
    let entry = document.locations.entry(key.to_string()).or_default();
    match &entry.verified {
        None => {
            entry.verified = Some(VerifiedLocation {
                location,
                location_revision: 1,
            });
            true
        }
        Some(existing) if existing.location == location => false,
        Some(existing) => {
            entry.verified = Some(VerifiedLocation {
                location,
                location_revision: existing.location_revision + 1,
            });
            true
        }
    }
}

/// Union the colliding generation budgets on bind: combined consumed counts
/// capped at the three-start allowance, unioned attempt identities, one
/// unaccepted series kept deterministically (the existing durable series if
/// present) so completions for the superseded series are discarded by the
/// series-id guard.
fn union_generation_state(document: &mut StoredDocument, from_key: &str, to_key: &str, now: i64) {
    let Some(pending_series) = document.generation.remove(from_key) else {
        return;
    };
    match document.generation.get_mut(to_key) {
        Some(durable) => {
            durable.consumed =
                (durable.consumed + pending_series.consumed).min(MAX_GENERATION_STARTS);
            for attempt in pending_series.attempt_ids {
                if !durable.attempt_ids.contains(&attempt) {
                    durable.attempt_ids.push(attempt);
                }
            }
            durable.attempt_starts.extend(pending_series.attempt_starts);
            durable.attempt_starts.sort_unstable();
            if durable.input_fingerprint.is_none() {
                durable.input_fingerprint = pending_series.input_fingerprint;
            }
            if durable.excerpt.is_none() {
                durable.excerpt = pending_series.excerpt;
            }
            if durable.consumed >= MAX_GENERATION_STARTS {
                durable.status = GenerationStatus::Exhausted;
                durable.exhausted_at = Some(now);
                durable.excerpt = None;
            }
        }
        None => {
            document
                .generation
                .insert(to_key.to_string(), pending_series);
        }
    }
}

/// Transfer native-write state on bind: consumed cycles and read allowance
/// move conservatively, the desired revision rebases to the bound record
/// (binding is not a new name decision), and original receipts are retained.
fn transfer_native_write(
    document: &mut StoredDocument,
    from_key: &str,
    to_key: &str,
    record: &SessionNameRecord,
) {
    if let Some(mut pending_state) = document.native_write.remove(from_key) {
        match document.native_write.get_mut(to_key) {
            Some(durable) => {
                durable.cycles_consumed += pending_state.cycles_consumed;
                durable.reads_consumed += pending_state.reads_consumed;
                for receipt in pending_state.attempted_receipts {
                    if !durable.attempted_receipts.contains(&receipt) {
                        durable.attempted_receipts.push(receipt);
                    }
                }
                if durable.last_confirmed_receipt.is_none() {
                    durable.last_confirmed_receipt = pending_state.last_confirmed_receipt;
                }
            }
            None => {
                pending_state.desired_revision = Some(record.revision);
                pending_state.desired_name = Some(record.name.clone());
                pending_state.desired_source = Some(record.source);
                document
                    .native_write
                    .insert(to_key.to_string(), pending_state);
            }
        }
    }
    if let Some(state) = document.native_write.get_mut(to_key) {
        state.desired_revision = Some(record.revision);
        state.desired_name = Some(record.name.clone());
        state.desired_source = Some(record.source);
    }
}

/// Move pending-key location evidence onto the bound record (keeping any
/// already-verified target evidence) before the bind's own acquisition lands.
fn move_location_evidence(document: &mut StoredDocument, from_key: &str, to_key: &str) {
    if let Some(pending_location) = document.locations.remove(from_key) {
        let entry = document.locations.entry(to_key.to_string()).or_default();
        if entry.verified.is_none() {
            entry.verified = pending_location.verified;
        }
        if entry.prospective.is_none() {
            entry.prospective = pending_location.prospective;
        }
    }
}

// ---------------------------------------------------------------------------
// Decision closures
// ---------------------------------------------------------------------------

fn ensure_pending_decision(
    document: &mut StoredDocument,
    _meta: &TxnMeta,
    input: PendingNameInput,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    if input.handle.trim().is_empty() {
        return Err(NameError::InvalidName(
            "a naming handle cannot be empty".into(),
        ));
    }
    let pending_ref = SessionNameRef::Pending { id: input.handle };
    let key = name_ref_key(&pending_ref);

    // Already bound: resolve through the redirect (idempotent re-ensure of
    // the durable record, never a second pending admission).
    if let Some(redirect) = document.redirects.get(&key).cloned() {
        let target_key = name_ref_key(&redirect.to);
        if let Some(mut update) =
            update_for_key(document, &target_key, false, RedirectScope::ToRecord)
        {
            update.redirects.push(redirect);
            return Ok(Decision::Read(update));
        }
        // Dangling redirect (its target record vanished): drop it and admit
        // the handle afresh.
        document.redirects.remove(&key);
    }

    // Existing pending record: creation/recovery retries preserve it.
    if let Some(update) = update_for_key(document, &key, false, RedirectScope::None) {
        return Ok(Decision::Read(update));
    }

    let name = directory_fallback_name(input.cwd.as_deref(), &input.provider);
    let revision = document.allocate_revision()?;
    let record = SessionNameRecord {
        name_ref: pending_ref,
        name,
        source: NameSource::Directory,
        revision,
        manual_revision: None,
        renamed_at: None,
        legacy_origin: None,
    };
    document.records.insert(key.clone(), record);
    let value = update_after_commit(document, &key, true, RedirectScope::None)
        .expect("the freshly inserted record resolves");
    Ok(Decision::Write {
        value,
        publish: vec![PublishSpec { key, changed: true }],
    })
}

fn rename_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: RenameNameInput,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, record) = required_record(document, &input.target)?;
    let name = validate_name(&input.name)?;
    if let Some(expected) = input.if_revision {
        if record.revision != expected {
            return Err(NameError::Conflict {
                message: format!(
                    "the record moved to revision {} while the editor held {expected}",
                    record.revision
                ),
                current: Some(record),
            });
        }
    }
    // UI Rename always conveys user intent; automation defaults to an
    // automatic suggestion (provider_ai rank — it can never freeze a name).
    let source = if input.intent == NameIntent::User {
        NameSource::Manual
    } else {
        NameSource::ProviderAi
    };
    if offer_mut(document, &key, name, source, meta.now_ms)? {
        Ok(commit_decision(document, &key, true))
    } else {
        Ok(Decision::Read(read_update(document, &key)))
    }
}

fn offer_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    name: &str,
    source: NameSource,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, _record) = required_record(document, target)?;
    let name = validate_name(name)?;
    if offer_mut(document, &key, name, source, meta.now_ms)? {
        Ok(commit_decision(document, &key, true))
    } else {
        Ok(Decision::Read(read_update(document, &key)))
    }
}

fn bind_pending_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: BindNameInput,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let BindNameInput {
        pending,
        target,
        acquisition,
    } = input;
    if !matches!(pending, SessionNameRef::Pending { .. }) {
        return Err(NameError::InvalidName(
            "a bind source must be a pending handle".into(),
        ));
    }
    if !matches!(target, SessionNameRef::Session { .. }) {
        return Err(NameError::InvalidName(
            "a bind target must be a durable provider/session ref".into(),
        ));
    }
    if acquisition.persistence != NativePersistence::Verified {
        return Err(NameError::IdentityAmbiguous(
            "prospective evidence cannot authorize a pending→durable binding".into(),
        ));
    }

    let pending_key = name_ref_key(&pending);
    let target_key = name_ref_key(&target);

    // Already bound: idempotent for the same target, a conflict otherwise.
    if let Some(existing) = document.redirects.get(&pending_key).cloned() {
        if existing.to == target {
            return Ok(Decision::Read(
                update_for_key(document, &target_key, false, RedirectScope::ToRecord)
                    .expect("the bound target resolves"),
            ));
        }
        return Err(NameError::Conflict {
            message: "the pending handle is already bound to a different durable session".into(),
            current: document.record_at(&target_key).cloned(),
        });
    }

    let pending_record = document
        .record_at(&pending_key)
        .cloned()
        .ok_or_else(|| NameError::NotFound(format!("no pending record for {pending_key}")))?;
    let existing = document.record_at(&target_key).cloned();

    // Rank decides the collision: manual/manual compares actual manual
    // revisions; equal automatic ranks favor the durable record; migration
    // protection rides the rank order. Losing evidence is retained in
    // recovery, never active.
    let (winner, loser) = match &existing {
        None => (pending_record.clone(), None),
        Some(current) => {
            let pending_wins = if pending_record.source == NameSource::Manual
                && current.source == NameSource::Manual
            {
                pending_record.manual_revision.unwrap_or(0) > current.manual_revision.unwrap_or(0)
            } else {
                source_rank(pending_record.source) > source_rank(current.source)
            };
            if pending_wins {
                (pending_record.clone(), Some(current.clone()))
            } else {
                (current.clone(), Some(pending_record.clone()))
            }
        }
    };

    // Binding allocates a record revision even with unchanged text, plus a
    // redirect revision for the pending→durable edge.
    let record_revision = document.allocate_revision()?;
    let record = SessionNameRecord {
        name_ref: target.clone(),
        name: winner.name.clone(),
        source: winner.source,
        revision: record_revision,
        manual_revision: winner.manual_revision,
        renamed_at: winner.renamed_at,
        legacy_origin: winner.legacy_origin,
    };
    document.records.insert(target_key.clone(), record.clone());
    if let Some(loser) = loser {
        document.recovery.insert(
            format!("{}#{}", name_ref_key(&loser.name_ref), loser.revision),
            RecoveryEntry {
                record: loser,
                evidence: None,
                retained_at: meta.now_ms,
                reason: "bind_collision_loser".to_string(),
            },
        );
    }
    let redirect_revision = document.allocate_revision()?;
    document.redirects.insert(
        pending_key.clone(),
        SessionNameRedirect {
            from: pending.clone(),
            to: target.clone(),
            revision: redirect_revision,
        },
    );
    document.records.remove(&pending_key);

    // Internal state transfers (never user-visible wire fields).
    move_location_evidence(document, &pending_key, &target_key);
    union_generation_state(document, &pending_key, &target_key, meta.now_ms);
    transfer_native_write(document, &pending_key, &target_key, &record);
    apply_verified_location(document, &target_key, acquisition.location);

    Ok(commit_decision(document, &target_key, true))
}

fn activity_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: NameActivity,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let NameActivity {
        target,
        mode: _mode,
        event_id: _event_id,
        reason,
        first_user_message,
        cwd: _cwd,
    } = input;
    let (key, _record) = required_record(document, &target)?;

    let mut changed = false;
    // Accepted input upgrades the fallback without waiting for generation.
    if matches!(
        reason,
        NameActivityReason::AcceptedUserMessage | NameActivityReason::IndexUserMessage
    ) {
        if let Some(message) = first_user_message.as_deref() {
            if let Some(fallback) = first_message_fallback(message) {
                if validate_name(&fallback).is_ok() {
                    changed = offer_mut(
                        document,
                        &key,
                        fallback,
                        NameSource::FirstMessage,
                        meta.now_ms,
                    )?;
                }
            }
        }
    }

    // Eligibility arming: protected names never arm; an exhausted series
    // never re-arms; duplicate delivery (same input fingerprint) is a no-op.
    let current_source = document
        .record_at(&key)
        .map(|record| record.source)
        .expect("record exists");
    let mut armed_or_updated = false;
    if !source_is_protected(current_source) {
        if let Some(message) = first_user_message.as_deref() {
            let fingerprint = fingerprint_message(message);
            let needs_arm = match document.generation.get(&key) {
                None => true,
                Some(series) => series.input_fingerprint.as_deref() != Some(fingerprint.as_str()),
            };
            if needs_arm {
                let series =
                    document
                        .generation
                        .entry(key.clone())
                        .or_insert_with(|| GenerationState {
                            status: GenerationStatus::Eligible,
                            series_id: Uuid::new_v4().to_string(),
                            input_fingerprint: None,
                            excerpt: None,
                            attempt_ids: Vec::new(),
                            attempt_starts: Vec::new(),
                            consumed: 0,
                            next_due: None,
                            exhausted_at: None,
                        });
                if series.status != GenerationStatus::Exhausted {
                    series.status = GenerationStatus::Eligible;
                    series.input_fingerprint = Some(fingerprint);
                    series.excerpt = Some(excerpt_of(message));
                    series.next_due = None;
                    armed_or_updated = true;
                }
            }
        }
    }

    if changed {
        Ok(commit_decision(document, &key, true))
    } else if armed_or_updated {
        // Bookkeeping-only commit: a generation advance with no visible text.
        Ok(commit_decision(document, &key, false))
    } else {
        Ok(Decision::Read(read_update(document, &key)))
    }
}

fn observe_native_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    input: NativeNameObservation,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let NativeNameObservation {
        target,
        title,
        origin,
        location_revision,
        event_id,
    } = input;
    let (key, _record) = required_record(document, &target)?;

    // An old-location observation is provenance only: it can never mark the
    // current location synchronized or fold a stale title into the name.
    let verified_revision = document
        .locations
        .get(&key)
        .and_then(|location| location.verified.as_ref())
        .map(|verified| verified.location_revision)
        .unwrap_or(0);
    let stale = location_revision < verified_revision;

    {
        let entry = document.native_write.entry(key.clone()).or_default();
        entry.last_observation = Some(StoredObservation {
            origin: match origin {
                NativeNameOrigin::Snapshot => "snapshot".to_string(),
                NativeNameOrigin::ProviderAi => "provider_ai".to_string(),
                NativeNameOrigin::OwnWrite => "own_write".to_string(),
            },
            location_revision,
            event_id,
            at: meta.now_ms,
            stale,
        });
    }

    let mut changed = false;
    match origin {
        // An own-write echo is provenance only: same-name or late echoes never
        // promote the source or revision.
        NativeNameOrigin::OwnWrite => {}
        NativeNameOrigin::Snapshot | NativeNameOrigin::ProviderAi => {
            if !stale {
                let name = validate_name(&title)?;
                changed = offer_mut(document, &key, name, NameSource::ProviderAi, meta.now_ms)?;
            }
        }
    }

    if changed {
        Ok(commit_decision(document, &key, true))
    } else {
        // Provenance bookkeeping is a persisted mutation (a bookkeeping-only
        // generation) — but it publishes nothing and never renames.
        Ok(commit_decision(document, &key, false))
    }
}

fn record_acquisition_decision(
    document: &mut StoredDocument,
    _meta: &TxnMeta,
    target: &SessionNameRef,
    acquisition: NativeAcquisition,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, _record) = required_record(document, target)?;
    match acquisition.persistence {
        NativePersistence::Verified => {
            let changed = apply_verified_location(document, &key, acquisition.location);
            if changed {
                Ok(commit_decision(document, &key, false))
            } else {
                Ok(Decision::Read(read_update(document, &key)))
            }
        }
        NativePersistence::Prospective => {
            let entry = document.locations.entry(key.clone()).or_default();
            let changed = entry.prospective.as_ref() != Some(&acquisition.location);
            if changed {
                entry.prospective = Some(acquisition.location);
                Ok(Decision::Write {
                    value: update_after_commit(document, &key, false, RedirectScope::ToRecord)
                        .expect("the record resolves"),
                    publish: Vec::new(),
                })
            } else {
                Ok(Decision::Read(
                    update_for_key(document, &key, false, RedirectScope::ToRecord)
                        .expect("the record resolves"),
                ))
            }
        }
    }
}

fn claim_generation_start_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    attempt_id: &str,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, _record) = required_record(document, target)?;
    let Some(series) = document.generation.get_mut(&key) else {
        return Err(NameError::NotFound(format!(
            "no generation series is armed for {key}"
        )));
    };
    if series.status == GenerationStatus::Exhausted || series.consumed >= MAX_GENERATION_STARTS {
        // Exhaustion is final: a claim beyond the cap is a bounded no-op.
        return Ok(Decision::Read(read_update(document, &key)));
    }
    // Persist the start before dispatch; empty/invalid answers consume it.
    series.consumed += 1;
    series.attempt_ids.push(attempt_id.to_string());
    series.attempt_starts.push(meta.now_ms);
    if series.consumed >= MAX_GENERATION_STARTS {
        series.status = GenerationStatus::Exhausted;
        series.exhausted_at = Some(meta.now_ms);
        series.excerpt = None;
    } else {
        series.status = GenerationStatus::InFlight;
    }
    Ok(commit_decision(document, &key, false))
}

fn complete_generation_decision(
    document: &mut StoredDocument,
    meta: &TxnMeta,
    target: &SessionNameRef,
    series_id: &str,
    answer: &str,
) -> Result<Decision<SessionNameUpdate>, NameError> {
    let (key, _record) = required_record(document, target)?;
    let Some(series) = document.generation.get(&key).cloned() else {
        return Err(NameError::NotFound(format!(
            "no generation series is armed for {key}"
        )));
    };
    // Accept only if that same series is current: superseded-series
    // completions are discarded.
    if series.series_id != series_id {
        return Ok(Decision::Read(read_update(document, &key)));
    }
    // A protected winner (manual, migration-protected, accepted Freshell AI)
    // rejects late output.
    let current_source = document
        .record_at(&key)
        .map(|record| record.source)
        .expect("record exists");
    if source_is_protected(current_source) {
        return Ok(Decision::Read(read_update(document, &key)));
    }
    let name = validate_name(answer)?;
    if offer_mut(document, &key, name, NameSource::FreshellAi, meta.now_ms)? {
        let series = document
            .generation
            .get_mut(&key)
            .expect("the series still exists");
        series.status = GenerationStatus::Idle;
        series.excerpt = None;
        Ok(commit_decision(document, &key, true))
    } else {
        Ok(Decision::Read(read_update(document, &key)))
    }
}
