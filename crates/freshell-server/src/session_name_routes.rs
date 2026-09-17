//! Unified agent names (Task 2): the canonical session-name HTTP surface —
//! `POST /api/session-names/read` and `PATCH /api/session-names` — plus the
//! shared helpers the convenience routes (session/terminal/pane/tab) and the
//! read projections (directory/resolve/terminal inventory) use, so EVERY
//! surface resolves the same `rename` call and the same canonical record.
//!
//! Ownership: the authority is the ONE `SessionNames` store constructed in
//! `main.rs` BEFORE publication; every mutation path lands in the store's
//! guarded current-document transaction (see `session_names.rs`), and
//! commits publish `session.name.updated` through the wired publisher — a
//! route response is the accepted update, never a second name authority.
//!
//! Error policy (plan "Name acceptance, storage, and publication"): every
//! error path logs STRUCTURED severity/operation/name-reference/revision/
//! failure-class JSONL (`naming::log_name_error` — `tracing` is this
//! server's JSONL channel) and answers the mapped HTTP status with the
//! stable machine-readable `NameError::code()`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use freshell_freshagent::naming::{
    log_name_error, NameError, RenameNameInput, SessionNaming, NAME_RESET_UNSUPPORTED,
};
use freshell_protocol::session_names::{
    NameIntent, RenameSessionNameRequest, SessionNameRef, MAX_NAME_REVISION,
};

use crate::boot::{is_authed, unauthorized};
use crate::session_names::SessionNames;

/// Client batch reads are chunked to this many references per request (plan
/// rule 9 / the route contract).
pub(crate) const READ_CHUNK_LIMIT: usize = 100;

/// Shared state for the session-names sub-router.
#[derive(Clone)]
pub struct SessionNamesState {
    pub auth_token: Arc<String>,
    /// The ONE durable name authority, constructed in `main.rs` before
    /// publication and shared with every other surface's wiring.
    pub names: Arc<SessionNames>,
}

/// The session-names sub-router (`POST /api/session-names/read` +
/// `PATCH /api/session-names`).
pub fn router(state: SessionNamesState) -> Router {
    Router::new()
        .route("/api/session-names/read", post(read_session_names))
        .route("/api/session-names", patch(rename_session_name))
        .with_state(state)
}

/// Map a store error onto the route wire shape: the mapped HTTP status (the
/// plan's 400/404/409/409/503/503/503) plus the stable machine-readable
/// code, with the structured JSONL error log already emitted by the caller.
pub(crate) fn name_error_response(error: &NameError, target: &SessionNameRef) -> Response {
    let status =
        StatusCode::from_u16(error.http_status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    let conflict_current = if let NameError::Conflict { current, .. } = error {
        current.clone()
    } else {
        None
    };
    let mut body = json!({
        "error": error.code(),
        "message": error.to_string(),
        "nameRef": target,
    });
    if let Some(current) = conflict_current {
        // The accepted record the editor should surface instead of an
        // invisible overwrite (plan rule 4).
        body["sessionName"] = serde_json::to_value(&current).unwrap_or(Value::Null);
        body["nameRef"] = serde_json::to_value(&current.name_ref).unwrap_or(Value::Null);
    }
    (status, Json(body)).into_response()
}

/// The shared scoped-rename drive every convenience route funnels into —
/// the ONE `rename` call with the intent default (`automatic`: an agent
/// suggestion never acquires a user rename's permanence) and the optional
/// `ifRevision` compare-and-set. Returns the accepted update, or the mapped
/// error response (with the structured error log already emitted).
pub(crate) async fn rename_through_authority(
    sink: &dyn SessionNaming,
    target: SessionNameRef,
    name: String,
    intent: NameIntent,
    if_revision: Option<u64>,
) -> Result<freshell_protocol::session_names::SessionNameUpdate, Response> {
    match sink
        .rename(RenameNameInput {
            target: target.clone(),
            name,
            intent,
            if_revision,
        })
        .await
    {
        Ok(update) => Ok(update),
        Err(error) => {
            log_name_error("rename", &target, &error);
            Err(name_error_response(&error, &target))
        }
    }
}

/// Parse the rename-intent fields a convenience route may carry alongside
/// its legacy body: `nameIntent` (`user` | `automatic`, default automatic)
/// and `ifRevision` (compare-and-set, JS-safe ceiling). Unknown values
/// default rather than erroring — the intent default is a server contract,
/// not a client assertion.
pub(crate) fn parse_rename_intents(body: &Value) -> (NameIntent, Option<u64>) {
    let intent = match body.get("nameIntent").and_then(Value::as_str) {
        Some("user") => NameIntent::User,
        _ => NameIntent::Automatic,
    };
    let if_revision = body
        .get("ifRevision")
        .and_then(Value::as_u64)
        .filter(|r| *r <= MAX_NAME_REVISION);
    (intent, if_revision)
}

/// `POST /api/session-names/read {refs}` → `{names: [SessionNameUpdate]}`.
/// Adopts the current document first (the common full-document refresh path
/// before name-dependent reads), then resolves the requested refs — unknown
/// refs are omitted (plan rule 7). A body naming more than
/// [`READ_CHUNK_LIMIT`] refs is a 400 (the client chunks).
async fn read_session_names(
    State(state): State<SessionNamesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let Some(refs) = body.get("refs").and_then(Value::as_array) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": "refs array is required" })),
        )
            .into_response();
    };
    if refs.len() > READ_CHUNK_LIMIT {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": "Invalid request",
                "details": format!("refs must be chunked to at most {READ_CHUNK_LIMIT} references per request")
            })),
        )
            .into_response();
    }
    let mut targets: Vec<SessionNameRef> = Vec::with_capacity(refs.len());
    for raw in refs {
        match serde_json::from_value::<SessionNameRef>(raw.clone()) {
            Ok(target) => targets.push(target),
            Err(_) => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(json!({
                        "error": "Invalid request",
                        "details": format!("invalid SessionNameRef: {raw}")
                    })),
                )
                    .into_response();
            }
        }
    }
    // The common full-document adoption path before the name-dependent read:
    // a same-home cooperating process's commits (the 2s tick's own refresh)
    // are adopted here too, so a CLI/MCP read reflects current state without
    // polling. Adoption failures degrade to the last established snapshot
    // (the read still answers from it), loudly logged.
    if let Err(error) = state.names.refresh_current().await {
        log_name_error(
            "refresh_current",
            &SessionNameRef::Pending { id: "-".into() },
            &error,
        );
    }
    match state.names.get(targets).await {
        Ok(updates) => Json(json!({ "names": updates })).into_response(),
        Err(error) => {
            // `get` has no single target to name; log per the read's shape.
            tracing::warn!(
                target: "freshell_server::session_names",
                op = "get",
                name_ref = "-",
                revision = 0,
                class = %error.code(),
                "session_names.operation_failed: {}",
                error
            );
            name_error_response(
                &NameError::Persistence(error.to_string()),
                &SessionNameRef::Pending { id: "-".into() },
            )
        }
    }
}

/// `PATCH /api/session-names` with `RenameSessionNameRequest` → the accepted
/// `SessionNameUpdate`. Omitted `nameIntent` defaults to `automatic`; a
/// scoped null/reset never clears a protected name through ANY route — the
/// dedicated reset control is gone (the route answers
/// [`NAME_RESET_UNSUPPORTED`] for a blank name).
async fn rename_session_name(
    State(state): State<SessionNamesState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let request: RenameSessionNameRequest = match serde_json::from_value(body) {
        Ok(request) => request,
        Err(error) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "error": "Invalid request",
                    "details": format!("invalid RenameSessionNameRequest: {error}")
                })),
            )
                .into_response();
        }
    };
    let name = request.name.trim().to_string();
    if name.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({
                "error": NAME_RESET_UNSUPPORTED,
                "message": "a scoped session's saved name is never cleared; rename it instead",
                "nameRef": request.target,
            })),
        )
            .into_response();
    }
    let target = request.target.clone();
    let intent = request.name_intent.unwrap_or(NameIntent::Automatic);
    match rename_through_authority(&*state.names, target, name, intent, request.if_revision).await {
        Ok(update) => Json(serde_json::to_value(&update).unwrap_or(Value::Null)).into_response(),
        Err(response) => response,
    }
}

#[cfg(test)]
#[path = "session_name_routes_tests.rs"]
mod tests;
