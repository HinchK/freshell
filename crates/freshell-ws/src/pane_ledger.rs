//! P1.8 — the server-side pane-identity ledger (restart-resilience campaign
//! §4.2): a small per-row disk store under `<home>/.freshell/pane-ledger/`,
//! written durably at identity events with atomic temp+rename
//! (`crate::tabs_persist::atomic_write_durable`).
//!
//! Two row types with different keys and different rights:
//!
//! * **Binding rows** — durable identity facts, keyed on the server-minted
//!   `sessionRef` (provider, sessionId), with `terminalId` as a secondary
//!   index. A binding row is *the resume-invocation record*: it stores
//!   exactly what re-issuing the provider's resume needs (for terminal panes:
//!   provider, sessionId, mode, cwd). Layout:
//!   `bindings/<enc(provider)>/<enc(sessionId)>.json`.
//! * **Pending markers** — evidence that identity establishment was in
//!   flight, keyed on `terminalId` (the only stable server-minted id that
//!   exists pre-identity). NEVER promoted, never joined (G1): resolution
//!   writes a fresh binding row FIRST, then deletes the marker. Layout:
//!   `pending/<enc(terminalId)>.json`.
//!
//! Deliberately NOT stored: scrollback (own store, P2.19), transcripts
//! (provider-owned), layout (client-owned). NOT keyed on `createRequestId`
//! (D4/V9.md: every restore path that re-creates an anchored pane re-mints
//! it first; only the orphaned in-flight-create replay preserves it) —
//! stored only as an advisory field, never an identity join key.
//!
//! Corruption policy: fail loud PER-ROW, never per-store — an unparsable row
//! is quarantined (renamed aside + logged), never silently dropped, and never
//! causes healthy rows to be skipped.
//!
//! Write-failure policy: a ledger write failure never blocks the
//! create/identity event, but it is never silent — see
//! [`surface_write_failure`].
//!
//! Read/scan policy (V1.md / A15): a write-through in-memory index, loaded
//! ONCE at construction by a single directory scan, answers ALL steady-state
//! reads — no API does a per-call directory scan (full-store scans measured
//! at 21ms@1k / 426ms@20k rows; TTL math yields 1.2k-12k rows). Files stay
//! the durable source of truth; this process is the only writer
//! (single-writer flock, [`PaneLedger::new_locked`]), so write-through
//! invalidation is trivial. Reads never touch the fs and may run inline on
//! async paths; WRITES fsync (~15ms p50 on this host) and must be wrapped in
//! `spawn_blocking` at async call sites (the `terminal.rs:1369-1379`
//! PTY-spawn precedent) — the sync API here stays call-site-agnostic.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, RwLock};

use freshell_protocol::SessionLocator;
use serde::{Deserialize, Serialize};

/// Gates schema migration (spec §4.2): rows with a different version are
/// quarantined loudly at boot, never silently reinterpreted.
pub const LEDGER_VERSION: u32 = 1;

/// Bound rows not observed within this TTL are expired TO TOMBSTONES
/// (`retired/gc_expired`), never deleted (spec §4.2 lifecycle).
pub const BOUND_GC_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Tombstones older than this are deleted ONLY once the transcript no longer
/// exists on disk — silent-fresh never returns by timer while the
/// conversation is still recoverable.
pub const TOMBSTONE_GC_TTL_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// Pending markers older than this are swept (boot scan + periodic GC),
/// bounding leaked-marker lifetime (A8/V7: a pane that dies WITH the server
/// leaves a marker no exit hook will ever delete — terminal ids are never
/// re-minted). Fresh-by-race evidence matters at the boots near the crash;
/// a month-old marker is stale noise.
pub const PENDING_MARKER_TTL_MS: i64 = 30 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RowState {
    Bound,
    Retired,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RetiredReason {
    Superseded,
    Closed,
    GcExpired,
}

/// A durable identity fact — see the module doc for the schema contract.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BindingRow {
    pub ledger_version: u32,
    pub provider: String,
    pub session_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    /// Advisory secondary index — the terminal that last owned this identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub live_terminal_id: Option<String>,
    /// Advisory, latest-observed (D4: the client re-mints it on hydrate; it
    /// is never an identity join key).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub create_request_id: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
    pub last_observed_at: i64,
    pub state: RowState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retired_reason: Option<RetiredReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<SessionLocator>,
}

/// Evidence that identity establishment was in flight (G1: never a binding).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingMarker {
    pub ledger_version: u32,
    pub terminal_id: String,
    pub mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub spawned_at: i64,
}

/// One identity event's worth of binding-row input.
pub struct BindingWrite<'a> {
    pub provider: &'a str,
    pub session_id: &'a str,
    pub terminal_id: &'a str,
    pub mode: &'a str,
    pub cwd: Option<&'a str>,
    pub create_request_id: Option<&'a str>,
    pub now_ms: i64,
}

/// A row the boot scan renamed aside because it could not be parsed.
#[derive(Debug, Clone)]
pub struct QuarantinedRow {
    pub original_path: PathBuf,
    pub quarantined_path: PathBuf,
    pub error: String,
}

/// What one boot scan / GC pass did — every field is also loudly logged.
#[derive(Debug, Default)]
pub struct BootScanReport {
    pub quarantined: Vec<QuarantinedRow>,
    pub stale_markers_removed: Vec<String>,
    /// (retired old ref, winning new ref) pairs from the crash-window repair.
    pub supersession_repairs: Vec<(SessionLocator, SessionLocator)>,
    pub gc_tombstoned: Vec<SessionLocator>,
    pub tombstones_deleted: Vec<SessionLocator>,
}

/// A chain-terminus lookup result. `corrected == true` means the caller's
/// claimed ref was superseded and this row is the live successor.
#[derive(Debug, Clone)]
pub struct Resolution {
    pub row: BindingRow,
    pub corrected: bool,
}

/// The in-memory write-through index (V1.md / A15). Loaded ONCE at
/// construction by a single directory scan; every successful file write
/// updates it in the same locked section. Unparsable / wrong-version files
/// are skipped here silently — the boot scan (Task 4) is what quarantines
/// them loudly.
#[derive(Default)]
struct LedgerIndex {
    /// (provider, session_id) -> row. Bound AND retired (tombstones stay).
    bindings: std::collections::HashMap<(String, String), BindingRow>,
    /// terminal_id -> marker.
    pending: std::collections::HashMap<String, PendingMarker>,
}

/// The ledger store. `root: None` ⇒ feature disabled (no resolvable home) —
/// every write is an `Ok(())` no-op and every read answers empty, mirroring
/// the tabs-snapshots `Option`-wrapped-root precedent (`main.rs:709-711`).
pub struct PaneLedger {
    root: Option<PathBuf>,
    /// ONE lock: serializes read-modify-write cycles AND owns the
    /// write-through index — no cache-vs-file races by construction.
    index: Mutex<LedgerIndex>,
    /// Held for the process lifetime by `new_locked` (single-writer guard,
    /// V2.md); the kernel releases the flock on process death.
    #[allow(dead_code)] // read only by the kernel (flock lifetime)
    lock_file: Option<std::fs::File>,
    /// Rows quarantined by the boot scan, retained for API surfacing.
    #[allow(dead_code)] // populated + read by the boot scan (Task 4)
    quarantined: RwLock<Vec<QuarantinedRow>>,
}

impl PaneLedger {
    /// Lock-free construction — tests and the integration harness use this
    /// (verification handles over a live server's dir must not fight the
    /// server's flock). Production uses [`PaneLedger::new_locked`].
    pub fn new(root: Option<PathBuf>) -> Self {
        let index = root
            .as_ref()
            .map(|r| Self::load_index(r))
            .unwrap_or_default();
        Self {
            root,
            index: Mutex::new(index),
            lock_file: None,
            quarantined: RwLock::new(Vec::new()),
        }
    }

    /// Production construction (V2.md single-writer guard): acquire an
    /// exclusive advisory `flock(2)` on `<root>/lock` (the `ConfigLock`
    /// pattern, `settings_store.rs:385-417`). If another process holds it,
    /// log a loud structured ERROR and come up DISABLED (no-op) — never two
    /// writers on one store. Non-unix: no flock primitive is wired;
    /// construct normally (ConfigLock's non-unix parity).
    pub fn new_locked(root: Option<PathBuf>) -> Self {
        let Some(r) = root.clone() else {
            return Self::new(None);
        };
        match Self::acquire_store_lock(&r) {
            Ok(lock_file) => {
                let mut ledger = Self::new(root);
                ledger.lock_file = lock_file;
                ledger
            }
            Err(err) => {
                tracing::error!(
                    target: "freshell_ws::pane_ledger",
                    root = %r.display(),
                    error = %err,
                    "pane_ledger_lock_unavailable: another writer holds <root>/lock; \
                     ledger DISABLED for this process (never two writers on one store)"
                );
                Self::new(None)
            }
        }
    }

    #[cfg(unix)]
    fn acquire_store_lock(root: &Path) -> std::io::Result<Option<std::fs::File>> {
        use std::os::unix::io::AsRawFd;
        std::fs::create_dir_all(root)?;
        // Content irrelevant (only existence + flock state matter);
        // truncate(false) avoids clippy's suspicious_open_options.
        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(root.join("lock"))?;
        // SAFETY: `fd` is a valid open descriptor owned by `file` for the
        // duration of the call; flock only mutates kernel lock state.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            Ok(Some(file))
        } else {
            Err(std::io::Error::last_os_error())
        }
    }

    #[cfg(not(unix))]
    fn acquire_store_lock(_root: &Path) -> std::io::Result<Option<std::fs::File>> {
        Ok(None) // no advisory-lock primitive on this platform (ConfigLock parity)
    }

    /// A ledger that stores nothing — the test/default construction.
    pub fn disabled() -> Self {
        Self::new(None)
    }

    fn bindings_dir(root: &Path) -> PathBuf {
        root.join("bindings")
    }

    fn pending_dir(root: &Path) -> PathBuf {
        root.join("pending")
    }

    fn binding_path(root: &Path, provider: &str, session_id: &str) -> PathBuf {
        Self::bindings_dir(root)
            .join(encode_segment(provider))
            .join(format!("{}.json", encode_segment(session_id)))
    }

    /// The ONE directory scan — construction-time only (V1.md).
    fn load_index(root: &Path) -> LedgerIndex {
        let mut index = LedgerIndex::default();
        if let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) {
            for provider in providers.flatten() {
                let Ok(files) = std::fs::read_dir(provider.path()) else {
                    continue;
                };
                for file in files.flatten() {
                    let path = file.path();
                    if path.extension().and_then(|e| e.to_str()) != Some("json") {
                        continue; // *.tmp-* and *.quarantined-* residue
                    }
                    if let Ok(row) = load_row::<BindingRow>(&path) {
                        if row.ledger_version == LEDGER_VERSION {
                            index
                                .bindings
                                .insert((row.provider.clone(), row.session_id.clone()), row);
                        }
                    }
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) {
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                if let Ok(marker) = load_row::<PendingMarker>(&path) {
                    if marker.ledger_version == LEDGER_VERSION {
                        index.pending.insert(marker.terminal_id.clone(), marker);
                    }
                }
            }
        }
        index
    }

    /// Poison-tolerant lock (the `with_persist_lock` idiom) over the
    /// write-through index.
    fn guard(&self) -> std::sync::MutexGuard<'_, LedgerIndex> {
        self.index.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Record (or refresh) a `bound` row for this identity event.
    pub fn record_binding(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        self.record_binding_locked(root, &mut index, w)
    }

    fn record_binding_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        w: &BindingWrite<'_>,
    ) -> std::io::Result<()> {
        // Supersession (G3, retire-never-defend): if this terminal already
        // owns a DIFFERENT bound identity, the order is pinned — write the
        // new `bound` row FIRST, then retire the old. A crash between the
        // two leaves two bound rows; the boot-scan repair (Task 4) closes
        // that window. Detection is a memory scan over the index (V1.md).
        let previous = index
            .bindings
            .values()
            .find(|r| {
                r.state == RowState::Bound
                    && r.live_terminal_id.as_deref() == Some(w.terminal_id)
                    && (r.provider != w.provider || r.session_id != w.session_id)
            })
            .cloned();

        let key = (w.provider.to_string(), w.session_id.to_string());
        let existing = index.bindings.get(&key);
        let created_at = existing.map(|r| r.created_at).unwrap_or(w.now_ms);
        if existing.is_some_and(|r| r.retired_reason == Some(RetiredReason::GcExpired)) {
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                provider = %w.provider,
                session_id = %w.session_id,
                "pane_ledger_revived: gc_expired tombstone re-bound by a live identity event"
            );
        }
        let row = BindingRow {
            ledger_version: LEDGER_VERSION,
            provider: w.provider.to_string(),
            session_id: w.session_id.to_string(),
            mode: w.mode.to_string(),
            cwd: w.cwd.map(str::to_string),
            live_terminal_id: Some(w.terminal_id.to_string()),
            create_request_id: w.create_request_id.map(str::to_string),
            created_at,
            updated_at: w.now_ms,
            last_observed_at: w.now_ms,
            state: RowState::Bound,
            retired_reason: None,
            superseded_by: None,
        };
        self.write_binding(root, index, &row)?; // new bound row FIRST (pinned)

        if let Some(mut old) = previous {
            old.state = RowState::Retired;
            old.retired_reason = Some(RetiredReason::Superseded);
            old.superseded_by = Some(SessionLocator {
                provider: w.provider.to_string(),
                session_id: w.session_id.to_string(),
            });
            old.updated_at = w.now_ms;
            tracing::info!(
                target: "freshell_ws::pane_ledger",
                terminal_id = %w.terminal_id,
                old_session_id = %old.session_id,
                new_session_id = %w.session_id,
                "pane_ledger_superseded: binding moved; old row retired, never defended"
            );
            self.write_binding(root, index, &old)?; // THEN retire the old
        }
        Ok(())
    }

    /// One row: durable file FIRST, then the write-through index — in the
    /// same locked section, so readers never see index-ahead-of-disk.
    fn write_binding(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        row: &BindingRow,
    ) -> std::io::Result<()> {
        let dest = Self::binding_path(root, &row.provider, &row.session_id);
        write_row_atomic(&dest, row)?;
        index
            .bindings
            .insert((row.provider.clone(), row.session_id.clone()), row.clone());
        Ok(())
    }

    /// Raw single-row read from the index (no chain following — that is
    /// `lookup_by_session`, Task 2). Memory-only (V1.md read policy).
    pub fn load_binding(&self, provider: &str, session_id: &str) -> Option<BindingRow> {
        self.root.as_ref()?;
        self.guard()
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()
    }

    /// Follow the `supersededBy` chain from a claimed ref to its terminus.
    /// Chains cannot cycle (a supersession write always targets a fresh row
    /// and retires its predecessor in the same act) — the hop cap is a
    /// corruption backstop, loud when hit.
    pub fn lookup_by_session(&self, provider: &str, session_id: &str) -> Option<Resolution> {
        self.root.as_ref()?;
        let index = self.guard(); // memory-only chain walk (V1.md read policy)
        let mut row = index
            .bindings
            .get(&(provider.to_string(), session_id.to_string()))
            .cloned()?;
        let mut corrected = false;
        let mut hops = 0u32;
        while row.state == RowState::Retired {
            let Some(next) = row.superseded_by.clone() else {
                break; // closed / gc_expired terminus — caller applies its reader rule
            };
            hops += 1;
            if hops > 32 {
                tracing::error!(
                    target: "freshell_ws::pane_ledger",
                    provider = %provider,
                    session_id = %session_id,
                    "pane_ledger_chain_overflow: supersession chain exceeded 32 hops (corruption?)"
                );
                return None;
            }
            let Some(next_row) = index
                .bindings
                .get(&(next.provider.clone(), next.session_id.clone()))
                .cloned()
            else {
                break;
            };
            row = next_row;
            corrected = true;
        }
        Some(Resolution { row, corrected })
    }

    /// Whether this server has EVER durably bound this identity — bound or
    /// retired, tombstones included. This is the ledger-backed
    /// `ever_observed` input (spec §4.2 reads). Memory-only.
    pub fn ever_bound(&self, provider: &str, session_id: &str) -> bool {
        if self.root.is_none() {
            return false;
        }
        self.guard()
            .bindings
            .contains_key(&(provider.to_string(), session_id.to_string()))
    }

    /// All indexed binding rows (bound AND retired). Memory-only.
    pub fn list_bindings(&self) -> Vec<BindingRow> {
        if self.root.is_none() {
            return Vec::new();
        }
        self.guard().bindings.values().cloned().collect()
    }

    /// Secondary-index read: the newest BOUND row owned by this terminal.
    pub fn bound_session_ref_for_terminal(&self, terminal_id: &str) -> Option<SessionLocator> {
        self.list_bindings()
            .into_iter()
            .filter(|r| {
                r.state == RowState::Bound && r.live_terminal_id.as_deref() == Some(terminal_id)
            })
            .max_by_key(|r| r.updated_at)
            .map(|r| SessionLocator {
                provider: r.provider,
                session_id: r.session_id,
            })
    }

    /// Advisory-index read for the claude restore ladder: the newest row for
    /// this provider whose latest-observed `createRequestId` matches.
    /// Includes `gc_expired` tombstones (auto-resume is a legal transition);
    /// excludes `closed`/`superseded` rows (retired rows are never used to
    /// answer a restore — reader rule, spec §4.2).
    pub fn lookup_by_create_request_id(
        &self,
        provider: &str,
        create_request_id: &str,
    ) -> Option<BindingRow> {
        self.list_bindings()
            .into_iter()
            .filter(|r| {
                r.provider == provider
                    && r.create_request_id.as_deref() == Some(create_request_id)
                    && (r.state == RowState::Bound
                        || r.retired_reason == Some(RetiredReason::GcExpired))
            })
            .max_by_key(|r| r.updated_at)
    }

    fn pending_path(root: &Path, terminal_id: &str) -> PathBuf {
        Self::pending_dir(root).join(format!("{}.json", encode_segment(terminal_id)))
    }

    /// Durable evidence that identity establishment is in flight for this
    /// terminal (spec §4.2): written at spawn of an identity-bearing pane
    /// whose identity is not yet known. File first, then index (write-through).
    pub fn record_pending(
        &self,
        terminal_id: &str,
        mode: &str,
        cwd: Option<&str>,
        now_ms: i64,
    ) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        let marker = PendingMarker {
            ledger_version: LEDGER_VERSION,
            terminal_id: terminal_id.to_string(),
            mode: mode.to_string(),
            cwd: cwd.map(str::to_string),
            spawned_at: now_ms,
        };
        write_row_atomic(&Self::pending_path(root, terminal_id), &marker)?;
        index.pending.insert(terminal_id.to_string(), marker);
        Ok(())
    }

    /// Identity resolved: two independent atomic operations in a PINNED,
    /// load-bearing order — write the sessionRef-keyed binding row FIRST,
    /// then delete the pending marker (spec §4.2, G1/decision 5). A crash
    /// between the two leaves both, which is safe: the reader rule prefers
    /// the binding row and the boot sweep (Task 4) deletes the stale marker.
    /// Idempotent: a second racing resolution finds the marker gone or the
    /// row already bound and no-ops.
    pub fn resolve_pending(&self, w: &BindingWrite<'_>) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        self.record_binding_locked(root, &mut index, w)?; // binding row FIRST
        Self::remove_pending(root, &mut index, w.terminal_id) // THEN the marker
    }

    /// Best-effort marker removal (missing file == already resolved/GC'd).
    pub fn delete_pending(&self, terminal_id: &str) -> std::io::Result<()> {
        let Some(root) = &self.root else {
            return Ok(());
        };
        let mut index = self.guard();
        Self::remove_pending(root, &mut index, terminal_id)
    }

    fn remove_pending(
        root: &Path,
        index: &mut LedgerIndex,
        terminal_id: &str,
    ) -> std::io::Result<()> {
        let result = match std::fs::remove_file(Self::pending_path(root, terminal_id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e),
        };
        if result.is_ok() {
            index.pending.remove(terminal_id);
        }
        result
    }

    /// Reader-rule lookup: `None` when no marker exists OR when a binding
    /// row already covers this terminal ("binding row wins; such a marker is
    /// stale"). Memory-only (V1.md read policy).
    pub fn pending_for_terminal(&self, terminal_id: &str) -> Option<PendingMarker> {
        self.root.as_ref()?;
        let index = self.guard();
        let marker = index.pending.get(terminal_id).cloned()?;
        let has_binding = index
            .bindings
            .values()
            .any(|r| r.live_terminal_id.as_deref() == Some(terminal_id));
        if has_binding {
            return None;
        }
        Some(marker)
    }

    /// Raw markers (no reader rule) — boot-sweep + test surface. Memory-only.
    pub fn list_pending_raw(&self) -> Vec<PendingMarker> {
        if self.root.is_none() {
            return Vec::new();
        }
        self.guard().pending.values().cloned().collect()
    }

    /// Boot-time hygiene (spec §4.2): per-row quarantine, stale-marker
    /// sweep, supersession crash-window repair, then a GC pass. Fail loud
    /// per-row, never per-store. The directory walks here are BOOT-ONLY —
    /// steady-state reads stay on the in-memory index (V1.md).
    pub fn boot_scan(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let mut index = self.guard();
        let mut report = BootScanReport::default();

        // 1. Quarantine unparsable / wrong-version rows (bindings + pending).
        //    These never made it into the index (load_index keeps only clean
        //    current-version parses), so no index maintenance is needed here.
        self.quarantine_unparsable(&root, now_ms, &mut report);
        {
            let mut q = self.quarantined.write().unwrap_or_else(|p| p.into_inner());
            q.extend(report.quarantined.iter().cloned());
        }

        // 2. Stale-marker sweep — two cases, both loud:
        //    (a) a marker whose terminalId already has a binding row is
        //        stale — the crash-between-write-and-delete shape;
        //    (b) a marker older than PENDING_MARKER_TTL_MS is aged out
        //        (A8/V7: bounds leaked markers from panes that died WITH the
        //        server — no exit hook will ever fire for them and terminal
        //        ids are never re-minted).
        //    Markers that are neither are PRESERVED (fresh-by-race
        //    evidence), never swept merely because the terminal isn't live.
        let markers: Vec<PendingMarker> = index.pending.values().cloned().collect();
        for marker in markers {
            let covered = index
                .bindings
                .values()
                .any(|r| r.live_terminal_id.as_deref() == Some(marker.terminal_id.as_str()));
            let aged_out = now_ms - marker.spawned_at > PENDING_MARKER_TTL_MS;
            if covered || aged_out {
                match Self::remove_pending(&root, &mut index, &marker.terminal_id) {
                    Ok(()) => {
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %marker.terminal_id,
                            covered_by_binding = covered,
                            aged_out = aged_out,
                            "pane_ledger_stale_marker_swept: crash-window residue or aged past TTL"
                        );
                        report.stale_markers_removed.push(marker.terminal_id);
                    }
                    Err(err) => {
                        // Fail loud, never silent: the marker stays; the
                        // next boot/GC pass retries naturally.
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %marker.terminal_id,
                            covered_by_binding = covered,
                            aged_out = aged_out,
                            error = %err,
                            "pane_ledger_stale_marker_sweep_failed: marker removal failed; will retry next pass"
                        );
                    }
                }
            }
        }

        // 3. Supersession crash-window repair: two bound rows on one pane
        //    lineage — newer updatedAt wins, older auto-retired, loud.
        let mut by_terminal: std::collections::HashMap<String, Vec<BindingRow>> =
            std::collections::HashMap::new();
        for row in index.bindings.values() {
            if row.state == RowState::Bound {
                if let Some(tid) = &row.live_terminal_id {
                    by_terminal
                        .entry(tid.clone())
                        .or_default()
                        .push(row.clone());
                }
            }
        }
        for (terminal_id, mut rows) in by_terminal {
            if rows.len() < 2 {
                continue;
            }
            // Tiebreak rationale (A16, strategist report): both rows were
            // written by a SINGLE process run, milliseconds apart — the only
            // hazard is a wall-clock step landing INSIDE that ms-wide window.
            // Accepted: wall-clock updatedAt is the tiebreak. If this ever
            // bites, stamp an in-process AtomicU64 sequence into rows as a
            // secondary tiebreak (schema addition, P1.13-compatible).
            rows.sort_by_key(|r| std::cmp::Reverse(r.updated_at));
            let winner = SessionLocator {
                provider: rows[0].provider.clone(),
                session_id: rows[0].session_id.clone(),
            };
            for mut loser in rows.into_iter().skip(1) {
                loser.state = RowState::Retired;
                loser.retired_reason = Some(RetiredReason::Superseded);
                loser.superseded_by = Some(winner.clone());
                loser.updated_at = now_ms;
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    terminal_id = %terminal_id,
                    loser_session_id = %loser.session_id,
                    winner_session_id = %winner.session_id,
                    "pane_ledger_supersession_repair: two bound rows on one lineage; newer updatedAt wins"
                );
                let loser_ref = SessionLocator {
                    provider: loser.provider.clone(),
                    session_id: loser.session_id.clone(),
                };
                match self.write_binding(&root, &mut index, &loser) {
                    Ok(()) => {
                        report
                            .supersession_repairs
                            .push((loser_ref, winner.clone()));
                    }
                    Err(err) => {
                        // Fail loud, never silent: the loser stays bound on
                        // disk; the repair re-runs at the next boot scan.
                        tracing::error!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %terminal_id,
                            loser_session_id = %loser_ref.session_id,
                            winner_session_id = %winner.session_id,
                            error = %err,
                            "pane_ledger_supersession_repair_failed: retire write failed; row left bound"
                        );
                    }
                }
            }
        }

        // 4. GC pass (also runs periodically via `gc`).
        let gc_report = self.gc_locked(&root, &mut index, now_ms, transcript_absent);
        report.gc_tombstoned = gc_report.gc_tombstoned;
        report.tombstones_deleted = gc_report.tombstones_deleted;
        report
    }

    /// The periodic subset: expire unobserved bound rows TO TOMBSTONES,
    /// delete old tombstones ONLY when the transcript is definitively gone —
    /// per the caller's DIRECT-STAT closure (V10.md: probe Absent alone is
    /// not definitive; see the boot_scan contract) — and sweep aged-out
    /// pending markers (the leaked-marker lifetime bound must hold on a
    /// long-running server, not only across restarts).
    pub fn gc(
        &self,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let Some(root) = self.root.clone() else {
            return BootScanReport::default();
        };
        let mut index = self.guard();
        self.gc_locked(&root, &mut index, now_ms, transcript_absent)
    }

    fn gc_locked(
        &self,
        root: &Path,
        index: &mut LedgerIndex,
        now_ms: i64,
        transcript_absent: &dyn Fn(&str, &str) -> bool,
    ) -> BootScanReport {
        let mut report = BootScanReport::default();

        // Aged-marker sweep (A8/V7): part of the periodic subset per the
        // `gc` contract, so a long-running server bounds leaked-marker
        // lifetime WITHOUT a restart. Only the TTL case runs here — the
        // covered-by-binding case is boot-only crash-window residue
        // (boot_scan step 2, which also handles the TTL case at boot, so
        // this loop finds nothing on the boot path).
        let markers: Vec<PendingMarker> = index.pending.values().cloned().collect();
        for marker in markers {
            if now_ms - marker.spawned_at > PENDING_MARKER_TTL_MS {
                match Self::remove_pending(root, index, &marker.terminal_id) {
                    Ok(()) => {
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %marker.terminal_id,
                            "pane_ledger_stale_marker_swept: aged past TTL (periodic GC)"
                        );
                        report.stale_markers_removed.push(marker.terminal_id);
                    }
                    Err(err) => {
                        // Fail loud, never silent: the marker stays; the
                        // next GC pass retries naturally.
                        tracing::warn!(
                            target: "freshell_ws::pane_ledger",
                            terminal_id = %marker.terminal_id,
                            error = %err,
                            "pane_ledger_stale_marker_sweep_failed: marker removal failed; will retry next pass"
                        );
                    }
                }
            }
        }

        let rows: Vec<BindingRow> = index.bindings.values().cloned().collect();
        for mut row in rows {
            let sref = SessionLocator {
                provider: row.provider.clone(),
                session_id: row.session_id.clone(),
            };
            match row.state {
                RowState::Bound => {
                    if now_ms - row.last_observed_at > BOUND_GC_TTL_MS {
                        row.state = RowState::Retired;
                        row.retired_reason = Some(RetiredReason::GcExpired);
                        row.updated_at = now_ms;
                        tracing::info!(
                            target: "freshell_ws::pane_ledger",
                            provider = %sref.provider,
                            session_id = %sref.session_id,
                            "pane_ledger_gc_tombstoned: bound row expired to tombstone (never deleted by timer)"
                        );
                        match self.write_binding(root, index, &row) {
                            Ok(()) => report.gc_tombstoned.push(sref),
                            Err(err) => {
                                // Fail loud, never silent: the row stays
                                // bound on disk; the next GC pass retries.
                                tracing::error!(
                                    target: "freshell_ws::pane_ledger",
                                    provider = %sref.provider,
                                    session_id = %sref.session_id,
                                    error = %err,
                                    "pane_ledger_gc_tombstone_failed: tombstone write failed; row left bound"
                                );
                            }
                        }
                    }
                }
                RowState::Retired => {
                    let old_enough = now_ms - row.updated_at > TOMBSTONE_GC_TTL_MS;
                    if old_enough && transcript_absent(&row.provider, &row.session_id) {
                        let path = Self::binding_path(root, &row.provider, &row.session_id);
                        match std::fs::remove_file(&path) {
                            Ok(()) => {
                                index
                                    .bindings
                                    .remove(&(row.provider.clone(), row.session_id.clone()));
                                tracing::info!(
                                    target: "freshell_ws::pane_ledger",
                                    provider = %sref.provider,
                                    session_id = %sref.session_id,
                                    "pane_ledger_tombstone_deleted: transcript gone (direct stat) and tombstone TTL elapsed"
                                );
                                report.tombstones_deleted.push(sref);
                            }
                            Err(err) => {
                                // Fail loud, never silent: the tombstone
                                // stays; the next GC pass retries naturally.
                                tracing::warn!(
                                    target: "freshell_ws::pane_ledger",
                                    provider = %sref.provider,
                                    session_id = %sref.session_id,
                                    error = %err,
                                    "pane_ledger_tombstone_delete_failed: tombstone file removal failed; will retry next pass"
                                );
                            }
                        }
                    }
                }
            }
        }
        report
    }

    fn quarantine_unparsable(&self, root: &Path, now_ms: i64, report: &mut BootScanReport) {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Ok(providers) = std::fs::read_dir(Self::bindings_dir(root)) {
            for provider in providers.flatten() {
                if let Ok(files) = std::fs::read_dir(provider.path()) {
                    candidates.extend(files.flatten().map(|f| f.path()));
                }
            }
        }
        if let Ok(files) = std::fs::read_dir(Self::pending_dir(root)) {
            candidates.extend(files.flatten().map(|f| f.path()));
        }
        for path in candidates {
            let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
            if name.contains(".tmp-") {
                // Orphan temp from a crashed write — reap with a WARN (the
                // `sweep_orphan_tmp` discipline).
                tracing::warn!(
                    target: "freshell_ws::pane_ledger",
                    path = %path.display(),
                    "pane_ledger_orphan_tmp_reaped"
                );
                let _ = std::fs::remove_file(&path);
                continue;
            }
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue; // prior quarantine residue
            }
            let error = match load_row::<serde_json::Value>(&path) {
                Err(e) => format!("{e}"),
                Ok(value) => {
                    let version = value.get("ledgerVersion").and_then(|v| v.as_u64());
                    if version == Some(u64::from(LEDGER_VERSION)) {
                        // Version ok — but does it parse as its row type?
                        let is_pending = path
                            .parent()
                            .map(|p| p.ends_with("pending"))
                            .unwrap_or(false);
                        let typed_ok = if is_pending {
                            serde_json::from_value::<PendingMarker>(value).is_ok()
                        } else {
                            serde_json::from_value::<BindingRow>(value).is_ok()
                        };
                        if typed_ok {
                            continue; // healthy
                        }
                        "row shape does not match its type".to_string()
                    } else {
                        format!("unsupported ledgerVersion {version:?} (gate: {LEDGER_VERSION})")
                    }
                }
            };
            let quarantined_path = path.with_file_name(format!("{name}.quarantined-{now_ms}"));
            match std::fs::rename(&path, &quarantined_path) {
                Ok(()) => {
                    tracing::error!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        quarantined = %quarantined_path.display(),
                        error = %error,
                        "pane_ledger_row_quarantined: unparsable row renamed aside (fail loud per-row, never per-store)"
                    );
                    report.quarantined.push(QuarantinedRow {
                        original_path: path,
                        quarantined_path,
                        error,
                    });
                }
                Err(rename_err) => {
                    // Fail loud, never silent: the bad row stays in place;
                    // the next boot scan retries the quarantine.
                    tracing::error!(
                        target: "freshell_ws::pane_ledger",
                        path = %path.display(),
                        quarantined = %quarantined_path.display(),
                        row_error = %error,
                        error = %rename_err,
                        "pane_ledger_quarantine_rename_failed: unparsable row left in place; will retry next boot"
                    );
                }
            }
        }
    }

    /// Rows quarantined by this process's boot scan — the Phase-3 verdict
    /// surfacing (`ledger_quarantined` breadcrumb) reads this.
    pub fn quarantined_rows(&self) -> Vec<QuarantinedRow> {
        self.quarantined
            .read()
            .unwrap_or_else(|p| p.into_inner())
            .clone()
    }
}

/// Path-segment encoding: `[A-Za-z0-9._-]` pass through, everything else
/// (including `%`) becomes `%XX` uppercase hex. Injective and containment-
/// safe (no `/`, and the `.`/`..` specials are fully escaped).
pub(crate) fn encode_segment(raw: &str) -> String {
    if raw.is_empty() {
        return "%00".to_string();
    }
    if raw == "." {
        return "%2E".to_string();
    }
    if raw == ".." {
        return "%2E%2E".to_string();
    }
    let mut out = String::with_capacity(raw.len());
    for b in raw.bytes() {
        match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'.' | b'_' | b'-' => out.push(b as char),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

#[derive(Debug)]
pub(crate) enum RowLoadError {
    Missing,
    Io(std::io::Error),
    Parse(String),
}

impl std::fmt::Display for RowLoadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            RowLoadError::Missing => write!(f, "missing"),
            RowLoadError::Io(e) => write!(f, "io: {e}"),
            RowLoadError::Parse(e) => write!(f, "parse: {e}"),
        }
    }
}

pub(crate) fn load_row<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, RowLoadError> {
    let bytes = match std::fs::read(path) {
        Ok(b) => b,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Err(RowLoadError::Missing),
        Err(e) => return Err(RowLoadError::Io(e)),
    };
    serde_json::from_slice(&bytes).map_err(|e| RowLoadError::Parse(e.to_string()))
}

/// One row, atomically: sibling temp (PID+millis unique, the `instance_id.rs`
/// idiom) + `atomic_write_durable` (write, fsync, rename, fsync parent).
pub(crate) fn write_row_atomic<T: Serialize>(dest: &Path, row: &T) -> std::io::Result<()> {
    let bytes = serde_json::to_vec_pretty(row)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let file_name = dest.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "row has no file name")
    })?;
    let parent = dest.parent().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::InvalidInput, "row has no parent")
    })?;
    std::fs::create_dir_all(parent)?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = parent.join(format!("{file_name}.tmp-{}-{millis}", std::process::id()));
    crate::tabs_persist::atomic_write_durable(dest, &tmp, &bytes)
}

#[cfg(test)]
#[path = "pane_ledger_tests.rs"]
mod tests;
