//! The index-backed [`SessionExistenceProbe`] (reconciliation-handshake
//! design §5.1): "does `provider:sessionId` exist on disk?" answered from the
//! SAME shared [`SessionIndex`] the History/session-directory surfaces read.
//!
//! Semantics (the design's defined contract):
//! * unknown provider → `Absent`, **never** `Unknown` (change #4c);
//! * known provider + no published snapshot (cold index) → `Unknown` — and a
//!   background `snapshot()` refresh is kicked so a re-query converges;
//! * known provider + published snapshot → `Present`/`Absent` from the
//!   snapshot; a STALE snapshot also kicks a background refresh, so a
//!   `provider:sessionId` written to disk after a cold read resolves
//!   `Present` on re-query — never a latched stale `Absent` (§9.1 test 13).
//!
//! `ever_observed` gates `dead_session` (§5.3 rows 4/4b): every snapshot read
//! feeds a monotone observed-set, so "disk has seen this identity at least
//! once (this boot)" survives the session later disappearing from disk.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use freshell_sessions::directory_index::SessionIndex;
use freshell_ws::existence::{SessionExistence, SessionExistenceProbe};

/// The disk-indexed providers of `main.rs`'s `SessionIndex` construction —
/// the "known provider" set of the probe contract.
const KNOWN_PROVIDERS: [&str; 4] = ["claude", "codex", "opencode", "amplifier"];

pub struct IndexExistenceProbe {
    index: Arc<SessionIndex>,
    /// `provider:sessionId` keys ever seen in ANY snapshot this boot.
    observed: Mutex<HashSet<String>>,
    /// P1.8 (spec §4.2 read 2): the durable "ever bound by this server"
    /// memory — survives restarts, so a transcript deleted while the server
    /// was down yields loud dead_session, not silent fresh.
    ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
    /// Each known provider's session root on THIS machine (the same paths
    /// `main.rs` hands the index sources). A known provider whose root does
    /// not exist will never warm up — the cold-index answer for it is
    /// `ProviderUnavailable`, not the deferrable `Unknown`. A provider with
    /// no entry keeps the plain `Unknown` cold answer.
    provider_roots: HashMap<String, PathBuf>,
}

impl IndexExistenceProbe {
    pub fn new(
        index: Arc<SessionIndex>,
        ledger: Option<Arc<freshell_ws::pane_ledger::PaneLedger>>,
        provider_roots: HashMap<String, PathBuf>,
    ) -> Self {
        Self {
            index,
            observed: Mutex::new(HashSet::new()),
            ledger,
            provider_roots,
        }
    }

    /// Kick a detached background refresh (never blocks the caller). No-op
    /// outside a tokio runtime — the WS handler always runs inside one.
    fn kick_refresh(&self) {
        if let Ok(handle) = tokio::runtime::Handle::try_current() {
            let index = Arc::clone(&self.index);
            handle.spawn(async move {
                let _ = index.snapshot().await;
            });
        }
    }

    fn record_observed(&self, items: &[freshell_sessions::directory_index::IndexedSession]) {
        let mut observed = self.observed.lock().expect("observed set lock");
        for item in items {
            observed.insert(item.key());
        }
    }
}

impl SessionExistenceProbe for IndexExistenceProbe {
    fn exists(&self, provider: &str, session_id: &str) -> SessionExistence {
        if !KNOWN_PROVIDERS.contains(&provider) {
            return SessionExistence::Absent;
        }
        // Keep the answer converging: any non-fresh state kicks a detached
        // refresh so a re-query (the client's reconnect-and-re-present loop)
        // eventually reads current disk truth.
        if !self.index.is_fresh() {
            self.kick_refresh();
        }
        match self.index.peek() {
            None => {
                // Cold index: a known provider whose session root does not
                // exist on this machine will NEVER warm up — that's an
                // immediate, honest provider_unavailable, not index_warming.
                if self
                    .provider_roots
                    .get(provider)
                    .is_some_and(|root| !root.exists())
                {
                    return SessionExistence::ProviderUnavailable;
                }
                SessionExistence::Unknown
            }
            Some(items) => {
                self.record_observed(&items);
                let hit = items
                    .iter()
                    .any(|s| s.provider == provider && s.session_id == session_id);
                if hit {
                    SessionExistence::Present
                } else {
                    SessionExistence::Absent
                }
            }
        }
    }

    fn ever_observed(&self, provider: &str, session_id: &str) -> bool {
        if self
            .observed
            .lock()
            .expect("observed set lock")
            .contains(&format!("{provider}:{session_id}"))
        {
            return true;
        }
        self.ledger
            .as_ref()
            .is_some_and(|ledger| ledger.ever_bound(provider, session_id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_sessions::directory_index::{ClaudeSource, SessionSource};
    use std::time::Duration;

    fn temp_claude_home(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "freshell-existence-{tag}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(dir.join("projects/proj")).expect("mkdir claude home");
        dir
    }

    fn write_session(claude_home: &std::path::Path, session_id: &str) {
        // Minimal claude transcript that passes the R10b cwd gate: one line
        // carrying `cwd` + timestamps; the file stem is the session id.
        let line = serde_json::json!({
            "type": "user",
            "message": "hello",
            "uuid": "msg-1",
            "cwd": "/tmp/proj",
            "timestamp": "2026-07-22T10:00:00.000Z"
        });
        std::fs::write(
            claude_home
                .join("projects/proj")
                .join(format!("{session_id}.jsonl")),
            format!("{line}\n"),
        )
        .expect("write session fixture");
    }

    fn probe_over(home: &std::path::Path) -> (IndexExistenceProbe, Arc<SessionIndex>) {
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(home.to_path_buf())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None, // no persistent parse-cache — fully isolated temp home
        ));
        (
            IndexExistenceProbe::new(
                Arc::clone(&index),
                None,
                HashMap::from([("claude".to_string(), home.to_path_buf())]),
            ),
            index,
        )
    }

    /// Construct a probe exactly as `main.rs` does — over an index whose
    /// provider home is an EMPTY temp dir (the transcript is gone) — with the
    /// given ledger handle. The home leaks intentionally: it's a per-test
    /// unique temp path and the OS temp cleaner owns it.
    fn new_test_probe_with_ledger(
        ledger: Option<std::sync::Arc<freshell_ws::pane_ledger::PaneLedger>>,
    ) -> IndexExistenceProbe {
        let home = temp_claude_home("with-ledger");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(home.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        IndexExistenceProbe::new(index, ledger, HashMap::from([("claude".to_string(), home)]))
    }

    #[test]
    fn ever_observed_survives_a_restart_via_the_ledger() {
        // Spec §4.2 read 2: a transcript deleted while the server was DOWN
        // must yield loud dead_session, not silent fresh. The per-boot
        // observed set is empty after a restart — the ledger is the durable
        // memory. (The Absent+ever_observed => dead_session derivation is
        // already pinned by reconcile.rs's
        // `row4_absent_but_ever_observed_yields_dead_session`; this test
        // covers the INPUT seam.)
        let dir = std::env::temp_dir().join(format!(
            "ledger-everobs-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let ledger =
            std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(dir.clone())));
        // "Generation 1" bound this identity durably.
        ledger
            .record_binding(&freshell_ws::pane_ledger::BindingWrite {
                provider: "claude",
                session_id: "11111111-2222-3333-4444-555555555555",
                terminal_id: "t1",
                mode: "claude",
                cwd: None,
                create_request_id: None,
                now_ms: 1_000,
            })
            .unwrap();

        // "Generation 2": a brand-new probe with an EMPTY observed set —
        // construct it exactly as main.rs does, over an index whose
        // provider home is an empty temp dir (the transcript is gone).
        let probe = new_test_probe_with_ledger(Some(std::sync::Arc::clone(&ledger)));
        assert!(
            probe.ever_observed("claude", "11111111-2222-3333-4444-555555555555"),
            "durable ledger memory answers across restarts"
        );
        assert!(!probe.ever_observed("claude", "99999999-2222-3333-4444-555555555555"));

        // Without a ledger, the old per-boot behavior is preserved.
        let bare = new_test_probe_with_ledger(None);
        assert!(!bare.ever_observed("claude", "11111111-2222-3333-4444-555555555555"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn unknown_provider_is_absent_never_unknown() {
        let home = temp_claude_home("unknown-provider");
        let (probe, _index) = probe_over(&home);
        assert_eq!(
            probe.exists("not-a-provider", "s1"),
            SessionExistence::Absent
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    #[tokio::test]
    async fn cold_index_is_unknown_for_known_provider() {
        let home = temp_claude_home("cold");
        let (probe, _index) = probe_over(&home);
        // Nothing published yet — honest Unknown, never a guessed Absent.
        assert_eq!(probe.exists("claude", "s-cold"), SessionExistence::Unknown);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// A known provider whose session root does NOT exist on this machine
    /// will never warm up — the probe answers `ProviderUnavailable`, not the
    /// deferrable `Unknown`.
    #[tokio::test]
    async fn missing_provider_root_is_provider_unavailable_not_unknown() {
        let home = temp_claude_home("root-missing");
        let gone = home.join("never-created-claude-root");
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(ClaudeSource::new(gone.clone())) as Arc<dyn SessionSource>],
            Duration::from_millis(50),
            None,
        ));
        let probe = IndexExistenceProbe::new(
            index,
            None,
            std::collections::HashMap::from([("claude".to_string(), gone)]),
        );
        assert_eq!(
            probe.exists("claude", "s-any"),
            SessionExistence::ProviderUnavailable
        );
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The counterpart boundary: the root EXISTS but the index is still cold
    /// → `Unknown` (warming), unchanged by the ProviderUnavailable check.
    #[tokio::test]
    async fn existing_but_cold_provider_root_stays_unknown() {
        let home = temp_claude_home("root-cold");
        let (probe, _index) = probe_over(&home);
        assert_eq!(probe.exists("claude", "s-cold"), SessionExistence::Unknown);
        let _ = std::fs::remove_dir_all(&home);
    }

    /// §9.1 test 13 — real-index staleness: a `provider:sessionId` written to
    /// disk AFTER a cold read must resolve `Present` on re-query; a stale
    /// `Absent` must never latch.
    #[tokio::test]
    async fn session_written_after_cold_read_resolves_present_on_requery() {
        let home = temp_claude_home("staleness");
        let (probe, index) = probe_over(&home);
        let session_id = "5f0c2a1e-9b7d-4c3a-8e21-0d9f6b4a7c11";

        // Cold read: Unknown (kicks a background refresh of the EMPTY home).
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Unknown
        );
        index.warm().await;
        // Warmed empty home: honestly Absent.
        assert_eq!(probe.exists("claude", session_id), SessionExistence::Absent);

        // The session appears on disk AFTER that Absent answer.
        write_session(&home, session_id);

        // Re-query until the stale-kicked refresh publishes it (bounded).
        let mut last = SessionExistence::Absent;
        for _ in 0..100u8 {
            last = probe.exists("claude", session_id);
            if last == SessionExistence::Present {
                break;
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        assert_eq!(
            last,
            SessionExistence::Present,
            "a re-query must converge to Present — no latched stale Absent"
        );
        assert!(probe.ever_observed("claude", session_id));
        let _ = std::fs::remove_dir_all(&home);
    }

    /// The observed-set is monotone: once seen on disk, an identity stays
    /// `ever_observed` even after its file disappears — exactly what gates
    /// `dead_session` vs `fresh(identity_never_observed)`.
    #[tokio::test]
    async fn ever_observed_survives_the_session_disappearing_from_disk() {
        let home = temp_claude_home("observed");
        let (probe, index) = probe_over(&home);
        let session_id = "7a1b3c5d-2e4f-4a6b-9c8d-1e2f3a4b5c6d";
        write_session(&home, session_id);
        index.warm().await;
        assert_eq!(
            probe.exists("claude", session_id),
            SessionExistence::Present
        );

        std::fs::remove_file(
            home.join("projects/proj")
                .join(format!("{session_id}.jsonl")),
        )
        .expect("delete session file");

        let mut last = SessionExistence::Present;
        for _ in 0..100u8 {
            last = probe.exists("claude", session_id);
            if last == SessionExistence::Absent {
                break;
            }
            tokio::time::sleep(Duration::from_millis(60)).await;
        }
        assert_eq!(last, SessionExistence::Absent);
        assert!(
            probe.ever_observed("claude", session_id),
            "the observed-set must remember identities disk has seen"
        );
        let _ = std::fs::remove_dir_all(&home);
    }
}
