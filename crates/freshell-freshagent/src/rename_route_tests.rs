//! Task 16 (`PATCH /api/panes/:id`, kills D10): store-backed rename ROUTE
//! tests. Split out of `lib.rs` per this branch's
//! `pane_ops_tests.rs`/`layout_store_tests.rs` precedent (`lib.rs` is already
//! over the 1,000-line ceiling). Formerly `rename_cascade_tests.rs`: the
//! syncable-terminal persistence cascade (`persistSyncableTerminalRename`,
//! `router.ts:649-693`) was removed in b5fb — the route is layout-only, and
//! the b5fb pins at the bottom hold GREEN by structural absence: no
//! persistence seam exists for the route to call, so each rename emits
//! exactly one `ui.command{pane.rename}` frame and zero `terminals.changed`
//! frames.

use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::response::Response;
use axum::Router;
use serde_json::{json, Value};
use tower::util::ServiceExt;

use freshell_protocol::session_names::{NameIntent, NamedProvider, SessionNameRef};

use super::FreshAgentState;
use crate::naming::test_support::{verified_claude_acquisition, RecordingSink};
use crate::naming::{BindNameInput, PendingNameInput, SessionNaming};

// ── helpers (oneshot pattern from `lib.rs`'s `rename_pane_tests`) ───────────

fn state_with(tx: tokio::sync::broadcast::Sender<String>) -> FreshAgentState {
    FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx))
}

async fn body_json(resp: Response) -> Value {
    let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
        .await
        .unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn patch_pane(router: Router, pane_id: &str, name: &str) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("PATCH")
        .uri(format!("/api/panes/{pane_id}"))
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(json!({ "name": name }).to_string()))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

/// `PATCH /api/tabs/:id` with the given body (the tab rename route).
async fn patch_tab(router: Router, tab_id: &str, body: Value) -> (StatusCode, Value) {
    let req = Request::builder()
        .method("PATCH")
        .uri(format!("/api/tabs/{tab_id}"))
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    (status, body_json(resp).await)
}

/// Create a REAL registry terminal via the Slice-1 shell-tab route, returning
/// its `terminalId` (`pane_ops_tests::create_shell_tab` pattern).
async fn create_registry_terminal(router: Router) -> String {
    let tmp = std::env::temp_dir();
    let req = Request::builder()
        .method("POST")
        .uri("/api/tabs")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({ "mode": "shell", "cwd": tmp.to_string_lossy() }).to_string(),
        ))
        .unwrap();
    let resp = router.oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    body["data"]["terminalId"].as_str().unwrap().to_string()
}

/// Seed the shared layout store the way Task 13's WS ingestion does
/// (`pane_ops_store_tests::seed_layout` pattern).
fn seed_layout(state: &FreshAgentState, payload: Value) {
    seed_layout_as(state, payload, "test-conn");
}

/// Same, but as a SPECIFIC client connection (multi-client layout store).
fn seed_layout_as(state: &FreshAgentState, payload: Value, conn_id: &str) {
    let sync: freshell_protocol::UiLayoutSync =
        serde_json::from_value(payload).expect("UiLayoutSync parses");
    state.layout.update_from_ui(&sync, conn_id);
}

/// One tab `t1` holding the lone leaf `p1` with the given content — the
/// single-pane-tab shape (`tabRenamed === true` per `router.ts:1414-1415`).
fn lone_pane_layout(content: Value) -> Value {
    json!({
        "tabs": [{ "id": "t1", "title": "First" }],
        "activeTabId": "t1",
        "layouts": { "t1": { "type": "leaf", "id": "p1", "content": content } },
        "activePane": { "t1": "p1" },
        "paneTitles": {},
        "paneTitleSetByUser": {},
        "timestamp": 1,
    })
}

fn drain_frames(rx: &mut tokio::sync::broadcast::Receiver<String>) -> Vec<Value> {
    let mut frames = Vec::new();
    while let Ok(frame) = rx.try_recv() {
        frames.push(serde_json::from_str(&frame).unwrap());
    }
    frames
}

// ── the route tests ──────────────────────────────────────────────────────────

/// Store rename + `ui.command{pane.rename}` broadcast + `tabRenamed:true` for
/// a single-pane tab (`router.ts:1408-1420`).
#[tokio::test]
async fn rename_pane_renames_store_and_broadcasts_ui_command() {
    let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx);
    seed_layout(&state, lone_pane_layout(json!({ "kind": "terminal" })));

    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "New Name").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["data"]["paneId"], json!("p1"));
    assert_eq!(body["data"]["tabRenamed"], json!(true), "{body}");
    assert_eq!(body["message"], json!("pane renamed"));

    // The STORE title changed (sticky pane title, `renamePane` layout-store.ts:558-575).
    let rows = state.layout.list_panes(Some("t1")).expect("panes list");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "p1");
    assert_eq!(rows[0].title.as_deref(), Some("New Name"));

    // Exactly one broadcast: `ui.command{pane.rename,{tabId,paneId,title}}`.
    let frames = drain_frames(&mut rx);
    assert_eq!(frames.len(), 1, "{frames:?}");
    assert_eq!(frames[0]["type"], json!("ui.command"));
    assert_eq!(frames[0]["command"], json!("pane.rename"));
    assert_eq!(
        frames[0]["payload"],
        json!({ "tabId": "t1", "paneId": "p1", "title": "New Name" })
    );
}

/// Unknown pane → Node's 200 `ok({message:'pane not found'})`
/// (`router.ts:1411`+`:1423` — result carries only `message`, no broadcast).
#[tokio::test]
async fn rename_pane_unknown_pane_is_200_with_message() {
    let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx);
    seed_layout(&state, lone_pane_layout(json!({ "kind": "terminal" })));

    let (status, body) = patch_pane(crate::router(state), "nope", "New Name").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["data"], json!({ "message": "pane not found" }));
    assert_eq!(body["message"], json!("pane not found"));
    assert!(drain_frames(&mut rx).is_empty(), "no broadcast on a miss");
}

// ── multi-client layout store (cross-client pane-id resolution fix) ─────────

/// A pane id known only to a NON-primary client connection must still rename,
/// and `tabRenamed` must be computed from the snapshot where the pane
/// resolved — NOT the primary's same-id tab. (Multi-client divergence from
/// Node's single shared snapshot; Node keeps last-writer-wins.)
#[tokio::test]
async fn rename_from_non_primary_client_succeeds_and_tab_renamed_uses_that_snapshot() {
    let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx);

    // conn-a: tab t1 is a SINGLE-pane tab holding p1.
    seed_layout_as(
        &state,
        lone_pane_layout(json!({ "kind": "terminal" })),
        "conn-a",
    );
    // conn-b (last writer / primary): the SAME tab id t1, but with TWO panes
    // b1/b2 — a different window's view of the workspace.
    seed_layout_as(
        &state,
        json!({
            "tabs": [{ "id": "t1", "title": "First" }],
            "activeTabId": "t1",
            "layouts": { "t1": {
                "type": "split", "id": "s1", "direction": "horizontal", "sizes": [50, 50],
                "children": [
                    { "type": "leaf", "id": "b1", "content": { "kind": "terminal" } },
                    { "type": "leaf", "id": "b2", "content": { "kind": "terminal" } },
                ],
            } },
            "activePane": { "t1": "b1" },
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 2,
        }),
        "conn-b",
    );

    // p1 exists ONLY in conn-a's snapshot (conn-a is not the last writer).
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Cross Client").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["status"], json!("ok"));
    assert_eq!(body["data"]["tabId"], json!("t1"), "{body}");
    assert_eq!(body["data"]["paneId"], json!("p1"), "{body}");
    assert_eq!(
        body["data"]["tabRenamed"],
        json!(true),
        "tabRenamed must come from conn-a's snapshot (single-pane t1), not \
         the primary's two-pane t1: {body}"
    );

    // The primary's b1 keeps renaming too, and ITS tab is NOT single-pane.
    let (status, body) = patch_pane(crate::router(state), "b1", "Primary Pane").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["data"]["tabId"], json!("t1"));
    assert_eq!(body["data"]["tabRenamed"], json!(false), "{body}");

    // Both renames broadcast `ui.command{pane.rename}`.
    let frames = drain_frames(&mut rx);
    assert_eq!(frames.len(), 2, "{frames:?}");
    assert_eq!(
        frames[0]["payload"],
        json!({ "tabId": "t1", "paneId": "p1", "title": "Cross Client" })
    );
}

// ── unified agent names (Task 2): scoped pane renames route to the authority ──

/// Wire the recording sink into a state the way `main.rs` wires the real
/// store (the sink is the ONE naming authority for the route).
fn wire_recording_sink(state: &FreshAgentState) -> Arc<RecordingSink> {
    let sink = RecordingSink::new();
    state.set_session_naming(sink.clone());
    sink
}

/// Seed a durable record the way the create lane does (pending admission +
/// verified bind) so the route's rename resolves an existing record.
async fn seed_durable_record(sink: &Arc<RecordingSink>, handle: &str, session_id: &str) {
    sink.ensure_pending(PendingNameInput {
        handle: handle.to_string(),
        provider: NamedProvider::Claude,
        cwd: None,
    })
    .await
    .unwrap();
    sink.bind_pending(BindNameInput {
        pending: SessionNameRef::Pending {
            id: handle.to_string(),
        },
        target: SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: session_id.to_string(),
        },
        acquisition: verified_claude_acquisition(session_id),
    })
    .await
    .unwrap();
}

/// Unified agent names (Task 8 acceptance): a pre-bind rename on a fresh
/// claude pane whose content carries the PROSPECTIVE preallocated
/// `sessionRef` (the WS/REST fresh-claude create contract) resolves
/// through the pane's own pre-durable binding when the store has no
/// session record yet — the claude CLI journey's pane-header rename before
/// the first message materializes the transcript. The pending binding is
/// read from the terminal registry row (both create doors stamp it via
/// `set_naming`), and the client's captured `expectedNameRef` (the session
/// ref — its only visible form pre-bind) is accepted: a 404-on-session
/// proves no established conversation exists to have switched from.
#[tokio::test]
async fn pre_bind_claude_pane_rename_falls_back_to_the_pending_binding() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    // ONLY the create-time pending admission exists — no durable record for
    // the preallocated session id yet.
    sink.ensure_pending(PendingNameInput {
        handle: "nh-prebind".into(),
        provider: NamedProvider::Claude,
        cwd: Some("/work/prebind".into()),
    })
    .await
    .unwrap();

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    // The pre-bind binding BOTH create doors stamp on the terminal row.
    registry.set_naming(
        &terminal_id,
        Some(SessionNameRef::Pending {
            id: "nh-prebind".into(),
        }),
        Some("nh-prebind".into()),
    );
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "prealloc-prospective" },
        })),
    );

    // The client's editor captured the session ref (its only visible form).
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/panes/p1")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({
                "name": "Pre-durable keep me",
                "nameIntent": "user",
                "expectedNameRef": { "kind": "session", "provider": "claude", "sessionId": "prealloc-prospective" },
            })
            .to_string(),
        ))
        .unwrap();
    let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The accepted record is the pending one, under the user intent.
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "pending", "id": "nh-prebind" }),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionName"]["record"]["name"],
        json!("Pre-durable keep me"),
        "{body}"
    );
    // The primary session attempt missed (no record yet); the pending
    // fallback accepted the rename.
    let recorded_renames = sink.renames.lock().unwrap().clone();
    assert_eq!(recorded_renames.len(), 2, "{recorded_renames:?}");
    assert_eq!(
        recorded_renames[0].target,
        SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "prealloc-prospective".into(),
        }
    );
    assert_eq!(
        recorded_renames[1].target,
        SessionNameRef::Pending {
            id: "nh-prebind".into()
        }
    );
    assert_eq!(recorded_renames[1].name, "Pre-durable keep me");
    assert_eq!(recorded_renames[1].intent, NameIntent::User);
}

/// Unified agent names (Task 8, the T6-R3 sender-repair consequence): a
/// pane whose CONTENT carries the pre-durable `namingHandle` (what the
/// view-layer create senders stamp — the client's own rungs) resolves its
/// rename target as the PENDING record DIRECTLY, even while the content
/// also carries the PROSPECTIVE preallocated sessionRef. The client's
/// captured `expectedNameRef` follows the same rungs, so the capture
/// matches the server-resolved target — pre-flip this shape refused with
/// a spurious NAME_TARGET_MOVED (session-first resolution vs the
/// pending-first capture), which is exactly what the pre-durable
/// pane-header journey demonstrated.
#[tokio::test]
async fn pane_rename_prefers_the_content_handle_over_a_prospective_session_ref() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    sink.ensure_pending(PendingNameInput {
        handle: "nh-sender-stamped".into(),
        provider: NamedProvider::Claude,
        cwd: Some("/work/sender-stamped".into()),
    })
    .await
    .unwrap();

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
            "namingHandle": "nh-sender-stamped",
            "sessionRef": { "provider": "claude", "sessionId": "prealloc-prospective-2" },
        })),
    );

    // The client's editor captured the pane's pre-durable binding — the
    // same rungs the sender stamped into its content.
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/panes/p1")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({
                "name": "Pre-durable keep me",
                "nameIntent": "user",
                "expectedNameRef": { "kind": "pending", "id": "nh-sender-stamped" },
            })
            .to_string(),
        ))
        .unwrap();
    let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "pending", "id": "nh-sender-stamped" }),
        "{body}"
    );
    // ONE rename, targeted at the pending record — no session-first
    // attempt, no fallback, no spurious capture conflict.
    let recorded_renames = sink.renames.lock().unwrap().clone();
    assert_eq!(recorded_renames.len(), 1, "{recorded_renames:?}");
    assert_eq!(
        recorded_renames[0].target,
        SessionNameRef::Pending {
            id: "nh-sender-stamped".into()
        }
    );
    assert_eq!(recorded_renames[0].name, "Pre-durable keep me");
    assert_eq!(recorded_renames[0].intent, NameIntent::User);
}

/// Unified agent names (Task 8 acceptance): a pane-header rename carries the
/// editor's CAPTURED binding (`expectedNameRef`) — the client's assertion
/// that the pane is scoped with that naming target. The layout mirror is a
/// REPLICA that lags a freshly created agent pane: the ui.layout.sync
/// carrying the picker→agent content switch lands seconds after the editor
/// could open, and a rename committed inside that window resolved the pane
/// through its STALE pre-selection content — silently downgrading the
/// scoped rename to the legacy layout label (the manual pre-durable name
/// was lost; the first-message fallback later won). The capture must never
/// be silently downgraded: a mirror that resolves unscoped while the
/// request carries a scoped capture targets the CAPTURED binding through
/// the naming authority, not the layout alias.
#[tokio::test]
async fn pane_rename_with_capture_never_downgrades_to_the_legacy_label() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    sink.ensure_pending(PendingNameInput {
        handle: "nh-stale-mirror".into(),
        provider: NamedProvider::Claude,
        cwd: Some("/work/stale-mirror".into()),
    })
    .await
    .unwrap();

    // The mirror's LAST adopted sync predates the picker→agent selection:
    // the pane is still adopted as its pre-selection PICKER content.
    seed_layout(
        &state,
        lone_pane_layout(json!({ "kind": "picker", "title": "New Tab" })),
    );

    // The editor's captured binding — the pre-durable handle the sender
    // stamped and the pane header rename asserts.
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/panes/p1")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({
                "name": "Pre-durable keep me",
                "nameIntent": "user",
                "expectedNameRef": { "kind": "pending", "id": "nh-stale-mirror" },
            })
            .to_string(),
        ))
        .unwrap();
    let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // The SCOPED response shape — never the legacy
    // `{tabId, paneId, tabRenamed}` layout-label write.
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "pending", "id": "nh-stale-mirror" }),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionName"]["record"]["name"],
        json!("Pre-durable keep me"),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionName"]["record"]["source"],
        json!("manual"),
        "{body}"
    );
    assert!(body["data"].get("tabRenamed").is_none(), "{body}");
    // ONE rename through the naming authority, targeted at the capture —
    // the same single-rename/no-fallback shape as the fresh-mirror test.
    let recorded_renames = sink.renames.lock().unwrap().clone();
    assert_eq!(recorded_renames.len(), 1, "{recorded_renames:?}");
    assert_eq!(
        recorded_renames[0].target,
        SessionNameRef::Pending {
            id: "nh-stale-mirror".into()
        }
    );
    assert_eq!(recorded_renames[0].name, "Pre-durable keep me");
    assert_eq!(recorded_renames[0].intent, NameIntent::User);
    // And NO legacy `ui.command{pane.rename}` alias frame.
    let mut rx = tx.subscribe();
    let frames = drain_frames(&mut rx);
    assert!(
        !frames.iter().any(|frame| {
            frame["command"] == json!("pane.rename") || frame["type"] == json!("pane.rename")
        }),
        "{frames:?}"
    );
}

/// The same capture-wins rule when the mirror has never adopted the pane at
/// all (a rename racing the FIRST sync): a missing mirror resolution must
/// not answer `pane not found` (the legacy miss shape) when the request
/// carries a scoped capture the naming authority can resolve.
#[tokio::test]
async fn pane_rename_with_capture_targets_the_capture_when_the_pane_is_unmirrored() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    sink.ensure_pending(PendingNameInput {
        handle: "nh-unsynced".into(),
        provider: NamedProvider::Claude,
        cwd: Some("/work/unsynced".into()),
    })
    .await
    .unwrap();

    // No layout seed at all: the pane exists only in the (unsynced) client.
    let req = Request::builder()
        .method("PATCH")
        .uri("/api/panes/p1")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({
                "name": "Pre-durable keep me",
                "nameIntent": "user",
                "expectedNameRef": { "kind": "pending", "id": "nh-unsynced" },
            })
            .to_string(),
        ))
        .unwrap();
    let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "pending", "id": "nh-unsynced" }),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionName"]["record"]["source"],
        json!("manual"),
        "{body}"
    );
}

/// Unified agent names (Task 8 acceptance): the tab route's Session
/// source-pointer gate is fed by the SAME lagging mirror as the pane
/// resolution — the ui.layout.sync carrying the tab's post-selection
/// `nameSource: Session{pane}` (and the pane's agent content) lands seconds
/// after the editor could open. A tab rename committed inside that window
/// answered the LEGACY tab-title write. The capture on the request is the
/// client's assertion that the tab's name IS a session's name with that
/// binding; it must reach the naming authority through the same
/// capture-wins rule as the pane route.
#[tokio::test]
async fn tab_rename_with_capture_never_downgrades_to_the_legacy_title() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    sink.ensure_pending(PendingNameInput {
        handle: "nh-tab-stale".into(),
        provider: NamedProvider::Claude,
        cwd: Some("/work/tab-stale".into()),
    })
    .await
    .unwrap();

    // The mirror's LAST adopted sync predates the selection: the tab's lone
    // pane is still the pre-selection PICKER (its nameSource is the
    // unresolved derivation, never Session).
    seed_layout(
        &state,
        lone_pane_layout(json!({ "kind": "picker", "title": "New Tab" })),
    );

    let req = Request::builder()
        .method("PATCH")
        .uri("/api/tabs/t1")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({
                "name": "Pre-durable keep me",
                "nameIntent": "user",
                "expectedNameRef": { "kind": "pending", "id": "nh-tab-stale" },
            })
            .to_string(),
        ))
        .unwrap();
    let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "pending", "id": "nh-tab-stale" }),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionName"]["record"]["name"],
        json!("Pre-durable keep me"),
        "{body}"
    );
    assert_eq!(
        body["data"]["sessionName"]["record"]["source"],
        json!("manual"),
        "{body}"
    );
    // The response envelope still carries the sole pane the client's editor
    // captured (renamePaneAfterMirrorReady checks `data.paneId`).
    assert_eq!(body["data"]["paneId"], json!("p1"), "{body}");
    // ONE rename through the naming authority; NO legacy alias frame.
    let recorded_renames = sink.renames.lock().unwrap().clone();
    assert_eq!(recorded_renames.len(), 1, "{recorded_renames:?}");
    assert_eq!(
        recorded_renames[0].target,
        SessionNameRef::Pending {
            id: "nh-tab-stale".into()
        }
    );
    let mut rx = tx.subscribe();
    let frames = drain_frames(&mut rx);
    assert!(
        !frames.iter().any(|frame| {
            frame["command"] == json!("tab.rename") || frame["type"] == json!("tab.rename")
        }),
        "{frames:?}"
    );
}

/// Unified agent names (Task 8 acceptance): the pre-bind fallback is a
/// FALLBACK — a pane with NO pending binding anywhere (no content
/// `namingHandle`, no registry-row binding, no stash) keeps the honest
/// 404 NAME_NOT_FOUND, never a silent success.
#[tokio::test]
async fn pre_bind_rename_without_any_pending_binding_stays_404() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let _sink = wire_recording_sink(&state);

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "prealloc-unbound" },
        })),
    );

    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Nothing To Target").await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(body["error"], json!("NAME_NOT_FOUND"), "{body}");
}

/// Unified agent names (Task 2): renaming a SCOPED pane routes to the ONE
/// naming authority — the durable session record — and never writes the
/// layout alias: NO `ui.command{pane.rename}` frame, no registry title
/// write-through, no `terminals.changed`. The b5fb invariant survives
/// (never a settings session override); live propagation is the naming
/// publisher's `session.name.updated`, not a sticky layout title.
#[tokio::test]
async fn rename_pane_routes_a_scoped_claude_pane_to_the_naming_authority() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-sr1", "sess-ref-1").await;

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "sess-ref-1" },
        })),
    );

    // Subscribe AFTER the create so only the rename's frames are captured.
    let mut rx = tx.subscribe();
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Local Only").await;

    assert_eq!(status, StatusCode::OK, "{body}");
    // ONE rename through the authority, targeting the durable ref, with the
    // default automatic intent (an agent suggestion never acquires a user
    // rename's permanence).
    let renames = sink.renames.lock().unwrap();
    assert_eq!(renames.len(), 1, "{renames:?}");
    assert_eq!(
        renames[0].target,
        SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-ref-1".into(),
        }
    );
    assert_eq!(renames[0].name, "Local Only");
    assert_eq!(renames[0].intent, NameIntent::Automatic);
    drop(renames);
    // The accepted record rides the response envelope.
    assert_eq!(
        body["data"]["sessionName"]["record"]["name"],
        json!("Local Only"),
        "{body}"
    );
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "session", "provider": "claude", "sessionId": "sess-ref-1" }),
        "{body}"
    );
    // NO layout-alias frames: the scoped rename publishes through the
    // naming publisher, never a sticky ui.command title.
    let frames = drain_frames(&mut rx);
    assert!(
        frames.is_empty(),
        "a scoped rename emits no layout-alias frames: {frames:?}"
    );
    // The registry title is untouched by the route (the publisher owns the
    // write-through).
    assert_ne!(
        registry.title_of(&terminal_id).as_deref(),
        Some("Local Only"),
        "registry title untouched by a pane rename"
    );
}

/// Delta-review round 3, finding 8: an unknown `nameIntent` string (a typo
/// like `"User"`) is a loud 400 on the pane/tab convenience routes too —
/// the same rejection the canonical PATCH route, CLI, and MCP apply — never
/// a silent default to `automatic` that quietly strips an intended rename's
/// permanence.
#[tokio::test]
async fn pane_rename_with_an_unknown_name_intent_is_rejected_loudly() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-typo", "sess-typo-1").await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": "sess-typo-1" },
        })),
    );

    let req = Request::builder()
        .method("PATCH")
        .uri("/api/panes/p1")
        .header("content-type", "application/json")
        .header("x-auth-token", "tok")
        .body(Body::from(
            json!({ "name": "Typo Intent", "nameIntent": "User" }).to_string(),
        ))
        .unwrap();
    let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
    let status = resp.status();
    let body = body_json(resp).await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "a typoed nameIntent is rejected loudly, not silently defaulted: {body}"
    );
    {
        let renames = sink.renames.lock().unwrap();
        assert!(
            renames.is_empty(),
            "no silent automatic rename reached the authority: {renames:?}"
        );
    }

    // The valid values and the omitted default still work (the gate must
    // not over-apply).
    for intent in [None, Some("user"), Some("automatic")] {
        let req = Request::builder()
            .method("PATCH")
            .uri("/api/panes/p1")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(Body::from(
                json!({ "name": "Valid Intent", "nameIntent": intent }).to_string(),
            ))
            .unwrap();
        let resp = crate::router(state.clone()).oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK, "intent {intent:?} is valid");
    }
}

/// Unified agent names (Task 2): A→B pane reuse routes each rename to the
/// pane's CURRENT binding — the durable record the content names now —
/// never carrying a label across sessions. No frames, no registry titles.
#[tokio::test]
async fn pane_reuse_across_sessions_targets_the_current_binding_only() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let registry = freshell_terminal::TerminalRegistry::new();
    let state = state_with(tx.clone()).with_terminal_registry(registry.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-a", "aaaa0000-0000-4000-8000-00000000000a").await;
    seed_durable_record(&sink, "handle-b", "bbbb0000-0000-4000-8000-00000000000b").await;

    let terminal_id = create_registry_terminal(crate::router(state.clone())).await;
    let mut rx = tx.subscribe();
    // Session A displayed
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal", "mode": "claude", "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "aaaa0000-0000-4000-8000-00000000000a" },
        })),
    );
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Reusable Name").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    // Pane reused for session B (a new conversation on the same pane)
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal", "mode": "claude", "terminalId": terminal_id,
            "sessionRef": { "provider": "claude", "sessionId": "bbbb0000-0000-4000-8000-00000000000b" },
        })),
    );
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Reusable Name 2").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Each rename targeted the binding CURRENT at its moment — A then B.
    let renames = sink.renames.lock().unwrap();
    assert_eq!(renames.len(), 2, "{renames:?}");
    assert_eq!(
        renames[0].target,
        SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "aaaa0000-0000-4000-8000-00000000000a".into(),
        }
    );
    assert_eq!(
        renames[1].target,
        SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "bbbb0000-0000-4000-8000-00000000000b".into(),
        }
    );
    drop(renames);

    let title = registry.title_of(&terminal_id);
    assert!(
        title.as_deref() != Some("Reusable Name") && title.as_deref() != Some("Reusable Name 2"),
        "registry title never takes a pane label: {title:?}"
    );
    let frames = drain_frames(&mut rx);
    assert!(
        frames.is_empty(),
        "scoped reuse renames emit no layout-alias frames: {frames:?}"
    );
}

/// Unified agent names (Task 2): a pane renamed BEFORE its durable identity
/// exists targets its PENDING handle (the pre-durable naming admission) —
/// the rename never waits for materialization, and the record's later
/// verified bind carries it.
#[tokio::test]
async fn naming_pending_bind_targets_the_pre_durable_handle() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    sink.ensure_pending(PendingNameInput {
        handle: "handle-p".into(),
        provider: NamedProvider::Claude,
        cwd: Some("/work/alpha".into()),
    })
    .await
    .unwrap();

    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "namingHandle": "handle-p",
        })),
    );
    let (status, body) =
        patch_pane(crate::router(state.clone()), "p1", "Named Before Identity").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let recorded_renames = sink.renames.lock().unwrap().clone();
    assert_eq!(recorded_renames.len(), 1, "{recorded_renames:?}");
    assert_eq!(
        recorded_renames[0].target,
        SessionNameRef::Pending {
            id: "handle-p".into()
        }
    );

    // The pending record's MANUAL name carries through the verified bind.
    sink.bind_pending(BindNameInput {
        pending: SessionNameRef::Pending {
            id: "handle-p".into(),
        },
        target: SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-late".into(),
        },
        acquisition: verified_claude_acquisition("sess-late"),
    })
    .await
    .unwrap();
    let bound = sink
        .get(vec![SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-late".into(),
        }])
        .await
        .unwrap();
    assert_eq!(bound[0].record.name, "Named Before Identity");
}

/// Unified agent names (Task 2): the pane names through its CURRENT binding
/// — a resume answers the durable record, a new conversation adopts the NEW
/// session's record — and a stale editor capture (`expectedNameRef`) is
/// refused visibly (409 NAME_TARGET_MOVED), never silently retargeted.
#[tokio::test]
async fn naming_resume_and_new_conversation_follow_the_current_binding() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-a", "aaaa0000-0000-4000-8000-00000000000a").await;
    seed_durable_record(&sink, "handle-b", "bbbb0000-0000-4000-8000-00000000000b").await;

    // A resumed pane names its durable session.
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "fresh-agent", "sessionType": "freshclaude",
            "provider": "claude", "sessionId": "aaaa0000-0000-4000-8000-00000000000a",
            "sessionRef": { "provider": "claude", "sessionId": "aaaa0000-0000-4000-8000-00000000000a" },
        })),
    );
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Resumed Name").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "session", "provider": "claude", "sessionId": "aaaa0000-0000-4000-8000-00000000000a" }),
        "{body}"
    );

    // A new conversation on the same pane adopts the NEW session's record.
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "fresh-agent", "sessionType": "freshclaude",
            "provider": "claude", "sessionId": "bbbb0000-0000-4000-8000-00000000000b",
            "sessionRef": { "provider": "claude", "sessionId": "bbbb0000-0000-4000-8000-00000000000b" },
        })),
    );
    let (status, body) =
        patch_pane(crate::router(state.clone()), "p1", "New Conversation Name").await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(
        body["data"]["nameRef"],
        json!({ "kind": "session", "provider": "claude", "sessionId": "bbbb0000-0000-4000-8000-00000000000b" }),
        "{body}"
    );

    // A stale editor capture is refused visibly — the rename never lands on
    // the wrong conversation.
    let router = crate::router(state.clone());
    let resp = router
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/panes/p1")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({
                        "name": "Stale Editor",
                        "expectedNameRef": { "kind": "session", "provider": "claude", "sessionId": "aaaa0000-0000-4000-8000-00000000000a" }
                    })
                    .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let v = body_json(resp).await;
    assert_eq!(v["error"], json!("NAME_TARGET_MOVED"));

    let renames = sink.renames.lock().unwrap();
    assert_eq!(
        renames.len(),
        2,
        "the refused rename never reached the authority: {renames:?}"
    );
}

/// Unified agent names (Task 2 review, M2): a session-owned tab has NO
/// separately stored name — renaming the TAB targets the SOURCE pane's
/// session (the deterministic first-leaf the mirror recorded), never the
/// ACTIVE pane. This tab's active pane is a shell leaf; its source pane is
/// the scoped claude leaf — the rename must land on the source session and
/// never write the layout alias.
#[tokio::test]
async fn rename_tab_routes_a_multi_pane_tab_through_its_source_pane_not_the_active_pane() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-tabsrc", "sess-tab-src").await;

    // Tab t1: the SOURCE pane p1 (first leaf, scoped claude) plus a shell
    // leaf p2 that holds the ACTIVE-PANE slot — the pane a rename routed
    // through `activePane` would wrongly target (falling to the legacy
    // layout rename).
    seed_layout(
        &state,
        json!({
            "tabs": [{ "id": "t1", "title": "First" }],
            "activeTabId": "t1",
            "layouts": { "t1": {
                "type": "split", "id": "s1", "direction": "horizontal", "sizes": [50, 50],
                "children": [
                    { "type": "leaf", "id": "p1", "content": {
                        "kind": "terminal", "mode": "claude",
                        "sessionRef": { "provider": "claude", "sessionId": "sess-tab-src" },
                    } },
                    { "type": "leaf", "id": "p2", "content": { "kind": "terminal", "mode": "shell" } },
                ],
            } },
            "activePane": { "t1": "p2" },
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 1,
        }),
    );

    let (status, body) = patch_tab(
        crate::router(state.clone()),
        "t1",
        json!({ "name": "Via Tab Rename" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    // Exactly ONE rename, targeting the SOURCE pane's durable session.
    let renames = sink.renames.lock().unwrap();
    assert_eq!(renames.len(), 1, "{renames:?}");
    assert_eq!(
        renames[0].target,
        SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-tab-src".into(),
        },
        "the tab rename must target the SOURCE pane's session, never the active pane"
    );
    assert_eq!(renames[0].name, "Via Tab Rename");
    drop(renames);

    // The accepted record rides the response envelope.
    assert_eq!(
        body["data"]["sessionName"]["record"]["name"],
        json!("Via Tab Rename"),
        "{body}"
    );
    // And NO layout-alias frames: the accepted name publishes through the
    // naming publisher, never a sticky ui.command title.
    let mut rx = tx.subscribe();
    assert!(
        drain_frames(&mut rx).is_empty(),
        "a scoped tab rename emits no layout-alias frames"
    );
}

/// Unified agent names (Task 2 review, M4): a scoped blank/absent `name`
/// through the pane/tab convenience routes answers the SAME machine-readable
/// refusal as the canonical/session/terminal surfaces — 400
/// `NAME_RESET_UNSUPPORTED` — because a scoped session's saved name is never
/// cleared. (The legacy `name required` contract stays for non-scoped panes.)
#[tokio::test]
async fn scoped_blank_rename_refuses_name_reset_unsupported_on_pane_and_tab_routes() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-blank", "sess-blank-ref").await;

    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal",
            "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": "sess-blank-ref" },
        })),
    );

    // The pane route: a blank name, and an absent name — both must answer
    // 400 NAME_RESET_UNSUPPORTED.
    for body in [json!({ "name": "" }), json!({})] {
        let router = crate::router(state.clone());
        let req = Request::builder()
            .method("PATCH")
            .uri("/api/panes/p1")
            .header("content-type", "application/json")
            .header("x-auth-token", "tok")
            .body(Body::from(body.to_string()))
            .unwrap();
        let resp = router.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST, "{body}");
        let answered = body_json(resp).await;
        assert_eq!(
            answered["error"],
            json!("NAME_RESET_UNSUPPORTED"),
            "the scoped pane route must refuse a blank name with the uniform code: {body} -> {answered}"
        );
    }

    // The tab route (the tab's source pane is the scoped pane p1): same
    // refusal, same code.
    for body in [json!({ "name": "" }), json!({})] {
        let (status, answered) = patch_tab(crate::router(state.clone()), "t1", body.clone()).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
        assert_eq!(
            answered["error"],
            json!("NAME_RESET_UNSUPPORTED"),
            "the scoped tab route must refuse a blank name with the uniform code: {body} -> {answered}"
        );
    }

    // Nothing ever reached the authority (a protected name is never cleared).
    assert!(sink.renames.lock().unwrap().is_empty());
}

/// Unified agent names (Task 2): the route passes the editor's inputs
/// through faithfully — explicit `nameIntent:"user"` maps to the user intent,
/// an omitted intent defaults to automatic, and `ifRevision` rides the
/// compare-and-set.
#[tokio::test]
async fn naming_accepted_input_intent_and_revision_pass_through() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-i", "sess-intent").await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal", "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": "sess-intent" },
        })),
    );

    // Omitted intent => automatic (the agent-suggestion default).
    let router = crate::router(state.clone());
    let resp = router
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/panes/p1")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(json!({ "name": "Default Intent" }).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Explicit user intent + a compare-and-set revision. The sink honors
    // the CAS (the real store's contract): the seed binds at revision 2,
    // the first rename above moved it to 3, so the matching revision is 3.
    let router = crate::router(state.clone());
    let resp = router
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/panes/p1")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "name": "User Intent", "nameIntent": "user", "ifRevision": 3 })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let renames = sink.renames.lock().unwrap();
    assert_eq!(renames.len(), 2, "{renames:?}");
    assert_eq!(renames[0].intent, NameIntent::Automatic);
    assert_eq!(renames[0].if_revision, None);
    assert_eq!(renames[1].intent, NameIntent::User);
    assert_eq!(renames[1].if_revision, Some(3));
    drop(renames);
}

/// Unified agent names (Task 8 acceptance): a stale `ifRevision` conflict
/// must answer the CURRENT record as `sessionName` — the client editor's
/// documented conflict contract (the accepted winner is folded for display
/// AND the editor's capture is refreshed from it so the user's resubmit
/// can succeed). The canonical/session/terminal routes already carry it
/// (`name_error_response`); the pane route must answer the same shape —
/// without it the pane editor is STUCK: every resubmit re-sends the same
/// stale revision and re-conflicts forever (observed live: "the record
/// moved to revision 2 while the editor held 1" persisting across every
/// resubmit of a pre-durable rename racing its own materialization).
#[tokio::test]
async fn stale_revision_conflict_answers_the_current_record() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    // The seed binds the durable record at revision 2 (pending admission
    // allocates 1, the verified bind moves it to 2) — the exact live
    // sequence of a pre-durable pane rename racing its materialization.
    seed_durable_record(&sink, "handle-conflict", "sess-conflict").await;
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "terminal", "mode": "claude",
            "sessionRef": { "provider": "claude", "sessionId": "sess-conflict" },
        })),
    );

    let router = crate::router(state.clone());
    let resp = router
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/panes/p1")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "name": "Stale Edit", "nameIntent": "user", "ifRevision": 1 })
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::CONFLICT);
    let answered = body_json(resp).await;
    assert_eq!(
        answered["error"],
        json!("NAME_REVISION_CONFLICT"),
        "the conflict class must be the uniform code: {answered}"
    );
    assert!(
        answered["sessionName"].is_object(),
        "the conflict must answer the CURRENT record as sessionName (the editor's          capture-refresh contract — without it the pane editor re-conflicts the          same stale revision forever): {answered}"
    );
    assert_eq!(
        answered["sessionName"]["revision"],
        json!(2),
        "the answered record is the accepted current one: {answered}"
    );
}

/// Unified agent names (Task 2): a zero-turn fresh-agent pane (restarted
/// before any durable materialization) RETAINS its pre-durable handle — the
/// create-lane stash keys it by the pane's placeholder sessionId, and the
/// rename resolves the pending handle from there.
#[tokio::test]
async fn naming_zero_turn_initial_recovery_resolves_the_retained_handle() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    sink.ensure_pending(PendingNameInput {
        handle: "handle-z".into(),
        provider: NamedProvider::Claude,
        cwd: None,
    })
    .await
    .unwrap();
    // The create lane stashed the handle under the pane's placeholder.
    state.stash_naming_handle("placeholder-1", "handle-z");

    // The pane content carries NO sessionRef and NO namingHandle (the
    // restart reminted the content; only the stash retains the handle).
    seed_layout(
        &state,
        lone_pane_layout(json!({
            "kind": "fresh-agent", "sessionType": "freshclaude",
            "provider": "claude", "sessionId": "placeholder-1",
        })),
    );
    let (status, body) = patch_pane(crate::router(state.clone()), "p1", "Recovered Name").await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let renames = sink.renames.lock().unwrap();
    assert_eq!(renames.len(), 1, "{renames:?}");
    assert_eq!(
        renames[0].target,
        SessionNameRef::Pending {
            id: "handle-z".into()
        },
        "the retained pre-durable handle is the rename target: {renames:?}"
    );
    drop(renames);
}

/// Unified agent names (Task 6): the client's SYNCED nameSource pointer is
/// authoritative on the server mirror — a tab whose adopted pointer names a
/// NON-first leaf (e.g. after a content swap moved the source off the first
/// slot) routes its tab rename through THAT pane's session, never the
/// derived first leaf.
#[tokio::test]
async fn rename_tab_routes_through_the_adopted_synced_name_source_not_the_derived_first_leaf() {
    let (tx, _rx) = tokio::sync::broadcast::channel::<String>(64);
    let state = state_with(tx.clone());
    let sink = wire_recording_sink(&state);
    seed_durable_record(&sink, "handle-adopted", "sess-adopted-source").await;

    // Tab t1: first leaf is a shell (derivation would say legacy), second
    // leaf is the scoped claude pane the client's pointer names.
    seed_layout(
        &state,
        json!({
            "tabs": [{ "id": "t1", "title": "First", "nameSource": { "kind": "session", "paneId": "p-agent" } }],
            "activeTabId": "t1",
            "layouts": { "t1": {
                "type": "split", "id": "s1", "direction": "horizontal", "sizes": [50, 50],
                "children": [
                    { "type": "leaf", "id": "p-shell", "content": {
                        "kind": "terminal", "mode": "shell",
                    } },
                    { "type": "leaf", "id": "p-agent", "content": {
                        "kind": "terminal", "mode": "claude",
                        "sessionRef": { "provider": "claude", "sessionId": "sess-adopted-source" },
                    } },
                ],
            } },
            "activePane": { "t1": "p-shell" },
            "paneTitles": {},
            "paneTitleSetByUser": {},
            "timestamp": 1,
        }),
    );

    let (status, body) = patch_tab(
        crate::router(state.clone()),
        "t1",
        json!({ "name": "Adopted Pointer Rename" }),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let renames = sink.renames.lock().unwrap();
    assert_eq!(renames.len(), 1, "{renames:?}");
    assert_eq!(
        renames[0].target,
        SessionNameRef::Session {
            provider: NamedProvider::Claude,
            session_id: "sess-adopted-source".into(),
        },
        "the tab rename must route through the ADOPTED synced pointer's session, never the derived first leaf"
    );
    assert_eq!(renames[0].name, "Adopted Pointer Rename");
}
