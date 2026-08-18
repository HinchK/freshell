//! Per-connection `includeSubagents` interest registry (amplifier watch
//! reduction, 2026-08-17 design: subagent-session freshness is demand-driven).
//!
//! A `/ws` connection that sends `sessions.prefs { includeSubagents: true }`
//! is INTERESTED; the amplifier subagent rescan cadence runs while ANY
//! connected client is interested. `terminal.rs`'s `sessions.prefs` dispatch
//! arm overwrites the sending connection's LATEST declared preference on each
//! frame, and the connection-teardown block clears it — connected-ness (plus
//! the latest flag) is the whole gate, never a fetch-recency time window. A
//! frozen client never sends the frame, so its connections are never
//! interested.
//!
//! Shape precedent: [`crate::screenshot::ScreenshotBroker`] (a
//! cheaply-cloneable `Arc` handle shared by every connection + the production
//! server's cadence task). `count_handle()` hands the cross-crate consumer
//! (the session watcher's subagent-mkdir gate) a lock-free read.

use std::collections::HashSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

/// The shared interior: the interested connection-id set under a lock, and a
/// lock-free mirror of its cardinality for cross-crate gate reads. The two are
/// always updated under the same lock acquisition, so `count` can never drift
/// from `interested.len()`.
#[derive(Default)]
struct Inner {
    interested: Mutex<HashSet<u64>>,
    count: Arc<AtomicUsize>,
}

/// A cheaply-cloneable handle to the per-connection includeSubagents interest
/// set. All clones share the one underlying set (like `ScreenshotBroker`).
#[derive(Clone, Default)]
pub struct SubagentInterestRegistry {
    inner: Arc<Inner>,
}

impl SubagentInterestRegistry {
    /// Declare (or retract) this connection's includeSubagents interest.
    /// Overwrites the connection's LATEST declared preference; idempotent;
    /// `set(id, false)` on an unknown id is harmless.
    pub fn set(&self, conn_id: u64, interested: bool) {
        let mut guard = self.inner.interested.lock().unwrap();
        // `insert`/`remove` report whether the cardinality actually changed
        // (idempotence); the count mirror is mutated under the same lock, so
        // it can never drift from the set.
        let changed = if interested {
            guard.insert(conn_id)
        } else {
            guard.remove(&conn_id)
        };
        if changed {
            if interested {
                self.inner.count.fetch_add(1, Ordering::SeqCst);
            } else {
                self.inner.count.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    /// Clear a connection's entry entirely (teardown). Equivalent to
    /// `set(conn_id, false)` — unknown ids are a no-op.
    pub fn remove(&self, conn_id: u64) {
        self.set(conn_id, false);
    }

    /// True iff at least one connected client is currently interested.
    pub fn any(&self) -> bool {
        self.inner.count.load(Ordering::SeqCst) > 0
    }

    /// The lock-free cardinality mirror, for cross-crate gate reads (the
    /// session watcher's subagent-mkdir gate reads `> 0`).
    pub fn count_handle(&self) -> Arc<AtomicUsize> {
        Arc::clone(&self.inner.count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn set_any_remove_semantics() {
        let r = SubagentInterestRegistry::default();
        assert!(!r.any());
        r.set(7, true);
        assert!(r.any());
        r.set(7, true); // idempotent
        assert!(r.any());
        r.set(9, true);
        assert!(r.any());
        r.remove(7);
        assert!(r.any(), "other connection still interested");
        r.remove(42); // unknown id is a no-op
        assert!(r.any());
        r.remove(9);
        assert!(!r.any());
    }
}
