//! Server-wide bounded-concurrency PTY spawn gate (restart-storm protection;
//! prior art: docs/plans/2026-07-06-wsl-outage-rca.md — a ~20-tab fleet
//! respawning 50-70 processes in the same instant).
//!
//! Semantics:
//! - `concurrency` permits bound simultaneous PTY spawns server-wide, from
//!   before the PTY spawn through the terminal being settled
//!   (`terminal.created` + broadcasts queued) — the caller
//!   (`crate::create_gate`) owns that scope via the RAII permit.
//! - FIFO-fair: tokio's Semaphore hands released permits to the oldest
//!   queued waiter, so restore storms drain in arrival order (the
//!   `try_acquire_owned` fast path fails while waiters queue — no barging).
//! - Bounded queue: more than `queue_cap` waiters fails LOUD (`QueueFull`)
//!   instead of queueing unboundedly.
//! - Bounded wait: a waiter that cannot get a permit within the timeout
//!   fails LOUD (`Timeout`). Both bounds must resolve far below the frozen
//!   client's ~38s RATE_LIMITED ladder patience.
//! - CANCELLABLE: a queued waiter whose per-connection cancel watch fires
//!   (or whose sender drops — the connection loop exited) unblocks with
//!   `Cancelled` immediately. This is what lets a disconnecting client or a
//!   shutting-down server abandon queued creates without ever spawning a PTY.
//! - RAII: the returned `OwnedSemaphorePermit` releases on drop — every
//!   completion/failure/panic path frees the permit. Never call
//!   `permit.forget()` (it permanently shrinks capacity).
//!
//! RESTORE-ONLY scope (user decision, PR #552): `restore:true` creates
//! bypass the RATE limiter but go through THIS gate (via
//! `crate::create_gate::spawn_gated_restore_create`'s spawned, cancellable
//! acquire) — the gate is exactly what protects restore storms. Interactive
//! (non-restore) creates do the opposite: they are rate-limited but BYPASS
//! this gate entirely, so a human clicking "new terminal" gets an instant
//! create with zero queueing latency.
//!
//! Accepted scope: non-restore (interactive) creates intentionally bypass
//! this gate and therefore have NO server-wide concurrency bound. freshell
//! is a single-user, token-authenticated deployment, so the per-connection
//! rate limiter — rate-shaping, not a hard bound — is accepted as
//! sufficient protection for that path. Decision recorded on PR #552 after
//! council review (post-c3268185).
//!
//! HOME NOTE: this module moved from `freshell-ws` so the freshagent REST
//! create pipeline can share the ONE server-wide gate (freshell-freshagent
//! cannot import freshell-ws — dependency direction). freshell-ws re-exports
//! it; `freshell-server/src/main.rs` mints the single production instance.
//! The tracing target below stays pinned to the original literal
//! `freshell_ws::spawn_gate` so existing log consumers (e2e greps of
//! rust-server.jsonl) keep working across the move. The REST door acquires
//! with a held, never-fired cancel sender (an HTTP request has no
//! per-connection cancel watch); `SpawnGate::from_config` did NOT move — it
//! referenced freshell-ws's `CreateProtectConfig`, so call sites pass the
//! two (already env-sanitized) values to `new` directly.
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SpawnGateError {
    /// More than `queue_cap` creates were already waiting.
    QueueFull,
    /// No permit became available within the timeout.
    Timeout,
    /// The waiter's connection went away (disconnect or server shutdown).
    Cancelled,
}

/// Cancel-safe accounting for the `waiting` queue-depth counter: the
/// decrement lives in `Drop` so success, timeout, cancellation, and the
/// future being dropped mid-wait all reclaim the slot.
///
/// The caller's future can be DROPPED while suspended in the queued wait
/// (e.g. a WS connection task aborted on disconnect). A straight-line
/// `fetch_sub` after the await would never run on that path, leaking a queue
/// slot per cancellation until the gate wedges into permanent `QueueFull`.
/// Putting the decrement in `Drop` covers every exit: success, timeout, and
/// cancellation.
struct WaitingGuard<'a>(&'a AtomicUsize);

impl Drop for WaitingGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Debug)]
pub struct SpawnGate {
    semaphore: Arc<Semaphore>,
    queue_cap: usize,
    waiting: AtomicUsize,
    queued_total: AtomicU64,
    queue_rejections: AtomicU64,
    timeouts: AtomicU64,
    cancellations: AtomicU64,
}

impl SpawnGate {
    pub fn new(concurrency: usize, queue_cap: usize) -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(concurrency)),
            queue_cap,
            waiting: AtomicUsize::new(0),
            queued_total: AtomicU64::new(0),
            queue_rejections: AtomicU64::new(0),
            timeouts: AtomicU64::new(0),
            cancellations: AtomicU64::new(0),
        }
    }

    /// Acquire a spawn permit, queueing FIFO behind other waiters.
    /// Cancellable: resolves `Err(Cancelled)` the moment `cancel` observes
    /// `true` or its sender drops.
    pub async fn acquire(
        &self,
        timeout: Duration,
        cancel: &mut tokio::sync::watch::Receiver<bool>,
    ) -> Result<OwnedSemaphorePermit, SpawnGateError> {
        if *cancel.borrow() {
            self.cancellations.fetch_add(1, Ordering::Relaxed);
            return Err(SpawnGateError::Cancelled);
        }

        // Fast path: a free permit never queues (tokio's fair semaphore
        // fails try_acquire while waiters are queued, so no barging).
        if let Ok(permit) = self.semaphore.clone().try_acquire_owned() {
            return Ok(permit);
        }

        // Queue-depth cap: fail loud instead of unbounded queueing.
        // (fetch_add/check is approximate under races by at most the number
        // of simultaneously-arriving creates; the cap is a loud safety
        // valve, not an exact admission count.)
        let waiting_before = self.waiting.fetch_add(1, Ordering::SeqCst);
        if waiting_before >= self.queue_cap {
            self.waiting.fetch_sub(1, Ordering::SeqCst);
            self.queue_rejections.fetch_add(1, Ordering::Relaxed);
            tracing::warn!(
                target: "freshell_ws::spawn_gate",
                waiting = waiting_before,
                queue_cap = self.queue_cap,
                "spawn_gate_queue_full"
            );
            return Err(SpawnGateError::QueueFull);
        }
        // From here every exit path (success, timeout, cancellation, drop)
        // decrements `waiting` via the guard's Drop.
        let _waiting_guard = WaitingGuard(&self.waiting);
        self.queued_total.fetch_add(1, Ordering::Relaxed);
        tracing::info!(
            target: "freshell_ws::spawn_gate",
            waiting = waiting_before + 1,
            "spawn_gate_queued"
        );

        tokio::select! {
            acquired = tokio::time::timeout(timeout, self.semaphore.clone().acquire_owned()) => {
                match acquired {
                    Ok(Ok(permit)) => Ok(permit),
                    // The semaphore is never closed; treat close like timeout.
                    Ok(Err(_closed)) => Err(SpawnGateError::Timeout),
                    Err(_elapsed) => {
                        self.timeouts.fetch_add(1, Ordering::Relaxed);
                        tracing::warn!(
                            target: "freshell_ws::spawn_gate",
                            timeout_ms = timeout.as_millis() as u64,
                            "spawn_gate_timeout"
                        );
                        Err(SpawnGateError::Timeout)
                    }
                }
            }
            // Ok(()) = the value changed (we only ever send `true`);
            // Err(_) = the sender dropped (connection loop exited). Both
            // mean this waiter's client is gone: cancel.
            _ = cancel.changed() => {
                self.cancellations.fetch_add(1, Ordering::Relaxed);
                tracing::info!(
                    target: "freshell_ws::spawn_gate",
                    "spawn_gate_cancelled"
                );
                Err(SpawnGateError::Cancelled)
            }
        }
    }

    pub fn queued_total(&self) -> u64 {
        self.queued_total.load(Ordering::Relaxed)
    }

    pub fn queue_rejections(&self) -> u64 {
        self.queue_rejections.load(Ordering::Relaxed)
    }

    pub fn timeouts(&self) -> u64 {
        self.timeouts.load(Ordering::Relaxed)
    }

    pub fn cancellations(&self) -> u64 {
        self.cancellations.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;
    use tokio::sync::watch;

    fn cancel_pair() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    #[tokio::test]
    async fn bounds_concurrency_to_n_and_all_complete() {
        // Spawn N+K creates, assert max in-flight == N, all complete.
        let gate = Arc::new(SpawnGate::new(2, 64));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let gate = Arc::clone(&gate);
            let in_flight = Arc::clone(&in_flight);
            let max_seen = Arc::clone(&max_seen);
            handles.push(tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                let permit = gate
                    .acquire(Duration::from_secs(5), &mut rx)
                    .await
                    .expect("permit");
                let now = in_flight.fetch_add(1, Ordering::SeqCst) + 1;
                max_seen.fetch_max(now, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(30)).await;
                in_flight.fetch_sub(1, Ordering::SeqCst);
                drop(permit);
            }));
        }
        for h in handles {
            h.await.expect("task completes");
        }
        assert_eq!(
            max_seen.load(Ordering::SeqCst),
            2,
            "max in-flight must equal N"
        );
    }

    #[tokio::test]
    async fn drains_fifo_in_arrival_order() {
        let gate = Arc::new(SpawnGate::new(1, 64));
        let (_htx, mut hrx) = cancel_pair();
        let holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");
        let order = Arc::new(tokio::sync::Mutex::new(Vec::<usize>::new()));
        let mut handles = Vec::new();
        for i in 0..4 {
            let gate = Arc::clone(&gate);
            let order = Arc::clone(&order);
            handles.push(tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                let permit = gate
                    .acquire(Duration::from_secs(5), &mut rx)
                    .await
                    .expect("permit");
                order.lock().await.push(i);
                drop(permit);
            }));
            // Give each waiter time to enqueue before the next arrives.
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        drop(holder);
        for h in handles {
            h.await.expect("task completes");
        }
        assert_eq!(
            *order.lock().await,
            vec![0, 1, 2, 3],
            "storms drain in order"
        );
        assert_eq!(
            gate.queued_total(),
            4,
            "every queued waiter counts toward queued_total"
        );
    }

    #[tokio::test]
    async fn queue_cap_fails_loud() {
        let gate = Arc::new(SpawnGate::new(1, 2));
        let (_htx, mut hrx) = cancel_pair();
        let _holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");
        // Two waiters occupy the queue.
        let w1 = {
            let g = Arc::clone(&gate);
            tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                g.acquire(Duration::from_secs(5), &mut rx).await
            })
        };
        let w2 = {
            let g = Arc::clone(&gate);
            tokio::spawn(async move {
                let (_tx, mut rx) = cancel_pair();
                g.acquire(Duration::from_secs(5), &mut rx).await
            })
        };
        tokio::time::sleep(Duration::from_millis(50)).await; // let them enqueue
                                                             // Third waiter overflows the cap: immediate loud failure.
        let (_tx3, mut rx3) = cancel_pair();
        let res = gate.acquire(Duration::from_secs(5), &mut rx3).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::QueueFull);
        assert_eq!(gate.queue_rejections(), 1);
        drop(_holder);
        assert!(w1.await.expect("join").is_ok());
        assert!(w2.await.expect("join").is_ok());
    }

    #[tokio::test]
    async fn timeout_fails_loud_and_leaks_no_permit() {
        let gate = SpawnGate::new(1, 64);
        let (_htx, mut hrx) = cancel_pair();
        let holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");
        let (_tx, mut rx) = cancel_pair();
        let res = gate.acquire(Duration::from_millis(50), &mut rx).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::Timeout);
        assert_eq!(gate.timeouts(), 1);
        drop(holder);
        // The timed-out wait must not have consumed the permit.
        let (_tx2, mut rx2) = cancel_pair();
        let again = gate.acquire(Duration::from_millis(500), &mut rx2).await;
        assert!(again.is_ok(), "no leaked permits after a timeout");
    }

    #[tokio::test]
    async fn already_cancelled_never_queues() {
        let gate = SpawnGate::new(1, 64);
        let (tx, mut rx) = cancel_pair();
        tx.send(true).expect("send");
        let res = gate.acquire(Duration::from_secs(5), &mut rx).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);
        assert_eq!(
            gate.queued_total(),
            0,
            "a pre-cancelled acquire never queues"
        );
    }

    #[tokio::test]
    async fn cancel_signal_unblocks_queued_waiter_and_reclaims_slot() {
        // A WS connection task's cancel watch can fire while suspended in
        // the queued wait. The `waiting` slot must be reclaimed on
        // cancellation, or drift eventually wedges the gate into permanent
        // QueueFull.
        let gate = Arc::new(SpawnGate::new(1, 1));
        let (_htx, mut hrx) = cancel_pair();
        let holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");

        let (tx, rx) = cancel_pair();
        let waiter = {
            let g = Arc::clone(&gate);
            let mut rx = rx.clone();
            tokio::spawn(async move { g.acquire(Duration::from_secs(30), &mut rx).await })
        };
        // Poll until the waiter is actually queued (no tight sleep race).
        for _ in 0..200 {
            if gate.queued_total() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(
            gate.queued_total(),
            1,
            "waiter must be queued before cancel"
        );

        tx.send(true).expect("send cancel");
        let res = waiter.await.expect("join");
        assert_eq!(res.unwrap_err(), SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);

        // The cancelled wait's queue slot must be reclaimed: a fresh acquire
        // must QUEUE (and time out on the still-held permit), NOT QueueFull.
        let (_tx2, mut rx2) = cancel_pair();
        let res = gate.acquire(Duration::from_millis(50), &mut rx2).await;
        assert_eq!(
            res.unwrap_err(),
            SpawnGateError::Timeout,
            "cancelled queued wait must release its queue slot"
        );

        // And once the permit frees up, the gate fully recovers.
        drop(holder);
        let (_tx3, mut rx3) = cancel_pair();
        let again = gate.acquire(Duration::from_millis(500), &mut rx3).await;
        assert!(again.is_ok(), "gate recovers after a cancelled queued wait");
    }

    #[tokio::test]
    async fn sender_drop_cancels_queued_waiter() {
        // The connection loop exiting (disconnect OR server shutdown) drops
        // the watch sender; a queued create must unblock as Cancelled.
        let gate = Arc::new(SpawnGate::new(1, 64));
        let (_htx, mut hrx) = cancel_pair();
        let _holder = gate
            .acquire(Duration::from_secs(1), &mut hrx)
            .await
            .expect("holder");

        let (tx, rx) = cancel_pair();
        let waiter = {
            let g = Arc::clone(&gate);
            let mut rx = rx.clone();
            tokio::spawn(async move { g.acquire(Duration::from_secs(30), &mut rx).await })
        };
        for _ in 0..200 {
            if gate.queued_total() == 1 {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        drop(tx); // the connection loop exited
        let res = waiter.await.expect("join");
        assert_eq!(res.unwrap_err(), SpawnGateError::Cancelled);
        assert_eq!(gate.cancellations(), 1);
    }

    #[tokio::test]
    async fn raii_drop_releases_permit() {
        let gate = SpawnGate::new(1, 64);
        let (_tx, mut rx) = cancel_pair();
        let p = gate
            .acquire(Duration::from_millis(100), &mut rx)
            .await
            .expect("first");
        drop(p);
        let (_tx2, mut rx2) = cancel_pair();
        let p2 = gate.acquire(Duration::from_millis(100), &mut rx2).await;
        assert!(p2.is_ok(), "dropping the guard frees the permit");
    }
}
