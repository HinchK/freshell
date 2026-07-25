# Codex Identity Capture + Claude Restore Fail-Loud (P0.3 + P0.4) Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Two related fixes to the Rust freshell server's `terminal.create` path: (P0.3) wire server-side capture of a codex terminal's session identity from the client's `terminal.codex.candidate.persisted` frame, behind four mandatory guards; (P0.4) make a claude `restore:true` create with no resolvable resume id fail loudly with `error{RESTORE_UNAVAILABLE}` instead of silently spawning a permanently un-resumable claude.

**Architecture:** P0.3 adds a new crate-private module `crates/freshell-ws/src/codex_candidate.rs` (mirroring `opencode_association.rs`'s bind + broadcast shape) plus a one-arm dispatch wire-up in `terminal.rs`. P0.4 adds a server-side resolution ladder (in-process identity registry via createRequestId lineage — the durable ledger rung comes in a later slice) and a fail-loud reject inside `handle_create`'s existing claude branch. No protocol changes: every message, struct, and error code involved already exists in `freshell-protocol`.

**Tech Stack:** Rust (axum WebSocket server, tokio), `freshell-ws` / `freshell-terminal` / `freshell-protocol` crates, integration tests via real server + `tokio_tungstenite` client + fake CLI scripts (the crate's established harness).

**Reference campaign plan:** `/home/dan/code/freshell/docs/plans/2026-07-24-restart-resilience-architecture-analysis.md` (UNTRACKED on main — read via absolute path, do NOT commit it). Relevant sections: §2.2 (P0.4), §2.3/§2.3.1 (P0.3 guards), §4.1 (principles: never silently fresh, never silently wrong, never ask when we can act).

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/codex-identity-claude-restore`, branch `fix/codex-identity-claude-restore` (already created from `origin/main`; base suite verified green by the workspace stage). All paths below are relative to the worktree root.
- Rust-only slice: do NOT modify the frozen TS client (`src/`), the legacy Node server (`server/`), or `shared/`.
- Do not touch gemini/kimi code paths. P0.4's new branch must be gated `mode == "claude"` exactly.
- MERGE-CONFLICT AVOIDANCE: another agent's un-merged branch (`fix/claude-attach-lost-session`) modified the `FreshAgent*` dispatch arms in `crates/freshell-ws/src/terminal.rs` (currently lines ~521–623). Make no edits inside that region; our new dispatch arm goes right after the `TerminalCreate` arm (~line 470–472), well above it.
- Error contract (pinned by tests): code string exactly `RESTORE_UNAVAILABLE` (serde `SCREAMING_SNAKE_CASE` of `ErrorCode::RestoreUnavailable`, already declared in `crates/freshell-protocol/src/common.rs:71-97`); message exactly `Restore requires a canonical session reference.` (Node parity: `server/ws-handler.ts:2130-2159`). The frozen client parses this code (`shared/ws-protocol.ts:27`) and handles the frame in its generic in-flight-create error handler (`src/components/TerminalView.tsx:3995` — matches ANY code gated on `msg.requestId`), showing `[Restore failed] <message>` — identical to today's Node behavior.
- A candidate frame failing ANY guard is logged at WARN and ignored — NEVER adopted, and NOTHING is sent back to the client (legacy parity: `server/ws-handler.ts:2951-2963` sends nothing on failure).
- Fresh (non-restore) claude creates keep today's t=0 `--session-id` pre-allocation behavior unchanged; goldens in `crates/freshell-platform/src/cli_launch_goldens.rs` must stay green (we do not touch `freshell-platform` at all).
- Client-supplied paths are NEVER trusted raw: rollout verification must canonicalize (resolving `..` and symlinks) and enforce containment under the codex sessions root.
- Repo rules (AGENTS.md): Red-Green-Refactor TDD; NEVER restart the user's self-hosted freshell server; NEVER use broad kill patterns; tests bind ephemeral loopback ports only (`127.0.0.1:0`).
- PR policy: PR creation is NOT user-approved. Final task ends with commit + push + STOP (no `gh pr create`).
- Line numbers in this plan were verified on this branch at plan time but WILL drift as tasks land; always locate by the quoted code, not the number.

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `crates/freshell-ws/src/codex_candidate.rs` | **Create** | P0.3: guards + bind + broadcast for `terminal.codex.candidate.persisted`; pure disk-truth verifier with unit tests |
| `crates/freshell-ws/src/lib.rs` | Modify (~line 28) | register `pub(crate) mod codex_candidate;` |
| `crates/freshell-ws/src/terminal.rs` | Modify (~line 473, ~line 995, +1 helper fn) | P0.3 dispatch arm; P0.4 resolution ladder + fail-loud reject in `handle_create` |
| `crates/freshell-ws/src/invariants.rs` | Modify (append) | P0.4: `error_claude_restore_unresolved` structured ERROR emitter + capture-harness unit test |
| `crates/freshell-ws/tests/common/mod.rs` | Modify | extract `spawn_server_with_specs` so tests can inject a codex CLI spec |
| `crates/freshell-ws/tests/codex_candidate_persisted.rs` | **Create** | P0.3 integration: all four guards, hijack, stale replay, happy path binds + broadcasts + resume argv |
| `crates/freshell-ws/tests/claude_restore_unavailable.rs` | **Create** | P0.4 integration: pinned resume, server-side resolution, fail-loud reject with no spawn |

Sequencing: P0.3 (Tasks 1–2) then P0.4 (Tasks 3–4), then verification (Task 5). Each task is an independent commit.

---

### Task 1: P0.3 — rollout disk-truth verifier (pure function, unit-tested)

**Files:**
- Create: `crates/freshell-ws/src/codex_candidate.rs`
- Modify: `crates/freshell-ws/src/lib.rs` (module registration, next to `pub(crate) mod invariants;` at ~line 28)
- Test: in-module `#[cfg(test)]` in `codex_candidate.rs`

**Interfaces:**
- Consumes: nothing from other tasks (std only; `tempfile` is already a `freshell-ws` dev-dependency).
- Produces (Task 2 relies on these exact signatures):
  - `pub(crate) fn verify_rollout_path(rollout_path: &str, sessions_root: &Path, thread_id: &str) -> Result<(), &'static str>`
  - `pub(crate) fn is_uuid_shaped(s: &str) -> bool`

- [ ] **Step 1: Create the module skeleton and register it**

Create `crates/freshell-ws/src/codex_candidate.rs`:

```rust
//! P0.3 (campaign plan §2.3.1): server-side capture of a codex terminal's
//! session identity from the client's `terminal.codex.candidate.persisted`
//! frame -- guarded so identity never becomes client-writable.
//!
//! Four guards; a candidate failing ANY check is logged at WARN and ignored
//! (never adopted, and nothing is sent back -- legacy parity with
//! `server/ws-handler.ts:2951-2963`):
//!   1. the terminalId exists in the registry
//!   2. that terminal is codex-mode
//!   3. the claimed thread id is not already bound to a DIFFERENT terminal
//!      (cross-pane hijack) and the terminal is not already bound to a
//!      DIFFERENT thread id (stale replay)
//!   4. disk truth: the rolloutPath canonicalizes under the codex sessions
//!      root, stats, and carries the claimed thread id

use std::path::Path;

/// Codex thread ids are bare hyphenated UUIDs. Cheap shape check so an empty
/// or junk id can never substring-match everything in the disk guard.
pub(crate) fn is_uuid_shaped(s: &str) -> bool {
    s.len() == 36
        && s.chars().enumerate().all(|(i, c)| match i {
            8 | 13 | 18 | 23 => c == '-',
            _ => c.is_ascii_hexdigit(),
        })
}

/// Guard 4 (disk truth). Client-supplied paths are NEVER trusted raw:
/// `fs::canonicalize` both sides (stats the file and resolves `..` and
/// symlinks, so traversal and symlink escapes fail containment), require the
/// rollout to live under the sessions root, and require the claimed thread id
/// to appear in the rollout filename (`rollout-<ts>-<threadId>.jsonl`;
/// filename match is acceptable verification) or, failing that, in the file
/// contents.
pub(crate) fn verify_rollout_path(
    rollout_path: &str,
    sessions_root: &Path,
    thread_id: &str,
) -> Result<(), &'static str> {
    let root = std::fs::canonicalize(sessions_root).map_err(|_| "sessions_root_missing")?;
    let rollout = std::fs::canonicalize(rollout_path).map_err(|_| "rollout_missing")?;
    if !rollout.starts_with(&root) {
        return Err("rollout_outside_sessions_root");
    }
    if !rollout.is_file() {
        return Err("rollout_not_a_file");
    }
    let file_name = rollout.file_name().and_then(|n| n.to_str()).unwrap_or("");
    if file_name.contains(thread_id) {
        return Ok(());
    }
    let contents = std::fs::read_to_string(&rollout).map_err(|_| "rollout_unreadable")?;
    if contents.contains(thread_id) {
        return Ok(());
    }
    Err("thread_id_not_in_rollout")
}
```

In `crates/freshell-ws/src/lib.rs`, next to the existing `pub(crate) mod invariants;` (~line 28), add:

```rust
pub(crate) mod codex_candidate;
```

- [ ] **Step 2: Write the failing unit tests**

Append to `crates/freshell-ws/src/codex_candidate.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    const TID: &str = "0192aaaa-bbbb-cccc-dddd-eeeeffff0001";

    fn root_with_rollout(file_name: &str, contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let sessions = dir.path().join("sessions").join("2026").join("07").join("24");
        std::fs::create_dir_all(&sessions).expect("mkdir sessions tree");
        let rollout = sessions.join(file_name);
        std::fs::write(&rollout, contents).expect("write rollout");
        (dir, rollout)
    }

    #[test]
    fn uuid_shape_accepts_canonical_and_rejects_junk() {
        assert!(is_uuid_shaped(TID));
        assert!(!is_uuid_shaped(""));
        assert!(!is_uuid_shaped("not-a-uuid"));
        assert!(!is_uuid_shaped("0192aaaa-bbbb-cccc-dddd-eeeeffff000")); // 35 chars
        assert!(!is_uuid_shaped("0192aaaa+bbbb+cccc+dddd+eeeeffff0001")); // wrong separators
    }

    #[test]
    fn accepts_rollout_with_thread_id_in_filename() {
        let (dir, rollout) = root_with_rollout(&format!("rollout-2026-07-24T12-00-00-{TID}.jsonl"), "{}");
        let root = dir.path().join("sessions");
        assert_eq!(verify_rollout_path(rollout.to_str().unwrap(), &root, TID), Ok(()));
    }

    #[test]
    fn accepts_rollout_with_thread_id_only_in_contents() {
        let (dir, rollout) =
            root_with_rollout("rollout-2026-07-24T12-00-00-other.jsonl", &format!("{{\"id\":\"{TID}\"}}\n"));
        let root = dir.path().join("sessions");
        assert_eq!(verify_rollout_path(rollout.to_str().unwrap(), &root, TID), Ok(()));
    }

    #[test]
    fn rejects_nonexistent_rollout() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("sessions");
        std::fs::create_dir_all(&root).unwrap();
        let missing = root.join(format!("rollout-{TID}.jsonl"));
        assert_eq!(
            verify_rollout_path(missing.to_str().unwrap(), &root, TID),
            Err("rollout_missing")
        );
    }

    #[test]
    fn rejects_rollout_outside_sessions_root() {
        let (dir, _rollout) = root_with_rollout(&format!("rollout-{TID}.jsonl"), "{}");
        let root = dir.path().join("sessions");
        // A real file that exists but lives OUTSIDE the root.
        let outside = dir.path().join(format!("rollout-{TID}.jsonl"));
        std::fs::write(&outside, "{}").unwrap();
        assert_eq!(
            verify_rollout_path(outside.to_str().unwrap(), &root, TID),
            Err("rollout_outside_sessions_root")
        );
    }

    #[test]
    fn rejects_dotdot_traversal_escape() {
        let (dir, _rollout) = root_with_rollout(&format!("rollout-{TID}.jsonl"), "{}");
        let root = dir.path().join("sessions");
        let outside = dir.path().join(format!("escape-{TID}.jsonl"));
        std::fs::write(&outside, "{}").unwrap();
        // Path is SPELLED under the root but traverses out; canonicalize resolves it.
        let sneaky = root.join("..").join(format!("escape-{TID}.jsonl"));
        assert_eq!(
            verify_rollout_path(sneaky.to_str().unwrap(), &root, TID),
            Err("rollout_outside_sessions_root")
        );
    }

    #[cfg(unix)]
    #[test]
    fn rejects_symlink_escape() {
        let (dir, _rollout) = root_with_rollout(&format!("rollout-{TID}.jsonl"), "{}");
        let root = dir.path().join("sessions");
        let outside = dir.path().join(format!("target-{TID}.jsonl"));
        std::fs::write(&outside, "{}").unwrap();
        let link = root.join(format!("rollout-link-{TID}.jsonl"));
        std::os::unix::fs::symlink(&outside, &link).expect("symlink");
        assert_eq!(
            verify_rollout_path(link.to_str().unwrap(), &root, TID),
            Err("rollout_outside_sessions_root")
        );
    }

    #[test]
    fn rejects_rollout_that_never_mentions_thread_id() {
        let (dir, rollout) = root_with_rollout("rollout-2026-07-24T12-00-00-other.jsonl", "{}\n");
        let root = dir.path().join("sessions");
        assert_eq!(
            verify_rollout_path(rollout.to_str().unwrap(), &root, TID),
            Err("thread_id_not_in_rollout")
        );
    }
}
```

- [ ] **Step 3: Run the tests — RED then GREEN**

TDD note: write Step 2's tests FIRST against the skeleton with the two function bodies replaced by `unimplemented!()`, run to see them fail, then fill in the Step 1 bodies. If you created both together, verify RED by temporarily inverting one assertion instead — the point is proving the tests can fail.

Run: `cargo test -p freshell-ws --lib codex_candidate`
Expected: all 8 tests PASS (7 on non-unix).

- [ ] **Step 4: Quality gates**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/codex_candidate.rs crates/freshell-ws/src/lib.rs
git commit -m "feat(rust): add codex rollout disk-truth verifier (P0.3 guard 4)"
```

---

### Task 2: P0.3 — wire `terminal.codex.candidate.persisted` with the four guards

**Files:**
- Modify: `crates/freshell-ws/src/codex_candidate.rs` (handler + broadcast)
- Modify: `crates/freshell-ws/src/terminal.rs` (new dispatch arm immediately after the `ClientMessage::TerminalCreate` arm at ~470–472; NOT near the FreshAgent arms)
- Modify: `crates/freshell-ws/tests/common/mod.rs` (extract `spawn_server_with_specs`)
- Test: `crates/freshell-ws/tests/codex_candidate_persisted.rs` (create)

**Interfaces:**
- Consumes: Task 1's `verify_rollout_path` / `is_uuid_shaped`; existing `crate::WsState` (`state.registry: freshell_terminal::TerminalRegistry`, `state.identity: crate::identity::TerminalIdentityRegistry`, `state.broadcast_tx`); `crate::terminal::now_ms` (already `pub(crate)`, imported the same way `opencode_association.rs` does); protocol types `TerminalCodexCandidatePersisted { candidate_thread_id, captured_at, rollout_path, terminal_id }`, `TerminalSessionAssociated`, `TerminalMetaUpdated`, `TerminalMetaRecord`, `SessionLocator` (all exist in `freshell-protocol`; if any is not re-exported at the crate root, import via its `client_messages`/`server_messages` module path).
- Produces: `pub(crate) fn handle_codex_candidate_persisted(state: &WsState, msg: TerminalCodexCandidatePersisted)` (sync, infallible, no reply frame); the wire behavior that Task 5's verification and the campaign's later P1.12 locator work build on; `common::spawn_server_with_specs(cli_commands: Vec<freshell_platform::CliCommandSpec>) -> (String, TerminalRegistry)` for any future test.

- [ ] **Step 1: Write the failing integration test**

First, in `crates/freshell-ws/tests/common/mod.rs`, extract the server builder so a test can inject its own CLI specs. The existing `pub async fn spawn_server()` (currently `common/mod.rs:127-185`) hardcodes `cli_commands: Arc::new(vec![sleeper_cli_spec("amplifier"), sleeper_cli_spec("claude")])`. Change ONLY that:

```rust
pub async fn spawn_server() -> (String, freshell_terminal::TerminalRegistry) {
    spawn_server_with_specs(vec![sleeper_cli_spec("amplifier"), sleeper_cli_spec("claude")]).await
}

#[allow(dead_code)] // not every test binary uses the injectable variant
pub async fn spawn_server_with_specs(
    cli_commands: Vec<freshell_platform::CliCommandSpec>,
) -> (String, freshell_terminal::TerminalRegistry) {
    // <the ENTIRE former body of spawn_server, verbatim, with one change:>
    //     cli_commands: Arc::new(cli_commands),
    ...
}
```

Everything else in the former body (the `WsState` literal with all its fields, router, ephemeral `TcpListener::bind("127.0.0.1:0")`, `axum::serve` spawn, returning `(ws_url, registry)`) moves unchanged into `spawn_server_with_specs`.

Then create `crates/freshell-ws/tests/codex_candidate_persisted.rs`. It mutates process env (`CODEX_HOME`, `CODEX_ARGV_CAPTURE_PATH`), so — following the crate's established precedent in `crates/freshell-ws/tests/codex_session_ref_resume.rs` — it is ONE sequential multi-phase test fn. Copy the fake-codex argv-capture script writer from `codex_session_ref_resume.rs:85-103` (shown inline below).

```rust
//! P0.3 integration: `terminal.codex.candidate.persisted` handling.
//! Campaign plan §2.3.1: four guards; reject = WARN + ignore, nothing sent back.

mod common;

use common::{connect_and_capture_inventory, next_frame_of_type, sleeper_cli_spec, spawn_server_with_specs};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const THREAD_A: &str = "0192aaaa-bbbb-4ccc-8ddd-eeeeffff0001";
const THREAD_B: &str = "0192aaaa-bbbb-4ccc-8ddd-eeeeffff0002";

/// Fake codex: records argv to $CODEX_ARGV_CAPTURE_PATH (atomic tmp+mv) then
/// sleeps. Copied from tests/codex_session_ref_resume.rs:85-103.
fn write_fake_codex() -> std::path::PathBuf {
    let script_path = std::env::temp_dir().join(format!(
        "freshell-codex-candidate-fake-{}.sh",
        std::process::id()
    ));
    let script = "#!/bin/sh\n\
        printf '%s\\n' \"$@\" > \"$CODEX_ARGV_CAPTURE_PATH.tmp\"\n\
        mv \"$CODEX_ARGV_CAPTURE_PATH.tmp\" \"$CODEX_ARGV_CAPTURE_PATH\"\n\
        exec sleep 300\n";
    std::fs::write(&script_path, script).expect("write fake codex script");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&script_path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&script_path, perms).unwrap();
    }
    script_path
}

fn codex_capture_spec() -> freshell_platform::CliCommandSpec {
    freshell_platform::CliCommandSpec {
        name: "codex".to_string(),
        label: "Codex CLI".to_string(),
        env_var: None,
        default_cmd: write_fake_codex().to_string_lossy().to_string(),
        base_args: vec![],
        base_env: std::collections::BTreeMap::new(),
        // Real codex manifest shape: resume subcommand, no createSessionArgs.
        resume_args: Some(vec!["resume".to_string(), "{{sessionId}}".to_string()]),
        create_session_args: None,
        model_args: None,
        sandbox_args: None,
        permission_mode_args: None,
    }
}

fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|row| row.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

async fn send_create(ws: &mut common::TestWs, request_id: &str, mode: &str, extra: serde_json::Value) {
    let mut msg = json!({
        "type": "terminal.create",
        "requestId": request_id,
        "mode": mode,
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    });
    if let (Some(obj), Some(extra_obj)) = (msg.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_obj {
            obj.insert(k.clone(), v.clone());
        }
    }
    ws.send(WsMessage::Text(msg.to_string())).await.expect("send terminal.create");
}

async fn send_candidate(ws: &mut common::TestWs, terminal_id: &str, thread_id: &str, rollout_path: &str) {
    ws.send(WsMessage::Text(
        json!({
            "type": "terminal.codex.candidate.persisted",
            "terminalId": terminal_id,
            "candidateThreadId": thread_id,
            "rolloutPath": rollout_path,
            "capturedAt": 1_753_300_000_000i64,
        })
        .to_string(),
    ))
    .await
    .expect("send candidate");
    // Handler is synchronous in the dispatch loop; a ping round-trip proves
    // the frame was consumed before we assert on registry state.
    ws.send(WsMessage::Text(json!({"type": "ping"}).to_string())).await.expect("send ping");
    let _pong = next_frame_of_type(ws, "pong").await;
}

fn wait_for_captured_argv(path: &std::path::Path) -> Vec<String> {
    for _ in 0..100 {
        if let Ok(contents) = std::fs::read_to_string(path) {
            return contents.lines().map(str::to_string).collect();
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    panic!("fake codex never wrote argv capture at {}", path.display());
}

#[tokio::test(flavor = "multi_thread")]
#[cfg(unix)]
async fn codex_candidate_persisted_guards_and_happy_path() {
    // ---- env setup (single sequential test: this binary owns process env) ----
    let codex_home = tempfile::tempdir().expect("codex home");
    let sessions_day = codex_home.path().join("sessions").join("2026").join("07").join("24");
    std::fs::create_dir_all(&sessions_day).expect("sessions tree");
    std::env::set_var("CODEX_HOME", codex_home.path());
    std::env::remove_var("FRESHELL_CODEX_MANAGED_LAUNCH");
    let capture = std::env::temp_dir().join(format!("codex-candidate-argv-{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&capture);
    std::env::set_var("CODEX_ARGV_CAPTURE_PATH", &capture);

    let (url, registry) =
        spawn_server_with_specs(vec![sleeper_cli_spec("claude"), codex_capture_spec()]).await;
    let (mut ws, _inventory) = connect_and_capture_inventory(&url).await;

    // A codex terminal with NO identity yet (fresh create, no resume).
    send_create(&mut ws, "req-codex-cand-1", "codex", json!({})).await;
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let codex_tid = created["terminalId"].as_str().expect("terminalId").to_string();
    assert_eq!(registry_resume_id(&registry, &codex_tid), None, "fresh codex must start unbound");

    // A valid on-disk rollout for THREAD_A.
    let rollout_a = sessions_day.join(format!("rollout-2026-07-24T12-00-00-{THREAD_A}.jsonl"));
    std::fs::write(&rollout_a, format!("{{\"thread\":\"{THREAD_A}\"}}\n")).unwrap();
    let rollout_a = rollout_a.to_string_lossy().to_string();

    // ---- Guard 1: unknown terminal is ignored ----
    send_candidate(&mut ws, "no-such-terminal", THREAD_A, &rollout_a).await;
    assert_eq!(registry_resume_id(&registry, &codex_tid), None);

    // ---- Guard 2: non-codex terminal is ignored ----
    send_create(&mut ws, "req-claude-cand-1", "claude", json!({})).await;
    let claude_created = next_frame_of_type(&mut ws, "terminal.created").await;
    let claude_tid = claude_created["terminalId"].as_str().expect("terminalId").to_string();
    send_candidate(&mut ws, &claude_tid, THREAD_A, &rollout_a).await;
    assert_ne!(
        registry_resume_id(&registry, &claude_tid).as_deref(),
        Some(THREAD_A),
        "claude terminal must never adopt a codex candidate"
    );
    assert_eq!(registry_resume_id(&registry, &codex_tid), None);

    // ---- Guard 4: out-of-root rolloutPath is ignored ----
    let outside = std::env::temp_dir().join(format!("outside-rollout-{THREAD_A}.jsonl"));
    std::fs::write(&outside, format!("{THREAD_A}\n")).unwrap();
    send_candidate(&mut ws, &codex_tid, THREAD_A, &outside.to_string_lossy()).await;
    assert_eq!(registry_resume_id(&registry, &codex_tid), None);

    // ---- Guard 4: nonexistent rolloutPath is ignored ----
    let missing = sessions_day.join("rollout-nope.jsonl");
    send_candidate(&mut ws, &codex_tid, THREAD_A, &missing.to_string_lossy()).await;
    assert_eq!(registry_resume_id(&registry, &codex_tid), None);

    // ---- Happy path: binds both identity homes + broadcasts ----
    send_candidate(&mut ws, &codex_tid, THREAD_A, &rollout_a).await;
    assert_eq!(registry_resume_id(&registry, &codex_tid).as_deref(), Some(THREAD_A));
    let associated = next_frame_of_type(&mut ws, "terminal.session.associated").await;
    assert_eq!(associated["terminalId"], json!(codex_tid));
    assert_eq!(
        associated["sessionRef"],
        json!({ "provider": "codex", "sessionId": THREAD_A })
    );
    let meta = next_frame_of_type(&mut ws, "terminal.meta.updated").await;
    let upsert = &meta["upsert"][0];
    assert_eq!(upsert["terminalId"], json!(codex_tid));
    assert_eq!(upsert["provider"], json!("codex"));
    assert_eq!(upsert["sessionId"], json!(THREAD_A));

    // ---- Guard 3: cross-pane hijack -- THREAD_A is live-bound to codex_tid ----
    send_create(&mut ws, "req-codex-cand-2", "codex", json!({})).await;
    let created2 = next_frame_of_type(&mut ws, "terminal.created").await;
    let codex_tid2 = created2["terminalId"].as_str().expect("terminalId").to_string();
    send_candidate(&mut ws, &codex_tid2, THREAD_A, &rollout_a).await;
    assert_eq!(
        registry_resume_id(&registry, &codex_tid2),
        None,
        "a sessionRef bound to a different live terminal must never be adopted"
    );

    // ---- Guard 3: stale replayed candidate once a newer binding exists ----
    let rollout_b = sessions_day.join(format!("rollout-2026-07-24T13-00-00-{THREAD_B}.jsonl"));
    std::fs::write(&rollout_b, format!("{{\"thread\":\"{THREAD_B}\"}}\n")).unwrap();
    send_candidate(&mut ws, &codex_tid, THREAD_B, &rollout_b.to_string_lossy()).await;
    assert_eq!(
        registry_resume_id(&registry, &codex_tid).as_deref(),
        Some(THREAD_A),
        "an already-bound terminal must keep its binding; replayed/stale candidates are ignored"
    );

    // ---- Subsequent restore create builds `codex ... resume <id>` ----
    registry.kill(&codex_tid);
    let _ = std::fs::remove_file(&capture);
    send_create(
        &mut ws,
        "req-codex-cand-restore",
        "codex",
        json!({ "restore": true, "sessionRef": { "provider": "codex", "sessionId": THREAD_A } }),
    )
    .await;
    let restored = next_frame_of_type(&mut ws, "terminal.created").await;
    let restored_tid = restored["terminalId"].as_str().expect("terminalId").to_string();
    let argv = wait_for_captured_argv(&capture);
    let pos = argv.iter().position(|a| a == "resume");
    assert!(
        pos.is_some_and(|p| argv.get(p + 1).map(String::as_str) == Some(THREAD_A)),
        "restore create must spawn `codex ... resume {THREAD_A}`: {argv:?}"
    );

    registry.kill(&restored_tid);
    registry.kill(&codex_tid2);
    registry.kill(&claude_tid);
    std::env::remove_var("CODEX_HOME");
    std::env::remove_var("CODEX_ARGV_CAPTURE_PATH");
}
```

Adjust imports to what `common/mod.rs` actually exports (`TestWs` is the alias `connect_and_capture_inventory` returns; `next_frame_of_type` and `sleeper_cli_spec` are existing helpers). If the server answers `ping` with a different frame type than `pong`, match whatever `ClientMessage::Ping`'s handler (terminal.rs ~663) actually sends and use that type string in `send_candidate`'s round-trip.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p freshell-ws --test codex_candidate_persisted`
Expected: FAIL at the happy-path phase — `registry_resume_id(...) == Some(THREAD_A)` assertion fails (candidate frame currently falls through to `_ => true` at terminal.rs ~751 and is dropped), and `next_frame_of_type(ws, "terminal.session.associated")` would time out.

- [ ] **Step 3: Implement the handler**

Append to `crates/freshell-ws/src/codex_candidate.rs` (above the `#[cfg(test)]` module):

```rust
use std::path::PathBuf;

use freshell_protocol::{
    ServerMessage, SessionLocator, TerminalCodexCandidatePersisted, TerminalMetaRecord,
    TerminalMetaUpdated, TerminalSessionAssociated,
};

use crate::terminal::now_ms;
use crate::WsState;

/// `CODEX_HOME` env (non-empty) else `<HOME>/.codex`, then `/sessions` --
/// mirrors `freshell-server/src/session_directory.rs::codex_home` (which is
/// crate-private there; HOME only, never FRESHELL_HOME) joined with the
/// `sessions` dir the way `freshell_sessions::directory_index::CodexSource`
/// does.
fn codex_sessions_root() -> Option<PathBuf> {
    let home = match std::env::var("CODEX_HOME") {
        Ok(v) if !v.is_empty() => PathBuf::from(v),
        _ => {
            #[cfg(windows)]
            let base = std::env::var("USERPROFILE").ok()?;
            #[cfg(not(windows))]
            let base = std::env::var("HOME").ok()?;
            PathBuf::from(base).join(".codex")
        }
    };
    Some(home.join("sessions"))
}

/// Handle one `terminal.codex.candidate.persisted` frame. No reply frame on
/// any path; rejects are WARN logs, accepts bind BOTH identity homes and
/// broadcast (mirrors `opencode_association.rs`'s resolve path).
pub(crate) fn handle_codex_candidate_persisted(
    state: &WsState,
    msg: TerminalCodexCandidatePersisted,
) {
    let thread_id = msg.candidate_thread_id.as_str();
    if !is_uuid_shaped(thread_id) {
        tracing::warn!(
            terminal_id = %msg.terminal_id,
            candidate_thread_id = %thread_id,
            "codex_candidate_rejected: invalid_thread_id"
        );
        return;
    }
    // Guard 1: the terminal exists.
    let Some(row) = state.registry.probe(&msg.terminal_id) else {
        tracing::warn!(
            terminal_id = %msg.terminal_id,
            candidate_thread_id = %thread_id,
            "codex_candidate_rejected: terminal_missing"
        );
        return;
    };
    // Guard 2: the terminal is codex-mode.
    if row.mode != "codex" {
        tracing::warn!(
            terminal_id = %msg.terminal_id,
            mode = %row.mode,
            "codex_candidate_rejected: terminal_not_codex"
        );
        return;
    }
    // Guard 3a: the terminal is not already bound to a DIFFERENT session
    // (stale-replay defense; a re-announce of the SAME id is an idempotent
    // no-op -- the client re-sends on every durability update).
    if let Some(existing) = row.resume_session_id.as_deref().filter(|s| !s.is_empty()) {
        if existing != thread_id {
            tracing::warn!(
                terminal_id = %msg.terminal_id,
                candidate_thread_id = %thread_id,
                bound_session_id = %existing,
                "codex_candidate_rejected: terminal_already_bound"
            );
        }
        return;
    }
    // Guard 3b: the claimed session is not live-bound to a DIFFERENT terminal
    // (cross-pane hijack).
    if let Some(other) = state.identity.find_by_session("codex", thread_id) {
        if other.terminal_id != msg.terminal_id {
            tracing::warn!(
                terminal_id = %msg.terminal_id,
                candidate_thread_id = %thread_id,
                bound_terminal_id = %other.terminal_id,
                "codex_candidate_rejected: session_bound_elsewhere"
            );
            return;
        }
    }
    // Guard 4: disk truth.
    let Some(root) = codex_sessions_root() else {
        tracing::warn!(
            terminal_id = %msg.terminal_id,
            "codex_candidate_rejected: no_codex_sessions_root"
        );
        return;
    };
    if let Err(reason) = verify_rollout_path(&msg.rollout_path, &root, thread_id) {
        tracing::warn!(
            terminal_id = %msg.terminal_id,
            candidate_thread_id = %thread_id,
            rollout_path = %msg.rollout_path,
            "codex_candidate_rejected: {reason}"
        );
        return;
    }
    // Bind both identity homes (they have different consumers -- see
    // opencode_association.rs:135-148), then broadcast.
    state.identity.upsert(
        &msg.terminal_id,
        Some("codex"),
        Some(thread_id),
        row.cwd.as_deref(),
        now_ms(),
    );
    state.registry.set_meta(
        &msg.terminal_id,
        None,
        None,
        Some("codex".to_string()),
        Some(thread_id.to_string()),
    );
    broadcast_terminal_session_associated(state, &msg.terminal_id, thread_id, row.cwd.clone());
}

/// Fan `terminal.session.associated` + a `terminal.meta.updated` upsert to
/// every connection. Byte-for-byte the shape of
/// `opencode_association.rs::broadcast_terminal_session_associated` with
/// provider "codex".
fn broadcast_terminal_session_associated(
    state: &WsState,
    terminal_id: &str,
    session_id: &str,
    cwd: Option<String>,
) {
    let associated = ServerMessage::TerminalSessionAssociated(TerminalSessionAssociated {
        terminal_id: terminal_id.to_string(),
        session_ref: SessionLocator {
            provider: "codex".to_string(),
            session_id: session_id.to_string(),
        },
    });
    if let Ok(frame) = serde_json::to_string(&associated) {
        let _ = state.broadcast_tx.send(frame);
    }

    let meta = ServerMessage::TerminalMetaUpdated(TerminalMetaUpdated {
        remove: Vec::new(),
        upsert: vec![TerminalMetaRecord {
            terminal_id: terminal_id.to_string(),
            updated_at: now_ms(),
            branch: None,
            checkout_root: None,
            cwd,
            display_subdir: None,
            is_dirty: None,
            provider: Some("codex".to_string()),
            repo_root: None,
            session_id: Some(session_id.to_string()),
            token_usage: None,
        }],
    });
    if let Ok(frame) = serde_json::to_string(&meta) {
        let _ = state.broadcast_tx.send(frame);
    }
}
```

Wire the dispatch arm in `crates/freshell-ws/src/terminal.rs`, immediately after the `TerminalCreate` arm (currently 470–472):

```rust
        ClientMessage::TerminalCreate(create) => {
            handle_create(create, ws_tx, state, pane_reconcile_v1).await
        }
        // P0.3: server-side codex identity capture from the client's persisted
        // candidate -- guarded (campaign plan §2.3.1); rejects are logged and
        // ignored, never answered (legacy parity ws-handler.ts:2951-2963).
        ClientMessage::TerminalCodexCandidatePersisted(candidate) => {
            crate::codex_candidate::handle_codex_candidate_persisted(state, candidate);
            true
        }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p freshell-ws --test codex_candidate_persisted`
Expected: PASS.

Run: `cargo test -p freshell-ws`
Expected: full crate green (existing binaries — especially `codex_session_ref_resume`, `session_identity_frames` — unaffected).

- [ ] **Step 5: Quality gates and commit**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets -- -D warnings`
Expected: clean.

```bash
git add crates/freshell-ws/src/codex_candidate.rs crates/freshell-ws/src/terminal.rs \
        crates/freshell-ws/tests/common/mod.rs crates/freshell-ws/tests/codex_candidate_persisted.rs
git commit -m "feat(rust): wire terminal.codex.candidate.persisted with four binding guards (P0.3)"
```

---

### Task 3: P0.4 — `claude_restore_identity_unresolved` invariant ERROR emitter

**Files:**
- Modify: `crates/freshell-ws/src/invariants.rs` (append production fn + tests)
- Test: in-module, using the file's existing `CaptureLayer` tracing-capture harness (`invariants.rs:102–180`, filter helper at `:182–191`)

**Interfaces:**
- Consumes: nothing new.
- Produces (Task 4 calls this): `pub(crate) fn error_claude_restore_unresolved(request_id: &str)`.

- [ ] **Step 1: Write the failing test**

Append inside `invariants.rs`'s existing `#[cfg(test)]` module, reusing its capture harness exactly the way the existing cases at `:194`/`:224`/`:247`/`:262` do (same `CaptureLayer` + `tracing::subscriber::set_default` + events-filter idiom — copy the setup lines from the test at `:194`):

```rust
    #[test]
    fn error_claude_restore_unresolved_emits_on_invariants_target() {
        let (subscriber, events) = capture(); // the file's existing harness constructor
        let _guard = tracing::subscriber::set_default(subscriber);

        super::error_claude_restore_unresolved("req-lost-42");

        let captured = invariant_events(&events); // the file's existing filter helper
        assert_eq!(captured.len(), 1, "exactly one emission: {captured:?}");
        assert!(
            captured[0].message.starts_with("claude_restore_identity_unresolved:"),
            "message must lead with the grep-target invariant name: {}",
            captured[0].message
        );
        assert!(
            captured[0].fields.contains(&("request_id".to_string(), "req-lost-42".to_string()))
                || format!("{:?}", captured[0]).contains("req-lost-42"),
            "request_id must be a structured field: {:?}",
            captured[0]
        );
    }
```

Adapt the two helper names (`capture`, `invariant_events`) and the field-assertion shape to the file's actual harness API — mirror how the existing test at `invariants.rs:194` constructs and asserts; the assertions to keep are: exactly one event, on target `freshell_ws::invariants`, message prefix `claude_restore_identity_unresolved:`, `request_id` recorded.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p freshell-ws --lib invariants`
Expected: FAIL to compile — `error_claude_restore_unresolved` not defined.

- [ ] **Step 3: Implement the emitter**

Append to the production section of `crates/freshell-ws/src/invariants.rs` (after `warn_unresolved_terminal_identities`):

```rust
/// P0.4 fail-loud (campaign plan §2.2): a `restore:true` claude create carried
/// no client id AND no server-side identity source could resolve one -- an
/// invariant-violation ("never happens") state. The create is rejected with
/// `error{RESTORE_UNAVAILABLE}` instead of silently spawning claude with
/// neither `--session-id` nor `--resume` (an unidentifiable, permanently
/// un-resumable session). ERROR, not WARN: unlike the sweep alarms above,
/// this is a per-request hard failure the user sees. Grep target:
/// `claude_restore_identity_unresolved`.
pub(crate) fn error_claude_restore_unresolved(request_id: &str) {
    tracing::error!(
        target: "freshell_ws::invariants",
        request_id = %request_id,
        "claude_restore_identity_unresolved: restore:true claude create had no \
         sessionRef/resumeSessionId and no server-resolvable identity; rejected with \
         RESTORE_UNAVAILABLE instead of spawning an unidentifiable claude session"
    );
}
```

Note: if the `CaptureLayer` harness filters on level WARN specifically (check its `on_event`), it will still capture ERROR unless it filters exactly — adjust the harness's level filter to include ERROR if needed (widening the test harness is fine; do not weaken the production level).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p freshell-ws --lib invariants`
Expected: PASS (all existing invariants tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-ws/src/invariants.rs
git commit -m "feat(rust): add claude_restore_identity_unresolved invariant ERROR emitter (P0.4)"
```

---

### Task 4: P0.4 — claude restore-without-identity: server resolution, else fail loud

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs` (the resume-derivation `else` branch inside `handle_create`, currently lines 969–1008; plus one new helper fn near `terminal_meta_record_for_create`)
- Test: `crates/freshell-ws/tests/claude_restore_unavailable.rs` (create)

**Interfaces:**
- Consumes: Task 3's `crate::invariants::error_claude_restore_unresolved(&str)`; existing `send_create_error(ws_tx, ErrorCode, String, &str) -> bool` (terminal.rs ~1626); `ErrorCode::RestoreUnavailable` (already declared, never before emitted from terminal.rs); `state.registry.newest_by_create_request_id` / `.probe`; `state.identity.session_ref_for` (retired entries included — that is the point); test helpers from `tests/common/mod.rs` (`spawn_server`, `connect_and_capture_inventory`, `next_frame_of_type`, `session_ref_of`).
- Produces: the wire contract `error{code:"RESTORE_UNAVAILABLE", message:"Restore requires a canonical session reference.", requestId}` with NO pty spawned; `fn resolve_claude_restore_session_id(state: &WsState, create_request_id: &str) -> Option<String>`.

- [ ] **Step 1: Write the failing integration tests**

Create `crates/freshell-ws/tests/claude_restore_unavailable.rs`:

```rust
//! P0.4 integration (campaign plan §2.2): a claude `restore:true` create must
//! resume when an id is resolvable (client-supplied OR server-side lineage)
//! and fail LOUD -- error{RESTORE_UNAVAILABLE}, no pty -- when it is not.
//! Never a silent bare `claude` with neither --session-id nor --resume.

mod common;

use common::{connect_and_capture_inventory, next_frame_of_type, session_ref_of, spawn_server};
use futures_util::SinkExt;
use serde_json::json;
use tokio_tungstenite::tungstenite::Message as WsMessage;

const KNOWN_ID: &str = "11111111-2222-4333-8444-555566667777";

async fn send_create(ws: &mut common::TestWs, body: serde_json::Value) {
    ws.send(WsMessage::Text(body.to_string())).await.expect("send terminal.create");
}

fn registry_resume_id(
    registry: &freshell_terminal::TerminalRegistry,
    terminal_id: &str,
) -> Option<String> {
    registry
        .identity_probe_rows()
        .into_iter()
        .find(|row| row.terminal_id == terminal_id)
        .unwrap_or_else(|| panic!("registry must list {terminal_id}"))
        .resume_session_id
}

/// Pins EXISTING behavior: restore:true + sessionRef resumes with that id.
#[tokio::test]
async fn claude_restore_with_session_ref_resumes() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    send_create(&mut ws, json!({
        "type": "terminal.create",
        "requestId": "req-restore-ref-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true,
        "sessionRef": { "provider": "claude", "sessionId": KNOWN_ID },
    }))
    .await;

    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid = created["terminalId"].as_str().expect("terminalId").to_string();
    assert_eq!(
        session_ref_of(&created),
        Some(json!({ "provider": "claude", "sessionId": KNOWN_ID })),
        "restore-with-ref must carry the client's identity: {created}"
    );
    assert_eq!(registry_resume_id(&registry, &tid).as_deref(), Some(KNOWN_ID));
    registry.kill(&tid);
}

/// The server's own resolution ladder (this slice: in-process identity
/// registry via createRequestId lineage). A restore:true create with NO
/// client id, whose requestId lineage has a retired identity, resumes it
/// automatically -- no error, no user interaction.
#[tokio::test]
async fn claude_restore_without_id_resolves_from_request_lineage() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    // Generation 1: fresh claude (server preallocates a --session-id UUID).
    send_create(&mut ws, json!({
        "type": "terminal.create",
        "requestId": "req-lineage-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
    }))
    .await;
    let created = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid1 = created["terminalId"].as_str().expect("terminalId").to_string();
    let preallocated = session_ref_of(&created).expect("fresh claude carries sessionRef")["sessionId"]
        .as_str()
        .expect("sessionId")
        .to_string();
    registry.kill(&tid1); // pty exit retires (not removes) the identity

    // Generation 2: same requestId, restore:true, identity LOST client-side.
    send_create(&mut ws, json!({
        "type": "terminal.create",
        "requestId": "req-lineage-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true,
    }))
    .await;
    let restored = next_frame_of_type(&mut ws, "terminal.created").await;
    let tid2 = restored["terminalId"].as_str().expect("terminalId").to_string();
    assert_eq!(
        session_ref_of(&restored),
        Some(json!({ "provider": "claude", "sessionId": preallocated })),
        "server must auto-resume the lineage identity: {restored}"
    );
    assert_eq!(registry_resume_id(&registry, &tid2).as_deref(), Some(preallocated.as_str()));
    registry.kill(&tid2);
}

/// Genuinely unresolvable: error frame with the EXACT code + message the
/// frozen client handles (generic in-flight-create error handler,
/// TerminalView.tsx:3995; Node parity ws-handler.ts:2130-2159), and NO pty.
#[tokio::test]
async fn claude_restore_without_any_identity_is_rejected_loudly() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    send_create(&mut ws, json!({
        "type": "terminal.create",
        "requestId": "req-lost-1",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true,
    }))
    .await;

    let err = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err["code"], json!("RESTORE_UNAVAILABLE"), "exact wire code: {err}");
    assert_eq!(
        err["message"],
        json!("Restore requires a canonical session reference."),
        "Node-parity message: {err}"
    );
    assert_eq!(err["requestId"], json!("req-lost-1"), "reject must correlate: {err}");
    assert!(
        registry.identity_probe_rows().is_empty(),
        "NO pty may be spawned for an unresolvable restore"
    );

    // Provider-mismatched sessionRef is equally unresolvable (Node parity).
    send_create(&mut ws, json!({
        "type": "terminal.create",
        "requestId": "req-lost-2",
        "mode": "claude",
        "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true,
        "sessionRef": { "provider": "codex", "sessionId": KNOWN_ID },
    }))
    .await;
    let err2 = next_frame_of_type(&mut ws, "error").await;
    assert_eq!(err2["code"], json!("RESTORE_UNAVAILABLE"));
    assert_eq!(err2["requestId"], json!("req-lost-2"));
    assert!(registry.identity_probe_rows().is_empty());
}
```

- [ ] **Step 2: Run tests to verify the red/green split**

Run: `cargo test -p freshell-ws --test claude_restore_unavailable`
Expected: `claude_restore_with_session_ref_resumes` PASSES (pins existing behavior). The other two FAIL — today the bare-launch path spawns a claude with no identity: `session_ref_of(&restored)` is `None` in the lineage test, and the reject test times out waiting for an `error` frame (a `terminal.created` arrives instead) or fails the empty-registry assertion.

- [ ] **Step 3: Implement resolution + fail-loud reject**

In `crates/freshell-ws/src/terminal.rs`, add the helper near `terminal_meta_record_for_create` (~line 1456):

```rust
/// P0.4 server-side resolution ladder (campaign plan §2.2; this slice is
/// in-process only -- the durable-ledger and disk-scan rungs land in a later
/// slice). A `restore:true` claude create that carried no usable client id
/// gets one more chance: the newest terminal generation (INCLUDING exited)
/// for the same createRequestId, consulted in both identity homes -- the same
/// two-home precedence `reconcile.rs::resolve_authoritative_ref` uses.
fn resolve_claude_restore_session_id(state: &WsState, create_request_id: &str) -> Option<String> {
    let newest = state.registry.newest_by_create_request_id(create_request_id)?;
    if let Some(sref) = state.identity.session_ref_for(&newest) {
        // Retired entries included -- an exited claude's identity is exactly
        // what a same-lineage restore needs.
        return (sref.provider == "claude").then_some(sref.session_id);
    }
    // Registry-side identity home (REST-created resumes carry identity only
    // on the registry row).
    let row = state.registry.probe(&newest)?;
    if row.mode != "claude" {
        return None;
    }
    row.resume_session_id.filter(|s| !s.is_empty())
}
```

Then modify the resume-derivation `else` branch (the block quoted below currently ends `handle_create`'s lines 995–1007). Replace:

```rust
        } else {
            resume_session_id = requested_ref
                .map(|r| r.session_id.clone())
                .or_else(|| create.resume_session_id.clone())
                .filter(|s| !s.is_empty());
        }
```

(keeping the long legacy-derivation comment above the assignment exactly as it is) with:

```rust
        } else {
            resume_session_id = requested_ref
                .map(|r| r.session_id.clone())
                .or_else(|| create.resume_session_id.clone())
                .filter(|s| !s.is_empty());
            // P0.4 (campaign plan §2.2): a restore:true claude create with no
            // client-supplied id must NEVER silently launch a bare `claude`
            // (neither --resume nor --session-id => permanently un-resumable).
            // Try the server-side ladder; auto-resume on success (never ask);
            // reject loudly when nothing can resolve. Claude-only: gemini/kimi
            // behavior is deliberately untouched, and fresh (non-restore)
            // claude keeps the preallocation branch above.
            if mode == "claude" && create.restore == Some(true) && resume_session_id.is_none() {
                resume_session_id = resolve_claude_restore_session_id(state, &create.request_id);
                if resume_session_id.is_none() {
                    crate::invariants::error_claude_restore_unresolved(&create.request_id);
                    return send_create_error(
                        ws_tx,
                        ErrorCode::RestoreUnavailable,
                        // Node parity (`server/ws-handler.ts:2130-2159`): the
                        // frozen client's create-error handler shows
                        // "[Restore failed] <this message>".
                        "Restore requires a canonical session reference.".to_string(),
                        &create.request_id,
                    )
                    .await;
                }
            }
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p freshell-ws --test claude_restore_unavailable`
Expected: all 3 PASS.

Run: `cargo test -p freshell-ws --test session_identity_frames`
Expected: PASS — fresh-claude preallocation (`fresh_claude_create_frames_carry_preallocated_session_ref`) and the amplifier resume/shell-negative pins are untouched.

Run: `cargo test -p freshell-ws`
Expected: full crate green.

- [ ] **Step 5: Quality gates and commit**

Run: `cargo fmt --all && cargo clippy -p freshell-ws --all-targets -- -D warnings`
Expected: clean.

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/claude_restore_unavailable.rs
git commit -m "fix(rust): reject claude restore-without-identity with RESTORE_UNAVAILABLE instead of silent bare launch (P0.4)"
```

---

### Task 5: Full verification, push, STOP (no PR)

**Files:**
- No source changes expected. Fix-forward only if a suite reveals a defect (with its own focused commit).

**Interfaces:**
- Consumes: everything above.
- Produces: pushed branch `fix/codex-identity-claude-restore`; the report for the user (branch name + per-fix proving test names).

- [ ] **Step 1: Touched-crate cargo suites**

Run, from the worktree root:

```bash
cargo test -p freshell-ws
cargo test -p freshell-platform
cargo test -p freshell-protocol
```

Expected: all green. `freshell-platform` proves the argv goldens (G-C2 claude resume `--resume`, G-C3 claude fresh `--session-id`, G-X2 codex `resume <id>` last) did not regress — we made no `freshell-platform` change, so any failure here means environmental trouble, not our diff.

- [ ] **Step 2: Coordinated repo suite (AGENTS.md-mandated)**

```bash
npm run test:status
```

If another agent holds the coordinator gate, WAIT and re-run — do not bypass. If the baseline is not green/current, run the coordinated suite:

```bash
FRESHELL_TEST_SUMMARY=1 npm test
```

Expected: green (this slice changes no TS; the Node/Vitest suite is a no-regression check). NEVER restart the user's self-hosted freshell server; never use broad kill patterns to clean up.

- [ ] **Step 3: Push the branch and STOP**

```bash
git push -u origin fix/codex-identity-claude-restore
```

Do NOT run `gh pr create` — PR creation is not user-approved. Report:
- Branch: `fix/codex-identity-claude-restore`
- P0.3 proven by: `codex_candidate_persisted::codex_candidate_persisted_guards_and_happy_path` (all four guards, cross-pane hijack, stale replay, bind + `terminal.session.associated`/`terminal.meta.updated` broadcasts, and post-bind restore spawning `codex … resume <id>`) plus the `codex_candidate` unit tests (traversal/symlink/out-of-root/missing/id-mismatch).
- P0.4 proven by: `claude_restore_unavailable::claude_restore_with_session_ref_resumes` (pinned existing resume), `::claude_restore_without_id_resolves_from_request_lineage` (server auto-resolution), `::claude_restore_without_any_identity_is_rejected_loudly` (exact `RESTORE_UNAVAILABLE` frame, Node-parity message, no pty), `invariants::error_claude_restore_unresolved_emits_on_invariants_target`, and the untouched `session_identity_frames` + `cli_launch_goldens` pins for fresh-create preallocation.

---

## Self-Review Notes (performed at plan time)

**Spec coverage.** P0.3: message handled (Task 2 arm) ✓; identity registry upsert + registry `set_meta` mirroring the claude create path ✓; `terminal.session.associated` + `terminal.meta.updated` broadcasts mirroring `opencode_association.rs` ✓; all four §2.3.1 guards with WARN-and-ignore semantics ✓; all six mandated red tests present in Task 2's single sequential test (unknown terminal, non-codex terminal, hijack, out-of-root + nonexistent rollout, stale replay, happy path incl. resume argv) ✓. P0.4: server-first resolution (in-process registry via createRequestId lineage, both identity homes) ✓; auto-resume with no interaction ✓; `error{RESTORE_UNAVAILABLE}` + structured ERROR on the invariants target + no spawn when unresolvable ✓; error-code string verified against the frozen client (the client's `ErrorCode` enum includes `RESTORE_UNAVAILABLE`; its generic in-flight-create error handler at `TerminalView.tsx:3995` matches by `requestId` with any code — the Node server sends this identical frame today, so behavior parity is exact) and pinned in a test ✓; all four mandated tests present ✓; fresh-create preallocation and goldens pinned untouched ✓. Shared constraints: no gemini/kimi edits (claude-only gate), no TS edits, FreshAgent region untouched, PR stop honored ✓.

**Deviation from the task brief, deliberate:** the brief describes the client minting a fresh pane from the TerminalView 4026–4224 block on this error. Exploration showed that block keys on `INVALID_TERMINAL_ID` attach errors; a create-reject `error{RESTORE_UNAVAILABLE, requestId}` is instead consumed by the client's generic in-flight-create handler (`TerminalView.tsx:3995` — any code, requestId-gated), exactly as it consumes the legacy Node server's identical reject today (`ws-handler.ts:2130-2159`). Emitting `INVALID_TERMINAL_ID` instead would be wrong (that path requires a matching in-flight *attach*). The plan therefore pins Node parity — same code, same message, same client outcome as the production Node path.

**No silent deferrals.** The ledger/disk-scan rungs of the P0.4 ladder are explicitly out of scope per the campaign plan's own sequencing (§2.2: ledger is P1.8, a later slice) and the task brief ("a durable ledger comes in a later slice") — not a coverage gap of this plan. Everything user-facing in this slice lands with production behavior and real end-to-end tests (real server, real sockets, real ptys, real disk for guard 4).

**Type consistency.** `verify_rollout_path(&str, &Path, &str) -> Result<(), &'static str>` used identically in Tasks 1 and 2; `handle_codex_candidate_persisted(&WsState, TerminalCodexCandidatePersisted)` matches the Task 2 dispatch arm; `error_claude_restore_unresolved(&str)` matches Task 4's call; `resolve_claude_restore_session_id(&WsState, &str) -> Option<String>` assigned into the existing `resume_session_id: Option<String>`; `spawn_server_with_specs(Vec<CliCommandSpec>)` matches both definition and use; `registry_resume_id` helper duplicated per test binary by design (test binaries are separate crates; `common` stays minimal).
