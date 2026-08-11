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

// ---------------------------------------------------------------------------
// Task 6: ReattachedCodexAppServerRuntime + kill_verified_sidecar_tree.
//
// Each reattach test spawns ITS OWN fake app-server fixture
// (`node test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
// --listen ws://127.0.0.1:<port>`) as a direct tokio::process child tagged
// `FRESHELL_CODEX_SIDECAR_ID=<test-ownership-id>`, records that pid, and
// kills ONLY that pid in cleanup (`kill_on_drop(true)` plus explicit kills)
// — nothing else on the machine is ever signalled. Loopback ephemeral ports
// only; never 3001/3002.
// ---------------------------------------------------------------------------

use crate::launch_lifecycle::CodexLaunchRuntime;

fn fake_app_server_fixture() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs")
}

/// Spawn THIS TEST'S OWN fake app-server on a loopback ephemeral port and
/// wait for its WS listener to accept. `kill_on_drop(true)` guarantees
/// cleanup kills ONLY this recorded child, even on panic.
async fn spawn_own_fake_app_server(ownership_id: &str) -> (tokio::process::Child, String) {
    // Allocate a free loopback ephemeral port for the fixture to listen on.
    let ws_url = unused_loopback_ws_url();
    let mut child = tokio::process::Command::new("node")
        .arg(fake_app_server_fixture())
        .arg("--listen")
        .arg(&ws_url)
        .env(crate::durability::CODEX_SIDECAR_OWNERSHIP_ENV, ownership_id)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .expect("spawn this test's own fake app-server");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Ok((probe, _response))) = tokio::time::timeout(
            Duration::from_secs(1),
            tokio_tungstenite::connect_async(&ws_url),
        )
        .await
        {
            drop(probe);
            break;
        }
        if let Ok(Some(status)) = child.try_wait() {
            panic!("fake app-server exited before listening: {status}");
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "fake app-server WS never came up"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    (child, ws_url)
}

/// Count live processes whose `/proc/<pid>/environ` carries OUR unique
/// ownership tag — a read-only `/proc` scan keyed on this test's own id,
/// used to prove a reattach spawned NO new sidecar process.
fn count_own_tagged_processes(ownership_id: &str) -> usize {
    let needle = crate::durability::ownership_needle(ownership_id);
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return 0;
    };
    entries
        .flatten()
        .filter(|entry| {
            let name = entry.file_name();
            let Some(name) = name.to_str() else {
                return false;
            };
            let Ok(pid) = name.parse::<i32>() else {
                return false;
            };
            let Ok(environ) = std::fs::read(format!("/proc/{pid}/environ")) else {
                return false;
            };
            environ
                .split(|&b| b == 0)
                .any(|var| var == needle.as_bytes())
        })
        .count()
}

/// Grace window before a "never signalled" assertion: long enough for the
/// fixture's graceful SIGTERM exit to become observable if a signal HAD
/// (wrongly) been sent.
const NEVER_SIGNALLED_GRACE: Duration = Duration::from_millis(300);

#[tokio::test]
async fn reattach_ensure_ready_returns_the_existing_listener() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a6000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    let (mut child, ws_url) = spawn_own_fake_app_server(ownership_id).await;
    // Record built from the live fixture's REAL /proc evidence + real ws_url.
    let record = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        ..record_for_child(
            ownership_id,
            child.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record).expect("write record");

    let runtime = ReattachedCodexAppServerRuntime::new(record.clone(), Arc::clone(&store));
    let ready = runtime
        .ensure_ready(Some("/tmp/ignored-reattach-cwd".to_string()))
        .await
        .expect("reattach ensure_ready adopts the surviving listener");
    assert_eq!(
        ready.ws_url, ws_url,
        "reattach returns the SURVIVOR's ws url"
    );

    // The survivor is still alive and NO new process was spawned: exactly
    // one live process carries this test's unique ownership tag.
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the adopted survivor must still be alive"
    );
    assert_eq!(
        count_own_tagged_processes(ownership_id),
        1,
        "reattach must spawn NO new sidecar process"
    );
    assert_eq!(
        store.load_all(),
        vec![record],
        "a usable survivor's record stays in the store"
    );

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn reattach_refuses_on_identity_mismatch_without_signalling() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a6000002-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    let (mut child, ws_url) = spawn_own_fake_app_server(ownership_id).await;
    // The fixture's pid + starttime but a WRONG cmdline — the pid-reuse
    // shape. This pid is NOT ours; it must never be signalled.
    let record = CodexSidecarRecord {
        ws_url: ws_url.clone(),
        cmdline: vec!["codex".to_string(), "app-server".to_string()],
        ..record_for_child(
            ownership_id,
            child.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record).expect("write record");

    let runtime = ReattachedCodexAppServerRuntime::new(record, Arc::clone(&store));
    runtime
        .ensure_ready(None)
        .await
        .expect_err("a mismatched identity must refuse the reattach");

    assert!(
        store.load_all().is_empty(),
        "the mismatched record is removed"
    );
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    assert_eq!(
        child.try_wait().expect("try_wait fixture"),
        None,
        "the mismatching pid must NEVER be signalled"
    );

    child
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}

#[tokio::test]
async fn reattach_reaps_verified_but_unusable_survivor() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);
    let ownership_id = "codex-sidecar-a6000003-cccc-4ccc-8ccc-cccccccccccc";
    // Fixture listens on port A; the record's ws_url points at port B where
    // NOTHING listens (record_for_child's default) — pid evidence stays
    // valid, so identity is Verified but the probe fails fast.
    let (mut child, _fixture_ws_url) = spawn_own_fake_app_server(ownership_id).await;
    let record = record_for_child(
        ownership_id,
        child.id().expect("live fixture pid"),
        Some(SESSION),
    );
    store.write(&record).expect("write record");

    let runtime = ReattachedCodexAppServerRuntime::new(record, Arc::clone(&store));
    runtime
        .ensure_ready(None)
        .await
        .expect_err("a verified-but-unusable survivor must fail into fallback");

    // The unusable survivor was REAPED — an unusable tracked sidecar must
    // not leak (killing it releases codex's writer-lock files on exit).
    tokio::time::timeout(Duration::from_secs(10), child.wait())
        .await
        .expect("the unusable survivor must be reaped within the drain budget")
        .expect("wait fixture");
    assert!(
        store.load_all().is_empty(),
        "the unusable survivor's record is removed"
    );
}

#[tokio::test]
async fn reattach_shutdown_kills_only_after_reverification() {
    let dir = tempfile::tempdir().expect("tempdir");
    let store = store_in(&dir);

    // Positive arm: successful ensure_ready, then shutdown() → fixture gone,
    // record removed.
    let ownership_a = "codex-sidecar-a6000004-dddd-4ddd-8ddd-dddddddddddd";
    let (mut child_a, ws_a) = spawn_own_fake_app_server(ownership_a).await;
    let record_a = CodexSidecarRecord {
        ws_url: ws_a.clone(),
        ..record_for_child(
            ownership_a,
            child_a.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record_a).expect("write record a");
    let runtime_a = ReattachedCodexAppServerRuntime::new(record_a, Arc::clone(&store));
    runtime_a
        .ensure_ready(None)
        .await
        .expect("ensure_ready adopts survivor A");
    runtime_a.shutdown().await.expect("shutdown A");
    tokio::time::timeout(Duration::from_secs(10), child_a.wait())
        .await
        .expect("shutdown must reap the adopted survivor within the drain budget")
        .expect("wait fixture a");
    assert!(
        store.load_all().is_empty(),
        "shutdown removes the adopted survivor's record"
    );

    // Negative arm: successful ensure_ready, THEN the record's starttime is
    // replaced — the kill-time re-verification sees Mismatch and NEVER
    // signals; the record is still removed.
    let ownership_b = "codex-sidecar-a6000005-eeee-4eee-8eee-eeeeeeeeeeee";
    let (mut child_b, ws_b) = spawn_own_fake_app_server(ownership_b).await;
    let record_b = CodexSidecarRecord {
        ws_url: ws_b.clone(),
        ..record_for_child(
            ownership_b,
            child_b.id().expect("live fixture pid"),
            Some(SESSION),
        )
    };
    store.write(&record_b).expect("write record b");
    let runtime_b = ReattachedCodexAppServerRuntime::new(record_b, Arc::clone(&store));
    runtime_b
        .ensure_ready(None)
        .await
        .expect("ensure_ready adopts survivor B");
    // Tamper the held record's starttime (tests are a child module of the
    // runtime, so private field access is available): the pid-reuse shape
    // appearing AFTER a successful adopt.
    runtime_b.record.lock().unwrap().starttime += 1;
    runtime_b
        .shutdown()
        .await
        .expect("shutdown returns Ok even when re-verification refuses the kill");
    tokio::time::sleep(NEVER_SIGNALLED_GRACE).await;
    assert_eq!(
        child_b.try_wait().expect("try_wait fixture b"),
        None,
        "a kill-time identity mismatch must NEVER be signalled"
    );
    assert!(
        store.load_all().is_empty(),
        "shutdown removes the record even when the kill is refused"
    );

    child_b
        .kill()
        .await
        .expect("cleanup: kill this test's own fixture");
}
