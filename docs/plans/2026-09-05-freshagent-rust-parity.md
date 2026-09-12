# Fresh-Agent Rust Parity (attachments, diff/exec, per-send settings) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix three fresh-agent parity bugs on the Rust server, tracked as kata items te1m, ekc6, and z7j7:
1. te1m: the fresh-agent composer attachment upload fails because the Rust server has no `POST /api/fresh-agent/attachments` route. Implement it with the retired Node server's behavior (request/response shape, size limits, error codes) as the contract, and make the composer surface failures visibly instead of silently.
2. ekc6: the transcript "view diff" panel fails because the Rust server has no `GET /api/fresh-agent/diff` route. Port it (and check the AGENT-13 exec endpoints for the same gap) using the Node route as the response-shape oracle, and show clear inline errors in the panel instead of spinning forever.
3. z7j7: mid-session model/effort/sandbox/permission-mode changes are parsed and silently discarded on the Rust server. Apply per-send selections at send time for every provider that supports mid-session changes (capability-gated where not), with wire-contract-safe frames; where a provider genuinely cannot honor a mid-session change, the UI must say so at selection time instead of silently ignoring it.

### Explicit constraints
- Node server behavior is the contract/oracle for request/response shapes, size limits, and error codes; server tests must pin Node/Rust parity with the Node route test suite (`test/server/fresh-agent-extras.test.ts`) as the oracle.
- Failure paths are user-visible: the composer surfaces upload failures (unsupported server, oversized file, network) instead of sending silently; the diff panel shows a clear inline error instead of spinning forever.
- UI honestly reflects "applies to next send" vs "session create only" per provider; no silent drop path remains.
- Unit coverage for parse→apply for each provider adapter touching mid-session settings (Rust: codex, claude; opencode already has it).
- Follow the repo's TDD and PR rules: work in the dedicated worktree from `origin/main` (`db8e09cb67e08a1028ab50b71b99b160a2e7f35f`), red→green per behavior, all affected suites green at the final gate.

### Accepted tradeoffs and residuals
- If attachments are deliberately out of scope for the Rust server, the fallback of hiding/disabling the paperclip against incapable servers is explicitly acceptable (per te1m) — but an implemented endpoint is the primary requested outcome.
- Byte-exact 413/500 body-text parity with express/Node is not required; statuses and the `{error}` JSON shape are. Each such divergence is recorded in the Rust module's doc comments (house pattern, e.g. `resolve.rs:575-581`).
- `POST /api/fresh-agent/send` (AGENT-20, MCP/CLI-only REST twin of `freshAgent.send`) shares the same Node-only gap but is NOT part of these three items and stays out of scope.

**Goal:** Fresh-agent attachment uploads, the transcript diff panel (plus the composer `!cmd` shell escape), and per-send model/effort/sandbox/permission controls all work against the production Rust server with Node-parity wire behavior, visible failures, and honest UI copy.

**Architecture:** Port the three missing extras routes (`attachments`, `diff`, `exec`) into one new self-contained Rust module `crates/freshell-server/src/fresh_agent_extras.rs` following the `checkpoints.rs` extras-family pattern (own `{X}State`, auth-first handlers, `{error}` JSON envelope, Node-oracle doc citations, in-file `#[cfg(test)]` pins). For per-send settings (kata z7j7) apply the parsed `FreshAgentSendSettings` at send time: codex overlays merged settings onto the session record and the `turn/start` params (Node `adapter.ts:955-1001` semantics); claude/kilroy gain a `session.update` sidecar control frame consumed by the vendored sidecar's SDK control surface; opencode already applies per-send settings and serves as the parity reference. Client work is surgical: composer attachment failure copy + a visible notice channel, diff-panel retry/empty/error clarity, and settings pickers whose "applies from the next message" copy becomes true per provider.

**Tech Stack:** Rust (axum 0.8, tokio, serde_json; tracing) under `crates/`; vendored Node sidecar `crates/freshell-claude-sidecar/index.mjs`; React 18 + Redux Toolkit client (Vitest); Playwright e2e on the Rust server (`rust-chromium` project).

## Post-execution amendment (2026-09-12): second rebase onto current main

All nine tasks below were executed to completion at the original base
(`db8e09cb…`) with per-task reviews and a green final gate (receipts in the
run's usual-sdd ledger). During the approved post-recap extension (rebase +
additional delta rounds), `origin/main` advanced twice and landed independent
implementations of two of the three katas via PR #727:

- **te1m (attachments) — CLOSED on main.** `crates/freshell-server/src/attachments.rs`
  (78b8d9d7a) + `agent-attachments.spec.ts` + the composer's 413/size-limit
  surfacing. Plan Tasks 1 and 4 are superseded and dropped from this branch.
- **z7j7 (per-send settings) — CLOSED on main.** The codex/claude per-send
  engine (codex turn/start merge + persist-after-acceptance; claude
  `configure`→`sdk.configured` handshake) landed before the first rebase;
  b28bda34a then landed the honesty scope copy and the per-send e2e proofs in
  `fresh-agent-control-rust.spec.ts`. Plan Tasks 6, 7, and 8 are superseded
  and dropped, along with the corresponding per-send legs of Task 9.
- **ekc6 (diff panel + AGENT-13 diff/exec) — still OPEN.** Main has no
  `GET /api/fresh-agent/diff` / `POST /api/fresh-agent/exec` routes and the
  panel still lacks retry/unsupported/empty states; the SPA already calls
  both routes (`FreshAgentDiffPanel.tsx`, `FreshAgentView.tsx`
  `runShellCommand`).

This branch was rebased onto `origin/main` at `2e05dd9e2` and now carries only
the surviving ekc6 delta: **Task 2** (diff route), **Task 3** (exec route) —
both in `crates/freshell-server/src/fresh_agent_extras.rs` with the
attachments code stripped, **Task 5** (diff-panel retry/unsupported/empty
states), and **Task 9** (e2e proof, trimmed to the diff/exec tests). All
dropped tasks remain documented below for the record; their acceptance
criteria are satisfied by main's landed implementations, not by this branch.

## Global Constraints

1. **Worktree/git.** Work only in `/home/dan/code/freshell/.worktrees/freshagent-rust-parity` on branch `the-usual/freshagent-rust-parity` (base `db8e09cb67e08a1028ab50b71b99b160a2e7f35f`). Focused conventional commits per task. Never touch the main checkout, other worktrees, or `origin/main`.
2. **Setup.** First action in the worktree before client tests: `npm ci --no-audit --no-fund` (Node 22, `.nvmrc`). Rust: 1.96 (`rust-version = "1.96"`); `cargo build`/`cargo test` need no other setup, Tauri-linked workspaces excluded by package scoping (`-p`).
3. **Node server is the oracle, not a target.** `server/fresh-agent-extras-router.ts` and `server/fresh-agent/adapters/**` are READ-ONLY. No changes under `server/` at all; existing suites must stay green unchanged.
4. **Frozen WS contract untouched.** No changes to `port/contract/`, `shared/ws-protocol.ts`, or `crates/freshell-protocol`. The `freshAgent.send.settings` frame already carries `{cwd?, model?, permissionMode?, sandbox?, effort?}` on both sides (`shared/ws-protocol.ts:668-687`; `crates/freshell-protocol/src/client_messages.rs:593-624`) — no frame changes needed. If a step appears to require one, STOP and flag a plan defect instead of touching the contract.
5. **Exact oracle pins (byte-exact where listed).** Attachments: `400 {error:'name query parameter required'}`; `400 {error:'attachment body must be a non-empty application/octet-stream'}`; `200 {path, bytes}`; `413` over `10*1024*1024` body bytes; store at `<home>/.freshell/attachments/<8hex>-<sanitized>` with `basename` + `[^a-zA-Z0-9._-]→'_'` + `'attachment'` fallback. Diff: `400 {error:'cwd query parameter required'}`; `400 {error:'cwd does not exist: <cwd>'}`; `200 {diff}` incl. empty-on-clean AND the error-with-stdout permissive branch; `500 {error:'git diff failed: <...>'}` (prefix pinned; suffix is a recorded divergence). Exec: `400 {error:'command is required'}`; `400 {error:'cwd does not exist: <cwd>'}`; `200 {output, exitCode, truncated}` with `${stdout}${stderr ? '\n'+stderr : ''}`.trim() combining, 30s timeout, `200*1024` truncation cap with `\n[output truncated]` suffix, exitCode = numeric child exit code / `1` on kill or spawn error.
6. **Auth parity.** Every new Rust route gates auth FIRST via `crate::boot::is_authed` (x-auth-token header OR `freshell-auth` cookie) and returns `401 {"error":"Unauthorized"}` before any param validation — same order as the Node global middleware.
7. **Rust house patterns.** New module doc comment cites the Node oracle file:lines and lists recorded divergences; handlers return `Response`; errors are `(StatusCode, Json(json!({"error": message})))` (+ optional `code`); structured `tracing` (info on saved attachment / accepted sends, warn on failures — never log attachment bytes or prompt text, per the DIAG-01 precedent); in-file `#[cfg(test)]` tests + one `tower::ServiceExt::oneshot` route-wiring test per route; `serde(rename_all = "camelCase")` where wire-casing matters.
8. **Client house patterns.** No new toast library: reuse the view's `notice` banner (`role="alert"`, 6s auto-dismiss, `FreshAgentApprovalBanner`) via a new composer→view `onNotice` prop, the chip-level inline errors, and the diff panel's inline destructive-state pattern. ApiError conventions from `src/lib/api.ts`. A11y: real `<button>`s with `aria-label`s; `npm run lint` must pass (jsx-a11y is CI).
9. **Test coordination.** Broad runs ONLY through repo commands (`npm test`, `npm run check`, `npm run test:unit`, `npm run test:integration`) — they hold the shared coordinator gate; set `FRESHELL_TEST_SUMMARY`. Focused vitest runs: `npm run test:vitest -- run <path>`. Rust: plain `cargo test -p <pkg> …` (not coordinated). Focused e2e: chromium-leg specs via `npm run test:e2e:chromium -- <spec>`; RUST-ONLY specs via the validated `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium <spec>` form (no npm script exists for that project) — ALWAYS verify collection with `--list` first when touching a spec's registration. Never restart or deploy any server; never run production ops.
10. **Known pre-existing flake.** `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx > snapshot scheduler integration (zrrj) > keeps the last good snapshot visible and stops fetching during 429 backoff` is a load-sensitive real-timer flake that failed once at the unmodified base under full-suite parallel load and passes in isolation (3/3 at base). If it fails in a gate/classifier run at this run's HEAD, it counts as pre-existing ONLY with a reproduction receipt at `base_ref`; do not "fix" that test in this run unless a failure is attributed to this run's changes.
11. **docs.** No `docs/index.html` update (no major default-experience change; failure copy and a Retry button are minor). No README changes. Keep AGENTS.md untouched (its content is process, not surfaces this run changes).
12. **Scope decision (recorded):** `POST /api/fresh-agent/exec` IS included as Task 3 — the "same gap" half of AGENT-13 that ekc6's task text names; without it the composer `!cmd` escape stays dead on production. `POST /api/fresh-agent/send` (AGENT-20) is excluded (different checklist item, MCP-only consumer).

---

### Task 1: Rust `POST /api/fresh-agent/attachments` (te1m, server half)

**Files:**
- Create: `crates/freshell-server/src/fresh_agent_extras.rs`
- Modify: `crates/freshell-server/src/main.rs:1579-1613` (state construction + merge chain) and the crate's module declaration list (add `mod fresh_agent_extras;` next to the existing `mod checkpoints;` declaration — same file region that declares the checkpoints module)
- Modify: `crates/freshell-server/Cargo.toml:45` (add `"process"` to the `tokio` features list with a one-line why comment — this module spawns `tokio::process::Command` directly in Tasks 2-3, so the crate declares what it uses rather than relying on feature unification)
- Test: in-file `#[cfg(test)] mod tests` in the new module

**Interfaces:**
- Consumes: `crate::boot::{is_authed, unauthorized}`; axum 0.8 `DefaultBodyLimit`; `uuid::Uuid::new_v4()` (already a freshell-server dep); `tokio::fs`.
- Produces: `pub struct FreshAgentExtrasApiState { pub auth_token: Arc<String>, pub home: Arc<PathBuf> }`; `pub fn router(state: FreshAgentExtrasApiState) -> Router`. Mounted in `main.rs` immediately after the checkpoints merge. Tasks 2-3 add routes to this same module/router.

- [ ] **Step 1: Write the failing behavioral test**

Create the module with the router, a STUB handler (auth-check only, then 500), and the complete test module. The stub makes every behavioral test fail for the intended missing behavior rather than for a compile error (the tests name the handler directly, per house style).

```rust
//! `POST /api/fresh-agent/attachments` — a faithful port of
//! `server/fresh-agent-extras-router.ts:268-287` (the `raw({ type:
//! 'application/octet-stream', limit: ATTACHMENT_MAX_BYTES })` handler).
//!
//! Recorded parity divergences from the Node oracle:
//! - Over-limit bodies: the Node route's 413 is express's non-JSON
//!   `PayloadTooLargeError` page; axum's `DefaultBodyLimit` rejection is 413
//!   with axum's own plain-text body. Status parity only — the client maps 413
//!   to clear oversized-file copy (FreshAgentComposer).
```

```rust
use axum::{
    body::Bytes,
    extract::{DefaultBodyLimit, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    routing::post,
    Json, Router,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

use crate::boot::{is_authed, unauthorized};

/// `ATTACHMENT_MAX_BYTES` (`fresh-agent-extras-router.ts:10`).
const ATTACHMENT_MAX_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone)]
pub struct FreshAgentExtrasApiState {
    pub auth_token: Arc<String>,
    /// Resolved home (mirrors `os.homedir()` in `attachmentsDir()`,
    /// `fresh-agent-extras-router.ts:20-22`): uploads land under
    /// `<home>/.freshell/attachments/`.
    pub home: Arc<PathBuf>,
}

pub fn router(state: FreshAgentExtrasApiState) -> Router {
    Router::new()
        .route(
            "/api/fresh-agent/attachments",
            // Route-scoped limit: lifts axum's 2 MiB `Bytes` default for this
            // route only; every other route keeps the default.
            post(post_attachment).layer(DefaultBodyLimit::max(ATTACHMENT_MAX_BYTES)),
        )
        // Node-ordering parity (validated C8, axum 0.8.9 + main.rs:1821-1842
        // precedent): a ROUTER-level auth gate short-circuits BEFORE route
        // extractors, so an unauthenticated over-limit body gets 401, never
        // 413 — mirroring the Node global httpAuthMiddleware before the
        // extras router's parsers (server/index.ts:210-213, :832). The
        // in-handler `is_authed` checks stay as defense-in-depth. LAST call
        // after all .route(...) registrations; survives `.merge()`.
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            |State(state): State<FreshAgentExtrasApiState>,
             request: axum::extract::Request,
             next: axum::middleware::Next| async move {
                if !is_authed(request.headers(), &state.auth_token) {
                    return unauthorized();
                }
                next.run(request).await
            },
        ))
        .with_state(state)
}
```

Test module (complete):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::Request;
    use tower::ServiceExt;

    fn state(home: &std::path::Path) -> FreshAgentExtrasApiState {
        FreshAgentExtrasApiState {
            auth_token: Arc::new("tok".to_string()),
            home: Arc::new(home.to_path_buf()),
        }
    }

    fn headers_with_token(token: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert("x-auth-token", token.parse().unwrap());
        headers
    }

    async fn body_json(resp: Response) -> Value {
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX).await.unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    fn octet(headers: &mut HeaderMap) {
        headers.insert(header::CONTENT_TYPE, "application/octet-stream".parse().unwrap());
    }

    // Mirrors test/server/fresh-agent-extras.test.ts "saves a raw binary
    // attachment and returns its path" (:21-40).
    #[tokio::test]
    async fn saves_attachment_and_returns_path_and_bytes() {
        let home = tempfile::tempdir().unwrap();
        let mut h = headers_with_token("tok");
        octet(&mut h);
        let resp = post_attachment(
            State(state(home.path())),
            h,
            Query(AttachmentQuery { name: Some("hello world.txt".into()) }),
            Bytes::from_static(b"hello bytes"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["bytes"], json!(11));
        let saved = PathBuf::from(v["path"].as_str().unwrap());
        assert_eq!(saved.parent().unwrap(), home.path().join(".freshell/attachments"));
        let base = saved.file_name().unwrap().to_string_lossy();
        assert!(base.ends_with("-hello_world.txt"), "sanitized: {base}");
        assert_eq!(&base[..8], base[..8].to_ascii_lowercase().as_str());
        assert_eq!(std::fs::read(&saved).unwrap(), b"hello bytes");
    }

    // Node `:16-18` + oracle "sanitizes hostile filenames" — basename strips
    // traversal, disallowed chars become '_'.
    #[tokio::test]
    async fn sanitizes_hostile_filenames() {
        let home = tempfile::tempdir().unwrap();
        let mut h = headers_with_token("tok");
        octet(&mut h);
        let resp = post_attachment(
            State(state(home.path())),
            h,
            Query(AttachmentQuery { name: Some("../../etc/passwd".into()) }),
            Bytes::from_static(b"x"),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let base = PathBuf::from(v["path"].as_str().unwrap())
            .file_name().unwrap().to_string_lossy().to_string();
        assert!(!base.contains(".."));
        assert!(base.ends_with("-passwd"), "basename wins: {base}");
    }

    // Node :276-279 — the single funnel for empty body AND wrong content type.
    #[tokio::test]
    async fn rejects_empty_body_and_wrong_content_type() {
        let home = tempfile::tempdir().unwrap();
        for (mut h, body) in [
            ({ let mut h = headers_with_token("tok"); octet(&mut h); h }, Bytes::new()),
            (headers_with_token("tok"), Bytes::from_static(b"{}")),
        ] {
            let resp = post_attachment(
                State(state(home.path())),
                h,
                Query(AttachmentQuery { name: Some("a.txt".into()) }),
                body,
            ).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            assert_eq!(body_json(resp).await["error"],
                json!("attachment body must be a non-empty application/octet-stream"));
        }
    }

    // Node :272-275.
    #[tokio::test]
    async fn rejects_missing_or_empty_name() {
        let home = tempfile::tempdir().unwrap();
        for q in [AttachmentQuery { name: None }, AttachmentQuery { name: Some(String::new()) }] {
            let mut h = headers_with_token("tok");
            octet(&mut h);
            let resp = post_attachment(
                State(state(home.path())), h, Query(q), Bytes::from_static(b"x"),
            ).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            assert_eq!(body_json(resp).await["error"], json!("name query parameter required"));
        }
    }

    #[tokio::test]
    async fn rejects_unauthenticated_first() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_attachment(
            State(state(home.path())),
            HeaderMap::new(),
            Query(AttachmentQuery { name: None }),
            Bytes::new(),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"], json!("Unauthorized"));
    }

    // Route wiring + the route-scoped body limit: the node's own 2MiB regression
    // guard (oracle :64-81) has no global-JSON-parser analogue here; the
    // layering hazard to pin is route-scoped-only override.
    #[tokio::test]
    async fn route_is_wired_with_a_10mib_limit() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let ok_body = vec![b'x'; 2 * 1024 * 1024];
        let resp = app.clone().oneshot(
            Request::builder().method("POST")
                .uri("/api/fresh-agent/attachments?name=big.bin")
                .header("x-auth-token", "tok")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(axum::body::Body::from(ok_body)).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);

        let over = vec![b'x'; ATTACHMENT_MAX_BYTES + 1];
        let resp = app.oneshot(
            Request::builder().method("POST")
                .uri("/api/fresh-agent/attachments?name=toobig.bin")
                .header("x-auth-token", "tok")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(axum::body::Body::from(over)).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    // Node-ordering pin (C8): UNAUTHENTICATED + over-limit → 401, never 413 —
    // the router-level auth gate runs before DefaultBodyLimit, mirroring Node's
    // global auth middleware ordering. (Chunked variant optional; known-length
    // is sufficient here since the middleware precedes extraction entirely.)
    #[tokio::test]
    async fn unauthenticated_over_limit_is_401_not_413() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let over = vec![b'x'; ATTACHMENT_MAX_BYTES + 1];
        let resp = app.oneshot(
            Request::builder().method("POST")
                .uri("/api/fresh-agent/attachments?name=toobig.bin")
                .header(header::CONTENT_TYPE, "application/octet-stream")
                .body(axum::body::Body::from(over)).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(body_json(resp).await["error"], json!("Unauthorized"));
    }
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server fresh_agent_extras`

Expected: FAIL — tests compile (module + handler stub exist) but assertions fail because the stub returns 500 for everything after the auth gate ("behavior absent", not compile/setup errors). Two tests are green already at RED by construction — the direct-call 401 test (stub gates auth) and the 401-before-413 ordering pin (the router-level middleware is part of the skeleton) — which is expected and fine.

- [ ] **Step 3: Add the minimal production implementation**

Replace the stub with the real handler + helpers + module docs above:

```rust
#[derive(serde::Deserialize)]
struct AttachmentQuery {
    name: Option<String>,
}

async fn post_attachment(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Query(query): Query<AttachmentQuery>,
    body: Bytes,
) -> Response {
    // Auth FIRST, mirroring the Node global middleware order (Global Constraint 6).
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `fresh-agent-extras-router.ts:272-275`.
    let name = match query.name.filter(|n| !n.is_empty()) {
        Some(n) => n,
        None => return bad_request("name query parameter required"),
    };
    // `:276-279`. Node's raw({type}) parser leaves any other content type
    // unparsed, funneling everything into this one 400; the port gates the
    // header explicitly to keep that funnel (type-is media-type comparison).
    let octet_stream = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(';').next().unwrap_or("").trim()
            .eq_ignore_ascii_case("application/octet-stream"))
        .unwrap_or(false);
    if !octet_stream || body.is_empty() {
        return bad_request("attachment body must be a non-empty application/octet-stream");
    }
    let dir = state.home.join(".freshell").join("attachments");
    if let Err(err) = tokio::fs::create_dir_all(&dir).await {
        tracing::warn!(error = %err, "fresh_agent_extras.attachments.mkdir_failed");
        return internal_error(format!("failed to create attachments directory: {err}"));
    }
    let filename = format!(
        "{}-{}",
        &uuid::Uuid::new_v4().simple().to_string()[..8],
        sanitize_filename(&name),
    );
    let target = dir.join(&filename);
    let bytes = body.len();
    if let Err(err) = tokio::fs::write(&target, &body).await {
        tracing::warn!(error = %err, "fresh_agent_extras.attachments.write_failed");
        return internal_error(format!("failed to write attachment: {err}"));
    }
    // DIAG-01 posture: bytes + name only, never the file contents.
    tracing::info!(bytes, name = %name, "fresh_agent_extras.attachment.saved");
    Json(json!({ "path": target.to_string_lossy(), "bytes": bytes })).into_response()
}

/// `sanitizeFilename` (`fresh-agent-extras-router.ts:15-18`): linux basename
/// (splits on `/` only), `[^a-zA-Z0-9._-] → '_'`, empty → `attachment`.
fn sanitize_filename(name: &str) -> String {
    let base = name.rsplit('/').next().unwrap_or(name);
    let cleaned: String = base
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' { c } else { '_' })
        .collect();
    if cleaned.is_empty() { "attachment".to_string() } else { cleaned }
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn internal_error(message: String) -> Response {
    (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "error": message }))).into_response()
}
```

`main.rs` wiring (after the `checkpoints_state` construction at :1579-1582 and into the merge chain at :1613):

```rust
    // `POST /api/fresh-agent/attachments` (+ Tasks 2-3's `/diff`, `/exec`) —
    // `fresh-agent-extras-router.ts:268-321`. `home` shares the checkpoints
    // resolution above.
    let fresh_agent_extras_state = fresh_agent_extras::FreshAgentExtrasApiState {
        auth_token: Arc::clone(&auth_token),
        home: Arc::new(home.clone().unwrap_or_else(|| PathBuf::from("."))),
    };
```

and in the app merge chain, directly after `.merge(checkpoints::router(checkpoints_state))`:

```rust
        .merge(fresh_agent_extras::router(fresh_agent_extras_state))
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server fresh_agent_extras`

Expected: PASS — all module tests green, including the 2 MiB body OK and the 10 MiB+1 → 413 limit proof.

- [ ] **Step 5: Refactor while green**

Check: doc-comment citations accurate after final edits; no dead code; `cargo fmt --all --check -p` scope passes; run `cargo clippy -p freshell-server --all-targets -- -D warnings` and fix anything raised in the new module.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server` (whole crate — the merge chain lives here; checkpoints/main wiring must stay green)

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/fresh_agent_extras.rs crates/freshell-server/src/main.rs crates/freshell-server/Cargo.toml
git commit -m "feat(rust): port POST /api/fresh-agent/attachments from the Node extras router (te1m server half)"
```

### Task 2: Rust `GET /api/fresh-agent/diff` (ekc6, server half)

**Files:**
- Modify: `crates/freshell-server/src/fresh_agent_extras.rs` (add route + handler + `run_git_diff`)
- Test: same module's `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: the Task 1 module/router/state; `tokio::process::Command` (feature declared in Task 1); `tokio::time::timeout`.
- Produces: `GET /api/fresh-agent/diff?cwd=<required>&path=<optional>` on the same router; inner `async fn run_git_diff(cwd: &str, file_path: Option<&str>) -> Result<String, String>` reused by tests.

Oracle (`fresh-agent-extras-router.ts:48-59, 304-321`): `git diff --no-color [-- <path>]` in the given `cwd` (the cwd's OWN repo — never the checkpoint shadow repo); `maxBuffer` 512 KiB; 15s timeout. **Permissive branch (parity-critical):** `if (error && !stdout) reject … resolve({diff: stdout})` — a failing/killed git that still produced stdout resolves 200 with whatever stdout was captured (this is how Node's maxBuffer kill surfaces: `error` set, stdout holding the captured prefix). Only error-with-empty-stdout rejects to 500 `git diff failed: <detail>`.

- [ ] **Step 1: Write the failing behavioral test**

Add to `mod tests` (git is available in CI/dev — same assumption as the Node oracle test, which runs real `git` on temp repos):

```rust
    fn git_repo_with_dirty_file() -> (tempfile::TempDir, std::path::PathBuf) {
        // git init && config && commit "one\n", then overwrite with "two\n".
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git").args(args).current_dir(&repo)
                .output().unwrap();
            assert!(out.status.success(), "{args:?}: {}", String::from_utf8_lossy(&out.stderr));
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        std::fs::write(repo.join("a.txt"), "one\n").unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("a.txt"), "two\n").unwrap();
        (dir, repo)
    }

    fn diff_query(cwd: &std::path::Path, path: Option<&str>) -> Query<DiffQuery> {
        Query(DiffQuery {
            cwd: Some(cwd.to_string_lossy().to_string()),
            path: path.map(str::to_string),
        })
    }

    // Oracle `:117-150` "returns a diff payload for a git repo cwd".
    #[tokio::test]
    async fn returns_unified_diff_for_dirty_file_and_scoped_path() {
        let (_d, repo) = git_repo_with_dirty_file();
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("a.txt")),
        ).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let diff = body_json(resp).await["diff"].as_str().unwrap().to_string();
        assert!(diff.contains("-one"), "{diff}");
        assert!(diff.contains("+two"), "{diff}");
    }

    #[tokio::test]
    async fn clean_repo_and_unknown_path_return_empty_200() {
        let (_d, repo) = git_repo_with_dirty_file();
        let home = tempfile::tempdir().unwrap();
        // Clean for a path with no changes:
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("does-not-exist.txt")),
        ).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(body_json(resp).await["diff"], json!(""));
    }

    #[tokio::test]
    async fn requires_cwd_and_validates_it_exists() {
        let home = tempfile::tempdir().unwrap();
        // Missing cwd — Node :308.
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            Query(DiffQuery { cwd: None, path: None }),
        ).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"], json!("cwd query parameter required"));
        // Nonexistent cwd — Node :309-311 (verbatim message).
        let ghost = home.path().join("nope");
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&ghost, None),
        ).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"],
            json!(format!("cwd does not exist: {}", ghost.to_string_lossy())));
    }

    #[tokio::test]
    async fn non_repo_cwd_is_a_500_with_the_oracle_prefix() {
        let not_repo = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(not_repo.path(), None),
        ).await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let err = body_json(resp).await["error"].as_str().unwrap().to_string();
        assert!(err.starts_with("git diff failed: "), "{err}");
    }

    #[tokio::test]
    async fn route_is_wired_at_api_fresh_agent_diff() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app.oneshot(
            Request::builder().method("GET")
                .uri("/api/fresh-agent/diff")
                .header("x-auth-token", "tok")
                .body(axum::body::Body::empty()).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server fresh_agent_extras`

Expected: FAIL — handler not yet mounted/`get_diff` returns the Task-1-era stub or route is missing (assertions fail on behavior, not compile).

- [ ] **Step 3: Add the minimal production implementation**

```rust
/// `DIFF_MAX_BYTES` / diff timeout (`fresh-agent-extras-router.ts:13, 52-59`).
const DIFF_MAX_BYTES: usize = 512 * 1024;
const DIFF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(serde::Deserialize)]
struct DiffQuery {
    cwd: Option<String>,
    path: Option<String>,
}
```

In `router()`, before `.with_state(state)`:

```rust
        .route("/api/fresh-agent/diff", get(get_diff))
```

(add `routing::get` to the imports.)

```rust
async fn get_diff(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Query(query): Query<DiffQuery>,
) -> Response {
    let _ = &state; // auth token only; home unused by diff
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `fresh-agent-extras-router.ts:307-311` (verbatim strings).
    let cwd = match query.cwd.filter(|c| !c.is_empty()) {
        Some(c) => c,
        None => return bad_request("cwd query parameter required"),
    };
    if !std::path::Path::new(&cwd).exists() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }
    match run_git_diff(&cwd, query.path.as_deref()).await {
        Ok(diff) => Json(json!({ "diff": diff })).into_response(),
        Err(message) => {
            tracing::warn!(error = %message, "fresh_agent_extras.diff.failed");
            internal_error(message)
        }
    }
}

/// `runGitDiff` (`fresh-agent-extras-router.ts:48-59`): `git diff --no-color
/// [-- <path>]`, 512 KiB stdout cap, 15 s timeout. The permissive branch is
/// the contract: error/kill WITH captured stdout resolves with that stdout;
/// only error-with-empty-stdout rejects (`git diff failed: <detail>`).
/// Recorded divergence: Node's detail is its execFile error text
/// ("Command failed: …\n<stderr>"); the port uses git's stderr (trimmed) with
/// the same `git diff failed: ` prefix.
async fn run_git_diff(cwd: &str, file_path: Option<&str>) -> Result<String, String> {
    use tokio::io::AsyncReadExt;
    let mut cmd = tokio::process::Command::new("git");
    cmd.arg("diff").arg("--no-color");
    if let Some(p) = file_path {
        cmd.arg("--").arg(p);
    }
    cmd.current_dir(cwd)
        .kill_on_drop(true)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(std::process::Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("git diff failed: {e}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut stderr = child.stderr.take().expect("piped stderr");

    // Drain both streams concurrently; stdout capped at DIFF_MAX_BYTES
    // (keep the prefix — that's the permissive branch), stderr small-capped
    // for the error message only.
    let read_out = async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match stdout.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    let room = DIFF_MAX_BYTES.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                Err(_) => break,
            }
        }
        buf
    };
    let read_err = async {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stderr.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    let room = (64 * 1024_usize).saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                Err(_) => break,
            }
        }
        buf
    };
    let drained = tokio::time::timeout(DIFF_TIMEOUT, async {
        let (out, err) = tokio::join!(read_out, read_err);
        let status = child.wait().await;
        (out, err, status)
    })
    .await;

    let (out, err, status) = match drained {
        Ok(v) => v,
        Err(_) => {
            let _ = child.kill().await;
            return Err("git diff failed: timed out after 15s".to_string());
        }
    };
    let ok = matches!(status, Ok(s) if s.success());
    let stdout_text = String::from_utf8_lossy(&out).into_owned();
    if !ok && stdout_text.is_empty() {
        let detail = String::from_utf8_lossy(&err).trim().to_string();
        return Err(format!("git diff failed: {}", if detail.is_empty() { "git exited without output".to_string() } else { detail }));
    }
    Ok(stdout_text)
}
```

(Note: Node's `${stdout}` is verbatim — no trim on the diff payload; preserve that.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server fresh_agent_extras`

Expected: PASS (whole module, Task 1 tests included).

- [ ] **Step 5: Refactor while green**

Check divergence list in the module doc comment is current (add the diff-suffix divergence); clippy clean per Task 1 Step 5.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/fresh_agent_extras.rs
git commit -m "feat(rust): port GET /api/fresh-agent/diff from the Node extras router (ekc6 server half)"
```

### Task 3: Rust `POST /api/fresh-agent/exec` (ekc6's AGENT-13 sibling — the composer `!cmd` escape)

**Files:**
- Modify: `crates/freshell-server/src/fresh_agent_extras.rs` (add route + handler + `run_command`)
- Test: same module's `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: Task 1 module/router/state (`home` = the `os.homedir()` default-cwd analogue).
- Produces: `POST /api/fresh-agent/exec` `{command: string, cwd?: string}` → `{output: string, exitCode: number, truncated: boolean}`.

Oracle (`fresh-agent-extras-router.ts:26-46, 289-302`), byte-exact semantics:
- Request: `command` string (`.trim()`-ed; missing/non-string/empty-after-trim → `400 {"error":"command is required"}`); `cwd` optional string, default `os.homedir()`; nonexistent cwd → `400 {"error":"cwd does not exist: <cwd>"}`.
- Execution: `bash -lc <command>` (**login shell** — profile init, do not downgrade to `-c`), inherited env, 30s timeout, per-stream 200 KiB capture cap.
- Result: `combined = (stdout + (stderr ? "\n" + stderr : "")).trim()` — stdout THEN stderr, one newline between, no interleave; `truncated = combined.length >= 200*1024`; `output = truncated ? combined.slice(0, 200*1024) + "\n[output truncated]" : combined`; `exitCode = <numeric exit code> | 1 when killed/spawn-failed/timed-out | 0`.
- No 500 path: failures surface as non-zero `exitCode` in a 200.

- [ ] **Step 1: Write the failing behavioral test**

```rust
    async fn post_exec_authed(home: &std::path::Path, body: Value) -> Response {
        post_exec(State(state(home)), headers_with_token("tok"), Json(body)).await
    }

    // Oracle `:84-116` happy path + non-zero exit with stderr folded.
    #[tokio::test]
    async fn exec_runs_command_and_combines_streams() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({
            "command": "echo out; echo err 1>&2",
            "cwd": home.path().to_string_lossy(),
        })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        // `${stdout}\n${stderr}`.trim(): stdout first, one newline, stderr, trimmed.
        assert_eq!(v["output"], json!("out\nerr"));
        assert_eq!(v["exitCode"], json!(0));
        assert_eq!(v["truncated"], json!(false));
    }

    #[tokio::test]
    async fn exec_reports_nonzero_exit_code() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({ "command": "exit 7" })).await;
        let v = body_json(resp).await;
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(v["exitCode"], json!(7));
    }

    #[tokio::test]
    async fn exec_rejects_missing_command_and_bad_cwd() {
        let home = tempfile::tempdir().unwrap();
        for body in [json!({}), json!({ "command": "   " })] {
            let resp = post_exec_authed(home.path(), body).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            assert_eq!(body_json(resp).await["error"], json!("command is required"));
        }
        let ghost = home.path().join("nope");
        let resp = post_exec_authed(home.path(), json!({
            "command": "true",
            "cwd": ghost.to_string_lossy(),
        })).await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(body_json(resp).await["error"],
            json!(format!("cwd does not exist: {}", ghost.to_string_lossy())));
    }

    #[tokio::test]
    async fn exec_truncates_oversized_output() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({
            "command": "head -c 300000 /dev/zero | tr '\\0' 'a'",
        })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["truncated"], json!(true));
        // Node's maxBuffer kill surfaces as exitCode 1 (non-numeric code).
        assert_eq!(v["exitCode"], json!(1));
        let output = v["output"].as_str().unwrap();
        assert_eq!(output.len(), 200 * 1024 + "\n[output truncated]".len());
        assert!(output.ends_with("\n[output truncated]"));
    }

    #[tokio::test]
    async fn exec_route_is_wired() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app.oneshot(
            Request::builder().method("POST")
                .uri("/api/fresh-agent/exec")
                .header("x-auth-token", "tok")
                .header(header::CONTENT_TYPE, "application/json")
                .body(axum::body::Body::from(r#"{"command":"true"}"#)).unwrap(),
        ).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-server fresh_agent_extras`

Expected: FAIL — `post_exec` stub/route absent (behavioral failure, not compile).

- [ ] **Step 3: Add the minimal production implementation**

```rust
/// `EXEC_TIMEOUT_MS` / `EXEC_MAX_OUTPUT` (`fresh-agent-extras-router.ts:11-12`).
const EXEC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const EXEC_MAX_OUTPUT: usize = 200 * 1024;
```

In `router()`: `.route("/api/fresh-agent/exec", post(post_exec))`.

```rust
async fn post_exec(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `fresh-agent-extras-router.ts:289-297`.
    let command = body
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let Some(command) = command else {
        return bad_request("command is required");
    };
    let cwd = body
        .get("cwd")
        .and_then(Value::as_str)
        .filter(|c| !c.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| state.home.to_string_lossy().to_string());
    if !std::path::Path::new(&cwd).exists() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }
    let result = run_command(command, &cwd).await;
    Json(json!({
        "output": result.output,
        "exitCode": result.exit_code,
        "truncated": result.truncated,
    }))
    .into_response()
}

struct ExecOutcome {
    output: String,
    exit_code: i64,
    truncated: bool,
}

/// `runCommand` (`fresh-agent-extras-router.ts:26-46`): `bash -lc`, 30 s
/// timeout, 200 KiB per-stream capture caps, combined
/// `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), slice+marker truncation,
/// exitCode = numeric code / 1 on kill-or-spawn-error / 0.
async fn run_command(command: &str, cwd: &str) -> ExecOutcome {
    use tokio::io::AsyncReadExt;
    let spawned = tokio::process::Command::new("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let mut child = match spawned {
        Ok(c) => c,
        // Node surfaces spawn failure as exitCode 1 with empty output.
        Err(err) => {
            tracing::warn!(error = %err, "fresh_agent_extras.exec.spawn_failed");
            return ExecOutcome { output: String::new(), exit_code: 1, truncated: false };
        }
    };
    let mut out_pipe = child.stdout.take().expect("piped stdout");
    let mut err_pipe = child.stderr.take().expect("piped stderr");
    let drain = |pipe: &mut (dyn tokio::io::AsyncRead + Unpin)| async move {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        loop {
            match pipe.read(&mut chunk).await {
                Ok(0) => break,
                Ok(n) => {
                    let room = EXEC_MAX_OUTPUT.saturating_sub(buf.len());
                    buf.extend_from_slice(&chunk[..n.min(room)]);
                }
                Err(_) => break,
            }
        }
        buf
    };
    let drained = tokio::time::timeout(EXEC_TIMEOUT, async {
        let (out, err) = tokio::join!(drain(&mut out_pipe), drain(&mut err_pipe));
        let status = child.wait().await;
        (out, err, status)
    })
    .await;
    let (out, err, status) = match drained {
        Ok(v) => v,
        Err(_) => {
            let _ = child.kill().await;
            tracing::warn!("fresh_agent_extras.exec.timed_out");
            (Vec::new(), Vec::new(), None)
        }
    };
    let stdout = String::from_utf8_lossy(&out);
    let stderr = String::from_utf8_lossy(&err);
    let combined = format!("{stdout}{}", if stderr.is_empty() { String::new() } else { format!("\n{stderr}") })
        .trim()
        .to_string();
    let truncated = combined.len() >= EXEC_MAX_OUTPUT;
    let output = if truncated {
        let mut s = combined;
        s.truncate(EXEC_MAX_OUTPUT);
        s.push_str("\n[output truncated]");
        s
    } else {
        combined
    };
    let exit_code = match status {
        Some(Ok(s)) => s.code().map(i64::from).unwrap_or(1),
        _ => 1,
    };
    ExecOutcome { output, exit_code, truncated }
}
```

Two faithfulness corrections the implementer must preserve (they pin Node's kill semantics):

1. **Kill on cap.** Node's `maxBuffer` KILLS the child when a stream exceeds its cap, and that kill delivers a NON-numeric `error.code` → `exitCode: 1` on a truncated run — not the shell pipeline's own exit status. Mirror this: when a stream's buffer reaches its cap, kill the child instead of draining to EOF, and report `exitCode: 1` for that kill (same path as a timeout kill). The `exec_truncates_oversized_output` test therefore also asserts `exitCode` is `1`.
2. **Kills keep captured output.** On ANY kill (cap or timeout) the already-captured bytes are kept and flow through the same combine/trim/truncate rule, so a killed run still returns its partial prefix (Node passes the buffered content alongside a kill error). Shape suggestion: drive the two stream drains with `tokio::join!` but `select!` that against `sleep(EXEC_TIMEOUT)`; share the buffers via `Arc<Mutex<Vec<u8>>>` (or split reads) so the kill arm can combine what arrived.

(The `drain` closure may still become a plain `async fn` helper to satisfy borrow rules — mechanics are the implementer's, the semantics above are not.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-server fresh_agent_extras`

Expected: PASS (whole module).

- [ ] **Step 5: Refactor while green**

Keep the module's divergence list honest; clippy clean.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-server`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-server/src/fresh_agent_extras.rs
git commit -m "feat(rust): port POST /api/fresh-agent/exec from the Node extras router (AGENT-13 same-gap sibling of ekc6)"
```

### Task 4: Composer attachment failure visibility (te1m, client half)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentComposer.tsx` (size guard, error-copy mapping, `onNotice` prop, send-while-uploading notice)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (~:2888-2899 composer mount: pass `onNotice={setNotice}`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx` (new `describe('attachments')`), plus one wiring test in `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: the view's existing `setNotice` state setter (banner: `FreshAgentApprovalBanner`, `role="alert"`, 6s auto-dismiss — see `FreshAgentView.tsx:2430-2433, 2740`).
- Produces: `FreshAgentComposerProps` gains OPTIONAL `onNotice?: (text: string) => void`; module-local constant `ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024` (mirrors `fresh-agent-extras-router.ts:10`). No api.ts changes.

Exact copy (pins):
- Over-limit (pre-upload guard AND 413 mapping): `over the 10 MiB attachment limit` (chip renders `— over the 10 MiB attachment limit`; the pre-upload guard message is `File is over the 10 MiB attachment limit` when it needs to stand alone in the notice).
- Unsupported server (404): `Attachments are not supported by this server` — the 404 case is real for stale-server deploys even though this run implements the route (the Accepted-residual fallback made visible, per te1m).
- Upload-failure notice: `Attachment failed: <file.name> — <message>`.
- Enter-while-uploading: `Attachments are still uploading — wait for them to finish or remove them`.

Behavior decisions (recorded): errored chips still survive a send and are still excluded from the outgoing prompt text (existing `:480-489` design — a failed upload has no path to reference); the new visibility comes from the failure-time notice + clearer chip copy, not from blocking send.

- [ ] **Step 1: Write the failing behavioral test**

The composer's uploader uses raw `fetch`, so tests stub it globally (established pattern: `PaneContainer.createContent.test.tsx:188-192`). Add to `FreshAgentComposer.test.tsx`:

```tsx
describe('attachments', () => {
  const fileOf = (name: string, size: number) => {
    const f = new File(['x'], name, { type: 'application/octet-stream' })
    Object.defineProperty(f, 'size', { value: size })
    return f
  }
  const attachViaInput = async (file: File) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [file] } })
  }
  const pngData = transferWith(...) // per existing drag-drop helpers if present; input path suffices

  afterEach(() => { vi.unstubAllGlobals() })

  it('rejects an over-limit file before any network call, with a notice', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const onNotice = vi.fn()
    render(<FreshAgentComposer /* …existing required props… */ onNotice={onNotice} />)
    await attachViaInput(fileOf('big.bin', 10 * 1024 * 1024 + 1))
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(screen.getByText(/over the 10 MiB attachment limit/)).toBeInTheDocument()
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('10 MiB'))
  })

  it('uploads a small file and marks the chip ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ path: '/home/u/.freshell/attachments/abcd1234-note.txt', bytes: 1 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )))
    render(<FreshAgentComposer /* …props… */ />)
    await attachViaInput(fileOf('note.txt', 1))
    await waitFor(() => expect(screen.queryByLabelText('uploading')).not.toBeInTheDocument())
    const chip = screen.getByText('note.txt').closest('[role="listitem"]')
    expect(chip?.textContent ?? '').not.toContain('—')
  })

  it.each([
    [413, '<html>Payload Too Large</html>', /over the 10 MiB attachment limit/],
    [404, JSON.stringify({ error: 'Not found' }), /not supported by this server/],
    [400, JSON.stringify({ error: 'name query parameter required' }), /name query parameter required/],
  ])('maps a %s failure to visible chip copy and a notice', async (status, body, copy) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status })))
    const onNotice = vi.fn()
    render(<FreshAgentComposer /* …props… */ onNotice={onNotice} />)
    await attachViaInput(fileOf('note.txt', 1))
    await screen.findByText(copy)
    expect(onNotice).toHaveBeenCalledWith(expect.stringContaining('Attachment failed: note.txt'))
  })

  it('Enter while an upload is in flight sends nothing and posts a notice', async () => {
    let release: (r: Response) => void = () => {}
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(new Promise<Response>((r) => { release = r })))
    const onSend = vi.fn()
    const onNotice = vi.fn()
    render(<FreshAgentComposer /* …props… */ onSend={onSend} onNotice={onNotice} />)
    await attachViaInput(fileOf('note.txt', 1))
    await userEvent.type(screen.getByRole('textbox'), 'hello{Enter}')
    expect(onSend).not.toHaveBeenCalled()
    expect(onNotice).toHaveBeenCalledWith('Attachments are still uploading — wait for them to finish or remove them')
    release(new Response(JSON.stringify({ path: '/x', bytes: 1 }), { status: 200 }))
    await screen.findByText('note.txt')
  })
})
```

(Wire the test file's existing minimal-props/render helper into these; the block above shows the meaningful assertions. `userEvent`/rendering conventions follow the file's existing describes.)

View wiring test (add to `FreshAgentView.test.tsx` near the composer focus describes): render a fresh-agent pane, drive an attachment failure (stubbed fetch 500), assert the view-level `role="alert"` banner shows the `Attachment failed: …` text — proving composer→view `onNotice` plumbing.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`

Expected: FAIL — no size guard, no copy mapping, no `onNotice` prop (assertions fail on missing behavior; not on setup errors).

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentComposer.tsx`:

```tsx
// Component props interface: add
  onNotice?: (text: string) => void
```

```tsx
/** Mirrors ATTACHMENT_MAX_BYTES in server/fresh-agent-extras-router.ts:10. */
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024
const ATTACHMENT_TOO_LARGE_MESSAGE = 'over the 10 MiB attachment limit'
```

In `uploadAttachment` (current :176-190), extend the failure branch:

```tsx
  if (!res.ok) {
    if (res.status === 413) throw new Error(ATTACHMENT_TOO_LARGE_MESSAGE)
    if (res.status === 404) throw new Error('Attachments are not supported by this server')
    const data = await res.json().catch(() => null) as { error?: string; message?: string } | null
    throw new Error(data?.error || data?.message || `upload failed (${res.status})`)
  }
```

In `addFiles` (current :440-468), after the extension-rejection branch, add the size guard and notice wiring:

```tsx
    if (file.size > ATTACHMENT_MAX_BYTES) {
      setAttachments((current) => [...current, {
        name: file.name, bytes: file.size, status: 'error',
        error: `File is ${ATTACHMENT_TOO_LARGE_MESSAGE}`,
      }])
      onNotice?.(`Attachment failed: ${file.name} — File is ${ATTACHMENT_TOO_LARGE_MESSAGE}`)
      continue // or `return` per the loop shape — one notice per rejected file
    }
```

and in the upload `.catch` (current :470-476), after the chip flip:

```tsx
      onNotice?.(`Attachment failed: ${file.name} — ${message}`)
```

(`message` = the same string placed on the chip.)

In `sendText` (current :482), make the in-flight guard speak:

```tsx
  if (attachments.some((entry) => entry.status === 'uploading')) {
    onNotice?.('Attachments are still uploading — wait for them to finish or remove them')
    return
  }
```

In `FreshAgentView.tsx`, at the composer mount: add `onNotice={setNotice}`.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Check a11y: no new interactive elements were added (chips/notices only); `role="list"/"listitem"` chip semantics intact; the notice uses the existing `role="alert"` banner. `npm run lint` clean for the touched files.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/`

Expected: PASS — composer, view (incl. the new wiring test), settings-button, dialog suites all green. The ledger-known flaky 429 test is excluded from flake guilt per Global Constraint 10.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentComposer.tsx src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(client): visible fresh-agent attachment failures (size guard, copy map, notice banner) — te1m client half"
```

### Task 5: Diff panel retry + clear failure/empty states (ekc6, client half)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentDiffPanel.tsx`
- Test: `test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx` (currently 24 lines, render-only — this task gives it behavioral coverage; mock `@/lib/api` like the sibling suites do)

**Interfaces:**
- Consumes: `api.get`, `ApiError` from `@/lib/api`; existing props `{ diffs, cwd, onComment }`.
- Produces: no prop/signature changes.

- [ ] **Step 1: Write the failing behavioral test**

```tsx
// vi.mock('@/lib/api') with a getFreshAgentDiff-capable `get` spy (follow the
// composer/sibling suites' vi.mock shape; only `get` needs stubbing here).
describe('diff loading', () => {
  const entry = { id: 'd1', path: 'src/a.ts', status: 'modified' as const }

  it('expand → success renders the diff lines', async () => {
    apiMock.get.mockResolvedValue({ diff: '@@ -1 +1 @@\n-one\n+two' })
    render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
    await screen.findByText('+two')
  })

  it('expand → server 500 shows the inline error and a Retry button', async () => {
    apiMock.get.mockRejectedValue(new ApiError(500, 'git diff failed: fatal: not a git repository', { error: 'git diff failed: …' }))
    render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
    await screen.findByText(/git diff failed/)
    const retry = screen.getByRole('button', { name: 'Retry loading diff' })
    apiMock.get.mockResolvedValue({ diff: 'later' })
    await userEvent.click(retry)
    await screen.findByText('later')
    expect(apiMock.get).toHaveBeenCalledTimes(2)
  })

  it('expand → 404 shows the unsupported-server copy', async () => {
    apiMock.get.mockRejectedValue(new ApiError(404, 'Not found', { error: 'Not found' }))
    render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
    await screen.findByText(/not supported by this server/)
  })

  it('missing cwd renders an explicit inline state and never fetches', async () => {
    render(<FreshAgentDiffPanel diffs={[entry]} cwd={undefined} />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
    await screen.findByText(/Diff unavailable for this file/)
    expect(apiMock.get).not.toHaveBeenCalled()
  })

  it('empty diff keeps its copy', async () => {
    apiMock.get.mockResolvedValue({ diff: '' })
    render(<FreshAgentDiffPanel diffs={[entry]} cwd="/repo" />)
    await userEvent.click(screen.getByRole('button', { name: 'Diff: src/a.ts' }))
    await screen.findByText(/No uncommitted changes for this file/)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`

Expected: FAIL — no Retry button, no 404 mapping, no missing-cwd state (the missing-cwd expand currently renders silently blank).

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentDiffPanel.tsx`:

```tsx
import { ApiError, get as apiGet } from '@/lib/api' // adjust to the file's existing import shape

function mapDiffLoadError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404) {
    return 'Diffs are not supported by this server.'
  }
  return err instanceof Error ? err.message : 'Failed to load diff'
}
```

Rework `load` (current :25-40) so prerequisites are an explicit state, not a silent no-op, and keep the one-shot `diff !== null` guard semantics for success-only:

```tsx
  const load = useCallback(() => {
    if (loading || diff !== null) return
    setLoading(true)
    setError(null)
    void Promise
      .resolve(api.get<{ diff: string }>(
        `/api/fresh-agent/diff?cwd=${encodeURIComponent(cwd as string)}&path=${encodeURIComponent(summary.path as string)}`,
      ))
      .then((result) => setDiff(result?.diff ?? ''))
      .catch((err: unknown) => setError(mapDiffLoadError(err)))
      .finally(() => setLoading(false))
  }, [cwd, diff, loading, summary.path])
```

Render changes in the expanded body:
1. When `!cwd || !summary.path`: `<div className="px-3 py-2 text-muted-foreground">Diff unavailable for this file.</div>` (and `load` is never invoked).
2. Error block gains the retry affordance:

```tsx
        <div className="px-3 py-2 text-destructive">
          {error}{' '}
          <button
            type="button"
            aria-label="Retry loading diff"
            className="underline hover:text-destructive/80"
            onClick={() => load()}
          >
            Retry
          </button>
        </div>
```

(The existing `error` state already leaves `diff` null, so `load()` retries; `setError(null)` inside `load` clears the block on the way.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

A11y check: the row trigger keeps `aria-expanded`/`aria-label`; the Retry button is a real button with an aria-label. Lint the touched files.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentDiffPanel.tsx test/unit/client/components/fresh-agent/FreshAgentDiffPanel.test.tsx
git commit -m "feat(client): fresh-agent diff panel retry + clear unsupported/empty states (ekc6 client half)"
```

### Task 6: codex per-send settings applied (z7j7, freshcodex)

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` (`handle_send`, :1167-1312)
- Test: same file's `mod tests`

**Interfaces:**
- Consumes: `FreshAgentSend.settings: Option<FreshAgentSendSettings>` (`freshell-protocol::client_messages`); existing `normalize_freshcodex_model`, `normalize_freshcodex_effort`, `to_codex_reasoning_effort` (`crates/freshell-codex/src/model.rs`), `sandbox_policy_value` (codex.rs:5046), the `send_error(..., "INVALID_EFFORT", …)` channel (:1259-1265), and the test seam `freshell_codex::new_channel_transport()` + `peer.expect_request()` (existing tests, e.g. :5717-5778).
- Produces: per-send overlay semantics in `handle_send` (Node `adapter.ts:955-1001` + `rememberThreadSettings` :695-710): fields present in `settings` override the session baseline for this turn AND become the new baseline; absent fields keep prior values.

Behavior spec:
1. Merge: `model = settings.model ?? baseline.model` (same for `effort`, `sandbox`, `permission_mode`; `cwd = settings.cwd ?? baseline.cwd ?? msg.cwd`). `Sandbox` enum ⇄ its wire string (`"read-only" | "workspace-write" | "danger-full-access"`) via `serde_json::to_value(...).as_str()` (camelCase serde naming already yields these strings).
2. Normalize exactly as today (:1256-1258): `normalize_freshcodex_model`, `normalize_freshcodex_effort(&model, effort)`, `to_codex_reasoning_effort`.
3. Invalid effort → existing `INVALID_EFFORT` error frame, no turn started, **baseline NOT mutated** (validate before persist).
4. Persist the merged+normalized values back onto the `CodexSession` record BEFORE `start_turn` (Node persists the merged map at :173-175, pre-turn), so a later settings-less send inherits them. Do the overlay+persist in ONE short `sessions.lock()` section **before** acquiring `turn_lock` (do not hold the sessions lock across the turn lock — keep today's lock ordering).
5. `turn/start` params built from the merged values (shape unchanged, :1267-1277).
6. Re-snapshot the identity binding row when the persisted settings changed (P1.13 mirror of the create-time write — the opencode precedent is `opencode_ws.rs:867-890`; the codex create-time call is the `record_codex_binding`-family call the `:583-589` create flow uses; reuse that exact call with the new values).

- [ ] **Step 1: Write the failing behavioral test**

Follow the file's existing channel-transport harness (insert session with baseline settings; drive `handle_send`; answer `initialize`/`expect_request` on the peer). Two tests:

```rust
    #[tokio::test]
    async fn per_send_settings_overlay_the_baseline_and_stick() {
        // Baseline: create-time model "big-model", effort "high", no sandbox/permission.
        // (Insert the fake session the way existing tests do, carrying those
        // create-time values into the CodexSession record.)
        let (transport, peer) = freshell_codex::new_channel_transport();
        // … existing harness setup (client, consumer, session insert) …

        let mut send = send_msg("thread-1", "second"); // existing msg builder
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            effort: Some("low".to_string()),
            model: Some("small-model".to_string()),
            permission_mode: Some("never".to_string()),
            sandbox: Some(freshell_protocol::common::Sandbox::ReadOnly.into()),
        });
        state.handle_send(send).await;

        // Answer the app-server handshake the way existing tests do, then:
        let (id, method, params) = peer.expect_request().await;
        assert_eq!(method, "turn/start");
        assert_eq!(params["model"], json!("small-model"));
        assert_eq!(params["effort"], json!("low"));
        assert_eq!(params["sandboxPolicy"], json!({ "type": "readOnly" }));
        assert_eq!(params["approvalPolicy"], json!("never"));
        peer.respond(&id, json!({ "turn": { "id": "turn-x" } })); // per existing respond shape

        // Stickiness: a settings-less send reuses the merged baseline.
        // … second handle_send, expect turn/start with the SAME values …
    }

    #[tokio::test]
    async fn invalid_per_send_effort_rejects_without_mutating_the_baseline() {
        // baseline effort "high"; send.settings.effort = "bogus"
        // expect: error frame with code INVALID_EFFORT broadcast, NO turn/start
        // request observed on the peer (timeout-guarded), and a subsequent
        // settings-less send still applies "high".
    }
```

(The exact `Sandbox` enum path/variants come from `crates/freshell-protocol/src/common.rs:142-149` — implementer uses the real names; the harness glue comes from the file's existing tests verbatim.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent codex::tests::per_send_settings`

Expected: FAIL — `turn/start` carries the create-time baseline, not the per-send override (behavioral failure; the harness compiles and runs).

- [ ] **Step 3: Add the minimal production implementation**

In `handle_send`, restructure the lookup-extract block (:1200-1229) into extract+overlay → validate → persist, with two short `sessions.lock()` sections (never nested, both before `turn_lock` acquisition — today's lock ordering is untouched):

```rust
        // Lock section 1: extract the baseline and compute merged candidates
        // WITHOUT writing (validation must precede persistence).
        let looked_up = {
            let guard = self.sessions.lock().await;
            guard.get(&session_id).map(|s| {
                (
                    s.client.clone(),
                    // z7j7 / AGENT-12 (Node adapter.ts:955-975 +
                    // rememberThreadSettings :695-710): per-send fields override
                    // the baseline and, once validated, become it; absent fields
                    // keep prior values. cwd: settings > baseline > msg.cwd.
                    msg.settings.as_ref().and_then(|st| st.model.clone()).unwrap_or_else(|| s.model.clone()),
                    msg.settings.as_ref().and_then(|st| st.effort.clone()).or_else(|| s.effort.clone()),
                    msg.settings.as_ref().and_then(|st| st.cwd.clone())
                        .or_else(|| s.cwd.clone()).or_else(|| cwd.clone()),
                    msg.settings.as_ref()
                        .and_then(|st| st.sandbox.as_ref())
                        .and_then(|sb| serde_json::to_value(sb).ok()
                            .and_then(|v| v.as_str().map(str::to_string)))
                        .or_else(|| s.sandbox.clone()),
                    msg.settings.as_ref().and_then(|st| st.permission_mode.clone())
                        .or_else(|| s.permission_mode.clone()),
                    s.active_turn.clone(),
                    s.turn_lock.clone(),
                )
            })
        };
```

The existing normalize/validate block (:1256-1265) then runs on the merged locals unchanged (`INVALID_EFFORT` early-return now happens before any persistence — a bogus per-send value mutates nothing). On success:

```rust
        // Lock section 2 (only after validated values, still before turn_lock):
        // persist the merged baseline so later settings-less sends inherit it
        // (Node persists the merged map pre-turn, adapter.ts:173-175).
        {
            let mut guard = self.sessions.lock().await;
            if let Some(s) = guard.get_mut(&session_id) {
                s.model = model.clone();
                s.effort = effort.clone();          // menu value, pre wire-map
                s.cwd = Some(turn_cwd.clone()).flatten().or(s.cwd.take());
                s.sandbox = sandbox.clone();
                s.permission_mode = permission_mode.clone();
            }
        }
```

(respecting the real `CodexSession` field types — `model: String`, `effort/cwd/sandbox/permission_mode: Option<_>`, :199-211; implementer adapts exact assignments, never the merge semantics.)

After a successful persist where any setting actually changed, re-snapshot the binding row via the create-path call with the new values (see Behavior spec point 6).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent codex::tests`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Doc comment on `CodexSession` (`:199-211`) currently codifies create-time reuse — update it to the merged-baseline semantics so the doc stops lying. `cargo clippy -p freshell-freshagent --all-targets -- -D warnings` clean.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent`

Expected: PASS — the whole crate, incl. existing `send`-path and binding tests.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/codex.rs
git commit -m "feat(rust): apply freshcodex per-send model/effort/sandbox/permission at send time (z7j7)"
```

### Task 7: claude/kilroy per-send settings via a `session.update` sidecar control frame (z7j7)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` (`handle_send` :1008-1040; `ClaudeSession` :215+ gains `model`/`permission_mode`/`effort` fields seeded at create from the P1.13 settings snapshot)
- Modify: `crates/freshell-claude-sidecar/index.mjs` (dispatch switch :453-485 gains a `session.update` case)
- Modify: `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` (the e2e fake sidecar implements the same frame; its stdin audit records it)
- Test: `claude.rs` `mod tests` (scripted-fake harness: `FakeClaudeSidecarEnv::install()`, the `CLAUDE_ENV_LOCK` guard, `state_with_bus()` — the existing binding/resume tests at :6430-6660 are the template); `test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts` (frame-handling pin for the e2e fake)
- Do NOT modify: `port/contract/**`, `shared/ws-protocol.ts`, `crates/freshell-protocol/**` (sidecar frames are an internal protocol, not the client WS contract).

**Interfaces:**
- Consumes: sidecar `state.query` (retained at `index.mjs:345`), whose SDK control surface per the vendored `@anthropic-ai/claude-agent-sdk` type pins (validator-confirmed in Stage 2) is `query.setModel(model)`, `query.setPermissionMode(mode)`, `query.applyFlagSettings({ effortLevel })`.
- Produces: sidecar frame `{ "type": "session.update", "sessionId": string, "model"?: string, "permissionMode"?: string, "effort"?: string }` (camelCase, mirroring the `create` frame's field names at `claude.rs:597-606`). Written (when non-empty) BEFORE the `send` frame so the SDK applies the values before the prompt streams.

Behavior spec:
1. `handle_send` with `msg.settings`: merge each of `model`/`permission_mode`/`effort` over the session record (settings value wins; absent field keeps the record's value — same overlay rule as codex Task 6). `settings.cwd` is ignored for claude: cwd is session-create-scoped (the client only stamps the pane's own `initialCwd`); note this in the code comment.
2. If (and only if) the merged values differ from the record, write one `session.update` frame (carrying the changed-or-full merged trio — full-trio is simpler and idempotent; pick full-trio) and THEN the existing `send` frame, and persist the merged trio onto the session record. The client stamps settings on every send, so the diff-vs-record guard is what keeps ordinary sends single-frame; tests pin both shapes.
3. `session.update` write failure → the same recovery as a failed `send` write (`undo_turn_op_arm` + `send_error(…, "CLAUDE_SEND_FAILED", …)` at :1019-1028) — never emit `send` after a failed update.
4. Sidecar `session.update` case: look up the session; unknown session → `logerr` (existing convention), no crash. Otherwise call the three SDK methods for present fields, in `try/catch`; on throw, emit the file's existing session-error frame convention (the Rust stdout consumer already folds those) — never swallow. Load-bearing validation C2 outcome: the SDK methods send a control request and await `control_response`, so CLI rejections surface into this `try/catch`; BUT the SDK defines no timeout, so wrap the awaited calls in a bounded timeout (~10s, `Promise.race`) that emits the same session-error frame on expiry — a never-answering CLI must not park the session.
5. Effort: passed through verbatim (same as create-time). Invalid values surface via the SDK's error (4), never silently.
6. Real `index.mjs` + e2e fake both implement the case, so e2e freshclaude flows keep working when the frozen client sends settings.

- [ ] **Step 1: Write the failing behavioral test**

Rust (scripted fake — extend its knobs to log received request frame types/fields to its spawn log, the file's established pattern):

```rust
    /// z7j7 / AGENT-12: a send whose settings differ from the session record
    /// writes ONE session.update frame (merged values) immediately BEFORE the
    /// send frame, and re-snapshots the identity binding with the new values.
    #[tokio::test(flavor = "multi_thread")]
    async fn send_with_changed_settings_writes_session_update_then_send() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let (state, mut rx) = state_with_bus();
        let fake = std::sync::Arc::new(crate::identity_sink::FakeIdentitySink::default());
        state.set_identity_sink(fake.clone());

        let mut msg = dedup_create_msg("req-per-send");
        msg.model = Some("opus-a".to_string());
        msg.permission_mode = Some("default".to_string());
        msg.effort = Some("high".to_string());
        msg.cwd = Some(env.dir.to_string_lossy().to_string());
        state.handle_create(msg).await;
        await_claude_created(&mut rx, "req-per-send").await;

        let mut send = send_msg_for("req-per-send", "hello"); // existing send builder in this module
        send.settings = Some(freshell_protocol::FreshAgentSendSettings {
            cwd: None,
            model: Some("opus-b".to_string()),
            permission_mode: Some("plan".to_string()),
            effort: Some("low".to_string()),
            sandbox: None,
        });
        state.handle_send(send).await;

        // The scripted fake records stdin frames in order: find [send] and
        // assert the frame immediately before it is our session.update.
        // (helper: read the fake's recorded stdin lines — the harness already
        // exposes them via its log knob; see :5326+)
        // assert update has {model: "opus-b", permissionMode: "plan", effort: "low"}
        // assert a binding row carries the same merged values.
    }

    #[tokio::test(flavor = "multi_thread")]
    async fn send_with_unchanged_settings_writes_no_session_update() {
        // create with model "opus-a"; send with settings {model: "opus-a"}
        // → exactly one frame on the fake's stdin log: the send.
    }
```

E2e-fake unit pin (in `fake-claude-sdk-sidecar-control.test.ts`, driving the fixture per its `launch()` helper):

```ts
it('session.update records setModel/setPermissionMode/applyFlagSettings-in-spirit and never crashes', async () => {
  const s = launch(/* minimal create+idle program per this file's existing programs */)
  s.send({ type: 'session.update', sessionId: '<created id>', model: 'm2', permissionMode: 'plan', effort: 'low' })
  // assert via the fixture's audit/log channel that the update was accepted
  // and a following send still flows (program continues).
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent claude::tests::send_with_changed_settings`

Expected: FAIL — today only the `send` frame is written (no `session.update`), and the binding row holds create-time values.

Run: `npm run test:e2e:helpers -- fake-claude-sdk-sidecar-control` (the helpers vitest config: `test/e2e-browser/vitest.config.ts`)

Expected: FAIL — the fixture has no `session.update` arm.

- [ ] **Step 3: Add the minimal production implementation**

`claude.rs` — in `handle_send` between the session-lookup and the `send` write (:1015-1019), guarded by `msg.settings`:

```rust
        // z7j7 / AGENT-12: per-send model/permissionMode/effort ride a sidecar
        // control frame (`session.update`, index.mjs) applied by the SDK before
        // the prompt. settings.cwd is create-scoped for claude and ignored here.
        if let Some(settings) = msg.settings.as_ref() {
            let merged_model = settings.model.clone().or_else(|| session.model.clone());
            let merged_perm = settings.permission_mode.clone().or_else(|| session.permission_mode.clone());
            let merged_effort = settings.effort.clone().or_else(|| session.effort.clone());
            let changed = merged_model != session.model
                || merged_perm != session.permission_mode
                || merged_effort != session.effort;
            if changed {
                let update = json!({
                    "type": "session.update",
                    "sessionId": session.sidecar_session_id,
                    "model": merged_model,
                    "permissionMode": merged_perm,
                    "effort": merged_effort,
                });
                if let Err(err) = write_line(&mut session.stdin, &update).await {
                    drop(guard);
                    undo_turn_op_arm(&in_turn, &turn_tracker, send_was_busy);
                    self.send_error(&request_id, "CLAUDE_SEND_FAILED", &err);
                    return;
                }
                session.model = merged_model;
                session.permission_mode = merged_perm;
                session.effort = merged_effort;
                // Re-snapshot the identity binding with the merged values via the
                // same sink call the create flow uses (:597-617 region / P1.13),
                // mirroring the opencode (:867-890) and codex (Task 6) behavior.
            }
        }
```

and the `ClaudeSession` struct gains:

```rust
    /// Current claude session settings baseline — seeded at create from the
    /// P1.13 settings snapshot; updated by per-send overlays (z7j7).
    model: Option<String>,
    permission_mode: Option<String>,
    effort: Option<String>,
```

(seeded at the create site from the same values the create frame carries.)

`index.mjs` — in the dispatch switch (:453-485):

```js
    case 'session.update': {
      const st = sessions.get(String(req.sessionId))
      if (!st?.query) { logerr(`session.update for unknown session: ${req.sessionId}`); break }
      try {
        if (req.model != null) await st.query.setModel(req.model)
        if (req.permissionMode != null) await st.query.setPermissionMode(req.permissionMode)
        if (req.effort != null) await st.query.applyFlagSettings({ effortLevel: req.effort })
      } catch (err) {
        // Emit through the file's existing session-error channel (same frame the
        // other handlers use — the Rust consumer folds it); never swallow.
        // eslint-disable-next-line no-undef — use the local emitter verbatim
        st.emitError?.(`session.update failed: ${err?.message ?? String(err)}`)
      }
      break
    }
```

(The exact session map name, `query` handle, and error-emitter come from the file's existing `handleSend`/`create` code — implementer copies the local idioms verbatim, keeps `logerr` for the unknown-session arm.)

E2e fake sidecar: mirror the same case (record into its audit log per its own knob conventions; continue the program).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent claude::tests` and `npm run test:e2e:helpers -- fake-claude-sdk-sidecar-control`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Comments cite the SDK pins and the create-frame naming precedent; `cargo clippy -p freshell-freshagent --all-targets -- -D warnings` clean; the sidecar package has no lint config — keep style consistent with the file.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent` plus `npm run test:e2e:helpers`

Expected: PASS — incl. the existing claude binding/resume/interrupt suites and the fixture control suite.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/claude.rs crates/freshell-claude-sidecar/index.mjs test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs test/e2e-browser/helpers/fake-claude-sdk-sidecar-control.test.ts
git commit -m "feat(rust): apply freshclaude/kilroy per-send settings via sidecar session.update (z7j7)"
```

### Task 8: Settings pickers tell the truth per provider (z7j7, client)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx` (claude/kilroy popover: the "Applies from the next message." caption currently exists only under the permission-mode select, :435-437 — add the same caption under the model radio list and the Thinking select)
- Test: `test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx`; `test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx` (pin the codex/opencode dialog footer copy if not already pinned)

**Interfaces:**
- Consumes: existing popover markup/styles (`:435-437` caption), `resolveFreshAgentType(sessionType)`, the `FreshAgentModelDialog` footer (:556).
- Produces: no prop/state changes — copy-only.

Why this is sufficient honesty: after Tasks 6-7, every visible setting on every provider applies per-send on the Rust server (codex: model/effort/sandbox-at-create + permission; claude/kilroy: model/effort/permission; opencode: model/effort — with opencode's permission select already hidden by `settingsVisibility`, :133, and its sandbox absence structural). Sandbox has no picker anywhere (codex panes stamp it at create from provider settings — honest by absence; the codex dialog footer says "applies from your next message", which is true of its model/effort controls). The static client registry remains the visibility source; no server capability field is added (Global Constraint 4). The Node server's claude adapter remains create-only, but the Node server is retired and out of scope (Constraint 3).

Recorded residual (load-bearing C2, accepted-path decision): claude mid-session control rests on the vendored SDK's control-request contract (`setModel`/`setPermissionMode`/`applyFlagSettings` await `control_response` and throw on rejection), but repo production code has not exercised it since 2026-06-15, and no test can prove the real claude CLI honors the requests (a live probe is out of read-only scope). The copy therefore states the SDK-contract truth; CLI-side failures are never silent — they surface through Task 7's timeout-guarded session-error frame.

- [ ] **Step 1: Write the failing behavioral test**

```tsx
// FreshAgentSettingsButton.test.tsx — store-backed render per this file's setup (:101-133)
it.each(['freshclaude', 'kilroy'] as const)('(%s) every picker row carries next-message copy', async (sessionType) => {
  renderPopoverFor(sessionType) // existing helper pattern in this file
  await userEvent.click(screen.getByRole('button', { name: /settings/i }))
  const captions = await screen.findAllByText('Applies from the next message.')
  expect(captions.length).toBe(3) // model list, Thinking select, permission select
})

// FreshAgentModelDialog.test.tsx — check-then-pin:
it.each(['freshcodex', 'freshopencode'] as const)('(%s) footer states when values apply', async (sessionType) => {
  render(<FreshAgentModelDialog /* per this file's per-sessionType describes */ sessionType={sessionType} … />)
  expect(screen.getByText(/applies from your next message/)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx`

Expected: FAIL — caption count is 1 (permission only), not 3.

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentSettingsButton.tsx`, directly under the model radio list block and under the Thinking select block, add the same caption element used at :435-437:

```tsx
          <p className="px-1 text-[11px] text-muted-foreground">Applies from the next message.</p>
```

(Duplicate the EXACT class list of the existing permission caption; if the three copies grate, extract a one-line local `<AppliesNote />` — your refactor judgment, same classes/text.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Only if the three-duplicate caption reads poorly (then the `<AppliesNote />` extraction); `npm run lint` clean.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentSettingsButton.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx test/unit/client/components/fresh-agent/FreshAgentModelDialog.test.tsx
git commit -m "feat(client): honest applies-from-next-message copy across fresh-agent settings pickers (z7j7)"
```

### Task 9: Rust-server e2e proof for attachments, diff/exec, and per-send settings

**Files:**
- Create: `test/e2e-browser/specs/freshagent-extras-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` — DUAL registration (validated C7): the spec regexp goes in BOTH `RUST_ONLY_SPECS` (:183+, excludes it from the match-all projects) AND the `rust-chromium` project's `testMatch` list (:368+) — without the second entry even the correct command matches zero tests
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (the REAL fixture path — validated C10; the `test/e2e-browser/fixtures/...` variant does not exist): one additive default-off knob, below
- Test: the spec itself

**Interfaces:**
- Consumes: `RustServer` (`test/e2e-browser/helpers/rust-server.js`), `TestHarness` + `fixtures.js` `test`/`expect`, the raw-WS `WsCapture` pattern and fixture wiring copied per the per-spec-ownership convention from `freshagent-settings-resume-rust.spec.ts` (helpers `:26-45`; claude fixture `test/e2e-browser/fixtures/fake-claude-sidecar.mjs`), and the REST-with-token precedent (`agent-checkpoint-rewind.spec.ts:301`).
- Produces: PW-RUST executable evidence for AGENT-11/12/13's validation bullets.

Codex fixture knob (C10, additivity-verified): in `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs`, inside the `successResult` `turn/start` arm (:307-323), before shaping, add exactly:

```js
if (typeof behavior.turnStartParamsLogPath === 'string' && behavior.turnStartParamsLogPath) {
  fs.mkdirSync(path.dirname(behavior.turnStartParamsLogPath), { recursive: true })
  fs.appendFileSync(behavior.turnStartParamsLogPath,
    JSON.stringify({ at: new Date().toISOString(), method: 'turn/start', threadId: params?.threadId ?? null, params }) + '\n', 'utf8')
}
```

Default-off, orthogonal to `recordTurns`; never touches `fake-turns/*.json` or the recorded-turn schema (its two consuming specs are unaffected); unknown behavior keys are inert. The spec passes an absolute path rooted in its own mkdtemp.

Design: drive the real Rust server binary directly (REST + raw WS, no browser page — the settings-resume spec's tests 1-3 precedent), plus ONE browser test for the composer loop.

1. **attachments (REST):** create a fresh-agent session fixture cwd; `POST /api/fresh-agent/attachments?name=note.txt` with raw bytes + token → 200 `{path, bytes}`; file exists under the harness's isolated `HOME/.freshell/attachments/` matching `/^[0-9a-f]{8}-note\.txt$/` with byte-equal contents; `../../etc/evil.txt` → basename `evil.txt` inside the dir; missing `name` → 400 `name query parameter required`; no token → 401.
2. **diff (REST):** mkdtemp + `git init` + commit `one\n` + overwrite `two\n`; `GET /diff?cwd&path=a.txt` → 200 containing `-one`/`+two`; nonexistent cwd → 400 `cwd does not exist: `; non-repo cwd → 500 prefix `git diff failed: `.
3. **exec (REST):** `{"command":"echo out; echo err 1>&2; exit 7"}` → `{output: "out\nerr", exitCode: 7, truncated: false}`; missing command → 400 `command is required`.
4. **codex per-send (WS):** hello → `freshAgent.create` (freshcodex, model A) → `freshAgent.send` plain → `freshAgent.send` with `settings{model:"small-model", effort:"low"}` → poll the fixture's `turnStartParamsLogPath` JSONL: row 1's `params.model` is A, row 2's `params.model`/`params.effort` are `small-model`/`low` (plus `sandboxPolicy`/`approvalPolicy` when the test sends them); a third plain send produces row 3 with the MERGED values (stickiness).
5. **claude per-send (WS):** create freshclaude → send with `settings{model:"opus-b", effort:"low"}` → the fake claude sidecar's recorded stdin shows a `session.update` carrying those values immediately before the `send`.
6. **composer loop (browser):** open the UI with the harness token, create a freshclaude pane (fake sidecar), attach a small text fixture via the file input (`setInputFiles`), chip becomes ready, send → the fake sidecar's received prompt contains `Attached files (read them from disk):` and the stored path; a >10 MiB synthetic file shows the limit error chip WITHOUT any upload request (assert no POST to `/attachments` fired).

- [ ] **Step 1: Write the failing spec**

Write the full spec (helpers copied per convention; exact frame builders from the donor specs). The FAILING driving assertion before Tasks 1-3/6-7 land would be 404s — but this task runs AFTER them, so:

- [ ] **Step 2: Run and verify the intended failure shape**

For TDD integrity of THIS task's new assertions (401-on-no-token, exact 400 strings, sidecar frame ordering), temporarily verify against the pre-fix behavior only if cheap (e.g. run the spec on a stash of Tasks 1-3); otherwise record that RED was demonstrated incrementally by Tasks 1-7's own RED steps and run the full spec as GREEN evidence here. State the choice in the implementer report.

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list test/e2e-browser/specs/freshagent-extras-rust.spec.ts` FIRST (defeats the zero-match trap: it must list ≥1 test), then `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/freshagent-extras-rust.spec.ts`

(Validated C7/C9: `npm run test:e2e:chromium -- <rust-only-spec>` collects ZERO tests for rust-only specs — the chromium project `testIgnore`s `RUST_ONLY_SPECS`. The `--project=rust-chromium` form above is the sanctioned house invocation; no package.json script exists for it.)

- [ ] **Step 3: Add the implementation**

The production code exists (Tasks 1-7); "implementation" here is the spec itself + its DUAL registration (C7):

```ts
// playwright.config.ts — in RUST_ONLY_SPECS (keeps match-all chromium off it),
// house comment style:
  // AGENT-11/12/13 (kata te1m/ekc6/z7j7): Rust-server extras routes +
  // per-send settings, wire-level through owned fixtures.
  /freshagent-extras-rust\.spec\.ts$/,
// AND the same regexp again in the rust-chromium project's testMatch list
// (:368+) — without this second entry the spec never runs.
```

- [ ] **Step 4: Run the focused spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/freshagent-extras-rust.spec.ts`

Expected: PASS (browser test included).

- [ ] **Step 5: Refactor while green**

Spec hygiene: helper copies carry their donor citations; no shared-state leaks (isolated HOMEs/cwds per test); the spec owns its fixtures.

- [ ] **Step 6: Run impacted-test verification**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts test/e2e-browser/specs/freshagent-extras-rust.spec.ts` and separately `npm run test:e2e:chromium -- test/e2e-browser/specs/fresh-agent.spec.ts` (the legacy fresh-agent spec stays on the chromium leg — it is NOT rust-only)

Expected: PASS — neighboring fresh-agent specs unaffected (the new routes/frames didn't disturb them).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/freshagent-extras-rust.spec.ts test/e2e-browser/playwright.config.ts test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs
git commit -m "test(e2e): rust-server proof of fresh-agent attachments, diff/exec, and per-send settings (AGENT-11/12/13)"
```

---

## Final gate (after the last task)

1. `cargo fmt --all --check`
2. `cargo clippy -p freshell-server -p freshell-freshagent --all-targets -- -D warnings`
3. `cargo test -p freshell-server` and `cargo test -p freshell-freshagent`
4. `npm run lint` and `npm run typecheck`
5. `npm test` — coordinated full suite (`FRESHELL_TEST_SUMMARY='freshagent-rust-parity final gate'`), green excluding the ledger-recorded pre-existing flake (Global Constraint 10; attribution only via a base_ref reproduction receipt).
6. Focused e2e set from Task 9 Step 6 (the validated `--project=rust-chromium` invocation for the rust-only specs; chromium leg for `fresh-agent.spec.ts`), green on the local backend (`FRESHELL_E2E_BACKEND` unset → local; do not switch backends).

## Load-bearing validation outcomes folded into this plan (Stage 2)

- C1/C3/C4/C5/C6 verified during exploration (axum route-scoped body limits; Node exec maxBuffer kill semantics incl. exitCode 1 from a non-numeric code; Node diff error-with-partial-stdout resolving 200; both Rust test seams adequate) — no plan change beyond what the tasks already say.
- C2 falsified as "production-proven": claude SDK control methods await `control_response` and throw on CLI rejection (observable), but have had no production callers since 2026-06-15 — Task 7 gained a bounded timeout + the accepted residual is recorded in Task 8.
- C7/C9: e2e commands and Task 9 registration corrected (dual registration, `--project=rust-chromium`, `--list` first-defeat).
- C8: Task 1 gained a router-level auth gate + the 401-before-413 ordering pin.
- C10: Task 9 gained the additive `turnStartParamsLogPath` fixture knob and the corrected fixture path.
