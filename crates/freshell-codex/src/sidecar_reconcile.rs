//! Boot-time **sidecar reconciler** — loads the durable
//! `rust-codex-sidecars` records a previous server generation left behind
//! ([`crate::sidecar_store`]), prunes rows whose identity evidence no longer
//! matches live `/proc` (Dead / Mismatch — remove only, NEVER signal), and
//! holds the survivors as one-shot claimable by codex session id for
//! restore-time reattach (katas ynfn/da92; the adopt/sweep sides land in
//! Tasks 6–9).
//!
//! Every prune/claim decision emits structured tracing with the ownership id
//! and identity verdict — auditability is half the invariant.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

use crate::protocol::{build_request_frame, parse_incoming_frame, IncomingMessage, RequestId};
use crate::sidecar_store::{
    verify_sidecar_identity, CodexSidecarRecord, CodexSidecarStore, IdentityVerdict,
};

/// Per-candidate budget for the duplicate-arm writer probe (connect + one
/// `thread/loaded/list` round trip). Bounded so a wedged survivor cannot
/// stall a restore; on timeout the candidate is simply NOT the writer.
const WRITER_PROBE_BUDGET: Duration = Duration::from_millis(1000);

/// Boot-log summary returned by [`SidecarReconciler::boot_reconcile`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BootReconcileReport {
    /// Healthy rows loaded from the store (corrupt rows were quarantined by
    /// `load_all`, not counted here).
    pub loaded: usize,
    /// Dead-verdict rows removed (stale records of exited sidecars).
    pub pruned_dead: usize,
    /// Mismatch-verdict rows removed (pid reuse — the pid is NOT ours; the
    /// row is dropped and the process is NEVER signalled).
    pub pruned_mismatch: usize,
    /// Rows held for claim/sweep (Verified + Unverifiable).
    pub held: usize,
}

/// The boot reconciler: holds every surviving record until a restore claims
/// it (by session id) or the sweep (Task 9) disposes of it.
pub struct SidecarReconciler {
    store: Arc<CodexSidecarStore>,
    /// ALL held records, keyed by ownership_id — NOT by session id. Two live
    /// records can legitimately share a session id (a mid-turn survivor
    /// retained at sweep + a later fresh spawn enriched with the same session;
    /// validated reachable — reports/V3.md), and Verified-without-session /
    /// Unverifiable records must also be held for the sweep. Keying by
    /// session_id would silently drop records (a fifth-fate ynfn violation).
    held: Mutex<HashMap<String /*ownership_id*/, CodexSidecarRecord>>,
    /// Secondary index for restore-time claims.
    by_session: Mutex<HashMap<String /*session_id*/, Vec<String /*ownership_id*/>>>,
}

/// Outcome of the sync (lock-holding) phase of a claim. The `Claimed` record
/// is boxed to keep the enum small (clippy `large_enum_variant`).
enum FastClaim {
    /// No claimable candidate for this session.
    Empty,
    /// Exactly one verified candidate — claimed under the locks, no probe.
    Claimed(Box<CodexSidecarRecord>),
    /// Two or more verified candidates, snapshotted OUT of the locks for the
    /// async writer probe.
    Duplicates(Vec<CodexSidecarRecord>),
}

impl SidecarReconciler {
    /// Boot: load_all(); prune records whose identity verdict is Dead
    /// (remove) or Mismatch (remove — the pid is NOT ours, never signal);
    /// hold every remaining record by ownership_id (Verified with session =
    /// claimable via the index; Verified without session and Unverifiable =
    /// held for the sweep only). Returns a summary for boot logs.
    pub fn boot_reconcile(store: Arc<CodexSidecarStore>) -> (Self, BootReconcileReport) {
        let records = store.load_all();
        let loaded = records.len();
        let mut pruned_dead = 0;
        let mut pruned_mismatch = 0;
        let mut held: HashMap<String, CodexSidecarRecord> = HashMap::new();
        let mut by_session: HashMap<String, Vec<String>> = HashMap::new();

        for record in records {
            let verdict = verify_sidecar_identity(&record);
            match verdict {
                IdentityVerdict::Dead => {
                    pruned_dead += 1;
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        verdict = ?verdict,
                        "sidecar_record_pruned: recorded sidecar exited; stale row removed"
                    );
                    remove_pruned(&store, &record.ownership_id);
                }
                IdentityVerdict::Mismatch => {
                    pruned_mismatch += 1;
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        verdict = ?verdict,
                        "sidecar_record_pruned: pid reuse — the pid is NOT ours; \
                         row removed, process NEVER signalled"
                    );
                    remove_pruned(&store, &record.ownership_id);
                }
                IdentityVerdict::Verified | IdentityVerdict::Unverifiable => {
                    // Verified with a session id is claimable via the index;
                    // Verified without one and Unverifiable are held for the
                    // sweep only.
                    let claimable =
                        verdict == IdentityVerdict::Verified && record.session_id.is_some();
                    if claimable {
                        by_session
                            .entry(record.session_id.clone().expect("claimable has a session"))
                            .or_default()
                            .push(record.ownership_id.clone());
                    }
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %record.ownership_id,
                        verdict = ?verdict,
                        session_id = record.session_id.as_deref().unwrap_or("<none>"),
                        claimable,
                        "sidecar_record_held: survivor held for claim/sweep"
                    );
                    held.insert(record.ownership_id.clone(), record);
                }
            }
        }

        let report = BootReconcileReport {
            loaded,
            pruned_dead,
            pruned_mismatch,
            held: held.len(),
        };
        (
            Self {
                store,
                held: Mutex::new(held),
                by_session: Mutex::new(by_session),
            },
            report,
        )
    }

    /// Restore-time claim: re-verify identity at claim time and return ONE
    /// record for this session. With duplicates, pick the WRITER: prefer the
    /// candidate whose live sidecar reports this session in
    /// thread/loaded/list (a bounded ws probe — duplicate arm only, ~1s per
    /// candidate), else newest updated_at. Losers
    /// STAY held (they keep their sweep fate — never silently dropped).
    /// Retained-state records ARE claimable (re-verified; adopt flips them
    /// back to Active) — a late restore after the sweep must still reattach
    /// a mid-turn survivor instead of reproducing the -32600 (reports/V3.md).
    /// Only the returned record leaves `held`; each record is claimable ONCE.
    /// ASYNC because of the writer probe (Task 7's factory is async-aware and
    /// awaits this): the 0/1-candidate fast path opens no connection; the
    /// duplicate arm snapshots candidates OUT of the `held`/`by_session`
    /// locks before any await (std Mutex guards must never be held across an
    /// await point — clippy `await_holding_lock`).
    /// After the probe await, the winner is claimed by re-acquiring the
    /// locks and removing it from `held`/`by_session` ONLY if still present;
    /// a candidate the sweep consumed during the await is skipped (fall
    /// through to the remaining candidates, else None). Membership in
    /// `held` is the single source of truth for claim-vs-sweep ownership —
    /// every exit from `held` happens under its lock (Task 9's sweep
    /// TOCTOU guard is the mirror of this rule).
    pub async fn claim_for_session(&self, session_id: &str) -> Option<CodexSidecarRecord> {
        let candidates = match self.verify_and_fast_claim(session_id) {
            FastClaim::Empty => return None,
            FastClaim::Claimed(record) => return Some(*record),
            FastClaim::Duplicates(candidates) => candidates,
        };

        // Duplicate arm — NO locks held across these awaits.
        let mut ranked: Vec<(bool, CodexSidecarRecord)> = Vec::with_capacity(candidates.len());
        for record in candidates {
            let is_writer = writer_probe(&record.ws_url, session_id).await;
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %record.ownership_id,
                session_id,
                is_writer,
                "sidecar_claim_probe: duplicate-arm writer probe result"
            );
            ranked.push((is_writer, record));
        }
        // Writers first, then newest updated_at; ownership_id is a
        // deterministic final tiebreak.
        ranked.sort_by(|a, b| {
            b.0.cmp(&a.0)
                .then(b.1.updated_at.cmp(&a.1.updated_at))
                .then(a.1.ownership_id.cmp(&b.1.ownership_id))
        });

        self.claim_first_still_held(session_id, &ranked)
    }

    /// Records still held (unclaimed) — the sweep's future workload.
    pub fn unclaimed_len(&self) -> usize {
        self.held.lock().unwrap().len()
    }

    /// Sync phase of a claim (all lock work, no awaits): re-verify every
    /// indexed candidate, prune Dead/Mismatch rows (store + held), skip
    /// Unverifiable ones (held for the sweep), and either claim a single
    /// verified candidate outright or snapshot the duplicates for the probe.
    fn verify_and_fast_claim(&self, session_id: &str) -> FastClaim {
        let mut held = self.held.lock().unwrap();
        let mut by_session = self.by_session.lock().unwrap();
        let Some(indexed_ids) = by_session.get(session_id).cloned() else {
            return FastClaim::Empty;
        };

        let mut retained_ids: Vec<String> = Vec::new();
        let mut candidates: Vec<CodexSidecarRecord> = Vec::new();
        for ownership_id in indexed_ids {
            let Some(record) = held.get(&ownership_id) else {
                // Consumed by an earlier claim or the sweep — membership in
                // `held` is the single source of truth; drop the stale index
                // entry.
                continue;
            };
            let verdict = verify_sidecar_identity(record);
            match verdict {
                IdentityVerdict::Verified => {
                    candidates.push(record.clone());
                    retained_ids.push(ownership_id);
                }
                IdentityVerdict::Dead => {
                    tracing::info!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %ownership_id,
                        verdict = ?verdict,
                        session_id,
                        "sidecar_claim_pruned: candidate died since boot; row removed"
                    );
                    remove_pruned(&self.store, &ownership_id);
                    held.remove(&ownership_id);
                }
                IdentityVerdict::Mismatch => {
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %ownership_id,
                        verdict = ?verdict,
                        session_id,
                        "sidecar_claim_pruned: pid reuse since boot — the pid is NOT \
                         ours; row removed, process NEVER signalled"
                    );
                    remove_pruned(&self.store, &ownership_id);
                    held.remove(&ownership_id);
                }
                IdentityVerdict::Unverifiable => {
                    // Not provably ours ⇒ not claimable; not provably stale
                    // ⇒ stays held for the sweep (never silently dropped).
                    tracing::warn!(
                        target: "freshell_codex::sidecar_reconcile",
                        ownership_id = %ownership_id,
                        verdict = ?verdict,
                        session_id,
                        "sidecar_claim_skipped: identity unverifiable at claim time; \
                         record stays held for the sweep"
                    );
                    retained_ids.push(ownership_id);
                }
            }
        }

        if candidates.len() == 1 {
            let claimed = candidates.remove(0);
            held.remove(&claimed.ownership_id);
            retained_ids.retain(|id| id != &claimed.ownership_id);
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %claimed.ownership_id,
                verdict = ?IdentityVerdict::Verified,
                session_id,
                decided_by = "single_candidate",
                "sidecar_record_claimed: sole verified candidate claimed (no probe)"
            );
            rewrite_index(&mut by_session, session_id, retained_ids);
            return FastClaim::Claimed(Box::new(claimed));
        }

        rewrite_index(&mut by_session, session_id, retained_ids);
        if candidates.is_empty() {
            FastClaim::Empty
        } else {
            FastClaim::Duplicates(candidates)
        }
    }

    /// Post-probe phase (locks re-acquired, no awaits): claim the first
    /// ranked candidate still present in `held`; skip candidates consumed
    /// during the probe await.
    fn claim_first_still_held(
        &self,
        session_id: &str,
        ranked: &[(bool, CodexSidecarRecord)],
    ) -> Option<CodexSidecarRecord> {
        let mut held = self.held.lock().unwrap();
        let mut by_session = self.by_session.lock().unwrap();
        for (is_writer, candidate) in ranked {
            let Some(record) = held.remove(&candidate.ownership_id) else {
                tracing::info!(
                    target: "freshell_codex::sidecar_reconcile",
                    ownership_id = %candidate.ownership_id,
                    session_id,
                    "sidecar_claim_candidate_consumed: candidate left `held` during \
                     the probe await; skipped"
                );
                continue;
            };
            if let Some(ids) = by_session.get_mut(session_id) {
                ids.retain(|id| id != &record.ownership_id);
                if ids.is_empty() {
                    by_session.remove(session_id);
                }
            }
            tracing::info!(
                target: "freshell_codex::sidecar_reconcile",
                ownership_id = %record.ownership_id,
                verdict = ?IdentityVerdict::Verified,
                session_id,
                decided_by = if *is_writer { "writer_probe" } else { "updated_at_fallback" },
                "sidecar_record_claimed: duplicate-arm winner claimed; losers stay held"
            );
            return Some(record);
        }
        None
    }
}

/// Remove a pruned row from the store; a removal failure is logged loudly
/// (the row will be re-pruned next boot) and never fails the reconcile.
fn remove_pruned(store: &CodexSidecarStore, ownership_id: &str) {
    if let Err(error) = store.remove(ownership_id) {
        tracing::error!(
            target: "freshell_codex::sidecar_reconcile",
            ownership_id = %ownership_id,
            error = %error,
            "sidecar_record_prune_remove_failed: row removal failed; retried next boot"
        );
    }
}

/// Rewrite (or drop, when empty) a session's index entry.
fn rewrite_index(
    by_session: &mut HashMap<String, Vec<String>>,
    session_id: &str,
    retained_ids: Vec<String>,
) {
    if retained_ids.is_empty() {
        by_session.remove(session_id);
    } else {
        by_session.insert(session_id.to_string(), retained_ids);
    }
}

/// Bounded writer probe (duplicate arm only): does the candidate's live
/// sidecar report `session_id` in `thread/loaded/list`? Connect to the
/// record's ws_url, send one JSON-RPC request, and scan frames for the
/// response — all under a single [`WRITER_PROBE_BUDGET`]. Any error/timeout
/// ⇒ NOT the writer (the newest-`updated_at` fallback decides). The positive
/// arm is exercised by Task 9's fixture-backed tests; this module's own
/// tests use `sleep` children that speak no ws, so the probe fails fast.
async fn writer_probe(ws_url: &str, session_id: &str) -> bool {
    tokio::time::timeout(WRITER_PROBE_BUDGET, writer_probe_inner(ws_url, session_id))
        .await
        .unwrap_or(false)
}

async fn writer_probe_inner(ws_url: &str, session_id: &str) -> bool {
    let Ok((stream, _response)) = tokio_tungstenite::connect_async(ws_url).await else {
        return false;
    };
    let (mut write, mut read) = stream.split();
    let request_id = RequestId::Int(1);
    let frame = build_request_frame(&request_id, "thread/loaded/list", &serde_json::json!({}));
    if write.send(Message::Text(frame)).await.is_err() {
        return false;
    }
    while let Some(frame) = read.next().await {
        let Ok(message) = frame else {
            return false;
        };
        let text = match message {
            Message::Text(text) => text,
            // Tolerate a binary frame as UTF-8 (transport.rs parity).
            Message::Binary(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            // Ping/Pong/Frame are transport-level noise — keep reading.
            _ => continue,
        };
        match parse_incoming_frame(&text) {
            Some(IncomingMessage::Response { id, result }) if id == request_id => {
                return loaded_list_contains(&result, session_id);
            }
            Some(IncomingMessage::RpcError { id, .. }) if id == request_id => {
                return false;
            }
            // Notifications / unrelated frames — keep scanning for our id.
            _ => continue,
        }
    }
    false
}

/// `thread/loaded/list` result shape: `{ data: string[], nextCursor? }`
/// (contract-foundation plan §thread/loaded/list; the committed fixture
/// returns `{ data: behavior.loadedThreadIds }`, fake-app-server.mjs:263).
fn loaded_list_contains(result: &serde_json::Value, session_id: &str) -> bool {
    result
        .get("data")
        .and_then(|data| data.as_array())
        .is_some_and(|ids| ids.iter().any(|id| id.as_str() == Some(session_id)))
}

// ---------------------------------------------------------------------------
// Process-global reconciler handle (wired at server boot in Task 10). A
// re-settable RwLock seam, mirroring `sidecar_store`'s store global.
// ---------------------------------------------------------------------------

static GLOBAL_SIDECAR_RECONCILER: RwLock<Option<Arc<SidecarReconciler>>> = RwLock::new(None);

/// Install the process-wide reconciler (server boot, after
/// [`SidecarReconciler::boot_reconcile`]). Later calls replace the handle.
pub fn set_codex_sidecar_reconciler(r: Arc<SidecarReconciler>) {
    *GLOBAL_SIDECAR_RECONCILER.write().unwrap() = Some(r);
}

/// The installed process-wide reconciler, if any. `None` (nothing installed)
/// means restore-time callers have nothing to claim from — behavior identical
/// to the pre-reconciler world.
pub fn codex_sidecar_reconciler() -> Option<Arc<SidecarReconciler>> {
    GLOBAL_SIDECAR_RECONCILER.read().unwrap().clone()
}

#[cfg(test)]
#[path = "sidecar_reconcile_tests.rs"]
mod tests;
