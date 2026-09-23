//! Unified agent names (plan Task 3) — Codex native-name contract tests:
//! direct metadata management over a `ChannelTransport`, the root-match
//! policy for management connections, the rollout walk under BOTH supported
//! layouts, automatic-provenance observation of forwarded name requests, and
//! the T2-M6 remote-proxy initialize/candidate-path correlation (a proxied
//! initialize's captured `codexHome` verified against a real rollout walk).
//!
//! Real sockets only where inherently IO (the proxy relay): loopback,
//! ephemeral ports — never 3001/3002. No real codex binary is spawned (the
//! real-provider proof belongs to Task 8's sandbox smoke).
#![cfg(feature = "real-transport")]

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::time::timeout;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::{accept_async, connect_async};

use freshell_codex::app_server::CodexAppServerClient;
use freshell_codex::durability::locate_thread_rollout_in_home;
use freshell_codex::protocol::{classify_notification, thread_name_from_result, CodexNotification};
use freshell_codex::remote_proxy::{CodexRemoteProxy, CodexRemoteProxyOptions, RemoteProxyEvent};
use freshell_codex::remote_proxy_side_effects::{
    extract_initialize_codex_home, extract_thread_name_set_request,
    extract_upstream_thread_name_updated,
};

const RECV_TIMEOUT: Duration = Duration::from_secs(5);

// ── shared fake-upstream harness (mirrors remote_proxy_relay.rs) ─────────────────────

struct FakeUpstream {
    ws_url: String,
    conn_rx: mpsc::UnboundedReceiver<FakeUpstreamConn>,
}

struct FakeUpstreamConn {
    incoming: mpsc::UnboundedReceiver<Message>,
    outgoing: mpsc::UnboundedSender<Message>,
}

async fn start_fake_upstream() -> FakeUpstream {
    let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let ws_url = format!("ws://{}:{}", addr.ip(), addr.port());
    let (conn_tx, conn_rx) = mpsc::unbounded_channel();

    tokio::spawn(async move {
        loop {
            let Ok((stream, _)) = listener.accept().await else {
                break;
            };
            let Ok(ws) = accept_async(stream).await else {
                continue;
            };
            let (mut sink, mut stream) = ws.split();
            let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Message>();
            let (in_tx, in_rx) = mpsc::unbounded_channel::<Message>();
            tokio::spawn(async move {
                while let Some(msg) = out_rx.recv().await {
                    if sink.send(msg).await.is_err() {
                        break;
                    }
                }
                let _ = sink.close().await;
            });
            tokio::spawn(async move {
                while let Some(Ok(msg)) = stream.next().await {
                    if in_tx.send(msg).is_err() {
                        break;
                    }
                }
            });
            if conn_tx
                .send(FakeUpstreamConn {
                    incoming: in_rx,
                    outgoing: out_tx,
                })
                .is_err()
            {
                break;
            }
        }
    });

    FakeUpstream { ws_url, conn_rx }
}

impl FakeUpstream {
    async fn accept(&mut self) -> FakeUpstreamConn {
        timeout(RECV_TIMEOUT, self.conn_rx.recv())
            .await
            .expect("fake upstream: timed out waiting for the proxy to dial in")
            .expect("fake upstream: connection channel closed")
    }
}

impl FakeUpstreamConn {
    async fn recv_text(&mut self) -> String {
        match timeout(RECV_TIMEOUT, self.incoming.recv())
            .await
            .expect("fake upstream: timed out waiting for a frame")
            .expect("fake upstream: incoming channel closed")
        {
            Message::Text(text) => text,
            other => panic!("fake upstream: expected a text frame, got {other:?}"),
        }
    }

    fn send_text(&self, text: impl Into<String>) {
        self.outgoing.send(Message::Text(text.into())).unwrap();
    }
}

// ── direct metadata management over the channel transport ────────────────────────────

/// Complete an initialize handshake on the scripted peer, recording every
/// client→server frame so the test can assert ZERO management
/// resume/unarchive/lease traffic.
async fn handshake(peer: &freshell_codex::app_server::ChannelPeer, seen: &mut Vec<String>) {
    let (id, method, _) = peer.expect_request().await;
    assert_eq!(method, "initialize");
    seen.push(method);
    peer.respond(
        &id,
        json!({ "userAgent": "codex", "codexHome": "/h/.codex" }),
    );
    let (note, _) = peer.expect_notification().await;
    assert_eq!(note, "initialized");
}

#[tokio::test]
async fn set_thread_name_dispatches_the_public_request_without_management_traffic() {
    let (transport, peer) = freshell_codex::app_server::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let client = std::sync::Arc::new(client);

    let c = client.clone();
    let task = tokio::spawn(async move { c.set_thread_name("thread-1", "Managed Name").await });

    let mut seen = Vec::new();
    handshake(&peer, &mut seen).await;

    let (id, method, params) = peer.expect_request().await;
    seen.push(method.clone());
    assert_eq!(method, "thread/name/set", "the public name/set request");
    assert_eq!(params["threadId"], json!("thread-1"));
    assert_eq!(params["name"], json!("Managed Name"));
    peer.respond(&id, json!({}));

    task.await.unwrap().expect("set_thread_name succeeds");

    // ZERO management resume/unarchive/lease/start traffic: the name write is
    // a direct metadata call on the live connection, nothing else.
    for forbidden in [
        "thread/resume",
        "thread/unarchive",
        "thread/archive",
        "thread/start",
        "lease/acquire",
    ] {
        assert!(
            !seen.iter().any(|m| m == forbidden),
            "management name-set must never dispatch {forbidden}; saw {seen:?}"
        );
    }
    assert_eq!(seen, vec!["initialize", "thread/name/set"]);
}

#[tokio::test]
async fn read_thread_reads_metadata_directly_without_turns() {
    let (transport, peer) = freshell_codex::app_server::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let client = std::sync::Arc::new(client);

    let c = client.clone();
    let task = tokio::spawn(async move { c.read_thread("thread-1", false).await });

    let mut seen = Vec::new();
    handshake(&peer, &mut seen).await;

    let (id, method, params) = peer.expect_request().await;
    seen.push(method.clone());
    assert_eq!(method, "thread/read");
    assert_eq!(
        params["includeTurns"],
        json!(false),
        "metadata reads never pull turns"
    );
    peer.respond(
        &id,
        json!({ "thread": { "id": "thread-1", "name": "Current Name" } }),
    );

    let result = task.await.unwrap().expect("read_thread succeeds");
    // The native name is observed from the read response's own thread.name.
    assert_eq!(
        thread_name_from_result(&result).as_deref(),
        Some("Current Name")
    );
    for forbidden in ["thread/resume", "thread/unarchive", "thread/start"] {
        assert!(
            !seen.iter().any(|m| m == forbidden),
            "saw {forbidden}: {seen:?}"
        );
    }
}

#[test]
fn thread_name_is_parsed_from_read_and_resume_result_threads() {
    // read/resume/fork responses all carry the thread at result.thread.
    assert_eq!(
        thread_name_from_result(&json!({ "thread": { "id": "t", "name": "Named" } })).as_deref(),
        Some("Named")
    );
    assert_eq!(
        thread_name_from_result(&json!({ "thread": { "id": "t", "name": "" } })),
        None,
        "an empty name is not an observation"
    );
    assert_eq!(
        thread_name_from_result(&json!({ "thread": { "id": "t" } })),
        None
    );
    assert_eq!(thread_name_from_result(&json!({})), None);
}

#[test]
fn thread_name_updated_notifications_classify_typed() {
    let notification = classify_notification(
        "thread/name/updated",
        Some(&json!({ "threadId": "thread-9", "name": "Externally Renamed" })),
    );
    assert_eq!(
        notification,
        CodexNotification::ThreadNameUpdated {
            thread_id: "thread-9".into(),
            name: "Externally Renamed".into(),
        }
    );
    // Malformed shapes fall through to Other, never abort.
    assert!(matches!(
        classify_notification("thread/name/updated", Some(&json!({ "threadId": "t" }))),
        CodexNotification::Other { .. }
    ));
}

// ── forwarded request observation: always automatic ───────────────────────────────────

#[test]
fn forwarded_name_set_requests_are_observed_without_intent() {
    // Identical automatic- and human-shaped forwarded requests observe the
    // SAME automatic fact: the extractor carries only threadId+name, never
    // an intent, so both remain automatic observations downstream.
    let human_shaped = br#"{"id":7,"method":"thread/name/set","params":{"threadId":"thread-1","name":"Human Renamed"}}"#;
    let automatic_shaped = br#"{"id":9001,"method":"thread/name/set","params":{"threadId":"thread-2","name":"tool title"}}"#;

    for (raw, thread, name) in [
        (human_shaped, "thread-1", "Human Renamed"),
        (automatic_shaped, "thread-2", "tool title"),
    ] {
        let observed = extract_thread_name_set_request(raw)
            .expect("well-formed name/set extracts")
            .expect("a name/set frame");
        assert_eq!(observed.thread_id, thread);
        assert_eq!(observed.name, name);
        // No intent field exists on the observation: the caller cannot
        // distinguish, so the fold treats both as automatic.
    }

    // Other frames observe nothing.
    assert!(
        extract_thread_name_set_request(br#"{"id":1,"method":"turn/start","params":{}}"#)
            .expect("scan ok")
            .is_none()
    );
    assert!(extract_thread_name_set_request(b"{bad json")
        .expect("scan tolerated")
        .is_none());
}

#[test]
fn upstream_name_updated_notifications_extract_thread_and_name() {
    let observed = extract_upstream_thread_name_updated(
        br#"{"method":"thread/name/updated","params":{"threadId":"t-1","name":"Renamed"}}"#,
    )
    .expect("scan ok")
    .expect("the notification extracts");
    assert_eq!(observed, ("t-1".to_string(), "Renamed".to_string()));
    assert!(extract_upstream_thread_name_updated(
        br#"{"method":"turn/started","params":{"threadId":"t-1"}}"#
    )
    .expect("scan ok")
    .is_none());
}

// ── the rollout walk under both supported layouts ────────────────────────────────────

fn plant_rollout(path: &std::path::Path, thread_id: &str, history_mode: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
    }
    let meta = json!({
        "type": "session_meta",
        "payload": { "id": thread_id, "cwd": "/repo", "history_mode": history_mode }
    });
    std::fs::write(path, format!("{meta}\n")).unwrap();
}

#[test]
fn the_rollout_walk_finds_threads_in_both_supported_layouts() {
    let home = tempfile::tempdir().expect("tempdir");
    // The production layout: sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl.
    plant_rollout(
        &home
            .path()
            .join("sessions/2026/09/17/rollout-2026-09-17T10-00-00-a1b2c3d4-e5f6-7890-abcd-ef0123456789.jsonl"),
        "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        "paginated",
    );
    // The flat test layout: <id>.jsonl directly under sessions/.
    plant_rollout(
        &home.path().join("sessions/0198-flat-layout-000000.jsonl"),
        "0198-flat-layout-000000",
        "legacy",
    );
    // A decoy whose FILENAME contains a foreign thread id (fork lineage) but
    // whose session_meta owns a different id — the ownership proof must
    // reject it.
    plant_rollout(
        &home
            .path()
            .join("sessions/2026/09/17/rollout-2026-09-17T11-00-00-a1b2c3d4-e5f6-7890-abcd-ef0123456789-child.jsonl"),
        "aaaa-different-owner-0000",
        "legacy",
    );

    for thread in [
        "a1b2c3d4-e5f6-7890-abcd-ef0123456789",
        "0198-flat-layout-000000",
    ] {
        let found = locate_thread_rollout_in_home(home.path(), thread)
            .unwrap_or_else(|| panic!("the walk must find {thread}"));
        assert!(found.is_file());
    }
    // A substring-matching foreign id is NOT found through the decoy.
    assert!(
        locate_thread_rollout_in_home(home.path(), "a1b2c3d4-e5f6-7890-abcd-ef0123456789c")
            .is_none()
    );
    assert!(locate_thread_rollout_in_home(home.path(), "never-planted").is_none());
}

// ── T2-M6: the proxied initialize correlation ────────────────────────────────────────

/// A proxied initialize's captured `codexHome` is the root the rollout walk
/// finds the thread's rollout under — the exact correlation the native lanes
/// rely on (never ambient env).
#[tokio::test]
async fn a_proxied_initialize_captures_the_home_the_rollout_walk_verifies() {
    // Plant a rollout under the home the fake upstream will report.
    let home = tempfile::tempdir().expect("tempdir");
    let thread = "019810de-1e5f-7db3-9c47-1c2a3b4c5d6e";
    plant_rollout(
        &home
            .path()
            .join("sessions/2026/09/17/rollout-2026-09-17T10-00-00-019810de-1e5f-7db3-9c47-1c2a3b4c5d6e.jsonl"),
        thread,
        "paginated",
    );

    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(upstream.ws_url.clone(), false))
            .await
            .expect("proxy starts");

    // A client (the TUI role) dials the proxy and sends initialize.
    let (mut client_ws, _) = connect_async(proxy.ws_url())
        .await
        .expect("client dials the proxy");
    let mut upstream_conn = upstream.accept().await;
    client_ws
        .send(Message::Text(
            json!({ "id": 1, "method": "initialize", "params": {} }).to_string(),
        ))
        .await
        .unwrap();
    let initialize = upstream_conn.recv_text().await;
    let initialize_id = serde_json::from_str::<Value>(&initialize).unwrap()["id"].clone();
    upstream_conn.send_text(
        json!({ "id": initialize_id, "result": { "userAgent": "codex", "codexHome": home.path().display().to_string() } })
            .to_string(),
    );

    // The proxy captures the initialized home per proxied connection.
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    let captured = loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no UpstreamInitialized event"
        );
        match timeout(Duration::from_millis(200), events.recv()).await {
            Ok(Some(RemoteProxyEvent::UpstreamInitialized {
                conn_id,
                codex_home,
            })) => {
                assert_eq!(conn_id, 0);
                break codex_home;
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => continue,
        }
    };
    assert_eq!(captured, home.path().display().to_string());

    // The captured home feeds the rollout walk: the thread's rollout IS
    // under the initialized root (the candidate-path correlation).
    let found = locate_thread_rollout_in_home(std::path::Path::new(&captured), thread)
        .expect("the captured home's rollout walk finds the thread");
    assert!(found.to_string_lossy().contains(thread));

    // The initialize response also extracts standalone (the side-effect
    // probe the hub path shares).
    assert_eq!(
        extract_initialize_codex_home(
            json!({ "id": 1, "result": { "codexHome": captured } })
                .to_string()
                .as_bytes()
        )
        .expect("scan ok")
        .as_deref(),
        Some(captured.as_str())
    );
    assert!(
        extract_initialize_codex_home(br#"{"id":2,"result":{"thread":{"id":"t"}}}"#)
            .expect("scan ok")
            .is_none(),
        "ordinary responses carry no codexHome"
    );

    // A forwarded thread/name/set observes automatically through the relay.
    client_ws
        .send(Message::Text(
            json!({ "id": 2, "method": "thread/name/set", "params": { "threadId": thread, "name": "Proxied Rename" } })
                .to_string(),
        ))
        .await
        .unwrap();
    let forwarded = upstream_conn.recv_text().await;
    assert!(forwarded.contains("thread/name/set"), "relayed verbatim");
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    let observed = loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no NativeNameObserved event"
        );
        match timeout(Duration::from_millis(200), events.recv()).await {
            Ok(Some(RemoteProxyEvent::NativeNameObserved { thread_id, name })) => {
                break (thread_id, name);
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => continue,
        }
    };
    assert_eq!(observed, (thread.to_string(), "Proxied Rename".to_string()));

    proxy.close().await;
}

/// An upstream `thread/name/updated` notification relays verbatim AND is
/// observed as a native name event.
#[tokio::test]
async fn an_upstream_name_updated_notification_relays_and_observes() {
    let mut upstream = start_fake_upstream().await;
    let (proxy, mut events) =
        CodexRemoteProxy::start(CodexRemoteProxyOptions::new(upstream.ws_url.clone(), false))
            .await
            .expect("proxy starts");

    let (mut client_ws, _) = connect_async(proxy.ws_url()).await.expect("client dials");
    let mut upstream_conn = upstream.accept().await;

    // initialize so the connection is fully relaying (not required for
    // notifications, but mirrors production).
    client_ws
        .send(Message::Text(
            json!({ "id": 1, "method": "initialize", "params": {} }).to_string(),
        ))
        .await
        .unwrap();
    let initialize = upstream_conn.recv_text().await;
    let initialize_id = serde_json::from_str::<Value>(&initialize).unwrap()["id"].clone();
    upstream_conn.send_text(
        json!({ "id": initialize_id, "result": { "codexHome": "/h/.codex" } }).to_string(),
    );

    upstream_conn.send_text(
        json!({ "method": "thread/name/updated", "params": { "threadId": "thread-7", "name": "Provider Renamed" } })
            .to_string(),
    );

    // The TUI receives the relayed frame verbatim (after the initialize
    // response relay).
    let relayed = timeout(RECV_TIMEOUT, async {
        loop {
            let Some(Ok(Message::Text(text))) = client_ws.next().await else {
                continue;
            };
            if text.contains("thread/name/updated") {
                return text;
            }
        }
    })
    .await
    .expect("relayed");
    assert!(relayed.contains("Provider Renamed"));

    // And the proxy observed it.
    let deadline = tokio::time::Instant::now() + RECV_TIMEOUT;
    let observed = loop {
        assert!(
            tokio::time::Instant::now() < deadline,
            "no observation event"
        );
        match timeout(Duration::from_millis(200), events.recv()).await {
            Ok(Some(RemoteProxyEvent::NativeNameObserved { thread_id, name })) => {
                break (thread_id, name);
            }
            Ok(Some(_)) => continue,
            Ok(None) | Err(_) => continue,
        }
    };
    assert_eq!(
        observed,
        ("thread-7".to_string(), "Provider Renamed".to_string())
    );

    proxy.close().await;
}

/// The started client's own initialize capture is ALSO available for the
/// adapter's root-match policy (the app-server client mirrors the proxy):
/// `codex_home` answers the initialized root the connection reported.
#[tokio::test]
async fn the_app_server_client_exposes_its_initialized_root_for_root_matching() {
    let (transport, peer) = freshell_codex::app_server::new_channel_transport();
    let (client, _notifs) = CodexAppServerClient::connect(transport);
    let client = std::sync::Arc::new(client);
    assert!(
        client.codex_home().await.is_none(),
        "no root before the first initialize"
    );

    let c = client.clone();
    let task = tokio::spawn(async move { c.initialize().await });
    let (id, _, _) = peer.expect_request().await;
    peer.respond(
        &id,
        json!({ "codexHome": "/h/.codex", "userAgent": "codex" }),
    );
    let _ = peer.expect_notification().await;
    task.await.unwrap().expect("initialize ok");

    assert_eq!(client.codex_home().await.as_deref(), Some("/h/.codex"));
}
