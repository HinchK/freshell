//! Server-side implementation of the fresh-agent identity bridge (P1.13):
//! freshell-freshagent cannot see the ledger (crate cycle), so main.rs
//! injects this adapter at wiring time.

use freshell_freshagent::{
    FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink, RollbackRecord, SinkWrite,
    ROLLBACK_RECORD_VERSION,
};
use freshell_ws::pane_ledger::{FreshAgentBindingWrite, PaneLedger};
use std::sync::Arc;

pub struct LedgerIdentitySink {
    ledger: Arc<PaneLedger>,
}

impl LedgerIdentitySink {
    pub fn new(ledger: Arc<PaneLedger>) -> Self {
        Self { ledger }
    }
}

fn now_ms() -> i64 {
    // Match the timestamp convention main.rs already uses for ledger writes
    // (see the boot-scan / record_binding call sites in main.rs).
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl PaneIdentitySink for LedgerIdentitySink {
    // Writes are AWAITED spawn_blocking (durable-before-answer, V8/A11) —
    // exactly the shape terminal.rs:1589 already ships. Timestamps are taken
    // at EVENT time (before the hop), so `updated_at` reflects event order
    // (V8's out-of-order aggravator).
    fn record_pending(&self, placeholder_id: &str, mode: &str, cwd: Option<&str>) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, m, c) = (
            placeholder_id.to_string(),
            mode.to_string(),
            cwd.map(str::to_string),
        );
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || ledger.record_pending(&p, &m, c.as_deref(), now))
                .await
                .map_err(std::io::Error::other)? // JoinError (incl. closure panic) surfaces as Err
        })
    }

    fn record_binding(&self, upsert: FreshAgentBindingUpsert) -> SinkWrite {
        let ledger = self.ledger.clone();
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let w = FreshAgentBindingWrite {
                    provider: &upsert.provider,
                    session_id: &upsert.session_id,
                    mode: &upsert.mode,
                    cwd: upsert.settings.cwd.as_deref(),
                    create_request_id: upsert.create_request_id.as_deref(),
                    model: upsert.settings.model.as_deref(),
                    sandbox: upsert.settings.sandbox.as_deref(),
                    permission_mode: upsert.settings.permission_mode.as_deref(),
                    effort: upsert.settings.effort.as_deref(),
                    supersedes: upsert.supersedes.as_deref(),
                    now_ms: now,
                };
                ledger.record_fresh_agent_binding(&w)?; // binding-write failure propagates
                if let Some(p) = upsert.resolves_pending.as_deref() {
                    // Cosmetic on failure: an orphaned marker is TTL-swept at 30d
                    // (V6/A15) — warn, do not fail the identity event over it.
                    if let Err(e) = ledger.delete_pending(p) {
                        tracing::warn!(error = %e, placeholder = %p, "pane_ledger.fresh_agent.pending_delete_failed");
                    }
                }
                Ok(())
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    fn load_settings(&self, provider: &str, session_id: &str) -> Option<FreshAgentSettings> {
        // Reads are memory-only against the write-through index — safe inline.
        let row = self.ledger.load_binding(provider, session_id)?;
        // Terminal-lineage rows (wave-A codex_candidate etc.) are NOT resume
        // records — only fresh-agent rows serve settings (V7/A10 gating).
        if row.pane_kind.as_deref() != Some("fresh-agent") {
            return None;
        }
        let s = FreshAgentSettings {
            model: row.model,
            sandbox: row.sandbox,
            permission_mode: row.permission_mode,
            effort: row.effort,
            cwd: row.cwd,
        };
        // A fully blank snapshot is "nothing recoverable" (real creates always
        // carry at least cwd): None here + was_recorded()==true is exactly the
        // SETTINGS_RESET alarm condition (V7/A10).
        if s == FreshAgentSettings::default() {
            return None;
        }
        Some(s)
    }

    fn was_recorded(&self, provider: &str, session_id: &str) -> bool {
        // State-agnostic (load_binding serves Retired/GcExpired rows too, V6/A9).
        self.ledger
            .load_binding(provider, session_id)
            .map(|r| r.pane_kind.as_deref() == Some("fresh-agent"))
            .unwrap_or(false)
    }

    /// kata 1wxv: await the rollback-record row write BEFORE the provider
    /// mutation runs (durable-BEFORE-mutation; a pre-write failure refuses
    /// the rollback with `LEDGER_WRITE_REFUSAL_COPY`).
    fn record_rollback(
        &self,
        provider: &str,
        session_id: &str,
        record: RollbackRecord,
    ) -> SinkWrite {
        let ledger = self.ledger.clone();
        let (p, s) = (provider.to_string(), session_id.to_string());
        let now = now_ms();
        Box::pin(async move {
            tokio::task::spawn_blocking(move || {
                let payload = serde_json::to_value(&record).map_err(std::io::Error::other)?;
                ledger.record_rollback_row(&p, &s, &payload, now)
            })
            .await
            .map_err(std::io::Error::other)?
        })
    }

    fn load_rollback(&self, provider: &str, session_id: &str) -> Option<RollbackRecord> {
        // Reads are memory-only against the write-through index — safe inline.
        // The ledger is payload-opaque; the schema (and its version gate: a
        // mismatched version reads as None, never reinterpreted) lives here.
        let payload = self.ledger.load_rollback_row(provider, session_id)?;
        let record: RollbackRecord = serde_json::from_value(payload).ok()?;
        if record.version == ROLLBACK_RECORD_VERSION {
            Some(record)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use freshell_freshagent::{FreshAgentBindingUpsert, FreshAgentSettings, PaneIdentitySink};
    use std::sync::Arc;

    #[tokio::test(flavor = "multi_thread")]
    async fn writes_through_to_ledger_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger.clone());
        sink.record_binding(FreshAgentBindingUpsert {
            provider: "codex".into(),
            session_id: "t1".into(),
            mode: "freshcodex".into(),
            create_request_id: None,
            resolves_pending: None,
            supersedes: None,
            settings: FreshAgentSettings {
                model: Some("gpt-5.3-codex-spark".into()),
                sandbox: Some("workspace-write".into()),
                permission_mode: Some("on-request".into()),
                effort: None,
                cwd: Some("/w".into()),
            },
        })
        .await
        .expect("awaited write succeeds");
        // Awaited write => durable and readable IMMEDIATELY, no polling.
        let s = sink
            .load_settings("codex", "t1")
            .expect("binding visible after await");
        assert_eq!(s.model.as_deref(), Some("gpt-5.3-codex-spark"));
        assert_eq!(s.sandbox.as_deref(), Some("workspace-write"));
        assert!(sink.was_recorded("codex", "t1"));
        assert!(!sink.was_recorded("codex", "nope"));
        let row = ledger.load_binding("codex", "t1").unwrap();
        assert_eq!(row.pane_kind.as_deref(), Some("fresh-agent"));
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn rollback_record_writes_through_and_reads_back() {
        let tmp = tempfile::tempdir().unwrap();
        let ledger = std::sync::Arc::new(freshell_ws::pane_ledger::PaneLedger::new(Some(
            tmp.path().to_path_buf(),
        )));
        let sink = LedgerIdentitySink::new(ledger);
        let mut record = freshell_freshagent::RollbackRecord::empty(100);
        record.push_entry(
            freshell_freshagent::RollbackEntry {
                removed_turns: vec![serde_json::json!({"id": "t1", "turnId": "t1"})],
                prompt_text: "second prompt".into(),
                at_ms: 101,
            },
            102,
        );
        sink.record_rollback("codex", "thr-1", record.clone())
            .await
            .expect("awaited write");
        assert_eq!(
            sink.load_rollback("codex", "thr-1"),
            Some(record),
            "awaited write => readable immediately"
        );
        // A fresh ledger over the same root sees the row (durable, not just memory):
        let ledger2 = freshell_ws::pane_ledger::PaneLedger::new(Some(tmp.path().to_path_buf()));
        assert!(
            ledger2.load_rollback_row("codex", "thr-1").is_some(),
            "boot scan indexes rollback rows"
        );
    }
}
