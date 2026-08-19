//! Demand-driven amplifier subagent rescan cadence (amplifier watch
//! reduction design, lines 114-146).
//!
//! While ANY connected WS client has declared includeSubagents interest
//! (see `freshell_ws::subagent_interest`), a 15s heartbeat calls
//! `index.mark_provider_dirty("amplifier")` — an amplifier-only full
//! `discover` (refresh gate directory_index.rs:1688-1698) with
//! amplifier-only prune (:1845-1857) — NEVER the index-global TTL (a
//! `force_full` sweep would reconcile Claude/Codex/OpenCode every 15s,
//! :1343-1357) and NEVER a fetch-recency window (broadcast-driven clients
//! quiet-starve; the interest gate is per-connection, cleared on
//! disconnect — Task 8).
use std::sync::Arc;
use std::time::Duration;

use freshell_sessions::directory_index::SessionIndex;
use freshell_ws::subagent_interest::SubagentInterestRegistry;

/// Design cadence: 15s. Warm amplifier discover ≈ 0.65s warm (measured
/// 2026-08-18 on the 22,300-dir real corpus; supersedes the design's
/// ~0.3s estimate) — ~4.2% of a core while any interested client is
/// connected; zero while none.
pub const SUBAGENT_CADENCE_INTERVAL: Duration = Duration::from_secs(15);

pub fn spawn_subagent_cadence(
    index: Arc<SessionIndex>,
    interest: SubagentInterestRegistry,
    interval: Duration,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.tick().await; // consume the immediate first tick (main.rs cadence convention)
        loop {
            ticker.tick().await;
            if interest.any() {
                index.mark_provider_dirty("amplifier");
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use freshell_sessions::directory_index::{
        FileStat, IndexedSession, SessionIndex, SessionSource,
    };
    use freshell_ws::subagent_interest::SubagentInterestRegistry;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    async fn wait_until(timeout: Duration, mut predicate: impl FnMut() -> bool) -> bool {
        let start = std::time::Instant::now();
        loop {
            if predicate() {
                return true;
            }
            if start.elapsed() >= timeout {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Local in-crate counting double (mirror of directory_index.rs'
    /// CountingSource — private there). One fake item per source.
    struct CountingSource {
        name: &'static str,
        calls: Arc<AtomicUsize>,
    }

    impl SessionSource for CountingSource {
        fn discover(&self) -> Vec<FileStat> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            vec![FileStat {
                path: PathBuf::from(format!("mem://{}", self.name)),
                mtime_ms: 0,
                size: 0,
            }]
        }
        fn parse(&self, _path: &Path) -> Option<IndexedSession> {
            None
        }
        fn provider_name(&self) -> Option<&'static str> {
            Some(self.name)
        }
    }

    /// Regressions 2 / 12 / 15: while ANY connection is interested, the
    /// cadence marks amplifier and ONLY amplifier; through quiet periods; and
    /// stops when the last interest goes away.
    #[tokio::test]
    async fn cadence_marks_amplifier_only_while_interested_and_stops_when_last_interest_leaves() {
        let amp_calls = Arc::new(AtomicUsize::new(0));
        let claude_calls = Arc::new(AtomicUsize::new(0));
        let codex_calls = Arc::new(AtomicUsize::new(0));
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![
                Arc::new(CountingSource {
                    name: "amplifier",
                    calls: Arc::clone(&amp_calls),
                }) as Arc<dyn SessionSource>,
                Arc::new(CountingSource {
                    name: "claude",
                    calls: Arc::clone(&claude_calls),
                }) as Arc<dyn SessionSource>,
                Arc::new(CountingSource {
                    name: "codex",
                    calls: Arc::clone(&codex_calls),
                }) as Arc<dyn SessionSource>,
            ],
            Duration::from_secs(3600),
            None,
        ));
        let _ = index.snapshot().await; // seed all three providers (1 discover each)
        assert_eq!(amp_calls.load(Ordering::SeqCst), 1);
        assert_eq!(claude_calls.load(Ordering::SeqCst), 1);

        let interest = SubagentInterestRegistry::default();
        let handle = spawn_subagent_cadence(
            Arc::clone(&index),
            interest.clone(),
            Duration::from_millis(60), // fast test cadence
        );

        // No interest: nothing ticks.
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert_eq!(
            amp_calls.load(Ordering::SeqCst),
            1,
            "no interest ⇒ no marks"
        );

        // Interested: cadence ticks amplifier only — and keeps ticking through
        // quiet periods with NO further fetch traffic (connected-client
        // gating, regression 15's quiet-period clause).
        interest.set(7, true);
        assert!(
            wait_until(Duration::from_secs(2), || amp_calls.load(Ordering::SeqCst)
                >= 4)
            .await,
            "≥3 cadence ticks mark amplifier"
        );
        assert_eq!(
            claude_calls.load(Ordering::SeqCst),
            1,
            "claude untouched (regression 12)"
        );
        assert_eq!(codex_calls.load(Ordering::SeqCst), 1, "codex untouched");
        // NOTE (regression 12 precision): opencode's cheap change-token read
        // still runs per scoped sweep (directory_index.rs:1625-1630) — by
        // design — but its discover/direct_list is NOT re-armed. Not pinned
        // here (no opencode source in this index).
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert!(
            amp_calls.load(Ordering::SeqCst) >= 5,
            "ticks continue through quiet periods ({} ≥ 5)",
            amp_calls.load(Ordering::SeqCst)
        );

        // Second connection joins, first leaves: still armed (regression 15
        // middle clause).
        interest.set(9, true);
        interest.remove(7);
        let keep = amp_calls.load(Ordering::SeqCst);
        assert!(
            wait_until(Duration::from_secs(2), || amp_calls.load(Ordering::SeqCst)
                > keep)
            .await,
            "one remaining interest keeps the cadence live"
        );

        // Last disconnect: the cadence stops (regressions 2/15 ending clause).
        interest.remove(9);
        let stop_at = amp_calls.load(Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(400)).await;
        assert_eq!(
            amp_calls.load(Ordering::SeqCst),
            stop_at,
            "no interested connection ⇒ no marks"
        );

        handle.abort();
    }
}
