//! Tabs-sync snapshot REST surface (continuity trio,
//! docs/plans/2026-07-22-continuity-safety-trio.md). PURELY ADDITIVE: the legacy
//! server has no on-disk snapshot generations, so this diverges from no ported
//! behavior and gets no DEVIATIONS ledger entry.
//! Read endpoints serve the generations `freshell_ws::tabs_persist` persists.
//! The store's consumers are these GET endpoints (operator tooling, e.g.
//! `scripts/deploy-tab-diff.sh`) and `GET /api/recovery/inventory` + the
//! client recover-my-panes flow (the operator server-push restore endpoint
//! was deleted in the kata h9vt cleanup).

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Json, Response};
use axum::routing::get;
use axum::Router;
use serde_json::{json, Value};

use crate::boot::is_authed; // pub(crate) in boot.rs:686 — same crate, no copy

#[derive(Clone)]
pub struct TabsSnapshotsState {
    pub auth_token: Arc<String>,
    pub snapshots_dir: Option<PathBuf>,
}

pub fn router(state: TabsSnapshotsState) -> Router {
    Router::new()
        .route("/api/tabs-sync/snapshots", get(list_snapshots))
        .route("/api/tabs-sync/snapshots/{device_id}", get(get_snapshot))
        .with_state(state)
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        Json(json!({ "error": "Unauthorized" })),
    )
        .into_response()
}

/// A backup is PRESENT but unreadable/corrupt, OR a `spawn_blocking` task failed:
/// 500 + structured log with the store path + error (`:480`). NEVER 404 (that is
/// reserved for genuine absence) and never a silent empty success. `err` accepts
/// both `std::io::Error` and `tokio::task::JoinError` (both `Display`).
fn snapshots_read_error(dir: &std::path::Path, err: &dyn std::fmt::Display) -> Response {
    tracing::error!(target: "freshell_server::tabs_snapshots", path = %dir.display(),
        error = %err, "tabs_snapshot_store_unreadable");
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": "snapshot store unreadable" })),
    )
        .into_response()
}

// Fail-closed selector parsing for the GET query params — see
// `tabs_snapshots_selectors.rs`.
#[path = "tabs_snapshots_selectors.rs"]
mod selectors_mod;
use selectors_mod::{parse_selector, Selector};

async fn list_snapshots(State(state): State<TabsSnapshotsState>, headers: HeaderMap) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = state.snapshots_dir.clone() else {
        return Json(json!({ "devices": [] })).into_response();
    };
    let dir_for_log = dir.clone();
    // All filesystem work runs off the async runtime (blocking read_dir/parse).
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Vec<Value>> {
        let mut out = Vec::new();
        for device in freshell_ws::tabs_persist::list_snapshot_devices(&dir)? {
            // ONE directory scan per device -> (union, generation index).
            let (union, generations) =
                match freshell_ws::tabs_persist::read_device_overview(&dir, &device)? {
                    Some(pair) => pair,
                    None => (Value::Null, Vec::new()),
                };
            out.push(json!({
                "deviceId": device,
                "deviceLabel": union.get("deviceLabel").cloned().unwrap_or(Value::Null),
                "recordCount": union.get("records").and_then(Value::as_array).map(|r| r.len()).unwrap_or(0),
                "capturedAt": union.get("capturedAt").cloned().unwrap_or(Value::Null),
                "generations": generations,
            }));
        }
        Ok(out)
    })
    .await;
    match result {
        Ok(Ok(devices)) => Json(json!({ "devices": devices })).into_response(),
        Ok(Err(err)) => snapshots_read_error(&dir_for_log, &err),
        Err(join_err) => snapshots_read_error(&dir_for_log, &join_err),
    }
}

async fn get_snapshot(
    State(state): State<TabsSnapshotsState>,
    AxumPath(device_id): AxumPath<String>,
    headers: HeaderMap,
    Query(params): Query<Vec<(String, String)>>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(dir) = state.snapshots_dir.clone() else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Snapshot not found" })),
        )
            .into_response();
    };
    let selector = match parse_selector(&params) {
        Ok(s) => s,
        Err(resp) => return resp,
    };
    let dir_for_log = dir.clone();
    // No selector -> coherent device union; generationId -> stable-digest file;
    // generation=N -> Nth-newest point-in-time file. All reads off-runtime, fail-loud.
    let result = tokio::task::spawn_blocking(move || -> std::io::Result<Option<Value>> {
        match selector {
            Selector::Id(id) => {
                freshell_ws::tabs_persist::read_generation_by_id(&dir, &device_id, &id)
            }
            Selector::Index(n) => freshell_ws::tabs_persist::read_generation(&dir, &device_id, n),
            Selector::Union => freshell_ws::tabs_persist::read_device_union(&dir, &device_id),
        }
    })
    .await;
    match result {
        Ok(Ok(Some(snap))) => Json(snap).into_response(),
        Ok(Ok(None)) => (
            StatusCode::NOT_FOUND,
            Json(json!({ "error": "Snapshot not found" })),
        )
            .into_response(),
        Ok(Err(err)) => snapshots_read_error(&dir_for_log, &err),
        Err(join_err) => snapshots_read_error(&dir_for_log, &join_err),
    }
}

#[cfg(test)]
#[path = "tabs_snapshots_tests.rs"]
mod tests;
