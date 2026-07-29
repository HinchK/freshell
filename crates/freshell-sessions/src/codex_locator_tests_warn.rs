//! Warn-once-per-window lock for `tick_forks`'s ambiguity arm (Task 5).
//! Sibling child of `codex_locator_tests` (the `tabs_persist_validation_tests`
//! convention: a `#[path]`-included child module) because the parent test
//! file sits against the 1,000-line cap (port/AGENTS.md:81). `use super::*`
//! reaches the parent tests module's helpers (`unique_temp_dir`,
//! `write_rollout_full`, `TID`) and, through its own glob, `codex_locator`.

use super::*;

/// Log-capture layer counting WARN events whose fields mention a needle.
struct WarnCounter {
    hits: std::sync::Arc<AtomicU64>,
    needle: &'static str,
}
impl<S: tracing::Subscriber> tracing_subscriber::layer::Layer<S> for WarnCounter {
    fn on_event(
        &self,
        event: &tracing::Event<'_>,
        _ctx: tracing_subscriber::layer::Context<'_, S>,
    ) {
        struct Buf(String);
        impl tracing::field::Visit for Buf {
            fn record_debug(&mut self, _f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
                self.0.push_str(&format!("{v:?}"));
            }
        }
        let mut buf = Buf(String::new());
        event.record(&mut buf);
        if event.metadata().level() == &tracing::Level::WARN && buf.0.contains(self.needle) {
            self.hits.fetch_add(1, Ordering::SeqCst);
        }
    }
}

#[test]
fn ambiguous_fork_warns_once_per_window_and_rearms_on_new_submit() {
    use tracing_subscriber::layer::SubscriberExt;
    const TID2: &str = "22222222-3333-4444-5555-666666666666";
    let hits = std::sync::Arc::new(AtomicU64::new(0));
    let subscriber = tracing_subscriber::registry().with(WarnCounter {
        hits: std::sync::Arc::clone(&hits),
        needle: "codex_fork_ambiguous",
    });
    // Thread-local: tick_forks runs on this thread, so the counter sees
    // exactly this test's events even under parallel test execution.
    let _guard = tracing::subscriber::set_default(subscriber);

    let root = unique_temp_dir("fork-ambiguity-warn-once");
    let locator = CodexLocator::new(root.clone());
    assert!(locator.watch_fork("t1", "aaaa-old"));
    assert!(locator.note_fork_submit("t1", 1_000));
    // TWO user forks of the same parent in one window -> ambiguous.
    write_rollout_full(
        &root,
        "2026/07/29",
        TID,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    write_rollout_full(
        &root,
        "2026/07/29",
        TID2,
        Some("/tmp/x"),
        Some("aaaa-old"),
        Some("user"),
    );
    // Refusal semantics are unchanged on EVERY tick of the window...
    assert!(locator.tick_forks(1_100).is_empty());
    assert!(locator.tick_forks(1_200).is_empty());
    assert!(locator.tick_forks(1_300).is_empty());
    // ...but the warn fires once, not once per tick.
    assert_eq!(
        hits.load(Ordering::SeqCst),
        1,
        "one warn per ambiguity window"
    );
    // A NEW Enter opens a new window: the condition is fresh -> warn again.
    assert!(locator.note_fork_submit("t1", 5_000));
    assert!(locator.tick_forks(5_100).is_empty());
    assert_eq!(
        hits.load(Ordering::SeqCst),
        2,
        "a new window re-arms the warn"
    );
    let _ = std::fs::remove_dir_all(&root);
}
