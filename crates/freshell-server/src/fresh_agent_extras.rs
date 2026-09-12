//! Fresh-agent extras routes — faithful ports of
//! `server/fresh-agent-extras-router.ts`:
//! - `GET /api/fresh-agent/diff` (:304-321) backed by `runGitDiff` (:48-59) —
//!   `git diff --no-color [-- <path>]` in the session cwd's OWN repo (never
//!   the checkpoint shadow repo), 512 KiB stdout cap, 15 s timeout.
//! - `POST /api/fresh-agent/exec` (:289-302) backed by `runCommand` (:26-46)
//!   — `bash -lc` (login shell) with inherited env, 30 s timeout, 200 KiB
//!   per-stream capture caps with kill-on-cap, `${stdout}\n${stderr}`.trim()
//!   combine, `\n[output truncated]` marker, exitCode = numeric code / 1 on
//!   any kill or spawn error. Never a 500: failures are a non-zero exitCode
//!   in a 200.
//!
//! Recorded parity divergences from the Node oracle:
//! - Query-string edge cases: an authenticated-but-malformed query string
//!   (invalid percent-encoding/UTF-8, duplicated params) is rejected by axum's
//!   `Query` extractor with a plain-text 400 BEFORE the handler — status
//!   parity with the oracle's pinned 400s, but the body shape diverges
//!   (consistent with this crate's other `Query` extractors, e.g.
//!   `checkpoints.rs`).
//! - Diff 500 detail suffix: Node's `git diff failed: <detail>` uses the
//!   execFile error text (`Command failed: …\n<stderr>`); this port uses
//!   git's stderr (trimmed), `git diff failed: timed out after 15s` on
//!   timeout, and `git exited without output` when git fails silently. The
//!   500 status, the `{error}` envelope, and the `git diff failed: ` prefix
//!   are pinned.
//! - Over-cap diffs (>512 KiB): Node's execFile maxBuffer KILLS git at
//!   ~512 KiB but still resolves 200 with the captured prefix; this port
//!   drains stdout to EOF (never killing, never deadlocking on a full pipe)
//!   and clips the buffer to exactly 512 KiB. The response contract
//!   (200-with-captured-prefix) is identical; only git's process lifetime
//!   differs.
//! - Exec JSON-body rejections (malformed JSON, non-JSON content type):
//!   express's `json()` leaves `req.body` undefined or routes through its
//!   HTML error page (status parity: 400); axum's `Json` extractor rejects
//!   BEFORE the handler with its own plain-text 400/415 body. A wrong
//!   content type is 400 `command is required` from Node vs 415 from axum.
//! - Exec truncation is measured in UTF-8 BYTES (`.len()`/
//!   `floor_char_boundary`) where Node uses UTF-16 code units
//!   (`String.length`/`slice`, which can split a surrogate pair). Identical
//!   for ASCII; multi-byte output can clip at a slightly different point.
//! - Exec timing on eternal-output commands (e.g. `yes`): Node's maxBuffer
//!   kill resolves promptly after the cap; this port's cap kill is prompt
//!   for ordinary pipelines (the dropped read end SIGPIPEs downstream
//!   writers), but a command producing output a reader can't saturate only
//!   resolves at the shared 30 s timeout. The response contract
//!   (prefix + marker + exitCode 1) is identical; only timing differs.
//! - Exec stdin is `Stdio::null()` where Node's `execFile` leaves the
//!   child's stdin an open pipe that nothing ever writes to or ends: a
//!   stdin-consuming one-liner (e.g. `cat`) gets instant EOF here (exitCode
//!   0, empty output) vs hanging until the 30 s timeout kill on Node
//!   (exitCode 1, empty output). Deliberate — no stdin producer exists, so
//!   hanging is never useful — but it diverges from the oracle on that edge
//!   (exitCode + timing).
//! - Exact-cap kill boundary: this port kills the moment a stream's buffer
//!   REACHES 200 KiB (`drain_exec_stream`, `>=`), while Node kills only when
//!   consumed bytes EXCEED maxBuffer (`>`). A run producing exactly 200 KiB
//!   on a stream can therefore return exitCode 0 on Node vs 1 here (when the
//!   `start_kill` lands ahead of the child's natural exit — race-dependent).
//!   `truncated` is identical (both `>= cap`). Boundary-only; recorded, not
//!   repaired.

use axum::{
    extract::{Query, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::Arc;

use crate::boot::{is_authed, unauthorized};

/// `DIFF_MAX_BYTES` / diff timeout (`fresh-agent-extras-router.ts:13, 52`).
const DIFF_MAX_BYTES: usize = 512 * 1024;
const DIFF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(15);

/// `EXEC_TIMEOUT_MS` / `EXEC_MAX_OUTPUT` (`fresh-agent-extras-router.ts:11-12`).
const EXEC_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
const EXEC_MAX_OUTPUT: usize = 200 * 1024;

#[derive(Clone)]
pub struct FreshAgentExtrasApiState {
    pub auth_token: Arc<String>,
    /// Resolved home (the `os.homedir()` analogue,
    /// `fresh-agent-extras-router.ts:291`): the exec route's cwd fallback
    /// when the request carries no usable `cwd`.
    pub home: Arc<PathBuf>,
}

pub fn router(state: FreshAgentExtrasApiState) -> Router {
    Router::new()
        .route("/api/fresh-agent/diff", get(get_diff))
        .route("/api/fresh-agent/exec", post(post_exec))
        // Node-ordering parity (validated C8, axum 0.8.9 + the main.rs
        // router-level layering precedent): a ROUTER-level auth gate
        // short-circuits BEFORE route extractors, so an unauthenticated
        // request the extractor would otherwise reject (wrong content type,
        // malformed JSON, an over-limit body under any future route-scoped
        // limit) gets 401 — mirroring the Node global httpAuthMiddleware
        // before the extras router's parsers (server/index.ts:210-213,
        // :832). The in-handler `is_authed` checks stay as
        // defense-in-depth. LAST call after all .route(...) registrations;
        // survives `.merge()`.
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

#[derive(serde::Deserialize)]
struct DiffQuery {
    cwd: Option<String>,
    path: Option<String>,
}

async fn get_diff(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Query(query): Query<DiffQuery>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `fresh-agent-extras-router.ts:305-314` (verbatim strings; `state.home`
    // is unused by diff — the cwd comes from the query).
    let cwd = match query.cwd.filter(|c| !c.is_empty()) {
        Some(c) => c,
        None => return bad_request("cwd query parameter required"),
    };
    if !std::path::Path::new(&cwd).exists() {
        return bad_request(&format!("cwd does not exist: {cwd}"));
    }
    // Node's truthiness gate (`fresh-agent-extras-router.ts:306`): an empty
    // `path` is absent, not `-- ""` (git rejects an empty pathspec).
    let path = query.path.as_deref().filter(|p| !p.is_empty());
    match run_git_diff(&cwd, path).await {
        Ok(diff) => Json(json!({ "diff": diff })).into_response(),
        Err(message) => {
            tracing::warn!(error = %message, "fresh_agent_extras.diff.failed");
            internal_error(message)
        }
    }
}

/// `POST /api/fresh-agent/exec` (`fresh-agent-extras-router.ts:289-302`).
/// Auth FIRST, then `command` validation BEFORE the cwd lookup — the Node
/// field order, observable when both are invalid.
async fn post_exec(
    State(state): State<FreshAgentExtrasApiState>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !is_authed(&headers, &state.auth_token) {
        return unauthorized();
    }
    // `fresh-agent-extras-router.ts:290-294`: non-string, missing, and
    // empty-after-trim all funnel into the one 400.
    let command = body
        .get("command")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|c| !c.is_empty());
    let Some(command) = command else {
        return bad_request("command is required");
    };
    // `:291`: a non-string or empty cwd falls back to the home (the
    // `os.homedir()` analogue) — it is never a 400 by itself.
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
    tracing::info!(
        exit_code = result.exit_code,
        truncated = result.truncated,
        "fresh_agent_extras.exec.completed"
    );
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

/// `runCommand` (`fresh-agent-extras-router.ts:26-46`): `bash -lc` (LOGIN
/// shell — profile init, never `-c` alone) with inherited env, 30 s timeout,
/// 200 KiB per-stream capture caps, combined
/// `${stdout}${stderr ? `\n${stderr}` : ''}`.trim(), slice+marker truncation,
/// exitCode = numeric child code / 1 on any kill or spawn error. Never a
/// 500: failures surface as a non-zero exitCode in a 200.
///
/// Kill semantics (pinned by Node's maxBuffer/timeout behavior):
/// - Kill on cap: Node's maxBuffer KILLS the child as a stream crosses the
///   cap, and that kill delivers a NON-numeric `error.code` → `exitCode: 1`.
///   Mirrored by `drain_exec_stream`, which kills the child at the cap.
/// - Kills keep captured output: on ANY kill (cap or timeout) the bytes
///   already captured flow through the same combine/trim/truncate rule, so a
///   killed run still returns its partial prefix. The shared
///   `Arc<Mutex<Vec<u8>>>` buffers survive the 30 s `tokio::time::timeout`
///   arm that takes the kill path, mirroring Node buffering up to the kill.
async fn run_command(command: &str, cwd: &str) -> ExecOutcome {
    let spawned = tokio::process::Command::new("bash")
        .arg("-lc")
        .arg(command)
        .current_dir(cwd)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn();
    let child = match spawned {
        Ok(c) => c,
        // Node surfaces spawn failure as exitCode 1 with empty output.
        Err(err) => {
            tracing::warn!(error = %err, "fresh_agent_extras.exec.spawn_failed");
            return ExecOutcome {
                output: String::new(),
                exit_code: 1,
                truncated: false,
            };
        }
    };
    let mut child = child;
    let out_pipe = child.stdout.take().expect("piped stdout");
    let err_pipe = child.stderr.take().expect("piped stderr");
    let child = std::sync::Arc::new(tokio::sync::Mutex::new(child));
    let out_buf = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let err_buf = std::sync::Arc::new(tokio::sync::Mutex::new(Vec::new()));

    let drains_then_wait = {
        let child = std::sync::Arc::clone(&child);
        let out_fut = drain_exec_stream(
            out_pipe,
            std::sync::Arc::clone(&out_buf),
            std::sync::Arc::clone(&child),
        );
        let err_fut = drain_exec_stream(
            err_pipe,
            std::sync::Arc::clone(&err_buf),
            std::sync::Arc::clone(&child),
        );
        async move {
            tokio::join!(out_fut, err_fut);
            let mut guard = child.lock().await;
            guard.wait().await.ok()
        }
    };
    let status = match tokio::time::timeout(EXEC_TIMEOUT, drains_then_wait).await {
        Ok(status) => status,
        Err(_) => {
            tracing::warn!("fresh_agent_extras.exec.timed_out");
            let mut guard = child.lock().await;
            let _ = guard.kill().await;
            None
        }
    };

    let out = std::mem::take(&mut *out_buf.lock().await);
    let err = std::mem::take(&mut *err_buf.lock().await);
    let stdout = String::from_utf8_lossy(&out);
    let stderr = String::from_utf8_lossy(&err);
    let combined = if stderr.is_empty() {
        stdout.into_owned()
    } else {
        format!("{stdout}\n{stderr}")
    }
    .trim()
    .to_string();
    let truncated = combined.len() >= EXEC_MAX_OUTPUT;
    let output = if truncated {
        let mut s = combined;
        // Never split a UTF-8 char (Node slices UTF-16 units; see the module
        // divergence list).
        s.truncate(s.floor_char_boundary(EXEC_MAX_OUTPUT));
        s.push_str("\n[output truncated]");
        s
    } else {
        combined
    };
    let exit_code = match status {
        Some(s) => s.code().map(i64::from).unwrap_or(1),
        None => 1,
    };
    ExecOutcome {
        output,
        exit_code,
        truncated,
    }
}

/// Drains one child stream into `buf`, keeping at most `EXEC_MAX_OUTPUT`
/// bytes (Node's maxBuffer prefix). Node's maxBuffer KILLS the child as a
/// stream crosses the cap; on reaching the cap this kills the child (a kill
/// has no numeric exit code → `exitCode: 1`, same as a timeout kill) and
/// returns, dropping the read end — orphaned pipeline stages (e.g. the `tr`
/// in `head | tr`) then die on SIGPIPE, so the sibling drain still sees a
/// prompt EOF instead of hanging to the 30 s timeout. Bytes captured before
/// the kill are kept for the combine step (see `run_command`).
async fn drain_exec_stream(
    mut pipe: impl tokio::io::AsyncRead + Unpin,
    buf: std::sync::Arc<tokio::sync::Mutex<Vec<u8>>>,
    child: std::sync::Arc<tokio::sync::Mutex<tokio::process::Child>>,
) {
    use tokio::io::AsyncReadExt as _;
    let mut chunk = [0u8; 8192];
    loop {
        match pipe.read(&mut chunk).await {
            Ok(0) | Err(_) => return,
            Ok(n) => {
                let at_cap = {
                    let mut guard = buf.lock().await;
                    let room = EXEC_MAX_OUTPUT.saturating_sub(guard.len());
                    guard.extend_from_slice(&chunk[..n.min(room)]);
                    guard.len() >= EXEC_MAX_OUTPUT
                };
                if at_cap {
                    tracing::warn!("fresh_agent_extras.exec.output_cap_reached");
                    let mut guard = child.lock().await;
                    let _ = guard.start_kill();
                    return;
                }
            }
        }
    }
}

/// `runGitDiff` (`fresh-agent-extras-router.ts:48-59`): `git diff --no-color
/// [-- <path>]`, 512 KiB stdout cap, 15 s timeout. The permissive branch is
/// the contract: error/kill WITH captured stdout resolves with that stdout;
/// only error-with-empty-stdout rejects (`git diff failed: <detail>`).
/// Recorded divergence: Node's detail is its execFile error text
/// (`Command failed: …\n<stderr>`); the port uses git's stderr (trimmed) with
/// the same `git diff failed: ` prefix. Node's `${stdout}` payload is
/// verbatim — no trim on the diff text.
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

    // Drain both streams concurrently (a full pipe never blocks the child);
    // stdout capped at DIFF_MAX_BYTES keeping the prefix (the permissive
    // branch), stderr small-capped for the error message only.
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
        let detail = if detail.is_empty() {
            "git exited without output".to_string()
        } else {
            detail
        };
        return Err(format!("git diff failed: {detail}"));
    }
    Ok(stdout_text)
}

fn bad_request(message: &str) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": message }))).into_response()
}

fn internal_error(message: String) -> Response {
    (
        StatusCode::INTERNAL_SERVER_ERROR,
        Json(json!({ "error": message })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::{header, Request};
    use serde_json::Value;
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
        let body = axum::body::to_bytes(resp.into_body(), usize::MAX)
            .await
            .unwrap();
        serde_json::from_slice(&body).unwrap()
    }

    /* ------------------------- GET /api/fresh-agent/diff ----------------- */

    fn git_repo_with_dirty_file() -> (tempfile::TempDir, std::path::PathBuf) {
        // git init && config && commit "one\n", then overwrite with "two\n".
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
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

    // Oracle `fresh-agent-extras.test.ts:117-150` "returns a diff payload for
    // a git repo cwd".
    #[tokio::test]
    async fn returns_unified_diff_for_dirty_file_and_scoped_path() {
        let (_d, repo) = git_repo_with_dirty_file();
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("a.txt")),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let diff = body_json(resp).await["diff"].as_str().unwrap().to_string();
        assert!(diff.contains("-one"), "{diff}");
        assert!(diff.contains("+two"), "{diff}");
    }

    #[tokio::test]
    async fn unknown_scoped_path_returns_empty_200() {
        let (_d, repo) = git_repo_with_dirty_file();
        let home = tempfile::tempdir().unwrap();
        // A scoped path with no changes (here: an unknown path) yields an
        // empty diff, and git exits 0 — `200 {"diff":""}` (a "500 on empty"
        // regression would fail this):
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, Some("does-not-exist.txt")),
        )
        .await;
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
            Query(DiffQuery {
                cwd: None,
                path: None,
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!("cwd query parameter required")
        );
        // Nonexistent cwd — Node :309-311 (verbatim message).
        let ghost = home.path().join("nope");
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&ghost, None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!(format!("cwd does not exist: {}", ghost.to_string_lossy()))
        );
    }

    #[tokio::test]
    async fn non_repo_cwd_is_a_500_with_the_oracle_prefix() {
        let not_repo = tempfile::tempdir().unwrap();
        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(not_repo.path(), None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let err = body_json(resp).await["error"].as_str().unwrap().to_string();
        assert!(err.starts_with("git diff failed: "), "{err}");
    }

    // Coverage pin for the over-cap permissive branch (Task 2 review,
    // Minor 1 — Node resolves 200-with-captured-prefix on its maxBuffer
    // kill, `fresh-agent-extras-router.ts:48-59`). A dirty diff LARGER than
    // the 512 KiB cap must return 200 with the clipped prefix — never a 500,
    // never the whole output — and the concurrent drain keeps the full pipe
    // from blocking git (without it the 15 s timeout would fire a 500
    // instead).
    #[tokio::test]
    async fn over_cap_diff_returns_200_with_clipped_prefix() {
        let dir = tempfile::tempdir().unwrap();
        let repo = dir.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        let run = |args: &[&str]| {
            let out = std::process::Command::new("git")
                .args(args)
                .current_dir(&repo)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "{args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        };
        run(&["init", "-q"]);
        run(&["config", "user.email", "t@t"]);
        run(&["config", "user.name", "t"]);
        // ~720 KB of DISTINCT lines (12 bytes each) so the diff of the
        // rewrite is ~1.4 MB — well over the 512 KiB cap.
        let original: String = (0..60_000).map(|i| format!("line-{i:06}\n")).collect();
        let rewritten: String = (0..60_000).map(|i| format!("LINE-{i:06}\n")).collect();
        std::fs::write(repo.join("big.txt"), &original).unwrap();
        run(&["add", "."]);
        run(&["commit", "-q", "-m", "init"]);
        std::fs::write(repo.join("big.txt"), &rewritten).unwrap();

        let home = tempfile::tempdir().unwrap();
        let resp = get_diff(
            State(state(home.path())),
            headers_with_token("tok"),
            diff_query(&repo, None),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let diff = body_json(resp).await["diff"].as_str().unwrap().to_string();
        assert!(!diff.is_empty());
        assert!(
            diff.len() <= DIFF_MAX_BYTES + 1024,
            "clipped at the cap (+ small tolerance): {} bytes",
            diff.len()
        );
        // Prefix-keeping: early removed lines survived the clip (a cap that
        // discarded the prefix would fail this).
        assert!(diff.contains("-line-000000"), "{:.200}", diff);
        assert!(diff.contains("-line-000100"), "{:.200}", diff);
    }

    #[tokio::test]
    async fn route_is_wired_at_api_fresh_agent_diff() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        let resp = app
            .oneshot(
                Request::builder()
                    .method("GET")
                    .uri("/api/fresh-agent/diff")
                    .header("x-auth-token", "tok")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    }

    /* ------------------------- POST /api/fresh-agent/exec ---------------- */

    async fn post_exec_authed(home: &std::path::Path, body: Value) -> Response {
        post_exec(State(state(home)), headers_with_token("tok"), Json(body)).await
    }

    // Oracle `fresh-agent-extras.test.ts:84-94` happy path, made exact:
    // stdout and stderr fold into `${stdout}\n${stderr}`.trim() — stdout
    // first, exactly one newline between, stream contents verbatim. (printf
    // emits no trailing newline so the combined form has no blank line.)
    #[tokio::test]
    async fn exec_runs_command_and_combines_streams() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(
            home.path(),
            json!({
                "command": "printf out; printf err 1>&2",
                "cwd": home.path().to_string_lossy(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["output"], json!("out\nerr"));
        assert_eq!(v["exitCode"], json!(0));
        assert_eq!(v["truncated"], json!(false));
    }

    // The combine rule is verbatim per-stream (NO per-stream trim): echo's
    // trailing newlines survive as a blank line between the streams, and only
    // the final combined string is trimmed (oracle :34).
    #[tokio::test]
    async fn exec_folds_streams_verbatim_without_per_stream_trims() {
        let home = tempfile::tempdir().unwrap();
        let resp =
            post_exec_authed(home.path(), json!({ "command": "echo out; echo err 1>&2" })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["output"], json!("out\n\nerr"));
    }

    // Oracle `fresh-agent-extras.test.ts:96-103` — non-zero exit is a 200
    // with the numeric code (never a 500).
    #[tokio::test]
    async fn exec_reports_nonzero_exit_code() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({ "command": "exit 7" })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["exitCode"], json!(7));
        assert_eq!(v["output"], json!(""));
    }

    // Oracle :289-298 (verbatim strings): missing/blank command is checked
    // BEFORE the cwd lookup; a nonexistent cwd names the cwd in the error.
    #[tokio::test]
    async fn exec_rejects_missing_command_and_bad_cwd() {
        let home = tempfile::tempdir().unwrap();
        for body in [json!({}), json!({ "command": "   " })] {
            let resp = post_exec_authed(home.path(), body).await;
            assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
            assert_eq!(body_json(resp).await["error"], json!("command is required"));
        }
        let ghost = home.path().join("nope");
        let resp = post_exec_authed(
            home.path(),
            json!({
                "command": "true",
                "cwd": ghost.to_string_lossy(),
            }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
        assert_eq!(
            body_json(resp).await["error"],
            json!(format!("cwd does not exist: {}", ghost.to_string_lossy()))
        );
    }

    // The cwd default is the state's home (the `os.homedir()` analogue,
    // oracle :291) — not the server process's cwd.
    #[tokio::test]
    async fn exec_defaults_to_the_state_home_cwd() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(home.path(), json!({ "command": "pwd" })).await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        let expected = std::fs::canonicalize(home.path()).unwrap();
        assert_eq!(v["output"], json!(expected.to_string_lossy()));
    }

    // Oracle :36-43 — a stream crossing the 200 KiB cap kills the child
    // (Node's maxBuffer kill → non-numeric code → exitCode 1), keeps the
    // captured prefix, and slices the trimmed combination to the cap plus
    // the marker.
    #[tokio::test]
    async fn exec_truncates_oversized_output() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(
            home.path(),
            json!({
                "command": "head -c 300000 /dev/zero | tr '\\0' 'a'",
            }),
        )
        .await;
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
        let resp = app
            .oneshot(
                Request::builder()
                    .method("POST")
                    .uri("/api/fresh-agent/exec")
                    .header("x-auth-token", "tok")
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(axum::body::Body::from(r#"{"command":"true"}"#))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    // Exec-specific auth-ordering pin (Task 3 review, Nit 5a): the exec
    // route is registered BEFORE the router-level `.layer(...)`, so the auth
    // gate short-circuits BEFORE the `Json` extractor — an UNAUTHENTICATED
    // request the extractor would otherwise reject (wrong content type →
    // 415, malformed JSON → 400) must be 401, mirroring the Node global
    // httpAuthMiddleware's run-before-parsers ordering on this same router
    // instance. With the route registered after the layer, both requests
    // below would surface the extractor's rejection instead.
    #[tokio::test]
    async fn unauthenticated_exec_is_401_before_json_extraction() {
        let home = tempfile::tempdir().unwrap();
        let app = router(state(home.path()));
        for (content_type, body) in [("text/plain", "{}"), ("application/json", "{not json")] {
            let resp = app
                .clone()
                .oneshot(
                    Request::builder()
                        .method("POST")
                        .uri("/api/fresh-agent/exec")
                        .header(header::CONTENT_TYPE, content_type)
                        .body(axum::body::Body::from(body))
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(
                resp.status(),
                StatusCode::UNAUTHORIZED,
                "content-type {content_type} must be 401 before extractor rejection"
            );
            assert_eq!(body_json(resp).await["error"], json!("Unauthorized"));
        }
    }

    // `floor_char_boundary` pin (Task 3 review, Nit 5b): the cap slice is in
    // UTF-8 BYTES and `String::truncate` PANICS off a char boundary, so the
    // slice must clip down to the char floor (the recorded divergence from
    // Node's UTF-16-unit slicing). The producer emits 1 ASCII byte then
    // 2-byte `é`s, so byte offset `EXEC_MAX_OUTPUT` (204800) is the SECOND
    // byte of an `é` — the slice must floor to 204799, never panic.
    #[tokio::test]
    async fn exec_truncation_clips_to_the_char_floor_on_multibyte_output() {
        let home = tempfile::tempdir().unwrap();
        let resp = post_exec_authed(
            home.path(),
            json!({ "command": "printf a; printf 'é%.0s' {1..150000}" }),
        )
        .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let v = body_json(resp).await;
        assert_eq!(v["truncated"], json!(true));
        // Cap-kill → exitCode 1, same as the ASCII oversize pin.
        assert_eq!(v["exitCode"], json!(1));
        let output = v["output"].as_str().unwrap();
        let prefix = output.strip_suffix("\n[output truncated]").unwrap();
        // The floor clip lands strictly BELOW the byte cap: 1 `a` plus
        // 102399 `é`s = 204799 bytes. An unfloored `truncate(204800)` would
        // panic the handler; this length is only reachable via the floor.
        assert_eq!(prefix.len(), EXEC_MAX_OUTPUT - 1);
        assert!(prefix.starts_with('a'));
        assert!(prefix.ends_with('é'));
    }
}
