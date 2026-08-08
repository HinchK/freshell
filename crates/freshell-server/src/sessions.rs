//! `/api/sessions/:sessionId` — session rename/archive/delete overrides and
//! AI/first-message title generation. Faithful port of the write half of
//! `server/sessions-router.ts` (`PATCH` :122-165, `POST generate-title` :167-210),
//! backed by `SettingsStore::patch_session_override`. The REVERSE terminal-cascade
//! rename (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`) IS
//! implemented in `patch_session` below: a rename of a session currently running
//! in a LIVE terminal (`TerminalIdentityRegistry::find_by_session`) rewrites that
//! terminal's own override, write-throughs the in-memory registry title, and
//! broadcasts `terminals.changed`, echoing the real terminal id as
//! `cascadedTerminalId` (`null` only when no live terminal matches). Proven by
//! `patch_rename_cascades_all_four_effects_to_a_live_terminal` and
//! `patch_rename_to_a_retired_terminal_identity_does_not_cascade` below.

use std::sync::Arc;

use axum::{
    extract::{Path as AxumPath, Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{patch, post},
    Json, Router,
};
use serde_json::{json, Value};

use crate::boot::{is_authed, unauthorized};
use crate::settings_store::SettingsStore;

/// Shared state for the `/api/sessions` write surface.
#[derive(Clone)]
pub struct SessionsState {
    pub auth_token: Arc<String>,
    pub settings: SettingsStore,
    /// Fix Spec: Session Naming Cluster (SYMPTOM 2a reverse direction) — the
    /// shared terminal identity registry, read here to cascade a session rename
    /// to the terminal currently running it (`cascadeSessionRenameToTerminal`,
    /// `rename-cascade.ts:39-50`). Uses `.list()` (live-only) via
    /// `find_by_session`, matching `deps.terminalMetadata.list()`
    /// (`sessions-router.ts:149`) — an already-exited terminal is NOT retitled by
    /// a session rename (only the forward direction survives exit).
    pub identity: freshell_ws::identity::TerminalIdentityRegistry,
    /// The shared terminal registry, so a successful reverse cascade can
    /// write-through the live title the same way the terminals PATCH route does
    /// (`deps.registry?.updateTitle(cascadedTerminalId, cleanTitle)`,
    /// `sessions-router.ts:155`), and the shared broadcast bus + revision counter
    /// so `terminals.changed` fires (`sessions-router.ts:156`).
    pub registry: freshell_terminal::TerminalRegistry,
    pub broadcast_tx: Arc<tokio::sync::broadcast::Sender<String>>,
    pub terminals_revision: Arc<std::sync::atomic::AtomicI64>,
    /// GAP-1 fix (reviewer Important, SESSION-09 follow-up): the shared
    /// `sessions.changed` revision counter (the SAME `Arc<AtomicI64>` as
    /// `freshell_ws::WsState::sessions_revision` and
    /// `FreshAgentState`'s, unified in commit b068d28b), wired here so a
    /// rename/archive/delete OVERRIDE write can broadcast directly instead
    /// of relying on the periodic session-directory sweep
    /// (`spawn_sessions_sweep`, `main.rs`) -- that sweep's `(count, max
    /// lastActivityAt)` signature is structurally blind to override-only
    /// changes (`IndexedSession` carries no archived/title-override
    /// fields), so an archive/rename toggle would otherwise never trip a
    /// broadcast. Legacy parity: `SessionsSyncService`'s differ
    /// (`hasSessionDirectorySnapshotChange`, `projection.ts:23`) diffs the
    /// FULL comparable snapshot -- including `archived`/`title` -- on
    /// every `codingCliIndexer.refresh()` call, which the legacy PATCH
    /// route always triggers.
    pub sessions_revision: Arc<std::sync::atomic::AtomicI64>,
    /// Task 6: the process-local Gemini key cell -- `generate_title` gates its
    /// AI branch on key presence ONLY, never on
    /// `settings.sidebar.autoGenerateTitles` (that gate belongs exclusively to
    /// the background sweep; real Node asymmetry, Scope Decision 7,
    /// `sessions-router.ts:181-184`).
    pub ai_key: crate::ai_title::AiKeyCell,
    /// Trait-injected Gemini transport (same seam as
    /// `AutoTitleSweepState.gemini`) so tests fake the wire -- no live calls.
    pub gemini: Arc<dyn crate::ai_title::GeminiTransport>,
    /// The shared session index, consulted ONLY for the provider-generated
    /// short-circuit (`sessions-router.ts:186-192`). `None` when no provider
    /// home resolves (the same `Option` main.rs threads everywhere else).
    pub index: Option<Arc<freshell_sessions::directory_index::SessionIndex>>,
}

/// The sessions sub-router (`PATCH /api/sessions/:id` + `POST .../generate-title`).
pub fn router(state: SessionsState) -> Router {
    Router::new()
        .route("/api/sessions/{session_id}", patch(patch_session))
        .route(
            "/api/sessions/{session_id}/generate-title",
            post(generate_title),
        )
        .with_state(state)
}

/// `rawId.includes(':') ? rawId : makeSessionKey(provider, rawId)` — the axum
/// path extractor already percent-decodes, so `codex%3Axyz` arrives as `codex:xyz`.
fn composite_key(raw: &str, provider: &str) -> String {
    if raw.contains(':') {
        raw.to_string()
    } else {
        format!("{provider}:{raw}")
    }
}

fn provider_of(q: &std::collections::HashMap<String, String>) -> String {
    q.get("provider")
        .filter(|s| !s.is_empty())
        .cloned()
        .unwrap_or_else(|| "claude".into())
}

/// `cleanString` (`server/utils.ts`): trim; empty/whitespace/absent/null → clear.
fn clean_string(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// `PATCH /api/sessions/:sessionId` — validate the `SessionPatchSchema` body,
/// build the JS-spread patch tuple list, persist via
/// `SettingsStore::patch_session_override`, and respond with the merged
/// override plus the always-`null` `cascadedTerminalId` (the terminal-cascade
/// rename is out of scope for this port).
async fn patch_session(
    State(state): State<SessionsState>,
    AxumPath(raw_id): AxumPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // SessionPatchSchema shape validation (sessions-router.ts:31-63):
    // titleOverride/summaryOverride: string|null; archived/deleted: bool;
    // createdAtOverride: number. Any wrong type → 400 {error:"Invalid request",details:[...]}.
    if let Some(details) = validate_session_patch(&body) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Invalid request", "details": details })),
        )
            .into_response();
    }
    let key = composite_key(&raw_id, &provider_of(&q));

    let title = clean_string(body.get("titleOverride"));
    let mut patch: Vec<(&str, Option<Value>)> = Vec::new();
    if body.get("titleOverride").is_some() {
        patch.push(("titleOverride", title.clone().map(Value::from)));
        // titleSource:'user' only when a non-empty title is present (sessions-router.ts:132-133).
        if title.is_some() {
            patch.push(("titleSource", Some(json!("user"))));
        }
    }
    if body.get("summaryOverride").is_some() {
        patch.push((
            "summaryOverride",
            clean_string(body.get("summaryOverride")).map(Value::from),
        ));
    }
    if let Some(a) = body.get("archived") {
        patch.push(("archived", Some(a.clone())));
    }
    if let Some(d) = body.get("deleted") {
        patch.push(("deleted", Some(d.clone())));
    }
    if let Some(c) = body.get("createdAtOverride") {
        patch.push(("createdAtOverride", Some(c.clone())));
    }

    let merged = state.settings.patch_session_override(&key, &patch).await;
    let mut out = merged.as_object().cloned().unwrap_or_default();

    // Cascade: if this session is running in a LIVE terminal, also rename the
    // terminal (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`,
    // driven from `sessions-router.ts:140-161`). `key` is always `provider:id`
    // (`composite_key` above guarantees the separator), so splitting on the
    // FIRST `:` recovers `(sessionProvider, sessionId)` exactly like the
    // original's `parts[0]` / `parts.slice(1).join(':')`.
    let mut cascaded_terminal_id: Option<String> = None;
    if let Some(clean_title) = &title {
        if let Some((session_provider, session_id)) = key.split_once(':') {
            if let Some(matched) = state.identity.find_by_session(session_provider, session_id) {
                state
                    .settings
                    .patch_terminal_override(
                        &matched.terminal_id,
                        &[("titleOverride", Some(Value::from(clean_title.clone())))],
                    )
                    .await;
                state
                    .registry
                    .update_title(&matched.terminal_id, clean_title);
                let revision = state
                    .terminals_revision
                    .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                    + 1;
                let frame =
                    json!({ "type": "terminals.changed", "revision": revision }).to_string();
                let _ = state.broadcast_tx.send(frame);
                cascaded_terminal_id = Some(matched.terminal_id);
            }
        }
    }
    out.insert(
        "cascadedTerminalId".into(),
        cascaded_terminal_id.map(Value::from).unwrap_or(Value::Null),
    );

    // GAP-1 fix: broadcast `sessions.changed` directly for this override
    // write, rather than relying on the periodic session-directory sweep
    // (which is structurally blind to override-only changes -- see the
    // `sessions_revision` field doc comment on `SessionsState` above).
    // Guarded on a non-empty patch: an empty body (no recognized fields) is
    // schema-valid but performs no actual write, so nothing changed to
    // broadcast. Emitted AFTER the terminal cascade (if any) so a rename
    // that also cascades produces `terminals.changed` before
    // `sessions.changed`, preserving the existing cascade test's
    // single-`try_recv()` assumption.
    if !patch.is_empty() {
        broadcast_sessions_changed_from(&state);
    }

    Json(Value::Object(out)).into_response()
}

/// The one `sessions.changed` emit site (revision bump + frame send), factored
/// from `patch_session` so the generate-title write paths (heuristic + AI)
/// share it exactly (D11: Node reaches the equivalent broadcast via
/// `codingCliIndexer.refresh()` -> sessionsSync publish).
fn broadcast_sessions_changed_from(state: &SessionsState) {
    let revision = state
        .sessions_revision
        .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        + 1;
    let frame = json!({ "type": "sessions.changed", "revision": revision }).to_string();
    let _ = state.broadcast_tx.send(frame);
}

/// Snapshot the shared index (same accessor as the sweeps) and find the
/// session whose `provider:sessionId` key equals `key`.
async fn lookup_indexed_session(
    index: &freshell_sessions::directory_index::SessionIndex,
    key: &str,
) -> Option<freshell_sessions::directory_index::IndexedSession> {
    let items = index.snapshot().await;
    items.iter().find(|s| s.key() == key).cloned()
}

/// Faithful subset of `SessionPatchSchema` — returns zod-shaped `details` on a
/// type violation, `None` when the body is valid.
///
/// **Note on details shape:** the legacy body validator emits zod v4 `issues`.
/// The exact `details` wording for session-patch type errors was not captured
/// in the investigation reports; this emits shapes consistent with the
/// session-directory validator style. Not claimed byte-exact.
fn validate_session_patch(body: &Value) -> Option<Value> {
    let Value::Object(map) = body else {
        return Some(json!([{
            "code": "invalid_type",
            "expected": "object",
            "path": [],
            "message": "Invalid input: expected object"
        }]));
    };
    let mut issues: Vec<Value> = Vec::new();
    let str_or_null = |k: &str, issues: &mut Vec<Value>| {
        if let Some(v) = map.get(k) {
            if !v.is_string() && !v.is_null() {
                issues.push(json!({
                    "code": "invalid_type",
                    "expected": "string",
                    "path": [k],
                    "message": "Invalid input: expected string"
                }));
            }
        }
    };
    let bool_field = |k: &str, issues: &mut Vec<Value>| {
        if let Some(v) = map.get(k) {
            if !v.is_boolean() {
                issues.push(json!({
                    "code": "invalid_type",
                    "expected": "boolean",
                    "path": [k],
                    "message": "Invalid input: expected boolean"
                }));
            }
        }
    };
    str_or_null("titleOverride", &mut issues);
    str_or_null("summaryOverride", &mut issues);
    bool_field("archived", &mut issues);
    bool_field("deleted", &mut issues);
    if let Some(v) = map.get("createdAtOverride") {
        if !v.is_number() {
            issues.push(json!({
                "code": "invalid_type",
                "expected": "number",
                "path": ["createdAtOverride"],
                "message": "Invalid input: expected number"
            }));
        }
    }
    if issues.is_empty() {
        None
    } else {
        Some(Value::Array(issues))
    }
}

/// `extractTitleFromMessage` (`shared/title-utils.ts:9-30`): maxLen 50;
/// multi-line -> first non-empty line (trimmed + whitespace-collapsed);
/// single-line -> trim + collapse whitespace, then truncate to `max_len`.
fn extract_title_from_message(content: &str, max_len: usize) -> String {
    let collapse = |s: &str| s.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = if content.contains('\n') {
        match content.lines().find(|l| !l.trim().is_empty()) {
            Some(first) => collapse(first.trim()),
            None => return String::new(),
        }
    } else {
        collapse(content.trim())
    };
    cleaned.chars().take(max_len).collect()
}

/// `POST /api/sessions/:sessionId/generate-title` — a blank `firstMessage` is
/// the only 400 this emits (`sessions-router.ts:167-179`); everything else
/// resolves to `200`, never `5xx` (Global Constraint 8). Resolution order
/// (`sessions-router.ts:180-221`): (1) a parsed session whose `titleSource` is
/// `provider-generated` short-circuits with the parsed title — NO write, no
/// broadcast; (2) no AI key → the first-message heuristic, persisted through
/// the title-source ladder; (3) key present → Gemini via the injected
/// transport, persisted as `titleSource:'ai'` through the ladder (`Ok(None)`
/// → `{title:null,source:'none'}` with no write; `Err` → 200
/// `{title:null,source:'none',error}` with no write). Deliberately NOT gated
/// on `settings.sidebar.autoGenerateTitles` (real Node asymmetry, Scope
/// Decision 7) — key presence alone selects the AI branch. Both write paths
/// broadcast `sessions.changed` after the write (D11: Node reaches this via
/// `codingCliIndexer.refresh()`), and both respond with the STORED
/// (ladder-resolved) title/source — faithfully reflecting a ladder-blocked
/// write (`sessions-router.ts:185-190`).
async fn generate_title(
    State(state): State<SessionsState>,
    AxumPath(raw_id): AxumPath<String>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    let first_message = body
        .get("firstMessage")
        .and_then(Value::as_str)
        .unwrap_or("");
    if first_message.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "firstMessage is required" })),
        )
            .into_response();
    }
    let key = composite_key(&raw_id, &provider_of(&q));

    // (1) provider-generated short-circuit (`sessions-router.ts:186-192`): a
    // session whose PARSED title is provider-authored is never renamed by
    // this route -- echo the parsed title; no write, no broadcast.
    if let Some(index) = &state.index {
        if let Some(parsed) = lookup_indexed_session(index, &key).await {
            if parsed.title_source.as_deref() == Some("provider-generated") {
                return Json(json!({
                    "title": parsed.title.clone().map(Value::from).unwrap_or(Value::Null),
                    "source": "provider-generated",
                }))
                .into_response();
            }
        }
    }

    if !state.ai_key.enabled() {
        // (2) AI disabled: the first-message heuristic (`sessions-router.ts:196-209`).
        let heuristic = extract_title_from_message(first_message, 50);
        if heuristic.is_empty() {
            return Json(json!({ "title": null, "source": "none" })).into_response();
        }
        let stored = state
            .settings
            .patch_session_override(
                &key,
                &[
                    ("titleOverride", Some(json!(heuristic))),
                    ("titleSource", Some(json!("first-message"))),
                ],
            )
            .await;
        broadcast_sessions_changed_from(&state);
        // Respond with the STORED (ladder-resolved) value, faithfully.
        let title = stored.get("titleOverride").cloned().unwrap_or(Value::Null);
        let source = stored.get("titleSource").cloned().unwrap_or(json!("none"));
        Json(json!({ "title": title, "source": source })).into_response()
    } else {
        // (3) AI enabled -- key presence ONLY (Scope Decision 7; the
        // `autoGenerateTitles` toggle never gates this route).
        let custom_prompt = state.settings.get().await.ai.title_prompt;
        match crate::ai_title::generate_ai_session_title(
            &*state.gemini,
            first_message,
            custom_prompt.as_deref(),
        )
        .await
        {
            Ok(None) => Json(json!({ "title": null, "source": "none" })).into_response(),
            Ok(Some(title)) => {
                let stored = state
                    .settings
                    .patch_session_override(
                        &key,
                        &[
                            ("titleOverride", Some(json!(title))),
                            ("titleSource", Some(json!("ai"))),
                        ],
                    )
                    .await;
                broadcast_sessions_changed_from(&state);
                Json(json!({
                    "title": stored.get("titleOverride").cloned().unwrap_or(Value::Null),
                    "source": stored.get("titleSource").cloned().unwrap_or(Value::Null),
                }))
                .into_response()
            }
            Err(e) => Json(json!({ "title": null, "source": "none", "error": e })).into_response(),
        }
    }
}

#[cfg(test)]
mod tests {
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    fn state(dir: &std::path::Path) -> super::SessionsState {
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        super::SessionsState {
            auth_token: std::sync::Arc::new("tok".into()),
            settings: crate::settings_store::SettingsStore::load(Some(dir), vec!["claude".into()]),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            // AI disabled by default; tests that exercise the AI branch
            // overwrite these fields (the no-key path never touches gemini).
            ai_key: crate::ai_title::AiKeyCell::init(None, None),
            gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
            index: None,
        }
    }

    async fn body_json(resp: axum::response::Response) -> serde_json::Value {
        let bytes = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn patch_rename_persists_and_returns_merged_plus_cascade_null() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"My Title"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["titleOverride"], serde_json::json!("My Title"));
        assert_eq!(v["titleSource"], serde_json::json!("user"));
        assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Registers a REAL (but throwaway, immediately killable) terminal in the
    /// shared `TerminalRegistry` so the reverse cascade's registry
    /// write-through (`registry.update_title`) has an actual entry to mutate.
    /// `TerminalRegistry::insert_headless` (used by `freshell-terminal`'s own
    /// unit tests to avoid a real spawn) is private to that crate's test
    /// module, so this port spawns a minimal `sleep` child instead -- the
    /// caller is responsible for `registry.kill(terminal_id)` afterward.
    fn spawn_headless_terminal_for_test(
        registry: &freshell_terminal::TerminalRegistry,
        terminal_id: &str,
    ) {
        use freshell_platform::spawn::{SpawnSpec, DEFAULT_COLS, DEFAULT_ROWS};
        let spec = SpawnSpec {
            program: "/bin/sh".into(),
            args: vec!["-c".into(), "sleep 5".into()],
            env_overrides: Default::default(),
            cwd: None,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
        };
        registry
            .create(
                &spec,
                &std::collections::BTreeMap::new(),
                terminal_id.to_string(),
                "stream-test".to_string(),
                "shell",
                None,
                None,
                None,
            )
            .expect("spawn headless test terminal");
    }

    /// Reviewer finding (Important, commit d5cf534a): the REVERSE rename
    /// cascade (`cascadeSessionRenameToTerminal`, `rename-cascade.ts:39-50`,
    /// implemented in `patch_session` above) had ZERO positive-match test
    /// coverage -- reverting the entire cascade block still left all prior
    /// tests green, since they only covered the no-match case. This proves
    /// all FOUR effects a live match must produce: (a) the terminal's OWN
    /// override is written with the new title, (b) the in-memory registry
    /// title is updated (write-through, not just the on-disk override), (c) a
    /// `terminals.changed` broadcast fires, and (d) the response echoes the
    /// REAL `cascadedTerminalId` (not the always-null placeholder a prior
    /// version of this router emitted).
    #[tokio::test]
    async fn patch_rename_cascades_all_four_effects_to_a_live_terminal() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);

        // A terminal currently running `claude:sess-live` (the session key
        // this PATCH targets) -- `find_by_session` needs a LIVE (non-retired)
        // match, and the registry write-through needs a REAL registered
        // terminal_id (`update_title` is a no-op against an unknown id).
        st.identity
            .upsert("term-live", Some("claude"), Some("sess-live"), None, 1000);
        spawn_headless_terminal_for_test(&st.registry, "term-live");

        // Subscribe BEFORE the PATCH so the `terminals.changed` send lands in
        // this receiver's buffer.
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/sess-live?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"Renamed From Session"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;

        // (d) the REAL cascadedTerminalId, not null.
        assert_eq!(
            v["cascadedTerminalId"],
            serde_json::json!("term-live"),
            "response must echo the live terminal's id, not null"
        );

        // (a) the terminal's OWN override was written with the new title.
        let terminal_overrides = st.settings.terminal_overrides();
        let term_override = terminal_overrides
            .get("term-live")
            .expect("terminal override written by the reverse cascade");
        assert_eq!(
            term_override["titleOverride"],
            serde_json::json!("Renamed From Session")
        );

        // (b) the in-memory registry title was updated (write-through, not
        // just the on-disk override).
        let entry = st
            .registry
            .directory()
            .into_iter()
            .find(|e| e.terminal_id == "term-live")
            .expect("terminal present in the registry directory");
        assert_eq!(entry.title, "Renamed From Session");

        // (c) a `terminals.changed` broadcast fired.
        let frame = broadcast_rx
            .try_recv()
            .expect("terminals.changed broadcast fired");
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["type"], serde_json::json!("terminals.changed"));

        st.registry.kill("term-live");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The reverse cascade's terminal lookup is LIVE-only (`.list()` via
    /// `find_by_session`, matching `deps.terminalMetadata.list()`,
    /// `sessions-router.ts:149`): a RETIRED (already-exited) terminal's
    /// session can still be renamed through this route, but the rename does
    /// NOT reach back into the exited terminal -- `cascadedTerminalId` stays
    /// `null`. This pins the live-only semantic against the OPPOSITE
    /// (terminal -> session) direction's `.get()`-based
    /// `rename_cascades_even_after_the_terminal_has_exited` test in
    /// `terminals.rs`, which deliberately DOES still cascade for a retired
    /// terminal -- the two directions are asymmetric on purpose.
    #[tokio::test]
    async fn patch_rename_to_a_retired_terminal_identity_does_not_cascade() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);

        st.identity.upsert(
            "term-exited",
            Some("claude"),
            Some("sess-exited"),
            None,
            1000,
        );
        st.identity.retire("term-exited");

        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/sess-exited?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"Renamed After Exit"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;

        assert_eq!(v["cascadedTerminalId"], serde_json::Value::Null);
        assert_eq!(
            v["titleOverride"],
            serde_json::json!("Renamed After Exit"),
            "the session override itself still lands -- only the reach-back to the terminal is skipped"
        );
        assert!(
            st.settings.terminal_overrides().is_empty(),
            "no terminal override should be fabricated for a retired terminal"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// GAP-1 fix (reviewer Important, SESSION-09 follow-up): the periodic
    /// session-directory sweep (`spawn_sessions_sweep`, `main.rs`) is
    /// structurally blind to override-only changes -- its `(count, max
    /// lastActivityAt)` signature never moves for a title-override write,
    /// since `IndexedSession` carries no override fields at all. Legacy
    /// broadcasts `sessions.changed` on ANY sidebar-visible change (its
    /// differ, `projection.ts:23`, diffs the full comparable snapshot
    /// including `title`), so THIS write site must broadcast directly.
    /// Proves a rename PATCH produces exactly one `sessions.changed` frame
    /// with a positive, monotonic revision.
    #[tokio::test]
    async fn patch_rename_broadcasts_sessions_changed_with_increased_revision() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);

        // Subscribe BEFORE the PATCH so the `sessions.changed` send lands in
        // this receiver's buffer.
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let app = super::router(st.clone());
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"titleOverride":"Renamed Session"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the rename override write");
        let frame: serde_json::Value = serde_json::from_str(&frame).unwrap();
        assert_eq!(frame["type"], serde_json::json!("sessions.changed"));
        let revision = frame["revision"].as_i64().expect("revision is a number");
        assert!(revision > 0, "revision must be a positive counter value");

        // Exactly one frame -- no duplicate/extra broadcast for a plain
        // rename (no live-terminal cascade in play here).
        assert!(
            broadcast_rx.try_recv().is_err(),
            "exactly one broadcast frame expected for a plain rename PATCH"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    /// Companion to the rename case above: an archive toggle is exactly the
    /// kind of sidebar-visible, sweep-invisible change GAP-1 covers (the
    /// reviewer's own example). Also proves the revision counter is shared
    /// across successive PATCHes (strictly increasing, not reset per call).
    #[tokio::test]
    async fn patch_archive_broadcasts_sessions_changed_and_revision_is_monotonic() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);
        let mut broadcast_rx = st.broadcast_tx.subscribe();

        let app = super::router(st.clone());
        let resp = app
            .clone()
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let first_frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the archive override write");
        let first_frame: serde_json::Value = serde_json::from_str(&first_frame).unwrap();
        let first_revision = first_frame["revision"].as_i64().unwrap();

        // A second override write on the SAME state must bump the counter
        // further (shared, monotonic sequence -- not reset per request).
        let resp2 = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc123?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":false}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp2.status(), StatusCode::OK);
        let second_frame = broadcast_rx
            .try_recv()
            .expect("sessions.changed broadcast fired for the second override write");
        let second_frame: serde_json::Value = serde_json::from_str(&second_frame).unwrap();
        let second_revision = second_frame["revision"].as_i64().unwrap();

        assert!(
            second_revision > first_revision,
            "revision must strictly increase across successive override writes"
        );

        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_requires_auth() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/abc")
                    .header("content-type", "application/json")
                    .body(Body::from("{}"))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn patch_url_encoded_composite_key_is_decoded() {
        // A raw id already containing ':' (url-encoded %3A) is used verbatim.
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("PATCH")
                    .uri("/api/sessions/codex%3Axyz")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"archived":true}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let cfg: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(dir.join(".freshell").join("config.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(
            cfg["sessionOverrides"]["codex:xyz"]["archived"],
            serde_json::json!(true)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_blank_first_message_is_400() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"   "}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        let v = body_json(resp).await;
        assert_eq!(v["error"], serde_json::json!("firstMessage is required"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_no_key_uses_first_message_heuristic() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"firstMessage":"Fix the login bug\nmore detail"}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("Fix the login bug")); // first non-empty line
        assert_eq!(v["source"], serde_json::json!("first-message"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_after_user_rename_is_ladder_blocked() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let st = state(&dir);
        // Pre-seed a user rename (rank 5).
        st.settings
            .patch_session_override(
                "claude:abc",
                &[
                    ("titleOverride", Some(serde_json::json!("User Named"))),
                    ("titleSource", Some(serde_json::json!("user"))),
                ],
            )
            .await;
        let app = super::router(st);
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"firstMessage":"Some prompt"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        // first-message (3) cannot upgrade user (5): store keeps the user title; the
        // response reflects the STORED (merged) value, faithfully (sessions-router.ts:185-190).
        assert_eq!(v["title"], serde_json::json!("User Named"));
        assert_eq!(v["source"], serde_json::json!("user"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn generate_title_multiline_takes_first_nonempty_line_truncated() {
        let dir = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        std::fs::create_dir_all(dir.join(".freshell")).unwrap();
        let app = super::router(state(&dir));
        let long_line = "a".repeat(80);
        let first_message = format!("\n   \n{long_line}\nsecond line");
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/sessions/abc/generate-title")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "firstMessage": first_message }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["title"], serde_json::json!("a".repeat(50)));
        assert_eq!(v["source"], serde_json::json!("first-message"));
        std::fs::remove_dir_all(&dir).ok();
    }

    /// End-to-end sanity: a PATCH through THIS router persists a
    /// `sessionOverride` that `session_directory`'s overlay (Task 2) then
    /// surfaces on the matching item — the same `SettingsStore` backs both.
    #[tokio::test]
    async fn patch_override_is_visible_through_session_directory_overlay() {
        use axum::http::Request as HttpRequest;

        let home = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        let project = home.join(".claude").join("projects").join("-tmp-proj");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(home.join(".freshell")).unwrap();
        // Inline transcript (not the committed `healthy.jsonl` fixture, which
        // deliberately has no `cwd` and is excluded at discovery, R10b): a
        // `cwd`-bearing, two-user-message session so it survives both the
        // discovery `cwd` requirement and the default `isNonInteractive` filter.
        let content = [
            r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"first prompt"},"timestamp":"2025-01-30T10:00:00.000Z"}"#,
            r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"assistant","message":{"role":"assistant","content":"ack"},"timestamp":"2025-01-30T10:00:01.000Z"}"#,
            r#"{"cwd":"/tmp/proj","sessionId":"healthy-session-id","type":"user","message":{"role":"user","content":"second prompt"},"timestamp":"2025-01-30T10:00:02.000Z"}"#,
        ]
        .join("\n");
        std::fs::write(project.join("healthy-session-id.jsonl"), content).unwrap();

        let settings =
            crate::settings_store::SettingsStore::load(Some(&home), vec!["claude".into()]);
        let auth_token: std::sync::Arc<String> = std::sync::Arc::new("tok".into());

        // Patch title + archived through the sessions router.
        let (tx, _rx) = tokio::sync::broadcast::channel::<String>(16);
        let sessions_app = super::router(super::SessionsState {
            auth_token: std::sync::Arc::clone(&auth_token),
            settings: settings.clone(),
            identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            registry: freshell_terminal::TerminalRegistry::new(),
            broadcast_tx: std::sync::Arc::new(tx),
            terminals_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            sessions_revision: std::sync::Arc::new(std::sync::atomic::AtomicI64::new(0)),
            ai_key: crate::ai_title::AiKeyCell::init(None, None),
            gemini: std::sync::Arc::new(FakeGemini(Err("unused in default test state".into()))),
            index: None,
        });
        let patch_resp = sessions_app
            .oneshot(
                HttpRequest::builder()
                    .method("PATCH")
                    .uri("/api/sessions/healthy-session-id?provider=claude")
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        r#"{"titleOverride":"Overlay Title","archived":true}"#,
                    ))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(patch_resp.status(), StatusCode::OK);

        // Query the session-directory read model with the SAME settings store.
        // Batch B: the read model is backed by a `SessionIndex` now, not a
        // per-request `home: Option<PathBuf>` scan.
        let session_index =
            std::sync::Arc::new(freshell_sessions::directory_index::SessionIndex::new(vec![
                std::sync::Arc::new(freshell_sessions::directory_index::ClaudeSource::new(
                    crate::session_directory::claude_home(&home),
                ))
                    as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>,
            ]));
        let dir_app =
            crate::session_directory::router(crate::session_directory::SessionDirectoryState {
                auth_token: std::sync::Arc::clone(&auth_token),
                settings,
                session_index: Some(session_index),
                identity: freshell_ws::identity::TerminalIdentityRegistry::new(),
            });
        let dir_resp = dir_app
            .oneshot(
                HttpRequest::builder()
                    .method("GET")
                    .uri("/api/session-directory?priority=visible")
                    .header("x-auth-token", "tok")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(dir_resp.status(), StatusCode::OK);
        let page = body_json(dir_resp).await;
        let items = page["items"].as_array().unwrap();
        let item = items
            .iter()
            .find(|i| i["sessionId"] == serde_json::json!("healthy-session-id"))
            .expect("patched session present in directory");
        assert_eq!(item["title"], serde_json::json!("Overlay Title"));
        assert_eq!(item["archived"], serde_json::json!(true));

        std::fs::remove_dir_all(&home).ok();
    }

    /// Same 4-line fake as `auto_title_sweep`'s test transport: the wired-in
    /// result IS the Gemini reply. NO live Gemini calls in tests, ever.
    struct FakeGemini(Result<String, String>);
    impl crate::ai_title::GeminiTransport for FakeGemini {
        fn generate_content(
            &self,
            _p: String,
            _m: u32,
        ) -> crate::ai_title::BoxFuture<Result<String, String>> {
            let r = self.0.clone();
            Box::pin(async move { r })
        }
    }

    /// Oneshots `POST /api/sessions/{sid}/generate-title` with
    /// `{"firstMessage": first}` and the auth header against a router built
    /// from a CLONE of `st` (the caller keeps the original for post-request
    /// assertions on settings/broadcast state).
    async fn post_generate_title(
        st: &super::SessionsState,
        sid: &str,
        first: &str,
    ) -> axum::response::Response {
        super::router(st.clone())
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri(format!("/api/sessions/{sid}/generate-title"))
                    .header("x-auth-token", "tok")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        serde_json::json!({ "firstMessage": first }).to_string(),
                    ))
                    .unwrap(),
            )
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn generate_title_uses_gemini_when_key_present_and_broadcasts_sessions_changed() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = state(dir.path());
        st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
        st.gemini = std::sync::Arc::new(FakeGemini(Ok("  Sardine crash investigation  ".into())));
        let mut rx = st.broadcast_tx.subscribe();
        let sid = uuid_like();
        let resp = post_generate_title(&st, &sid, "investigate the sardine crash").await;
        let body = body_json(resp).await;
        assert_eq!(body["title"], "Sardine crash investigation");
        assert_eq!(body["source"], "ai");
        let row = st
            .settings
            .session_overrides()
            .get(&format!("claude:{sid}"))
            .cloned()
            .unwrap();
        assert_eq!(row["titleSource"], "ai");
        let frames: Vec<String> = std::iter::from_fn(|| rx.try_recv().ok()).collect();
        assert!(frames.iter().any(|f| f.contains("sessions.changed")));
    }

    #[tokio::test]
    async fn generate_title_gemini_error_returns_200_none_with_error_and_no_write() {
        let dir = tempfile::tempdir().unwrap();
        let mut st = state(dir.path());
        st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
        st.gemini = std::sync::Arc::new(FakeGemini(Err("boom".into())));
        let sid = uuid_like();
        let body = body_json(post_generate_title(&st, &sid, "hello").await).await;
        assert_eq!(body["title"], serde_json::Value::Null);
        assert_eq!(body["source"], "none");
        assert_eq!(body["error"], "boom");
        assert!(st
            .settings
            .session_overrides()
            .get(&format!("claude:{sid}"))
            .is_none());
    }

    #[tokio::test]
    async fn generate_title_after_user_rename_is_still_ladder_blocked_for_ai() {
        // AI write attempted, ladder rejects, response echoes the user's stored title.
        let dir = tempfile::tempdir().unwrap();
        let mut st = state(dir.path());
        st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
        st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
        let sid = uuid_like();
        st.settings
            .patch_session_override(
                &format!("claude:{sid}"),
                &[
                    ("titleOverride", Some(serde_json::json!("Mine"))),
                    ("titleSource", Some(serde_json::json!("user"))),
                ],
            )
            .await;
        let body = body_json(post_generate_title(&st, &sid, "hello").await).await;
        assert_eq!(body["title"], "Mine");
        assert_eq!(body["source"], "user");
    }

    /// The provider-generated short-circuit (`sessions-router.ts:186-192`):
    /// a session whose PARSED title is provider-authored is never renamed by
    /// this route -- the parsed title is echoed with NO override write, even
    /// with an AI key present and a transport that WOULD return a title. The
    /// index fixture is the committed claude `real-corrupted.jsonl` (its
    /// `type:'summary'` record marks the parsed title provider-generated --
    /// proven by directory_index.rs's
    /// `indexed_session_carries_first_user_message_and_provider_generated_title_source`;
    /// opencode sessions can never be provider-generated), seeded the same
    /// way `patch_override_is_visible_through_session_directory_overlay`
    /// above builds its `SessionIndex`.
    #[tokio::test]
    async fn generate_title_provider_generated_short_circuits_without_write() {
        let home = std::env::temp_dir().join(format!("frs-sess-router-{}", uuid_like()));
        let project = home.join(".claude").join("projects").join("-p");
        std::fs::create_dir_all(&project).unwrap();
        std::fs::create_dir_all(home.join(".freshell")).unwrap();
        let fixture = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/sessions/real-corrupted.jsonl");
        std::fs::copy(&fixture, project.join("real-corrupted.jsonl")).unwrap();

        let mut st = state(&home);
        st.ai_key = crate::ai_title::AiKeyCell::init(Some("k".into()), None);
        st.gemini = std::sync::Arc::new(FakeGemini(Ok("AI Title".into())));
        st.index = Some(std::sync::Arc::new(
            freshell_sessions::directory_index::SessionIndex::new(vec![std::sync::Arc::new(
                freshell_sessions::directory_index::ClaudeSource::new(
                    crate::session_directory::claude_home(&home),
                ),
            )
                as std::sync::Arc<dyn freshell_sessions::directory_index::SessionSource>]),
        ));
        let sid = "b7936c10-4935-441c-837c-c1f33cafec2d"; // the fixture's sessionId
        let body = body_json(post_generate_title(&st, sid, "hello").await).await;
        assert_eq!(body["title"], "Test Session 1"); // the fixture's parsed summary title
        assert_eq!(body["source"], "provider-generated");
        assert!(st
            .settings
            .session_overrides()
            .get(&format!("claude:{sid}"))
            .is_none());
        std::fs::remove_dir_all(&home).ok();
    }

    fn uuid_like() -> String {
        format!("{}-{:?}", std::process::id(), std::time::SystemTime::now())
            .replace([':', '.', ' '], "-")
    }
}
