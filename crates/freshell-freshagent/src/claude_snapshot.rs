//! Claude fresh-agent snapshot adapter (restart-resilience plan §2.8 item 4).
//!
//! Reads the Claude CLI's own transcript store (`<store-root>/projects/<cwd-slug>/
//! <uuid>.jsonl`) directly -- the first file-reading snapshot source in the Rust port.
//! Design choice over codex's resume-and-ask: the sidecar protocol has no history op,
//! the SDK's own `getSessionMessages` is itself just a local JSONL read with the same
//! root resolution (ledger A16), a sidecar resume burns a real SDK process per
//! snapshot GET, and the legacy Node server already proved direct-read viable
//! (`server/session-history-loader.ts` -- with real-store parsing fixes, ledger A5).
//! Store-root resolution is ORDERED CANDIDATES (`CLAUDE_CONFIG_DIR` > `CLAUDE_HOME` >
//! `$HOME/.claude`) because the real CLI honors CLAUDE_CONFIG_DIR and IGNORES
//! CLAUDE_HOME (ledger A3) -- reading a single root risks false positive denial.
//! The transcript store is also the AUTHORITY for lost-vs-alive on attach
//! ([`crate::FreshClaudeState::handle_attach`]): file present => resumable, file
//! absent in EVERY candidate root => positively gone (mirrors opencode's 404 rule;
//! honest even under claude's 30-day `cleanupPeriodDays` GC -- an expired transcript
//! is unresumable by the CLI too, ledger A4).

use std::path::{Path, PathBuf};

/// Ordered candidate store roots. The real CLI resolves its store as
/// `CLAUDE_CONFIG_DIR ?? $HOME/.claude` and IGNORES `CLAUDE_HOME` (verified against
/// cli.js 2.1.220 -- ledger A3); `CLAUDE_HOME` is freshell's legacy knob
/// (`server/claude-home.ts`, `session_directory.rs` -- `pub(crate)` to that crate).
/// We read ALL candidates so a reader/writer root mismatch can never turn a live
/// session into a false positive denial.
#[allow(dead_code)]
pub(crate) fn claude_home_candidates() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let mut push = |p: PathBuf| {
        if !out.contains(&p) {
            out.push(p);
        }
    };
    if let Ok(v) = std::env::var("CLAUDE_CONFIG_DIR") {
        if !v.is_empty() {
            push(PathBuf::from(v));
        }
    }
    if let Ok(v) = std::env::var("CLAUDE_HOME") {
        if !v.is_empty() {
            push(PathBuf::from(v));
        }
    }
    if let Ok(h) = std::env::var("HOME") {
        if !h.is_empty() {
            push(PathBuf::from(h).join(".claude"));
        }
    }
    out
}

/// `find_transcript` across every candidate root, in resolution order.
/// Positive denial (attach) and snapshot 404 both require a miss EVERYWHERE.
#[allow(dead_code)]
pub(crate) fn locate_transcript(session_id: &str) -> Option<PathBuf> {
    claude_home_candidates()
        .iter()
        .find_map(|root| find_transcript(root, session_id))
}

/// The session's ORIGINAL cwd: first non-empty `cwd` field among the transcript's
/// lines (100% of real user/assistant lines carry it -- ledger A5 census). Needed
/// because the CLI's resume lookup is scoped to the original cwd's project slug
/// (ledger A15). Reads lazily, stops at the first hit; malformed lines skipped.
#[allow(dead_code)]
pub(crate) fn transcript_cwd(path: &Path) -> Option<String> {
    use std::io::BufRead;
    let file = std::fs::File::open(path).ok()?;
    for line in std::io::BufReader::new(file).lines() {
        let Ok(line) = line else { break };
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        if let Some(cwd) = value.get("cwd").and_then(serde_json::Value::as_str) {
            if !cwd.is_empty() {
                return Some(cwd.to_string());
            }
        }
    }
    None
}

/// Locate `<claude_home>/projects/*/<session_id>.jsonl` (or one subdir deeper, e.g.
/// `<project>/<session-id-dir>/...` layouts). Filename scan, NEVER slug re-derivation:
/// the cwd->slug encoding is lossy (`docs/port-plan.md:45`). Sorted dirs for
/// determinism (mirrors `directory_index.rs::discover_claude_home`).
#[allow(dead_code)]
pub(crate) fn find_transcript(claude_home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let filename = format!("{session_id}.jsonl");
    let projects = claude_home.join("projects");
    let entries = std::fs::read_dir(&projects).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for dir in &dirs {
        let direct = dir.join(&filename);
        if direct.is_file() {
            return Some(direct);
        }
        let Ok(nested) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut subdirs: Vec<PathBuf> = nested
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        for sub in &subdirs {
            let candidate = sub.join(&filename);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn find_transcript_locates_a_direct_project_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-home-user-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "11111111-1111-4111-8111-111111111111"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_locates_a_one_level_nested_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p").join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "22222222-2222-4222-8222-222222222222"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_misses_cleanly_and_rejects_traversal() {
        let home = temp_home();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        assert_eq!(
            find_transcript(home.path(), "33333333-3333-4333-8333-333333333333"),
            None
        );
        assert_eq!(find_transcript(home.path(), "../etc/passwd"), None);
        assert_eq!(find_transcript(home.path(), "a/b"), None);
        assert_eq!(find_transcript(home.path(), ""), None);
    }

    #[test]
    fn transcript_cwd_reads_the_first_cwd_field() {
        let home = temp_home();
        let file = home.path().join("t.jsonl");
        std::fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"type\":\"user\",\"cwd\":\"/home/user/proj\",\"message\":\"hi\"}\n",
        )
        .unwrap();
        assert_eq!(transcript_cwd(&file), Some("/home/user/proj".to_string()));
        let empty = home.path().join("e.jsonl");
        std::fs::write(&empty, "").unwrap();
        assert_eq!(transcript_cwd(&empty), None);
    }
}
