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

    // Explicit user intent + a compare-and-set revision.
    let router = crate::router(state.clone());
    let resp = router
        .oneshot(
            Request::builder()
                .method("PATCH")
                .uri("/api/panes/p1")
                .header("x-auth-token", "tok")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({ "name": "User Intent", "nameIntent": "user", "ifRevision": 7 })
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
    assert_eq!(renames[1].if_revision, Some(7));
    drop(renames);
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
