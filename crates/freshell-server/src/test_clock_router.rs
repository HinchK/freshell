//! HARNESS-14 — the Rust server's test-clock control surface.
//!
//! Five endpoints driving the shared [`freshell_platform::clock`] test
//! clock, mounted by `main.rs` ONLY when `FRESHELL_TEST_CLOCK` enabled the
//! clock at boot — and even then every handler re-checks
//! [`clock::enabled()`], so a future placement mistake can never expose the
//! surface in a normal build (defense in depth; the disabled answer is the
//! same indistinguishable 404 the SPA fallback gives an unmounted `/api/*`
//! route, `main.rs`'s "clean 404" comment).
//!
//! Parity: the legacy server mounts the identical surface from
//! `server/test-clock-router.ts` — same paths, same JSON envelopes, same
//! auth gate (`x-auth-token` header / `freshell-auth` cookie, constant-time
//! compare via [`is_authed`]). A spec can therefore drive either server
//! implementation with one code path.
//!
//! ```text
//! GET  /api/test-clock                 → 200 { ok:true, enabled:true, mode:'live'|'frozen', nowMs, offsetMs }
//! POST /api/test-clock/advance {ms}    → 200 same shape | 400 { ok:false, error:'invalid_advance', message }
//! POST /api/test-clock/freeze          → 200 same shape
//! POST /api/test-clock/resume          → 200 same shape
//! POST /api/test-clock/reset           → 200 same shape
//! (any of the above, no/invalid token) → 401 { "error": "Unauthorized" }
//! (gate off)                           → 404 { "error": "Not found" }
//! ```

use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};

use freshell_platform::clock::{self, ClockSnapshot};

use crate::boot::{is_authed, unauthorized};

/// Shared state for the test-clock router: just the auth token (the clock
/// itself is the process-global `freshell_platform::clock`).
#[derive(Clone)]
pub struct TestClockState {
    pub auth_token: Arc<String>,
}

pub fn router(state: TestClockState) -> Router {
    Router::new()
        .route("/api/test-clock", get(get_clock))
        .route("/api/test-clock/advance", post(post_advance))
        .route("/api/test-clock/freeze", post(post_freeze))
        .route("/api/test-clock/resume", post(post_resume))
        .route("/api/test-clock/reset", post(post_reset))
        .with_state(state)
}

/// The REST field projection of a [`ClockSnapshot`] (camelCase, mirroring
/// the legacy JSON envelope exactly).
fn snapshot_json(snap: ClockSnapshot) -> Value {
    json!({
        "ok": true,
        "enabled": snap.enabled,
        "mode": snap.mode.as_str(),
        "nowMs": snap.now_ms,
        "offsetMs": snap.offset_ms,
    })
}

/// The disabled-gate reject: byte-identical to the legacy catch-all /
/// SPA-fallback "no such route" body, so an off-gate deployment is
/// indistinguishable from one where the surface was never compiled in.
fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "Not found" }))).into_response()
}

/// Uniform pre-handler gate: auth first (401 mirrors every other `/api/*`
/// route), then the enabled check (404 when the clock is off).
fn gate(headers: &HeaderMap, state: &TestClockState) -> Option<Response> {
    if !is_authed(headers, &state.auth_token) {
        return Some(unauthorized());
    }
    if !clock::enabled() {
        return Some(not_found());
    }
    None
}

fn invalid_advance(message: &str) -> Response {
    (
        StatusCode::BAD_REQUEST,
        Json(json!({
            "ok": false,
            "error": "invalid_advance",
            "message": message,
        })),
    )
        .into_response()
}

async fn get_clock(State(state): State<TestClockState>, headers: HeaderMap) -> Response {
    if let Some(reject) = gate(&headers, &state) {
        return reject;
    }
    Json(snapshot_json(clock::snapshot())).into_response()
}

async fn post_advance(
    State(state): State<TestClockState>,
    headers: HeaderMap,
    body: Option<Json<Value>>,
) -> Response {
    if let Some(reject) = gate(&headers, &state) {
        return reject;
    }
    // `req.body || {}` parity with the legacy router: a missing body is
    // validated as `{}`, which then fails the ms check with a useful 400.
    let ms = body
        .and_then(|Json(v)| v.get("ms").and_then(Value::as_i64))
        // as_i64 rejects floats (parity: legacy requires Number.isInteger),
        // strings, and missing keys uniformly.
        .filter(|ms| (0..=clock::MAX_ADVANCE_MS).contains(ms));
    let Some(ms) = ms else {
        return invalid_advance("body.ms must be an integer in [0, MAX_ADVANCE_MS] (31 days)");
    };
    match clock::advance_ms(ms) {
        Ok(snap) => Json(snapshot_json(snap)).into_response(),
        // Unreachable while gated (the gate checked enabled first), but
        // never panic on a control surface.
        Err(_) => not_found(),
    }
}

async fn post_freeze(State(state): State<TestClockState>, headers: HeaderMap) -> Response {
    if let Some(reject) = gate(&headers, &state) {
        return reject;
    }
    match clock::freeze() {
        Ok(snap) => Json(snapshot_json(snap)).into_response(),
        Err(_) => not_found(),
    }
}

async fn post_resume(State(state): State<TestClockState>, headers: HeaderMap) -> Response {
    if let Some(reject) = gate(&headers, &state) {
        return reject;
    }
    match clock::resume() {
        Ok(snap) => Json(snapshot_json(snap)).into_response(),
        Err(_) => not_found(),
    }
}

async fn post_reset(State(state): State<TestClockState>, headers: HeaderMap) -> Response {
    if let Some(reject) = gate(&headers, &state) {
        return reject;
    }
    match clock::reset() {
        Ok(snap) => Json(snapshot_json(snap)).into_response(),
        Err(_) => not_found(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::Request;
    use tower::ServiceExt;

    // Serialize + scope the process-global clock override (HARNESS-14).
    use crate::test_clock_gate::TestClockGate as OverrideGuard;

    fn app() -> Router {
        router(TestClockState {
            auth_token: Arc::new("tok".to_string()),
        })
    }

    async fn call(
        method: &str,
        uri: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut req = Request::builder().method(method).uri(uri);
        // Only a present body carries a JSON content-type: axum's
        // `Option<Json<Value>>` tolerates a MISSING content-type but rejects
        // a json-typed EMPTY body before the handler ever runs (400
        // plain-text), which would preempt this router's own 400 envelope.
        if body.is_some() {
            req = req.header("content-type", "application/json");
        }
        if let Some(token) = token {
            req = req.header("x-auth-token", token);
        }
        let resp = app()
            .oneshot(
                req.body(match body {
                    Some(v) => Body::from(v.to_string()),
                    None => Body::empty(),
                })
                .unwrap(),
            )
            .await
            .unwrap();
        let status = resp.status();
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        let json = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or_else(|e| {
                panic!(
                    "unparseable response body for {method} {uri}: {e}; raw={:?}",
                    String::from_utf8_lossy(&bytes)
                )
            })
        };
        (status, json)
    }

    #[tokio::test]
    async fn unauthenticated_requests_are_401_before_any_gate_logic() {
        // No override needed: auth precedes the enabled check, so every
        // verb rejects first — even in a production (gate-off) process.
        for (method, uri) in [
            ("GET", "/api/test-clock"),
            ("POST", "/api/test-clock/advance"),
            ("POST", "/api/test-clock/freeze"),
            ("POST", "/api/test-clock/resume"),
            ("POST", "/api/test-clock/reset"),
        ] {
            let (status, body) = call(method, uri, None, None).await;
            assert_eq!(status, StatusCode::UNAUTHORIZED, "{method} {uri}");
            assert_eq!(body, json!({ "error": "Unauthorized" }));
        }
    }

    #[tokio::test]
    async fn gate_off_every_verb_is_an_indistinguishable_404() {
        let _guard = OverrideGuard::locked(false);
        for (method, uri) in [
            ("GET", "/api/test-clock"),
            ("POST", "/api/test-clock/advance"),
            ("POST", "/api/test-clock/freeze"),
            ("POST", "/api/test-clock/resume"),
            ("POST", "/api/test-clock/reset"),
        ] {
            let (status, body) = call(method, uri, Some("tok"), None).await;
            assert_eq!(status, StatusCode::NOT_FOUND, "{method} {uri}");
            assert_eq!(body, json!({ "error": "Not found" }));
        }
    }

    #[tokio::test]
    async fn get_reports_enabled_live_state() {
        let _guard = OverrideGuard::locked(true);
        let (status, body) = call("GET", "/api/test-clock", Some("tok"), None).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["ok"], json!(true));
        assert_eq!(body["enabled"], json!(true));
        assert_eq!(body["mode"], json!("live"));
        assert_eq!(body["offsetMs"], json!(0));
        let now_ms = body["nowMs"].as_i64().expect("nowMs integer");
        let real = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert!((now_ms - real).abs() < 5_000);
    }

    #[tokio::test]
    async fn advance_freeze_resume_reset_round_trip_over_http() {
        let _guard = OverrideGuard::locked(true);

        let (s, b) = call(
            "POST",
            "/api/test-clock/advance",
            Some("tok"),
            Some(json!({ "ms": 90_000 })),
        )
        .await;
        assert_eq!((s, b["offsetMs"].as_i64()), (StatusCode::OK, Some(90_000)));

        let (s, b) = call("POST", "/api/test-clock/freeze", Some("tok"), None).await;
        assert_eq!((s, b["mode"].as_str()), (StatusCode::OK, Some("frozen")));
        let held = b["nowMs"].as_i64().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        let (_, b2) = call("GET", "/api/test-clock", Some("tok"), None).await;
        assert_eq!(
            b2["nowMs"].as_i64(),
            Some(held),
            "frozen time must not move"
        );

        let (s, b) = call("POST", "/api/test-clock/resume", Some("tok"), None).await;
        assert_eq!((s, b["mode"].as_str()), (StatusCode::OK, Some("live")));
        assert!(
            (b["nowMs"].as_i64().unwrap() - held).abs() < 1_000,
            "no jump on resume"
        );

        let (s, b) = call("POST", "/api/test-clock/reset", Some("tok"), None).await;
        assert_eq!(s, StatusCode::OK);
        assert_eq!(b["offsetMs"], json!(0));
        assert_eq!(b["mode"], json!("live"));
    }

    #[tokio::test]
    async fn advance_rejects_invalid_bodies_with_400_and_no_mutation() {
        let _guard = OverrideGuard::locked(true);
        for body in [
            json!({ "ms": -1 }),
            json!({ "ms": 1.5 }),
            json!({ "ms": "60000" }),
            json!({ "ms": clock::MAX_ADVANCE_MS + 1 }),
            json!({}),
            json!("hello"),
        ] {
            let (status, body) =
                call("POST", "/api/test-clock/advance", Some("tok"), Some(body)).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
            assert_eq!(body["error"], json!("invalid_advance"));
            assert!(body["message"].is_string());
        }
        // No body at all: also a 400 (never a handler panic).
        let (status, _) = call("POST", "/api/test-clock/advance", Some("tok"), None).await;
        assert_eq!(status, StatusCode::BAD_REQUEST);
        // Nothing mutated.
        let (_, b) = call("GET", "/api/test-clock", Some("tok"), None).await;
        assert_eq!(b["offsetMs"], json!(0));
    }
}
