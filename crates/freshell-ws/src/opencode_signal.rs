//! Opencode mid-session rebind: signal-file watcher.
//!
//! The freshell TUI plugin (extensions/opencode/freshell-rebind-plugin.ts,
//! injected per-pane via OPENCODE_TUI_CONFIG pointing at the freshell-owned
//! plugin-only tui.json) writes
//! `$HOME/.freshell/session-signals/opencode/<terminal_id>__<nonce>.json`
//! on every in-TUI session switch. This module drains those files.
//!
//! Shape-mirrors claude_signal.rs (the codebase prefers duplication over a
//! premature provider-generic controller — see codex_association.rs:4-6),
//! with three deltas: drain() sorts by filename (timestamp-first nonces ⇒
//! deterministic last-write-wins under rapid A→B→A switching); session ids
//! must match `ses_[A-Za-z0-9]+` (opencode's id shape; reject everything
//! else before any guard runs, warn-logging rejects for detectability);
//! and drain is NON-DESTRUCTIVE for valid signals — the consumer deletes a
//! file only after acting on it (act-then-delete, D1.1), with a ~10-minute
//! staleness reap for signals nobody ever acts on.
//!
//! Deliberately NOT a WsState field: the sweep task owns the watcher
//! (claude_signal.rs:12-14 — WsState is an exhaustive struct literal in
//! ~27 test files).

use std::path::{Path, PathBuf};

// NOTE: the sweep-interval const (OPENCODE_SIGNAL_SWEEP_INTERVAL) is added in
// Task 5 together with its only consumer, spawn_opencode_signal_sweep —
// introducing it here would make this task's `clippy -D warnings` gate fail
// as dead_code.
/// Retention cap for unacted signal files (D1.1): a signal whose pane never
/// (re)appears is reaped after this age instead of living forever.
pub(crate) const STALE_SIGNAL_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(600);

#[derive(Clone)]
pub struct OpencodeSignalWatcher {
    root: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpencodeSignal {
    /// The signal file itself. The consumer deletes it only after ACTING on
    /// the signal (act-then-delete, D1.1) — never delete-on-read.
    pub path: PathBuf,
    pub terminal_id: String,
    pub session_id: String,
    /// The plugin's `source` field ("opencode-tui-plugin"); logged only.
    pub source: Option<String>,
}

pub(crate) fn is_valid_opencode_session_id(id: &str) -> bool {
    id.strip_prefix("ses_")
        .is_some_and(|rest| !rest.is_empty() && rest.bytes().all(|b| b.is_ascii_alphanumeric()))
}

impl OpencodeSignalWatcher {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// `$HOME` (unix) / `%USERPROFILE%` (windows) + `.freshell/session-signals/opencode`.
    /// `None` when home is unresolvable — boot skips the sweep (mirrors
    /// ClaudeSignalWatcher::default_root).
    pub fn default_root() -> Option<PathBuf> {
        // Copy the body of ClaudeSignalWatcher::default_root (claude_signal.rs:52-66)
        // verbatim, changing the final path segment from "claude" to "opencode".
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
                .join("opencode"),
        )
    }

    /// Read + parse every `*.json`, sorted by filename. Valid signals are
    /// returned WITH their file paths and RETAINED on disk — act-then-delete
    /// is the consumer's job (D1.1: a fire-and-forget drain permanently lost
    /// signals when a pane died within seconds of a switch, V6). Malformed
    /// and invalid-shape files are warn-logged (`opencode_signal_rejected`)
    /// and deleted (single-shot semantics — junk must not re-fail every
    /// sweep). Files older than STALE_SIGNAL_MAX_AGE are reaped without
    /// emitting. `*.tmp` staging files are ignored.
    pub fn drain(&self) -> Vec<OpencodeSignal> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new(); // no dir yet: no opencode pane has ever signaled
        };
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("json"))
            .collect();
        paths.sort();
        let mut signals = Vec::new();
        for path in paths {
            let stale = std::fs::metadata(&path)
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.elapsed().ok())
                .is_some_and(|age| age > STALE_SIGNAL_MAX_AGE);
            if stale {
                let _ = std::fs::remove_file(&path); // retention cap (D1.1)
                continue;
            }
            match parse_signal_file(&path) {
                Some(sig) => signals.push(sig), // retained: consumer act-then-deletes
                None => {
                    // A silently-never-firing lane is the failure mode to
                    // avoid (A8 detectability): log rejects before consuming.
                    tracing::warn!(path = %path.display(),
                        "opencode_signal_rejected: bad terminal id or session_id shape, consuming file");
                    let _ = std::fs::remove_file(&path);
                }
            }
        }
        signals
    }
}

fn parse_signal_file(path: &Path) -> Option<OpencodeSignal> {
    let stem = path.file_stem()?.to_str()?;
    let (terminal_id, _nonce) = stem.rsplit_once("__")?; // LAST "__" — load-bearing
    if terminal_id.is_empty() {
        return None;
    }
    let raw = std::fs::read_to_string(path).ok()?;
    let body: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let session_id = body.get("session_id")?.as_str()?;
    if !is_valid_opencode_session_id(session_id) {
        return None;
    }
    Some(OpencodeSignal {
        path: path.to_path_buf(),
        terminal_id: terminal_id.to_string(),
        session_id: session_id.to_string(),
        source: body
            .get("source")
            .and_then(|v| v.as_str())
            .map(str::to_string),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_signal(dir: &std::path::Path, name: &str, body: &str) {
        std::fs::write(dir.join(name), body).unwrap();
    }

    #[test]
    fn session_id_shape_is_enforced() {
        assert!(is_valid_opencode_session_id("ses_abc123XYZ"));
        assert!(!is_valid_opencode_session_id("ses_"));
        assert!(!is_valid_opencode_session_id("ses_ab-cd"));
        assert!(!is_valid_opencode_session_id(
            "22222222-3333-4444-8555-666677778888"
        ));
        assert!(!is_valid_opencode_session_id(""));
    }

    fn remaining(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<String> = std::fs::read_dir(dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    #[test]
    fn drain_parses_sorts_retains_valid_files_and_consumes_rejects() {
        let dir = tempfile::tempdir().unwrap();
        // Timestamp-first nonces: lexicographic order == emission order.
        write_signal(
            dir.path(),
            "term-1__00000000000002-000002-9.json",
            r#"{"session_id":"ses_bbb","source":"opencode-tui-plugin"}"#,
        );
        write_signal(
            dir.path(),
            "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_aaa","source":"opencode-tui-plugin"}"#,
        );
        // Rejected (warn-logged as opencode_signal_rejected + deleted):
        // bad id shape (claude-style uuid), malformed json, missing __.
        write_signal(
            dir.path(),
            "term-1__00000000000003-000003-9.json",
            r#"{"session_id":"22222222-3333-4444-8555-666677778888"}"#,
        );
        write_signal(dir.path(), "junk__1.json", "{not json");
        write_signal(dir.path(), "no-delimiter.json", r#"{"session_id":"ses_x"}"#);
        // Ignored entirely (staging file), must survive the drain.
        write_signal(
            dir.path(),
            "term-1__00000000000004-000004-9.tmp",
            r#"{"session_id":"ses_ccc"}"#,
        );

        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        let signals = watcher.drain();
        let ids: Vec<(&str, &str)> = signals
            .iter()
            .map(|s| (s.terminal_id.as_str(), s.session_id.as_str()))
            .collect();
        assert_eq!(ids, vec![("term-1", "ses_aaa"), ("term-1", "ses_bbb")]);
        assert_eq!(signals[0].source.as_deref(), Some("opencode-tui-plugin"));
        // Valid signals carry their file paths and are RETAINED on disk —
        // the Task 5 consumer deletes each file only after ACTING on it
        // (act-then-delete, D1.1).
        assert!(signals.iter().all(|s| s.path.exists()));
        // Rejected .json files are consumed (single-shot — junk must not
        // re-fail every sweep); the .tmp staging file is untouched.
        assert_eq!(
            remaining(dir.path()),
            vec![
                "term-1__00000000000001-000001-9.json".to_string(),
                "term-1__00000000000002-000002-9.json".to_string(),
                "term-1__00000000000004-000004-9.tmp".to_string(),
            ]
        );
    }

    #[test]
    fn drain_reaps_stale_files_without_emitting() {
        let dir = tempfile::tempdir().unwrap();
        write_signal(
            dir.path(),
            "term-1__00000000000001-000001-9.json",
            r#"{"session_id":"ses_old"}"#,
        );
        let path = dir.path().join("term-1__00000000000001-000001-9.json");
        // Backdate past the retention cap (D1.1 staleness reap).
        let stale = std::time::SystemTime::now()
            - STALE_SIGNAL_MAX_AGE
            - std::time::Duration::from_secs(60);
        std::fs::OpenOptions::new()
            .write(true)
            .open(&path)
            .unwrap()
            .set_modified(stale)
            .unwrap();
        let watcher = OpencodeSignalWatcher::new(dir.path().to_path_buf());
        assert!(watcher.drain().is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn drain_on_missing_directory_is_empty() {
        let watcher = OpencodeSignalWatcher::new(std::path::PathBuf::from(
            "/nonexistent/freshell-opencode-signals",
        ));
        assert!(watcher.drain().is_empty());
    }
}
