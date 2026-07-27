//! Shutdown forensics: attribute external signals (WSL-outage RCA
//! 2026-07-06 §6.4; design reference: `server/shutdown-forensics.ts` on the
//! `fix/wsl-crash-hardening` branch).
//!
//! The 2026-07-06 WSL outages killed the server with external SIGTERMs whose
//! sender could not be identified after the fact. On shutdown we log the
//! parent-process chain and compare it against the BOOT-TIME chain.
//! Discriminator (V5, measured on WSL2): orphans reparent to the
//! session-leader SUBREAPER "Relay" — NOT pid 1 — and reparenting completes
//! BEFORE the SIGHUP handler runs (8/8 trials; walk ~0.2ms). So the signal
//! is "parent CHANGED vs the boot-time parent / parent is a
//! subreaper-family process (Relay/init/systemd)" — never a literal
//! `ppid == 1` check. A changed parent indicates the login-session host
//! died (RCA candidate A); an unchanged live chain plus SIGTERM indicates a
//! directed kill.
//!
//! Best-effort by construction: pure sync `std::fs` reads of tiny /proc
//! files, bounded hops, no retries, no timers, no awaits — it can never
//! delay or block shutdown. On platforms without /proc the walker returns
//! `None` instead of erroring (macOS/Windows builds compile and degrade
//! gracefully; no conditional compilation needed here).

use std::path::Path;
use std::sync::OnceLock;

/// Boot-time parent chain, captured once at startup (Task 9 calls
/// [`record_boot_parent_chain`] from `main` right after logging init).
static BOOT_PARENT_CHAIN: OnceLock<String> = OnceLock::new();

#[derive(Debug, PartialEq, Eq)]
pub struct ProcessChainEntry {
    pub pid: i64,
    pub comm: String,
}

/// Parse a `/proc/<pid>/stat` line: `pid (comm) state ppid ...`.
/// `comm` may itself contain spaces and parentheses, so it is delimited by
/// the FIRST `(` and the LAST `)`.
fn parse_proc_stat(content: &str) -> Option<(i64, String, i64)> {
    let open = content.find('(')?;
    let close = content.rfind(')')?;
    if close < open {
        return None;
    }
    let pid: i64 = content[..open].trim().parse().ok()?;
    let comm = content[open + 1..close].to_string();
    let mut rest = content[close + 1..].split_whitespace();
    let _state = rest.next()?;
    let ppid: i64 = rest.next()?.parse().ok()?;
    Some((pid, comm, ppid))
}

/// Walk the ppid chain starting at `start_pid`, reading `<proc_root>/<pid>/stat`.
/// Returns entries starting with the process itself, following parents up to
/// pid 1 or `max_hops` parent hops. Returns `None` when the starting process
/// cannot be read (e.g. no /proc on non-Linux); returns a TRUNCATED chain
/// when a parent disappears mid-walk (that is data, not an error).
fn collect_parent_chain(
    proc_root: &Path,
    start_pid: i64,
    max_hops: usize,
) -> Option<Vec<ProcessChainEntry>> {
    let read_stat =
        |pid: i64| std::fs::read_to_string(proc_root.join(pid.to_string()).join("stat")).ok();

    let first = parse_proc_stat(&read_stat(start_pid)?)?;
    let mut chain = vec![ProcessChainEntry {
        pid: first.0,
        comm: first.1,
    }];
    let mut pid = first.0;
    let mut ppid = first.2;
    let mut hops = 0;
    while hops < max_hops && pid != 1 && ppid >= 1 {
        let Some(raw) = read_stat(ppid) else { break };
        let Some(parsed) = parse_proc_stat(&raw) else {
            break;
        };
        chain.push(ProcessChainEntry {
            pid: parsed.0,
            comm: parsed.1,
        });
        pid = parsed.0;
        ppid = parsed.2;
        hops += 1;
    }
    Some(chain)
}

/// Format `12345:freshell-server <- 4242:systemd <- 1:init` (walks toward init).
fn format_chain(chain: &[ProcessChainEntry]) -> String {
    chain
        .iter()
        .map(|e| format!("{}:{}", e.pid, e.comm))
        .collect::<Vec<_>>()
        .join(" <- ")
}

/// Capture the boot-time parent chain for signal-time comparison.
/// Idempotent; call once from `main` after logging init (Task 9).
pub fn record_boot_parent_chain() {
    let _ = BOOT_PARENT_CHAIN.get_or_init(|| {
        match collect_parent_chain(Path::new("/proc"), std::process::id() as i64, 10) {
            Some(entries) => format_chain(&entries),
            None => "unavailable".to_string(),
        }
    });
}

/// Emit the single structured shutdown-forensics record. Never panics.
/// MUST stay at INFO or above: the default EnvFilter is `info` (A14/V5),
/// and the line only lands if `logging::init` succeeded at boot.
pub fn log_shutdown_forensics(signal: &str) {
    let chain = collect_parent_chain(Path::new("/proc"), std::process::id() as i64, 10);
    let parent_chain = match &chain {
        Some(entries) => format_chain(entries),
        None => "unavailable".to_string(),
    };
    let boot_parent_chain = BOOT_PARENT_CHAIN
        .get()
        .cloned()
        .unwrap_or_else(|| "unrecorded".to_string());
    tracing::info!(
        event = "shutdown_forensics",
        signal = %signal,
        parent_chain = %parent_chain,
        boot_parent_chain = %boot_parent_chain,
        "shutdown forensics: compare parent_chain to boot_parent_chain. A \
         CHANGED parent (typically a subreaper-family adopter: Relay/init/\
         systemd — on WSL2 orphans reparent to the Relay subreaper, NOT \
         pid 1) indicates the original parent/login-session host died; an \
         unchanged live chain plus SIGTERM indicates a directed kill"
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_stat(root: &Path, pid: i64, comm: &str, ppid: i64) {
        let dir = root.join(pid.to_string());
        std::fs::create_dir_all(&dir).expect("mkdir");
        // Real /proc stat shape: `pid (comm) state ppid pgrp ...`
        std::fs::write(dir.join("stat"), format!("{pid} ({comm}) S {ppid} 0 0 0"))
            .expect("write stat");
    }

    #[test]
    fn parses_plain_stat_line() {
        let parsed = parse_proc_stat("42 (bash) S 7 42 42 0").expect("parse");
        assert_eq!(parsed, (42, "bash".to_string(), 7));
    }

    #[test]
    fn comm_with_spaces_and_parens_uses_first_open_and_last_close() {
        let parsed = parse_proc_stat("99 (tmux: server (v3)) S 12 99 99 0").expect("parse");
        assert_eq!(parsed, (99, "tmux: server (v3)".to_string(), 12));
    }

    #[test]
    fn garbage_stat_returns_none() {
        assert!(parse_proc_stat("").is_none());
        assert!(parse_proc_stat("no parens here").is_none());
        assert!(parse_proc_stat(") reversed ( 1 2").is_none());
        assert!(parse_proc_stat("x (comm) S notanumber").is_none());
    }

    #[test]
    fn walks_chain_to_init() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_stat(tmp.path(), 300, "freshell-server", 200);
        write_stat(tmp.path(), 200, "bash", 100);
        write_stat(tmp.path(), 100, "sshd", 1);
        write_stat(tmp.path(), 1, "systemd", 0);
        let chain = collect_parent_chain(tmp.path(), 300, 10).expect("chain");
        let comms: Vec<&str> = chain.iter().map(|e| e.comm.as_str()).collect();
        assert_eq!(comms, vec!["freshell-server", "bash", "sshd", "systemd"]);
        assert_eq!(chain.last().expect("last").pid, 1);
    }

    #[test]
    fn missing_start_pid_returns_none() {
        let tmp = tempfile::tempdir().expect("tempdir");
        assert!(collect_parent_chain(tmp.path(), 12345, 10).is_none());
    }

    #[test]
    fn missing_parent_truncates_chain_instead_of_erroring() {
        let tmp = tempfile::tempdir().expect("tempdir");
        write_stat(tmp.path(), 300, "freshell-server", 200);
        // pid 200 does not exist: mid-walk failure.
        let chain = collect_parent_chain(tmp.path(), 300, 10).expect("chain");
        assert_eq!(chain.len(), 1);
        assert_eq!(chain[0].comm, "freshell-server");
    }

    #[test]
    fn max_hops_bounds_the_walk() {
        let tmp = tempfile::tempdir().expect("tempdir");
        // A pathological 20-deep chain; only max_hops=3 parents get walked.
        for pid in 0..20i64 {
            write_stat(tmp.path(), 1000 + pid, &format!("p{pid}"), 1000 + pid + 1);
        }
        let chain = collect_parent_chain(tmp.path(), 1000, 3).expect("chain");
        assert_eq!(chain.len(), 4, "start entry + 3 hops");
    }

    #[test]
    fn format_chain_walks_toward_init() {
        let chain = vec![
            ProcessChainEntry {
                pid: 300,
                comm: "freshell-server".into(),
            },
            ProcessChainEntry {
                pid: 1,
                comm: "systemd".into(),
            },
        ];
        assert_eq!(format_chain(&chain), "300:freshell-server <- 1:systemd");
    }

    #[test]
    fn record_boot_parent_chain_is_idempotent() {
        record_boot_parent_chain();
        let first = super::BOOT_PARENT_CHAIN.get().cloned();
        assert!(first.is_some(), "boot chain must be recorded");
        record_boot_parent_chain();
        assert_eq!(super::BOOT_PARENT_CHAIN.get().cloned(), first);
    }
}
