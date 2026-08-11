//! Unit tests for the boot-time sidecar reconciler ([`super`]).
//!
//! Tempfile tempdirs ONLY — no global state, nothing outside each test's own
//! temp dir. In particular these tests must NEVER touch
//! `~/.freshell/codex-sidecars/` (Node's store), the production
//! `~/.freshell/rust-codex-sidecars/` root (wired in Task 10), or any live
//! process the test did not itself spawn.
//!
//! PROCESS SAFETY: each test spawns and reaps ONLY its own children
//! (`sleep 300`), killed in a [`ChildGuard`] drop guard — nothing else on the
//! machine is ever signalled. Reconciliation itself NEVER signals any pid
//! (prune is `store.remove` only), and the tests assert exactly that by
//! checking their children are still alive afterwards.
//!
//! Writer-probe note: `sleep` children speak no ws, and every record's
//! `ws_url` points at a loopback port nothing listens on, so the duplicate
//! arm's probe fails fast (connection refused, bounded by the ~1s budget) and
//! the newest-`updated_at` fallback decides — deterministic. The probe's
//! POSITIVE arm is exercised by Task 9's fixture-backed tests. Tests bind
//! loopback ephemeral ports only; never port 3001.
//!
//! /proc semantics are Linux-only, so these tests are
//! `#[cfg(target_os = "linux")]` (the sidecar_store_tests precedent).

#![cfg(target_os = "linux")]

use std::sync::Arc;

use super::*;
use crate::sidecar_store::{
    proc_cmdline, proc_starttime, CodexSidecarRecord, CodexSidecarStore, SidecarRecordState,
    SIDECAR_RECORD_VERSION,
};

/// Kills and reaps ONLY the guarded child on drop (defer-style guard) — the
/// test's own `sleep 300`, nothing else on the machine. `kill` on an
/// already-reaped `Child` is a no-op error inside std (no signal is sent to
/// a possibly-recycled pid), so double-cleanup is safe.
struct ChildGuard(std::process::Child);

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn spawn_own_sleep_child() -> ChildGuard {
    let guard = ChildGuard(
        std::process::Command::new("sleep")
            .arg("300")
            .spawn()
            .expect("spawn this test's own sleep child"),
    );
    // Wait for exec to complete: immediately after spawn the child may still
    // be post-fork/pre-exec, so /proc/<pid>/cmdline briefly reads as the TEST
    // BINARY's argv. Evidence captured in that window verifies as a cmdline
    // Mismatch at boot/claim time (observed flake). Poll until the child's
    // cmdline is really `sleep 300`.
    let pid = guard.0.id() as i32;
    let want = vec!["sleep".to_string(), "300".to_string()];
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while proc_cmdline(pid).as_ref() != Some(&want) {
        assert!(
            std::time::Instant::now() < deadline,
            "sleep child failed to exec within 5s"
        );
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
    guard
}

/// A loopback `ws://` URL on an ephemeral port NOTHING listens on (bound,
/// read, dropped) — probe dials fail fast with connection-refused. Never
/// port 3001.
fn unused_loopback_ws_url() -> String {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let port = listener.local_addr().expect("local_addr").port();
    drop(listener);
    format!("ws://127.0.0.1:{port}")
}

/// A record carrying a spawned child's REAL `/proc` evidence.
fn record_for_child(ownership_id: &str, pid: u32, session_id: Option<&str>) -> CodexSidecarRecord {
    CodexSidecarRecord {
        record_version: SIDECAR_RECORD_VERSION,
        ownership_id: ownership_id.to_string(),
        pid,
        starttime: proc_starttime(pid as i32).expect("live child has a starttime"),
        cmdline: proc_cmdline(pid as i32).expect("live child has a cmdline"),
        ws_url: unused_loopback_ws_url(),
        session_id: session_id.map(str::to_string),
        terminal_id: None,
        server_instance_id: "srv-prev".to_string(),
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_000_001,
        state: SidecarRecordState::Active,
    }
}

fn store_in(dir: &tempfile::TempDir) -> Arc<CodexSidecarStore> {
    Arc::new(CodexSidecarStore::new(dir.path().to_path_buf()))
}

const SESSION: &str = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";

#[test]
fn boot_reconcile_prunes_dead_and_mismatched_records() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // Dead: real evidence captured live, then OUR OWN child is killed+reaped.
    let mut dead_child = spawn_own_sleep_child();
    let dead = record_for_child(
        "codex-sidecar-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        dead_child.0.id(),
        Some(SESSION),
    );
    dead_child.0.kill().expect("kill own child");
    dead_child.0.wait().expect("reap own child");

    // Mismatch: a live child's pid+starttime but a DIFFERENT cmdline —
    // the pid-reuse shape. This pid is NOT ours; it must never be signalled.
    let mut mismatch_child = spawn_own_sleep_child();
    let mismatch = CodexSidecarRecord {
        cmdline: vec!["codex".to_string(), "app-server".to_string()],
        ..record_for_child(
            "codex-sidecar-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            mismatch_child.0.id(),
            Some(SESSION),
        )
    };

    // Verified: a live child's real evidence.
    let mut verified_child = spawn_own_sleep_child();
    let verified = record_for_child(
        "codex-sidecar-cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        verified_child.0.id(),
        Some(SESSION),
    );

    store.write(&dead).expect("write dead");
    store.write(&mismatch).expect("write mismatch");
    store.write(&verified).expect("write verified");

    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));

    assert_eq!(
        report,
        BootReconcileReport {
            loaded: 3,
            pruned_dead: 1,
            pruned_mismatch: 1,
            held: 1,
        }
    );
    assert_eq!(reconciler.unclaimed_len(), 1, "only the verified row held");
    assert_eq!(
        store.load_all(),
        vec![verified],
        "the store holds ONLY the verified row after pruning"
    );

    // Prune NEVER signals: both live children are still alive afterwards.
    assert_eq!(
        mismatch_child
            .0
            .try_wait()
            .expect("try_wait mismatch child"),
        None,
        "the mismatching pid must never be signalled"
    );
    assert_eq!(
        verified_child
            .0
            .try_wait()
            .expect("try_wait verified child"),
        None,
        "the verified child must not be signalled by boot"
    );
}

#[tokio::test]
async fn boot_reconcile_holds_sessionless_records_for_the_sweep() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    let child = spawn_own_sleep_child();
    let sessionless = record_for_child(
        "codex-sidecar-dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        child.0.id(),
        None,
    );
    store.write(&sessionless).expect("write sessionless");

    let (reconciler, report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(report.held, 1);
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "a verified record WITHOUT a session is held for the sweep"
    );

    // Not claimable by any session — and NOT dropped by the attempt.
    assert_eq!(reconciler.claim_for_session(SESSION).await, None);
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "the sessionless record stays held after a foreign claim attempt"
    );
    assert_eq!(
        store.load_all(),
        vec![sessionless],
        "the sessionless row survives in the store"
    );
}

#[tokio::test]
async fn claim_for_session_returns_each_record_once() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    let child = spawn_own_sleep_child();
    let record = record_for_child(
        "codex-sidecar-eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        child.0.id(),
        Some(SESSION),
    );
    store.write(&record).expect("write record");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 1);

    let first = reconciler.claim_for_session(SESSION).await;
    assert_eq!(first, Some(record), "first claim returns the record");
    assert_eq!(reconciler.unclaimed_len(), 0, "the claim left held");

    let second = reconciler.claim_for_session(SESSION).await;
    assert_eq!(second, None, "each record is claimable ONCE");
}

#[tokio::test]
async fn claim_reverifies_identity_at_claim_time() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    let mut child = spawn_own_sleep_child();
    let record = record_for_child(
        "codex-sidecar-ffffffff-ffff-4fff-8fff-ffffffffffff",
        child.0.id(),
        Some(SESSION),
    );
    store.write(&record).expect("write record");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 1, "held while the child lives");

    // The sidecar dies BETWEEN boot and claim (kill+reap OUR OWN child).
    child.0.kill().expect("kill own child");
    child.0.wait().expect("reap own child");

    assert_eq!(
        reconciler.claim_for_session(SESSION).await,
        None,
        "claim re-verifies identity and refuses a dead sidecar"
    );
    assert_eq!(reconciler.unclaimed_len(), 0, "the dead record left held");
    assert!(
        store.load_all().is_empty(),
        "the dead record was removed from the store"
    );
}

#[tokio::test]
async fn duplicate_session_records_claim_one_keep_the_loser_held() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // Two VERIFIED records sharing one session id (two live test children) —
    // the mid-turn-survivor + fresh-spawn shape (reports/V3.md).
    let mut older_child = spawn_own_sleep_child();
    let older = CodexSidecarRecord {
        updated_at: 1_700_000_000_001,
        ..record_for_child(
            "codex-sidecar-11111111-2222-4333-8444-555555555555",
            older_child.0.id(),
            Some(SESSION),
        )
    };
    let mut newer_child = spawn_own_sleep_child();
    let newer = CodexSidecarRecord {
        updated_at: 1_700_000_000_002,
        ..record_for_child(
            "codex-sidecar-66666666-7777-4888-8999-aaaaaaaaaaaa",
            newer_child.0.id(),
            Some(SESSION),
        )
    };
    store.write(&older).expect("write older");
    store.write(&newer).expect("write newer");

    let (reconciler, _report) = SidecarReconciler::boot_reconcile(Arc::clone(&store));
    assert_eq!(reconciler.unclaimed_len(), 2, "both duplicates held");

    // `sleep` children speak no ws (and the ws_urls point at closed ports),
    // so the writer probe fails fast on both and the newest-`updated_at`
    // fallback decides.
    let claimed = reconciler.claim_for_session(SESSION).await;
    assert_eq!(
        claimed,
        Some(newer),
        "the newest-updated_at candidate wins the fallback"
    );
    assert_eq!(
        reconciler.unclaimed_len(),
        1,
        "the loser STAYS held for the sweep — never silently dropped"
    );

    // Claiming NEVER signals: both children are still alive.
    assert_eq!(
        older_child.0.try_wait().expect("try_wait older child"),
        None,
        "the losing candidate's sidecar must not be signalled"
    );
    assert_eq!(
        newer_child.0.try_wait().expect("try_wait newer child"),
        None,
        "the winning candidate's sidecar must not be signalled"
    );
}
