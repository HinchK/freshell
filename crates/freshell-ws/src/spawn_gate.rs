//! Server-wide bounded-concurrency PTY spawn gate (restart-storm protection;
//! prior art: docs/plans/2026-07-06-wsl-outage-rca.md — a ~20-tab fleet
//! respawning 50-70 processes in the same instant).
//!
//! Semantics:
//! - `concurrency` permits bound simultaneous PTY spawns server-wide.
//! - FIFO-fair: tokio's Semaphore hands released permits to the oldest
//!   queued waiter, so restore storms drain in arrival order.
//! - Bounded queue: more than `queue_cap` waiters fails LOUD (`QueueFull`)
//!   instead of queueing unboundedly.
//! - Bounded wait: a waiter that cannot get a permit within the timeout
//!   fails LOUD (`Timeout`). Both bounds must resolve far below the frozen
//!   client's ~38s RATE_LIMITED ladder patience.
//! - RAII: the returned `OwnedSemaphorePermit` releases on drop — every
//!   completion/failure/panic path frees the permit.
//!
//! `restore:true` creates bypass the RATE limiter but NOT this gate — the
//! gate is exactly what protects restore storms.

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
}

#[derive(Debug)]
pub struct SpawnGate {
    semaphore: Arc<Semaphore>,
    queue_cap: usize,
    waiting: AtomicUsize,
    queued_total: AtomicU64,
    queue_rejections: AtomicU64,
    timeouts: AtomicU64,
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
        }
    }

    pub fn from_config(cfg: &crate::create_limit::CreateProtectConfig) -> Self {
        Self::new(cfg.spawn_concurrency, cfg.spawn_queue_cap)
    }

    /// Acquire a spawn permit, queueing FIFO behind other waiters.
    pub async fn acquire(&self, timeout: Duration) -> Result<OwnedSemaphorePermit, SpawnGateError> {
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
        self.queued_total.fetch_add(1, Ordering::Relaxed);
        tracing::info!(
            target: "freshell_ws::spawn_gate",
            waiting = waiting_before + 1,
            "spawn_gate_queued"
        );

        let acquired =
            tokio::time::timeout(timeout, self.semaphore.clone().acquire_owned()).await;
        self.waiting.fetch_sub(1, Ordering::SeqCst);
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

    pub fn queued_total(&self) -> u64 {
        self.queued_total.load(Ordering::Relaxed)
    }

    pub fn queue_rejections(&self) -> u64 {
        self.queue_rejections.load(Ordering::Relaxed)
    }

    pub fn timeouts(&self) -> u64 {
        self.timeouts.load(Ordering::Relaxed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicUsize;

    #[tokio::test]
    async fn bounds_concurrency_to_n_and_all_complete() {
        // Spec requirement: spawn N+K creates, assert max in-flight == N,
        // all complete.
        let gate = Arc::new(SpawnGate::new(2, 64));
        let in_flight = Arc::new(AtomicUsize::new(0));
        let max_seen = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for _ in 0..6 {
            let gate = Arc::clone(&gate);
            let in_flight = Arc::clone(&in_flight);
            let max_seen = Arc::clone(&max_seen);
            handles.push(tokio::spawn(async move {
                let permit = gate.acquire(Duration::from_secs(5)).await.expect("permit");
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
        assert_eq!(max_seen.load(Ordering::SeqCst), 2, "max in-flight must equal N");
    }

    #[tokio::test]
    async fn drains_fifo_in_arrival_order() {
        let gate = Arc::new(SpawnGate::new(1, 64));
        let holder = gate.acquire(Duration::from_secs(1)).await.expect("holder");
        let order = Arc::new(tokio::sync::Mutex::new(Vec::<usize>::new()));
        let mut handles = Vec::new();
        for i in 0..4 {
            let gate = Arc::clone(&gate);
            let order = Arc::clone(&order);
            handles.push(tokio::spawn(async move {
                let permit = gate.acquire(Duration::from_secs(5)).await.expect("permit");
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
        assert_eq!(*order.lock().await, vec![0, 1, 2, 3], "restore storms drain in order");
    }

    #[tokio::test]
    async fn queue_cap_fails_loud() {
        let gate = Arc::new(SpawnGate::new(1, 2));
        let _holder = gate.acquire(Duration::from_secs(1)).await.expect("holder");
        // Two waiters occupy the queue.
        let w1 = { let g = Arc::clone(&gate); tokio::spawn(async move { g.acquire(Duration::from_secs(5)).await }) };
        let w2 = { let g = Arc::clone(&gate); tokio::spawn(async move { g.acquire(Duration::from_secs(5)).await }) };
        tokio::time::sleep(Duration::from_millis(50)).await; // let them enqueue
        // Third waiter overflows the cap: immediate loud failure.
        let res = gate.acquire(Duration::from_secs(5)).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::QueueFull);
        assert_eq!(gate.queue_rejections(), 1);
        drop(_holder);
        assert!(w1.await.expect("join").is_ok());
        assert!(w2.await.expect("join").is_ok());
    }

    #[tokio::test]
    async fn timeout_fails_loud_and_leaks_no_permit() {
        let gate = SpawnGate::new(1, 64);
        let holder = gate.acquire(Duration::from_secs(1)).await.expect("holder");
        let res = gate.acquire(Duration::from_millis(50)).await;
        assert_eq!(res.unwrap_err(), SpawnGateError::Timeout);
        assert_eq!(gate.timeouts(), 1);
        drop(holder);
        // The timed-out wait must not have consumed the permit.
        let again = gate.acquire(Duration::from_millis(500)).await;
        assert!(again.is_ok(), "no leaked permits after a timeout");
    }

    #[tokio::test]
    async fn raii_drop_releases_permit() {
        let gate = SpawnGate::new(1, 64);
        let p = gate.acquire(Duration::from_millis(100)).await.expect("first");
        drop(p);
        let p2 = gate.acquire(Duration::from_millis(100)).await;
        assert!(p2.is_ok(), "dropping the guard frees the permit");
    }
}
