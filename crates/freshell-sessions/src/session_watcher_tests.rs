//! Unit tests for `crate::session_watcher`. Kept in a sibling file (the
//! `codex_locator_tests.rs` convention: a `#[path]`-included child module) to
//! respect the repo's <=1K-lines file limit; `use super::*` still reaches
//! the parent's private items (`create_provider_watcher`, `watch_path`,
//! `unwatch_tolerated`, `WatchEvent`).

use super::*;
use crate::directory_index::{ClaudeSource, SessionIndex, SessionSource};

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
