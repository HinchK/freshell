//! Session watcher: inotify-based file watching that feeds dirty-path
//! notifications to [`SessionIndex`]. Replaces the continuous 1s-TTL
//! polling that burned 50-90% of a CPU core.
//!
//! Architecture:
//! - Literally one `notify::RecommendedWatcher` (one inotify fd) per provider,
//!   armed on many paths via [`ProviderLayout`] watch bases; watch lifetimes
//!   are explicit (`watch_path` to arm, `unwatch_tolerated` to drop)
//! - Raw events flow through a coalescing `HashMap<PathBuf, Instant>` that
//!   collapses ~35 events/s (measured 24h observer) to ~0.09 net changes/s
//! - Debounced flush (200ms) delivers dirty paths to `SessionIndex::mark_dirty`
//! - Late-root handling: watches nearest existing ancestor when the provider
//!   root doesn't exist yet; the 15-minute TTL reconciliation covers providers
//!   whose root never appears during the watcher's lifetime

use std::collections::hash_map::Entry;
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
/// root appears, a watcher is armed for it. Also detects ancestor
/// watchers that should be replaced by precise-root watchers.
const REARM_INTERVAL_SECS: u64 = 60;

/// A coarse, provider-agnostic classification of one notify event. The
/// amplifier managed engine (later tasks) consumes it; the legacy
/// providers' flush ignores it. `CreateFolder` deliberately preserves the
/// `CreateKind::Folder` distinction: depth-4+ routing (Task 5) drops a
/// folder creation (`context-intelligence/` mkdir) while scoped-marking
/// a file creation, and structural depths (Tasks 3-4) treat
/// `CreateFolder` as create-ish because a mkdir IS a `Create(Folder)`
/// under inotify. `Remove` deliberately does NOT carry the notify
/// dir-vs-file tag: a directly-armed directory's self-delete surfaces as
/// `Remove(File)`, NOT `Remove(Folder)` (the kernel does not set ISDIR
/// on IN_DELETE_SELF — LB-01 probe), so remove routing by path depth
/// must dispatch on the `Remove` kind WITHOUT filtering on the
/// dir-vs-file tag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WatchKind {
    Create,
    CreateFolder,
    Remove,
    NameFrom,
    NameTo,
    NameBoth,
    Modify,
    Other,
}

fn kind_of(event: &notify::Event) -> WatchKind {
    use notify::event::{CreateKind, ModifyKind, RenameMode};
    match event.kind {
        notify::EventKind::Create(CreateKind::Folder) => WatchKind::CreateFolder,
        notify::EventKind::Create(_) => WatchKind::Create,
        notify::EventKind::Remove(_) => WatchKind::Remove,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::From)) => WatchKind::NameFrom,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::To)) => WatchKind::NameTo,
        notify::EventKind::Modify(ModifyKind::Name(RenameMode::Both)) => WatchKind::NameBoth,
        notify::EventKind::Modify(_) => WatchKind::Modify,
        _ => WatchKind::Other,
    }
}

/// Events from watcher callbacks, carrying provider identity so the
/// flush logic can scope dirty marks to the correct provider.
enum WatchEvent {
    /// One notify event's full path set (one FileChanged message per
    /// notify event). Rename vocabulary as observed by the LB-01
    /// real-notify probe (notify 6.1.1, kernel 6.6.87.2-WSL2, ext4): an
    /// intra-`sessions/` rename emits THREE events sharing one tracker
    /// cookie — `Name(From)` with paths [from], `Name(To)` with paths
    /// [to], and `Name(Both)` carrying paths [from, to] — so a rename
    /// surfaces as three FileChanged messages and the dispatch handles
    /// both the From/To pair shape and the paired Both shape.
    FileChanged {
        paths: Vec<PathBuf>,
        kind: WatchKind,
        provider: String,
    },
    /// This provider needs a full re-discovery (direct-listed db change,
    /// `need_rescan()` flag, or watcher error).
    ProviderRescan { provider: String },
}

/// A configured provider with its resolved home directory.
pub struct WatchedProvider {
    pub layout: Box<dyn ProviderLayout>,
    pub home: PathBuf,
}

/// One notify watcher per provider armed on many paths. Watch lifetimes
/// are explicit (`watch_path`/`unwatch_tolerated`); dropping the loop's
/// `ProviderWatch` drops every remaining watch with the watcher.
struct ProviderWatch {
    watcher: notify::RecommendedWatcher,
    /// legacy-model bookkeeping parity with old `ArmedWatch`:
    targets: Vec<ArmedTarget>,
}

struct ArmedTarget {
    requested_base: PathBuf,
    actual_target: PathBuf,
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
    move |res: Result<notify::Event, _>| match res {
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
                let _ = tx.send(WatchEvent::FileChanged {
                    paths: event.paths.clone(),
                    kind: kind_of(&event),
                    provider: provider_name.clone(),
                });
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

/// Create THE provider's watcher. One watcher == one inotify fd per
/// provider (PR #655's per-target model would mint ~4.4K watchers on the
/// managed set — a `max_user_instances` (1024) violation).
fn create_provider_watcher(
    tx: &mpsc::UnboundedSender<WatchEvent>,
    provider_name: &str,
    is_direct: bool,
) -> Option<notify::RecommendedWatcher> {
    let cb = make_watcher_callback(tx.clone(), provider_name.to_owned(), is_direct);
    match notify::recommended_watcher(cb) {
        Ok(watcher) => Some(watcher),
        Err(e) => {
            tracing::warn!(
                provider = %provider_name,
                error = %e,
                "session-watcher: failed to create watcher",
            );
            None
        }
    }
}

/// Arm one path on the provider's shared watcher. Errors propagate (the
/// caller decides absent-vs-retry policy); failures are logged here.
fn watch_path(
    watcher: &mut notify::RecommendedWatcher,
    provider_name: &str,
    target: &Path,
    mode: notify::RecursiveMode,
) -> Result<(), notify::Error> {
    if let Err(e) = watcher.watch(target, mode) {
        tracing::warn!(
            provider = %provider_name,
            path = %target.display(),
            error = %e,
            "session-watcher: failed to arm watch",
        );
        return Err(e);
    }
    Ok(())
}

/// Explicit unwatch. IN_IGNORED on delete means the kernel already
/// dropped the watch, so WatchNotFound-class errors are tolerated at
/// debug (design: "explicit unwatch tolerates WatchNotFound").
fn unwatch_tolerated(watcher: &mut notify::RecommendedWatcher, provider_name: &str, target: &Path) {
    match watcher.unwatch(target) {
        Ok(()) => {}
        Err(e) if matches!(&e.kind, notify::ErrorKind::WatchNotFound) => {
            tracing::debug!(
                provider = %provider_name,
                path = %target.display(),
                "session-watcher: unwatch of already-dropped watch (tolerated)",
            );
        }
        Err(e) => {
            tracing::warn!(
                provider = %provider_name,
                path = %target.display(),
                error = %e,
                "session-watcher: unwatch failed",
            );
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

    // One watcher per provider, keyed by provider index. Watch lifetimes
    // are explicit (`watch_path`/`unwatch_tolerated`); dropping a
    // `ProviderWatch` drops every remaining watch with its watcher.
    let mut watches: HashMap<usize, ProviderWatch> = HashMap::new();
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
                // for an existing ancestor. For NonRecursive watchers
                // (OpenCode), allow climbing one level above provider.home
                // so we can observe when the data directory is created.
                let ancestor_bound = if mode == notify::RecursiveMode::NonRecursive {
                    provider.home.parent().unwrap_or(&provider.home)
                } else {
                    &provider.home
                };
                let candidate = nearest_existing_ancestor(base, ancestor_bound);
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

            // THE provider's watcher: created on the first base that gets
            // this far, reused by later bases of the same provider.
            let pw = match watches.entry(prov_idx) {
                Entry::Occupied(o) => o.into_mut(),
                Entry::Vacant(v) => match create_provider_watcher(&event_tx, &name, is_direct) {
                    Some(watcher) => v.insert(ProviderWatch {
                        watcher,
                        targets: Vec::new(),
                    }),
                    None => {
                        index.mark_provider_dirty(&name);
                        absent.push((prov_idx, base.clone()));
                        continue;
                    }
                },
            };

            match watch_path(&mut pw.watcher, &name, &watch_target, mode) {
                Ok(()) => {
                    pw.targets.push(ArmedTarget {
                        requested_base: base.clone(),
                        actual_target: watch_target,
                    });
                }
                Err(_) => {
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
    let mut pending_rescans: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut rearm_interval = tokio::time::interval(Duration::from_secs(rearm_interval_secs));
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
                    // One message per notify event; fan the paths back out
                    // so the coalescing keys (path, provider) are identical
                    // to the old per-path messages.
                    Some(WatchEvent::FileChanged { paths, provider, .. }) => {
                        for path in paths {
                            pending.insert((path, provider.clone()), Instant::now());
                        }
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
            _ = rearm_interval.tick(), if !absent.is_empty() || !watches.is_empty() => {
                // Detect ancestor watches whose precise base now exists,
                // and armed targets that disappeared. Unwatch the stale
                // target explicitly (inotify watches follow inodes, so an
                // un-unwatched move/delete keeps reporting under the stale
                // path) and move the base to absent for re-arming.
                for (prov_idx, pw) in watches.iter_mut() {
                    let name = providers[*prov_idx].layout.name();
                    let ProviderWatch { watcher, targets } = pw;
                    let mut removed_bases: Vec<PathBuf> = Vec::new();
                    targets.retain(|t| {
                        if t.actual_target != t.requested_base && t.requested_base.exists() {
                            tracing::info!(
                                provider = %name,
                                path = %t.requested_base.display(),
                                "session-watcher: precise root appeared, replacing ancestor watcher",
                            );
                            unwatch_tolerated(watcher, name, &t.actual_target);
                            removed_bases.push(t.requested_base.clone());
                            false
                        } else if !t.actual_target.exists() {
                            tracing::info!(
                                provider = %name,
                                path = %t.actual_target.display(),
                                "session-watcher: watch target disappeared, tracking for re-arm",
                            );
                            unwatch_tolerated(watcher, name, &t.actual_target);
                            removed_bases.push(t.requested_base.clone());
                            false
                        } else {
                            true
                        }
                    });
                    for base in removed_bases {
                        absent.push((*prov_idx, base));
                        index.mark_provider_dirty(name);
                    }
                }

                // Re-check absent providers: re-arm on the precise base
                // using the provider's EXISTING watcher (creating the
                // ProviderWatch first if the provider has none yet).
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
                    let pw = match watches.entry(*prov_idx) {
                        Entry::Occupied(o) => o.into_mut(),
                        Entry::Vacant(v) => {
                            match create_provider_watcher(&rearm_tx, &name, is_direct) {
                                Some(watcher) => v.insert(ProviderWatch {
                                    watcher,
                                    targets: Vec::new(),
                                }),
                                None => return true, // keep in absent
                            }
                        }
                    };
                    match watch_path(&mut pw.watcher, &name, base, mode) {
                        Ok(()) => {
                            tracing::info!(
                                provider = %name,
                                path = %base.display(),
                                "session-watcher: provider appeared, armed watcher",
                            );
                            pw.targets.push(ArmedTarget {
                                requested_base: base.clone(),
                                actual_target: base.clone(),
                            });
                            index.mark_provider_dirty(&name);
                            false // remove from absent
                        }
                        Err(_) => true, // keep in absent
                    }
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
#[path = "session_watcher_tests.rs"]
mod tests;
