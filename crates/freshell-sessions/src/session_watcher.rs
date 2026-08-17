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

/// How often (seconds) to re-check absent providers whose roots didn't
/// exist at startup (or whose watchers failed to arm). When a provider's
/// root appears, a watcher is armed for it. Also checks if any armed
/// provider's watch base disappeared at runtime (e.g. provider uninstall).
const REARM_INTERVAL_SECS: u64 = 60;

/// Events from watcher callbacks, carrying provider identity so the
/// flush logic can scope dirty marks to the correct provider.
enum WatchEvent {
    /// A specific file changed under this provider's watch base.
    FileChanged { path: PathBuf, provider: String },
    /// This provider needs a full re-discovery (direct-listed db change,
    /// `need_rescan()` flag, or watcher error).
    ProviderRescan { provider: String },
}

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
    rearm_interval_secs: u64,
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

/// Build a watcher callback that sends events to the given channel,
/// tagged with the provider's identity. Shared by initial arming and
/// re-arming.
fn make_watcher_callback(
    tx: mpsc::UnboundedSender<WatchEvent>,
    provider_name: String,
    is_direct: bool,
) -> impl Fn(Result<notify::Event, notify::Error>) + Send {
    move |res: Result<notify::Event, _>| {
        match res {
            Ok(event) => {
                if !is_relevant(&event) {
                    return;
                }
                let rescan = is_direct || event.need_rescan();
                if rescan {
                    let _ = tx.send(WatchEvent::ProviderRescan {
                        provider: provider_name.clone(),
                    });
                } else {
                    for path in &event.paths {
                        let _ = tx.send(WatchEvent::FileChanged {
                            path: path.clone(),
                            provider: provider_name.clone(),
                        });
                    }
                }
            }
            Err(e) => {
                tracing::warn!(
                    provider = %provider_name, error = %e,
                    "session-watcher: watcher error"
                );
                let _ = tx.send(WatchEvent::ProviderRescan {
                    provider: provider_name.clone(),
                });
            }
        }
    }
}

impl SessionWatcher {
    pub fn new(index: Arc<SessionIndex>, providers: Vec<WatchedProvider>) -> Self {
        Self {
            index,
            providers,
            stop_tx: None,
            rearm_interval_secs: REARM_INTERVAL_SECS,
        }
    }

    #[cfg(test)]
    pub fn with_rearm_interval(mut self, secs: u64) -> Self {
        self.rearm_interval_secs = secs;
        self
    }

    /// Start the watcher background task. Returns a `JoinHandle` for the
    /// event loop. Call `stop()` to shut it down.
    pub fn start(&mut self) -> tokio::task::JoinHandle<()> {
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
        self.stop_tx = Some(stop_tx);

        let index = Arc::clone(&self.index);
        let providers: Vec<_> = self.providers.drain(..).collect();
        let rearm_secs = self.rearm_interval_secs;

        tokio::spawn(async move {
            run_watcher_loop(index, providers, stop_rx, rearm_secs).await;
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
    rearm_interval_secs: u64,
) {
    let (event_tx, mut event_rx) = mpsc::unbounded_channel::<WatchEvent>();

    // Arm one watcher per provider, per watch base.
    // Keep watchers alive for the loop's lifetime — dropping them unwatches.
    let mut _watchers: Vec<notify::RecommendedWatcher> = Vec::new();
    // Track which provider indices have active watchers for each base.
    let mut armed_bases: Vec<(usize, PathBuf)> = Vec::new();
    // Providers whose roots didn't exist at startup OR whose watchers
    // failed to arm. Checked periodically so watchers are armed once the
    // provider is installed or the transient error resolves.
    let mut absent: Vec<(usize, PathBuf)> = Vec::new();
    for (prov_idx, provider) in providers.iter().enumerate() {
        let watch_bases = provider.layout.watch_bases(&provider.home);
        let is_direct = provider.layout.is_direct_listed();
        let mode = match provider.layout.watch_mode() {
            WatchMode::Recursive => notify::RecursiveMode::Recursive,
            WatchMode::NonRecursive => notify::RecursiveMode::NonRecursive,
        };
        let name = provider.layout.name().to_owned();

        for base in &watch_bases {
            let watch_target = if base.exists() {
                base.clone()
            } else {
                // Late-root: walk up toward the provider home looking
                // for an existing ancestor. Bound at provider.home so
                // we never climb above it (which could recursively
                // watch the user's entire home directory).
                let candidate = nearest_existing_ancestor(base, &provider.home);
                if !candidate.exists() {
                    tracing::info!(
                        provider = %name,
                        path = %base.display(),
                        "session-watcher: provider root absent, will re-check periodically",
                    );
                    absent.push((prov_idx, base.clone()));
                    index.mark_provider_dirty(&name);
                    continue;
                }
                candidate
            };

            let cb = make_watcher_callback(event_tx.clone(), name.clone(), is_direct);
            match notify::recommended_watcher(cb) {
                Ok(mut watcher) => {
                    if let Err(e) = watcher.watch(&watch_target, mode) {
                        tracing::warn!(
                            provider = %name,
                            path = %watch_target.display(),
                            error = %e,
                            "session-watcher: failed to arm watch",
                        );
                        index.mark_provider_dirty(&name);
                        absent.push((prov_idx, base.clone()));
                    } else {
                        _watchers.push(watcher);
                        armed_bases.push((prov_idx, base.clone()));
                    }
                }
                Err(e) => {
                    tracing::warn!(
                        provider = %name,
                        error = %e,
                        "session-watcher: failed to create watcher",
                    );
                    index.mark_provider_dirty(&name);
                    absent.push((prov_idx, base.clone()));
                }
            }
        }
    }

    // Keep the sender alive for re-arming absent providers.
    let rearm_tx = event_tx;

    // Coalescing event loop.
    let debounce = Duration::from_millis(DEBOUNCE_MS);
    // File-level events keyed by (path, provider) → last-seen instant.
    let mut pending: HashMap<(PathBuf, String), Instant> = HashMap::new();
    // Providers that need a full rescan (direct-listed change, rescan flag, or error).
    let mut pending_rescans: std::collections::HashSet<String> =
        std::collections::HashSet::new();
    let mut rearm_interval =
        tokio::time::interval(Duration::from_secs(rearm_interval_secs));
    rearm_interval.tick().await; // consume the immediate first tick

    loop {
        let flush_deadline = if pending.is_empty() && pending_rescans.is_empty() {
            None
        } else {
            Some(tokio::time::Instant::now() + debounce)
        };

        tokio::select! {
            _ = &mut stop_rx => break,
            event = event_rx.recv() => {
                match event {
                    Some(WatchEvent::FileChanged { path, provider }) => {
                        pending.insert((path, provider), Instant::now());
                    }
                    Some(WatchEvent::ProviderRescan { provider }) => {
                        pending_rescans.insert(provider);
                    }
                    None => break,
                }
            }
            _ = async {
                match flush_deadline {
                    Some(deadline) => tokio::time::sleep_until(deadline).await,
                    None => std::future::pending::<()>().await,
                }
            } => {
                // Debounce timer fired — flush.
                // Provider-level rescans: only mark the specific providers dirty.
                for provider_name in pending_rescans.drain() {
                    index.mark_provider_dirty(&provider_name);
                }
                if !pending.is_empty() {
                    let events: Vec<((PathBuf, String), Instant)> =
                        pending.drain().collect();
                    let mut qualified: Vec<(PathBuf, String)> = Vec::new();
                    let mut dirty_provider_names = std::collections::HashSet::new();
                    for ((path, provider_name), _) in events {
                        let prov = providers
                            .iter()
                            .find(|p| p.layout.name() == provider_name);
                        let qualifies = prov
                            .map(|p| p.layout.qualifies(&path))
                            .unwrap_or(false);
                        if qualifies {
                            qualified.push((path, provider_name));
                        } else {
                            dirty_provider_names.insert(provider_name);
                        }
                    }
                    if !qualified.is_empty() {
                        index.mark_dirty(&qualified);
                    }
                    for name in dirty_provider_names {
                        index.mark_provider_dirty(&name);
                    }
                }
            }
            _ = rearm_interval.tick(), if !absent.is_empty() || !armed_bases.is_empty() => {
                // Detect armed watch bases that disappeared at runtime
                // (e.g. provider uninstall) and move them to absent.
                armed_bases.retain(|(prov_idx, base)| {
                    if base.exists() {
                        return true; // still present
                    }
                    let name = providers[*prov_idx].layout.name();
                    tracing::info!(
                        provider = %name,
                        path = %base.display(),
                        "session-watcher: armed watch base disappeared, tracking for re-arm",
                    );
                    absent.push((*prov_idx, base.clone()));
                    index.mark_provider_dirty(name);
                    false
                });

                // Re-check absent providers: arm watchers for any whose
                // root has appeared since the last check.
                absent.retain(|(prov_idx, base)| {
                    if !base.exists() {
                        return true; // still absent
                    }
                    let prov = &providers[*prov_idx];
                    let is_direct = prov.layout.is_direct_listed();
                    let mode = match prov.layout.watch_mode() {
                        WatchMode::Recursive => notify::RecursiveMode::Recursive,
                        WatchMode::NonRecursive => notify::RecursiveMode::NonRecursive,
                    };
                    let name = prov.layout.name().to_owned();
                    let cb = make_watcher_callback(
                        rearm_tx.clone(),
                        name.clone(),
                        is_direct,
                    );
                    let armed = match notify::recommended_watcher(cb) {
                        Ok(mut watcher) => {
                            if watcher.watch(base, mode).is_ok() {
                                _watchers.push(watcher);
                                armed_bases.push((*prov_idx, base.clone()));
                                true
                            } else {
                                false
                            }
                        }
                        Err(_) => false,
                    };
                    if armed {
                        tracing::info!(
                            provider = %name,
                            path = %base.display(),
                            "session-watcher: provider appeared, armed watcher",
                        );
                        index.mark_provider_dirty(&name);
                    }
                    !armed // keep in absent list if arming failed
                });
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

    #[tokio::test]
    async fn watcher_rearms_when_absent_provider_appears() {
        // Create a base dir but NOT the provider home (simulates a
        // provider that isn't installed at startup).
        let base = unique_temp_dir("rearm");
        let claude_home = base.join(".claude");
        // Don't create claude_home — the watcher should track it as absent.

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
        .with_rearm_interval(1); // 1 second for fast test
        let handle = watcher.start();

        // Give the watcher time to start and register the absent provider.
        tokio::time::sleep(Duration::from_millis(500)).await;

        // "Install" the provider — create its root directory.
        let project = claude_home.join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();

        // Wait for the re-arm timer to fire and arm the new watcher.
        tokio::time::sleep(Duration::from_secs(2)).await;

        // NOW write a session file. If the watcher re-armed, it should
        // detect this file via inotify (not via TTL reconciliation).
        let sid = "550e8400-e29b-41d4-a716-446655440004";
        write_claude_session(&claude_home, sid, "/p/rearm");

        // Wait for the watcher to detect the new file.
        let changed = tokio::time::timeout(Duration::from_secs(5), rx.changed()).await;
        assert!(
            changed.is_ok(),
            "re-armed watcher must detect the new file"
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
        assert!(
            found,
            "session from a re-armed provider must appear in the index"
        );

        watcher.stop();
        let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        std::fs::remove_dir_all(&base).ok();
    }
}
