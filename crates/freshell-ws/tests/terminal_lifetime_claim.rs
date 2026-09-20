//! Real-server idle-threshold survival for hidden-pane lifetime claims
//! (responsive-terminal-restore Workstream 1).
//!
//! Runs as its own INTEGRATION binary on purpose: the shared test clock
//! (`freshell_platform::clock`, HARNESS-14) is process-global, so overriding
//! it here keeps the virtual-time machinery scoped to this binary (same
//! discipline as `test_clock_routing.rs`).
//!
//! Proves, over the REAL axum server + REAL `tokio-tungstenite` client + a
//! REAL spawned shell PTY, with a configured `autoKillIdleMinutes`:
//!  1. a created-hidden terminal held only by the negotiated claim survives
//!     the configured idle threshold, and an explicit claim withdrawal (a
//!     later interest snapshot omitting the id) re-exposes it — the sweep
//!     then reaps it at the threshold;
//!  2. a claim-connection DROP (transport loss) keeps the terminal wanted
//!     past the configured threshold (24-hour hard cap only — never
//!     threshold-reaped), and the hard cap stays the cleanup backstop.
//!
//! Zero wall-clock sleeps for the virtual waits; the sweep itself is driven
//! explicitly via the public `enforce_idle_kills`. The only processes this
//! binary kills are its own spawned server's terminals (its own PTYs), so
//! the destructive-test sandbox rule does not apply.

use std::sync::{Mutex, MutexGuard};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio_tungstenite::tungstenite::Message;

mod common;

const MINUTE_MS: i64 = 60_000;

/// Serialize + scope the process-global override within THIS binary.
static LOCK: Mutex<()> = Mutex::new(());

struct GateGuard {
    _guard: MutexGuard<'static, ()>,
}

impl GateGuard {
    fn enable() -> Self {
        let guard = LOCK.lock().unwrap_or_else(|p| p.into_inner());
        freshell_platform::clock::set_enabled_override_for_tests(Some(true));
        freshell_platform::clock::reset().expect("override enabled");
        freshell_platform::clock::freeze().expect("freeze at virtual T");
        Self { _guard: guard }
    }
}

impl Drop for GateGuard {
    fn drop(&mut self) {
        let _ = freshell_platform::clock::reset();
        freshell_platform::clock::set_enabled_override_for_tests(None);
    }
}

async fn receive(ws: &mut common::TestWs, kind: &str) -> Value {
    tokio::time::timeout(common::FRAME_BUDGET, async {
        loop {
            match ws
                .next()
                .await
                .expect("socket remains open")
                .expect("valid frame")
            {
                Message::Text(text) => {
                    let value: Value = serde_json::from_str(&text).expect("JSON");
                    if value["type"] == kind {
                        return value;
                    }
                    assert_ne!(value["type"], "error", "unexpected error: {value}");
                }
                Message::Ping(bytes) => {
                    ws.send(Message::Pong(bytes)).await.unwrap();
                }
                Message::Close(_) => panic!("unexpected close"),
                _ => {}
            }
        }
    })
    .await
    .expect("bounded frame receive")
}

async fn send(ws: &mut common::TestWs, value: Value) {
    ws.send(Message::Text(value.to_string())).await.unwrap();
}

/// Connect with the lifetime-claim negotiation and read past the handshake.
async fn connect_claim_negotiated(url: &str) -> (common::TestWs, Value) {
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.unwrap();
    send(
        &mut ws,
        json!({"type":"hello","token":common::AUTH_TOKEN,
            "protocolVersion":freshell_protocol::WS_PROTOCOL_VERSION,
            "capabilities":{"terminalInterestV1":true,"terminalLifetimeClaimV1":true}}),
    )
    .await;
    let ready = receive(&mut ws, "ready").await;
    receive(&mut ws, "terminal.inventory").await;
    (ws, ready)
}

/// Send `terminal.create` (shell) and return the created terminalId.
async fn create_shell_terminal(ws: &mut common::TestWs, request_id: &str) -> String {
    send(
        ws,
        json!({"type":"terminal.create","requestId":request_id,
            "mode":"shell","shell":"system"}),
    )
    .await;
    let deadline = tokio::time::Instant::now() + common::FRAME_BUDGET;
    while tokio::time::Instant::now() < deadline {
        let value = tokio::time::timeout(common::FRAME_BUDGET, ws.next())
            .await
            .expect("socket remains open")
            .expect("valid frame")
            .expect("frame ok");
        let Message::Text(text) = value else { continue };
        let parsed: Value = serde_json::from_str(&text).expect("JSON");
        if parsed["type"] == "terminal.created" && parsed["requestId"] == request_id {
            return parsed["terminalId"]
                .as_str()
                .expect("terminalId")
                .to_string();
        }
    }
    panic!("terminal.created never arrived");
}

/// Fence: the pong for a ping proves the preceding typed dispatch finished.
async fn fence_with_ping(ws: &mut common::TestWs) {
    send(ws, json!({"type":"ping"})).await;
    receive(ws, "pong").await;
}

/// Poll until `pred` holds (bounded) — used to await the server's
/// asynchronous socket-close cleanup (the claim sweep in remove_connection).
async fn eventually<T>(mut probe: impl FnMut() -> Option<T>) -> T {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(value) = probe() {
            return value;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "condition never became true"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// Created-hidden + claim-only survival past the configured threshold, then
/// explicit withdrawal re-exposes the terminal to the threshold and the
/// sweep reaps it.
#[tokio::test]
async fn created_hidden_claim_survives_threshold_and_withdrawal_reaps() {
    let _gate = GateGuard::enable();
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, ready) = connect_claim_negotiated(&url).await;
    assert_eq!(
        ready["capabilities"]["terminalLifetimeClaimV1"], true,
        "the negotiation rail must echo the claim capability: {ready}"
    );

    // Created-hidden: the pane never attaches. All stamps land at virtual T
    // (the clock is frozen).
    let tid = create_shell_terminal(&mut ws, "req-survival-1").await;
    registry.set_auto_kill_idle_minutes(1);

    // The interest snapshot claims the hidden terminal (no attach).
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
            "focusedTerminalId":null,"visibleTerminalIds":[],
            "claimedTerminalIds":[&tid]}),
    )
    .await;
    fence_with_ping(&mut ws).await;
    assert_eq!(
        registry
            .claim_state(&tid)
            .map(|s| (s.claimers, s.released_by_client)),
        Some((1, false))
    );

    // Two virtual minutes idle — past the 1-minute configured threshold.
    freshell_platform::clock::advance_ms(2 * MINUTE_MS).unwrap();
    let killed = registry.enforce_idle_kills();
    assert!(
        !killed.contains(&tid),
        "a claim-only hidden terminal must survive the configured idle threshold, got {killed:?}"
    );

    // Explicit withdrawal (a later snapshot no longer claims the id): the
    // terminal is re-exposed to the configured threshold...
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":2,
            "focusedTerminalId":null,"visibleTerminalIds":[],
            "claimedTerminalIds":[]}),
    )
    .await;
    fence_with_ping(&mut ws).await;
    assert_eq!(
        registry
            .claim_state(&tid)
            .map(|s| (s.claimers, s.released_by_client)),
        Some((0, true))
    );

    // ...and once past the DEV-0009 withdrawal grace, the sweep reaps it.
    freshell_platform::clock::advance_ms(2 * MINUTE_MS).unwrap();
    let killed = registry.enforce_idle_kills();
    assert_eq!(
        killed,
        vec![tid.clone()],
        "after explicit withdrawal the terminal must be reaped at the configured threshold"
    );
}

/// A claim-connection DROP (transport loss) is NOT release: the terminal
/// stays wanted past the configured threshold (24-hour hard cap only), and
/// the hard cap stays the cleanup backstop for an abandoned claim.
#[tokio::test]
async fn claim_connection_drop_keeps_terminal_wanted_until_hard_cap() {
    let _gate = GateGuard::enable();
    let (url, registry) = common::spawn_server_with_specs(vec![]).await;
    let (mut ws, _) = connect_claim_negotiated(&url).await;

    let tid = create_shell_terminal(&mut ws, "req-survival-2").await;
    registry.set_auto_kill_idle_minutes(1);
    send(
        &mut ws,
        json!({"type":"terminal.interest","revision":1,
            "focusedTerminalId":null,"visibleTerminalIds":[],
            "claimedTerminalIds":[&tid]}),
    )
    .await;
    fence_with_ping(&mut ws).await;

    // Transport loss: close the socket (no terminal.detach, no withdrawal).
    ws.send(Message::Close(None)).await.expect("clean close");
    drop(ws);
    eventually(|| match registry.claim_state(&tid) {
        Some(state) if state.claimers == 0 => Some(()),
        _ => None,
    })
    .await;

    // Past the configured threshold, still wanted (24h hard cap only).
    freshell_platform::clock::advance_ms(2 * MINUTE_MS).unwrap();
    let killed = registry.enforce_idle_kills();
    assert!(
        !killed.contains(&tid),
        "transport loss must not re-expose the terminal to the configured threshold, got {killed:?}"
    );

    // 25 virtual hours after the drop: the hard cap reaps the abandoned row.
    freshell_platform::clock::advance_ms(25 * 60 * MINUTE_MS).unwrap();
    let killed = registry.enforce_idle_kills();
    assert_eq!(
        killed,
        vec![tid],
        "the 24h hard cap must stay the cleanup backstop for an abandoned claim"
    );
}
