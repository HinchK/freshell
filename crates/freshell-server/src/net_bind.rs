//! Listener binding for the transactional rebind (NET-02).
//!
//! We create every listener (boot AND rebind) with SO_REUSEADDR + SO_REUSEPORT
//! so a new listener can be *proven to bind* before we persist the config and
//! retire the old one. Rollback is dropping the new socket — an infallible
//! no-op. There is never a zero-listener window and persisted state never
//! outruns reality. The `FRESHELL_REBIND_NO_REUSEPORT=1` escape hatch disables
//! SO_REUSEPORT (falls back to a best-effort bind a foreign squatter can block).
//!
//! Drain design (VALIDATED — ledger A-03 falsified the naive version): the
//! controller owns its own accept loop per listener. Retiring a listener uses
//! `Notify::notify_one()` (permit-storing: the wakeup cannot be lost, unlike
//! `notify_waiters`) and then AWAITS the old accept-loop `JoinHandle`, which
//! exits only after dropping its listener — a deterministic "old socket
//! closed" barrier, so callers may respond/probe immediately after `serve_on`
//! returns. In-flight connections (incl. WebSockets) drain in their own
//! spawned tasks — no mass 4009 on rebind.
//!
//! Trade-off: SO_REUSEPORT lets another process of the same effective UID bind
//! the port. On a single-user self-hosted box that is inside the same trust
//! boundary as the auth token.

use std::net::{IpAddr, SocketAddr, TcpListener as StdTcpListener};
use std::sync::{Arc, OnceLock};

use axum::Router;
use socket2::{Domain, Protocol, Socket, Type};
use tokio::sync::{Mutex, Notify};
use tokio::task::JoinHandle;

pub fn parse_reuse_port(raw: Option<&str>) -> bool {
    match raw {
        Some(v) => !matches!(v.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes"),
        None => true,
    }
}

pub fn reuse_port_enabled() -> bool {
    parse_reuse_port(
        std::env::var("FRESHELL_REBIND_NO_REUSEPORT")
            .ok()
            .as_deref(),
    )
}

pub fn bind_reusable(addr: SocketAddr, reuse_port: bool) -> std::io::Result<StdTcpListener> {
    let domain = match addr.ip() {
        IpAddr::V4(_) => Domain::IPV4,
        IpAddr::V6(_) => Domain::IPV6,
    };
    let socket = Socket::new(domain, Type::STREAM, Some(Protocol::TCP))?;
    socket.set_reuse_address(true)?;
    #[cfg(unix)]
    if reuse_port {
        socket.set_reuse_port(true)?;
    }
    #[cfg(not(unix))]
    let _ = reuse_port;
    socket.bind(&addr.into())?;
    socket.listen(1024)?;
    let std_listener: StdTcpListener = socket.into();
    std_listener.set_nonblocking(true)?;
    Ok(std_listener)
}

/// One live listener: its shutdown signal + the accept-loop task handle. The
/// accept loop drops its listener before exiting, so awaiting the handle is a
/// true "old socket closed" barrier.
struct LiveListener {
    shutdown: Arc<Notify>,
    accept_loop: JoinHandle<()>,
}

pub struct RebindController {
    port: u16,
    reuse_port: bool,
    app: OnceLock<Router>,
    current: Mutex<Option<LiveListener>>,
}

impl RebindController {
    pub fn new(port: u16, reuse_port: bool) -> Arc<Self> {
        Arc::new(Self {
            port,
            reuse_port,
            app: OnceLock::new(),
            current: Mutex::new(None),
        })
    }

    pub fn set_app(&self, app: Router) {
        let _ = self.app.set(app); // first (full) app wins
    }

    // Consumed by Task 2.3/2.4's network mutation endpoints (they gate the
    // rebind path on a fully-built app); until then nothing in the bin reads it.
    #[allow(dead_code)]
    pub fn has_app(&self) -> bool {
        self.app.get().is_some()
    }

    /// Bind `host:port` (proof), start our own accept loop, then retire the old
    /// listener: `notify_one` (permit-storing, cannot be lost) + await its
    /// JoinHandle (deterministic closed barrier). On bind failure the previous
    /// listener is left untouched (no swap). When no app has been injected
    /// (unit tests) this is an Ok no-op so validation and persistence can be
    /// tested without a real socket.
    pub async fn serve_on(&self, host: IpAddr) -> std::io::Result<()> {
        let Some(app) = self.app.get().cloned() else {
            return Ok(());
        };
        let addr = SocketAddr::new(host, self.port);
        let std_listener = bind_reusable(addr, self.reuse_port)?; // PROOF: must succeed
        let listener = tokio::net::TcpListener::from_std(std_listener)?;
        let shutdown = Arc::new(Notify::new());
        let shut = Arc::clone(&shutdown);
        let accept_loop = tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = shut.notified() => break,
                    res = listener.accept() => {
                        let (stream, _remote) = match res {
                            Ok(accepted) => accepted,
                            Err(err) => {
                                // A persistent accept failure (e.g. EMFILE)
                                // must not silently busy-loop: log it and back
                                // off briefly before retrying.
                                tracing::warn!(error = %err, "listener accept failed; retrying after backoff");
                                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                                continue;
                            }
                        };
                        let app = app.clone();
                        tokio::spawn(async move {
                            // axum 0.8 "serve with hyper directly" pattern — if the
                            // compiler objects to the service shape, mirror the
                            // vendored axum example `serve-with-hyper` exactly.
                            // `serve_connection_with_upgrades` keeps WebSockets working.
                            use tower::ServiceExt as _;
                            let socket = hyper_util::rt::TokioIo::new(stream);
                            let hyper_service = hyper::service::service_fn(
                                move |request: hyper::Request<hyper::body::Incoming>| {
                                    app.clone().oneshot(request)
                                },
                            );
                            let _ = hyper_util::server::conn::auto::Builder::new(
                                hyper_util::rt::TokioExecutor::new(),
                            )
                            .serve_connection_with_upgrades(socket, hyper_service)
                            .await;
                        });
                    }
                }
            }
            // `listener` is dropped HERE, before the task completes: awaiting
            // this JoinHandle is a true "old listener closed" barrier.
        });
        let mut cur = self.current.lock().await;
        if let Some(old) = cur.replace(LiveListener {
            shutdown,
            accept_loop,
        }) {
            old.shutdown.notify_one(); // permit-storing: never lost
            let _ = old.accept_loop.await; // barrier: old socket provably closed
        }
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        if let Some(cur) = self.current.lock().await.take() {
            cur.shutdown.notify_one();
            let _ = cur.accept_loop.await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr, SocketAddr};

    fn free_port() -> u16 {
        let l = std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        l.local_addr().unwrap().port()
    }

    #[test]
    fn reuse_port_kill_switch_reads_env() {
        assert!(parse_reuse_port(None));
        assert!(!parse_reuse_port(Some("1")));
        assert!(!parse_reuse_port(Some("TRUE")));
        assert!(!parse_reuse_port(Some("yes")));
        assert!(parse_reuse_port(Some("0")));
        assert!(parse_reuse_port(Some("")));
    }

    #[test]
    fn two_reuseport_binds_on_same_addr_both_succeed() {
        let port = free_port();
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
        let a = bind_reusable(addr, true).expect("first reuseport bind");
        let b = bind_reusable(addr, true).expect("second reuseport bind must also succeed");
        drop((a, b));
    }

    #[test]
    fn foreign_squatter_blocks_our_bind() {
        let port = free_port();
        let addr = SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port);
        let squatter = std::net::TcpListener::bind(addr).expect("squatter binds");
        let result = bind_reusable(addr, true);
        assert!(
            result.is_err(),
            "reuseport bind must still fail against a foreign non-reuseport squatter"
        );
        drop(squatter);
    }

    #[tokio::test]
    async fn serve_on_proves_bind_before_swapping_and_serves_traffic() {
        use axum::{routing::get, Router};
        let port = free_port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        ctl.serve_on(IpAddr::V4(Ipv4Addr::LOCALHOST))
            .await
            .expect("initial serve");
        let body = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body, "pong");
        ctl.serve_on(IpAddr::V4(Ipv4Addr::UNSPECIFIED))
            .await
            .expect("rebind serve");
        let body2 = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
            .await
            .unwrap()
            .text()
            .await
            .unwrap();
        assert_eq!(body2, "pong");
        ctl.shutdown_all().await;
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn hundred_rapid_rebinds_never_lose_a_listener_or_reset_a_probe() {
        // Falsifier for the validated lost-wakeup/drain race (ledger A-03,
        // reports/V1.md): with notify_waiters and no barrier, 42-99/100 of
        // these iterations fail. Do NOT weaken this test.
        use axum::{routing::get, Router};
        let port = free_port();
        let app = Router::new().route("/ping", get(|| async { "pong" }));
        let ctl = RebindController::new(port, true);
        ctl.set_app(app);
        let localhost = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let wildcard = IpAddr::V4(Ipv4Addr::UNSPECIFIED);
        ctl.serve_on(localhost).await.expect("initial serve");
        for i in 0..100 {
            let target = if i % 2 == 0 { wildcard } else { localhost };
            ctl.serve_on(target).await.expect("swap");
            // serve_on returned => the OLD listener is closed (barrier), so an
            // immediate probe must hit the new listener, never ConnectionReset.
            let body = reqwest::get(format!("http://127.0.0.1:{port}/ping"))
                .await
                .expect("probe connects")
                .text()
                .await
                .unwrap();
            assert_eq!(body, "pong", "swap #{i}");
        }
        ctl.shutdown_all().await;
        // Port fully released: a plain (non-reuseport) bind succeeds only if no
        // stuck listener remains (the lost-wakeup failure mode).
        std::net::TcpListener::bind((Ipv4Addr::LOCALHOST, port))
            .expect("no stuck listeners after 100 swaps");
    }
}
