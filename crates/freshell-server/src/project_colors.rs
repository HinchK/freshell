//! `PUT /api/project-colors` — the project-color write half of SESSION-05.
//! Faithful port of `server/project-colors-router.ts`
//! (`ProjectColorSchema`: `projectPath: string.min(1).max(1024)`,
//! `color: string.min(1).max(64)`) backed by
//! [`crate::settings_store::SettingsStore::set_project_color`].
//!
//! Broadcast parity: the legacy route ends with
//! `await codingCliIndexer.refresh()`
//! (`project-colors-router.ts:25`), and a refresh whose project-group
//! snapshot differs republishes `sessions.changed`
//! (`sessions-sync/service.ts`). The Rust session sweep
//! (`spawn_sessions_sweep`, `main.rs`) is structurally blind to
//! config-only changes (its `(count, max lastActivityAt)` signature never
//! moves on a color write — the same documented gap class the GAP-1 fix
//! closed for override writes), so — exactly like
//! `sessions::patch_session` — this route broadcasts `sessions.changed`
//! DIRECTLY on a successful write, bumping the SAME shared
//! `sessions_revision` counter so the revision stays on one unified
//! sequence with the sweep/override/fresh-agent producers.
//!
//! Error surfacing: the legacy route AWAITS `configStore.setProjectColor`
//! before responding, so a failed save is a failed request — but its
//! express-4 async handler has no error wrapper, making the exact legacy
//! failure behavior process-undefined. This port surfaces a failed persist
//! as a plain 500 `{error}` envelope (same shape as
//! `SettingsStore::patch`'s GAP2 surfacing) — a documented deliberate
//! hardening, recorded in `docs/plans/df1-evidence/SESSION-05.md`.

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::put,
    Json, Router,
};
use serde_json::{json, Value};

use crate::boot::{is_authed, unauthorized};
use crate::settings_store::SettingsStore;

/// The `ProjectColorSchema` string limits (`project-colors-router.ts:5-6`).
const PROJECT_PATH_MAX: usize = 1024;
const COLOR_MAX: usize = 64;

/// Shared state for the project-colors write surface.
#[derive(Clone)]
pub struct ProjectColorsState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,
    /// The shared WS broadcast bus + revision counter (the SAME
    /// `Arc<AtomicI64>` as `WsState::sessions_revision`,
    /// `sessions::SessionsState::sessions_revision`, and the sweep), so a
    /// color write broadcasts `sessions.changed` on the unified sequence.
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    pub sessions_revision: Arc<std::sync::atomic::AtomicI64>,
}

/// The project-colors sub-router (`PUT /api/project-colors`).
pub fn router(state: ProjectColorsState) -> Router {
    Router::new()
        .route("/api/project-colors", put(put_project_color))
        .with_state(state)
}

/// zod's "received" word for an `invalid_type` issue, derived from the
/// actual JSON value (`received undefined` for a missing key, matching
/// `safeParse(req.body || {})` — see `validate_project_color_body`).
fn received_word(v: &Value) -> &'static str {
    match v {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// `ProjectColorSchema.safeParse(req.body || {})`
/// (`project-colors-router.ts:4-7, 19`): BOTH fields required; per-field
/// checks in schema order (`projectPath`, then `color`), issues collected
/// across fields like zod. Issue shapes are byte-matched to a live zod
/// v4.3.6 probe of the ORIGINAL schema (see
/// `docs/plans/df1/SESSION-05.md` A1): `invalid_type` for
/// missing/null/wrong-type, `too_small`/`too_big` for the string bounds.
/// `None` = valid.
fn validate_project_color_body(body: &Value) -> Option<Value> {
    // `req.body || {}`: a falsy JSON body (null/false/0/"") means the
    // original validates `{}` and reports BOTH fields missing.
    let body = match body {
        Value::Null | Value::Bool(false) => &json!({}),
        other => other,
    };
    let Value::Object(map) = body else {
        return Some(json!([{
            "code": "invalid_type",
            "expected": "object",
            "path": [],
            "message": format!(
                "Invalid input: expected object, received {}",
                received_word(body)
            ),
        }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    for (key, max) in [("projectPath", PROJECT_PATH_MAX), ("color", COLOR_MAX)] {
        match map.get(key) {
            Some(Value::String(s)) => {
                if s.len() < 1 {
                    issues.push(json!({
                        "code": "too_small",
                        "minimum": 1,
                        "origin": "string",
                        "inclusive": true,
                        "path": [key],
                        "message": "Too small: expected string to have >=1 characters",
                    }));
                } else if s.len() > max {
                    issues.push(json!({
                        "code": "too_big",
                        "maximum": max,
                        "origin": "string",
                        "inclusive": true,
                        "path": [key],
                        "message": format!(
                            "Too big: expected string to have <={max} characters"
                        ),
                    }));
                }
            }
            Some(v) => issues.push(json!({
                "code": "invalid_type",
                "expected": "string",
                "path": [key],
                "message": format!(
                    "Invalid input: expected string, received {}",
                    received_word(v)
                ),
            })),
            None => issues.push(json!({
                "code": "invalid_type",
                "expected": "string",
                "path": [key],
                "message": "Invalid input: expected string, received undefined",
            })),
        }
    }
    if issues.is_empty() {
        None
    } else {
        Some(Value::Array(issues))
    }
}

/// `PUT /api/project-colors` (`project-colors-router.ts:18-27`): validate
/// the body, persist the color, broadcast `sessions.changed`, respond
/// `{ok:true}`. The refresh the original performs re-reads
/// `configStore.getProjectColors()` into the project groups — here the
/// client re-reads the colors through the refetch that follows the
/// broadcast (the session-directory page embeds `projectColors`, see
/// `session_directory.rs`), which is the SAME observable client behavior.
async fn put_project_color(
    State(state): State<ProjectColorsState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    if let Some(details) = validate_project_color_body(&body) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": details })),
        )
            .into_response();
    }
    let map = body.as_object().expect("validated as object above");
    let project_path = map["projectPath"].as_str().expect("validated string");
    let color = map["color"].as_str().expect("validated string");

    if let Err(err) = state.settings.set_project_color(project_path, color).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": err.to_string() })),
        )
            .into_response();
    }

    // Broadcast AFTER a successful persist (legacy equivalent: the
    // refresh AFTER `await setProjectColor` —
    // `project-colors-router.ts:24-25`). On the ONE unified
    // `sessions_revision` sequence (see `SessionsState::sessions_revision`).
    let revision = state
        .sessions_revision
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let frame = json!({ "type": "sessions.changed", "revision": revision }).to_string();
    let _ = state.broadcast_tx.send(frame);

    Json(json!({ "ok": true })).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    fn state_at(dir: &std::path::Path) -> (ProjectColorsState, tokio::sync::broadcast::Receiver<String>) {
        let (tx, rx) = tokio::sync::broadcast::channel::<String>(16);
        (
            ProjectColorsState {
                auth_token: Arc::new("tok".to_string()),
                settings: SettingsStore::load(
                    Some(dir),
                    vec!["claude".into(), "codex".into()],
                ),
                broadcast_tx: Arc::new(tx),
                sessions_revision: Arc::new(std::sync::atomic::AtomicI64::new(0)),
            },
            rx,
        )
    }

    async fn put_json(
        app: &Router,
        token: Option<&str>,
        body: &Value,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder()
            .method("PUT")
            .uri("/api/project-colors")
            .header("content-type", "application/json");
        if let Some(token) = token {
            req = req.header("x-auth-token", token);
        }
        let resp = app
            .clone()
            .oneshot(req.body(Body::from(body.to_string())).unwrap())
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap()
        };
        (status, json)
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        format!("{:x}-{:x}", nanos, std::process::id())
    }

    /// UNAUTH: no token → the same 401 as every other authed route
    /// (`httpAuthMiddleware` / `is_authed`).
    #[tokio::test]
    async fn put_requires_auth() {
        let dir = std::env::temp_dir().join(format!("frs-project-colors-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let (state, _rx) = state_at(&dir);
        let app = router(state);

        let (status, _body) = put_json(
            &app,
            None,
            &json!({ "projectPath": "/proj/a", "color": "#ff0000" }),
        )
        .await;
        assert_eq!(status, StatusCode::UNAUTHORIZED);

        std::fs::remove_dir_all(&dir).ok();
    }

    /// VALIDATION, missing fields: `{}` and `{}`-equivalent falsy bodies
    /// report BOTH fields (`safeParse(req.body || {})`,
    /// `project-colors-router.ts:19`) with the legacy 400 envelope; the
    /// integration suite pins this (`api-edge-cases.test.ts` "rejects
    /// empty body" / "rejects missing projectPath" / "rejects missing
    /// color").
    #[tokio::test]
    async fn put_rejects_missing_fields_with_both_zod_issues() {
        let dir = std::env::temp_dir().join(format!("frs-project-colors-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let (state, _rx) = state_at(&dir);
        let app = router(state);

        for (label, body) in
            [("empty object", json!({})), ("json null", Value::Null)]
        {
            let (status, resp) = put_json(&app, Some("tok"), &body).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{label}");
            assert_eq!(resp["error"], json!("Invalid request"), "{label}");
            let details = resp["details"].as_array().expect("details array");
            assert_eq!(details.len(), 2, "{label}: both fields reported");
            assert_eq!(details[0]["code"], json!("invalid_type"));
            assert_eq!(details[0]["path"], json!(["projectPath"]));
            assert_eq!(details[1]["path"], json!(["color"]));
        }

        std::fs::remove_dir_all(&dir).ok();
    }

    /// VALIDATION, wrong types/nulls/empty/over-limit — one 400 per class,
    /// matching the zod issue codes of the original schema (live-probed,
    /// see module doc / plan A1).
    #[tokio::test]
    async fn put_rejects_null_and_wrong_type_and_empty_and_over_limit() {
        let dir = std::env::temp_dir().join(format!("frs-project-colors-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let (state, _rx) = state_at(&dir);
        let app = router(state);

        // nulls
        let (status, resp) = put_json(
            &app,
            Some("tok"),
            &json!({ "projectPath": null, "color": null }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "nulls");
        assert_eq!(resp["details"][0]["code"], json!("invalid_type"));

        // wrong type
        let (status, resp) = put_json(
            &app,
            Some("tok"),
            &json!({ "projectPath": 42, "color": "#fff" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "wrong type");
        assert_eq!(resp["details"][0]["path"], json!(["projectPath"]));

        // empty strings → too_small
        let (status, resp) = put_json(
            &app,
            Some("tok"),
            &json!({ "projectPath": "", "color": "" }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "empty strings");
        let details = resp["details"].as_array().unwrap();
        assert_eq!(details.len(), 2);
        assert_eq!(details[0]["code"], json!("too_small"));
        assert_eq!(details[1]["code"], json!("too_small"));

        // over the limits → too_big
        let (status, resp) = put_json(
            &app,
            Some("tok"),
            &json!({
                "projectPath": "x".repeat(PROJECT_PATH_MAX + 1),
                "color": "y".repeat(COLOR_MAX + 1),
            }),
        )
        .await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "over limit");
        let details = resp["details"].as_array().unwrap();
        assert_eq!(details.len(), 2);
        assert_eq!(details[0]["code"], json!("too_big"));
        assert_eq!(details[0]["maximum"], json!(PROJECT_PATH_MAX as u64));
        assert_eq!(details[1]["maximum"], json!(COLOR_MAX as u64));

        // non-object body (array) → object-level invalid_type
        let (status, resp) = put_json(&app, Some("tok"), &json!([])).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "array body");
        assert_eq!(resp["details"][0]["expected"], json!("object"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// HAPPY PATH: 200 `{ok:true}`; the color is in `config.json`; an
    /// unrelated pre-existing color key survives; an extra body key is
    /// ignored (zod strips unknown keys)... and the SAME write broadcasts
    /// `sessions.changed` on the shared revision sequence.
    #[tokio::test]
    async fn put_persists_color_and_broadcasts_sessions_changed() {
        let dir = std::env::temp_dir().join(format!("frs-project-colors-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        std::fs::write(
            freshell.join("config.json"),
            serde_json::to_string(&json!({
                "version": 1,
                "settings": {},
                "sessionOverrides": { "claude:s1": { "titleOverride": "KeepMe" } },
                "projectColors": { "/proj/keep": "#123456" }
            }))
            .unwrap(),
        )
        .unwrap();
        let (state, mut rx) = state_at(&dir);
        let app = router(state);

        let (status, resp) = put_json(
            &app,
            Some("tok"),
            &json!({ "projectPath": "/proj/new", "color": "#ff8800", "junk": 1 }),
        )
        .await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(resp, json!({ "ok": true }));

        // On disk: the new color, the pre-existing one, and the unrelated
        // session override all survive.
        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(freshell.join("config.json")).unwrap())
                .unwrap();
        assert_eq!(cfg["projectColors"]["/proj/new"], json!("#ff8800"));
        assert_eq!(cfg["projectColors"]["/proj/keep"], json!("#123456"));
        assert_eq!(
            cfg["sessionOverrides"]["claude:s1"]["titleOverride"],
            json!("KeepMe")
        );

        // Broadcast fired AFTER the persist, revision bumped from 0 to 1.
        let frame = rx.try_recv().expect("a sessions.changed frame");
        let parsed: Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(parsed["type"], json!("sessions.changed"));
        assert_eq!(parsed["revision"], json!(1));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// REVISION MONOTONICITY: two writes produce strictly increasing
    /// revisions (the client treats a stalled revision as no-change —
    /// `App.tsx:1143`). Also proves the second write keeps the first path.
    #[tokio::test]
    async fn put_broadcasts_monotonically_increasing_revisions() {
        let dir = std::env::temp_dir().join(format!("frs-project-colors-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let (state, mut rx) = state_at(&dir);
        let app = router(state);

        for (path, color, expected_rev) in
            [("/proj/a", "#111111", 1u64), ("/proj/b", "#222222", 2u64)]
        {
            let (status, _) = put_json(
                &app,
                Some("tok"),
                &json!({ "projectPath": path, "color": color }),
            )
            .await;
            assert_eq!(status, StatusCode::OK);
            let frame = rx.try_recv().expect("a sessions.changed frame");
            let parsed: Value = serde_json::from_str(&frame).unwrap();
            assert_eq!(parsed["revision"], json!(expected_rev));
        }

        let cfg: Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(cfg["projectColors"]["/proj/a"], json!("#111111"));
        assert_eq!(cfg["projectColors"]["/proj/b"], json!("#222222"));

        std::fs::remove_dir_all(&dir).ok();
    }

    /// 500 SURFACING: a config directory Rust cannot write to fails the
    /// request (the legacy route AWAITS the save → a failed save is a
    /// failed request; this port can actually encode it). The color change
    /// must NOT be reported as persisted.
    #[cfg(unix)]
    #[tokio::test]
    async fn put_surfaces_a_persist_failure_as_500() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("frs-project-colors-{}", uuid_like()));
        let freshell = dir.join(".freshell");
        std::fs::create_dir_all(&freshell).unwrap();
        // Boot with a writable dir (load seeds config.json), then make it
        // read+execute only so the tmp-file create inside persist fails.
        let (state, mut rx) = state_at(&dir);
        let original_perms = std::fs::metadata(&freshell).unwrap().permissions();
        std::fs::set_permissions(&freshell, std::fs::Permissions::from_mode(0o500)).unwrap();
        let app = router(state);

        let (status, resp) = put_json(
            &app,
            Some("tok"),
            &json!({ "projectPath": "/proj/a", "color": "#111111" }),
        )
        .await;
        assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
        assert!(
            resp["error"].as_str().is_some(),
            "the error envelope must be human-readable: {resp:?}"
        );
        // No broadcast for a failed write.
        assert!(rx.try_recv().is_err(), "no sessions.changed on failure");

        std::fs::set_permissions(&freshell, original_perms).unwrap();
        std::fs::remove_dir_all(&dir).ok();
    }
}
