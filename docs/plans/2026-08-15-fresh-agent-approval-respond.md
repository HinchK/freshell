# Fresh-Agent Approval/Question/Fork/Compact Response Path (Rust Server) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Fix fresh-agent approval/question responses in the Freshell Rust server so they work end-to-end: clicking Approve/Deny must make freshAgent.approval.respond resolve the pending permission, question answers (question.respond), Fork, and Compact must all reach the agent runtime instead of returning freshAgent.error: UNSUPPORTED_MESSAGE. Detection of the pending state already works; only the response path is broken. See crates/freshell-ws/src/terminal.rs:4630 and checklist items AGENT-04/05/06/07/24.

### Explicit constraints
- Work follows "the usual" workflow
- The UNSUPPORTED_MESSAGE rejection site is crates/freshell-ws/src/terminal.rs:4630
- Checklist items AGENT-04/05/06/07/24 are the scope
- This blocks interactive freshclaude pane usage at cutover

### Accepted tradeoffs and residuals
- None stated

**Goal:** In the Rust server, a user can approve/deny a pending Claude/Kilroy tool permission, answer a provider question, run Compact on any fresh-agent pane, and fork a freshcodex/freshopencode session — each click reaches the agent runtime and resolves, exactly as the frozen client and legacy Node server already intend.

**Architecture:** The Claude sidecar (`crates/freshell-claude-sidecar`) grows the interactive `canUseTool` pending-request channel the legacy `SdkBridge` has (mint requestId, park the SDK promise, emit `sdk.permission.request`/`sdk.question.request`); `FreshClaudeState` gains `handle_approval_respond`/`handle_question_respond`/`handle_compact` that write new `permission.respond`/`question.respond`/`/compact`-send stdin frames, plus a per-session pending set folded from the stdout stream that the REST snapshot overlays (so cards render and survive reload). Codex/opencode compact and fork are implemented in their Rust slices (`thread/fork` RPC, `/session/:id/fork|summarize` POSTs). The pre-dispatch `UNSUPPORTED_MESSAGE` guard becomes a Node-parity refusal table only for genuinely unsupported provider×op cells; every handled frame gets real dispatch arms in `crates/freshell-ws/src/terminal.rs`.

**Tech Stack:** Rust (tokio, axum; workspace crates freshell-ws / freshell-freshagent / freshell-codex / freshell-opencode / freshell-protocol), vendored Node sidecar (`crates/freshell-claude-sidecar/index.mjs`, ESM), Vitest (sidecar unit tests), cargo test (Rust unit/integration), Playwright `rust-chromium` e2e.

## Global Constraints

- **Frozen WS contract v7, unchanged.** All four client frames, `freshAgent.event`, `freshAgent.forked`, and top-level `error` are already frozen; the fix adds **zero** new wire messages. `npm run test:port` must stay green and `npm run contract:generate && git diff --exit-code -- port/contract crates` must stay clean. The nested `freshAgent.event` payload is schema-`true`, so `sdk.permission.request`-derived payloads need no contract entry.
- **TDD (Red-Green-Refactor)** per repo philosophy: every behavior change adds a failing test first. Both unit and e2e coverage are required.
- **Node parity of error surfaces.** Failures reach the pane via the `freshAgent.event{freshAgent.error}` envelope (the shape every fresh-agent error in the Rust port already uses); special client handling: `code: "INVALID_SESSION_ID"` → `markSessionLost` recovery path, anything else → visible `sessionError` banner. Parity **messages** (exact strings from `server/fresh-agent/runtime-manager.ts` / claude adapter): `"Claude approval <requestId> is not available"`, `"Claude question <requestId> is not available"`, `"Approvals are not supported for <sessionType>"`, `"Questions are not supported for <sessionType>"`, `"Fork is not supported for <sessionType>"`, `"Compact is not supported for <sessionType>"`. Refusal frames use `code: "UNSUPPORTED_CAPABILITY"`.
- **No new per-session authorization machinery.** The Rust WS dispatch (existing send/interrupt/kill arms) performs no per-session authorization gate; token auth + origin checks at the WS edge are the port's model. Do not port Node's `freshAgentAuthorizations` map (YAGNI divergence, consistent with existing arms).
- **Decision payload passthrough is verbatim.** `approval.respond`'s `decision` is an opaque value forwarded untouched to the SDK (a defined `updatedInput` wholesale replaces tool input — never synthesize one). `question.respond` answers are wrapped server-side as `{behavior:'allow', updatedInput:{...originalInput, questions, answers}}` (legacy `server/sdk-bridge.ts:629-648`).
- **Kilroy rides the claude path** (`SessionType::Kilroy` + `AgentProvider::Claude`); every claude code path must preserve the session-type flavour (existing precedent: `session_type_str`, claude.rs:1300-1305).
- **The sidecar stays vendored plain-Node ESM** (no TypeScript, no new npm deps); stdout protocol remains newline-JSON, one frame per line; a sidecar death must never fabricate a completion (ADR Decision 2.1).
- **Rust gates:** `cargo fmt --all --check`; `cargo clippy --workspace --all-targets -- -D warnings`; plus `cargo clippy -p freshell-codex --features real-transport --all-targets -- -D warnings` and the same for `-p freshell-opencode`. MSRV/edition per workspace (`rust-version = "1.96"`, edition 2021).
- **Process safety:** never restart the live port-3001 server; worktree servers get unique ports + recorded PIDs; never broad-kill processes.
- **Client binding:** no client (`src/`) changes are planned; a task that discovers a client defect must flag it in its commit message and the run ledger rather than silently expanding scope.
- **docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md** gets its AGENT-04/05/06/07/24 rows updated **only** in Task 8, only as far as landed evidence justifies.

---

### Task 1: Claude sidecar interactive permission/question response channel

The sidecar's `canUseTool` (`crates/freshell-claude-sidecar/index.mjs:219-228`) currently emits an anonymous `sdk.turn.waiting` then auto-allows. Replace with legacy-parity pending request machinery (`server/sdk-bridge.ts:203-214, 516-627, 629-648, 771-783`).

**Files:**
- Create: `crates/freshell-claude-sidecar/permission-channel.mjs`
- Modify: `crates/freshell-claude-sidecar/index.mjs:38-45` (out-of-scope comment), `:111-112` (session record), `:205-230` (canUseTool), `~:280-300` (stdin dispatch), interrupt/shutdown paths
- Test: `test/unit/server/claude-sidecar/permission-channel.test.ts` (new dir; verify vitest default config picks up `test/unit/**/*.test.ts` — check `config/vitest/vitest.config.ts` include globs and adjust path to match the existing `test/unit/server/…` convention)

**Interfaces:**
- Consumes: sidecar `nanoid()` (index.mjs:64), `nextMonotonic(prev, now)` machinery, session records in `sessions` Map, `emit(frame)`.
- Produces (stdin protocol additions, Rust consumes in Task 2):
  - `{type:'permission.respond', sessionId, requestId, decision}` → resolves parked permission promise with `decision` verbatim; returns the turn.
  - `{type:'question.respond', sessionId, requestId, answers}` → resolves parked question promise with `{behavior:'allow', updatedInput:{...originalInput, questions, answers}}`.
  - stdout additions: `{type:'sdk.permission.request', sessionId, requestId, subtype:'can_use_tool', tool:{name,input}, toolUseID, suggestions, blockedPath, decisionReason}`, `{type:'sdk.question.request', sessionId, requestId, questions}`, `{type:'sdk.permission.cancelled', sessionId, requestId}`, `{type:'sdk.question.cancelled', sessionId, requestId}`.

- [ ] **Step 1: Write the failing behavioral test**

```ts
// test/unit/server/…/permission-channel.test.ts — cases:
// 1. raisePermissionRequest parks: emits sdk.permission.request with minted 21-char
//    requestId + tool payload; returns a pending promise; emitHook received frames in
//    order [permission.request, turn.waiting] (waiting only on 0→≥1: a second parked
//    request does NOT re-emit waiting).
// 2. respondPermission resolves the parked promise VERBATIM with the decision
//    ({behavior:'allow'} then {behavior:'deny',message:'Denied by user',interrupt:false}
//    on a second raise), deletes the map entry, returns true; unknown requestId → false,
//    nothing emitted.
// 3. raiseQuestionRequest (AskUserQuestion) sanitizes questions to
//    {question,header?,options?:[{label,description}],multiSelect?} (+spread extras),
//    emits sdk.question.request + waiting edge; empty/invalid questions array
//    short-circuits to {behavior:'allow', updatedInput: input} and parks nothing.
// 4. respondQuestion resolves with {behavior:'allow', updatedInput:{...originalInput,
//    questions, answers}}.
// 5. cancelAll(session, {resolveDeny:true}) (post-interrupt) emits sdk.permission.
//    cancelled / sdk.question.cancelled per entry and resolves each parked promise
//    {behavior:'deny', message:'Interrupted'} (questions: same deny) — never a
//    fabricated user approval. cancelAll(..., {resolveDeny:false}) (post-close/
//    shutdown) emits the cancel frames and NEVER resolves.
//    VALIDATED CONSTRAINT (LB-04, falsified-then-designed): with @anthropic-ai/
//    claude-agent-sdk@0.2.71, resolving a parked canUseTool promise AFTER the
//    query's transport close() throws inside the SDK's floating promise
//    (unhandled rejection → sidecar crash under Node 22 throw-mode). Therefore
//    cancelAll splits by live state: post-interrupt (transport still open) →
//    resolve-with-deny; post-close/shutdown → emit cancel frames ONLY, never
//    resolve. REVIEWED GUARD DESIGN (fresh-eyes round 2): NO process-level
//    swallow handlers. The resolveDeny split prevents the KNOWN rejection
//    vector at its origin (the SDK's internal floating promise is not
//    reachable from sidecar code, so no per-promise catch exists for it — the
//    prevention is simply never producing the late resolution). Any UNFORESEEN
//    unhandledRejection/uncaughtException keeps Node's default fatal behavior
//    so Rust's exit-eviction/SIDECAR_EXITED path engages (ADR 2.1) — deliberately
//    crash loudly rather than wedge alive. Reviewer's preference (handle at the
//    originating promise) was assessed: impossible for the SDK-internal floating
//    promise; source-prevention + crash-on-unforeseen is the correct shape.
// 6. bypassPermissions mode: no request emitted, immediate allow (preserve existing
//    behavior, exercised via a canUseTool-shaped adapter helper exported from the module)
// 7. AskUserQuestion routes to the question path even under bypassPermissions
//    (legacy ordering: question check precedes bypass check — sdk-bridge.ts:203-214).
// 8. No-guard invariant probe: spawn a probe (child node process) that imports index.mjs
//    with a held-open stdin pipe, rejects a synthetic promise, then closes stdin —
//    assert the process exited NONZERO on the rejection (default fatal handling kept;
//    crash preserves the Rust exit-eviction path; a wedged-alive sidecar is the
//    unacceptable state).
// 9. Provider-originated cancellation (options.signal; fresh-eyes round-2 F1; AGENT-05's
//    "provider cancellation removes the card without inventing a user decision"):
//    raisePermissionRequest subscribes options.signal — on abort: delete the pending
//    entry, emit sdk.permission.cancelled, resolve the parked promise with
//    {behavior:'deny', message:'Aborted by provider'} (query still open in this state).
//    Node leaks these (its signal is never subscribed); this is a deliberate parity-plus
//    completing the checklist cell, recorded in the commit message.
// 10. PRODUCTION-WIRING contract test (fresh-eyes round-2 F4): index.mjs gets an
//    env-injected SDK seam — `FRESHELL_CLAUDE_SDK_QUERY_MODULE=<abs path to an ESM
//    module exporting query>` overriding the `@anthropic-ai/claude-agent-sdk` import
//    (dynamic import at startup; default = the real package). The vitest integration
//    case spawns the REAL index.mjs with a scripted fake query module whose query()
//    invokes options.canUseTool on cue (scripted via a control file/env), then drives
//    the FULL dispatch: create → magic send → canUseTool fires → sdk.permission.request
//    on stdout → permission.respond stdin → fake's parked promise settled with the exact
//    decision → interrupt while a second request parks → cancel frames. This exercises
//    canUseTool registration, stdin dispatch, question routing, and cancellation through
//    the production entry point — not just the extracted module.
```

Module shape (implementation target):

```js
// crates/freshell-claude-sidecar/permission-channel.mjs
// Pure-ish channel: state lives on the per-session record; functions take explicit deps.
export function ensurePending(session) // lazily add {pendingPermissions:Map, pendingQuestions:Map}
export function raisePermissionRequest({ session, emit, nanoid, nextMonotonic, sessionId, toolName, input, options })
  // mint requestId=nanoid(); session.pendingPermissions.set(requestId, {…, resolve});
  // emit sdk.permission.request; if combined pending count went 0→1 emit sdk.turn.waiting
  // (at monotonic); return new Promise(resolve=>…) — resolves ON respond/cancel.
export function raiseQuestionRequest({ … }) // AskUserQuestion sanitize (legacy handleAskUserQuestion
  // sdk-bridge.ts:571-626); invalid array → {behavior:'allow',updatedInput:input}
export function respondPermission(session, requestId, decision) // delete+resolve verbatim, bool
export function respondQuestion(session, requestId, answers)    // wrap per spec above, bool
export function cancelPending(session, emit, sessionId, { resolveDeny }) // cancel frames,
  // clears maps; resolves deny ONLY when resolveDeny is true (query open — post-interrupt);
  // post-close callers pass false (LB-04: late resolve → unhandled rejection → crash)
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/claude-sidecar/permission-channel.test.ts --config config/vitest/vitest.server.config.ts`

(VALIDATED fix — LB-06: omitting `--config` makes the coordinator prepend its own `run --config`, leaving the literal `run` as a substring filter that mis-fires across ~11 unrelated files; the explicit-config form targets exactly one file. Verified by execution.)

Expected: FAIL because `permission-channel.mjs` does not exist (import error).

- [ ] **Step 3: Add the minimal production implementation**

Write `permission-channel.mjs` per the shape above (port, not paraphrase, of the cited sdk-bridge functions). Wire `index.mjs`:
1. Session record (creation sites) gains lazy `{pendingPermissions: new Map(), pendingQuestions: new Map()}` via `ensurePending`.
2. `canUseTool` becomes:
```js
canUseTool: async (toolName, input, options) => {
  const s = sessions.get(sessionId)
  if (!s) return { behavior: 'allow', updatedInput: input }
  if (toolName === 'AskUserQuestion') {
    return raiseQuestionRequest({ session: s, emit, nanoid, nextMonotonic, sessionId, input, signal: options?.signal })
  }
  if (s.permissionMode === 'bypassPermissions') return { behavior: 'allow', updatedInput: input }
  return raisePermissionRequest({ session: s, emit, nanoid, nextMonotonic, sessionId, toolName, input, options })
}
```
`options` carries `toolUseID/suggestions/blockedPath/decisionReason/signal`; the payloads pass through into the emitted frame; `signal` IS subscribed (review round-2 F1) — on abort the pending entry is deleted, `sdk.permission.cancelled`/`sdk.question.cancelled` is emitted, and the parked promise resolves `{behavior:'deny', message:'Aborted by provider'}` (query open in this state).
3. stdin dispatch adds:
```js
case 'permission.respond': {
  const s = sessions.get(m.sessionId); if (!s) break
  respondPermission(s, String(m.requestId), m.decision)
  break
}
case 'question.respond': {
  const s = sessions.get(m.sessionId); if (!s) break
  respondQuestion(s, String(m.requestId), m.answers && typeof m.answers === 'object' ? m.answers : {})
  break
}
```
(An unknown requestId is a lose-safely no-op — Rust validates against its pending set first, Task 2. Log to stderr only.)
4. On `interrupt`: per affected session `cancelPending(session, emit, sessionId, { resolveDeny: true })` (transport still open — safe). On `shutdown`/process teardown: `cancelPending(..., { resolveDeny: false })` — emit cancel frames for card cleanup, never resolve parked promises (LB-04). Track query-open state per session (a flag set false when the query generator closes/cleanup completes).
5. Install NO process-level handlers (reviewed guard design above). Add the env seam:
```js
const sdkModule = await import(process.env.FRESHELL_CLAUDE_SDK_QUERY_MODULE || '@anthropic-ai/claude-agent-sdk')
```
   and use `sdkModule.query` everywhere (default resolution unchanged without the env).
6. Update the header protocol comment and the out-of-scope note at index.mjs:42-45 (response channel is now in scope; the T2 auto-allow remains only for `bypassPermissions` sessions).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/claude-sidecar/permission-channel.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Keep the module dependency-injected (no imports of sessions-map/module state); ensure `nextMonotonic` reuse, not a second clock.

- [ ] **Step 6: Run impacted-test verification**

Sidecar is consumed by Rust only via newline-JSON (Task 2 lands that this run). VALIDATED impacted set (LB-06 — a vitest sweep over `git grep -l freshell-claude-sidecar -- test` hits only fixtures no vitest config owns, so it verifies nothing): prove no vitest-owned test code references the sidecar import path, then run the third-config helper suite that DOES own the adjacent fixtures:

Run: `! git grep -q "freshell-claude-sidecar" -- test/unit test/server test/integration ':(exclude)test/unit/server/claude-sidecar/**' && npm run test:e2e:helpers`

(Reviewed: bare `git grep` exits 1 on the intended no-match and would kill the `&&` chain — use the `!` negation so the intended silence is the success path.)

Expected: grep silent (excluding the new test) + helpers suite PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-claude-sidecar/ test/unit/server/claude-sidecar/
git commit -m "feat(claude-sidecar): interactive permission/question response channel (AGENT-05/06 sidecar half)"
```

---

### Task 2: Rust `FreshClaudeState` approval/question/compact handlers + pending fold + WS dispatch

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs:128-154` (ClaudeSession pending field), `:1109-1245` (consumer fold), plus new handlers beside `handle_send` (`:663`)
- Modify: `crates/freshell-ws/src/terminal.rs:653-660` (intercept call), `:4613-4676` (refusal-table rewrite), dispatch match (new arms beside `:924-1012`)
- Test: `crates/freshell-freshagent/src/claude.rs` in-module tests + `crates/freshell-ws/tests/freshagent_control_reply.rs` (rewrite pins)

**Interfaces:**
- Consumes: protocol types `FreshAgentApprovalRespond`/`FreshAgentQuestionRespond`/`FreshAgentCompact` (`crates/freshell-protocol/src/client_messages.rs:584-645`); sidecar frames from Task 1.
- CLIENT DEFECT FIX (flagged per Global Constraints; fresh-eyes round-3 F3): provider-cancelled QUESTIONS currently leave a stale actionable card — the client folds `freshAgent.permission.cancelled` but has NO question-cancel path (the `removeQuestion` reducer exists in `freshAgentSlice.ts:435` with zero dispatch sites, and `freshAgent.question.cancelled` is absent from `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS`). Included in this task: (a) Rust `normalize_sdk_type` maps `sdk.question.cancelled` → `freshAgent.question.cancelled` (forwarded like the other sdk types — REPLACING the earlier "keep it dropped" instruction); (b) `src/lib/fresh-agent-ws.ts` case folds it to `dispatch(removeQuestion({requestId}))`; (c) `FreshAgentView.tsx` adds `'freshAgent.question.cancelled'` to the invalidating set so the snapshot-driven card clears even if the fold races. Unit tests: fold/slice test for removeQuestion dispatch; normalize test asserts the mapping exists.
- Produces:
- `FreshClaudeState::handle_approval_respond(&self, FreshAgentApprovalRespond)` — resolve session (same `resolve_session_key` discipline as `handle_send`); unknown session → **emit the nested `freshAgent.event{freshAgent.error{code:"INVALID_SESSION_ID", …}}` envelope** (the `lost_session_frame`/`handle_attach` shape, NOT `handle_send`'s top-level `ServerMessage::Error` — fresh-eyes round-3 F2: the client only surfaces top-level errors correlated with a pending send, which these control frames never establish; the nested envelope is the single error surface for all four handlers per Global Constraints, and `INVALID_SESSION_ID` additionally engages the client's lost-session recovery). requestId not in pending → nested envelope with `INTERNAL_ERROR` + `Claude approval <id> is not available`. REVIEWED ORDERING (fresh-eyes round-2 F3): on hit, `write_line({type:'permission.respond', sessionId: session.sidecar_session_id, requestId, decision})` FIRST (decision verbatim `serde_json::Value`) and remove the pending entry ONLY after the write's flush succeeds; a failed write leaves the entry pending (card stays; the user can retry) and surfaces the error via the nested envelope — never clear-then-fail. No ack frame. Regression test pinned: write failure → entry still pending + nested error emitted.
- `FreshClaudeState::handle_question_respond(...)` — identical ordering discipline; frame `{type:'question.respond', sessionId, requestId, answers}` (answers as a JSON object, Map→object).
  - `FreshClaudeState::handle_compact(...)` — writes `{type:'send', sessionId: sidecar_session_id, text}` where `text = "/compact"` or `format!("/compact {}", instructions.trim())` (empty → bare `/compact`). No ack frame (do not reuse `handle_send`'s send.accepted broadcast).
  - `FreshClaudeState::snapshot_pending_overlay(&self, any_id: &str) -> (Vec<serde_json::Value>, Vec<serde_json::Value>)` (approvals, questions) — consumed by Task 3.

Pending-set fold details:
- `ClaudeSession` gains `pending: Arc<std::sync::Mutex<ClaudePending>>` (follow `broadcast_id` precedent), `ClaudePending { permissions: Vec<PendingApprovalEntry>, questions: Vec<PendingQuestionEntry> }`; entries capture contract fields (`request_id: String`, `tool_name/tool_use_id/blocked_path/decision_reason: Option<String>`, `input: Option<Value>`; questions: `request_id`, `questions: Value`).
- Fold inside the consumer loop before the normalize/broadcast step: on `sdk.permission.request` push (de-dupe by requestId — resend replaces), on `sdk.permission.cancelled` remove, on `sdk.question.request` push, on `sdk.question.cancelled` remove (this frame is consumed by the fold only; `normalize_sdk_type` must NOT map it — add a test pinning it stays dropped from the broadcast). Session eviction on EOF/exit drops the Arc with the record; no extra handling.

Dispatch (`terminal.rs`):
- Replace `unhandled_fresh_agent_control_reply` with `fresh_agent_control_refusal(&ClientMessage) -> Option<ServerMessage>` returning `Some(freshAgent.event{freshAgent.error{code:'UNSUPPORTED_CAPABILITY', message:<parity text>}})` **only** for: (approval.respond, provider≠Claude) → `"Approvals are not supported for <session_type>"`; (question.respond, provider≠Claude) → Questions wording; (fork, provider=Claude) → `"Fork is not supported for <session_type>"`; (any of the four, provider=Amplifier) → matching wording. Returns `None` for every other combo (those route to real arms now or in Tasks 4-6; until Task 4/5/6 lands, codex/opencode compact/fork combos TEMPORARILY keep getting refusals via these same cells with `"Compact is not supported for freshcodex"`-style text, and this plan's Tasks 4-6 shrink the table to the final shape).
- New arms (spawn-detached, mirroring `FreshAgentSend` at :924):
```rust
ClientMessage::FreshAgentApprovalRespond(m) => {
    if m.provider == freshell_protocol::AgentProvider::Claude {
        let fresh_claude = state.fresh_claude.clone();
        tokio::spawn(async move { fresh_claude.handle_approval_respond(m).await }
            .instrument(tracing::Span::current()));
    }
    true
}
// FreshAgentQuestionRespond, FreshAgentCompact claude-provider arms identical in shape.
```

- [ ] **Step 1: Write the failing behavioral tests**
  - claude.rs (fake-sidecar route): extend `FakeClaudeSidecarEnv`'s scripted fake (`claude.rs:2087-2129`) with: magic send `__raise_permission__` → emit `sdk.permission.request{requestId:"req-1", tool:{name:"Bash",input:{command:"ls"}}}` + park nothing (fake needs no promise); stdin arms for `permission.respond`/`question.respond` appending full lines to a new `FRESHELL_TEST_CLAUDE_RESPOND_LOG`. Tests: (a) approval.respond writes exact stdin frame w/ `sidecar_session_id` + verbatim decision and removes the pending entry; (a2) write failure (fake sidecar's stdin closed / flush error — use the fake's `__exit__` mechanic to kill the child first) keeps the pending entry and emits the error (fresh-eyes F3 regression pin); (b) unknown requestId → freshAgent.error hub-frame with parity message, no stdin write; (c) question.respond writes frame incl. answers object; (d) compact writes `{type:'send', text:"/compact"}` and `"/compact focus the diff"`; (e) same for SessionType::Kilroy (flavour preserved on error envelopes); (f) fold tests: feed `sdk.permission.request`/`sdk.question.request`/`sdk.permission.cancelled`/`sdk.question.cancelled` through the consumer path → pending set content matches; (g) normalize FORWARDS `sdk.question.cancelled` as `freshAgent.question.cancelled` (round-3 F3 replaces the earlier drop instruction); (h) client: fold test asserting `freshAgent.question.cancelled` dispatches `removeQuestion` and sits in the invalidating set.
  - terminal.rs/WS (`freshagent_control_reply.rs`): rewrite the four UNSUPPORTED_MESSAGE pins into the refusal matrix: codex approval.respond → "Approvals are not supported for freshcodex"; claude fork → "Fork is not supported for freshclaude"; kilroy approval.respond reaches dispatch (no refusal frame emitted); claude compact reaches dispatch.
- [ ] **Step 2: Run and verify intended failures**
  - Run: `cargo test -p freshell-freshagent approval` (+ `question`/`compact`/`pending`) — Expected: FAIL (no handlers/fields)
  - Run: `cargo test -p freshell-ws --test freshagent_control_reply` — Expected: FAIL (matrix text mismatch)
- [ ] **Step 3: Add the minimal production implementation** — as specified in Files/Interfaces above.
- [ ] **Step 4: Run the focused tests** — `cargo test -p freshell-freshagent claude:: && cargo test -p freshell-ws --test freshagent_control_reply` — Expected: PASS
- [ ] **Step 5: Refactor while green** — extract a shared `resolve_session_for_frame` helper only if three handlers show identical prologue; otherwise state no refactor.
- [ ] **Step 6: Impacted-test verification** — `cargo test -p freshell-freshagent -p freshell-ws` — Expected: PASS. Client leg: `npm run test:vitest -- run test/unit/client/lib/fresh-agent-ws --config config/vitest/vitest.config.ts` (adjust the exact existing test-file name at implementation; pin via nearest existing fresh-agent-ws test) — PASS. Also `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings`.
- [ ] **Step 7: Commit**
```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_control_reply.rs crates/freshell-freshagent/src/claude.rs src/lib/fresh-agent-ws.ts src/components/fresh-agent/FreshAgentView.tsx test/unit/client/lib/
git commit -m "feat(fresh-agent): route claude/kilroy approval+question responses and compact to the sidecar; question-cancel client path (AGENT-05/06 rust half, AGENT-04 claude leg)"
```

---

### Task 3: Snapshot pending overlay + capability gates (reload-while-pending)

Cards render from the REST snapshot only, and no WS replay exists — the snapshot must carry live pending entries (`server/fresh-agent/adapters/claude/normalize.ts:186-204, 226-232`).

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` — `snapshot_pending_overlay` (from Task 2)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs:554-627` + `crates/freshell-freshagent/src/snapshot.rs:60-75, 133-145` (SnapshotState claude field + route overlay)
- Modify: `crates/freshell-server/src/main.rs:1450-1454` (constructor plumbing)
- Test: `crates/freshell-freshagent/src/claude_snapshot.rs` tests + `crates/freshell-freshagent/src/snapshot.rs` tests

**Interfaces:**
- `SnapshotState::new(auth_token, fresh_codex, opencode_state, fresh_claude)` — update every construction site (main.rs, all tests building one).
- Route arm stays byte-identical output when the live pending set is empty (golden fixture `claude_snapshot.rs:907-918` MUST stay green unchanged); when non-empty: `pendingApprovals`/`pendingQuestions` populated (entry keys exactly `{requestId, toolName?, toolUseID?, blockedPath?, decisionReason?, input?}` / `{requestId, questions}` — `.strict()` contract, no extra keys) and `capabilities.approvals`/`capabilities.questions` flip to `true` (presence-of-pending gate, not capability-of-provider). Durable UUID → `cli_index` → map key (already the `resolve_session_key` discipline).

- [ ] **Step 1: Failing tests**
  - snapshot route test: insert fake claude session (existing `insert_fake_claude_session`) + staged pending entries → GET claude snapshot yields populated arrays + flipped gates; kilroy session-type variant identical with `"kilroy"`;
  - empty-pending test asserting response equals the pre-change JSON shape exactly (fields/values) — golden fixture stays untouched.
- [ ] **Step 2:** Run: `cargo test -p freshell-freshagent snapshot` — Expected: FAIL (SnapshotState has no claude field / overlay absent)
- [ ] **Step 3: Implementation** per above.
- [ ] **Step 4:** Run: `cargo test -p freshell-freshagent snapshot` — Expected: PASS
- [ ] **Step 5: Refactor** — none expected; note if the overlay closure can be a shared fn with the kilroy arm (do not duplicate logic).
- [ ] **Step 6:** `cargo test -p freshell-freshagent -p freshell-server` + fmt/clippy — Expected: PASS
- [ ] **Step 7: Commit**
```bash
git add crates/freshell-freshagent/src/{claude.rs,claude_snapshot.rs,snapshot.rs} crates/freshell-server/src/main.rs
git commit -m "feat(fresh-agent): claude/kilroy snapshot carries live pending approvals/questions (reload-while-pending, AGENT-05/06)"
```

---

### Task 4: Compact for codex and opencode

**Files:**
- Modify: `crates/freshell-freshagent/src/codex.rs` — new `FreshCodexState::handle_compact`. REVIEWED (fresh-eyes round-2 F5): do NOT send `/compact` as turn text — codex 0.147.0 has a real RPC `thread/compact/start` (params `{threadId}` per the generated `ThreadCompactStartParams`; no instructions field — the client's `instructions` are DROPPED for codex, upstream limitation; precedent: schema inventory `test/fixtures/coding-cli/codex-app-server/schema-inventory.ts:13,140` also records the `thread/compacted` notification). Implementation: new `CodexAppServerClient::compact_thread(threadId)` calling `thread/compact/start` (await its `Record<string,never>` response; error → the codex slice's existing error path). PROBED real 0.147.0 flow (fresh-eyes round-3 F4 closure; scratch probe, captured at /tmp/opencode — transcripts summarized in the run ledger): after the RPC returns, the notification flow is `thread/status/changed {status:{type:"active"}}` → `turn/started {turn:{id:<new>,…}}` → `item/started` → `thread/tokenUsage/updated` → `item/completed` → `thread/status/changed {status:{type:"idle"}}` → `turn/completed {turn:{status:"completed"}}`; a post-compact follow-up turn on the thread completed normally. NO `thread/compacted` notification arrived in the success flow, and NO new `CodexStatus` state is needed — busy and idle ride the existing consumer mapping (`adapter_event_to_frame` already handles `turn/started`/`turn/completed`/`thread/status/changed`), and the turn-complete chime gating already consumes `params.turn.status === 'completed'`. Consequences pinned in tests: (i) compact sets the session BUSY then IDLE with the server-authoritative completion when status==='completed'; (ii) a `turn/completed` with status 'failed'/'interrupted' after a compact produces NO completion chime; (iii) the Task-8 fake mirrors EXACTLY this notification sequence. Concurrency gate: refuse the RPC when the session has a running turn (`active_turn` set) with the existing error shape rather than letting the app-server EINVAL.
- Modify: `crates/freshell-opencode/src/serve.rs` — new `OpencodeServeManager::compact(session_id, provider_id, model_id, route)`: `POST /session/:id/summarize` via the private `json_request` helper (clone of `abort` at `:686`) with body `{providerID, modelID}` — VALIDATED contract (LB-03, falsified → redesigned; `/doc` schema: required `["providerID","modelID"]`, `additionalProperties:false`, 200 `boolean`; live probes: missing keys → 400). REVIEWED CONSTRAINT (fresh-eyes F2): the serve manager stores no session metadata — the model pair is an EXPLICIT PARAMETER supplied by the caller, never resolved crate-side.
  Resolution happens at the freshagent layer (`handle_compact`), in order: (1) `crate::model::split_opencode_model(session.model)` (the existing helper, `build_prompt_body` precedent opencode_ws.rs:937-948); (2) if unset/unsplittable: `GET /config` → its `model` key (probed: present, string-or-null) → `split_opencode_model` on it; (3) if still nothing: emit the error loudly (broadcast `freshAgent.error`, message naming the failed compact; no false success, no POST). The client's `instructions` are DROPPED for opencode (no-op upstream; legacy Node has the same degradation — its `serve-manager.ts:465-471` body shape 400s on 1.18.18 — note this divergence in the commit message).
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` — new `FreshOpencodeState::handle_compact`: silent no-op when `real_session_id` is none (legacy `adapter.ts:992-994`); otherwise REVIEWED lifecycle (fresh-eyes F3, legacy adapter.ts:356-410 verbatim): FIRST reset the session's `turn_aborted` and `turn_errored` flags to false (a prior interrupted/errored turn must not suppress this compact's completion edge), broadcast the running-status snapshot (the busy indicator must be visible before the upstream request settles), THEN `subscribe()` BEFORE POST → resolve the model pair per the `serve.rs` bullet → `manager.compact(real, provider_id, model_id, route)` → `await_idle(real, rx, DEFAULT_TURN_TIMEOUT, route)` → idle snapshot broadcast + `turn_complete_event` ONLY on success (`!turn_aborted && !turn_errored`, monotonic `at` via `next_monotonic_turn_complete_at`) — same shape as `handle_send`'s turn task at `:714-751`; a serve error flows to the existing error handling (no false turn-complete)
- Modify: `crates/freshell-ws/src/terminal.rs` — `FreshAgentCompact` arms for Codex/Opencode (same spawn-detached shape); shrink refusal table (Tasks 2) dropping the two compact cells
- Test: codex.rs/opencode_ws.rs/serve.rs in-crate tests + `freshagent_control_reply.rs` matrix update

**Interfaces:** codex fake app-server records `turn/start` payloads (existing test transport); opencode tests inject a mock `ServeHttpRequest` transport (existing pattern — `serve.rs:48-99`) capturing method/path/body.

- [ ] **Step 1: Failing tests**
  - codex: compact on live idle session → fake app-server recorded `thread/compact/start` with `{threadId}` exactly (NO turn/start, NO instructions key); the fake then drives the probed notification sequence → session snapshot goes busy→idle and the completion event fires ONLY for `status:'completed'` (failed/interrupted variants asserted NO completion); active turn busy → refusal error frame + no RPC; RPC error → error path, no fake completion.
  - opencode: compact on materialized session → POST `/session/:id/summarize` body `{providerID:"<p>", modelID:"<m>"}` derived per the two-step resolution; success → idle snapshot + gated turn-complete; serve error → error broadcast + no turn-complete; unmaterialized → no POST at all; compact after an aborted/errored prior turn (flags stale-true) → flags reset, turn-complete emitted on success; running snapshot precedes the POST.
  - WS matrix: codex/opencode compact no longer refused.
- [ ] **Step 2:** `cargo test -p freshell-freshagent -p freshell-opencode compact` — Expected: FAIL
- [ ] **Step 3: Implement** per Files/Interfaces.
- [ ] **Step 4:** same command — PASS
- [ ] **Step 5: Refactor** — opencode: extract the shared "run POST + await idle + gated chime" body between `handle_send`/`handle_compact` if the duplication is verbatim; otherwise state why not.
- [ ] **Step 6:** `cargo test -p freshell-freshagent -p freshell-opencode -p freshell-ws` + fmt/clippy (incl. `--features real-transport` variants for the two provider crates) — PASS
- [ ] **Step 7: Commit**
```bash
git add crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-opencode/src/serve.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_control_reply.rs
git commit -m "feat(fresh-agent): compact for freshcodex and freshopencode (AGENT-04)"
```

---

### Task 5: Fork for opencode (freshAgent.fork → freshAgent.forked)

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` — `FreshOpencodeState::handle_fork(msg, reply_sink: FrameSink)`; `manager.fork` already exists (`crates/freshell-opencode/src/serve.rs:697-713`)
- Modify: `crates/freshell-ws/src/terminal.rs` — FreshAgentFork opencode arm passing `conn_sink.clone()` (available in the dispatch context — `handle_client_text` receives it at `:621`; precedent: `create_gate.rs` `CreateOutput::Channel(&sink)`)
- Test: `opencode_ws.rs` in-crate tests; WS matrix test

**Interfaces:**
- Handle: resolve session by either id → gate: `real_session_id` none → reply on sink `freshAgent.event{freshAgent.error{code:"INVALID_SESSION_ID", message:"<parity: opencode session … has not materialized; cannot fork.">}}` (client recovery path engages — legacy throws `FreshAgentLostSessionError`); else `manager.fork(real, route, message_id)` → insert child `OpencodeSession` keyed by child id (dual-key precedent `:592-595`; inherit cwd from `child.directory ?? parent.cwd`, model, effort) → `spawn_serve_bridge` for the child → `record_binding` identity row (`:600-626` pattern) → reply on sink `ServerMessage::FreshAgentForked { request_id: msg.request_id, parent_session_id: msg.session_id, session_id: child.id, session_type, provider: Opencode, runtime_provider: Opencode, session_ref: {provider:'opencode', sessionId: child.id} }` (protocol type exists, `server_messages.rs:652-664`).
- REVIEWED CONTRACT (fresh-eyes F4/F5): (1) `serve.fork` gains an optional `message_id` — the probed 1.18.18 body schema is `{messageID?: ^msg…}` with `additionalProperties:false` (GET /doc), the selected-turn knob: when the client's `input` carries `atTurnId`, pass it ONLY if it matches the `^msg` shape (opencode turn ids are message ids); a non-`msg` value is dropped and the fork proceeds from the tip (never send unknown keys to this strict schema). (2) EVERY failure reply path must emit on the sink: serve error (e.g. 500/400) → reply `freshAgent.event{freshAgent.error{code:"INTERNAL_ERROR", message:<serve error text>}}` BEFORE any state change assertion — a Fork click must never die silently (this is the bug class the whole run exists to kill).
- Refusal table shrinks again (opencode fork cell drops).

- [ ] **Step 1: Failing tests** — mock transport fork response `{id:"ses_child", directory:"/tmp/x"}` → child session in map + bridge started + sink received exact `freshAgent.forked` (assert every field incl. request_id echo); unmaterialized parent → INVALID_SESSION_ID error on sink, no POST; serve 500 → no child insert **AND sink received the freshAgent.error frame with the serve error text** (fresh-eyes F5: failure-without-reply is the exact defect class being eliminated); `input.atTurnId:"msg_abc"` → POST body carries `messageID:"msg_abc"`; `input.atTurnId:"not-a-msg"` → body omits `messageID` entirely (strict schema safety).
- [ ] **Step 2:** `cargo test -p freshell-freshagent opencode` — FAIL
- [ ] **Step 3: Implement** per above.
- [ ] **Step 4:** PASS
- [ ] **Step 5: Refactor** — none expected (child registration mirrors materialization registration; extract only if verbatim twice).
- [ ] **Step 6:** `cargo test -p freshell-freshagent -p freshell-opencode -p freshell-ws` + fmt/clippy (+real-transport) — PASS
- [ ] **Step 7: Commit**
```bash
git add crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-opencode/src/serve.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_control_reply.rs
git commit -m "feat(fresh-agent): fork freshopencode sessions (AGENT-07)"
```

---

### Task 6: Fork for codex (thread/fork + child registration)

**Files:**
- Modify: `crates/freshell-codex/src/app_server.rs` — three new RPCs (clones of the `resume_thread` shape at `:308`): `fork_thread` (`thread/fork`, params from the 0.147.0 generated type: `{threadId, lastTurnId?, model?, cwd?, approvalPolicy?, sandbox?}` — **NO `excludeTurns`**: 0.147.0 removed it from the schema; it is silently ignored if sent, and without it `result.thread.turns` is populated, child rollout keeps full history. REVIEWED (fresh-eyes F4): `lastTurnId` EXISTS on 0.147.0's ThreadForkParams ("turns after `last_turn_id` are omitted"; the referenced turn cannot be in progress) — pass the client's `input.atTurnId` through as `lastTurnId` when present, so per-turn fork genuinely forks through the selected turn), plus `archive_thread` (`thread/archive`) and `unarchive_thread` (`thread/unarchive`) — result shapes parsed loosely (generic success Value is enough for archive/unarchive; fork parses `.thread.id`)
- Modify: `crates/freshell-freshagent/src/codex.rs` — `FreshCodexState::handle_fork(msg, reply_sink: FrameSink)`
- Modify: `crates/freshell-ws/src/terminal.rs` — FreshAgentFork codex arm w/ conn_sink
- Test: app_server.rs + codex.rs tests; WS matrix test

**Interfaces:**
- `fork_thread(&self, params: ThreadForkParams) -> Result<Value, CodexAppServerError>` — the crate's error type is `CodexAppServerError` (`crates/freshell-codex/src/app_server.rs:75`; fresh-eyes round-2 F6 name correction) — (+ `compact_thread`, `archive_thread`/`unarchive_thread`, same plumbing); types alongside `StartThreadParams` etc.
- VALIDATED lifecycle (LB-01, real 0.147.0 probe): a cross-process `thread/resume(child)` while the parent app-server holds the child is REJECTED (`-32600 "thread … already has an active writer"` — thread-writer locks under CODEX_HOME). The proven while-alive handoff is **archive on parent → unarchive on child sidecar → resume on child sidecar**. Post-owner-exit resume also works (clean SIGTERM drops locks; SIGKILL leaves stale locks that 0.147.0 self-reclaims) — that's the restart-recovery shape, not the fork shape.
- Handler order: parent lookup (unknown → freshAgent.error on sink, lost-session shape) → build fork params: parent's stored settings (`model/effort/cwd/sandbox/permission_mode`), `input` overrides only cwd/model per legacy adapter spread, and `lastTurnId` derived from `input.atTurnId` with REVIEWED NORMALIZATION (fresh-eyes round-3 F6): the snapshot's codex turn ids may be synthetic split ids of the form `{raw_turn_id}:row-{index}` (`build_codex_turn_json`, codex.rs:3161/:3246) — strip a trailing `:row-<digits>` suffix before sending; codex expects the raw provider turn id (test pins `"...:row-2"` → raw; a non-split id passes verbatim) → `fork_thread` on the parent client (app-server error — e.g. empty parent `-32600 no rollout found for thread id` — → reply `freshAgent.error` on sink with the server error text; no state change) → `archive_thread(child)` on the parent client (releases the writer lock; failure → error reply, child still usable on parent) → spawn the child sidecar + client via the existing owned-sidecar machinery (`ensure_session_resumable`-adjacent, `:2261+`) → `unarchive_thread(child)` → `resume_thread(child)` on the child client → register the child `CodexSession` → binding row via `record_codex_binding` → sink reply `FreshAgentForked{ request_id: msg.request_id, parent_session_id, session_id: child, session_type:'freshcodex', provider:'codex', runtime_provider:'codex', session_ref }`.
- REVIEWED failure containment (fresh-eyes F6): after a successful `archive_thread(child)`, ANY later failure (child-sidecar spawn, `unarchive_thread`, `resume_thread`) must (a) reply `freshAgent.error` on the sink with the failing step's text, and (b) BEST-EFFORT `unarchive_thread(child)` on the PARENT client to restore the child's original visibility (ignore its own error — parent may be mid-kill), leaving the child recoverable via post-owner-exit resume. Zero silent exits on any post-fork path.
- Notes for the implementer (probed facts): empty parents cannot fork; fork is capability-gated client-side to idle parents (`fork: !is_running` in the snapshot, already true); the client kills the parent immediately after `forked` — that kill tears down only the parent sidecar and does not disturb the resumed child (post-owner-exit resume proven, incl. SIGKILL staleness).
- Rationale in the commit message: Node pins the child to the parent's app-server connection (`adapter.ts:1070`); the port deliberately registers the child on its own sidecar (one-thread-per-sidecar invariant), using the probed archive→unarchive→resume handoff.

- [ ] **Step 1: Failing tests**
  - app_server: `fork_thread` serializes `{threadId,…}` **without** `excludeTurns` (pin that absence), WITH `lastTurnId` when input carried atTurnId, and parses `.thread.id`; archive/unarchive serialize their method names (fake transport).
  - codex.rs (fake app-server WS): fork on parent → RPC call ORDER `thread/fork` → `thread/archive` (parent) → spawn#2: `thread/unarchive` → `thread/resume` (child client; assert spawn count and per-connection params) → child session exists + sink `freshAgent.forked` fields exact; parent unknown → error shape; `thread/fork` error → sink error, no archive call, no spawn; `thread/archive` failure → sink error, no spawn; POST-ARCHIVE failure containment (fresh-eyes F6) — three tests: child-sidecar spawn failure / child `thread/unarchive` failure / child `thread/resume` failure → each asserts sink error with step text AND parent's `thread/unarchive` called best-effort.
  - WS matrix: codex fork not refused.
- [ ] **Step 2:** `cargo test -p freshell-codex -p freshell-freshagent fork` — FAIL
- [ ] **Step 3: Implement.**
- [ ] **Step 4:** PASS
- [ ] **Step 5: Refactor** — the child-sidecar spawn+register should reuse the existing resume machinery verbatim; flag any forced duplication. Do NOT refactor the consumer into a multiplexer (option A) — invalidated as unnecessary by the probe.
- [ ] **Step 6:** `cargo test -p freshell-codex -p freshell-freshagent -p freshell-ws` + clippy incl. `-p freshell-codex --features real-transport` — PASS
- [ ] **Step 7: Commit**
```bash
git add crates/freshell-codex/src/app_server.rs crates/freshell-freshagent/src/codex.rs crates/freshell-ws/src/terminal.rs crates/freshell-ws/tests/freshagent_control_reply.rs
git commit -m "feat(fresh-agent): fork freshcodex threads via thread/fork (AGENT-07)"
```

---

### Task 7: Kilroy availability + ride-through coverage (AGENT-24)

**Files:**
- Modify: `crates/freshell-server/src/main.rs:2332-2355` (`build_platform_payload`) — `featureFlags.kilroy` = env `KILROY_ENABLED` truthy read with legacy parity — VALIDATED set (LB-finder B8): legacy is exactly `value === '1' || value.toLowerCase() === 'true'` (`server/platform-router.ts:15-18`; the `'yes'`-accepting helper elsewhere in `server/cli/index.ts:106` is a DIFFERENT function, do not mirror it) — including those comments' "no KILROY_ENABLED wiring yet" note
- Test: main.rs tests (`:3195-3213` currently pin `kilroy:false` — rewrite to env-matrix); kilroy coverage added to Task 2/3 test surfaces

- [ ] **Step 1: Failing tests** — with `KILROY_ENABLED=1` payload kilroy=true; unset/empty/"0" → false (each env case a separate test, under the existing env-mutation lock convention in that module).
- [ ] **Step 2:** `cargo test -p freshell-server platform_payload` — FAIL
- [ ] **Step 3: Implement** env read (find the crate's existing env-reading idiom; mirror).
- [ ] **Step 4:** PASS
- [ ] **Step 5: Refactor** — none.
- [ ] **Step 6:** `cargo test -p freshell-server` + fmt/clippy — PASS
- [ ] **Step 7: Commit**
```bash
git add crates/freshell-server/src/main.rs
git commit -m "feat(fresh-agent): KILROY_ENABLED gates kilroy feature flag, legacy parity (AGENT-24)"
```
(No kilroy-specific runtime code rides in this task: Tasks 2-3 handlers are session-type-flavoured already; their kilroy test variants pin AGENT-24's "approvals/questions" cells.)

---

### Task 8: PW-RUST e2e validation + checklist reconciliation

**Files:**
- Modify: `test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs` — VALIDATED extension (LB-05: reuse this HARNESS-03 fixture, do NOT author a parallel stub): add stdin arms in `handleInput()` (`:147-192`; today `create`/`send`/`interrupt`/`shutdown` only, no default arm — unknown types silently dropped) routing `permission.respond`/`question.respond` to `engine.handleMessage(msg)`; respond arms must DECREMENT the per-session pending counter (`st.pending`, `:159` — incremented by `waitingEdgeIfFirstPending`, today reset only by interrupt) so a second raise re-fires `sdk.turn.waiting`; add an env-gated raw-stdin JSONL appender using a `FRESHELL_FAKE_`-namespaced env var (e.g. `FRESHELL_FAKE_STDIN`, auto-records into the launch ledger; mirror `appendJsonl` at `:107-111`, which needs exporting). `on:'msg:permission.respond'`/`'msg:question.respond'` decision points + a `kind:'completion'` emission give the scripted continuation (`sdk.assistant` + `sdk.turn.complete` + `sdk.status:idle`, `fixture-core.mjs:101-118`); add a `sdk.result` render kind only if the spec pins it. Program DSL then drives: `RAISE_PERMISSION` → `sdk.permission.request{requestId:"req-perm-1", subtype:'can_use_tool', tool:{name:'Bash',input:{command:'ls'}}}` + park; `RAISE_QUESTION` (+ multi-select and `Other` variants) → `sdk.question.request{…}` + park; any `/compact…` text → `sdk.status{compacting}` → completion. VALIDATED SUB-DEPENDENCY — SETTLED (fresh-eyes F7): the fixture writes NO disk transcripts today while `get_claude_snapshot` returns NotFound without one and the cards render EXCLUSIVELY from the REST snapshot — so the fixture MUST gain transcript-write support on `create`/`sdk.session.init`: append a minimal JSONL transcript (one user entry; each completion appends the assistant/result entries) into `$HOME/.claude/projects/<cwd-mangled>/<cliSessionId>.jsonl` using the harness's isolated HOME (the server env supplies it; `applyIsolatedHomeEnvironment` precedent). This is in-pattern: the real CLI writes exactly there. Record the transcript-shape source (mirror `parse_transcript_turns`' accepted shape, claude_snapshot.rs) in the fixture header.
- Create: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`
- Modify: `test/e2e-browser/playwright.config.ts` — register spec in `RUST_ONLY_SPECS` AND the `rust-chromium` project's `testMatch` (both lists; convention verified)
- Modify: `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` (or its e2e mirror `test/e2e-browser/fixtures/providers/fake-codex-app-server.mjs` — pick the file the spec's CODEX_CMD actually points at; both must stay consistent) — new `thread/fork`/`thread/archive`/`thread/unarchive`/`thread/compact/start` arms per case 9
- Modify: `test/e2e-browser/fixtures/providers/fake-opencode-server.mjs` (+ `test/e2e-browser/fixtures/fake-opencode.cjs` shim if that's the spawned surface) — fork/summarize arms with audit logging
- Modify: `docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md` — tick/re-annotate AGENT-04/05/06/07/24 **only** as far as the evidence of this run justifies: annotate each row with its evidence class (PW-RUST browser via hermetic fakes for all four lanes + cargo suites; fake-vs-real semantic-fidelity caveat from case 9). Append a dated status note citing this plan.

**Test approach:** `RustServer` boot with `env: { FRESHELL_CLAUDE_SIDECAR: <fixture abs path>, FRESHELL_CLAUDE_NODE: process.execPath, FRESHELL_FAKE_STDIN: <tmp log> }` (`RustServerOptions.env` exists; precedent `freshclaude-identity-persistence-rust.spec.ts:231`). Drive the real browser: create a freshclaude pane (follow the bootstrap of an existing freshclaude rust spec). Cases:
1. **Approval allow:** send `RAISE_PERMISSION` via composer → approval card renders (snapshot poll) with tool name → click `Allow` (accessible name per `FreshAgentApprovalCard`) → stdin log contains `permission.respond` with `{behavior:'allow'}` **and zero respond lines before the click** → card clears → completion flows.
2. **Deny:** same then `Deny` → stdin log decision `{behavior:'deny', message:'Denied by user', interrupt:false}`; no success completion from that request (fixture's respond arm keyable on behavior); pane back to prompt-usable.
3. **Reload-while-pending:** raise → `page.reload()` → card re-renders from snapshot (exactly one entry) → Allow → works.
4. **Cancel (AGENT-05 cancellation cell):** raise → click composer's `Stop` (`aria-label="Stop"`) → card disappears without any `permission.respond` line in the stdin log (`freshAgent.permission.cancelled` → card removal + snapshot backstop).
5. **Question (three variants, AGENT-06):** `RAISE_QUESTION` single-choice → choose option A in `FreshAgentQuestionBanner` → stdin log `question.respond` with answers keyed by QUESTION TEXT (`{[questionText]: answer}` — verified `FreshAgentQuestionBanner.tsx:182`, e.g. `{"Pick one":"A"}`; NOT index-keyed) → completion flows. `RAISE_QUESTION_MULTI` (multiSelect:true) → select two → answers carry both labels. `RAISE_QUESTION_OTHER` → type free text in the Other input → answers carry the typed text. The banner's own validation (client-side) is covered by existing client unit tests; do not duplicate.
6. **Compact (AGENT-04 full clause):** type `/compact focus the diff` in composer → stdin log `send` with text `/compact focus the diff` → compacting indicator visible → turn completes → THEN send a follow-up prompt on the same pane → stdin log shows both sends on the SAME session id (retained-context proxy: the fixture's transcript accumulates the compacted summary entry + follow-up; assert the pane's durable session id unchanged before and after).
6b. **Always Allow (AGENT-05 session-scoped cell):** raise for tool `Bash` → click `Always Allow` on `FreshAgentApprovalCard` → raise the SAME tool again → the second respond is client-generated without a click (stdin log shows two `permission.respond{behavior:'allow'}` lines, only one click).
7. **Fork hidden for claude:** `/fork` absent from slash menu / fork affordance disabled (capabilities gate).
8. **Kilroy lifecycle section (AGENT-24, fresh-eyes round-3 F7):** a dedicated kilroy sub-suite running the fixture as kilroy (fixture default; the RustServer env for these cases includes `KILROY_ENABLED=1` — Task 7's gate — and passes the pane create with a non-bypass `permissionMode` where approval surfacing is asserted), covering the checklist's enumerated lifecycle: create → send → waiting edge → approval response → turn completion; question raise → answer; reload-while-pending (card restores, respond resolves); interrupt-cancel (card removed, zero respond lines); and restart/crash recovery (fixture `__exit__` path → pane recovery flow engages). If any sub-case collides with the fixture's limits (e.g. the real kilroy create flow needs model availability), record the exact gap in the spec doc comment and the checklist note — never silently drop it.
9. **Provider lanes in-browser — hermetic, no residual (fresh-eyes round-2 F7):** the repo ALREADY has boot-time fakes for every provider (fresh-eyes verified): codex via `CODEX_CMD="<node> <test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs>"` + `FAKE_CODEX_APP_SERVER_BEHAVIOR` JSON (pattern: freshagent-settings-resume-rust.spec.ts:248-255), opencode via `OPENCODE_CMD=<fake-opencode.cjs>` + `FAKE_OPENCODE_AUDIT_LOG` (:349-353). Extend those fakes with the new surface: fake codex app-server gains `thread/fork` (+ its lastTurnId echo into the operation log), `thread/archive`, `thread/unarchive`, `thread/compact/start` arms; fake opencode serve gains `POST /session/:id/fork` and `POST /session/:id/summarize` arms (audit-logging bodies). Browser cases: freshcodex Compact click → operation log has `thread/compact/start{threadId}` and NO `turn/start`; freshcodex Fork (from idle) → child session repoints the pane (freshAgent.forked flow) and the log shows fork→archive→(child client) unarchive→resume; freshcodex per-turn Fork → the log's fork params carry `lastTurnId` with `:row-N` normalized away; freshopencode Compact → audit log `summarize` body `{providerID,modelID}`; freshopencode Fork → child insert + pane repoint; freshopencode per-turn Fork → body carries `messageID`. AGENT-07 acceptance assertions (fresh-eyes round-3 F8, per provider lane): (a) source unchanged — after fork+parent-kill the fake's records show NO mutation/turn operation against the source thread/session rollout after the fork call (rollout is copy-on-write); (b) checkpoint divergence — drive the per-turn case from a parent with ≥2 turns: fork at turn 1 → child's history in the fake contains turn 1 but NOT turn 2 (codex: `lastTurnId` honored by the fake arm); (c) dual durability — after `page.reload()`, the child's freshAgent.attach/resume succeeds through the fake (`thread/resume` logged for the child id). Where a fake's existing arm lacks a detail, extend it in the same style (these fixtures are the harness's own, not frozen).
   Residual honesty note (record in checklist annotation): fakes pin contract shape + server/client wiring; real-provider semantic fidelity of compact content is out of scope for shape tests by design (and the real-provider contract suites are opt-in per repo policy).

- [ ] **Step 1: Failing tests** — spec runs against the unfixed server only insofar as TDD demands: at THIS point in the task order the underlying features are already implemented (Tasks 1-7), so the red step is: author spec + stub, run it, and confirm each assertion genuinely exercises the wiring (kill any vacuous assertion by mutation check: temporarily expect the pre-fix failure shape and see the test fail — e.g. assert no `permission.respond` line pre-click while also asserting card visible; comment in the spec how to run the pre-fix negative).
- [ ] **Step 2:** Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium fresh-agent-control-rust` — Expected: PASS against fixed code; record one deliberate pre-fix-style negative run (e.g. `RUST` server started with `FRESHELL_CLAUDE_SIDECAR` pointed at a no-op stub) proving the spec fails loudly without the wiring.
- [ ] **Step 3: Implement** spec + stub + config registration.
- [ ] **Step 4:** PASS (repeat run for stability)
- [ ] **Step 5: Refactor** — hoist stub-log polling helper into the spec (retry-until-line loop), follow existing e2e helper style; no shared-helper extraction unless a second spec would use it.
- [ ] **Step 6: Impacted runs** — checklist file edit + config edit: run `npx playwright test --config test/e2e-browser/playwright.config.ts --project=rust-chromium --list` to prove registration without selection errors; run the config's own unit tests: `npm run test:e2e:helpers`.
- [ ] **Step 7: Commit**
```bash
git add test/e2e-browser/fixtures/providers/fake-claude-sdk-sidecar.mjs test/e2e-browser/fixtures/providers/fixture-core.mjs test/e2e-browser/fixtures/providers/fake-codex-app-server.mjs test/e2e-browser/fixtures/providers/fake-opencode-server.mjs test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/playwright.config.ts docs/plans/2026-07-14-rust-tauri-parity-completion-checklist.md
git commit -m "test(fresh-agent): PW-RUST approval/question/compact/fork validation across providers; checklist AGENT-04/05/06/07/24 status"
```
(Conditional adds: `fixture-core.mjs` only if its export surface changed; `test/e2e-browser/fixtures/fake-opencode.cjs` and/or `test/fixtures/coding-cli/codex-app-server/fake-app-server.mjs` if the spec's spawn path uses them instead of the providers/ mirrors — stage exactly the files the spec references.)

---

## Execution-order and evidence map

| Task | Checklist | Primary evidence |
|---|---|---|
| 1 | AGENT-05/06 (sidecar) | vitest unit suite |
| 2 | AGENT-05/06 (rust), AGENT-04 (claude) | cargo unit + WS matrix |
| 3 | AGENT-05/06 (snapshot/reload) | cargo snapshot suite |
| 4 | AGENT-04 (codex/opencode) | cargo suites |
| 5-6 | AGENT-07 | cargo suites |
| 7 | AGENT-24 (availability) | cargo main.rs suite |
| 8 | all (PW-RUST) | rust-chromium spec |

Final whole-run gates (owned by the executing stage): `cargo test -p freshell-ws -p freshell-freshagent -p freshell-codex -p freshell-opencode -p freshell-server -p freshell-protocol`, fmt/clippy set (incl. real-transport variants), `npm run test:port` + contract regen diff-clean, `npm run test:vitest -- run test/unit/server/claude-sidecar/ --config config/vitest/vitest.server.config.ts` (explicit-config form per LB-06), focused PW spec green, then the coordinated full npm suite.
