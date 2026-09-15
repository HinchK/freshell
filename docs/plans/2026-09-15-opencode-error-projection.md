# OpenCode Error Projection Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Every error OpenCode's CLI can show must also appear in freshopencode panes, including errors that exist only in OpenCode's persisted session state (for example a provider request-deadline failure: a message saying the request deadline was exceeded with type request_deadline_exceeded). The pane must keep showing them durably, not only as a transient live banner.
- Implement this as a the-usual run in a worktree branch based on the latest origin/main.

### Explicit constraints
- Use the `the-usual` workflow.
- Base the work on the latest `origin/main`.
- Scope is the missing-error projection: the X-to-dismiss behavior for error modules is already implemented on the separate `fix/opencode-compact-timeout-error-dismiss` branch and is being landed independently; do not redo or disturb it.
- Do not create or open a PR without the user's explicit approval at that time (repository rule).

### Accepted tradeoffs and residuals
- None stated.

**Goal:** A freshopencode pane durably shows every error OpenCode persists that its CLI presents — the message-level `info.error` on the assistant message (including the provider request-deadline failure whose only record is `message.info.error` in OpenCode's session store) and the persisted `state.error` text on failed tool parts (LB-3: 1,089 persisted tool-error parts, 742 of them CLI-rendered as failures, all dropped by today's projection) — using the same displayed text and abort/interrupted presentation as the OpenCode CLI, so the failure is still visible after reload or resume instead of existing only as a transient live banner.

**Architecture:** `opencode_message_turn_json` (the single per-message projection used by `turns[]` and the rollback marker bucket) gains an optional turn-level `error: { name, message }` read from `message.info.error`; the message mirrors the TUI `errorMessage` helper exactly — a string `data.message` verbatim (the real deadline case persists the double-encoded provider `{message,type}` payload there), otherwise the whole persisted error object pretty-printed as `JSON.stringify(error, null, 2)` would render it (LB-4). `opencode_item_from_part`'s tool arm gains an optional `error` string carrying the persisted `state.error` text for failed tool parts (LB-2/LB-3). The shared strict zod contract learns both optional keys so a strict client cannot blank the pane. `FreshAgentTurnArticle` renders non-abort turn errors as a durable amber module and `MessageAbortedError` as a muted "interrupted" marker; `buildTranscriptLayout` treats an errored turn as a hard activity-line boundary and the render loop never skips an errored turn, so activity-only errored turns (the real absorbed shape — 16 live rows including two exact `request_deadline_exceeded` failures) mount their own article and module (LB-2). `FreshAgentItemCard` shows the persisted tool error text through its existing failed-output slot. No new endpoint, no WS frame shape change, and no new transcript item kind. Scope narrowing (review round 1, recorded): the durable carriers in scope are exactly the two OpenCode itself persists — `info.error` on the assistant message and `part.state.error` on tool parts. Live-only `session.error` events (for example model-not-found) intentionally keep the existing live-banner-only treatment, matching OpenCode's own CLI, which presents them as a transient toast and never persists them; no machinery, tasks, or tests target persisting live-only errors. The live `freshAgent.error` banner path is left untouched (the run declines banner dedupe/suppression; the live banner may coexist with the durable module).

**Tech Stack:** Rust (`freshell-freshagent`, `serde_json`, Axum route tests), `shared/fresh-agent-contract.ts` (zod), React/TypeScript transcript components, Vitest + Testing Library, Cargo tests, Playwright e2e with the Node fake `opencode` serve.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/opencode-error-projection`, branch `the-usual/opencode-error-projection`, base `d3c22bf203dbf903fa24fb64e8534e9ac6ec2b07` (plan commits 0027e3b61 and 41c36c05f sit on it; rebased here in review round 1; see the run record for the base moves). Do not touch `fix/opencode-compact-timeout-error-dismiss` or its commits; do not edit `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`, `src/store/freshAgentSlice.ts`, `src/lib/fresh-agent-ws.ts`, or the `FreshAgentView.tsx` banner/dismiss surface — this plan does not implement banner dedupe or dismissal, so the live `freshAgent.error` banner (including a transient abort banner) may coexist with the durable module.
- Base freshness (review round 1): before Task 1, `git fetch origin` and confirm the branch sits on the latest `origin/main`; if `origin/main` has moved past `d3c22bf203dbf903fa24fb64e8534e9ac6ec2b07`, rebase onto it before executing. If `origin/main` advances mid-execution, rebase and reconcile before the final full-suite gate, recording each base change in the run state.
- Error-carrier scope (review round 1 narrowing): only OpenCode's two persisted carriers are in scope — the assistant message's `info.error` (the turn-level `error`) and a tool part's `state.error` (the item-level `error`). Live-only `session.error` events (for example model-not-found) intentionally keep the existing transient `freshAgent.error` banner as their only surface, matching OpenCode's CLI, which presents them as a transient toast and never persists them; add no persistence machinery, tasks, or tests for them.
- Provider scope is opencode only. Do not change claude/codex builders, the serve bridge transport, `DEFAULT_TURN_UNTIMEOUT`/`DEFAULT_TURN_TIMEOUT`, timeout correlation, or add `freshAgent.error` to `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS` (the existing `freshAgent.session.changed`/idle refetch already delivers a late persisted error).
- The client contract is strict zod: a new wire key must be declared in the same branch change or `FreshAgentSnapshotSchema.safeParse` fails and the whole transcript is replaced by the load-error banner (`src/lib/api.ts:445-448`). Both new keys are optional; the server must always stamp a non-empty turn-error `message` and a non-empty tool `error` when either key is present.
- Copy policy (LB-4 binding): the displayed turn-error message is `data.message` when it is a non-empty string (raw string verbatim, including the double-encoded `request_deadline_exceeded` payload), otherwise `serde_json::to_string_pretty` of the whole persisted error object. The upstream helper requires a *truthy* `data.message`, so an empty string falls through to the JSON rendering exactly as the CLI does — and the `min(1)` wire rule then always sees non-empty text. The workspace enables serde_json `preserve_order` (`Cargo.toml:33`), so key order follows the wire: `{"name":"MessageOutputLengthError","data":{}}` renders exactly `{\n  "name": "MessageOutputLengthError",\n  "data": {}\n}`.
- Absorption contract (LB-2 binding): an errored turn is never absorbed into another turn's activity line and is never skipped as block-less. Activity-only errored turns that follow an assistant turn ending on an activity item are the hot path in real data, not an edge case.
- E2E coverage (LB-2/LB-7 binding): the Task 5 fixture must produce the absorbed activity-only errored shape (not only a text-carrying errored message), assert the durable module after reload, and use the cloud-legal lane and command form; the cloud run on committed HEAD must be recorded.
- TypeScript uses NodeNext/ESM; relative imports need `.js` suffixes. `@/` → `src/`, `@shared/` → `shared/`. No `dist/` artifacts are committed.
- Test backends: `~/.bashrc` exports `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud`; non-interactive shells must export them explicitly. Focused Vitest runs go through `npm run test:vitest -- ...` (always local); cloud Vitest runs use `npm run test:cloud`. Cloud e2e runs execute the committed HEAD only — commit before kicking a cloud run. Broad `npm test`/`test:unit`/cargo workspace runs wait for the coordinator gate; narrowed `cargo test -p ...` selectors are not gated.
- Local Playwright needs chromium once (`npm exec -- playwright install chromium`); the first local spec run builds the client and the release Rust server via global-setup. Rust toolchain is 1.96; Node >= 22.5.0.
- A11y: the durable module is static text with `role="alert"` (matching the existing live banner convention); the muted interrupted marker is static text; no new interactive controls.
- Do not update `docs/index.html`: a durable in-transcript error module on an existing transcript is a modest addition, not a major UI change.
- Conventional focused commits per task; do not create a PR (explicit user constraint) and do not restart the self-hosted server on port 3001 (no "APPROVED").
- The explorer reports live under `.worktrees/.the-usual-logs/opencode-error-projection/reports/`. The client-surface report recommended a new `kind: 'error'` transcript item, but this plan follows the run's design direction of an optional turn-level `error` field plus an optional `dynamic_tool.error` text field (smaller surface: no item-union kind, layout, signature, or classifier changes; zero-item turns already render their own article). The turn-field shape also avoids `appendTurnItems`/coalescing special cases because those spread `...previous`, and the tool-level text rides the existing failed-output rendering slot.
- Stage-2 validator evidence stays in the reports, cited by path: `reports/load-bearing-validator-lb2.md` (absorption), `reports/load-bearing-validator-lb3.md` (tool-part drop), `reports/load-bearing-validator-lb4.md` (CLI copy), `reports/load-bearing-validator-lb7.md` (cloud e2e feasibility).

---

### Task 1: Project persisted opencode errors into snapshot turns and tool items (Rust)

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (helpers near `opencode_model_from_info` ~:905; turn insertion in `opencode_message_turn_json` ~:1484-1486; tool arm in `opencode_item_from_part` ~:1308-1338; tests after `opencode_item_from_part_running_tool_has_no_content_items_or_success` ~:3864)
- Test: `crates/freshell-freshagent/src/lib.rs` (inline `#[cfg(test)]` module)
- Test: `crates/freshell-freshagent/src/snapshot.rs` (extend `opencode_snapshot_success_returns_200_with_camelcase_body`, ~:938-985)

**Interfaces:**
- Consumes: one `{info, parts}` message from `OpencodeServeManager::list_messages` (`GET /session/:id/message`); `info.error` may be the persisted OpenCode union object `{name: string, data?: {message?: string}, message?: string}`. Tool parts may carry `state.status:"error"` with a string `state.error` (LB-3: the persisted tool-error text; `state.output` is absent on these parts).
- Produces:
  - Optional snapshot turn key `error: {"name": string, "message": string}` — present exactly when `info.error` is an object, absent otherwise. `message` is the non-blank string `error.data.message` verbatim, else the pretty-printed whole error object (CLI `errorMessage` parity; see Global Constraints copy policy). Helper `fn opencode_turn_error_from_info(info: &Value) -> Option<Value>`.
  - Optional `error` string key on the emitted `dynamic_tool` item — present exactly when the tool part is `state.status:"error"` with a non-blank string `state.error`; omitted otherwise so existing completed/running exact-shape tests stay byte-identical.

- [ ] **Step 1: Write the failing Rust projection tests**

Append to the inline test module in `crates/freshell-freshagent/src/lib.rs` (after `opencode_item_from_part_running_tool_has_no_content_items_or_success`):

```rust
    #[test]
    fn opencode_item_from_part_error_tool_carries_the_persisted_state_error_text() {
        // LB-3: a persisted failed tool part has non-empty `state.error` and no
        // `state.output`; the TUI renders that text as the failure body. The
        // projection must carry it on the item.
        let part = json!({
            "type": "tool", "id": "part-err", "tool": "bash",
            "state": {
                "status": "error",
                "input": { "command": "false" },
                "error": "The user has specified a rule which prevents you from using this specific tool call.",
            },
        });

        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);

        assert_eq!(items[0]["status"], json!("failed"));
        assert_eq!(
            items[0]["contentItems"],
            Value::Null,
            "failed persisted parts carry no state.output"
        );
        assert_eq!(
            items[0]["error"],
            json!("The user has specified a rule which prevents you from using this specific tool call.")
        );
    }

    #[test]
    fn opencode_item_from_part_blank_tool_error_is_dropped() {
        let part = json!({
            "type": "tool", "id": "part-err-blank", "tool": "bash",
            "state": { "status": "error", "input": {}, "error": "   " },
        });

        let items = opencode_item_from_part(&part, "fallback", Some("assistant"), false);

        assert!(items[0].get("error").is_none(), "a blank persisted error carries no text");
    }

    #[test]
    fn opencode_message_turn_json_projects_the_persisted_unknown_error_verbatim() {
        // The exact persisted shape of the real provider request-deadline failure:
        // `fromError` JSON.stringify's the plain `{message,type}` stream error into
        // `UnknownError.data.message` (request_deadline_exceeded is embedded text,
        // never a structured field). The TUI helper emits a string `data.message`
        // verbatim, so the projection must too.
        let raw = r#"{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}"#;
        let message = json!({
            "info": {
                "id": "msg-deadline",
                "role": "assistant",
                "error": { "name": "UnknownError", "data": { "message": raw } },
            },
            "parts": [{ "type": "step-start" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("error-only turn builds");

        assert_eq!(turn["items"], json!([]), "the real deadline message has no displayable parts");
        assert_eq!(turn["error"]["name"], json!("UnknownError"));
        assert_eq!(
            turn["error"]["message"],
            Value::String(raw.to_string()),
            "the raw persisted string is surfaced as-is, matching the CLI"
        );
    }

    #[test]
    fn opencode_message_turn_json_renders_a_messageless_error_as_cli_pretty_json() {
        // LB-4: MessageOutputLengthError persists `data: {}`; the TUI helper
        // falls through to `errorFormat`'s `JSON.stringify(error, null, 2)`.
        // With the workspace serde_json `preserve_order` feature the key order
        // follows the wire (`name` then `data`), byte-identical to the CLI.
        let message = json!({
            "info": {
                "id": "msg-len",
                "role": "assistant",
                "error": { "name": "MessageOutputLengthError", "data": {} },
            },
            "parts": [{ "type": "step-start" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert_eq!(turn["error"]["name"], json!("MessageOutputLengthError"));
        assert_eq!(
            turn["error"]["message"],
            json!("{\n  \"name\": \"MessageOutputLengthError\",\n  \"data\": {}\n}")
        );
    }

    #[test]
    fn opencode_message_turn_json_projects_message_aborted_error() {
        let message = json!({
            "info": {
                "id": "msg-abort",
                "role": "assistant",
                "error": { "name": "MessageAbortedError", "data": { "message": "Aborted" } },
            },
            "parts": [],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert_eq!(
            turn["error"],
            json!({ "name": "MessageAbortedError", "message": "Aborted" })
        );
        assert_eq!(turn["items"], json!([]));
    }

    #[test]
    fn opencode_message_turn_json_omits_error_for_a_normal_assistant_turn() {
        let message = json!({
            "info": { "id": "msg-ok", "role": "assistant" },
            "parts": [{ "type": "text", "text": "all good" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert!(turn.get("error").is_none(), "a turn without info.error stays byte-identical");
    }

    #[test]
    fn opencode_message_turn_json_ignores_a_malformed_error_payload() {
        let message = json!({
            "info": { "id": "msg-bad", "role": "assistant", "error": "boom" },
            "parts": [{ "type": "text", "text": "still renders" }],
        });

        let turn = opencode_message_turn_json(&message, 0).expect("turn builds");

        assert!(turn.get("error").is_none(), "a non-object error is never fatal");
        assert_eq!(turn["items"][0]["text"], json!("still renders"));
    }
```

In `crates/freshell-freshagent/src/snapshot.rs`, extend the `messages_body` and assertions of `opencode_snapshot_success_returns_200_with_camelcase_body`:

```rust
                messages_body: json!([
                    { "info": { "id": "m1", "role": "user" }, "parts": [{ "type": "text", "text": "hi" }] },
                    { "info": { "id": "m2", "role": "assistant", "error": { "name": "UnknownError", "data": { "message": "boom" } } }, "parts": [{ "type": "step-start" }] },
                ]),
```

```rust
        assert_eq!(value["turns"][0]["items"][0]["text"], json!("hi"));
        assert_eq!(value["turns"][1]["error"]["name"], json!("UnknownError"));
        assert_eq!(value["turns"][1]["error"]["message"], json!("boom"));
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --locked opencode_message_turn_json`

Expected: FAIL — `..._projects_the_persisted_unknown_error_verbatim`, `..._renders_a_messageless_error_as_cli_pretty_json`, and `..._projects_message_aborted_error` fail because `turn["error"]` is `Null` (the projection never reads `info.error`). The `..._omits_error_for_a_normal_assistant_turn` and `..._ignores_a_malformed_error_payload` tests pass already; they are regression guards for the absence behavior.

Run: `cargo test -p freshell-freshagent --locked opencode_item_from_part`

Expected: FAIL — `..._error_tool_carries_the_persisted_state_error_text` fails because `items[0]["error"]` is `Null` (the arm never reads `state.error`). `..._blank_tool_error_is_dropped` and the existing exact-shape tool tests pass already (guards).

Run: `cargo test -p freshell-freshagent --locked opencode_snapshot_success`

Expected: FAIL because `value["turns"][1]["error"]["name"]` is `Null`.

- [ ] **Step 3: Add the minimal production implementation**

Add the turn-error helper immediately after `opencode_model_from_info` in `crates/freshell-freshagent/src/lib.rs`:

```rust
/// The CLI/TUI `errorMessage` rendering (`packages/tui/src/util/error.ts`): a
/// string `data.message` is shown verbatim (the real deadline failure persists
/// its provider payload double-encoded there); every other persisted shape is
/// pretty-printed as the whole error object, matching `errorFormat`'s
/// `JSON.stringify(error, null, 2)`. The workspace serde_json
/// `preserve_order` feature keeps the wire key order (`name`, then `data`).
/// An empty `data.message` falls through to the JSON rendering, exactly like
/// the helper's truthy-string check; the wire contract requires non-empty text.
fn opencode_turn_error_from_info(info: &Value) -> Option<Value> {
    let error = info.get("error")?;
    error.as_object()?;
    let name = error
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("UnknownError");
    let message = error
        .pointer("/data/message")
        .and_then(Value::as_str)
        .filter(|message| !message.is_empty())
        .map(str::to_string)
        .unwrap_or_else(|| {
            serde_json::to_string_pretty(error).unwrap_or_else(|_| "unknown error".to_string())
        });
    Some(json!({ "name": name, "message": message }))
}
```

In `opencode_message_turn_json`, immediately after the `model` insert (currently `lib.rs:1484-1486`):

```rust
    if let Some(error) = opencode_turn_error_from_info(&info) {
        turn.insert("error".to_string(), error);
    }
```

In `opencode_item_from_part`'s `Some("tool")` arm, after `success` is computed and before the `vec![json!({...})]`, read the persisted error text and carry it on the item:

```rust
            let error_text = state
                .get("error")
                .and_then(Value::as_str)
                .filter(|error| !error.trim().is_empty())
                .map(str::to_string);
```

```rust
            let mut item = json!({
                "id": id,
                "kind": "dynamic_tool",
                "namespace": "opencode",
                "tool": part.get("tool").and_then(Value::as_str).unwrap_or("tool"),
                "status": status,
                "arguments": arguments,
                "contentItems": content_items,
                "success": success,
            });
            if let Some(error_text) = error_text {
                item["error"] = json!(error_text);
            }
            vec![item]
```

The conditional insert (rather than `"error": null`) keeps the existing completed/running exact-equality tests and the codex `dynamic_tool` shapes byte-identical, matching the turn-level insertion style.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --locked opencode_message_turn_json`

Expected: PASS (all new turn tests plus the existing `opencode_message_turn_json_*` tests).

Run: `cargo test -p freshell-freshagent --locked opencode_item_from_part`

Expected: PASS (including `opencode_item_from_part_tool_part_renders_dynamic_tool_kind_with_exact_schema_keys`, which must stay green because the key is omitted when absent).

Run: `cargo test -p freshell-freshagent --locked opencode_snapshot_success`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Re-read both helpers: one read of `info.error` / `state.error`, no panics on any shape, no CLI copy invented outside the helper. Keep them module-private; do not move shared behavior into `freshell-opencode::events` (its `opencode_error_message` is a different precedence and stays untouched). Confirm the patch/`file_change` branch needs no error carrier: upstream `PatchPart` is `{id, sessionID, messageID, type:'patch', hash, files}` with no `state`/error field (v1.18.31 `packages/schema/src/v1/session.ts:94-99`), so there is no persisted patch error text to project. Run `cargo fmt --all` and re-run the three focused commands. No further refactor needed if the diff is the two helpers plus two insertions.

- [ ] **Step 6: Run impacted-test verification**

The projections feed `turns[]`, `rolledBackTurns`, the durable rollback ledger, and the REST snapshot route; the whole `freshell-freshagent` crate suite covers those callers.

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS (all crate tests, including `opencode_item_from_part_*`, `opencode_snapshot_*`, the rollback buckets, and the opencode WS bridge suite).

Run: `cargo fmt --all --check && cargo clippy -p freshell-freshagent --all-targets -- -D warnings`

Expected: PASS (no formatting or lint findings).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/snapshot.rs
git commit -m "feat(fresh-agent): project persisted opencode errors into snapshot turns and tool items"
```

---

### Task 2: Accept the optional turn-level and tool-level error keys in the shared contract

**Files:**
- Modify: `shared/fresh-agent-contract.ts` (`FreshAgentTurnSchema` ~:190-207; `dynamic_tool` item ~:128-137)
- Test: `test/unit/shared/fresh-agent-contract.test.ts` (import `FreshAgentTranscriptItemSchema`)

**Interfaces:**
- Consumes: Task 1's wire keys — turn `error: { name: string, message: string }` and `dynamic_tool.error: string`.
- Produces: `FreshAgentTurnSchema` accepting optional `error: { name: string; message: string }` (strict inner object); the `dynamic_tool` union member accepting optional `error: z.string().min(1)`. Inferred types `FreshAgentTurn['error']` (Task 3) and the item `error` (Task 4). `FRESH_AGENT_CONTRACT_SCHEMA_NAMES` and the traceability fixture stay untouched because both members are inline.

- [ ] **Step 1: Write the failing contract tests**

Append to `test/unit/shared/fresh-agent-contract.test.ts` (and add `FreshAgentTranscriptItemSchema` to the import from `shared/fresh-agent-contract.js`):

```ts
describe('durable opencode error projection (turn-level and tool-level)', () => {
  const deadlineRaw = '{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}'
  const toolErrorText = 'The user has specified a rule which prevents you from using this specific tool call.'

  it('parses a turn carrying the projected opencode error', () => {
    const parsed = FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [],
      error: { name: 'UnknownError', message: deadlineRaw },
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.error).toEqual({ name: 'UnknownError', message: deadlineRaw })
  })

  it('parses snapshots whose errored turn is the only carrier of the failure', () => {
    const parsed = FreshAgentSnapshotSchema.safeParse({
      sessionType: 'freshopencode', provider: 'opencode', threadId: 'ses_1',
      revision: 3, status: 'idle',
      capabilities: { send: true, interrupt: true, approvals: false, questions: false, fork: true },
      tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      turns: [{ id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'MessageAbortedError', message: 'Aborted' } }],
      extensions: {},
    })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.turns[0]?.error?.name).toBe('MessageAbortedError')
  })

  it('keeps the turn error key optional (claude/codex/legacy servers omit it)', () => {
    const parsed = FreshAgentTurnSchema.safeParse({ id: 't1', turnId: 't1', summary: 's', items: [] })
    expect(parsed.success).toBe(true)
    expect(parsed.data && 'error' in parsed.data).toBe(false)
  })

  it('rejects a turn error without a message', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'UnknownError' },
    }).success).toBe(false)
  })

  it('rejects a blank turn error message', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'UnknownError', message: '' },
    }).success).toBe(false)
  })

  it('rejects unknown keys inside the turn error (strict)', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [],
      error: { name: 'UnknownError', message: 'boom', code: 'request_deadline_exceeded' },
    }).success).toBe(false)
  })

  it('parses a persisted opencode tool error on a dynamic_tool item', () => {
    const parsed = FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'failed', arguments: { command: 'false' }, contentItems: null, success: null,
      error: toolErrorText,
    })
    expect(parsed.success && parsed.data.kind === 'dynamic_tool' && parsed.data.error).toBe(toolErrorText)
  })

  it('keeps the tool error key optional and rejects blank or non-string values', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'completed', arguments: {}, contentItems: ['ok'], success: true,
    }).success).toBe(true)
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'failed', arguments: {}, contentItems: null, success: null, error: '',
    }).success).toBe(false)
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
      status: 'failed', arguments: {}, contentItems: null, success: null, error: 42,
    }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: FAIL — the positive parse tests (`parses a turn carrying the projected opencode error`, `parses snapshots whose errored turn is the only carrier of the failure`, `parses a persisted opencode tool error on a dynamic_tool item`) fail because the strict schemas reject the undeclared `error` keys. The rejection/omission tests pass already (the whole object is currently rejected as unknown-key); they become inner-rule guards after Step 3.

- [ ] **Step 3: Add the minimal production implementation**

In `shared/fresh-agent-contract.ts`, inside `FreshAgentTurnSchema` after the `model` field:

```ts
  // OpenCode persists provider/abort errors on the assistant message
  // (`info.error`, `{name, data}`); the snapshot projects them onto the owning
  // turn. The message mirrors the CLI's `errorMessage` helper: a string
  // `data.message` verbatim, else the whole persisted error object as
  // pretty-printed JSON. Optional and opencode-only: claude, codex, and older
  // servers omit it.
  error: z.object({
    // OpenCode error class, e.g. 'UnknownError' / 'MessageAbortedError'.
    name: z.string().min(1),
    // Non-empty display text; the server always stamps prose.
    message: z.string().min(1),
  }).strict().optional(),
```

In the `dynamic_tool` member of `FreshAgentTranscriptItemSchema`, after `success`:

```ts
    // Persisted opencode tool failure text (`part.state.error`), CLI-visible
    // in the TUI's failed tool blocks. Optional: absent on every non-error
    // state and on other providers.
    error: z.string().min(1).optional(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Keep both members inline (a named exported schema would require a traceability-fixture row in `test/fixtures/fresh-agent/contract-traceability.ts` for no behavioral gain). Confirm the field ordering in both schemas does not affect the inferred types. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The turn and item schemas are shared by every snapshot consumer; the impacted set is the contract suites, the turns helper suite, the client snapshot fetch test, and the claude/codex golden-fixture contract tests (their turns and dynamic_tool items must still parse without the new keys).

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-turns.test.ts test/unit/client/lib/api.test.ts test/unit/contracts/rust-claude-snapshot-contract.test.ts`

Expected: PASS.

Run: `npm run typecheck:client`

Expected: PASS (the new optional fields type-check in `shared/` and `src/`).

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-contract.ts test/unit/shared/fresh-agent-contract.test.ts
git commit -m "feat(fresh-agent): accept optional turn-level and tool-level errors in the shared contract"
```

---

### Task 3: Render durable turn errors and muted interrupts; keep errored turns out of activity absorption

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (`buildTranscriptLayout` per-turn loop ~:315-326; render loop absorbed check ~:1171-1175; `FreshAgentTurnArticle` copy block ~:848-872)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: `FreshAgentTurn['error']` from Task 2; the existing `FreshAgentTurnArticle` render path (including the zero-item branch that renders its own article).
- Produces: DOM `[data-testid="fresh-agent-turn-error"]` with `role="alert"` and class `fresh-agent-error-module` for every non-abort error; DOM `[data-testid="fresh-agent-turn-interrupted"]` (muted italic text `interrupted`) for `MessageAbortedError`; no chrome at all when `turn.error` is absent. Layout contract: a turn carrying `error` hard-closes any open activity line before its items are processed (so its items never merge into a previous assistant's line), and the render loop never classifies an errored turn as absorbed (so its article — and module — always mounts).

- [ ] **Step 1: Write the failing render tests**

Add inside the top-level `FreshAgentTranscript` describe in `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (next to the tool-error test at ~:1283):

```tsx
  describe('durable turn errors (opencode projection)', () => {
    const deadlineRaw = '{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}'

    it('renders the durable error module after the turn items', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: 'partial reply', summaryKind: 'echo',
            error: { name: 'UnknownError', message: deadlineRaw },
            items: [{ id: 'item-1', kind: 'text', text: 'partial reply' }],
          }]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveAttribute('role', 'alert')
      expect(module).toHaveTextContent('request deadline exceeded after 1195s before the response completed')
      expect(module).toHaveTextContent('request_deadline_exceeded')
      const article = module.closest('article')
      expect(article).not.toBeNull()
      const text = article?.textContent ?? ''
      expect(text.indexOf('partial reply')).toBeGreaterThanOrEqual(0)
      expect(text.indexOf('partial reply')).toBeLessThan(text.indexOf('Agent error'))
    })

    it('renders the module for an activity-only errored turn in the absorbed shape (LB-2)', () => {
      render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', summaryKind: 'echo',
              items: [{
                id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
                status: 'completed', arguments: { command: 'true' }, contentItems: ['ok'], success: true,
              }],
            },
            {
              id: 'turn-2', turnId: 'turn-2', role: 'assistant', summary: '', summaryKind: 'echo',
              error: { name: 'UnknownError', message: deadlineRaw },
              items: [{
                id: 'reason-1', kind: 'reasoning',
                summary: ['the provider never answered'], content: ['the provider never answered'],
                text: 'the provider never answered',
              }],
            },
          ]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveTextContent('request deadline exceeded after 1195s before the response completed')
      // The errored turn is a hard boundary: it mounts its own article. Pre-fix
      // this turn was absorbed into turn-1's activity line and skipped entirely.
      expect(screen.getAllByRole('article', { name: 'Assistant transcript turn' })).toHaveLength(2)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })

    it('renders a zero-item errored assistant turn as a visible module (the persisted deadline shape)', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', items: [],
            error: { name: 'UnknownError', message: deadlineRaw },
          }]}
        />,
      )

      const module = screen.getByTestId('fresh-agent-turn-error')
      expect(module).toHaveAttribute('role', 'alert')
      expect(module).toHaveTextContent(deadlineRaw)
    })

    it('renders MessageAbortedError as a muted interrupted marker, never an error module', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', items: [],
            error: { name: 'MessageAbortedError', message: 'Aborted' },
          }]}
        />,
      )

      const marker = screen.getByTestId('fresh-agent-turn-interrupted')
      expect(marker).toHaveTextContent('interrupted')
      expect(within(marker.closest('article')!).queryByRole('alert')).not.toBeInTheDocument()
      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
    })

    it('renders the muted interrupted marker for an activity-only aborted turn after an activity turn', () => {
      render(
        <FreshAgentTranscript
          turns={[
            {
              id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: '', summaryKind: 'echo',
              items: [{
                id: 'tool-1', kind: 'dynamic_tool', namespace: 'opencode', tool: 'bash',
                status: 'completed', arguments: { command: 'true' }, contentItems: ['ok'], success: true,
              }],
            },
            {
              id: 'turn-2', turnId: 'turn-2', role: 'assistant', summary: '', summaryKind: 'echo',
              error: { name: 'MessageAbortedError', message: 'Aborted' },
              items: [{
                id: 'reason-1', kind: 'reasoning',
                summary: ['stopped mid-flight'], content: ['stopped mid-flight'],
                text: 'stopped mid-flight',
              }],
            },
          ]}
        />,
      )

      const marker = screen.getByTestId('fresh-agent-turn-interrupted')
      expect(marker).toHaveTextContent('interrupted')
      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
      expect(within(marker.closest('article')!).queryByRole('alert')).not.toBeInTheDocument()
    })

    it('renders no error chrome for a turn without an error (regression)', () => {
      render(
        <FreshAgentTranscript
          turns={[{
            id: 'turn-1', turnId: 'turn-1', role: 'assistant', summary: 'ok',
            items: [{ id: 'item-1', kind: 'text', text: 'ok' }],
          }]}
        />,
      )

      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
      expect(screen.queryByTestId('fresh-agent-turn-interrupted')).not.toBeInTheDocument()
    })
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: FAIL — `getByTestId('fresh-agent-turn-error')` / `getByTestId('fresh-agent-turn-interrupted')` find nothing because the transcript ignores `turn.error` today; the absorbed-shape test additionally fails because turn-2 is absorbed (the existing `fully absorbed turns render no article` suite pins that collapse). The regression test passes already.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, in `buildTranscriptLayout`'s per-turn loop, make an errored turn a hard boundary before its items are processed:

```ts
  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    if (turn.error) {
      // LB-2 (stage-2 binding): an errored turn is a hard activity-line
      // boundary. Its durable module renders in its own article, so its
      // activity items must never be absorbed into a previous assistant's
      // open line — absorbed turns get no blocks and the render loop below
      // skips them entirely.
      flushOpen(true)
    }
    if (turn.items.length === 0) {
      flushOpen(true)
      continue
    }
```

In the `displayTurns.map` render loop, never classify an errored turn as absorbed:

```tsx
        {displayTurns.map((turn, index) => {
          const blocksForTurn = turnLayouts[index]?.blocks ?? []
          // An errored turn is never "absorbed": even when its item mix renders
          // no blocks (e.g. empty-text reasoning), its article must mount for
          // the durable error module. The layout gate above keeps its activity
          // items out of foreign lines.
          const absorbed = turn.items.length > 0 && blocksForTurn.length === 0 && !turn.error
          const isLastStreaming = isStreaming && index === displayTurns.length - 1
          if (absorbed) return null
```

In `FreshAgentTurnArticle`, inside the `fresh-agent-transcript-copy` div, just before its closing `</div>` (after the streaming-strip block at ~:869-871):

```tsx
        {turn.error && turn.error.name !== 'MessageAbortedError' ? (
          <div
            role="alert"
            data-testid="fresh-agent-turn-error"
            className="fresh-agent-error-module rounded-md border border-amber-500/50 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <div className="font-medium">Agent error</div>
            <div className="whitespace-pre-wrap break-words">{turn.error.message}</div>
          </div>
        ) : null}
        {turn.error?.name === 'MessageAbortedError' ? (
          <div
            data-testid="fresh-agent-turn-interrupted"
            className="text-xs italic text-muted-foreground"
          >
            interrupted
          </div>
        ) : null}
```

Placement note: the module goes after the turn's items/summary (the TUI renders the persisted error block after the message body) and inside the copy column, so the zero-item `summary: ''` markdown fallback above it renders nothing and the module is the only content.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: PASS (the new block plus the whole existing transcript suite, including the `fully absorbed turns render no article` collapse test for turns without errors).

- [ ] **Step 5: Refactor while green**

The two JSX branches are intentionally small and presentational; the transcript's render blocks are untouched beyond the two guards. Confirm an errored turn's activity items still get their own line (articles for the absorbed-shape tests carry an Activity strip) and that turns without `error` keep byte-identical layout behavior. Run `npm run lint` (jsx-a11y) and the focused test again. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The change is confined to the transcript layout/render; the impacted set is the transcript suite plus the item-card suite (same article tree).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`

Expected: PASS.

Run: `npm run lint && npm run typecheck:client`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat(ui): render durable opencode turn errors and keep errored turns out of activity absorption"
```

---

### Task 4: Surface persisted tool-error text in the item card

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentItemCard.tsx` (`itemToToolDisplay` `dynamic_tool` branch ~:184-193)
- Test: `test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`

**Interfaces:**
- Consumes: the optional `dynamic_tool.error` string from Task 2 (the Task 1 wire key).
- Produces: `FreshAgentToolDisplay.output` for a failed `dynamic_tool` item falls back to the persisted error text when `contentItems` is absent/null, so the existing collapsed `(error)` summary and the expanded destructive output `<pre data-tool-output>` render the CLI-visible text.

- [ ] **Step 1: Write the failing render tests**

Append to `FreshAgentItemCard.test.tsx` (inside the top-level describe):

```tsx
  it('renders the persisted opencode tool error text for a failed dynamic_tool', () => {
    const { container } = render(
      <FreshAgentItemCard
        item={{
          id: 'tool-err',
          kind: 'dynamic_tool',
          namespace: 'opencode',
          tool: 'bash',
          status: 'failed',
          arguments: { command: 'false' },
          contentItems: null,
          success: null,
          error: 'The user has specified a rule which prevents you from using this specific tool call.',
        }}
      />,
    )

    expect(screen.getByLabelText('error')).toBeInTheDocument()
    expect(screen.getByText('(error)')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'opencode.bash tool call' }))
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent(
      'The user has specified a rule which prevents you from using this specific tool call.',
    )
  })

  it('keeps rendering contentItems for a dynamic_tool without a persisted error (regression)', () => {
    const { container } = render(
      <FreshAgentItemCard
        item={{
          id: 'tool-ok',
          kind: 'dynamic_tool',
          namespace: 'opencode',
          tool: 'bash',
          status: 'completed',
          arguments: { command: 'true' },
          contentItems: ['PASS'],
          success: true,
        }}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'opencode.bash tool call' }))
    expect(container.querySelector('[data-tool-output]')).toHaveTextContent('PASS')
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`

Expected: FAIL — the failed-item test's expanded body renders the literal string `null` (the current `item.contentItems !== undefined ? formatJson(item.contentItems) : undefined` branch stringifies the JSON null) instead of the persisted error text. The regression test passes already (guard).

- [ ] **Step 3: Add the minimal production implementation**

In `itemToToolDisplay`'s `dynamic_tool` branch:

```ts
  if (item.kind === 'dynamic_tool') {
    return {
      id: item.id,
      name: item.namespace ? `${item.namespace}.${item.tool}` : item.tool,
      input: asRecord(item.arguments) ?? { arguments: item.arguments },
      // A persisted failed opencode tool carries its CLI-visible text in
      // `state.error` (never `state.output`), so the absent-JSON-null
      // contentItems path uses that text — the same destructive slot the card
      // already renders for failed tool output.
      output: item.contentItems != null
        ? formatJson(item.contentItems)
        : item.error ?? undefined,
      isError: item.status === 'failed' || item.success === false,
      status: item.status === 'running' ? 'running' : 'complete',
    }
  }
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

The change is one expression. Confirm the JSON-null meaning of `contentItems` (`null` = no output content) matches the Rust projection for both completed and failed parts and that `error` is undefined for every non-opencode provider. Run `npm run lint` and re-run the focused test. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The card is shared by the transcript article and the activity strip; the impacted set is the item-card suite plus the transcript suite.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: PASS.

Run: `npm run lint && npm run typecheck:client`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentItemCard.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx
git commit -m "feat(ui): surface persisted opencode tool-error text in the item card"
```

---

### Task 5: End-to-end durability of persisted message-level and tool-level errors through the fake opencode serve

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (`insertTextMessage` ~:165-187; `appendPromptMessages` ~:645-682)
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (`bootOpencodeLane` ~:2088-2126; `sendOpencodeTurn` ~:2133-2158; new test in the `fresh-agent control surfaces — opencode lane (rust)` describe ~:2160)
- Test: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (cloud-legal; not in `CLOUD_SKIP_SPECS` or `LOCAL_ONLY_SPECS`)

**Interfaces:**
- Consumes: Tasks 1-4; the fixture's existing `GET /session/:id/message` route (`fake-opencode.cjs:910-933`) and `messagesForSession` (`:549-589`), which spreads the persisted message `data` into `info` so a stored `data.error` arrives at Rust as `info.error`; the fake's part rows feed `state.error` the same way.
- Produces:
  - Fixture env switches — `FAKE_OPENCODE_PROMPT_ERROR=<inner provider message>`: the assistant turn is persisted in the absorbed shape: an assistant activity message ending on a failed `tool` part whose `state.error` is `FAKE_OPENCODE_TOOL_ERROR` (default `The user has specified a rule which prevents you from using this specific tool call.`), followed by an activity-only errored assistant message (`reasoning` part, no text) whose `info.error` is `{ name: 'UnknownError', data: { message: JSON.stringify({ message: <value>, type: 'request_deadline_exceeded' }) } }` — the exact double-encoded shape read from the real OpenCode DB. The activity-first ordering is what makes the errored turn the LB-2 absorbed shape.
  - `bootOpencodeLane(page, extraEnv?)` spreading `extraEnv` last; `sendOpencodeTurn(..., options?: { expectResponseText?: boolean })`; e2e test `durable provider error projects into the transcript and survives reload`.

- [ ] **Step 1: Write the failing e2e test and helper seams**

In `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`, change the lane helper signature and env merge:

```ts
async function bootOpencodeLane(
  page: Page,
  extraEnv: Record<string, string> = {},
): Promise<{
```

```ts
    const { server, info, harness } = await bootWall(page, {
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        OPENCODE_CMD: fakeOpencode,
        FAKE_OPENCODE_AUDIT_LOG: auditLogPath,
        ...extraEnv,
      },
      setupHome: seedWallConfig({ providers: ['opencode'], freshAgent: true }),
    })
```

Extend `sendOpencodeTurn` with an opt-out for the assistant-text wait (the error scenario persists no text part, keeping the errored turn activity-only):

```ts
async function sendOpencodeTurn(
  page: Page,
  harness: TestHarness,
  tabId: string,
  text: string,
  expectedPromptCount: number,
  auditLogPath: string,
  options: { expectResponseText?: boolean } = {},
): Promise<string> {
```

```ts
  // The assistant reply renders from the fake's own message store.
  if (options.expectResponseText !== false) {
    await expect(paneRoot).toContainText(`Fake OpenCode response: ${text}`, { timeout: 30_000 })
  }
  return (await paneLeaf(harness, tabId))?.content?.sessionId as string
```

Append this test inside the `fresh-agent control surfaces — opencode lane (rust)` describe:

```ts
  test('durable provider error projects into the transcript and survives reload', async ({ page }) => {
    const providerMessage = 'request deadline exceeded after 1195s before the response completed'
    const toolErrorMessage = 'The user has specified a rule which prevents you from using this specific tool call.'
    const lane = await bootOpencodeLane(page, {
      FAKE_OPENCODE_PROMPT_ERROR: providerMessage,
      FAKE_OPENCODE_TOOL_ERROR: toolErrorMessage,
    })
    try {
      await sendOpencodeTurn(
        page, lane.harness, lane.tabId, 'opencode error turn', 1, lane.auditLogPath,
        { expectResponseText: false },
      )

      // The snapshot refetch after idle carries the persisted info.error: the
      // activity-only errored turn mounts its own article + durable module.
      // Pre-fix (no errored-turn boundary) it merged into the first assistant
      // activity line and this locator never appeared.
      const transcript = page.locator('[data-context="fresh-agent-transcript"]')
      const errorModule = transcript.getByTestId('fresh-agent-turn-error')
      await expect(errorModule).toBeVisible({ timeout: 30_000 })
      await expect(errorModule).toContainText(providerMessage)
      await expect(errorModule).toContainText('request_deadline_exceeded')

      // The persisted tool-part state.error text is CLI-visible; the failed
      // tool row (single-tool strip) expands to show it.
      await transcript.getByRole('button', { name: 'Toggle activity details' }).first().click()
      await expect(transcript.locator('[data-tool-output]').first()).toContainText(toolErrorMessage)

      // Durability: both carriers re-derive from the REST snapshot after reload.
      await flushPersistence(page)
      await page.reload({ waitUntil: 'domcontentloaded' })
      const harness2 = new TestHarness(page)
      await harness2.waitForHarness()
      await harness2.waitForConnection()
      await expect(errorModule).toContainText(providerMessage, { timeout: 30_000 })
      await transcript.getByRole('button', { name: 'Toggle activity details' }).first().click()
      await expect(transcript.locator('[data-tool-output]').first()).toContainText(toolErrorMessage)

      // Wire-shape pin: the raw double-encoded provider payload survived as the
      // message, and the tool item carries the persisted error text.
      const sessionId = (await paneLeaf(harness2, (await harness2.getActiveTabId())!))?.content?.sessionId
      await expect(async () => {
        const snapshot = await fetchSnapshot(lane.info, 'freshopencode', 'opencode', sessionId)
        const erroredTurn = (snapshot?.turns ?? []).find((turn: any) => turn.error)
        expect(erroredTurn?.error?.name).toBe('UnknownError')
        expect(erroredTurn?.error?.message).toBe(
          JSON.stringify({ message: providerMessage, type: 'request_deadline_exceeded' }),
        )
        const toolErrorItem = (snapshot?.turns ?? [])
          .flatMap((turn: any) => turn.items ?? [])
          .find((item: any) => item.kind === 'dynamic_tool' && item.error)
        expect(toolErrorItem?.error).toBe(toolErrorMessage)
      }).toPass({ timeout: 30_000 })
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=chromium --grep="durable provider error" test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: FAIL because the fixture ignores `FAKE_OPENCODE_PROMPT_ERROR` and persists an ordinary text-only assistant message; no `info.error` or `state.error` reaches the snapshot, so `fresh-agent-turn-error` never appears. (First local run builds the client and the release Rust server via Playwright global-setup; prerequisites per Global Constraints.)

- [ ] **Step 3: Add the minimal fixture implementation**

In `test/e2e-browser/fixtures/fake-opencode.cjs`, factor message/part insertion so custom parts can be persisted, keeping `insertTextMessage`'s behavior byte-identical:

```js
function insertMessage(db, input) {
  db.prepare(`
      INSERT OR REPLACE INTO message (id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      input.messageId,
      input.sessionId,
      input.now,
      input.now,
      JSON.stringify({ role: input.role, ...(input.extra ?? {}) }),
    )
}

function insertPart(db, input) {
  db.prepare(`
      INSERT OR REPLACE INTO part (id, message_id, session_id, time_created, time_updated, data)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      input.partId,
      input.messageId,
      input.sessionId,
      input.now,
      input.now,
      JSON.stringify(input.data),
    )
}

function insertTextMessage(db, input) {
  insertMessage(db, input)
  insertPart(db, {
    sessionId: input.sessionId,
    messageId: input.messageId,
    partId: input.partId,
    now: input.now,
    data: { type: 'text', text: input.text },
  })
}
```

In `appendPromptMessages`, after the user insert, branch on the env switch to persist the absorbed errored shape instead of the default text reply:

```js
    // Durable provider-error scenario (LB-2/LB-3, e2e): an assistant activity
    // message ending on a failed tool (whose persisted `state.error` text is
    // CLI-visible), followed by an activity-only errored assistant message.
    // The second message is the absorbed shape: without the transcript's
    // errored-turn boundary it merged into the first assistant line and its
    // turn-level error module never mounted.
    const promptError = process.env.FAKE_OPENCODE_PROMPT_ERROR
    if (promptError) {
      const toolErrorText = process.env.FAKE_OPENCODE_TOOL_ERROR
        || 'The user has specified a rule which prevents you from using this specific tool call.'
      const activityMessageId = `${assistantMessageId}_activity`
      const activityTime = userTime + 1
      const erroredTime = userTime + 2
      insertMessage(db, {
        sessionId: input.sessionId,
        messageId: activityMessageId,
        role: 'assistant',
        now: activityTime,
      })
      insertPart(db, {
        sessionId: input.sessionId,
        messageId: activityMessageId,
        partId: `${activityMessageId}_part_tool`,
        now: activityTime,
        data: {
          type: 'tool',
          tool: 'bash',
          state: { status: 'error', input: { command: 'false' }, error: toolErrorText },
        },
      })
      insertMessage(db, {
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        role: 'assistant',
        now: erroredTime,
        extra: {
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({ message: promptError, type: 'request_deadline_exceeded' }),
            },
          },
        },
      })
      insertPart(db, {
        sessionId: input.sessionId,
        messageId: assistantMessageId,
        partId: `${assistantMessageId}_part_reasoning`,
        now: erroredTime,
        data: { type: 'reasoning', text: 'waiting for the provider response' },
      })
      db.prepare('UPDATE session SET time_updated = ? WHERE id = ?').run(erroredTime, input.sessionId)
      return { promptText, responseText, userMessageId, assistantMessageId, assistantTime: erroredTime }
    }
```

The default path (env unset) is byte-identical: the existing `insertTextMessage` call plus `UPDATE session SET time_updated` remain, with `assistantTime = userTime + 1` declared before them.

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=chromium --grep="durable provider error" test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: PASS — the module and the failed-tool error text show before reload and again after reload.

- [ ] **Step 5: Refactor while green**

Keep the fixture change env-gated and off by default so every existing spec is byte-identical in behavior. Confirm no spec was added to `CLOUD_SKIP_SPECS`/`LOCAL_ONLY_SPECS` and no other fixture consumer changed. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: the fixture's own parity suite and the existing opencode lane's default behavior (must be unchanged with the env unset).

Run: `npm run test:vitest -- run test/unit/provider-fixtures/fake-opencode-fixture.test.ts`

Expected: PASS.

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=chromium --grep="compact: POST /session/:id/summarize" test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: PASS (default fake behavior unchanged).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/specs/fresh-agent-control-rust.spec.ts
git commit -m "test(e2e): prove persisted opencode errors survive reload through the fake serve"
```

After this commit lands, run the same focused spec on the configured cloud backend (cloud runs the committed HEAD only):

Run: `npm run test:e2e:cloud -- --project=chromium --grep="durable provider error" test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: PASS; record the cloud run id in the progress ledger.

---

## Acceptance Mapping

| Requirement | Observable production outcome | Verification |
| --- | --- | --- |
| Every persisted OpenCode error the CLI shows appears in a freshopencode pane | Message-level `error {name,message}` from `info.error` AND tool-item `error` text from `state.error` | Task 1 unit + route tests; Task 5 e2e (module + failed-tool text) |
| The request-deadline failure (`request_deadline_exceeded`) displays as the CLI shows it | Raw persisted `data.message` string rendered verbatim (double-encoded payload included) | Task 1 deadline unit test; Task 3 render test; Task 5 e2e text assertion |
| Errors the CLI pretty-prints (e.g. `MessageOutputLengthError`) match the CLI | Pretty-printed whole `{name, data}` object, wire key order preserved | Task 1 exact-string unit test (LB-4) |
| Durability, not only a transient banner | Same module and tool text re-derive from `GET /api/fresh-agent/threads/freshopencode/opencode/:threadId` after reload/resume | Task 5 e2e reload assertions + wire-shape snapshot pin; REST route test Task 1 |
| Activity-only absorbed errored turns still render (LB-2) | Errored turn is an activity-line boundary and never skipped; module visible for the absorbed shape | Task 3 absorbed-shape render tests; Task 5 fixture absorbed shape |
| Aborts are muted, never alarming, no chime implication | `MessageAbortedError` renders `interrupted` (zero-item and activity-only); live banner behavior untouched | Task 3 abort render tests |
| No transcript item-union / classifier churn | Turn-level optional field + one optional dynamic_tool field | Task 2 schema diff; Task 3/4 render diffs |
| Dismiss work undisturbed | No edits to `FreshAgentApprovalBanner.tsx`, `freshAgentSlice.ts`, `fresh-agent-ws.ts`, `FreshAgentView.tsx` | Commit file lists per task |

## Self-Review

1. **Spec coverage.** Every active obligation maps to a task and an observable outcome (table above). The three explicit constraints are enforced by Global Constraints (the-usual process is the run itself; base `d3c22bf2` with the pre-execution latest-main check and the mid-execution rebase rule; no PR; dismiss branch untouched) and verified by the per-task file lists. The review-round-1 narrowing is recorded: durable parity covers OpenCode's two persisted carriers (`info.error`, `part.state.error`); live-only `session.error` keeps the CLI-matching transient banner treatment and gains no machinery, tasks, or tests. The stage-2 binding findings are dispositioned: LB-2 absorbed-shape boundary + tests (Task 3, Task 5), LB-3 tool-error extension through Rust item → strict zod → card (Tasks 1, 2, 4) plus the patch/`file_change` consistency check, LB-4 CLI-equivalent copy (Task 1), LB-5 Task 4 removal, LB-7 cloud-legal e2e form (Task 5).
2. **No silent deferrals.** No stubs or test-only seams: the production path is `lib.rs` (message + tool projections) → REST snapshot → zod contract → transcript module/item card, with the Task 5 e2e driving the real Rust server and fake serve through `GET /session/:id/message`. The one deliberate non-implementation is live-banner dedupe/suppression (LB-5 removed the abort-banner task), which the run direction explicitly declines; coexistence is stated in Global Constraints and covered by the acceptance mapping. Live-only `session.error` is likewise a recorded scope narrowing (review round 1), not a silent deferral: OpenCode's CLI never persists those, so the existing transient banner is the CLI-matching surface. The client-surface explorer's item-kind recommendation is deliberately not adopted (smaller turn-field + item-field surface; recorded in Global Constraints). The patch/`file_change` branch is inspected in Task 1's refactor step: persisted patch parts carry no error channel (`patch` parts have no `state`), so no change is needed; that rationale is stated there.
3. **File and interface consistency.** Task 1 emits `{name, message}` and the optional `dynamic_tool.error` string; Task 2 accepts exactly those shapes; Task 3 consumes `FreshAgentTurn['error']`; Task 4 consumes the `dynamic_tool` item `error`; Task 5 uses `fresh-agent-turn-error`, the exact testid Task 3 emits, and the fixture's persisted shape mirrors Task 1's inputs. Commands are repo-owned forms (`npm run test:vitest -- run ...`, `cargo test -p ... --locked`, `npm run test:e2e:local/cloud`). `fresh-agent-turn-interrupted` is produced and queried consistently.
4. **Executable tests.** Each task's positive tests fail before its production step for the intended missing behavior, verified against the current source: strict zod rejects the undeclared keys; the transcript ignores `turn.error` and collapses adjacent activity-only assistant turns (the existing `fully absorbed turns render no article` test pins that collapse, so the LB-2 positive test is red); the card stringifies JSON-null `contentItems` as `null`; the fixture ignores the env switch. The Task 1 pretty-JSON assertion pins the exact string the LB-4 validator executed upstream. Absence/malformed/regression tests are labeled as guards that pass in both states, so no reviewer mistake about vacuous reds.
5. **Placeholder scan.** No `TBD`/`TODO`/"implement later"/"handle edge cases"; every path, function, env var, fixture switch, testid, and command is defined in this plan. All Rust/TS snippets are complete and use real anchors from the current tree.
6. **Operational completeness.** No migration or config change; no server restart. Structured logs already cover the live bridge (`freshAgent.error` frames) and are unchanged. Rollback is a branch revert. `docs/index.html` is intentionally untouched (not a major UI change). Broad-suite and cloud e2e evidence is owned by the-usual Stage 5 plus the Task 5 post-commit cloud run (run id recorded); broad runs go through the test coordinator.

**UNRESOLVED COVERAGE GAP:** none.
