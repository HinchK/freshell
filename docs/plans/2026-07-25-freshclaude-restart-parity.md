# Freshclaude/Kilroy Restart Parity Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Bring freshclaude/kilroy fresh-agent sessions to restart parity with codex: record the durable Claude UUID (`cliSessionId`) server-side, resume untracked sessions in place on `freshAgent.attach` (lost-frame only on positive denial), and serve chat-history snapshots from the on-disk Claude transcript instead of 503.

**Architecture:** Three server-side slices in `crates/freshell-freshagent` mirroring the codex reference (`codex.rs ensure_session_resumable`/`handle_attach`) and opencode's lost-vs-transport discipline. The snapshot adapter reads the isolated `CLAUDE_HOME/projects/*/<uuid>.jsonl` transcript directly (no sidecar burn — claude has no `thread/read` RPC; the legacy Node server's `extractChatMessagesFromJsonl` is the parsing precedent). The FROZEN client already sends everything needed: `freshAgent.attach` carries `resumeSessionId` (the Claude UUID) + `sessionRef`, and the snapshot fetch uses the UUID as `threadId`.

**Tech Stack:** Rust (tokio, axum, serde_json), Node (test fixtures only — the vendored sidecar needs NO production change), Playwright e2e, vitest (zod contract pin).

## Global Constraints

- **Worktree:** all work in `/home/dan/code/freshell/.worktrees/freshclaude-restart-parity`, branch `feat/freshclaude-restart-parity`, base `origin/main @ c491aee0`.
- **Scope fence (owned files):** `crates/freshell-freshagent/src/claude.rs`, `crates/freshell-freshagent/src/snapshot.rs`, a NEW `crates/freshell-freshagent/src/claude_snapshot.rs` (+ its `mod` line in `crates/freshell-freshagent/src/lib.rs`), `crates/freshell-claude-sidecar/index.mjs` (turns out: no change needed), the `FreshAgentAttach` claude arm in `crates/freshell-ws/src/terminal.rs` (turns out: dispatch already routes to `handle_attach` — no terminal.rs change needed), test files and fixtures.
- **Do NOT touch:** the `terminal.create` path in `terminal.rs` (Lane A3), `codex.rs`/`opencode_ws.rs` beyond reading, `tabs_persist*`/`tabs_snapshots` (A1/A6), `registry.rs` (A5), anything under client `src/` — **the frozen client must work UNCHANGED; if a client change seems required, STOP and report.** No kimi/gemini.
- **TDD:** Red-Green-Refactor at every step — run the failing test BEFORE implementing.
- **Tests/e2e:** e2e specs create their OWN `RustServer` instances on ephemeral ports (`findFreePort` inside the harness) — NEVER ports 3001/3002. Broad vitest runs go through the coordinator gate (`npm run test:status` first; set `FRESHELL_TEST_SUMMARY="freshclaude restart parity"`; WAIT if held — 5 sibling lanes run concurrently). Playwright is NOT coordinator-gated. Cargo has no repo-blessed wrapper — use `cargo test -p <crate>` directly.
- **Process safety:** NEVER restart the user's self-hosted server; NEVER broad kill patterns (`pkill node`, etc.). Disk ~36GB free — halt on ENOSPC rather than deleting outside the worktree.
- **PR policy: NOT approved.** Push the branch, STOP before `gh pr create`, report branch + proof.
- **Wire invariants (frozen client contract):** lost-session = `freshAgent.event` envelope with inner `{type:"freshAgent.error", code:"INVALID_SESSION_ID"}` and is emitted ONLY on positive denial (session provably gone) — a transport/spawn error must instead produce a top-level `error` ServerMessage with code string `CLAUDE_ATTACH_RESUME_FAILED` (mirrors `CODEX_ATTACH_RESUME_FAILED`, codex.rs:3832 pins "NOT INVALID_SESSION_ID"). Snapshot responses are zod-`.strict()`-validated client-side (`shared/fresh-agent-contract.ts:230-246` via `src/lib/api.ts:396-416`) — one extra/missing/snake_case key and the pane renders nothing.

---

## Background facts every task relies on (verified @ c491aee0)

- `FreshClaudeState` (claude.rs:74–90): `broadcast_tx: Arc<broadcast::Sender<String>>`, `sessions: Arc<TokioMutex<HashMap<String, ClaudeSession>>>` keyed by the **sidecar-minted ephemeral nanoid** (from the sidecar's `{"type":"created","sessionId":…}` line, index.mjs:199), `create_dedup`.
- `ClaudeSession` (claude.rs:102–112): exactly `stdin: ChildStdin`, `child: Child`, `ownership_id: String`, `consumer: JoinHandle<()>`. No durable id, no cwd, no status.
- `spawn_consumer` (claude.rs:421–442) is a generic rename-and-rebroadcast loop; `sdk_line_to_frame` (claude.rs:452–468) clones the inner event, renames `sdk.*` → `freshAgent.*` via `normalize_sdk_type` (claude.rs:472–492, includes `"sdk.session.init" => "freshAgent.session.init"`), and injects the **sessions-map key** as the envelope `sessionId`. The client prefers the envelope id (`src/lib/fresh-agent-ws.ts:180-183`).
- The sidecar emits `{type:'sdk.session.init', sessionId, cliSessionId, model, cwd, tools}` (index.mjs:119–135); `cliSessionId` is the durable Claude UUID = the transcript filename stem. Today it is forwarded to the client and NEVER retained server-side.
- The real sidecar already passes `resume: req.resumeSessionId` into the SDK (index.mjs:209) — **no sidecar production change is needed** for resume.
- FROZEN client attach payload (`FreshAgentView.tsx:303-313`, sent at `:999`, `:1115`, `:1135` incl. ws.onReconnect): `sessionId` = the original create-time nanoid (never rekeyed), `resumeSessionId` = the Claude UUID (from `session.cliSessionId`), `sessionRef = {provider:'claude', sessionId:<UUID>}`, plus `cwd`. `FreshAgentAttach` (client_messages.rs:490–502) already deserializes `resume_session_id` and `session_ref` — currently read by NO handler.
- FROZEN client snapshot fetch (`FreshAgentView.tsx:1275-1420`): `GET /api/fresh-agent/threads/{sessionType}/{provider}/{threadId}?cwd=…` with `threadId` = the **Claude UUID** (never the nanoid); suppressed while `.lost`; no request at all if no UUID is known.
- `freshAgent.session.snapshot` inner events are provider-agnostic client-side (`fresh-agent-ws.ts:196-206`): one such frame un-wedges BUSY and hands the durable UUID over via `timelineSessionId`.
- Codex status-snapshot inner shape (codex.rs:2658–2696): `{type:"freshAgent.session.snapshot", sessionId, latestTurnId:null, status, timelineSessionId}`.
- `spawn_sidecar()` (claude.rs:529–565) inherits the parent env wholesale (HOME/CLAUDE_HOME isolation comes from the server env). `sidecar_entry_path()` honors `FRESHELL_CLAUDE_SIDECAR`; node binary from `FRESHELL_CLAUDE_NODE`.
- `read_created(&mut reader, SIDECAR_CREATE_BUDGET)` (claude.rs:569–617) returns the sidecar's nanoid; `write_line` (claude.rs:635–643) writes one JSON line to stdin; `mint_ownership_id`/`reap_owned_claude_sidecars` (claude.rs:663–710).
- Transcript layout: `<claude_home>/projects/<cwd-slug>/<uuid>.jsonl`; slug is lossy — locate by FILENAME scan across `projects/*` (+ one subdir level), never by re-deriving the slug (legacy precedent `server/session-history-loader.ts:132-226`).
- `claude_home` resolution precedent: env `CLAUDE_HOME` (non-empty) else `<home>/.claude` (`server/claude-home.ts`, and `crates/freshell-server/src/session_directory.rs:446` which is `pub(crate)` to freshell-server — NOT callable from freshell-freshagent, so we duplicate the 5-line resolver).
- snapshot.rs handler (snapshot.rs:86–147): arms for `("freshcodex","codex")` and `("freshopencode","opencode")`; claude falls to the catch-all → 503 `FRESH_AGENT_RUNTIME_UNAVAILABLE`. Pinning test `valid_but_unregistered_locator_is_503_with_code` (snapshot.rs:253–272) must be replaced. NotFound convention: 404 + `"FRESH_AGENT_LOST_SESSION"`.
- e2e fixture `test/e2e-browser/fixtures/fake-claude-sidecar.mjs`: emits `created` → `sdk.session.init` (cliSessionId = `44444444-4444-4444-8444-444444444444`, overridable via `FAKE_CLAUDE_SIDECAR_CLI_SESSION_ID`) → (`sdk.session.snapshot messages:[]` if resume) → `sdk.status idle`; `send` → running → assistant `'Fixture claude turn'` → `turn.complete` → idle; knob `FAKE_CLAUDE_SIDECAR_HOLD_TURN=1`. Writes NO files, NO log.
- `RustServer` harness (`test/e2e-browser/helpers/rust-server.ts`): mkdtemp HOME + `findFreePort` + random token; `applyIsolatedHomeEnvironment` pins HOME/CLAUDE_HOME per test; caller `env` wins; `restartAbrupt()` = SIGKILL process group + reboot on same home/port/token. New rust-only specs must be registered in BOTH `RUST_ONLY_SPECS` and the `rust-chromium` project's `testMatch` in `test/e2e-browser/playwright.config.ts`.
- Wall pins (`test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`): mechanism is `test.fail(e2eServerKind === 'rust', '<reason>')`; flipping = DELETING that call. Claude-relevant pins: line ~1134 (`freshclaude: SIGKILL restore rebinds…`, P0.2 — primary flip target), line ~1349 (composed all-pane ruler, blocked on P0.2 **plus other lanes' P1.x** — flip only if it actually passes), line ~1674 is claude **terminal** mode (Lane A3's territory — leave it).
- Kilroy is a pure alias: provider `claude`, `session_type_str` (claude.rs:497–502) maps `SessionType::Kilroy => "kilroy"`, else `"freshclaude"`.

## File structure (what this plan creates/modifies)

| File | Responsibility |
|---|---|
| `crates/freshell-freshagent/src/claude.rs` (modify) | Record cliSessionId (index + session field), sidecar-id-aware send/interrupt, resume-on-attach arm, status-snapshot frame builder |
| `crates/freshell-freshagent/src/claude_snapshot.rs` (create) | Pure claude transcript machinery: `claude_home()`, `find_transcript()`, JSONL→turns parser, snapshot JSON builder, `get_claude_snapshot()` |
| `crates/freshell-freshagent/src/lib.rs` (modify) | `pub(crate) mod claude_snapshot;` |
| `crates/freshell-freshagent/src/snapshot.rs` (modify) | `("freshclaude"\|"kilroy", "claude")` handler arm; replace the 503 pin test |
| `test/fixtures/fresh-agent/claude-transcript-sample.jsonl` (create) | Shared sample transcript (Rust builder input + TS contract test input) |
| `test/fixtures/fresh-agent/claude-snapshot-golden.json` (create) | Golden snapshot JSON (Rust asserts builder == golden; vitest asserts golden parses under the strict zod schema) |
| `test/unit/server/rust-claude-snapshot-contract.test.ts` (create) | zod contract pin for the golden snapshot |
| `crates/freshell-ws/tests/freshagent_claude_attach.rs` (modify) | WS-level resume-on-attach coverage |
| `test/e2e-browser/fixtures/fake-claude-sidecar.mjs` (modify) | + request log, transcript persistence, resume continuity, hold-once knob |
| `test/e2e-browser/specs/freshclaude-restart-parity-rust.spec.ts` (create) | Happy-path attach-resume + same-conversation + BUSY un-wedge e2e |
| `test/e2e-browser/playwright.config.ts` (modify) | Register the new rust-only spec |
| `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts` (modify) | Flip pins that now pass |

Task order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Tasks 2–5 (snapshot) and Task 6 (attach) both depend on Task 1 and Task 2; Task 6 additionally needs `find_transcript` from Task 2.

---

### Task 1: Record `cliSessionId` server-side (durable-id index + sidecar-id field)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs`
- Test: in-file `#[cfg(test)] mod tests` (claude.rs:737–1372)

**Interfaces:**
- Consumes: existing `spawn_consumer`, `handle_create`, `handle_kill`, `shutdown`, `FAKE_CLAUDE_SIDECAR_SOURCE` test fixture.
- Produces (later tasks rely on these exact names):
  - `FreshClaudeState.cli_index: Arc<TokioMutex<HashMap<String, String>>>` — durable `cliSessionId` → sessions-map key.
  - `ClaudeSession.cli_session_id: Option<String>` — best-effort copy of the durable id.
  - `ClaudeSession.sidecar_session_id: String` — the id the SIDECAR knows this session by (== map key for created sessions; differs for resumed ones in Task 6). `handle_send`/`handle_interrupt` write THIS id to the sidecar.
  - Test helper `FakeClaudeSidecarEnv` unchanged; `FAKE_CLAUDE_SIDECAR_SOURCE` extended to emit `sdk.session.init`.

- [ ] **Step 1: Extend the in-crate fake sidecar to emit `sdk.session.init`**

In `FAKE_CLAUDE_SIDECAR_SOURCE` (claude.rs:1008–1039), inside its `create` handling, immediately after it emits the `created` line, add emission of a session-init line (echoing `resumeSessionId` as the durable id when present — the continuity semantics Task 7's e2e fixture also uses):

```js
// inside the fake's create branch, after the created emit:
const cliSessionId = msg.resumeSessionId || 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
console.log(JSON.stringify({ type: 'sdk.session.init', sessionId, cliSessionId, model: 'fake-model', cwd: '/tmp', tools: [] }));
console.log(JSON.stringify({ type: 'sdk.status', sessionId, status: 'idle' }));
```

Also make the fake's create branch append `JSON.stringify(msg)` (the whole parsed create request) as the spawn-log line instead of just the pid, so tests can assert `resumeSessionId` was received. Update `spawn_count()` accordingly (count lines — unchanged behavior).

- [ ] **Step 2: Write the failing test**

Add to `mod tests` in claude.rs:

```rust
#[tokio::test]
async fn session_init_records_cli_session_id_in_the_index() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeSidecarEnv::install();
    let (st, mut rx) = state_with_bus();
    st.handle_create(dedup_create_msg("req-cli-idx-1")).await;
    let created = await_claude_created(&mut rx, "req-cli-idx-1").await;

    // The fake emits sdk.session.init with the durable uuid; poll until the
    // consumer has recorded it (bounded).
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
    loop {
        {
            let idx = st.cli_index.lock().await;
            if idx.get("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") == Some(&created) {
                break;
            }
        }
        assert!(tokio::time::Instant::now() < deadline, "cli_index never recorded the durable id");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    // Kill evicts the index entry.
    st.handle_kill(FreshAgentKill {
        provider: freshell_protocol::AgentProvider::Claude,
        session_id: created.clone(),
        session_type: SessionType::Freshclaude,
    }).await;
    assert!(st.cli_index.lock().await.is_empty());
    drop(env);
}
```

(Mirror the exact `FreshAgentKill` field set from the existing kill tests at claude.rs:1239–1300 — copy their construction verbatim if it differs.)

- [ ] **Step 3: Run test to verify it fails**

```bash
cd /home/dan/code/freshell/.worktrees/freshclaude-restart-parity
cargo test -p freshell-freshagent session_init_records_cli_session_id_in_the_index
```
Expected: FAIL to compile — `cli_index` field does not exist. (Compile failure IS the red state here.)

- [ ] **Step 4: Implement**

1. Add fields to `FreshClaudeState` (and initialize in `new()`, claude.rs:116):

```rust
    /// durable Claude UUID (`cliSessionId` from `sdk.session.init`) -> sessions-map key.
    /// THE restart-parity index (plan §2.8 item 2): lets attach/snapshot find a live
    /// session by its durable identity instead of the process-ephemeral placeholder.
    /// pub(crate) so in-crate tests (and snapshot wiring) can inspect it.
    pub(crate) cli_index: Arc<TokioMutex<HashMap<String, String>>>,
```

2. Add fields to `ClaudeSession`:

```rust
    /// The id the SIDECAR keys this session by (`created.sessionId`). Equal to the
    /// sessions-map key for created sessions; DIFFERENT for resumed-on-attach sessions
    /// (Task 6), where the map key is the CLIENT's original id. `handle_send`/
    /// `handle_interrupt` MUST address the sidecar with this id, never the map key.
    sidecar_session_id: String,
    /// Best-effort copy of the durable Claude UUID once `sdk.session.init` arrives.
    cli_session_id: Option<String>,
```

3. In `handle_create` (insert site claude.rs:224–232), set `sidecar_session_id: created.clone(), cli_session_id: None` on the inserted `ClaudeSession`. Same for the test helper `insert_fake_claude_session` (claude.rs:765–783): `sidecar_session_id: id.to_string(), cli_session_id: None`.

4. In `spawn_consumer` (claude.rs:421–442), clone `self.sessions` and `self.cli_index` into the task and intercept session-init lines before the generic rebroadcast:

```rust
        let broadcast_tx = self.broadcast_tx.clone();
        let sessions = self.sessions.clone();
        let cli_index = self.cli_index.clone();
        tokio::spawn(async move {
            while let Ok(Some(line)) = reader.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                    continue;
                };
                // Restart-parity (plan §2.8 item 2): record the durable Claude UUID.
                // The index insert is load-bearing; the session-field copy is
                // best-effort (the map entry may not exist yet during create).
                if value.get("type").and_then(Value::as_str) == Some("sdk.session.init") {
                    if let Some(cli_id) = value.get("cliSessionId").and_then(Value::as_str) {
                        cli_index
                            .lock()
                            .await
                            .insert(cli_id.to_string(), session_id.clone());
                        if let Some(session) = sessions.lock().await.get_mut(&session_id) {
                            session.cli_session_id = Some(cli_id.to_string());
                        }
                    }
                }
                if let Some(frame) = sdk_line_to_frame(&value, &session_id, &session_type) {
                    let _ = broadcast_tx.send(frame);
                }
            }
        })
```

5. In `handle_kill` (claude.rs:279–311), after removing the session from the map, evict its index entries (retain covers the init-raced-before-insert case):

```rust
        self.cli_index
            .lock()
            .await
            .retain(|_, mapped| mapped != &msg.session_id);
```

6. In `shutdown` (claude.rs:127–146), clear the index after draining sessions: `self.cli_index.lock().await.clear();`.

7. In `handle_send` (claude.rs:349–378) and `handle_interrupt` (claude.rs:326–341), address the sidecar by the stored id: look up the session, then build the payload with `session.sidecar_session_id` instead of `msg.session_id` (e.g. `json!({"type":"send","sessionId": session.sidecar_session_id, "text": msg.text})`). Keep the map lookup keyed by `msg.session_id` exactly as today. NOTE: `handle_send` currently locks, writes to `stdin`, and broadcasts — keep its structure; only the `sessionId` value written to the sidecar changes. This is a no-op for created sessions (the two ids are equal) — it becomes load-bearing in Task 6.

- [ ] **Step 5: Run the new test and the whole crate**

```bash
cargo test -p freshell-freshagent session_init_records_cli_session_id_in_the_index
cargo test -p freshell-freshagent
```
Expected: both PASS (all pre-existing claude tests still green — `sdk_line_to_frame` behavior is unchanged; the fake now emits extra lines which existing tests must tolerate; if `control_lines_are_not_forwarded_as_events` or the dedup tests assert exact frame sequences, adjust their drains to skip unrelated `freshAgent.*` frames rather than weakening assertions).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "feat(freshagent): record claude cliSessionId in a durable-id index"
```

---

### Task 2: Transcript locator (`claude_snapshot.rs` part 1)

**Files:**
- Create: `crates/freshell-freshagent/src/claude_snapshot.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (add `pub(crate) mod claude_snapshot;` next to the existing `mod claude;` line, lib.rs:39–49)
- Test: in-file `#[cfg(test)] mod tests`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `pub(crate) fn claude_home() -> Option<PathBuf>` — env `CLAUDE_HOME` (non-empty) else `$HOME/.claude`; `None` if neither resolvable.
  - `pub(crate) fn find_transcript(claude_home: &Path, session_id: &str) -> Option<PathBuf>` — filename scan of `projects/*/<session_id>.jsonl` + one subdir level; rejects path-traversal ids.

- [ ] **Step 1: Write the failing tests**

Create `crates/freshell-freshagent/src/claude_snapshot.rs` containing ONLY the test module first:

```rust
//! Claude fresh-agent snapshot adapter (restart-resilience plan §2.8 item 4).
//!
//! Reads the Claude CLI's own transcript store (`<claude_home>/projects/<cwd-slug>/
//! <uuid>.jsonl`) directly -- the first file-reading snapshot source in the Rust port.
//! Design choice over codex's resume-and-ask: claude has no `thread/read` RPC, a
//! sidecar resume burns a real SDK process per snapshot GET, and the legacy Node
//! server already proved direct-read viable (`server/session-history-loader.ts`).
//! The transcript store is also the AUTHORITY for lost-vs-alive on attach
//! ([`crate::FreshClaudeState::handle_attach`]): file present => resumable, file
//! absent => positively gone (mirrors opencode's 404 rule).

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_home() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn find_transcript_locates_a_direct_project_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-home-user-proj");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("11111111-1111-4111-8111-111111111111.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "11111111-1111-4111-8111-111111111111"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_locates_a_one_level_nested_file() {
        let home = temp_home();
        let dir = home.path().join("projects").join("-p").join("sessions");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("22222222-2222-4222-8222-222222222222.jsonl");
        std::fs::write(&file, "{}\n").unwrap();
        assert_eq!(
            find_transcript(home.path(), "22222222-2222-4222-8222-222222222222"),
            Some(file)
        );
    }

    #[test]
    fn find_transcript_misses_cleanly_and_rejects_traversal() {
        let home = temp_home();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        assert_eq!(find_transcript(home.path(), "33333333-3333-4333-8333-333333333333"), None);
        assert_eq!(find_transcript(home.path(), "../etc/passwd"), None);
        assert_eq!(find_transcript(home.path(), "a/b"), None);
        assert_eq!(find_transcript(home.path(), ""), None);
    }
}
```

If `tempfile` is not already a dev-dependency of `freshell-freshagent` (check `crates/freshell-freshagent/Cargo.toml`), add under `[dev-dependencies]`: `tempfile = "3"` (match the workspace's existing tempfile version if one is pinned elsewhere — `grep -rn "tempfile" crates/*/Cargo.toml`).

Add to `crates/freshell-freshagent/src/lib.rs` (next to `mod claude;`): `pub(crate) mod claude_snapshot;`

- [ ] **Step 2: Run tests to verify they fail**

```bash
cargo test -p freshell-freshagent claude_snapshot
```
Expected: FAIL to compile — `find_transcript` not defined.

- [ ] **Step 3: Implement**

Add above the test module:

```rust
use std::path::{Path, PathBuf};

/// `getClaudeHome()` parity (`server/claude-home.ts`, duplicated because
/// `freshell-server::session_directory::claude_home` is `pub(crate)` to that crate):
/// env `CLAUDE_HOME` (non-empty) else `$HOME/.claude`. The sidecar and the claude CLI
/// inherit this same env, so this resolution names the SAME store they write to.
pub(crate) fn claude_home() -> Option<PathBuf> {
    match std::env::var("CLAUDE_HOME") {
        Ok(v) if !v.is_empty() => Some(PathBuf::from(v)),
        _ => match std::env::var("HOME") {
            Ok(h) if !h.is_empty() => Some(PathBuf::from(h).join(".claude")),
            _ => None,
        },
    }
}

/// Locate `<claude_home>/projects/*/<session_id>.jsonl` (or one subdir deeper, e.g.
/// `<project>/<session-id-dir>/...` layouts). Filename scan, NEVER slug re-derivation:
/// the cwd->slug encoding is lossy (`docs/port-plan.md:45`). Sorted dirs for
/// determinism (mirrors `directory_index.rs::discover_claude_home`).
pub(crate) fn find_transcript(claude_home: &Path, session_id: &str) -> Option<PathBuf> {
    if session_id.is_empty()
        || session_id.contains('/')
        || session_id.contains('\\')
        || session_id.contains("..")
    {
        return None;
    }
    let filename = format!("{session_id}.jsonl");
    let projects = claude_home.join("projects");
    let entries = std::fs::read_dir(&projects).ok()?;
    let mut dirs: Vec<PathBuf> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .map(|e| e.path())
        .collect();
    dirs.sort();
    for dir in &dirs {
        let direct = dir.join(&filename);
        if direct.is_file() {
            return Some(direct);
        }
        let Ok(nested) = std::fs::read_dir(dir) else {
            continue;
        };
        let mut subdirs: Vec<PathBuf> = nested
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .map(|e| e.path())
            .collect();
        subdirs.sort();
        for sub in &subdirs {
            let candidate = sub.join(&filename);
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cargo test -p freshell-freshagent claude_snapshot
```
Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/Cargo.toml
git commit -m "feat(freshagent): claude transcript locator (claude_home + find_transcript)"
```

---

### Task 3: Transcript parser + snapshot JSON builder (+ golden fixture)

**Files:**
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs`
- Create: `test/fixtures/fresh-agent/claude-transcript-sample.jsonl`
- Create: `test/fixtures/fresh-agent/claude-snapshot-golden.json`
- Test: in-file `mod tests`

**Interfaces:**
- Consumes: Task 2's module.
- Produces:
  - `pub(crate) fn build_claude_snapshot_json(session_type: &str, thread_id: &str, transcript: &str, revision: i64) -> Value` — a `FreshAgentSnapshotSchema`-exact JSON value.
  - `pub(crate) enum ClaudeSnapshotError { NotFound, Io(String) }`
  - `pub(crate) async fn get_claude_snapshot(session_type: &str, thread_id: &str) -> Result<Value, ClaudeSnapshotError>` — env-home resolution + locate + read + build; revision = file mtime millis (fallback: turn count).

Contract recap the builder MUST satisfy (zod `.strict()` at every level — `shared/fresh-agent-contract.ts:6-246`): top-level requires `sessionType`, `provider`, `threadId`, `revision` (non-negative int), `status` (non-empty), `capabilities{send,interrupt,approvals,questions,fork}` (required booleans), `tokenUsage{inputTokens,outputTokens,totalTokens}` (non-negative ints). Optional: `sessionId`, `latestTurnId` (nullable), `summary`, `settings`. Arrays `pendingApprovals/pendingQuestions/worktrees/diffs/childThreads/turns/extensions` have zod defaults but we emit them explicitly (empty). Turns require `id`, `turnId` (UNIQUE — it keys `historyBodies`), `summary`, `items`; optional `messageId`, `ordinal`, `source` (`durable|live|server`), `role` (`user|assistant|system|tool`), `timestamp`, `model`. Items are a `kind`-discriminated union; every variant requires `id`. Client renders turns in ARRAY ORDER (nothing sorts) and clears claude local echo by matching the first ~80 chars of prompt text against a `role:'user'` turn — so user turns MUST carry the literal prompt text in a `kind:'text'` item.

- [ ] **Step 1: Create the shared sample transcript**

Create `test/fixtures/fresh-agent/claude-transcript-sample.jsonl` (exactly these 7 lines — covers: string-form message, structured text, thinking, tool_use/tool_result, skipped non-message line types, malformed line):

```
{"type":"summary","summary":"ignored line type"}
{"type":"user","timestamp":"2026-07-25T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"first question"}]}}
{"type":"assistant","timestamp":"2026-07-25T10:00:01.000Z","message":{"id":"msg_01","role":"assistant","model":"claude-opus-4-6","content":[{"type":"thinking","thinking":"pondering"},{"type":"text","text":"first answer"}]}}
{"type":"user","timestamp":"2026-07-25T10:00:02.000Z","message":"plain string question"}
{"type":"assistant","timestamp":"2026-07-25T10:00:03.000Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_01","name":"bash","input":{"command":"ls"}}]}}
{"type":"user","timestamp":"2026-07-25T10:00:04.000Z","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"toolu_01","content":[{"type":"text","text":"file-a\nfile-b"}],"is_error":false}]}}
not json at all
```

- [ ] **Step 2: Write the failing Rust test (builder == golden)**

Add to `claude_snapshot.rs` tests:

```rust
    const SAMPLE_TRANSCRIPT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-transcript-sample.jsonl"
    ));
    const GOLDEN_SNAPSHOT: &str = include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../test/fixtures/fresh-agent/claude-snapshot-golden.json"
    ));

    #[test]
    fn builder_output_matches_the_golden_snapshot_fixture() {
        let built = build_claude_snapshot_json(
            "freshclaude",
            "44444444-4444-4444-8444-444444444444",
            SAMPLE_TRANSCRIPT,
            1753437600000,
        );
        let golden: serde_json::Value = serde_json::from_str(GOLDEN_SNAPSHOT).expect("golden parses");
        assert_eq!(built, golden);
    }

    #[test]
    fn user_turns_carry_role_user_and_literal_prompt_text() {
        // Load-bearing for the frozen client's local-echo clearing: claude's
        // send.accepted has no submittedTurnId, so the client matches prompt text
        // against role:'user' turns (freshAgentSlice fold).
        let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0);
        let turns = built["turns"].as_array().unwrap();
        let first = &turns[0];
        assert_eq!(first["role"], "user");
        assert_eq!(first["items"][0]["kind"], "text");
        assert_eq!(first["items"][0]["text"], "first question");
    }

    #[test]
    fn turn_ids_are_unique_and_ordering_is_transcript_order() {
        let built = build_claude_snapshot_json("kilroy", "t", SAMPLE_TRANSCRIPT, 0);
        assert_eq!(built["sessionType"], "kilroy");
        let turns = built["turns"].as_array().unwrap();
        let mut ids: Vec<&str> = turns.iter().map(|t| t["turnId"].as_str().unwrap()).collect();
        let before = ids.len();
        ids.sort();
        ids.dedup();
        assert_eq!(ids.len(), before, "turnIds must be unique (historyBodies map key)");
        assert_eq!(turns.len(), 5); // summary + malformed lines skipped
        assert_eq!(built["latestTurnId"], turns[4]["turnId"]);
    }
```

Then create the golden by hand at `test/fixtures/fresh-agent/claude-snapshot-golden.json` — the EXACT expected output (this is the contract artifact the vitest test in Task 4 zod-parses):

```json
{
  "sessionType": "freshclaude",
  "provider": "claude",
  "threadId": "44444444-4444-4444-8444-444444444444",
  "sessionId": "44444444-4444-4444-8444-444444444444",
  "revision": 1753437600000,
  "latestTurnId": "44444444-4444-4444-8444-444444444444:4",
  "status": "idle",
  "capabilities": { "send": true, "interrupt": true, "approvals": false, "questions": false, "fork": false },
  "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
  "pendingApprovals": [],
  "pendingQuestions": [],
  "worktrees": [],
  "diffs": [],
  "childThreads": [],
  "turns": [
    {
      "id": "44444444-4444-4444-8444-444444444444:0",
      "turnId": "44444444-4444-4444-8444-444444444444:0",
      "ordinal": 0,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:00.000Z",
      "summary": "first question",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:0-i0", "kind": "text", "text": "first question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:1",
      "turnId": "44444444-4444-4444-8444-444444444444:1",
      "messageId": "msg_01",
      "ordinal": 1,
      "source": "durable",
      "role": "assistant",
      "timestamp": "2026-07-25T10:00:01.000Z",
      "model": "claude-opus-4-6",
      "summary": "first answer",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:1-i0", "kind": "thinking", "text": "pondering" },
        { "id": "44444444-4444-4444-8444-444444444444:1-i1", "kind": "text", "text": "first answer" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:2",
      "turnId": "44444444-4444-4444-8444-444444444444:2",
      "ordinal": 2,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:02.000Z",
      "summary": "plain string question",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:2-i0", "kind": "text", "text": "plain string question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:3",
      "turnId": "44444444-4444-4444-8444-444444444444:3",
      "ordinal": 3,
      "source": "durable",
      "role": "assistant",
      "timestamp": "2026-07-25T10:00:03.000Z",
      "summary": "bash",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:3-i0", "kind": "tool_use", "toolUseId": "toolu_01", "name": "bash", "input": { "command": "ls" } }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:4",
      "turnId": "44444444-4444-4444-8444-444444444444:4",
      "ordinal": 4,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:04.000Z",
      "summary": "[tool result]",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:4-i0", "kind": "tool_result", "toolUseId": "toolu_01", "content": "file-a\nfile-b", "isError": false }
      ]
    }
  ],
  "extensions": {}
}
```

- [ ] **Step 3: Run to verify red**

```bash
cargo test -p freshell-freshagent claude_snapshot
```
Expected: FAIL to compile — `build_claude_snapshot_json` not defined.

- [ ] **Step 4: Implement the parser + builder**

Add to `claude_snapshot.rs` (above tests):

```rust
use serde_json::{json, Map, Value};

/// Why a claude snapshot could not be served.
#[derive(Debug)]
pub(crate) enum ClaudeSnapshotError {
    /// No transcript file for this id -- the store positively does not know it
    /// (maps to 404 FRESH_AGENT_LOST_SESSION, the codex/opencode convention).
    NotFound,
    /// The file exists but could not be read.
    Io(String),
}

/// One transcript JSONL line -> zero-or-one snapshot turn. Parsing rules are the
/// legacy `extractChatMessagesFromJsonl` contract (`server/session-history-loader.ts:36-131`):
/// keep only type user|assistant; message may be a plain string or `{content: [...]}`;
/// malformed lines and unknown block kinds are skipped, never fatal.
fn parse_transcript_turns(thread_id: &str, transcript: &str) -> Vec<Value> {
    let mut turns: Vec<Value> = Vec::new();
    for line in transcript.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let Ok(obj) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let role = match obj.get("type").and_then(Value::as_str) {
            Some("user") => "user",
            Some("assistant") => "assistant",
            _ => continue,
        };
        let msg = obj.get("message");
        let blocks: Vec<Value> = match msg {
            Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
            Some(Value::Object(m)) => match m.get("content") {
                Some(Value::Array(arr)) => arr.clone(),
                Some(Value::String(text)) => vec![json!({ "type": "text", "text": text })],
                _ => continue,
            },
            _ => continue,
        };

        let ordinal = turns.len();
        let turn_id = format!("{thread_id}:{ordinal}");
        let mut items: Vec<Value> = Vec::new();
        for (j, block) in blocks.iter().enumerate() {
            let item_id = format!("{turn_id}-i{j}");
            match block.get("type").and_then(Value::as_str) {
                Some("text") => {
                    if let Some(text) = block.get("text").and_then(Value::as_str) {
                        items.push(json!({ "id": item_id, "kind": "text", "text": text }));
                    }
                }
                Some("thinking") => {
                    let text = block
                        .get("thinking")
                        .or_else(|| block.get("text"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    items.push(json!({ "id": item_id, "kind": "thinking", "text": text }));
                }
                Some("tool_use") => {
                    let tool_use_id = block
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or(item_id.as_str())
                        .to_string();
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let mut item = Map::new();
                    item.insert("id".into(), json!(item_id));
                    item.insert("kind".into(), json!("tool_use"));
                    item.insert("toolUseId".into(), json!(tool_use_id));
                    item.insert("name".into(), json!(name));
                    if let Some(input) = block.get("input") {
                        item.insert("input".into(), input.clone());
                    }
                    items.push(Value::Object(item));
                }
                Some("tool_result") => {
                    let tool_use_id = block
                        .get("tool_use_id")
                        .and_then(Value::as_str)
                        .unwrap_or(item_id.as_str())
                        .to_string();
                    let is_error = block.get("is_error").and_then(Value::as_bool).unwrap_or(false);
                    items.push(json!({
                        "id": item_id,
                        "kind": "tool_result",
                        "toolUseId": tool_use_id,
                        "content": tool_result_text(block),
                        "isError": is_error,
                    }));
                }
                _ => {}
            }
        }
        if items.is_empty() {
            continue;
        }

        let summary = summarize(&items);
        let mut turn = Map::new();
        turn.insert("id".into(), json!(turn_id));
        turn.insert("turnId".into(), json!(turn_id));
        if let Some(message_id) = msg
            .and_then(|m| m.get("id"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            turn.insert("messageId".into(), json!(message_id));
        }
        turn.insert("ordinal".into(), json!(ordinal));
        turn.insert("source".into(), json!("durable"));
        turn.insert("role".into(), json!(role));
        if let Some(ts) = obj.get("timestamp").and_then(Value::as_str) {
            turn.insert("timestamp".into(), json!(ts));
        }
        if let Some(model) = msg
            .and_then(|m| m.get("model"))
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            turn.insert("model".into(), json!(model));
        }
        turn.insert("summary".into(), json!(summary));
        turn.insert("items".into(), json!(items));
        turns.push(Value::Object(turn));
    }
    turns
}

/// Flatten a tool_result block's content (string, or array of text blocks) to a string.
fn tool_result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Turn summary: first text/thinking item's text (char-safe truncate), else a
/// tool label -- `FreshAgentTurnSchema.summary` is REQUIRED.
fn summarize(items: &[Value]) -> String {
    for item in items {
        match item.get("kind").and_then(Value::as_str) {
            Some("text") | Some("thinking") => {
                if let Some(text) = item.get("text").and_then(Value::as_str) {
                    let trimmed = text.trim();
                    if !trimmed.is_empty() {
                        return trimmed.chars().take(120).collect();
                    }
                }
            }
            Some("tool_use") => {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    return name.to_string();
                }
            }
            Some("tool_result") => return "[tool result]".to_string(),
            _ => {}
        }
    }
    "[claude turn]".to_string()
}

/// Build the `FreshAgentSnapshotSchema`-exact JSON (`shared/fresh-agent-contract.ts:230-246`,
/// zod `.strict()` -- every key here is either required or schema-known; NOTHING extra).
pub(crate) fn build_claude_snapshot_json(
    session_type: &str,
    thread_id: &str,
    transcript: &str,
    revision: i64,
) -> Value {
    let turns = parse_transcript_turns(thread_id, transcript);
    let latest_turn_id = turns
        .last()
        .and_then(|t| t.get("turnId"))
        .cloned()
        .unwrap_or(Value::Null);
    json!({
        "sessionType": session_type,
        "provider": "claude",
        "threadId": thread_id,
        "sessionId": thread_id,
        "revision": revision.max(0),
        "latestTurnId": latest_turn_id,
        "status": "idle",
        "capabilities": {
            "send": true,
            "interrupt": true,
            "approvals": false,
            "questions": false,
            "fork": false,
        },
        "tokenUsage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
        "pendingApprovals": [],
        "pendingQuestions": [],
        "worktrees": [],
        "diffs": [],
        "childThreads": [],
        "turns": turns,
        "extensions": {},
    })
}

/// Locate + read + build. `revision` = transcript mtime in ms (monotonic as the file
/// grows -- `mergeSnapshotForDisplay` DROPS revision regressions), fallback turn count.
pub(crate) async fn get_claude_snapshot(
    session_type: &str,
    thread_id: &str,
) -> Result<Value, ClaudeSnapshotError> {
    let home = claude_home().ok_or(ClaudeSnapshotError::NotFound)?;
    let path = find_transcript(&home, thread_id).ok_or(ClaudeSnapshotError::NotFound)?;
    let mtime_ms = std::fs::metadata(&path)
        .ok()
        .and_then(|m| m.modified().ok())
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64);
    let content = tokio::fs::read_to_string(&path)
        .await
        .map_err(|e| ClaudeSnapshotError::Io(e.to_string()))?;
    let mut snapshot = build_claude_snapshot_json(session_type, thread_id, &content, 0);
    let turn_count = snapshot["turns"].as_array().map(|a| a.len() as i64).unwrap_or(0);
    snapshot["revision"] = json!(mtime_ms.unwrap_or(turn_count).max(0));
    Ok(snapshot)
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cargo test -p freshell-freshagent claude_snapshot
```
Expected: all PASS. If the golden mismatches on serialization details, fix the GOLDEN only when the builder is right per the schema recap above; fix the BUILDER when it violates the recap. `assert_eq!` on `serde_json::Value` is key-order-insensitive — mismatches are real content bugs, not formatting.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude_snapshot.rs test/fixtures/fresh-agent/
git commit -m "feat(freshagent): claude transcript parser + snapshot JSON builder with golden fixture"
```

---

### Task 4: TS contract pin — golden snapshot parses under the strict zod schema

**Files:**
- Create: `test/unit/server/rust-claude-snapshot-contract.test.ts`
- Test: itself

**Interfaces:**
- Consumes: `test/fixtures/fresh-agent/claude-snapshot-golden.json` (Task 3), `FreshAgentSnapshotSchema` from `shared/fresh-agent-contract.ts`.
- Produces: the cross-language contract pin. If the Rust builder ever drifts from the client's strict schema, THIS test goes red before any e2e does.

- [ ] **Step 1: Write the test**

Create `test/unit/server/rust-claude-snapshot-contract.test.ts` (NodeNext/ESM — note the `.js` import extension on relative imports; check a sibling test in `test/unit/server/` for the exact relative path depth and import style and mirror it):

```ts
// Pins the Rust claude snapshot adapter's output (via the checked-in golden fixture,
// asserted byte-identical to the builder by crates/freshell-freshagent/src/
// claude_snapshot.rs::builder_output_matches_the_golden_snapshot_fixture) against the
// FROZEN client's strict zod contract. If this fails, the Rust builder violates
// FreshAgentSnapshotSchema and the pane would render nothing (FreshAgentApiContractError).
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { FreshAgentSnapshotSchema } from '../../../shared/fresh-agent-contract.js'

describe('rust claude snapshot contract', () => {
  it('the golden snapshot fixture parses under FreshAgentSnapshotSchema (strict)', () => {
    const golden = JSON.parse(
      fs.readFileSync(
        path.join(__dirname, '../../fixtures/fresh-agent/claude-snapshot-golden.json'),
        'utf-8',
      ),
    )
    const parsed = FreshAgentSnapshotSchema.safeParse(golden)
    if (!parsed.success) {
      throw new Error(JSON.stringify(parsed.error.issues, null, 2))
    }
    expect(parsed.success).toBe(true)
    // Load-bearing specifics for the frozen client:
    expect(parsed.data.turns[0].role).toBe('user')
    expect(parsed.data.turns[0].items[0]).toMatchObject({ kind: 'text', text: 'first question' })
    const turnIds = parsed.data.turns.map((t: any) => t.turnId)
    expect(new Set(turnIds).size).toBe(turnIds.length)
  })
})
```

If the vitest config for `test/unit` does not provide `__dirname` (ESM), use `path.dirname(fileURLToPath(import.meta.url))` with `import { fileURLToPath } from 'node:url'` — mirror whichever pattern sibling tests in `test/unit/server/` use.

- [ ] **Step 2: Run it (coordinator-gated)**

```bash
npm run test:status   # wait if a sibling holds the gate
FRESHELL_TEST_SUMMARY="freshclaude restart parity: snapshot contract pin" \
  npm run test:vitest -- run test/unit/server/rust-claude-snapshot-contract.test.ts --config config/vitest/vitest.config.ts
```
Expected: PASS. **If it fails on `tool_result`/`tool_use` item typing** (the one schema region inferred rather than read verbatim): open `shared/fresh-agent-contract.ts:51-162`, read the exact variant fields, adjust the Rust builder in `claude_snapshot.rs` (and the golden + sample expectations) to match, re-run Task 3's cargo tests, then this test, until both are green. The zod file is the source of truth; the client is frozen.

- [ ] **Step 3: Commit**

```bash
git add test/unit/server/rust-claude-snapshot-contract.test.ts
git commit -m "test: pin rust claude snapshot golden against the strict zod contract"
```

---

### Task 5: Wire the claude arm into the snapshot endpoint (kill the 503)

**Files:**
- Modify: `crates/freshell-freshagent/src/snapshot.rs`
- Test: in-file `mod tests` (snapshot.rs:176–481)

**Interfaces:**
- Consumes: `crate::claude_snapshot::{get_claude_snapshot, ClaudeSnapshotError}` (Task 3). NOTE: `SnapshotState` needs NO new field — the claude adapter is disk+env only.
- Produces: `GET /api/fresh-agent/threads/{freshclaude|kilroy}/claude/{uuid}` → 200 snapshot JSON | 404 `FRESH_AGENT_LOST_SESSION` | 500.

- [ ] **Step 1: Write the failing tests**

The existing test module (snapshot.rs:176+) builds a router with a `SnapshotState` and issues requests (see `valid_but_unregistered_locator_is_503_with_code`, snapshot.rs:253–272, for the harness pattern — reuse its helpers verbatim). Add:

```rust
    // Serializes CLAUDE_HOME mutation across tests in this file (process-global env).
    static SNAPSHOT_ENV_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

    #[tokio::test]
    async fn claude_locator_serves_a_snapshot_from_the_transcript_store() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join("projects").join("-e2e");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("55555555-5555-4555-8555-555555555555.jsonl"),
            r#"{"type":"user","timestamp":"2026-07-25T10:00:00.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}]}}"#,
        )
        .unwrap();
        std::env::set_var("CLAUDE_HOME", home.path());

        // <build router + authorized GET exactly like the existing tests do>
        let (status, body) = get_json(
            "/api/fresh-agent/threads/freshclaude/claude/55555555-5555-4555-8555-555555555555",
        )
        .await;
        std::env::remove_var("CLAUDE_HOME");
        assert_eq!(status, StatusCode::OK);
        assert_eq!(body["sessionType"], "freshclaude");
        assert_eq!(body["provider"], "claude");
        assert_eq!(body["turns"][0]["role"], "user");
        assert_eq!(body["turns"][0]["items"][0]["text"], "hello");
        assert!(body["revision"].as_i64().unwrap() >= 0);
    }

    #[tokio::test]
    async fn claude_locator_with_unknown_session_id_is_404_with_lost_session_code() {
        let _guard = SNAPSHOT_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        std::env::set_var("CLAUDE_HOME", home.path());
        let (status, body) = get_json(
            "/api/fresh-agent/threads/kilroy/claude/66666666-6666-4666-8666-666666666666",
        )
        .await;
        std::env::remove_var("CLAUDE_HOME");
        assert_eq!(status, StatusCode::NOT_FOUND);
        assert_eq!(body["code"], "FRESH_AGENT_LOST_SESSION");
    }
```

(`get_json` here stands for whatever request helper the existing tests use — copy their exact oneshot/request construction including the `x-auth-token` header; do not invent a new harness.)

Then UPDATE `valid_but_unregistered_locator_is_503_with_code` (snapshot.rs:253–272): with claude registered, NO structurally-valid locator is unregistered anymore, so **delete that test** and note in its place that the catch-all 503 arm is retained as a safety net for future enum growth (the two new claude tests + the existing 400 invalid-locator tests now cover the routing table).

- [ ] **Step 2: Run to verify red**

```bash
cargo test -p freshell-freshagent snapshot
```
Expected: the two new tests FAIL (503 instead of 200/404).

- [ ] **Step 3: Implement the handler arm**

In `get_snapshot` (snapshot.rs:91), add before the catch-all arm:

```rust
        ("freshclaude", "claude") | ("kilroy", "claude") => {
            match crate::claude_snapshot::get_claude_snapshot(&session_type, &thread_id).await {
                Ok(snapshot) => Json(snapshot).into_response(),
                Err(crate::claude_snapshot::ClaudeSnapshotError::NotFound) => fail_with_code(
                    StatusCode::NOT_FOUND,
                    format!("claude session {thread_id} not found"),
                    "FRESH_AGENT_LOST_SESSION",
                ),
                Err(crate::claude_snapshot::ClaudeSnapshotError::Io(err)) => {
                    fail(StatusCode::INTERNAL_SERVER_ERROR, err)
                }
            }
        }
```

Also update the module doc comment (snapshot.rs:29–35) — it currently documents the claude 503; rewrite those lines to document the new adapter (direct transcript read, 404 on missing file).

- [ ] **Step 4: Run tests to verify green**

```bash
cargo test -p freshell-freshagent snapshot
cargo test -p freshell-freshagent
```
Expected: PASS (whole crate).

- [ ] **Step 5: Commit**

```bash
git add crates/freshell-freshagent/src/snapshot.rs
git commit -m "feat(freshagent): serve claude/kilroy snapshots from the transcript store (503 -> 200/404)"
```

---

### Task 6: Real attach arm — resume untracked claude sessions in place

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs`
- Modify: `crates/freshell-ws/tests/freshagent_claude_attach.rs`
- Test: both of the above

**Interfaces:**
- Consumes: Task 1 (`cli_index`, `sidecar_session_id`), Task 2 (`claude_snapshot::{claude_home, find_transcript}`), existing `spawn_sidecar`, `write_line`, `read_created`, `spawn_consumer`, `lost_session_frame`, `send_error`, `session_type_str`.
- Produces:
  - `FreshClaudeState.resuming: Arc<TokioMutex<HashSet<String>>>` — single-flight per durable id.
  - `enum ResumeClaudeError { NotFound, Transient(String) }` (private).
  - `fn status_snapshot_frame(session_id, timeline_session_id, status, session_type) -> ServerMessage` (private).
  - Error code string on the wire: `CLAUDE_ATTACH_RESUME_FAILED` (top-level `error` ServerMessage, mirrors codex/opencode).
  - Behavior contract (decision table replacing claude.rs:382–401's):

| State | Action |
|---|---|
| tracked under `msg.session_id` | no-op — NO frame (wire-shape parity, unchanged) |
| untracked, no canonical durable id on the message | `lost_session_frame` (`INVALID_SESSION_ID`) — unchanged fallback |
| untracked, durable id already in `cli_index` | no-op (a concurrent attach already resumed it; its frames broadcast to all) |
| untracked, transcript file EXISTS | spawn sidecar with `resumeSessionId=<durable>`, register under the CLIENT's `msg.session_id`, emit idle `freshAgent.session.snapshot` |
| untracked, transcript file ABSENT | `lost_session_frame` — positive denial: the store is the authority |
| untracked, spawn/pipe/created failure | top-level `error` `CLAUDE_ATTACH_RESUME_FAILED` — NEVER the lost frame |

- [ ] **Step 1: Write the failing unit tests**

Add to claude.rs `mod tests` (all take `CLAUDE_ENV_LOCK` since they mutate `CLAUDE_HOME`/sidecar env; reuse `attach_msg(session_id)` but note it must now populate the resume fields — extend the helper with a variant):

```rust
    fn attach_msg_with_resume(session_id: &str, durable: &str) -> FreshAgentAttach {
        let mut msg = attach_msg(session_id);
        msg.resume_session_id = Some(durable.to_string());
        msg
    }

    fn write_fake_transcript(home: &std::path::Path, durable: &str) {
        let dir = home.join("projects").join("-t");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join(format!("{durable}.jsonl")),
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#,
        )
        .unwrap();
    }

    #[tokio::test]
    async fn attach_untracked_with_transcript_resumes_and_emits_idle_snapshot() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "77777777-7777-4777-8777-777777777777";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_HOME", home.path());

        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume("client-nanoid-1", durable)).await;
        std::env::remove_var("CLAUDE_HOME");

        // Registered under the CLIENT's id (envelope tagging + send routing depend on it).
        assert!(st.sessions.lock().await.contains_key("client-nanoid-1"));
        assert_eq!(
            st.cli_index.lock().await.get(durable),
            Some(&"client-nanoid-1".to_string())
        );
        // The fake received resumeSessionId (spawn log now records the create request).
        let log = std::fs::read_to_string(env.spawn_log_path()).unwrap();
        assert!(log.contains(durable), "sidecar create must carry resumeSessionId");
        // Idle snapshot frame, tagged with the client's id + the durable timeline id.
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.session.snapshot").await;
        assert_eq!(frame["sessionId"], "client-nanoid-1");
        assert_eq!(frame["event"]["status"], "idle");
        assert_eq!(frame["event"]["timelineSessionId"], durable);
        drop(env);
    }

    #[tokio::test]
    async fn attach_untracked_with_missing_transcript_emits_lost_frame() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(home.path().join("projects")).unwrap();
        std::env::set_var("CLAUDE_HOME", home.path());
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume(
            "client-nanoid-2",
            "88888888-8888-4888-8888-888888888888",
        ))
        .await;
        std::env::remove_var("CLAUDE_HOME");
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn attach_transient_spawn_failure_is_not_a_lost_frame() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let home = tempfile::tempdir().unwrap();
        let durable = "99999999-9999-4999-8999-999999999999";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_HOME", home.path());
        std::env::set_var("FRESHELL_CLAUDE_NODE", "/nonexistent-node-binary");
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg_with_resume("client-nanoid-3", durable)).await;
        std::env::remove_var("FRESHELL_CLAUDE_NODE");
        std::env::remove_var("CLAUDE_HOME");
        // Mirrors codex.rs:3832: transient => top-level error with the provider code,
        // explicitly NOT INVALID_SESSION_ID.
        let err = await_top_level_error(&mut rx).await;
        assert!(err.contains("CLAUDE_ATTACH_RESUME_FAILED"));
        assert!(st.sessions.lock().await.is_empty());
    }

    #[tokio::test]
    async fn attach_untracked_without_any_durable_id_still_emits_lost_frame() {
        // The pre-parity fallback (PR #529) is preserved verbatim.
        let (st, mut rx) = state_with_bus();
        st.handle_attach(attach_msg("no-resume-anywhere")).await;
        let frame = await_frame_of_inner_type(&mut rx, "freshAgent.error").await;
        assert_eq!(frame["event"]["code"], "INVALID_SESSION_ID");
    }

    #[tokio::test]
    async fn concurrent_attaches_for_the_same_durable_id_spawn_at_most_one_sidecar() {
        let _guard = CLAUDE_ENV_LOCK.lock().await;
        let env = FakeClaudeSidecarEnv::install();
        let home = tempfile::tempdir().unwrap();
        let durable = "12121212-1212-4121-8121-121212121212";
        write_fake_transcript(home.path(), durable);
        std::env::set_var("CLAUDE_HOME", home.path());
        let (st, _rx) = state_with_bus();
        let a = st.clone();
        let b = st.clone();
        let m1 = attach_msg_with_resume("nano-a", durable);
        let m2 = attach_msg_with_resume("nano-b", durable);
        tokio::join!(a.handle_attach(m1), b.handle_attach(m2));
        std::env::remove_var("CLAUDE_HOME");
        assert_eq!(env.spawn_count(), 1, "single-flight per durable id");
        drop(env);
    }
```

Helper notes: `await_frame_of_inner_type(rx, t)` = bounded drain of the broadcast receiver parsing each frame as `Value` until `frame["type"]=="freshAgent.event" && frame["event"]["type"]==t` (mirror `await_claude_created`'s 15s bounded-drain shape, claude.rs:1117–1134). `await_top_level_error` = same drain until `frame["type"]=="error"`, return `frame["message"]` as String. `env.spawn_log_path()` — expose the existing spawn-log path from `FakeClaudeSidecarEnv` (it already stores it; add an accessor if private). The existing tests `handle_attach_untracked_session_emits_lost_session_frame` / `..._kilroy_...` (claude.rs:791, :810) use `attach_msg` with no resume fields — they keep passing unchanged (row 2 of the decision table).

- [ ] **Step 2: Run to verify red**

```bash
cargo test -p freshell-freshagent attach
```
Expected: new tests FAIL (compile error on `resume_session_id` helper is acceptable red; after helper compiles, behavioral failures: lost frame emitted where resume expected).

- [ ] **Step 3: Implement**

1. Add to `FreshClaudeState` (+ init in `new()`): 

```rust
    /// Single-flight guard for resume-on-attach, keyed by DURABLE id (codex's
    /// `resuming` analog, simplified: contenders return immediately instead of
    /// waiting -- the winner's frames broadcast to every client anyway).
    resuming: Arc<TokioMutex<std::collections::HashSet<String>>>,
```

2. Add the durable-id extractor + UUID guard (near `session_type_str`):

```rust
/// The durable claude id an attach carries: `resumeSessionId` first, then
/// `sessionRef.sessionId` -- both written by the FROZEN client
/// (`FreshAgentView.tsx:303-313`). Only canonical UUIDs qualify
/// (`shared/session-contract.ts:34`) -- a nanoid here would just miss the store.
fn attach_durable_id(msg: &FreshAgentAttach) -> Option<String> {
    let candidate = msg
        .resume_session_id
        .clone()
        .or_else(|| msg.session_ref.as_ref().map(|r| r.session_id.clone()))?;
    is_canonical_claude_uuid(&candidate).then_some(candidate)
}

fn is_canonical_claude_uuid(s: &str) -> bool {
    let bytes = s.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(i, b)| match i {
            8 | 13 | 18 | 23 => *b == b'-',
            _ => b.is_ascii_hexdigit(),
        })
}
```

(Verify the `SessionLocator` field name for the inner id in `crates/freshell-protocol/src/client_messages.rs` — the client sends `{provider, sessionId}`; use the actual Rust field, expected `session_id`.)

3. Add the snapshot-frame builder (mirrors codex's `adapter_event_to_frame` StatusSnapshot shape, codex.rs:2658–2696):

```rust
/// The codex-shape idle status snapshot (`freshAgent.session.snapshot`) claude emits
/// after a resume-on-attach: provider-agnostic client-side (`fresh-agent-ws.ts:196-206`),
/// it un-wedges a BUSY pane and hands the durable UUID over via `timelineSessionId`.
fn status_snapshot_frame(
    session_id: &str,
    timeline_session_id: &str,
    status: &str,
    session_type: &str,
) -> ServerMessage {
    ServerMessage::FreshAgentEvent(FreshAgentEvent {
        event: json!({
            "type": "freshAgent.session.snapshot",
            "sessionId": session_id,
            "latestTurnId": Value::Null,
            "status": status,
            "timelineSessionId": timeline_session_id,
        }),
        provider: PROVIDER.to_string(),
        session_id: session_id.to_string(),
        session_type: session_type.to_string(),
    })
}

/// Why a resume-on-attach could not produce a live session (codex's
/// `ResumeSessionError` analog).
#[derive(Debug)]
enum ResumeClaudeError {
    /// The transcript store positively has no file for this durable id.
    NotFound,
    /// Spawn/pipe/`created` failure -- the session may be perfectly resumable;
    /// NEVER declared lost (opencode_ws.rs:596-612 discipline).
    Transient(String),
}
```

4. Rewrite `handle_attach` (replace claude.rs:382–401 body; keep + extend the doc-comment decision table with the one from this task's Interfaces block):

```rust
    pub async fn handle_attach(&self, msg: FreshAgentAttach) {
        if self.sessions.lock().await.contains_key(&msg.session_id) {
            return; // tracked-and-alive: no frame (wire-shape parity with codex)
        }
        let Some(durable) = attach_durable_id(&msg) else {
            // No durable identity to resume from: the pre-parity fallback (PR #529).
            self.broadcast(&lost_session_frame(&msg.session_id, msg.session_type));
            return;
        };
        if self.cli_index.lock().await.contains_key(&durable) {
            return; // already resumed under another placeholder; frames broadcast anyway
        }
        {
            let mut resuming = self.resuming.lock().await;
            if !resuming.insert(durable.clone()) {
                return; // a concurrent attach is resuming this exact durable id
            }
        }
        let outcome = self.resume_for_attach(&msg, &durable).await;
        self.resuming.lock().await.remove(&durable);
        match outcome {
            Ok(()) => {}
            Err(ResumeClaudeError::NotFound) => {
                self.broadcast(&lost_session_frame(&msg.session_id, msg.session_type));
            }
            Err(ResumeClaudeError::Transient(err)) => {
                self.send_error(&None, "CLAUDE_ATTACH_RESUME_FAILED", &err);
            }
        }
    }

    /// The not-tracked resume (codex `ensure_session_resumable` analog, file-store
    /// flavored): transcript-present gate -> spawn sidecar with `resumeSessionId` ->
    /// register under the CLIENT's id -> idle snapshot.
    async fn resume_for_attach(
        &self,
        msg: &FreshAgentAttach,
        durable: &str,
    ) -> Result<(), ResumeClaudeError> {
        let home = crate::claude_snapshot::claude_home().ok_or_else(|| {
            ResumeClaudeError::Transient("no CLAUDE_HOME/HOME resolvable".to_string())
        })?;
        if crate::claude_snapshot::find_transcript(&home, durable).is_none() {
            // Positive denial: the transcript store is the authority for claude.
            return Err(ResumeClaudeError::NotFound);
        }

        let (mut child, mut stdin, stdout, ownership_id) = spawn_sidecar()
            .await
            .map_err(ResumeClaudeError::Transient)?;
        let request_id = format!("attach-resume-{}", uuid::Uuid::new_v4());
        let create_req = json!({
            "type": "create",
            "requestId": request_id,
            "cwd": msg.cwd,
            "model": Value::Null,
            "permissionMode": Value::Null,
            "effort": Value::Null,
            "resumeSessionId": durable,
        });
        let mut reader = BufReader::new(stdout).lines();
        if let Err(err) = write_line(&mut stdin, &create_req).await {
            let _ = child.start_kill();
            reap_owned_claude_sidecars(&ownership_id);
            return Err(ResumeClaudeError::Transient(err));
        }
        let sidecar_session_id = match read_created(&mut reader, SIDECAR_CREATE_BUDGET).await {
            Ok(id) => id,
            Err(err) => {
                let _ = child.start_kill();
                reap_owned_claude_sidecars(&ownership_id);
                return Err(ResumeClaudeError::Transient(err));
            }
        };

        let session_type = session_type_str(msg.session_type).to_string();
        // Register under the CLIENT's id: the consumer stamps the map key on every
        // envelope and the frozen client routes by envelope sessionId
        // (fresh-agent-ws.ts:180-183) -- a fresh key would strand the pane.
        let consumer = self.spawn_consumer(reader, msg.session_id.clone(), session_type.clone());
        self.sessions.lock().await.insert(
            msg.session_id.clone(),
            ClaudeSession {
                stdin,
                child,
                ownership_id,
                consumer,
                sidecar_session_id,
                cli_session_id: Some(durable.to_string()),
            },
        );
        self.cli_index
            .lock()
            .await
            .insert(durable.to_string(), msg.session_id.clone());

        self.broadcast(&status_snapshot_frame(
            &msg.session_id,
            durable,
            "idle",
            &session_type,
        ));
        Ok(())
    }
```

Adapt the exact `spawn_sidecar`/`write_line`/`read_created` call signatures to what handle_create does at claude.rs:183–232 (e.g. reader construction, mutability) — copy its call pattern verbatim rather than the sketch above where they differ. `uuid::Uuid::new_v4()` — same crate `mint_ownership_id` uses; if claude.rs mints ownership ids differently (e.g. via a helper), reuse that helper style for `request_id`.

- [ ] **Step 4: Run unit tests**

```bash
cargo test -p freshell-freshagent claude
```
Expected: all PASS (including the 3 pre-existing attach tests).

- [ ] **Step 5: WS-level red test**

Add to `crates/freshell-ws/tests/freshagent_claude_attach.rs` (reuse its `spawn_server`/`connect_and_complete_handshake`/`send_json`/`await_frame` helpers; add a fake-sidecar env install mirroring `freshagent_claude_kill_interrupt.rs:66-93`'s `FRESHELL_CLAUDE_SIDECAR` pattern, with the fake emitting `created` + `sdk.session.init` echoing `resumeSessionId` + `sdk.status idle`, under that file's env-lock convention):

```rust
#[tokio::test]
async fn claude_attach_with_resumable_transcript_resumes_and_emits_snapshot_over_ws() {
    // env lock + fake sidecar install + temp CLAUDE_HOME with
    // projects/-t/aaaaaaa....jsonl seeded (one user line), then:
    let durable = "abababab-abab-4bab-8bab-abababababab";
    send_json(&mut ws, &serde_json::json!({
        "type": "freshAgent.attach",
        "provider": "claude",
        "sessionId": "gone-after-restart",
        "sessionType": "freshclaude",
        "resumeSessionId": durable,
        "sessionRef": { "provider": "claude", "sessionId": durable },
    })).await;
    let frame = await_frame(&mut ws, |v| {
        v["type"] == "freshAgent.event" && v["event"]["type"] == "freshAgent.session.snapshot"
    }).await;
    assert_eq!(frame["sessionId"], "gone-after-restart");
    assert_eq!(frame["sessionType"], "freshclaude");
    assert_eq!(frame["event"]["status"], "idle");
    assert_eq!(frame["event"]["timelineSessionId"], durable);
}
```

Run red first (before rebuilding with Task 6's claude.rs changes it fails — if the workspace already built, this test is the green proof at the WS layer; still run it):

```bash
cargo test -p freshell-ws --test freshagent_claude_attach
```
Expected: PASS with the new arm (the two pre-existing lost-frame tests still pass — they send no resume fields).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs crates/freshell-ws/tests/freshagent_claude_attach.rs
git commit -m "feat(freshagent): resume untracked claude sessions on attach (lost-frame only on positive denial)"
```

---

### Task 7: Extend the e2e fake claude sidecar (resume proof + transcripts + hold-once)

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-claude-sidecar.mjs`

**Interfaces:**
- Consumes: nothing (standalone fixture).
- Produces (Task 8 relies on these exact behaviors/knobs):
  - `FAKE_CLAUDE_SIDECAR_LOG=<path>` — every parsed stdin request appended as `{pid, t, msg}` JSONL (the `options.resume` proof).
  - Transcript persistence: create ensures, and each send appends to, `$CLAUDE_HOME/projects/-fixture/<cliSessionId>.jsonl` in claude-code line shape (so the Task 5 adapter serves real history and the Task 6 attach gate finds the file).
  - Resume continuity: `create` with `resumeSessionId` → `cliSessionId = resumeSessionId` (same durable id across restarts).
  - `FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER=<path>` — the FIRST send (across sidecar processes sharing the marker path) starts running and never completes; later sends behave normally. Existing knobs (`FAKE_CLAUDE_SIDECAR_HOLD_TURN`, `FAKE_CLAUDE_SIDECAR_CLI_SESSION_ID`) keep working.

- [ ] **Step 1: Rewrite the fixture**

Replace the body of `test/e2e-browser/fixtures/fake-claude-sidecar.mjs` with (keep the existing header doc comment, appending a note about the new knobs):

```js
import readline from 'node:readline'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const HOLD_TURN = process.env.FAKE_CLAUDE_SIDECAR_HOLD_TURN === '1'
const HOLD_ONCE_MARKER = process.env.FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER
const CLI_SESSION_ID =
  process.env.FAKE_CLAUDE_SIDECAR_CLI_SESSION_ID ?? '44444444-4444-4444-8444-444444444444'
const REQUEST_LOG = process.env.FAKE_CLAUDE_SIDECAR_LOG

// sessionId (bridge nanoid) -> cliSessionId (durable uuid)
const sessions = new Map()

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

function logRequest(msg) {
  if (!REQUEST_LOG) return
  fs.mkdirSync(path.dirname(REQUEST_LOG), { recursive: true })
  fs.appendFileSync(REQUEST_LOG, `${JSON.stringify({ pid: process.pid, t: Date.now(), msg })}\n`)
}

function claudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude')
}

function transcriptPath(cliSessionId) {
  const dir = path.join(claudeHome(), 'projects', '-fixture')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, `${cliSessionId}.jsonl`)
}

// Claude-code transcript line shape (what the Rust snapshot adapter parses).
function appendTranscript(cliSessionId, role, text) {
  const line = {
    type: role,
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  }
  fs.appendFileSync(transcriptPath(cliSessionId), `${JSON.stringify(line)}\n`)
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  let msg
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  logRequest(msg)
  if (msg.type === 'create') {
    const sessionId = `fc-e2e-${process.pid}-${Date.now()}`
    // Resume continuity: a resumed session keeps its durable id (what the real
    // CLI's transcript filename stem provides across restarts).
    const cliSessionId = msg.resumeSessionId ?? CLI_SESSION_ID
    sessions.set(sessionId, cliSessionId)
    // Ensure the transcript file EXISTS from create (the attach arm's
    // transcript-present gate reads it before any send happens post-restart).
    fs.closeSync(fs.openSync(transcriptPath(cliSessionId), 'a'))
    emit({ type: 'created', requestId: msg.requestId, sessionId })
    emit({
      type: 'sdk.session.init',
      sessionId,
      cliSessionId,
      model: msg.model ?? 'claude-opus-4-6',
      cwd: msg.cwd ?? process.cwd(),
      tools: [],
    })
    if (msg.resumeSessionId) {
      emit({ type: 'sdk.session.snapshot', sessionId, messages: [] })
    }
    emit({ type: 'sdk.status', sessionId, status: 'idle' })
  } else if (msg.type === 'send') {
    const cliSessionId = sessions.get(msg.sessionId) ?? CLI_SESSION_ID
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'running' })
    appendTranscript(cliSessionId, 'user', msg.text)
    const holdOnce = HOLD_ONCE_MARKER && !fs.existsSync(HOLD_ONCE_MARKER)
    if (holdOnce) {
      fs.mkdirSync(path.dirname(HOLD_ONCE_MARKER), { recursive: true })
      fs.writeFileSync(HOLD_ONCE_MARKER, '1')
      return // wedged: running forever (busy-restart scenario)
    }
    if (HOLD_TURN) return
    appendTranscript(cliSessionId, 'assistant', 'Fixture claude turn')
    emit({
      type: 'sdk.assistant',
      sessionId: msg.sessionId,
      content: [{ type: 'text', text: 'Fixture claude turn' }],
      model: 'claude-opus-4-6',
    })
    emit({ type: 'sdk.turn.complete', sessionId: msg.sessionId, subtype: 'success', at: Date.now() })
    emit({ type: 'sdk.status', sessionId: msg.sessionId, status: 'idle' })
  } else if (msg.type === 'shutdown') {
    process.exit(0)
  }
})
```

- [ ] **Step 2: Smoke it standalone**

```bash
cd /home/dan/code/freshell/.worktrees/freshclaude-restart-parity
TMPHOME=$(mktemp -d) && CLAUDE_HOME="$TMPHOME/.claude" FAKE_CLAUDE_SIDECAR_LOG="$TMPHOME/log.jsonl" \
  node -e '
const { spawn } = require("node:child_process");
const p = spawn("node", ["test/e2e-browser/fixtures/fake-claude-sidecar.mjs"], { env: process.env, stdio: ["pipe","pipe","inherit"] });
let out = "";
p.stdout.on("data", (d) => { out += d; });
p.stdin.write(JSON.stringify({type:"create",requestId:"r1",resumeSessionId:"44444444-4444-4444-8444-444444444444"})+"\n");
setTimeout(() => { p.stdin.write(JSON.stringify({type:"send",sessionId: JSON.parse(out.split("\n")[0]).sessionId, text:"hello"})+"\n"); }, 200);
setTimeout(() => { p.stdin.write(JSON.stringify({type:"shutdown"})+"\n"); setTimeout(()=>{ console.log(out); }, 200); }, 600);
' && cat "$TMPHOME/.claude/projects/-fixture/44444444-4444-4444-8444-444444444444.jsonl" && cat "$TMPHOME/log.jsonl"
```
Expected: stdout shows `created`, `sdk.session.init` with `cliSessionId: 44444444-…` (resume continuity), assistant + turn.complete + idle; the transcript file contains the user line (`hello`) and the assistant line; the log contains both requests with `resumeSessionId` visible on the create.

- [ ] **Step 3: Verify the existing wall spec still passes with the extended fixture**

The fixture's only current consumer is `restore-contract-wall-rust.spec.ts`. Its pinned freshclaude test is expected-fail; do NOT try to flip anything yet (that's Task 9 — the server binary must be rebuilt first anyway). Just typecheck/lint the fixture: `node --check test/e2e-browser/fixtures/fake-claude-sidecar.mjs`.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/fixtures/fake-claude-sidecar.mjs
git commit -m "test(e2e): fake claude sidecar gains resume continuity, transcripts, request log, hold-once"
```

---

### Task 8: E2E — restart parity spec (attach-resume happy path, same conversation, BUSY un-wedge)

**Files:**
- Create: `test/e2e-browser/specs/freshclaude-restart-parity-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` (add `/freshclaude-restart-parity-rust\.spec\.ts$/` to `RUST_ONLY_SPECS` (~line 81) AND to the `rust-chromium` project's `testMatch` array (~line 156))

**Interfaces:**
- Consumes: Tasks 1–7 (rebuilt server binary + extended fixture). Helper functions are COPIED from `restore-contract-wall-rust.spec.ts` per that suite's per-spec-ownership convention (donors named below), not imported.
- Produces: the executable proof of §2.8 items 2–4 end to end.

- [ ] **Step 1: Rebuild the server binary the e2e harness runs**

```bash
cargo build --release -p freshell-server
```
Expected: clean build.

- [ ] **Step 2: Write the spec**

Create `test/e2e-browser/specs/freshclaude-restart-parity-rust.spec.ts`. Copy these helpers VERBATIM from `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`: `seedWallConfig` (:131–155, claude flavor), `bootWall` (:156–170), `selectShellIfPickerShowing`, `waitForWsReady`, `flushPersistence`, `collectLeaves`/`findFreshAgentLeaf`, `leafDurableIdentity` (:245–251), `createFreshclaudePane` (:436–464), `sendFreshAgentTurn` (:373–393). Then the tests:

```ts
// FRESHCLAUDE RESTART PARITY -- restart-resilience plan §2.8 items 2-4 (Lane A2).
// Proves the server-side resume path end to end against the extended fake sidecar:
//   1. restartAbrupt -> WS auto-reconnect -> client re-attaches -> server resumes
//      IN PLACE: no INVALID_SESSION_ID lost frame, no client-driven re-create.
//   2. History rehydrates via GET /api/fresh-agent/threads/... (transcript adapter).
//   3. The next send continues the SAME conversation (fixture request log shows
//      create carried resumeSessionId === the original durable UUID).
//   4. A pane BUSY at restart un-wedges (idle status snapshot from the attach arm).
// Rust-only: registered in RUST_ONLY_SPECS + rust-chromium testMatch (restartAbrupt
// exists only on RustServer). NOTE: no page.reload() in test 1/2 -- the reload leg
// is the contract wall's freshclaude test; this spec owns the reconnect leg.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test, expect } from '../helpers/fixtures'
import { RustServer } from '../helpers/rust-server'

const FIXTURE = path.resolve(__dirname, '../fixtures/fake-claude-sidecar.mjs')

// ... copied helpers here (see Step 2 preamble) ...

test.describe('freshclaude restart parity (rust)', () => {
  test('SIGKILL restart: attach resumes in place, history rehydrates, send continues the same conversation', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshclaude-parity-'))
    const requestLog = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const { server, harness } = await bootWall(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FIXTURE,
        FAKE_CLAUDE_SIDECAR_LOG: requestLog,
      },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const projectDir = path.join(sharedRoot, 'proj')
      await fsp.mkdir(projectDir, { recursive: true })
      await createFreshclaudePane(page, harness, projectDir)
      const prompt = `parity first turn ${Math.random().toString(36).slice(2, 10)}`
      await sendFreshAgentTurn(page, harness, prompt)
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText('Fixture claude turn')

      // Durable identity = the fixture's canonical UUID.
      let originalDurable = ''
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout()
          originalDurable = leafDurableIdentity(findFreshAgentLeaf(layout)) ?? ''
          return originalDurable
        })
        .toBe('44444444-4444-4444-8444-444444444444')

      await flushPersistence(page)
      await harness.clearSentWsMessages()

      // ── SIGKILL + reboot on same home/port/token; NO page reload -- the client's
      // in-memory session (nanoid + resumeSessionId) drives ws.onReconnect attach.
      await server.restartAbrupt()
      await waitForWsReady(page)

      // Rebind proof: an attach carrying the durable UUID went out...
      await expect
        .poll(async () => {
          const sent = await harness.getSentWsMessages()
          return sent.some(
            (m: any) =>
              m.type === 'freshAgent.attach' &&
              m.provider === 'claude' &&
              (m.resumeSessionId === originalDurable || m.sessionRef?.sessionId === originalDurable),
          )
        })
        .toBe(true)

      // ...and the pane settled WITHOUT the lost path: status back to idle...
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout()
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 30_000 })
        .toBe('idle')

      // ...with NO client-driven re-create (the lost->triggerRecovery FALLBACK).
      const sentAfterRestart = await harness.getSentWsMessages()
      expect(sentAfterRestart.filter((m: any) => m.type === 'freshAgent.create')).toHaveLength(0)

      // Server-side resume proof: the post-restart sidecar create carried
      // options.resume = the original durable UUID (spec item 2 verification).
      const resumedCreates = fs
        .readFileSync(requestLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .filter((e) => e.msg?.type === 'create' && e.msg?.resumeSessionId === originalDurable)
      expect(resumedCreates.length).toBeGreaterThanOrEqual(1)

      // History rehydrated (snapshot adapter): the PRE-restart prompt is back in
      // the pane after the snapshot fetch folds durable turns in.
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText(prompt, {
        timeout: 30_000,
      })

      // Same conversation continues: next send round-trips on the resumed session.
      const secondPrompt = `parity second turn ${Math.random().toString(36).slice(2, 10)}`
      await sendFreshAgentTurn(page, harness, secondPrompt)
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText('Fixture claude turn')
      const layout = await harness.getPaneLayout()
      expect(leafDurableIdentity(findFreshAgentLeaf(layout))).toBe(originalDurable)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })

  test('a pane BUSY at restart un-wedges and the next send works', async ({ page, e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const sharedRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'freshclaude-busy-'))
    const requestLog = path.join(sharedRoot, 'sidecar-requests.jsonl')
    const holdMarker = path.join(sharedRoot, 'hold-once.marker')
    const { server, harness } = await bootWall(page, {
      env: {
        FRESHELL_CLAUDE_SIDECAR: FIXTURE,
        FAKE_CLAUDE_SIDECAR_LOG: requestLog,
        FAKE_CLAUDE_SIDECAR_HOLD_TURN_ONCE_MARKER: holdMarker,
      },
      setupHome: seedWallConfig({ providers: ['claude'], freshAgent: true }),
    })
    try {
      await selectShellIfPickerShowing(page)
      const projectDir = path.join(sharedRoot, 'proj')
      await fsp.mkdir(projectDir, { recursive: true })
      await createFreshclaudePane(page, harness, projectDir)

      // First send wedges (fixture holds the first turn forever): status stuck busy.
      await page.getByRole('textbox', { name: 'Chat message input' }).fill('wedge me')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout()
          return findFreshAgentLeaf(layout)?.content?.status
        })
        .toBe('running')

      await server.restartAbrupt()
      await waitForWsReady(page)

      // Un-wedge proof: the attach arm's idle snapshot clears the stuck state.
      await expect
        .poll(async () => {
          const layout = await harness.getPaneLayout()
          return findFreshAgentLeaf(layout)?.content?.status
        }, { timeout: 30_000 })
        .toBe('idle')

      // And the conversation is live again on the SAME durable session.
      await sendFreshAgentTurn(page, harness, `post-wedge turn ${Date.now()}`)
      await expect(page.locator('[data-context="fresh-agent"]').last()).toContainText('Fixture claude turn')
      const resumed = fs
        .readFileSync(requestLog, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
        .some((e) => e.msg?.type === 'create' && e.msg?.resumeSessionId === '44444444-4444-4444-8444-444444444444')
      expect(resumed).toBe(true)
    } finally {
      await server.stop().catch(() => {})
      await fsp.rm(sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
})
```

Adaptation notes for the implementer (verify against the donor spec while copying helpers): `sendFreshAgentTurn`'s exact signature in the donor takes `(page, harness, tabId, text)` — either copy its tabId acquisition too or inline the simpler fill/click/poll-idle sequence shown in the donor's body; keep `expect.poll` timeouts within the global 60s test timeout (bump per-test via `test.setTimeout(120_000)` at the top of each test — restart + resume + snapshot legs are slow). If `harness.getPaneLayout()`/leaf status field names differ (`content.status` vs a selector into Redux), mirror the donor's exact polling expressions (`restore-contract-wall-rust.spec.ts:1139-1214` freshclaude body is the authoritative reference for both).

- [ ] **Step 3: Register the spec (both places)**

In `test/e2e-browser/playwright.config.ts`: add `/freshclaude-restart-parity-rust\.spec\.ts$/,` to the `RUST_ONLY_SPECS` array (with a comment: `// Freshclaude restart parity (P0.2 §2.8 items 2-4) -- imports RustServer for restartAbrupt()`), and add the same regex to the `rust-chromium` project's `testMatch` array.

- [ ] **Step 4: Run it (red → green loop)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/freshclaude-restart-parity-rust.spec.ts --workers=1 --reporter=list
```
Expected: 2 PASS. Debug notes: if the attach never fires post-restart, dump `harness.getSentWsMessages()`; if history doesn't rehydrate, curl the snapshot endpoint directly against the test server (`x-auth-token` header, threadId = the UUID) to isolate server vs client; the pane may show a transient history banner — assert pane state via the harness, never error-free chrome (donor spec's explicit convention).

- [ ] **Step 5: Commit**

```bash
git add test/e2e-browser/specs/freshclaude-restart-parity-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "test(e2e): freshclaude restart parity spec (attach-resume, history, same-conversation, busy un-wedge)"
```

---

### Task 9: Flip wall pins that now pass, full-suite green, push branch

**Files:**
- Modify: `test/e2e-browser/specs/restore-contract-wall-rust.spec.ts`
- Test: everything

- [ ] **Step 1: Run the wall's claude-relevant tests**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/restore-contract-wall-rust.spec.ts --workers=1 --reporter=list \
  -g "freshclaude: SIGKILL restore rebinds"
```
Playwright HARD-FAILS an unexpected pass of a `test.fail()`-pinned test — that failure IS the flip signal.

- [ ] **Step 2: Flip the freshclaude pin (expected to now pass)**

Delete the `test.fail(e2eServerKind === 'rust', 'P0.2 (§2.8): claude identity never persisted; …')` call at ~line 1134 (and trim the stale portion of its preceding EXPECTED-FAIL comment, replacing it with a note: flipped by this branch — attach-resume arm + snapshot adapter landed; identity travels via `resumeSessionId`). Re-run the `-g "freshclaude: SIGKILL restore rebinds"` command: expected PASS as a normal green test. **If it does NOT pass unexpectedly (i.e. the pin holds):** investigate which leg fails (identity poll / history / status). If the blocking leg is the client persistence gap the pin's comment names (`persistMiddleware` strips `sessionId`; `resumeSessionId` not surviving reload) — that is a CLIENT change, which is fenced: leave the pin in place, update its comment to name exactly which legs now pass and which client gap remains, and record this in the final report. Do not weaken the wall's assertions.

- [ ] **Step 3: Probe the composed ruler pin (~line 1349)**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts \
  --project=rust-chromium specs/restore-contract-wall-rust.spec.ts --workers=1 --reporter=list \
  -g "all pane types survive one SIGKILL restart"
```
Its pin reason is `P0.1: … red until P0.2 (freshclaude identity) + remaining P1.x land` — other lanes' P1.x items likely still block it. If Playwright reports an unexpected pass → delete that `test.fail` too; otherwise leave it and update its reason string to drop the satisfied `P0.2` clause: `'P0.1: composed all-pane ruler; red until remaining P1.x land (P0.2 freshclaude identity landed)'`. Leave the ~line 1674 claude-terminal pin strictly alone (Lane A3).

- [ ] **Step 4: Full verification sweep**

```bash
# Rust
cargo test -p freshell-freshagent
cargo test -p freshell-ws --test freshagent_claude_attach
cargo test -p freshell-ws --test freshagent_claude_kill_interrupt
cargo test -p freshell-ws
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check

# Coordinated suites (WAIT for the gate if a sibling lane holds it)
npm run test:status
FRESHELL_TEST_SUMMARY="freshclaude restart parity: full suite" npm test

# E2E: the new spec + the wall + the claude-adjacent rust specs
npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium \
  specs/freshclaude-restart-parity-rust.spec.ts specs/restore-contract-wall-rust.spec.ts \
  --workers=1 --reporter=list
```
Expected: all green. Fix forward anything red (each fix follows red-green: reproduce → fix → re-run) — EXCEPT failures plainly caused by sibling lanes' concurrent activity; re-run those after the gate clears and report if persistent.

- [ ] **Step 5: Commit the flips + push (NO PR)**

```bash
git add test/e2e-browser/specs/restore-contract-wall-rust.spec.ts
git commit -m "test(e2e): flip freshclaude restore-contract-wall pin -- P0.2 §2.8 items 2-4 landed"
git push -u origin feat/freshclaude-restart-parity
```
Then STOP. Do NOT run `gh pr create` (not approved). The final report must include: branch name, the commands from Step 4 with their green results, which pins were flipped (with the unexpected-pass evidence) and which were left with updated reasons.

---

## Self-Review (performed while writing — results)

**1. Spec coverage:**
- §2.8 item 2 (record cliSessionId, findable by durable id) → Task 1 (`cli_index` + `cli_session_id` on `ClaudeSession`). The campaign plan's "write to the ledger" clause depends on P1.8 (another lane's roadmap item, not yet landed); this task's spec text scopes item 2 to in-memory index/dual-key only, which is what's planned.
- §2.8 item 3 (real attach arm, resume with `options.resume`, register under same mapping, idle snapshot, lost only on genuine failure, never on transport error) → Task 6 (decision table mirrors codex/opencode; positive-denial authority = transcript store; `CLAUDE_ATTACH_RESUME_FAILED` for transient).
- §2.8 item 4 (snapshot adapter, design choice evaluated, client shape matched exactly, pendingLocalEcho ordering) → Tasks 2–5. Design choice: direct transcript read (rationale documented in the module doc: no `thread/read` RPC exists for claude, no sidecar burn, legacy parsing precedent). Client shape pinned twice: Rust golden test + TS zod contract test (Task 4). Local-echo: `role:'user'` + literal prompt text asserted in both Rust and TS tests; array order = transcript order.
- TDD red-first e2e (own RustServer, ephemeral ports, restartAbrupt, no lost-frame happy path, history visible, BUSY un-wedges, same conversation via fixture receiving `options.resume`) → Tasks 7–8.
- Fixture extension → Task 7. Pin flips with commit notes → Task 9.

**1b. No silent deferrals:** every user-facing behavior lands with a production path plus an e2e proving the real outcome against the production server binary (the fake sidecar is the repo's established production-seam fixture — same seam the existing suite uses; the REAL sidecar needs no change and its resume plumbing at index.mjs:209 is exercised verbatim by the same code path). One conditional: Task 9 flips wall pins only if they actually pass — if the freshclaude pin holds because of the *client-side* persistence gap its comment names, that is outside this lane's fence (frozen client) and the task mandates leaving the pin honest, updating its text, and reporting loudly. That is the wall's own designed mechanism, not a scope reduction — the lane's own e2e (Task 8) proves the reconnect-leg contract unconditionally. No other requirement is deferred; no UNRESOLVED COVERAGE GAP.

**2. Placeholder scan:** no TBD/TODO/"handle edge cases"/"similar to Task N" steps; every code step shows code; the two "verify against the donor/actual file" notes are adaptation instructions with named authoritative sources (donor spec lines, zod file lines), not omissions.

**3. Type consistency:** `cli_index: Arc<TokioMutex<HashMap<String,String>>>` (Task 1) is what Task 6 reads/writes; `sidecar_session_id`/`cli_session_id` fields introduced in Task 1 are the ones Task 6's `ClaudeSession` literal sets; `claude_snapshot::{claude_home, find_transcript}` (Task 2) match Task 5/6 call sites; `build_claude_snapshot_json(session_type, thread_id, transcript, revision)` and `get_claude_snapshot(session_type, thread_id)` signatures match between Tasks 3 and 5; `ClaudeSnapshotError::{NotFound, Io}` matches the Task 5 match arms; fixture env knob names in Task 7 match Task 8's spec env exactly.
