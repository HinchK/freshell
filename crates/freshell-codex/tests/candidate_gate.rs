//! S5.c: candidate-persistence gate integration tests (DEV-0006).
//! Legacy parity target: remote-proxy.ts initial_capture gate (:422-425, :93-94).
#![cfg(feature = "real-transport")]

use freshell_codex::remote_proxy::{
    CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent, RemoteProxyRepairTrigger,
};
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// A minimal fake app-server: accepts one WS connection, records every text
/// frame it receives, and answers any frame carrying an `id` with a canned
/// success result so request/response flows complete.
async fn spawn_fake_upstream() -> (String, mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let url = format!("ws://{}", listener.local_addr().unwrap());
    let (seen_tx, seen_rx) = mpsc::unbounded_channel();
    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let seen_tx = seen_tx.clone();
            tokio::spawn(async move {
                let ws = tokio_tungstenite::accept_async(stream).await.unwrap();
                let (mut write, mut read) = ws.split();
                while let Some(Ok(msg)) = read.next().await {
                    if let tokio_tungstenite::tungstenite::Message::Text(text) = msg {
                        let _ = seen_tx.send(text.to_string());
                        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                            if let Some(id) = v.get("id") {
                                let reply = serde_json::json!({
                                    "jsonrpc": "2.0", "id": id, "result": {}
                                });
                                let _ = write
                                    .send(tokio_tungstenite::tungstenite::Message::Text(
                                        reply.to_string(),
                                    ))
                                    .await;
                            }
                        }
                    }
                }
            });
        }
    });
    (url, seen_rx)
}

type ClientWs =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn connect_client(proxy_ws_url: &str) -> ClientWs {
    let (ws, _) = tokio_tungstenite::connect_async(proxy_ws_url)
        .await
        .unwrap();
    ws
}

fn text(v: serde_json::Value) -> tokio_tungstenite::tungstenite::Message {
    tokio_tungstenite::tungstenite::Message::Text(v.to_string())
}

async fn recv_text_with_timeout<S>(read: &mut S, ms: u64) -> Option<String>
where
    S: StreamExt<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    tokio::time::timeout(std::time::Duration::from_millis(ms), read.next())
        .await
        .ok()
        .flatten()
        .and_then(|m| m.ok())
        .and_then(|m| match m {
            tokio_tungstenite::tungstenite::Message::Text(t) => Some(t.to_string()),
            _ => None,
        })
}

fn gate_options(upstream: &str, require: bool) -> CodexRemoteProxyOptions {
    let mut options = CodexRemoteProxyOptions::new(upstream, require);
    options.candidate_capture_timeout_ms = 60_000; // never fires in the happy tests
    options.identity_gate_hold_timeout_ms = 60_000;
    options
}

#[tokio::test(flavor = "multi_thread")]
async fn turn_start_is_held_until_mark_candidate_persisted() {
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(gate_options(&upstream, true))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;

    // Non-gated method flows through immediately.
    ws.send(text(
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"thread/start","params":{}}),
    ))
    .await
    .ok();
    let first = tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
        .await
        .expect("thread/start must reach upstream")
        .unwrap();
    assert!(first.contains("thread/start"));

    // Gated method is HELD: it must NOT reach upstream…
    ws.send(text(
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"turn/start","params":{}}),
    ))
    .await
    .ok();
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(500), seen.recv())
            .await
            .is_err(),
        "turn/start must be held by the identity gate"
    );

    // …until the candidate is persisted.
    proxy.mark_candidate_persisted();
    let released = tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
        .await
        .expect("held turn/start must be released to upstream")
        .unwrap();
    assert!(released.contains("turn/start"));
    // And the upstream's response comes back to the client.
    let mut got_response = false;
    for _ in 0..5 {
        if let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
            if frame.contains("\"id\":2") {
                got_response = true;
                break;
            }
        }
    }
    assert!(
        got_response,
        "client must receive the response to the released turn/start"
    );
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn resume_proxy_does_not_gate() {
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let (proxy, _events) = CodexRemoteProxy::start(gate_options(&upstream, false))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    ws.send(text(
        serde_json::json!({"jsonrpc":"2.0","id":1,"method":"turn/start","params":{}}),
    ))
    .await
    .ok();
    let frame = tokio::time::timeout(std::time::Duration::from_secs(5), seen.recv())
        .await
        .expect("require_candidate_persistence=false must not hold turn/start")
        .unwrap();
    assert!(frame.contains("turn/start"));
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn capture_timeout_rejects_held_frames_and_emits_repair_trigger() {
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let mut options = CodexRemoteProxyOptions::new(&upstream, true);
    options.candidate_capture_timeout_ms = 200; // fire fast
    options.identity_gate_hold_timeout_ms = 60_000;
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;

    ws.send(text(
        serde_json::json!({"jsonrpc":"2.0","id":7,"method":"turn/start","params":{}}),
    ))
    .await
    .ok();

    // Held frame is answered with a JSON-RPC error (-32000), never forwarded.
    let mut got_error = false;
    for _ in 0..5 {
        if let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
            if frame.contains("-32000") && frame.contains("\"id\":7") {
                got_error = true;
                break;
            }
        }
    }
    assert!(
        got_error,
        "held turn/start must be answered with a -32000 error on capture timeout"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), seen.recv())
            .await
            .is_err(),
        "held frame must never be forwarded upstream after a capture timeout"
    );

    // The repair trigger surfaces on the event stream.
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(
        saw_trigger,
        "capture timeout must emit RepairTrigger::CandidateCaptureTimeout"
    );
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn fail_candidate_capture_rejects_held_frames() {
    let (upstream, _seen) = spawn_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(gate_options(&upstream, true))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    ws.send(text(
        serde_json::json!({"jsonrpc":"2.0","id":9,"method":"thread/fork","params":{}}),
    ))
    .await
    .ok();
    // Settle: let the in-flight fork frame reach the hub and be HELD before the capture
    // failure lands — the gate's held-frame rejection path is what this test exercises.
    // (Without this the direct hub message reliably outraces the socket read; a failure
    // landing on an EMPTY gate closes the sockets before the frame can be answered —
    // that ordering is racy in legacy too, so it is not the behavior under test.)
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    proxy.fail_candidate_capture("identity guards refused the candidate");
    let mut got_error = false;
    for _ in 0..5 {
        if let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
            if frame.contains("-32000") && frame.contains("\"id\":9") {
                got_error = true;
                break;
            }
        }
    }
    assert!(
        got_error,
        "fail_candidate_capture must answer held frames with -32000"
    );
    // Ledger A28: ANY initial-capture failure (identity-guard refusal included)
    // fires repair_trigger{kind:'candidate_capture_timeout'}, not proxy_error.
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(
        saw_trigger,
        "fail_candidate_capture must emit CandidateCaptureTimeout"
    );
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn hold_queue_overflow_fails_the_capture() {
    // Legacy parity (ledger A28): the 33rd gated frame is PUSHED and then the
    // gate FAILS (overflow = capture failure) — every held frame gets -32000,
    // nothing reaches upstream, and candidate_capture_timeout fires.
    let (upstream, mut seen) = spawn_fake_upstream().await;
    let (proxy, mut events) = CodexRemoteProxy::start(gate_options(&upstream, true))
        .await
        .unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    for i in 0..33 {
        ws.send(text(
            serde_json::json!({"jsonrpc":"2.0","id":i,"method":"turn/start","params":{}}),
        ))
        .await
        .ok();
    }
    let mut errors = 0;
    while let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
        if frame.contains("-32000") {
            errors += 1;
            if errors == 33 {
                break;
            }
        }
    }
    assert_eq!(
        errors, 33,
        "all 33 held frames (incl. the overflowing one) get -32000"
    );
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(300), seen.recv())
            .await
            .is_err(),
        "no gated frame may reach upstream after an overflow failure"
    );
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(
        saw_trigger,
        "overflow is a capture failure: it must emit CandidateCaptureTimeout"
    );
    proxy.close().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn held_bytes_cap_fails_the_capture() {
    // Legacy parity (ledger A28): the CUMULATIVE held bytes are capped by
    // max_raw_forward_bytes — two frames each under the per-frame raw-forward
    // check but together over the cap fail the gate as a capture failure.
    let (upstream, _seen) = spawn_fake_upstream().await;
    let mut options = gate_options(&upstream, true);
    options.max_raw_forward_bytes = 2_048;
    let (proxy, mut events) = CodexRemoteProxy::start(options).await.unwrap();
    let mut ws = connect_client(proxy.ws_url()).await;
    let blob = "x".repeat(1_200); // each frame ~1.3 KB < 2 KB; two frames > 2 KB
    for i in 0..2 {
        ws
            .send(text(serde_json::json!({"jsonrpc":"2.0","id":i,"method":"turn/start","params":{"blob":&blob}})))
            .await
            .ok();
    }
    let mut errors = 0;
    while let Some(frame) = recv_text_with_timeout(&mut ws, 2_000).await {
        if frame.contains("-32000") {
            errors += 1;
            if errors == 2 {
                break;
            }
        }
    }
    assert_eq!(
        errors, 2,
        "both held frames get -32000 when the byte cap trips"
    );
    let mut saw_trigger = false;
    while let Ok(Some(event)) =
        tokio::time::timeout(std::time::Duration::from_secs(3), events.recv()).await
    {
        if matches!(
            event,
            RemoteProxyEvent::RepairTrigger(RemoteProxyRepairTrigger::CandidateCaptureTimeout)
        ) {
            saw_trigger = true;
            break;
        }
    }
    assert!(
        saw_trigger,
        "the held-bytes cap must emit CandidateCaptureTimeout"
    );
    proxy.close().await;
}
