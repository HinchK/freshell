use super::*;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::oneshot;

#[derive(Debug)]
struct DropJob {
    id: usize,
    drops: Arc<AtomicUsize>,
}
impl Drop for DropJob {
    fn drop(&mut self) {
        self.drops.fetch_add(1, Ordering::SeqCst);
    }
}

async fn bounded<T>(future: impl Future<Output = T>) -> T {
    tokio::time::timeout(Duration::from_secs(2), future)
        .await
        .expect("worker must make progress")
}

#[tokio::test]
async fn one_slow_create_does_not_occupy_its_callers_task() {
    let (tx, rx) = mpsc::channel(2);
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    tx.send((started_tx, release_rx)).await.unwrap();
    drop(tx);
    let task = tokio::spawn(run_serial(
        0,
        rx,
        cancel_rx,
        |count, (started, release)| async move {
            let _ = started.send(());
            let _ = release.await;
            count + 1
        },
    ));
    bounded(started_rx).await.unwrap();
    // The task serving an existing pane can run while the worker is parked.
    let (input_tx, input_rx) = oneshot::channel();
    tokio::spawn(async move {
        input_tx.send("input dispatched").unwrap();
    });
    assert_eq!(bounded(input_rx).await.unwrap(), "input dispatched");
    release_tx.send(()).unwrap();
    assert_eq!(bounded(task).await.unwrap(), 1);
}

#[tokio::test]
async fn worker_preserves_fifo_and_one_shared_rate_limiter() {
    let (tx, rx) = mpsc::channel(4);
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    for id in 0..4 {
        tx.send(id).await.unwrap();
    }
    drop(tx);
    let observed = Arc::new(Mutex::new(Vec::new()));
    let copy = Arc::clone(&observed);
    let _ = run_serial(
        CreateRateLimiter::new(2, 1000),
        rx,
        cancel_rx,
        move |mut limiter, id| {
            let observed = Arc::clone(&copy);
            async move {
                observed.lock().unwrap().push((id, limiter.try_acquire(0)));
                limiter
            }
        },
    )
    .await;
    assert_eq!(
        *observed.lock().unwrap(),
        vec![(0, true), (1, true), (2, false), (3, false)]
    );
}

#[tokio::test]
async fn cancellation_drains_queued_jobs_after_the_started_job() {
    let (tx, rx) = mpsc::channel(4);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let drops = Arc::new(AtomicUsize::new(0));
    for id in 0..3 {
        tx.send(DropJob {
            id,
            drops: Arc::clone(&drops),
        })
        .await
        .unwrap();
    }
    let (started_tx, started_rx) = oneshot::channel();
    let (release_tx, release_rx) = oneshot::channel();
    let mut started = Some(started_tx);
    let mut release = Some(release_rx);
    let task = tokio::spawn(run_serial(
        Vec::new(),
        rx,
        cancel_rx,
        move |mut ids, job| {
            let started = started.take();
            let release = release.take();
            async move {
                if let Some(started) = started {
                    let _ = started.send(());
                }
                if let Some(release) = release {
                    let _ = release.await;
                }
                ids.push(job.id);
                drop(job);
                ids
            }
        },
    ));
    bounded(started_rx).await.unwrap();
    cancel_tx.send(true).unwrap();
    // Cancellation closes admission promptly, but nothing accepted is
    // discarded: queued jobs are neither run ahead of the active job nor
    // dropped (received ⇒ settles, matching the old inline dispatch).
    bounded(async {
        while !tx.is_closed() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    assert_eq!(
        drops.load(Ordering::SeqCst),
        0,
        "accepted jobs are never dropped"
    );
    release_tx.send(()).unwrap();
    assert_eq!(
        bounded(task).await.unwrap(),
        vec![0, 1, 2],
        "queued jobs drain in FIFO order behind the started job"
    );
    assert_eq!(drops.load(Ordering::SeqCst), 3);
}

#[tokio::test]
async fn dropping_cancellation_sender_still_completes_received_work() {
    let (tx, rx) = mpsc::channel(2);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    tx.send(1).await.unwrap();
    drop(cancel_tx);
    // A vanished cancel signal closes admission; it cannot retract work a
    // producer already got accepted (the connection is gone either way).
    let count = run_serial(0, rx, cancel_rx, |count, _| async move { count + 1 }).await;
    assert_eq!(count, 1);
    assert!(tx.is_closed());
}

#[tokio::test]
async fn already_cancelled_still_completes_the_received_job() {
    let (tx, rx) = mpsc::channel(2);
    let (_cancel_tx, cancel_rx) = watch::channel(true);
    tx.send(1).await.unwrap();
    // Production cannot produce this ordering (a cancelled connection's
    // reader has already dropped the sender half, so try_send fails closed);
    // if a job did land, the drain completes it rather than losing it.
    assert_eq!(
        run_serial(0, rx, cancel_rx, |count, _| async move { count + 1 }).await,
        1
    );
}

#[tokio::test]
async fn cancellation_wakes_an_idle_worker() {
    let (_tx, rx) = mpsc::channel::<()>(2);
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let task = tokio::spawn(run_serial(
        0,
        rx,
        cancel_rx,
        |count, _| async move { count + 1 },
    ));
    cancel_tx.send(true).unwrap();
    assert_eq!(bounded(task).await.unwrap(), 0);
}

#[tokio::test]
async fn worker_panic_drops_active_and_queued_job_guards() {
    let (tx, rx) = mpsc::channel(3);
    let (_cancel_tx, cancel_rx) = watch::channel(false);
    let drops = Arc::new(AtomicUsize::new(0));
    for id in 0..3 {
        tx.send(DropJob {
            id,
            drops: Arc::clone(&drops),
        })
        .await
        .unwrap();
    }
    let task = tokio::spawn(run_serial((), rx, cancel_rx, |(), job| async move {
        let _active_job = job;
        panic!("injected worker failure");
    }));
    assert!(bounded(task).await.unwrap_err().is_panic());
    assert_eq!(drops.load(Ordering::SeqCst), 3);
    assert!(tx.is_closed());
}

#[test]
fn cleanup_panic_cannot_escape_a_drop_guard() {
    let result = std::panic::catch_unwind(|| {
        cleanup_without_unwinding("test-request", || panic!("injected cleanup failure"));
    });
    assert!(result.is_ok());
}

#[test]
fn successful_cleanup_is_run_exactly_once() {
    let count = AtomicUsize::new(0);
    cleanup_without_unwinding("test-request", || {
        count.fetch_add(1, Ordering::SeqCst);
    });
    assert_eq!(count.load(Ordering::SeqCst), 1);
}
