//! Session watcher: inotify-based file watching that feeds dirty-path
//! notifications to [`SessionIndex`]. Replaces the continuous 1s-TTL
//! polling that burned 50-90% of a CPU core.
//!
//! Architecture:
//! - One `notify::RecommendedWatcher` per provider, armed via [`ProviderLayout`]
//! - Raw events flow through a coalescing `HashMap<PathBuf, Instant>` that
//!   collapses ~35 events/s (measured 24h observer) to ~0.09 net changes/s
//! - Debounced flush (200ms) delivers dirty paths to `SessionIndex::mark_dirty`
//! - Late-root handling: watches nearest existing ancestor when the provider
//!   root doesn't exist yet; the 15-minute TTL reconciliation covers providers
//!   whose root never appears during the watcher's lifetime

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use notify::Watcher;
use tokio::sync::mpsc;

use crate::directory_index::SessionIndex;
use crate::provider_layout::{ProviderLayout, WatchMode};

/// Debounce window: coalesced events are flushed to SessionIndex after
/// this much quiet time. 200ms matches the observer's findings and is
/// well under human-perceptible latency.
const DEBOUNCE_MS: u64 = 200;

/// A configured provider with its resolved home directory.
pub struct WatchedProvider {
    pub layout: Box<dyn ProviderLayout>,
    pub home: PathBuf,
}

/// The session-directory file watcher.
pub struct SessionWatcher {
    index: Arc<SessionIndex>,
    providers: Vec<WatchedProvider>,
    stop_tx: Option<tokio::sync::oneshot::Sender<()>>,
}

/// Event filter: same logic as `activity.rs::fs_event_is_relevant` —
/// data-mutation kinds only, plus the Rescan miss-recovery override.
fn is_relevant(event: &notify::Event) -> bool {
    event.need_rescan()
        || matches!(
            event.kind,
            notify::EventKind::Modify(notify::event::ModifyKind::Data(_))
                | notify::EventKind::Modify(notify::event::ModifyKind::Any)
                | notify::EventKind::Modify(notify::event::ModifyKind::Name(_))
                | notify::EventKind::Create(_)
                | notify::EventKind::Remove(_)
                | notify::EventKind::Any
        )
}

impl SessionWatcher {
    pub fn new(index: Arc<SessionIndex>, providers: Vec<WatchedProvider>) -> Self {
        Self {
            index,
            providers,
            stop_tx: None,
        }
    }

    /// Start the watcher background task. Returns a `JoinHandle` for the
    /// event loop. Call `stop()` to shut it down.
    pub fn start(&mut self) -> tokio::task::JoinHandle<()> {
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_tx = Some(stop_tx);

        let index = Arc::clone(&self.index);
        let providers: Vec<_> = self.providers.drain(..).collect();

        tokio::spawn(async move {
            run_watcher_loop(index, providers, stop_rx).await;
        })
    }

    /// Signal the watcher to stop.
    pub fn stop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
    }
}

/// Arm watchers and run the coalescing event loop.
async fn run_watcher_loop(
    index: Arc<SessionIndex>,
    providers: Vec<WatchedProvider>,
    mut stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<(PathBuf, bool)>();

    // Arm one watcher per provider, per watch base.
    // Keep watchers alive for the loop's lifetime — dropping them unwatches.
    let mut _watchers: Vec<notify::RecommendedWatcher> = Vec::new();
    for provider in &providers {
        let watch_bases = provider.layout.watch_bases(&provider.home);
        let is_direct = provider.layout.is_direct_listed();
        let mode = match provider.layout.watch_mode() {
            WatchMode::Recursive => notify::RecursiveMode::Recursive,
            WatchMode::NonRecursive => notify::RecursiveMode::NonRecursive,
        };
        let name = provider.layout.name().to_owned();

        let ancestor_bound = provider.home.parent().unwrap_or(&provider.home);
        for base in &watch_bases {
            let watch_target = if base.exists() {
                base.clone()
            } else {
                // Late-root: watch the nearest existing ancestor. The
                // 15-minute TTL reconciliation covers providers whose
                // root never appears during the watcher's lifetime.
                nearest_existing_ancestor(base, ancestor_bound)
            };

            let tx = event_tx.clone();
            let cb_name = name.clone();
            match notify::recommended_watcher(move |res: Result<notify::Event, _>| {
                match res {
                    Ok(event) => {
                        if !is_relevant(&event) {
                            return;
                        }
                        let rescan = is_direct || event.need_rescan();
                        if event.paths.is_empty() && rescan {
                            let _ = tx.send((PathBuf::new(), true));
                        } else {
                            for path in event.paths {
                                let _ = tx.send((path, rescan));
                            }
                        }
                    }
                    Err(e) => {
                        tracing::warn!(provider = %cb_name, error = %e, "session-watcher: watcher error");
                        // Signal a full rescan so the next TTL reconciliation
                        // picks up whatever the watcher missed.
                        let _ = tx.send((PathBuf::new(), true));
                    }
                }
            }) {
                Ok(mut watcher) => {
                    if let Err(e) = watcher.watch(&watch_target, mode) {
                        tracing::warn!(
                            provider = %name,
                            path = %watch_target.display(),
                            error = %e,
                            "session-watcher: failed to arm watch",
                        );
                        index.mark_provider_dirty(&name);
                    } else {
                        _watchers.push(watcher);
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        provider = %name,
                        error = %e,
                        "session-watcher: failed to create watcher",
                    );
                    index.mark_provider_dirty(&name);
                }
            }
        }
    }

    // Drop the sender so the loop can detect when all watchers are gone.
    drop(event_tx);

    // Coalescing event loop.
    let debounce = Duration::from_millis(DEBOUNCE_MS);
    let mut pending: HashMap<PathBuf, Instant> = HashMap::new();
    let mut needs_full_dirty = false;

    loop {
        let flush_deadline = if pending.is_empty() && !needs_full_dirty {
            // No pending events — wait indefinitely for the next one.
            None
        } else {
            // Flush after debounce window.
            Some(tokio::time::Instant::now() + debounce)
        };

        tokio::select! {
            _ = &mut stop_rx => break,
            event = event_rx.recv() => {
                match event {
                    Some((path, is_rescan)) => {
                        if is_rescan {
                            needs_full_dirty = true;
                        } else {
                            pending.insert(path, Instant::now());
                        }
                    }
                    None => break, // all senders dropped
                }
            }
            _ = async {
                match flush_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                // Debounce timer fired — flush.
                if needs_full_dirty {
                    for provider in &providers {
                        index.mark_provider_dirty(provider.layout.name());
                    }
                    needs_full_dirty = false;
                }
                if !pending.is_empty() {
                    let dirty_paths: Vec<PathBuf> = pending.drain().map(|(p, _)| p).collect();
                    // Filter through provider layouts — only deliver paths
                    // that actually look like session files.
                    let qualified: Vec<PathBuf> = dirty_paths
                        .into_iter()
                        .filter(|p| providers.iter().any(|prov| prov.layout.qualifies(p)))
                        .collect();
                    if !qualified.is_empty() {
                        index.mark_dirty(&qualified);
                    }
                }
                pending.clear();
            }
        }
    }
}

/// Walk up from `target` toward `bound`, returning the first ancestor that
/// exists on disk. If nothing exists (not even `bound`), returns `bound`.
fn nearest_existing_ancestor(target: &Path, bound: &Path) -> PathBuf {
    let mut current = target.to_path_buf();
    while current != bound && !current.exists() {
        current = match current.parent() {
            Some(p) => p.to_path_buf(),
            None => break,
        };
    }
    if current.exists() {
        current
    } else {
        bound.to_path_buf()
    }
}

#[cfg(test)]
mod tests {
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

        let create_event = notify::Event::new(notify::EventKind::Create(
            notify::event::CreateKind::File,
        ));
        assert!(is_relevant(&create_event));

        let remove_event = notify::Event::new(notify::EventKind::Remove(
            notify::event::RemoveKind::File,
        ));
        assert!(is_relevant(&remove_event));
    }

    #[test]
    fn is_relevant_rejects_access_events() {
        let access_event = notify::Event::new(notify::EventKind::Access(
            notify::event::AccessKind::Read,
        ));
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

        // Start with one session.
        let sid1 = "550e8400-e29b-41d4-a716-446655440001";
        write_claude_session(&claude_home, sid1, "/p/1");

        let source = ClaudeSource::new(claude_home.clone());
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(source) as Arc<dyn SessionSource>],
            // Very long TTL — only dirty marking should trigger refreshes.
            Duration::from_secs(3600),
            None,
        ));

        // Warm the index.
        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 1);

        let mut rx = index.subscribe_changes();

        // Start the watcher.
        let mut watcher = SessionWatcher::new(
            Arc::clone(&index),
            vec![WatchedProvider {
                layout: Box::new(crate::provider_layout::ClaudeLayout),
                home: claude_home.clone(),
            }],
        );
        let handle = watcher.start();

        // Give the watcher time to arm.
        tokio::time::sleep(Duration::from_millis(500)).await;

        // Write a new session file.
        let sid2 = "550e8400-e29b-41d4-a716-446655440002";
        write_claude_session(&claude_home, sid2, "/p/2");

        // Wait for the change notification.
        let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
        assert!(
            changed.is_ok(),
            "watcher should detect the new file and trigger a snapshot change"
        );

        // The index should now contain both sessions.
        let snap2 = index.snapshot().await;
        // Poll briefly if stale-while-revalidate hasn't settled.
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
        // Create the provider home but NOT the session root (projects/).
        // The watcher can watch claude_home and detect when projects/
        // appears inside it via recursive inotify.
        std::fs::create_dir_all(&claude_home).unwrap();

        let source = ClaudeSource::new(claude_home.clone());
        let index = Arc::new(SessionIndex::with_ttl_and_cache_path(
            vec![Arc::new(source) as Arc<dyn SessionSource>],
            Duration::from_secs(3600),
            None,
        ));

        // Warm — empty, since projects/ doesn't exist.
        let snap = index.snapshot().await;
        assert_eq!(snap.len(), 0);

        let mut rx = index.subscribe_changes();
        // Mark the initial generation seen.
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

        // Now create the session root AND a session file.
        let sid = "550e8400-e29b-41d4-a716-446655440003";
        write_claude_session(&claude_home, sid, "/p/late");

        // The watcher should detect the new file and trigger a refresh.
        let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
        assert!(
            changed.is_ok(),
            "watcher must detect a late-appearing session (DEV-0002 liveness)"
        );

        // Verify the session actually appears in the index.
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
}
