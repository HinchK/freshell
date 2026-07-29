//! Claude SessionStart signal watcher + mid-session rebind (P4).
//!
//! Task 11's launch wiring injects a `SessionStart` hook into every claude
//! terminal-pane launch that writes the hook's stdin JSON atomically to
//! `$HOME/.freshell/session-signals/claude/<FRESHELL_TERMINAL_ID>__<nonce>.json`.
//! This module is the consumer: a periodic sweep drains those signal files and
//! moves a live claude pane's identity when the CLI reports a NEW session id
//! mid-session (in-TUI `/resume`, `/clear`, ...), so a later restore resumes
//! the id the user actually ended on -- deterministic (the CLI itself reports
//! the id), no heuristic coordinator port.
//!
//! Deliberate design: NO new `WsState` field -- the watcher is owned by the
//! sweep task (every integration test constructs `WsState` as an exhaustive
//! literal; a new field would touch ~27 test files for nothing).

use std::path::{Path, PathBuf};

use crate::terminal::now_ms;
use crate::WsState;

/// Sweep cadence -- mirrors the locator sweeps' ~1s-order polling shape
/// (`spawn_codex_locator_sweep`); signal files are rare (one per SessionStart
/// event) so 1s is comfortably fresh and comfortably cheap.
const CLAUDE_SIGNAL_SWEEP_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// Drains `*.json` signal files from one directory. Owned by the sweep task
/// (or a test) -- deliberately not stored in `WsState`. `Clone` (a bare
/// `PathBuf`) so the sweep can hand a copy to `spawn_blocking`.
#[derive(Clone)]
pub struct ClaudeSignalWatcher {
    root: PathBuf,
}

/// One parsed SessionStart signal: which pane reported which session id.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaudeSignal {
    pub terminal_id: String,
    pub session_id: String,
    /// SessionStart's `source` field: "startup" | "resume" | "clear" | ...
    pub source: Option<String>,
}

impl ClaudeSignalWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// The root Task 11's hook command writes into:
    /// `$HOME/.freshell/session-signals/claude` (`%USERPROFILE%` on Windows).
    /// `None` when the home env var is unresolvable -- the boot wiring skips
    /// the sweep in that case (mirrors `codex_sessions_root`'s convention).
    pub fn default_root() -> Option<PathBuf> {
        #[cfg(windows)]
        let base = std::env::var("USERPROFILE").ok()?;
        #[cfg(not(windows))]
        let base = std::env::var("HOME").ok()?;
        if base.is_empty() {
            return None;
        }
        Some(
            PathBuf::from(base)
                .join(".freshell")
                .join("session-signals")
                .join("claude"),
        )
    }

    /// Read+parse+DELETE every `*.json` in the root. Filename:
    /// `<terminal_id>__<nonce>.json` -- the terminal id is recovered by
    /// splitting the stem on the LAST `__` (`rsplit_once`): the nonce
    /// (`<pid>-<ns>` digits and `-`) can never contain `__`, so a LAST-split
    /// always recovers the full terminal id even if an id ever contained
    /// `__`. Malformed files are deleted and skipped (a signal is
    /// single-shot; leaving junk behind would re-fail every sweep forever).
    /// In-flight `*.tmp` files (the hook's atomic write staging) are left
    /// alone.
    /// drain() sorts by filename (timestamp-first nonces => deterministic last-write-wins under rapid A->B->A switching on nanosecond-precision date; the second-granularity fallback degrades same-second order to pid order).
    pub fn drain(&self) -> Vec<ClaudeSignal> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new(); // no dir yet: no claude pane has ever signaled
        };
        let mut paths: Vec<std::path::PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        // Deterministic last-write-wins (mirrors opencode_signal.rs): the
        // producer nonce is timestamp-first and width-stable, so a filename
        // sort is emission order on nanosecond-precision `date` (GNU; on the
        // second-granularity fallback, same-second order degrades to pid
        // order -- see the producer's doc comment); the consumer applies
        // signals in sequence, so the newest signal per terminal wins.
        paths.sort();
        let mut signals = Vec::new();
        for path in paths {
            if let Some(sig) = parse_signal_file(&path) {
                signals.push(sig);
            }
            let _ = std::fs::remove_file(&path);
        }
        signals
    }
}

/// Parse one signal file: terminal id from the filename stem (LAST `__`),
/// `session_id` (required non-empty) + `source` from the JSON body.
fn parse_signal_file(path: &Path) -> Option<ClaudeSignal> {
    let stem = path.file_stem()?.to_str()?;
    let (terminal_id, _nonce) = stem.rsplit_once("__")?;
    if terminal_id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let body: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let session_id = body.get("session_id")?.as_str()?;
    if session_id.is_empty() {
        return None;
    }
    Some(ClaudeSignal {
        terminal_id: terminal_id.to_string(),
        session_id: session_id.to_string(),
        source: body
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

/// Sweep body: drain signals; for each, no-op if the id matches the pane's
/// current claude identity; otherwise guarded rebind (same guard set as the
/// codex fork rebind, same pinned side-effect order as the codex tail).
///
/// `pub` (not `pub(crate)`): the integration test
/// (`tests/claude_session_rebind.rs`) drives drains directly for determinism
/// instead of racing a spawned sweep timer.
pub async fn drain_and_rebind_claude(state: &WsState, watcher: &ClaudeSignalWatcher) {
    // `drain()` is synchronous fs I/O (read_dir + read + remove per signal
    // file); run it on the blocking pool like the codex locator lanes
    // (30a34360) instead of on the async runtime inside the 1s sweep.
    // `drain()` itself stays synchronous -- only the call site moves.
    let drain_watcher = watcher.clone();
    let signals = match tokio::task::spawn_blocking(move || drain_watcher.drain()).await {
        Ok(signals) => signals,
        Err(join_error) => {
            tracing::warn!(
                error = %join_error,
                "claude_signal_drain_panicked: blocking drain task panicked, skipping this cycle"
            );
            return;
        }
    };
    for sig in signals {
        // Registry row: must be a live claude pane.
        let Some(current) = state.identity.get(&sig.terminal_id) else {
            continue;
        };
        if current.retired || current.provider.as_deref() != Some("claude") {
            continue;
        }
        if current.session_id.as_deref() == Some(sig.session_id.as_str()) {
            // Load-bearing no-op (A7): SessionStart also fires on `startup`
            // and on EVERY compaction (`compact`) with session_id == bound
            // id -- one signal file per compaction. Same-id signals must
            // stay silent no-ops; keep this guard.
            continue;
        }
        // A13: the claimed id must have no live owner.
        if let Some(owner) =
            state
                .registry
                .live_session_owner(Some(&state.identity), "claude", &sig.session_id)
        {
            tracing::warn!(terminal_id = %sig.terminal_id, owner = %owner,
                "claude_rebind_refused: target session already live-owned (A13)");
            continue;
        }
        // Ledger A8 (retired-inclusive) + freshclaude guard, mirroring codex
        // Guard A/C semantics.
        if let Some(existing) = state
            .identity
            .find_by_session_including_retired("claude", &sig.session_id)
        {
            if existing != sig.terminal_id {
                tracing::warn!(terminal_id = %sig.terminal_id,
                    "claude_rebind_refused: session_bound_elsewhere");
                continue;
            }
        }
        if state
            .pane_ledger
            .lookup_by_session("claude", &sig.session_id)
            .is_some_and(|r| r.row.pane_kind.as_deref() == Some("fresh-agent"))
        {
            continue;
        }
        let previous = current.session_id.clone();
        tracing::info!(terminal_id = %sig.terminal_id, new = %sig.session_id,
            source = ?sig.source, "claude_rebind: SessionStart reported a new session id");
        // Same pinned order as the codex tail: identity -> meta -> ledger
        // (awaited) -> associated THEN meta.updated.
        state.identity.upsert(
            &sig.terminal_id,
            Some("claude"),
            Some(&sig.session_id),
            current.cwd.as_deref(),
            now_ms(),
        );
        state.registry.set_meta(
            &sig.terminal_id,
            None,
            None,
            Some("claude".to_string()),
            Some(sig.session_id.clone()),
        );
        crate::pane_ledger::ledger_resolve_identity(
            state,
            &sig.terminal_id,
            "claude",
            &sig.session_id,
            current.cwd.as_deref(),
        )
        .await;
        crate::codex_identity::broadcast_terminal_session_associated(
            state,
            "claude",
            &sig.terminal_id,
            &sig.session_id,
            current.cwd.clone(),
            previous,
        );
    }
}

/// Spawned by `freshell-server` boot next to the locator sweeps (mirrors
/// `spawn_codex_locator_sweep`'s task shape): periodically drain the signal
/// root and process any rebinds, off the per-connection select loops.
pub fn spawn_claude_signal_sweep(state: WsState, watcher: ClaudeSignalWatcher) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(CLAUDE_SIGNAL_SWEEP_INTERVAL);
        loop {
            ticker.tick().await;
            drain_and_rebind_claude(&state, &watcher).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn drain_parses_and_deletes_signal_files() {
        let root = std::env::temp_dir().join(format!("freshell-claude-sig-{}", std::process::id()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(
            root.join("term-abc-123__42-9.json"),
            r#"{"session_id":"new-id","source":"resume","cwd":"/tmp/x","hook_event_name":"SessionStart"}"#,
        ).unwrap();
        std::fs::write(root.join("junk__1.json"), "not json").unwrap();
        let w = ClaudeSignalWatcher::new(root.clone());
        let got = w.drain();
        assert_eq!(
            got,
            vec![ClaudeSignal {
                terminal_id: "term-abc-123".into(),
                session_id: "new-id".into(),
                source: Some("resume".into()),
            }]
        );
        assert_eq!(
            std::fs::read_dir(&root).unwrap().count(),
            0,
            "processed AND malformed files deleted"
        );
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn drain_returns_signals_sorted_by_filename_oldest_first() {
        let root =
            std::env::temp_dir().join(format!("freshell-claude-sig-order-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        // Timestamp-first nonces (Task 1 shape). Written in REVERSE of
        // emission order so read_dir/creation order cannot fake a pass.
        let emissions = [
            (
                "1769000000000000001-11",
                "aaaaaaaa-0000-4000-8000-000000000001",
            ),
            (
                "1769000000000000002-11",
                "aaaaaaaa-0000-4000-8000-000000000002",
            ),
            (
                "1769000000000000003-99",
                "aaaaaaaa-0000-4000-8000-000000000003",
            ),
            (
                "1769000000000000004-42",
                "aaaaaaaa-0000-4000-8000-000000000004",
            ),
            (
                "1769000000000000005-42",
                "aaaaaaaa-0000-4000-8000-000000000005",
            ),
            (
                "1769000000000000006-07",
                "aaaaaaaa-0000-4000-8000-000000000006",
            ),
        ];
        for (nonce, sid) in emissions.iter().rev() {
            std::fs::write(
                root.join(format!("t1__{nonce}.json")),
                format!(r#"{{"session_id":"{sid}","source":"resume"}}"#),
            )
            .unwrap();
        }
        let watcher = ClaudeSignalWatcher::new(root.clone());
        let signals = watcher.drain();
        let got: Vec<&str> = signals.iter().map(|s| s.session_id.as_str()).collect();
        let want: Vec<&str> = emissions.iter().map(|(_, sid)| *sid).collect();
        assert_eq!(got, want, "drain must be filename-sorted (emission order)");
        // Existing delete-on-read semantics are unchanged.
        assert_eq!(std::fs::read_dir(&root).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&root);
    }
}
