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
/// the receiver silent while the prohibited CPU work ran anyway. (Task 5
/// grows the struct with `stat_scoped_calls` when the counted passthrough
/// lands; only fields a test actually reads live here, or the clippy
/// `-D warnings` gate would flag a dead one.)
struct CountedAmplifierIndex {
    index: Arc<SessionIndex>,
    discover_calls: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}

fn counted_amplifier_index(home: &Path) -> CountedAmplifierIndex {
    let amplifier = crate::amplifier::AmplifierSource::new(home.to_path_buf());
    let wrapped = crate::directory_index::tests::CountingWrapper::new(amplifier);
    let (discover_calls, _parse_calls, _direct_list_calls) =
        crate::directory_index::tests::wrapper_counters(&wrapped);
    let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
        vec![Arc::new(wrapped) as Arc<dyn crate::directory_index::SessionSource>],
        Duration::from_secs(3600),
        None,
    ));
    CountedAmplifierIndex {
        index,
        discover_calls,
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
