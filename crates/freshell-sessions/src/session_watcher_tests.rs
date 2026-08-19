//! Unit tests for `crate::session_watcher`. Kept in a sibling file (the
//! `codex_locator_tests.rs` convention: a `#[path]`-included child module) to
//! respect the repo's <=1K-lines file limit; `use super::*` still reaches
//! the parent's private items (`create_provider_watcher`, `watch_path`,
//! `unwatch_tolerated`, `WatchEvent`).

use super::*;
use crate::directory_index::{ClaudeSource, SessionIndex, SessionSource};
use std::sync::Arc;

#[test]
fn watched_provider_can_be_constructed() {
    let wp = WatchedProvider {
        layout: Box::new(crate::provider_layout::ClaudeLayout),
        home: PathBuf::from("/home/user/.claude"),
    };
    assert_eq!(wp.layout.name(), "claude");
}

fn unique_temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "freshell-watcher-{label}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

fn write_claude_session(claude_home: &Path, session_id: &str, cwd: &str) {
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();
    let line = serde_json::json!({
        "type": "user",
        "sessionId": session_id,
        "cwd": cwd,
        "message": { "role": "user", "content": "hello" },
        "timestamp": "2025-01-30T10:00:00.000Z",
    })
    .to_string();
    std::fs::write(
        project.join(format!("{session_id}.jsonl")),
        format!("{line}\n"),
    )
    .unwrap();
}

#[test]
fn is_relevant_accepts_data_modify_and_create() {
    use notify::event::ModifyKind;
    let data_event = notify::Event::new(notify::EventKind::Modify(ModifyKind::Data(
        notify::event::DataChange::Any,
    )));
    assert!(is_relevant(&data_event));

    let create_event =
        notify::Event::new(notify::EventKind::Create(notify::event::CreateKind::File));
    assert!(is_relevant(&create_event));

    let remove_event =
        notify::Event::new(notify::EventKind::Remove(notify::event::RemoveKind::File));
    assert!(is_relevant(&remove_event));
}

#[test]
fn is_relevant_rejects_access_events() {
    let access_event =
        notify::Event::new(notify::EventKind::Access(notify::event::AccessKind::Read));
    assert!(!is_relevant(&access_event));
}

#[test]
fn is_relevant_accepts_rescan_flag() {
    use notify::event::Flag;
    let mut event = notify::Event::new(notify::EventKind::Other);
    event = event.set_flag(Flag::Rescan);
    assert!(is_relevant(&event));
}

#[test]
fn is_relevant_rejects_flagless_other() {
    let event = notify::Event::new(notify::EventKind::Other);
    assert!(!is_relevant(&event));
}

#[test]
fn nearest_existing_ancestor_returns_existing_parent() {
    let tmp = std::env::temp_dir();
    // tmp exists; tmp/nonexistent/deep does not
    let target = tmp.join("nonexistent-watcher-test-dir").join("deep");
    let result = nearest_existing_ancestor(&target, &tmp);
    assert_eq!(result, tmp);
}

#[test]
fn nearest_existing_ancestor_returns_bound_when_nothing_exists() {
    let bound = PathBuf::from("/nonexistent-bound-for-test");
    let target = bound.join("sub").join("deep");
    let result = nearest_existing_ancestor(&target, &bound);
    assert_eq!(result, bound);
}

#[tokio::test]
async fn watcher_detects_new_file_and_marks_dirty() {
    let claude_home = unique_temp_dir("watcher-detect");
    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    let sid1 = "550e8400-e29b-41d4-a716-446655440001";
    write_claude_session(&claude_home, sid1, "/p/1");

    let source = ClaudeSource::new(claude_home.clone());
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source) as Arc<dyn SessionSource>],
        Duration::from_secs(3600),
        None,
    ));

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 1);

    let mut rx = index.subscribe_changes();

    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::ClaudeLayout),
            home: claude_home.clone(),
        }],
    );
    let handle = watcher.start();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let sid2 = "550e8400-e29b-41d4-a716-446655440002";
    write_claude_session(&claude_home, sid2, "/p/2");

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(
        changed.is_ok(),
        "watcher should detect the new file and trigger a snapshot change"
    );

    let snap2 = index.snapshot().await;
    let mut final_len = snap2.len();
    for _ in 0..20 {
        if final_len >= 2 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
        final_len = index.snapshot().await.len();
    }
    assert_eq!(final_len, 2, "new session should appear in the index");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&claude_home).ok();
}

#[tokio::test]
async fn watcher_handles_late_root_appearance() {
    let base = unique_temp_dir("late-root");
    let claude_home = base.join(".claude");
    std::fs::create_dir_all(&claude_home).unwrap();

    let source = ClaudeSource::new(claude_home.clone());
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source) as Arc<dyn SessionSource>],
        Duration::from_secs(3600),
        None,
    ));

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 0);

    let mut rx = index.subscribe_changes();
    let _ = *rx.borrow_and_update();

    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::ClaudeLayout),
            home: claude_home.clone(),
        }],
    );
    let handle = watcher.start();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let sid = "550e8400-e29b-41d4-a716-446655440003";
    write_claude_session(&claude_home, sid, "/p/late");

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(
        changed.is_ok(),
        "watcher must detect a late-appearing session (DEV-0002 liveness)"
    );

    let mut found = false;
    for _ in 0..20 {
        let snap = index.snapshot().await;
        if snap.iter().any(|s| s.session_id == sid) {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(found, "late-appearing session must be visible in the index");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&base).ok();
}

#[tokio::test]
async fn watcher_rearms_when_absent_provider_appears() {
    let base = unique_temp_dir("rearm");
    let claude_home = base.join(".claude");

    let source = ClaudeSource::new(claude_home.clone());
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(source) as Arc<dyn SessionSource>],
        Duration::from_secs(3600),
        None,
    ));

    let snap = index.snapshot().await;
    assert_eq!(snap.len(), 0);

    let mut rx = index.subscribe_changes();
    let _ = *rx.borrow_and_update();

    let mut watcher = SessionWatcher::new(
        Arc::clone(&index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::ClaudeLayout),
            home: claude_home.clone(),
        }],
    )
    .with_rearm_interval(1);
    let handle = watcher.start();
    tokio::time::sleep(Duration::from_millis(500)).await;

    let project = claude_home.join("projects").join("-p");
    std::fs::create_dir_all(&project).unwrap();

    tokio::time::sleep(Duration::from_secs(2)).await;

    let sid = "550e8400-e29b-41d4-a716-446655440004";
    write_claude_session(&claude_home, sid, "/p/rearm");

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "re-armed watcher must detect the new file");

    let mut found = false;
    for _ in 0..20 {
        let snap = index.snapshot().await;
        if snap.iter().any(|s| s.session_id == sid) {
            found = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        found,
        "session from a re-armed provider must appear in the index"
    );

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&base).ok();
}

/// Drain FileChanged paths into a set until `done` holds or the window
/// closes (ProviderRescan carries no paths and is skipped; a closed
/// channel or the expired deadline ends the drain). Module scope: Task
/// 3's amplifier tests reuse this collector after the test-file move.
async fn collect_file_paths(
    rx: &mut mpsc::UnboundedReceiver<WatchEvent>,
    window: Duration,
    done: impl Fn(&std::collections::HashSet<PathBuf>) -> bool,
) -> std::collections::HashSet<PathBuf> {
    let mut seen = std::collections::HashSet::new();
    let until = tokio::time::Instant::now() + window;
    while !done(&seen) {
        match tokio::time::timeout_at(until, rx.recv()).await {
            Ok(Some(WatchEvent::FileChanged { paths, .. })) => seen.extend(paths),
            Ok(Some(WatchEvent::ProviderRescan { .. })) => {}
            Ok(None) | Err(_) => break,
        }
    }
    seen
}

/// The one-fd-per-provider restructure's behavioral contract: one shared
/// `RecommendedWatcher` can arm SEVERAL paths; unwatching one path must
/// not disturb the others; unwatch of a never-armed path is tolerated.
///
/// Events are COLLECTED into a set under a deadline with set-membership
/// assertions — never per-`recv` identity: one `std::fs::write` emits
/// several notifications (commonly Create + Modify), so the recv after
/// a second write can deliver the FIRST write's queued companion.
#[tokio::test]
async fn one_watcher_supports_many_targets_and_tolerated_unwatch() {
    let a = unique_temp_dir("onefd-a");
    let b = unique_temp_dir("onefd-b");
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();

    let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "claude", false).expect("create shared watcher");
    watch_path(
        &mut watcher,
        "claude",
        &a,
        notify::RecursiveMode::NonRecursive,
    )
    .unwrap();
    watch_path(
        &mut watcher,
        "claude",
        &b,
        notify::RecursiveMode::NonRecursive,
    )
    .unwrap();

    // Both armed paths deliver events through the ONE watcher (early
    // exit once BOTH prefixes observed; companion events interleave with
    // the second write's, which is exactly why membership — not recv
    // order — is the assertion).
    std::fs::write(a.join("one.txt"), b"x").unwrap();
    std::fs::write(b.join("one.txt"), b"x").unwrap();
    let saw = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
        s.iter().any(|p| p.starts_with(&a)) && s.iter().any(|p| p.starts_with(&b))
    })
    .await;
    assert!(
        saw.iter().any(|p| p.starts_with(&a)),
        "events for a: {saw:?}"
    );
    assert!(
        saw.iter().any(|p| p.starts_with(&b)),
        "events for b: {saw:?}"
    );

    // Unwatch a (twice: the second proves the tolerated path), then
    // verify a's further writes produce nothing while b still delivers.
    // One fixed 700ms window collects every straggler, so the negative
    // assertion runs over the COMPLETE set.
    unwatch_tolerated(&mut watcher, "claude", &a);
    unwatch_tolerated(&mut watcher, "claude", &a); // tolerated no-op, no panic
    std::fs::write(a.join("two.txt"), b"x").unwrap();
    std::fs::write(b.join("two.txt"), b"x").unwrap();
    let after = collect_file_paths(&mut rx, Duration::from_millis(700), |_| false).await;
    assert!(
        after.iter().any(|p| p.starts_with(&b)),
        "b still delivers: {after:?}"
    );
    assert!(
        !after.iter().any(|p| p.starts_with(&a)),
        "no events from the unwatched path may arrive: {after:?}"
    );
    drop(watcher);
    std::fs::remove_dir_all(&a).ok();
    std::fs::remove_dir_all(&b).ok();
}

// ---------- amplifier managed watch set ----------

/// Mirrors `amplifier.rs::tests::write_session` (private to that module —
/// deliberate duplication per crate convention).
fn write_amplifier_session(home: &Path, slug: &str, id: &str) -> PathBuf {
    let dir = home.join("projects").join(slug).join("sessions").join(id);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        format!(
            r#"{{"session_id":"{id}","working_dir":"/p/{slug}","created":"2026-03-01T00:00:00.000Z","name":"t","description":"s","turn_count":1}}"#
        ),
    )
    .unwrap();
    dir
}

fn amplifier_index(home: &Path) -> Arc<SessionIndex> {
    Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![
            Arc::new(crate::amplifier::AmplifierSource::new(home.to_path_buf()))
                as Arc<dyn crate::directory_index::SessionSource>,
        ],
        Duration::from_secs(3600),
        None,
    ))
}

fn amplifier_watcher(index: &Arc<SessionIndex>, home: &Path) -> SessionWatcher {
    SessionWatcher::new(
        Arc::clone(index),
        vec![WatchedProvider {
            layout: Box::new(crate::provider_layout::AmplifierLayout),
            home: home.to_path_buf(),
        }],
    )
}

/// Amplifier index over a `CountingWrapper`, returning the source's call
/// counters next to the index. Negative no-scan tests assert on these
/// counters (OBSERVABLE WORK: an erroneous full/provider discover or
/// scoped stat ALWAYS increments its counter) — never only on
/// `subscribe_changes()`, whose generation bumps only when the published
/// CONTENT changes, so an index-equivalent erroneous sweep would leave
/// the receiver silent while the prohibited CPU work ran anyway. (Only
/// fields a test actually reads live here, or the clippy `-D warnings`
/// gate would flag a dead one.)
struct CountedAmplifierIndex {
    index: Arc<SessionIndex>,
    discover_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
    stat_scoped_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn counted_amplifier_index(home: &Path) -> CountedAmplifierIndex {
    let amplifier = crate::amplifier::AmplifierSource::new(home.to_path_buf());
    let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
    let (discover_calls, _parse_calls, _direct_list_calls, stat_scoped_calls) =
        crate::directory_index::tests::wrapper_counters(&wrapped);
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
        Duration::from_secs(3600),
        None,
    ));
    CountedAmplifierIndex {
        index,
        discover_calls,
        stat_scoped_calls,
    }
}

/// Regression 3 & the start of the watch-reduction proof: startup arms
/// exactly {projects root, per-project sessions dir (or stand-in),
/// root-named session dirs} — never a subagent dir, never a stray file.
#[tokio::test]
async fn amplifier_startup_arms_exactly_the_managed_set() {
    let home = unique_temp_dir("amp-startup");
    // Project named WITH underscore components (regression 3).
    let root_session =
        write_amplifier_session(&home, "my_proj_x", "012584be-9478-4801-a62d-4e5da428b3a0");
    write_amplifier_session(
        &home,
        "my_proj_x",
        "0000000000000000-014b6af1c2ac4ab5_agent",
    );
    // Stand-in project (no sessions/ dir) and a stray file at project depth.
    std::fs::create_dir_all(home.join("projects").join("no_sessions_proj")).unwrap();
    std::fs::write(home.join("projects").join("repl_history"), b"x").unwrap();

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().expect("amplifier book");
    let handle = watcher.start();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&root_session) && !book_has_path_named(&b, "repl_history") {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup arming completes");

    {
        let b = book.lock().unwrap();
        let armed = &b.armed;
        assert!(armed.contains(&home.join("projects")));
        assert!(armed.contains(&home.join("projects").join("my_proj_x").join("sessions")));
        assert!(armed.contains(&root_session));
        assert!(armed.contains(&home.join("projects").join("no_sessions_proj")));
        // Subagent dirs and stray files: never.
        assert!(!book_has_path_named(
            &b,
            "0000000000000000-014b6af1c2ac4ab5_agent"
        ));
        assert!(!book_has_path_named(&b, "repl_history"));
        // Exact count: root + 1 sessions + 1 stand-in + 1 root session dir.
        assert_eq!(armed.len(), 4);
    } // book guard released before the async stop-and-join
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

fn book_has_path_named(b: &ManagedBook, name: &str) -> bool {
    b.armed.iter().any(|p| p.ends_with(name))
}

/// Regression 17b: a deterministic arm failure (path missing by the time
/// the arm runs) leaves the retry set immediately — a reappearance is a
/// fresh structural create anyway.
#[tokio::test]
async fn deterministic_arm_failure_never_enters_retry_set() {
    let home = unique_temp_dir("amp-armerr");
    std::fs::create_dir_all(home.join("projects")).unwrap();

    // The arm helpers are free functions; drive them on a locally-
    // constructed shared watcher + a fresh book + a fresh mark sink — the
    // same helpers the spawned loop calls with ITS watcher/book/sink, but
    // with no loop and no inotify timing at all. (The dropped target here
    // is a SessionDir kind — for the root kind a deterministic failure
    // enters ABSENT instead; see Task 3's Interfaces and Task 4's root
    // lifecycle test.)
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    let ghost = home.join("projects").join("ghost");
    arm_managed_dir(
        &mut book,
        &mut watcher,
        &mut outcome,
        "amplifier",
        &ghost,
        crate::watch_plan::ArmKind::SessionDir,
        false,
    );

    assert!(book.retry.is_empty(), "deterministic failures never retry");
    assert!(!book.armed.contains(&ghost));
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 7 (check→arm window): the stand-in arm IMMEDIATELY re-checks
/// for sessions/ and swaps when it has appeared in the window.
#[tokio::test]
async fn arm_sessions_or_standin_rechecks_sessions_after_arming() {
    let home = unique_temp_dir("amp-toctou");
    let proj = home.join("projects").join("proj");
    std::fs::create_dir_all(&proj).unwrap(); // no sessions/ yet
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();

    // Phase 1: drive the project arm with NO sessions/ — a stand-in arms.
    arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &proj, false);
    assert!(book.armed.contains(&proj));
    assert!(!book.armed.contains(&proj.join("sessions")));

    // Phase 2: sessions/ appears; the armed stand-in must swap to the real
    // sessions dir (the swap path `arm_sessions_or_standin` re-checks after
    // arming AND serves as the recheck on repeat arms), cascading the
    // session child.
    let session = write_amplifier_session(&home, "proj", "012584be-9478-4801-a62d-4e5da428b3a0");
    arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &proj, false);
    assert!(
        book.armed.contains(&proj.join("sessions")),
        "sessions/ armed"
    );
    assert!(
        !book.armed.contains(&proj),
        "stale stand-in removed: {:?}",
        book.armed
    );
    assert!(
        book.armed.contains(&session),
        "the post-arm recheck cascades session children"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Startup race regression (watch-then-scan applied AT STARTUP): a root
/// session dir created AFTER the initial plan scan but BEFORE the
/// structural arms is nevertheless armed — the post-arm readdir union, not
/// the stale scan, decides session-dir arms. Driven deterministically by
/// splitting startup into the same ordered steps the production loop runs
/// and creating the dir at the window; no sleeps, no spawned loop.
#[tokio::test]
async fn startup_arms_session_dirs_created_in_the_scan_arm_window() {
    let home = unique_temp_dir("amp-startup-race");
    let pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let _ = pre; // one pre-existing session (present in the initial scan)
    let index = amplifier_index(&home);
    let projects_root = home.join("projects");

    // Step A of production startup: the initial plan scan.
    let plan = crate::watch_plan::plan_amplifier_targets(&projects_root).unwrap();
    // THE WINDOW: the dir appears after the scan, before the arms (in
    // production the loop calls apply_amplifier_startup_plan immediately
    // after the plan, in the same order, just wrapped in spawn_blocking).
    let windowed = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    // Step B: the structural arms + post-arm rescans (in production this
    // whole step runs inside `spawn_blocking` with the arm outcome handed
    // back to the async loop; here the sync core is driven directly).
    let (tx, mut rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    apply_amplifier_startup_plan(&mut book, &mut watcher, &mut outcome, &projects_root, plan);

    assert!(
        book.armed.contains(&windowed),
        "created between scan and arm ⇒ caught by the post-arm rescan: {:?}",
        book.armed
    );

    // The arm is LIVE: a sidecar write surfaces through the armed watch.
    std::fs::write(windowed.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    let seen = collect_file_paths(&mut rx, Duration::from_secs(2), |s| {
        s.iter().any(|p| p.starts_with(&windowed))
    })
    .await;
    assert!(
        seen.iter().any(|p| p.starts_with(&windowed)),
        "events flow through the window-armed watch: {seen:?}"
    );

    // …and visible in the index once the boot discover runs (startup arms
    // skip file marks by design; the discover covers initial state).
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "bb2584be-9478-4801-a62d-4e5da428b3a0"),
        "window-created session is visible at the first snapshot"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Startup-barrier race, PRODUCTION ORDER (extends
/// `startup_arms_session_dirs_created_in_the_scan_arm_window`): the real
/// boot race is the detached sweep tasks issued while the watcher arms —
/// the warm spawn (`main.rs:1287`) AND `spawn_sessions_sweep`'s initial
/// signature snapshot (`main.rs:2637`). The cold-start publish gate
/// (`SessionIndex::set_startup_gate`, fed by `SessionWatcher::startup_ready`)
/// must hold the FIRST publish until the startup arms settle, so a metadata
/// write landing in the scan↔arm window is visible in that SAME boot
/// snapshot — never stale until the 15-minute reconcile.
#[tokio::test]
async fn boot_snapshot_gate_covers_window_raced_writes() {
    let home = unique_temp_dir("amp-barrier");
    let _pre = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    // Production order (main.rs): construct → consumers subscribe via
    // `startup_ready()` → `start()`. The accessor clones the retained
    // receiver, so the gate install AND this test's awaiter both subscribe
    // before start — exactly as the main.rs wiring does.
    index.set_startup_gate(watcher.startup_ready());
    let mut ready = watcher.startup_ready();
    let book = watcher.amplifier_book_handle().unwrap();

    // The sessions sweep's boot snapshot (main.rs:2637): issued
    // immediately, pre-start — the task that raced ahead ungated in
    // production.
    let mut early = tokio::spawn({
        let index = Arc::clone(&index);
        async move { index.snapshot().await }
    });

    // The raced write: lands after the sweep's call, before its arm
    // (startup is markless by design).
    let racer = write_amplifier_session(&home, "p", "cc2584be-9478-4801-a62d-4e5da428b3a0");

    // Deterministic gate proof (no sleep-race): `timeout` DRIVES `early` —
    // ungated, the snapshot completes right here (a pre-arm publish, the
    // bug, and the assertion fails); gated, it can only still be pending —
    // the gate cannot open because `start()` has not been called, so the
    // 250ms window's length decides nothing.
    assert!(
        tokio::time::timeout(Duration::from_millis(250), &mut early)
            .await
            .is_err(),
        "the boot sweep's snapshot is gated: no publish before watcher readiness"
    );

    let handle = watcher.start();

    // Readiness fires only AFTER the startup arms settle; the raced dir is
    // provably armed by then.
    tokio::time::timeout(Duration::from_secs(5), ready.wait_for(|done| *done))
        .await
        .expect("startup readiness fires")
        .expect("sender alive");
    assert!(
        book.lock().unwrap().armed.contains(&racer),
        "readiness implies the raced dir is armed"
    );

    // The boot sweep's OWN snapshot — the first post-readiness publish —
    // covers the window-raced write. NO provider-dirty kick: the production
    // boot sequence makes no such call.
    let items = tokio::time::timeout(Duration::from_secs(5), early)
        .await
        .expect("the gated snapshot completes after readiness")
        .unwrap();
    assert!(
        items
            .iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "cc2584be-9478-4801-a62d-4e5da428b3a0"),
        "the first post-readiness publish covers the window-raced write"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 7 (event path): a `sessions/` dir created under a stand-in
/// project is observed — the stand-in swaps to the real sessions watch, and
/// existing session dirs under it are armed and scanned.
#[tokio::test]
async fn sessions_dir_created_after_standin_arm_is_picked_up() {
    let home = unique_temp_dir("amp-standin-swap");
    let proj = home.join("projects").join("late_proj");
    std::fs::create_dir_all(&proj).unwrap(); // no sessions/ yet

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Stand-in armed.
    assert!(book.lock().unwrap().armed.contains(&proj));

    // sessions/ + a root session appear while only the stand-in is armed.
    let session =
        write_amplifier_session(&home, "late_proj", "550e8400-e29b-41d4-a716-4466554400aa");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&session) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("stand-in swap observed events and armed the session dir");
    // The stand-in itself is gone; the sessions dir is armed.
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&proj.join("sessions")));
        assert!(!b.armed.contains(&proj));
    }
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// New-project cascade: `create_dir_all(proj/sessions/<id>)` surfaces ONE
/// `Create(<proj>)` at the root; the cascade arms sessions + root session
/// and the watch-then-scan marks metadata.json (the row appears).
#[tokio::test]
async fn new_project_cascade_arms_and_scans() {
    let home = unique_temp_dir("amp-cascade");
    std::fs::create_dir_all(home.join("projects")).unwrap();
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;

    let session =
        write_amplifier_session(&home, "brand_new", "550e8400-e29b-41d4-a716-4466554400bb");

    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("cascade's watch-then-scan mark refreshes the index")
        .unwrap();

    assert!(book.lock().unwrap().armed.contains(&session));
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "550e8400-e29b-41d4-a716-4466554400bb"),
        "the cascade's scoped mark made the new session visible immediately"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 14 (first half): with no subagent interest, a subagent-named
/// mkdir under a watched sessions dir is dropped silently (no provider
/// dirty, no arm) — the 15-minute reconcile owns it. The negative phase pins
/// OBSERVABLE WORK (`discover_calls`), not just the generation wait: an
/// erroneous escalation runs a full amplifier discover whose identical
/// content would NOT bump the generation, so a `subscribe_changes()` timeout
/// alone is vacuous for the prohibited CPU work.
#[tokio::test]
async fn subagent_mkdir_dropped_when_no_interest_escalates_when_interested() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let home = unique_temp_dir("amp-subgate");
    let root_session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let _ = root_session;
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let interest = Arc::new(AtomicUsize::new(0));
    let mut watcher =
        amplifier_watcher(&index, &home).with_subagent_interest(Arc::clone(&interest));
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);

    // Off: subagent dir creation is ignored — no index traffic AND no
    // discover sweep ran at all (the 700ms window covers the 200ms
    // debounce flush and the fire-and-forget background refresh).
    let sub = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_new");
    std::fs::create_dir_all(&sub).unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(700), rx.changed())
            .await
            .is_err(),
        "no-interest subagent mkdir must not refresh the index"
    );
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "an erroneous escalation would have run a discover (observable work)"
    );
    assert!(!book.lock().unwrap().armed.contains(&sub));

    // On: provider dirty — a full amplifier discover picks the row up
    // (observable: both the generation bump AND the discover counter).
    interest.store(1, Ordering::SeqCst);
    std::fs::write(
        sub.join("metadata.json"),
        r#"{"session_id":"s","working_dir":"/p/x","parent_id":"par","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    let sub2 = sub
        .parent()
        .unwrap()
        .join("0000000000000000-014b6af1c2ac4ab5_second");
    std::fs::create_dir_all(&sub2).unwrap();
    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("interested subagent mkdir escalates to provider dirty")
        .unwrap();
    assert!(
        counted.discover_calls.load(Ordering::SeqCst) > baseline_discovers,
        "the interested escalation ran a real discover"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Whole-branch review Finding 2: an INTERESTED subagent-mkdir escalation
/// is the design's provider-dirty lever (design "Subagent-dir mkdir events
/// escalate to provider-dirty (full amplifier discover) ONLY while the
/// subagents-subscribed flag is set") — NOT a strict whole-tree watch-set
/// replan per interested-burst flush. The replan path is reserved for true
/// need_rescan / queue-overflow events. The escalation still runs a REAL
/// discover (observable: `discover_calls` moves — the find-the-row work
/// the toggle is paying for) while `book.replans` (applied replans only)
/// stays put.
#[tokio::test]
async fn interested_subagent_mkdir_escalates_to_provider_dirty_without_replan() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    let home = unique_temp_dir("amp-subgate-dirtyonly");
    let _root = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let interest = Arc::new(AtomicUsize::new(1)); // interested from the start
    let mut watcher =
        amplifier_watcher(&index, &home).with_subagent_interest(Arc::clone(&interest));
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
    let baseline_replans = book.lock().unwrap().replans;

    let sub = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_new");
    std::fs::create_dir_all(&sub).unwrap();

    // The escalation fires as a provider dirty: a real amplifier discover
    // runs (observable work), exactly as designed.
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if counted.discover_calls.load(Ordering::SeqCst) > baseline_discovers {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("interested subagent mkdir escalates to provider dirty");

    // ...but it must NOT pay a watch-set replan: a subagent mkdir is not a
    // need_rescan, so the applied-replans counter stays put.
    assert_eq!(
        book.lock().unwrap().replans,
        baseline_replans,
        "the subagent-mkdir escalation is provider-dirty only, not a replan"
    );
    assert!(
        !book.lock().unwrap().armed.contains(&sub),
        "subagent dirs are never armed"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Retry lifecycle (design "Absence/retry"): a transient arm failure lands
/// in `retry`; the rearm tick's drain re-attempts it once `next_attempt`
/// arrives — a STILL-failing attempt re-enters with doubled backoff, and
/// once the dir's access is restored the drain arms it. One transient
/// failure must never suppress the watch indefinitely. Uses the crate's
/// established `with_rearm_interval` short-interval seam so the REAL loop's
/// tick drives the drain.
#[cfg(unix)]
#[tokio::test]
async fn transient_arm_failure_is_retried_by_the_rearm_drain_and_eventually_arms() {
    use std::os::unix::fs::PermissionsExt;
    let home = unique_temp_dir("amp-retry");
    let victim = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);

    // Make the session dir unwatchable: inotify_add_watch needs read
    // permission, so watch() fails EACCES (Transient ⇒ retry, never absent).
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&victim).is_ok() {
        eprintln!("skipping retry-drain assertions: euid can list a 0o000 dir");
        std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::fs::remove_dir_all(&home).ok();
        return;
    }

    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1); // 1s tick
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();

    // Phase 1: the startup arm fails transiently and the entry sits in
    // `retry` (startup arms run inside the loop; no tick wait needed).
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().retry.contains_key(&victim) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("transient arm failure lands in retry");
    let failures_at_insert = book.lock().unwrap().retry[&victim].failures;

    // Phase 2: a re-attempt while access is STILL denied re-enters with an
    // incremented failure count (backoff doubled). Force due immediacy via
    // the book handle so the 1s tick processes it at once.
    book.lock()
        .unwrap()
        .retry
        .get_mut(&victim)
        .unwrap()
        .next_attempt = std::time::Instant::now() - Duration::from_secs(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let grown = {
                let b = book.lock().unwrap();
                !b.armed.contains(&victim)
                    && b.retry
                        .get(&victim)
                        .is_some_and(|e| e.failures > failures_at_insert)
            };
            if grown {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("failed re-attempt re-enters retry with doubled backoff");

    // Phase 3: restore access and force due again — the drain re-arms the
    // dir and clears the retry entry, with no new filesystem event.
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o755)).unwrap();
    book.lock()
        .unwrap()
        .retry
        .get_mut(&victim)
        .unwrap()
        .next_attempt = std::time::Instant::now() - Duration::from_secs(1);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&victim) && !b.retry.contains_key(&victim) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("retry drain eventually arms the restored dir");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Absence lifecycle, startup half (design: the provider root is the ONLY
/// target that re-enters absence tracking): root missing at startup →
/// absent; once it appears, the rearm tick re-arms it AND runs the full
/// structural cascade (plan + apply, `emit_marks: true`), so sessions
/// created while it was absent are armed AND scanned first-line — no
/// reconcile wait. Uses the established `with_rearm_interval` idiom. (The
/// deletion half — armed root → depth-0 removal routing → absent — is
/// Task 4's `deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return`.)
#[tokio::test]
async fn absent_projects_root_at_startup_rearms_with_full_cascade_on_return() {
    let home = unique_temp_dir("amp-absent-boot");
    std::fs::create_dir_all(&home).unwrap(); // no projects/ yet
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    let projects = home.join("projects");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().absent.contains(&projects) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("root missing at startup enters absent tracking");

    // The root appears — WITH a session created underneath it while absent,
    // so only the cascade (not any in-flight event) can see it.
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(8), rx.changed())
        .await
        .expect("the return cascade's marks refresh the index (1s rearm tick)")
        .unwrap();
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&projects), "returned root re-armed");
        assert!(b.armed.contains(&projects.join("p").join("sessions")));
        assert!(b.armed.contains(&session), "cascade armed the session dir");
        assert!(!b.absent.contains(&projects));
    }
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "012584be-9478-4801-a62d-4e5da428b3a0"),
        "visible first-line — never deferred to the 15-minute reconcile"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// The retry schedule is bounded exponential: 1, 2, 4, … 60s cap, no
/// overflow — asserted against the pure fn without sleeping.
#[test]
fn retry_backoff_doubles_to_a_sixty_second_cap() {
    assert_eq!(retry_backoff(0), Duration::from_secs(1));
    assert_eq!(retry_backoff(1), Duration::from_secs(2));
    assert_eq!(retry_backoff(2), Duration::from_secs(4));
    assert_eq!(retry_backoff(4), Duration::from_secs(16));
    assert_eq!(retry_backoff(6), Duration::from_secs(60), "hits the cap");
    assert_eq!(retry_backoff(7), Duration::from_secs(60), "capped");
    assert_eq!(retry_backoff(100), Duration::from_secs(60), "no overflow");
}

// ---------- removes / renames / resource alarms ----------

/// Regression 13: `mv` of a root session dir within the same sessions/ dir
/// shows up as Name(Both) (or From+To); the new basename is re-armed
/// first-line and its files keep producing events.
#[tokio::test]
async fn renamed_root_session_dir_is_rearmed_immediately() {
    let home = unique_temp_dir("amp-rename");
    let old = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&old));

    let new = old
        .parent()
        .unwrap()
        .join("aa2584be-9478-4801-a62d-4e5da428b3a0");
    std::fs::rename(&old, &new).unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&new) && !b.armed.contains(&old) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("renamed session dir re-armed first-line, old entry forgotten");

    // Keep proving the new watch is live: a transcript append refreshes
    // the index without a provider discover.
    std::fs::write(
        new.join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "events flow through the re-armed watch");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// LB-01 probe (notify 6.1.1): renaming an ARMED session dir emits the
/// tracked From/To/Both trio AND a 4th, UNTRACKED duplicate `Name(From)`
/// on the old path (notify's mapping of the child watch's IN_MOVE_SELF),
/// arriving after the trio. Structural-remove handling must be idempotent:
/// the duplicate re-processes a path already removed from every
/// bookkeeping set.
#[tokio::test]
async fn armed_child_rename_duplicate_name_from_is_idempotent() {
    let home = unique_temp_dir("amp-rename-idem");
    let old = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&old));

    let new = old
        .parent()
        .unwrap()
        .join("aa2584be-9478-4801-a62d-4e5da428b3a0");
    std::fs::rename(&old, &new).unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                if b.armed.contains(&new) && !b.armed.contains(&old) {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("renamed dir re-armed under the new path, old forgotten");
    // Settle past the 4th, untracked duplicate Name(From) (it arrives
    // after the trio), then re-assert the settled bookkeeping.
    tokio::time::sleep(Duration::from_millis(300)).await;
    {
        let b = book.lock().unwrap();
        assert_eq!(
            b.armed.iter().filter(|p| **p == new).count(),
            1,
            "exactly one armed entry for the new path"
        );
        assert!(
            !b.armed.contains(&old),
            "duplicate From re-removal is a no-op"
        );
        assert!(!b.absent.contains(&old) && !b.retry.contains_key(&old));
        // No double-WARN is structural on this path: re-processing the
        // duplicate From hits only the book-miss no-op and
        // `unwatch_tolerated`'s debug-tier tolerated arm (the managed-set
        // auto-drop makes unwatch of the moved path return WatchNotFound)
        // — no warn site is reachable, so there is no log to count.
    }

    // Events from the renamed dir keep flowing (the duplicate From did not
    // tear down the fresh arm).
    let _ = rx.borrow_and_update();
    std::fs::write(
        new.join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"hi\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "events flow through the re-armed watch");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 8 (first half): removing a watched session dir prunes its row
/// promptly (scoped metadata.json mark → stat None → prune) and forgets all
/// bookkeeping.
#[tokio::test]
async fn session_dir_removal_prunes_rows_and_forgets_bookkeeping() {
    let home = unique_temp_dir("amp-sessrm");
    let victim = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let snap0 = index.snapshot().await;
    assert_eq!(
        snap0.iter().filter(|s| s.provider == "amplifier").count(),
        1
    );
    tokio::time::sleep(Duration::from_millis(300)).await;

    std::fs::remove_dir_all(&victim).unwrap();

    let mut pruned = false;
    for _ in 0..50 {
        if index
            .snapshot()
            .await
            .iter()
            .filter(|s| s.provider == "amplifier")
            .count()
            == 0
            && !book.lock().unwrap().armed.contains(&victim)
        {
            pruned = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(pruned, "row pruned AND watch bookkeeping forgotten");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 16: structural removal of a whole project cleans armed/absent/
/// retry bookkeeping (no forever-retrying entries after project deletion).
#[tokio::test]
async fn project_move_or_remove_cleans_all_bookkeeping() {
    let home = unique_temp_dir("amp-projrm");
    let proj = home.join("projects").join("doomed");
    let sess = write_amplifier_session(&home, "doomed", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    // Seed a retry entry under the project to prove cleanup reaches it.
    book.lock().unwrap().retry.insert(
        proj.join("should_never_exist"),
        RetryEntry {
            failures: 1,
            next_attempt: std::time::Instant::now(),
            kind: crate::watch_plan::ArmKind::SessionDir,
        },
    );
    assert!(book.lock().unwrap().armed.contains(&sess));

    std::fs::remove_dir_all(&proj).unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            {
                let b = book.lock().unwrap();
                let proj_prefix = proj.to_path_buf();
                let clean = !b.armed.iter().any(|p| p.starts_with(&proj_prefix))
                    && !b.absent.iter().any(|p| p.starts_with(&proj_prefix))
                    && !b.retry.keys().any(|p| p.starts_with(&proj_prefix));
                if clean {
                    break;
                }
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("project subtree dropped from armed/absent/retry");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 16 second clause: a session dir `mv`'d OUT of the watched
/// tree is explicitly unwatched (inotify watches follow inodes — without
/// this, events keep arriving under the stale old path forever).
/// Caveat (LB-01 sub-claim 3 nuance): in the managed-set shape the parent
/// arm's MOVED_FROM auto-drops the old-path watch, so the negative window
/// below cannot catch a MISSING explicit-unwatch regression (post-move
/// writes would be silent either way); the explicit unwatch stays as
/// belt-and-braces for the unowned-parent (inode-follow) shape.
#[tokio::test]
async fn moved_away_session_dir_is_explicitly_unwatched() {
    let home = unique_temp_dir("amp-mvout");
    let sess = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;

    let outside = home.join("outside-escaped-session");
    std::fs::rename(&sess, &outside).unwrap();
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if !book
                .lock()
                .unwrap()
                .armed
                .iter()
                .any(|p| p.ends_with("012584be-9478-4801-a62d-4e5da428b3a0"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("moved-away dir forgotten");

    // Writing where the dir moved to must produce NO further index traffic
    // (the watch would still fire under the stale path if it leaked).
    let _ = rx.borrow_and_update(); // clear any pending
    std::fs::write(outside.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(700), rx.changed())
            .await
            .is_err(),
        "no events from an unwatched inode"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// 25% watch-budget WARN: pure verdict + real procfs probe.
#[test]
fn watch_budget_warn_needed_trips_only_above_a_quarter_of_the_limit() {
    assert!(!watch_budget_warn_needed(524_288 / 4, 524_288));
    assert!(watch_budget_warn_needed(524_288 / 4 + 1, 524_288));
    assert!(!watch_budget_warn_needed(2, 524_288));
    // Real machine (Linux/WSL always has procfs here): parser sanity.
    if std::path::Path::new("/proc/sys/fs/inotify/max_user_watches").exists() {
        let max = read_max_user_watches().expect("parse the kernel limit");
        assert!(max > 1_000);
    }
}

/// Drift alarm: daily-bucketed, warns once per day on crossing.
#[test]
fn unknown_format_drift_alarm_is_daily_bucketed() {
    let mut counter = DailyCounter::default();
    let day0 = std::time::UNIX_EPOCH + Duration::from_secs(1_700_000_000u64);
    // Below the threshold: quiet.
    for _ in 0..DRIFT_DAILY_WARN_THRESHOLD - 1 {
        assert!(counter.note_unknown_arm(day0).is_none());
    }
    // Crossing: exactly one WARN.
    assert!(counter.note_unknown_arm(day0).is_some());
    assert!(
        counter.note_unknown_arm(day0).is_none(),
        "warn once per day"
    );
    // Next day: fresh budget.
    let day1 = day0 + Duration::from_secs(86_400);
    assert!(counter.note_unknown_arm(day1).is_none());
}

/// Projects-root absence lifecycle (design: "Only the provider root itself
/// re-enters absence tracking when it disappears"): deleting the ARMED
/// projects root routes it from `armed` to `absent` via the DEPTH-0
/// self-removal (the kernel surfaces it tagless — LB-01 `Remove(File)`),
/// with the subtree's bookkeeping wiped; re-creating the root re-arms it
/// at the rearm tick and the FULL structural cascade (plan + apply,
/// `emit_marks: true`) arms sessions created while the root was absent —
/// first-line, without waiting for the 15-minute reconcile.
#[tokio::test]
async fn deleted_projects_root_enters_absence_and_rearms_with_full_cascade_on_return() {
    let home = unique_temp_dir("amp-rootabsent");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let _ = session;
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home).with_rearm_interval(1);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    let projects = home.join("projects");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&projects) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("projects root armed at startup");

    // Delete the whole root: the depth-0 self-removal routes it to absent
    // and wipes the subtree bookkeeping.
    std::fs::remove_dir_all(&projects).unwrap();
    // The teardown's provider-dirty publish lands first (generation bump);
    // consume it so the later `changed()` await is the RETURN's publish.
    let _ = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let gone = {
                let b = book.lock().unwrap();
                b.absent.contains(&projects)
                    && !b.armed.iter().any(|p| p.starts_with(&projects))
                    && !b.retry.keys().any(|p| p.starts_with(&projects))
            };
            if gone {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("deleted root enters absent; whole subtree forgotten");

    // Re-create the root WITH a session while it is tracked absent — this
    // session was created while NO watch covered it, so only the
    // absent → re-arm full cascade can pick it up first-line.
    let _ = rx.borrow_and_update();
    let returned = write_amplifier_session(&home, "p", "bb2584be-9478-4801-a62d-4e5da428b3a0");
    tokio::time::timeout(Duration::from_secs(8), rx.changed())
        .await
        .expect("the return cascade's marks refresh the index promptly (1s rearm tick)")
        .unwrap();
    {
        let b = book.lock().unwrap();
        assert!(b.armed.contains(&projects), "returned root re-armed");
        assert!(b.armed.contains(&projects.join("p").join("sessions")));
        assert!(
            b.armed.contains(&returned),
            "session created during the absence armed by the cascade"
        );
        assert!(!b.absent.contains(&projects));
    }
    let snap = index.snapshot().await;
    assert!(
        snap.iter()
            .any(|s| s.provider == "amplifier"
                && s.session_id == "bb2584be-9478-4801-a62d-4e5da428b3a0"),
        "the returned session is visible without waiting for the reconcile"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// The 25% watch-budget WARN is edge-triggered and re-evaluated after
/// EVERY arm batch (startup apply, cascade, retry drain, replan,
/// absent-return), not only at startup: crossing ≤25% → >25% warns exactly
/// once, staying above stays quiet, and falling back below re-arms the
/// edge so the NEXT crossing warns again. The kernel limit is injected —
/// no procfs dependency and no real 4.4K-arm corpus needed.
#[test]
fn watch_budget_warn_fires_once_per_crossing_and_rearms_below() {
    let max = 100usize; // injected max_user_watches (test-only injection)
    let mut warned = false;
    // Exactly 1/4 (25 of 100): NOT above the quarter — no warn.
    let (w, emit) = watch_budget_edge(warned, 25, max);
    assert!(!emit, "at exactly the quarter: silent");
    warned = w;
    // Cross above: the edge fires exactly once.
    let (w, emit) = watch_budget_edge(warned, 26, max);
    assert!(emit, "crossing above 25% warns");
    warned = w;
    // More arms while already warned: no per-arm spam.
    let (w, emit) = watch_budget_edge(warned, 40, max);
    assert!(!emit, "already warned: silent");
    warned = w;
    // Falling back below re-arms the edge silently...
    let (w, emit) = watch_budget_edge(warned, 20, max);
    assert!(!emit, "falling back below: silent");
    warned = w;
    // ...and the next crossing warns again.
    let (_, emit) = watch_budget_edge(warned, 27, max);
    assert!(emit, "re-armed edge warns on the next crossing");
}

// ---------- file-depth routing ----------

/// Regression 5: sidecar/tmp/backup churn inside a watched root session dir
/// produces scoped metadata.json marks — never provider-dirty; steady
/// activity triggers no repeated full discovers.
#[tokio::test]
async fn amplify_file_depth_events_route_to_scoped_metadata_marks_and_never_escalate() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-filedepth");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let amplifier = crate::amplifier::AmplifierSource::new(home.clone());
    let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
    let (discover_calls, _, _, _) = crate::directory_index::tests::wrapper_counters(&wrapped);
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
        Duration::from_secs(3600),
        None,
    ));
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&session));
    let baseline_discovers = discover_calls.load(Ordering::SeqCst);

    // Steady heavy activity: sidecar append + tmp+rename metadata (VALID
    // content, so the row stays) + backup + the other sidecar.
    std::fs::write(session.join("transcript.jsonl"), "{\"type\":\"user\"}\n").unwrap();
    std::fs::write(
        session.join("metadata.json.tmp"),
        r#"{"session_id":"s1","working_dir":"/p/p","created":"2026-03-01T00:00:00.000Z","name":"t2"}"#,
    )
    .unwrap();
    std::fs::rename(
        session.join("metadata.json.tmp"),
        session.join("metadata.json"),
    )
    .unwrap();
    std::fs::write(session.join("metadata.json.backup"), b"{}").unwrap();
    std::fs::write(session.join("events.jsonl"), "{}\n").unwrap();

    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "scoped marks refresh the index");
    let mut settles = 0;
    for _ in 0..20 {
        if !index.has_dirty() {
            settles += 1;
            if settles >= 2 {
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(
        discover_calls.load(Ordering::SeqCst) == baseline_discovers,
        "no repeated full discovers: baseline {baseline_discovers}, now {}",
        discover_calls.load(Ordering::SeqCst)
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 6: a `context-intelligence/` mkdir inside a session dir
/// results in NO index activity at all (dropped at depth 4). The pins are
/// OBSERVABLE WORK, not just the generation wait: a directory created at
/// depth 4 must produce NO scoped mark (`stat_scoped_calls` never moves —
/// had the mkdir been rewritten to a metadata.json mark, the background
/// refresh would have stat'ed it) AND no provider-scan work
/// (`discover_calls` never moves — an erroneous escalation's discover over
/// identical content would not bump the generation, so the receiver timeout
/// alone would be vacuous). The `WatchKind::CreateFolder` distinction
/// (Task 2) is what lets this routing exist.
#[tokio::test]
async fn mkdir_inside_watched_session_dir_is_dropped_no_discover() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-mkdir-drop");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&session));
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
    let baseline_scoped_stats = counted.stat_scoped_calls.load(Ordering::SeqCst);

    std::fs::create_dir_all(session.join("context-intelligence")).unwrap();
    std::fs::write(
        session.join("context-intelligence").join("index.json"),
        b"{}",
    )
    .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(800), rx.changed())
            .await
            .is_err(),
        "folder mkdir + its contents never reach the index"
    );
    // Past the 200ms debounce flush and the fire-and-forget refresh: the
    // mkdir produced no mark and no sweep.
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "no discover ran for the depth-4 mkdir"
    );
    assert_eq!(
        counted.stat_scoped_calls.load(Ordering::SeqCst),
        baseline_scoped_stats,
        "no scoped stat ran — the mkdir created NO mark either"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Regression 14b: events under a stand-in watch that aren't `sessions/`
/// (the real `{project}/recipe-sessions/` tree) are dropped by default.
/// Same observable-work pins as the other negative tests: neither a
/// discover nor a scoped stat may run for the dropped tree.
#[tokio::test]
async fn standin_project_children_other_than_sessions_are_dropped() {
    use std::sync::atomic::Ordering;
    let home = unique_temp_dir("amp-standin-drop");
    let proj = home.join("projects").join("{project}");
    std::fs::create_dir_all(&proj).unwrap(); // stand-in target
    let counted = counted_amplifier_index(&home);
    let index = counted.index.clone();
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert!(book.lock().unwrap().armed.contains(&proj));
    let baseline_discovers = counted.discover_calls.load(Ordering::SeqCst);
    let baseline_scoped_stats = counted.stat_scoped_calls.load(Ordering::SeqCst);

    let odd = proj.join("recipe-sessions").join("nested");
    std::fs::create_dir_all(&odd).unwrap();
    std::fs::write(odd.join("data.json"), b"{}").unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(800), rx.changed())
            .await
            .is_err(),
        "recipes tree is dropped"
    );
    assert_eq!(
        counted.discover_calls.load(Ordering::SeqCst),
        baseline_discovers,
        "no discover ran for dropped stand-in children"
    );
    assert_eq!(
        counted.stat_scoped_calls.load(Ordering::SeqCst),
        baseline_scoped_stats,
        "no scoped mark was created for dropped stand-in children"
    );
    // And nothing under it got armed.
    {
        let b = book.lock().unwrap();
        assert!(!b
            .armed
            .iter()
            .any(|p| p.to_string_lossy().contains("recipe-sessions")));
    } // guard released before the async stop-and-join
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

// ---------- debounce cap + rescan replan ----------

/// Regression 10: a sustained sub-200ms event stream can no longer starve
/// the flush — it fires within the 2s max-deferral cap even while events
/// keep arriving. Timing discipline (the crate's real-time idiom, with
/// margins so a CORRECT implementation can never flake this): measure from
/// the stream's start (the first write lands ~immediately after spawn,
/// milliseconds before the first event is processed); the outer timeout is
/// 5s — comfortably larger than the 2s cap, so it can only trip on a
/// genuinely starved flush, never on a correct cap-limited one; the cap
/// assertion itself carries 500ms of notify/scheduling slack.
#[tokio::test]
async fn sustained_sub_gap_event_stream_flushes_within_max_deferral() {
    let home = unique_temp_dir("amp-debounce-cap");
    let session = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    let _ = rx.borrow_and_update();
    tokio::time::sleep(Duration::from_millis(300)).await;

    // Producer: 100ms-spaced sidecar writes; spans ~3s of continuous input.
    let transcript = session.join("transcript.jsonl");
    let stream_started = tokio::time::Instant::now();
    let producer = tokio::spawn(async move {
        for i in 0..28u32 {
            std::fs::write(&transcript, format!("{{\"i\":{i}}}\n")).unwrap();
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    // Without the cap the flush lands at producer-end (~2.8s) + 200ms quiet
    // gap ≈ 3.0s from stream start; with it, ≈2s after the first event.
    tokio::time::timeout(Duration::from_secs(5), rx.changed())
        .await
        .expect("flush never starves past 5s (outer timeout ≫ 2s cap)")
        .unwrap();
    let elapsed = stream_started.elapsed();
    assert!(
        elapsed >= Duration::from_millis(150),
        "the 200ms quiet gap is still respected (asserted with 50ms slack): {elapsed:?}"
    );
    assert!(
        elapsed <= Duration::from_millis(2_500),
        "flush within cap + 500ms slack of the stream start (first event ≈ start): {elapsed:?}"
    );
    producer.abort();
    let _ = producer.await;
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// need_rescan (IN_Q_OVERFLOW) on amplifier = full watch-set replan AND
/// provider dirty; on claude it stays provider-dirty only.
#[tokio::test]
async fn need_rescan_on_amplifier_replans_the_watch_set() {
    let home = unique_temp_dir("amp-replan");
    let _s1 = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    // The event channel is allocated at construction (Interfaces), so the
    // sender is valid BEFORE start() — this ordering is intentional.
    let tx = watcher.test_event_tx().expect("test event seam");
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::sleep(Duration::from_millis(300)).await;
    let initial_replans = book.lock().unwrap().replans;

    // Inject a synthetic queue-overflow rescan for amplifier.
    tx.send(WatchEvent::ProviderRescan {
        provider: "amplifier".to_string(),
    })
    .unwrap();

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().replans > initial_replans {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("rescan triggered a replan");
    // Bookkeeping is still consistent afterwards.
    assert!(book.lock().unwrap().armed.contains(&_s1));
    // The permanent projects-root watch survives the replan — the desired
    // kind-map includes `{ projects_root → ProjectsRoot }` whenever the
    // root exists, so the diff can never classify the structural root
    // watch as stale and unwatch it.
    assert!(
        book.lock().unwrap().armed.contains(&home.join("projects")),
        "the structural projects-root watch is never replanned away"
    );
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// Replan abort discipline, two phases: (1) a chmod-000 projects root
/// propagates EACCES from `open_root_dir`; (2) the NESTED partial-scan
/// case — root and project listable, `p/sessions` unreadable, which Task
/// 1's strict planner turns into a whole-plan `Err` rather than a partial
/// plan. In both, the replan ABORTS — no arm/unwatch diff is applied, the
/// armed set and all bookkeeping stay untouched, `book.replans` (APPLIED
/// replans only) does not move — while the provider-dirty mark STILL
/// fires, observable in phase 1 as a recorded `amplifier` scan failure via
/// discover's own root-listing protection.
#[cfg(unix)]
#[tokio::test]
async fn replan_aborts_and_keeps_armed_set_on_planner_error() {
    use std::os::unix::fs::PermissionsExt;
    let home = unique_temp_dir("amp-replan-abort");
    let s1 = write_amplifier_session(&home, "p", "012584be-9478-4801-a62d-4e5da428b3a0");
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    // Construction-time channel: the sender is valid before start().
    let tx = watcher.test_event_tx().expect("test event seam");
    let handle = watcher.start();
    let _ = index.snapshot().await;
    assert!(index.scan_failures().is_empty());
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut armed_before: Vec<PathBuf> = book.lock().unwrap().armed.iter().cloned().collect();
    armed_before.sort();
    let replans_before = book.lock().unwrap().replans;
    assert!(armed_before.iter().any(|p| p == &s1));

    // Transient planner failure: the projects root becomes UNLISTABLE.
    // (stat still succeeds — only read_dir fails — so the rearm tick sees
    // `exists() == true` and does not churn the armed set.)
    let projects = home.join("projects");
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&projects).is_ok() {
        eprintln!("skipping planner-error assertions: euid can list a 0o000 dir");
        std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
        watcher.stop();
        let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        std::fs::remove_dir_all(&home).ok();
        return;
    }

    tx.send(WatchEvent::ProviderRescan {
        provider: "amplifier".to_string(),
    })
    .unwrap();

    // The provider-dirty mark STILL fired: discover's root-listing
    // protection records a scan failure instead of gutting the snapshot
    // (data plane recovers through discover's own protection).
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if index.scan_failures().iter().any(|n| n == "amplifier") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await
    .expect("provider dirty still fired (amplifier scan failure recorded)");

    // The ABORT left every watch-set facet untouched: no arm/unwatch diff
    // was applied, bookkeeping is unchanged, and the applied-only replan
    // counter did not increment.
    {
        let b = book.lock().unwrap();
        let mut armed_after: Vec<PathBuf> = b.armed.iter().cloned().collect();
        armed_after.sort();
        assert_eq!(armed_after, armed_before, "aborted replan applies no diff");
        assert!(b.absent.is_empty() && b.retry.is_empty());
        assert_eq!(
            b.replans, replans_before,
            "book.replans counts APPLIED replans only"
        );
    }

    // Phase 2 — the NESTED partial-scan case: the projects root lists fine
    // and project `p` lists fine, but `p/sessions` is unreadable. Task 1's
    // strict planner fails the WHOLE plan on this (no partial plan), so the
    // replan must abort identically — before the strict-everywhere contract
    // this shape silently produced a partial plan whose unwatch diff would
    // tear down p's healthy root-session watch.
    std::fs::set_permissions(&projects, std::fs::Permissions::from_mode(0o755)).unwrap();
    let sessions = projects.join("p").join("sessions");
    std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o000)).unwrap();
    tx.send(WatchEvent::ProviderRescan {
        provider: "amplifier".to_string(),
    })
    .unwrap();
    // Bounded settle (the suite's negative-window idiom): long enough for a
    // buggy diff-applying replan to have run, then assert nothing changed.
    tokio::time::sleep(Duration::from_millis(700)).await;
    {
        let b = book.lock().unwrap();
        let mut armed_nested: Vec<PathBuf> = b.armed.iter().cloned().collect();
        armed_nested.sort();
        assert_eq!(
            armed_nested, armed_before,
            "nested scan error also aborts: the armed set is untouched"
        );
        assert!(b.absent.is_empty() && b.retry.is_empty());
        assert_eq!(b.replans, replans_before, "still no applied replan");
    }
    std::fs::set_permissions(&sessions, std::fs::Permissions::from_mode(0o755)).unwrap();

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

/// The replan applies arm diffs KIND-CORRECTLY (never flattened): a
/// `sessions/` dir first discovered by the REPLAN (not startup, not an
/// event cascade — its create events were lost) is armed as
/// `ArmKind::SessionsDir`, so the arm CASCADES: its root-session children
/// are armed first-line and their scoped metadata.json marks are emitted.
/// A flattened bare-path arm would leave those children unwatched —
/// silent staleness against the hard zero-latency requirement. Driven
/// through the sync core with the established no-loop idiom.
#[tokio::test]
async fn replan_arms_newly_appeared_sessions_dir_kind_correctly_with_cascade() {
    let home = unique_temp_dir("amp-replan-kind");
    let session = write_amplifier_session(&home, "late", "550e8400-e29b-41d4-a716-4466554400aa");
    let metadata = session.join("metadata.json");
    let projects_root = home.join("projects");
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    // Seed the book as if startup armed ONLY the projects root (the `late`
    // project appeared later and its events were lost — the replan is the
    // recovery path, so nothing below the root is armed yet).
    book.armed.insert(projects_root.clone());
    let mut outcome = ArmOutcome::default();

    let applied = replan_amplifier_watch_set(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        "amplifier",
    );

    let sessions_dir = projects_root.join("late").join("sessions");
    assert!(applied, "a clean plan applies");
    assert!(book.armed.contains(&sessions_dir), "sessions dir armed");
    assert!(
        book.armed.contains(&session),
        "the kind-correct arm CASCADED: the root-session child is armed"
    );
    assert!(
        outcome.marks.contains(&metadata),
        "watch-then-scan: the cascaded session's scoped mark was emitted"
    );
    assert!(
        outcome.provider_dirty,
        "the replan escalates provider dirty"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Whole-branch review Finding 1: the replan's unwatch cleanup must SPARE
/// the entries it armed (or retained) in the same apply. The arm loop runs
/// before the unwatch loop, and a prefix wipe of a stale stand-in would
/// otherwise drop the freshly-armed `<proj>/sessions` (and its cascaded
/// root session) out of the book while their KERNEL watches stay live —
/// an unwatch of the parent drops nothing else — desyncing the ledger
/// from the kernel (the depth-2 swap-back gate misfires, project teardown
/// misses the live watches, the budget WARN undercounts). The corner is
/// the replan's own purpose made concrete: `<proj>` sits armed as a
/// STAND-IN while on disk `<proj>/sessions` + a root session already
/// exist (the depth-2 create event was lost).
#[tokio::test]
async fn replan_unwatch_cleanup_spares_desired_armed_descendants() {
    let home = unique_temp_dir("amp-replan-spare");
    let projects_root = home.join("projects");
    let project = projects_root.join("p");
    std::fs::create_dir_all(&project).unwrap();
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    let mut outcome = ArmOutcome::default();
    // Pre-arm `<proj>` as a REAL stand-in (no `sessions/` yet): the kernel
    // watch is live, exactly as in the lost-event corner.
    arm_sessions_or_standin(&mut book, &mut watcher, &mut outcome, &project, false);
    assert!(book.armed.contains(&project), "stand-in pre-armed");
    // The lost depth-2 event: `sessions/` + a root session appear silently.
    let session = write_amplifier_session(&home, "p", "550e8400-e29b-41d4-a716-4466554400aa");
    let sessions_dir = project.join("sessions");

    let applied = replan_amplifier_watch_set(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        "amplifier",
    );

    assert!(applied, "a clean plan applies");
    assert!(
        !book.armed.contains(&project),
        "the stale stand-in IS unwatched (it is not desired)"
    );
    assert!(
        book.armed.contains(&sessions_dir),
        "the sessions dir the replan JUST armed (kernel-live) must stay in the book"
    );
    assert!(
        book.armed.contains(&session),
        "the cascaded root session (kernel-live) must stay in the book"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

/// Finding 1, retry corner: the same prefix wipe also silently DROPPED a
/// retry entry under the stale stand-in — breaching the "backoff never
/// bypassed" design letter on the replan path. Here `<proj>/sessions`
/// sits in `retry` (a transient arm failure — reachable when the depth-2
/// create's swap arm failed transiently, which leaves the stand-in armed)
/// while `<proj>` is still armed as a stand-in and `sessions/` + a root
/// session exist on disk. The replan must NOT arm the backed-off sessions
/// dir (backoff is never bypassed) and must NOT wipe its retry entry
/// either: the desired-aware cleanup spares every book entry that is a
/// key of the desired map, whichever set it lives in.
#[tokio::test]
async fn replan_unwatch_cleanup_spares_desired_retry_entries() {
    let home = unique_temp_dir("amp-replan-spare-retry");
    let session = write_amplifier_session(&home, "p", "550e8400-e29b-41d4-a716-4466554400aa");
    let projects_root = home.join("projects");
    let project = projects_root.join("p");
    let sessions_dir = project.join("sessions");
    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    book.armed.insert(project.clone());
    book.retry.insert(
        sessions_dir.clone(),
        RetryEntry {
            failures: 1,
            next_attempt: Instant::now() + Duration::from_secs(60),
            kind: ArmKind::SessionsDir,
        },
    );
    let mut outcome = ArmOutcome::default();

    let applied = replan_amplifier_watch_set(
        &mut book,
        &mut watcher,
        &mut outcome,
        &projects_root,
        "amplifier",
    );

    assert!(applied, "a clean plan applies");
    assert!(
        !book.armed.contains(&project),
        "the stale stand-in IS unwatched (it is not desired)"
    );
    assert!(
        !book.armed.contains(&sessions_dir),
        "backoff is never bypassed: the retrying sessions dir is NOT re-armed"
    );
    assert!(
        book.retry.contains_key(&sessions_dir),
        "backoff is never silently dropped: the retry entry survives the unwatch cleanup"
    );
    assert!(
        book.armed.contains(&session),
        "the root session dir (desired, armed this apply) stays in the book"
    );
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

// ---------- refresh→watcher self-correction channel (misnamed-root recovery) ----------

// Regression 4 (round trip): a subagent-NAMED dir holding root CONTENT
// (parent_id absent) is name-classified as subagent → never armed at
// startup — and is recovered by the refresh→watcher report. The
// not-armed-then-armed sequence is observed WITHOUT sleeps or races:
// phase 1 asserts the startup classification BEFORE any discover/snapshot
// has run (so no report can exist yet — the sink only fires from a full
// refresh, and startup itself is markless for an existing root); phase 2
// triggers the discover and awaits the arm.
#[tokio::test]
async fn misnamed_subagent_named_root_is_armed_via_refresh_report() {
    let home = unique_temp_dir("amp-misname");
    let dir = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_actually_a_root");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("metadata.json"),
        r#"{"session_id":"mis","working_dir":"/p/x","created":"2026-03-01T00:00:00.000Z"}"#,
    )
    .unwrap();
    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let handle = watcher.start();

    // Phase 1 (no report can exist yet — `index.snapshot()` has not been
    // called): wait for the startup structural arm pass to complete (the
    // `p/sessions` watch is the deepest structural arm in this fixture),
    // then assert the misnamed dir is UNARMED — name classification, with
    // no report in flight to race it.
    let sessions = home.join("projects").join("p").join("sessions");
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&sessions) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("startup structural arm pass completes");
    assert!(
        !book.lock().unwrap().armed.contains(&dir),
        "at startup the name says subagent ⇒ unarmed"
    );

    // Phase 2: NOW the first full discover runs — the root report fires
    // and the self-correction channel arms the misnamed root.
    let _ = index.snapshot().await;
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if book.lock().unwrap().armed.contains(&dir) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("misnamed root armed via the refresh report");
    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

// Regression 9: the diff never bypasses arm-failure backoff.
#[test]
fn roots_needing_arm_respects_retry_backoff() {
    let ghost = PathBuf::from("/tmp/amplifier-retry-ghost");
    let reported = vec![ghost.clone(), PathBuf::from("/tmp/fresh")];
    let mut armed: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    let mut retry: std::collections::HashMap<PathBuf, RetryEntry> =
        std::collections::HashMap::new();
    retry.insert(
        ghost.clone(),
        RetryEntry {
            failures: 2,
            next_attempt: std::time::Instant::now() + Duration::from_secs(60),
            kind: crate::watch_plan::ArmKind::SessionDir,
        },
    );
    let to_arm = roots_needing_arm(&reported, &armed, &retry);
    assert_eq!(to_arm, vec![PathBuf::from("/tmp/fresh")]);

    // Rust: a dir that's already armed is also skipped.
    let report2 = vec![ghost.clone()];
    armed.insert(ghost.clone());
    assert!(roots_needing_arm(&report2, &armed, &retry).is_empty());
}

/// Companion corner the channel itself creates: a transient arm failure of
/// a channel-reported misnamed root lands in `retry` (kind `SessionDir`),
/// where first-line re-arming through `arm_managed_dir` would refuse the
/// subagent-pattern basename FOREVER (the name gate exists precisely so
/// first-line paths never arm subagent dirs). The retry drain must route
/// such entries through the channel's content-verified arm — only the
/// channel can insert a subagent-named `SessionDir` entry, so this
/// classification-free re-arm can never leak onto a real subagent dir.
#[tokio::test]
async fn retry_drain_recovers_reported_misnamed_root() {
    let home = unique_temp_dir("amp-retry-misname");
    let dir = home
        .join("projects")
        .join("p")
        .join("sessions")
        .join("0000000000000000-014b6af1c2ac4ab5_misnamed_root");
    std::fs::create_dir_all(&dir).unwrap();

    let (tx, _rx) = mpsc::unbounded_channel::<WatchEvent>();
    let mut watcher = create_provider_watcher(&tx, "amplifier", false).unwrap();
    let mut book = ManagedBook::default();
    book.retry.insert(
        dir.clone(),
        RetryEntry {
            failures: 1,
            next_attempt: Instant::now(), // due now
            kind: crate::watch_plan::ArmKind::SessionDir,
        },
    );

    let mut outcome = ArmOutcome::default();
    arm_retry_entry(
        &mut book,
        &mut watcher,
        &mut outcome,
        "amplifier",
        &dir,
        crate::watch_plan::ArmKind::SessionDir,
    );

    assert!(
        book.armed.contains(&dir),
        "the channel-reported misnamed root is re-armed: {:?}",
        book.armed
    );
    assert!(
        book.retry.is_empty(),
        "a successful re-arm clears the retry entry"
    );
    // The kind-correct file-state watch-then-scan mark was emitted.
    assert!(outcome.marks.contains(&dir.join("metadata.json")));
    drop(watcher);
    std::fs::remove_dir_all(&home).ok();
}

// ---------- watch-reduction proof (kata target) ----------

/// THE proof: a 12-project corpus arms EXACTLY
/// 1 (projects root) + 12 (sessions dirs) + 4 (stand-ins) + 12×3 (root session dirs) = 53
/// watches — never a subagent dir, never context-intelligence — while every
/// root session (incl. one old+externally-resumed) updates instantly through
/// the real watcher path and all 72 subagent rows still index.
#[tokio::test]
async fn amplifier_managed_watch_set_proof_of_reduction_and_root_liveness() {
    let home = unique_temp_dir("amp-proof");
    let projects_with_sessions = 12usize;
    let roots_per = [
        "012584be-9478-4801-a62d-4e5da428b3a0",
        "aa2584be-9478-4801-a62d-4e5da428b3a0",
    ];
    let subagents_per = [
        "0000000000000000-014b6af1c2ac4ab5_a",
        "1111111111111111-2222222222222222_b",
        "3333333333333333-4444444444444444_c",
    ];
    // Twelve with sessions/, four stand-ins.
    for i in 0..projects_with_sessions {
        let slug = format!("proj_{i}");
        for id in roots_per {
            let dir = write_amplifier_session(&home, &slug, id);
            std::fs::write(
                dir.join("metadata.json"),
                format!(
                    r#"{{"session_id":"{id}-{i}","working_dir":"/p/{slug}","created":"2026-03-01T00:00:00.000Z","name":"t","description":"d","turn_count":1}}"#
                ),
            )
            .unwrap();
        }
        for id in subagents_per {
            let dir = write_amplifier_session(&home, &slug, id);
            // parent_id present ⇒ subagent row content (rows still index).
            std::fs::write(
                dir.join("metadata.json"),
                format!(
                    r#"{{"session_id":"{id}-{i}","working_dir":"/p/{slug}","parent_id":"x","created":"2026-03-01T00:00:00.000Z"}}"#
                ),
            )
            .unwrap();
        }
        // One oddball root per project (drift alarm input) + a CI subtree.
        write_amplifier_session(&home, &slug, &format!("oddball-{i}"));
        std::fs::create_dir_all(
            projects_with_sessions_path(&home, &slug, roots_per[0]).join("context-intelligence"),
        )
        .unwrap();
    }
    for i in 0..4usize {
        std::fs::create_dir_all(home.join("projects").join(format!("standin_{i}"))).unwrap();
    }

    let index = amplifier_index(&home);
    let mut watcher = amplifier_watcher(&index, &home);
    let book = watcher.amplifier_book_handle().unwrap();
    let mut rx = index.subscribe_changes();
    let handle = watcher.start();
    let _ = index.snapshot().await;
    tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if book.lock().unwrap().armed.len() >= 53 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .expect("full arm pass");

    // 1 root + 12 sessions + 4 stand-ins + 36 root session dirs = 53.
    let expected = 1 + projects_with_sessions + 4 + projects_with_sessions * 3;
    {
        let b = book.lock().unwrap();
        assert_eq!(b.armed.len(), expected, "exact planned watch count");
        // Never watched: any subagent-pattern dir or anything below a
        // session dir (context-intelligence).
        for p in &b.armed {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            assert!(
                crate::watch_plan::classify_basename(name)
                    != crate::watch_plan::BasenameClass::Subagent,
                "armed a subagent dir: {}",
                p.display()
            );
            assert!(!name.starts_with("context-intelligence"));
        }
        drop(b);
    }

    // Subagent rows still exist (discover covers the whole corpus).
    let snap = index.snapshot().await;
    let amps = snap.iter().filter(|s| s.provider == "amplifier").count();
    assert_eq!(
        amps,
        projects_with_sessions * (2 + 3 + 1),
        "every row indexed (roots + subagents + oddball)"
    );

    // Zero-latency-regression pin: an OLD root session (created at startup,
    // never touched since) gets an external-resume write and still updates
    // instantly through the real watched path.
    let _ = rx.borrow_and_update();
    let old_root = projects_with_sessions_path(&home, "proj_3", roots_per[0]);
    std::fs::write(
        old_root.join("transcript.jsonl"),
        "{\"type\":\"user\",\"message\":{\"role\":\"user\",\"content\":\"resumed\"}}\n",
    )
    .unwrap();
    let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
    assert!(changed.is_ok(), "old root session stays instantly fresh");

    watcher.stop();
    let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
    std::fs::remove_dir_all(&home).ok();
}

fn projects_with_sessions_path(home: &Path, slug: &str, id: &str) -> PathBuf {
    home.join("projects").join(slug).join("sessions").join(id)
}
