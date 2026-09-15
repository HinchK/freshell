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

**Goal:** A freshopencode pane durably shows every error OpenCode persists on an assistant message — including the provider request-deadline failure whose only record is `message.info.error` in OpenCode's session store — using the same text and abort/interrupted presentation as the OpenCode CLI, so the failure is still visible after reload or resume instead of existing only as a transient live banner.

**Architecture:** `opencode_message_turn_json` (the single per-message projection used by `turns[]` and the rollback marker bucket) gains an optional turn-level `error: { name, message }` read from `message.info.error`; the shared zod `FreshAgentTurnSchema` learns the same optional key so a strict client cannot blank the pane; `FreshAgentTurnArticle` renders non-abort errors as a durable amber module (raw `data.message` text verbatim, matching the CLI) and `MessageAbortedError` as a muted "interrupted" marker. The live serve bridge additionally suppresses the transient abort banner (the CLI never shows aborts as errors) while still latching `turn_errored` so an aborted turn cannot chime. No new endpoint, no WS frame shape change, no new transcript item kind, and no `session.error` persistence — `info.error` on the assistant message is OpenCode's only durable error carrier.

**Tech Stack:** Rust (`freshell-freshagent`, `serde_json`, Axum route tests), `shared/fresh-agent-contract.ts` (zod), React/TypeScript transcript components, Vitest + Testing Library, Cargo tests, Playwright e2e with the Node fake `opencode` serve.

## Global Constraints

- Worktree: `/home/dan/code/freshell/.worktrees/opencode-error-projection`, branch `the-usual/opencode-error-projection`, base `f9aac274642b2aec7566d1a50927b9ac826c5d86`. Do not touch `fix/opencode-compact-timeout-error-dismiss` or its 4 commits; do not edit `src/components/fresh-agent/FreshAgentApprovalBanner.tsx`, `src/store/freshAgentSlice.ts`, `src/lib/fresh-agent-ws.ts`, or the `FreshAgentView.tsx` banner/dismiss surface — this plan does not implement banner dedupe or dismissal, so the live `freshAgent.error` banner may coexist with the durable module.
- Provider scope is opencode only. Do not change claude/codex builders, the serve bridge transport, `DEFAULT_TURN_UNTIMEOUT`/`DEFAULT_TURN_TIMEOUT`, timeout correlation, or add `freshAgent.error` to `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS` (the existing `freshAgent.session.changed`/idle refetch already delivers a late persisted error).
- The client contract is strict zod: a new wire key must be declared in the same change or `FreshAgentSnapshotSchema.safeParse` fails and the whole transcript is replaced by the load-error banner (`src/lib/api.ts:445-448`). The new key is optional; the server must always stamp a non-empty `message`.
- TypeScript uses NodeNext/ESM; relative imports need `.js` suffixes. `@/` → `src/`, `@shared/` → `shared/`. No `dist/` artifacts are committed.
- Test backends: `~/.bashrc` exports `FRESHELL_VITEST_BACKEND=cloud` and `FRESHELL_E2E_BACKEND=cloud`; non-interactive shells must export them explicitly. Focused Vitest runs go through `npm run test:vitest -- ...` (always local); cloud Vitest runs use `npm run test:cloud`. Cloud e2e runs execute the committed HEAD only — commit before kicking a cloud run. Broad `npm test`/`test:unit`/cargo workspace runs wait for the coordinator gate; narrowed `cargo test -p ...` selectors are not gated.
- Local Playwright needs chromium once (`npm exec -- playwright install chromium`); the first local spec run builds the client and the release Rust server via global-setup. Rust toolchain is 1.96; Node >= 22.5.0.
- A11y: the durable module is static text with `role="alert"` (matching the existing live banner convention); no new interactive controls.
- Do not update `docs/index.html`: a durable in-transcript error module on an existing transcript is a modest addition, not a major UI change.
- Conventional focused commits per task; do not create a PR (explicit user constraint) and do not restart the self-hosted server on port 3001 (no "APPROVED").
- The explorer reports live under `.worktrees/.the-usual-logs/opencode-error-projection/reports/`; the client-surface report recommended a new `kind: 'error'` transcript item, but this plan follows the run's design direction of an optional turn-level `error` field (smaller surface: no item-union, layout, signature, or classifier changes; zero-item turns already render their own article). The turn-field shape also avoids `appendTurnItems`/coalescing special cases because those spread `...previous`.

---

### Task 1: Project persisted `info.error` into the opencode snapshot turn (Rust)

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (helper near `opencode_model_from_info` ~:905; insertion in `opencode_message_turn_json` ~:1486; tests after `opencode_message_turn_json_renders_both_tool_and_text_parts_in_one_message` ~:4004)
- Test: `crates/freshell-freshagent/src/lib.rs` (inline `#[cfg(test)]` module)
- Test: `crates/freshell-freshagent/src/snapshot.rs` (extend `opencode_snapshot_success_returns_200_with_camelcase_body`, ~:938-985)

**Interfaces:**
- Consumes: one `{info, parts}` message from `OpencodeServeManager::list_messages` (`GET /session/:id/message`); `info.error` may be the persisted OpenCode union object `{name: string, data?: {message?: string}, message?: string}`.
- Produces: an optional snapshot turn key `error: {"name": string, "message": string}` — present exactly when `info.error` is an object, absent otherwise; helper `fn opencode_turn_error_from_info(info: &Value) -> Option<Value>`; the persisted raw `data.message` string is emitted verbatim (no JSON unwrapping; matches the CLI `errorMessage` display). Name-aware fallback for `MessageOutputLengthError` is the exact copy `The model reached the output length limit.`

- [ ] **Step 1: Write the failing projection tests (unit + REST route)**

Append to the inline test module in `crates/freshell-freshagent/src/lib.rs` (after `opencode_message_turn_json_renders_both_tool_and_text_parts_in_one_message`):

```rust
    #[test]
    fn opencode_message_turn_json_projects_the_persisted_unknown_error_verbatim() {
        // The exact persisted shape of the real provider request-deadline failure:
        // `fromError` JSON.stringify's the plain `{message,type}` stream error into
        // `UnknownError.data.message` (request_deadline_exceeded is embedded text,
        // never a structured field).
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
    fn opencode_message_turn_json_projects_output_length_error_with_name_aware_copy() {
        // MessageOutputLengthError persists `data: {}` — there is no message text.
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
            json!("The model reached the output length limit.")
        );
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

Expected: FAIL — `opencode_message_turn_json_projects_the_persisted_unknown_error_verbatim`, `..._projects_message_aborted_error`, and `..._projects_output_length_error_with_name_aware_copy` fail because `turn["error"]` is `Null` (the projection never reads `info.error`). The `..._omits_error_for_a_normal_assistant_turn` and `..._ignores_a_malformed_error_payload` tests pass already; they are regression guards for the absence behavior.

Run: `cargo test -p freshell-freshagent --locked opencode_snapshot_success`

Expected: FAIL because `value["turns"][1]["error"]["name"]` is `Null`.

- [ ] **Step 3: Add the minimal production implementation**

Add the helper immediately after `opencode_model_from_info` in `crates/freshell-freshagent/src/lib.rs`:

```rust
/// The CLI/TUI `errorMessage` precedence over a persisted `info.error`: named-error
/// records carry their text under `data.message`, so it comes first; a top-level
/// `message` is the next fallback; name-aware copy covers classes that persist no
/// message at all (`MessageOutputLengthError` persists `data: {}`). The extracted
/// string is surfaced verbatim — the CLI shows OpenCode's double-encoded
/// `UnknownError` payload exactly as persisted.
fn opencode_turn_error_from_info(info: &Value) -> Option<Value> {
    let error = info.get("error")?.as_object()?;
    let name = error
        .get("name")
        .and_then(Value::as_str)
        .filter(|name| !name.is_empty())
        .unwrap_or("UnknownError");
    let message = error
        .pointer("/data/message")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .or_else(|| {
            error
                .get("message")
                .and_then(Value::as_str)
                .filter(|message| !message.trim().is_empty())
        })
        .map(str::to_string)
        .or_else(|| match name {
            "MessageOutputLengthError" => {
                Some("The model reached the output length limit.".to_string())
            }
            _ => None,
        })
        .unwrap_or_else(|| format!("OpenCode error: {name}"));
    Some(json!({ "name": name, "message": message }))
}
```

In `opencode_message_turn_json`, immediately after the `model` insert (currently `lib.rs:1484-1486`):

```rust
    if let Some(error) = opencode_turn_error_from_info(&info) {
        turn.insert("error".to_string(), error);
    }
```

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --locked opencode_message_turn_json`

Expected: PASS (all 5 new tests plus the existing `opencode_message_turn_json_*` tests).

Run: `cargo test -p freshell-freshagent --locked opencode_snapshot_success`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Re-read the helper: one read of `info.error`, one precedence chain, no panics on any shape. Keep it module-private; do not move shared behavior into `freshell-opencode::events` (its `opencode_error_message` is a different precedence and stays untouched). Run `cargo fmt --all` and re-run the two focused commands. No further refactor needed if the diff is the helper plus one insertion.

- [ ] **Step 6: Run impacted-test verification**

The projection feeds `turns[]`, `rolledBackTurns`, the durable rollback ledger, and the REST snapshot route; the whole `freshell-freshagent` crate suite covers those callers.

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS (all crate tests, including `opencode_item_from_part_*`, `opencode_snapshot_*`, the rollback buckets, and the opencode WS bridge suite).

Run: `cargo fmt --all --check && cargo clippy -p freshell-freshagent --all-targets -- -D warnings`

Expected: PASS (no formatting or lint findings).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/snapshot.rs
git commit -m "feat(fresh-agent): project persisted opencode errors into snapshot turns"
```

---

### Task 2: Add the additive turn-level `error` to the shared client contract

**Files:**
- Modify: `shared/fresh-agent-contract.ts` (`FreshAgentTurnSchema`, ~:190-207)
- Test: `test/unit/shared/fresh-agent-contract.test.ts`

**Interfaces:**
- Consumes: Task 1's wire key `error: { name: string, message: string }` on snapshot turns.
- Produces: `FreshAgentTurnSchema` accepting optional `error: { name: string; message: string }` (strict inner object); inferred type `FreshAgentTurn['error']` used by Task 3. `FRESH_AGENT_CONTRACT_SCHEMA_NAMES` and the traceability fixture stay untouched because the member is inline.

- [ ] **Step 1: Write the failing contract tests**

Append to `test/unit/shared/fresh-agent-contract.test.ts`:

```ts
describe('durable turn error projection (opencode)', () => {
  const deadlineRaw = '{"message":"request deadline exceeded after 1195s before the response completed","type":"request_deadline_exceeded"}'

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

  it('keeps the error key optional (claude/codex/legacy servers omit it)', () => {
    const parsed = FreshAgentTurnSchema.safeParse({ id: 't1', turnId: 't1', summary: 's', items: [] })
    expect(parsed.success).toBe(true)
    expect(parsed.data && 'error' in parsed.data).toBe(false)
  })

  it('rejects an error without a message', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'UnknownError' },
    }).success).toBe(false)
  })

  it('rejects a blank error message', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [], error: { name: 'UnknownError', message: '' },
    }).success).toBe(false)
  })

  it('rejects unknown keys inside the error (strict)', () => {
    expect(FreshAgentTurnSchema.safeParse({
      id: 't1', turnId: 't1', summary: '', items: [],
      error: { name: 'UnknownError', message: 'boom', code: 'request_deadline_exceeded' },
    }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: FAIL — `parses a turn carrying the projected opencode error` and `parses snapshots whose errored turn is the only carrier of the failure` fail because the strict turn schema rejects the undeclared `error` key. The three rejection tests pass already (the whole object is currently rejected as unknown-key); they become inner-rule guards after Step 3.

- [ ] **Step 3: Add the minimal production implementation**

In `shared/fresh-agent-contract.ts`, inside `FreshAgentTurnSchema` after the `model` field:

```ts
  // OpenCode persists provider/abort errors on the assistant message
  // (`info.error`, `{name, data}`); the snapshot projects them onto the owning
  // turn. Optional and opencode-only: claude, codex, and older servers omit it.
  error: z.object({
    // OpenCode error class, e.g. 'UnknownError' / 'MessageAbortedError'.
    name: z.string().min(1),
    // Human-readable text the pane shows; the server always stamps non-empty
    // prose (data.message first, matching the CLI).
    message: z.string().min(1),
  }).strict().optional(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Keep the error member inline (a named exported schema would require a traceability-fixture row in `test/fixtures/fresh-agent/contract-traceability.ts` for no behavioral gain). Confirm the field ordering in `FreshAgentTurnSchema` does not affect the inferred type. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The turn schema is shared by every snapshot consumer; the impacted set is the contract suites, the turns helper suite, the client snapshot fetch test, and the claude golden-fixture contract test (claude turns must still parse without the key).

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-turns.test.ts test/unit/client/lib/api.test.ts test/unit/contracts/rust-claude-snapshot-contract.test.ts`

Expected: PASS.

Run: `npm run typecheck:client`

Expected: PASS (the new optional field type-checks in `shared/` and `src/`).

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-contract.ts test/unit/shared/fresh-agent-contract.test.ts
git commit -m "feat(fresh-agent): accept optional turn-level error in the shared contract"
```

---

### Task 3: Render the durable error module and muted interrupted marker

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (`FreshAgentTurnArticle` copy block, ~:848-872)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: `FreshAgentTurn['error']` from Task 2; the existing `FreshAgentTurnArticle` render path (including the zero-item branch that renders its own article).
- Produces: DOM `[data-testid="fresh-agent-turn-error"]` with `role="alert"` and class `fresh-agent-error-module` for every non-abort error; DOM `[data-testid="fresh-agent-turn-interrupted"]` (muted italic text `interrupted`) for `MessageAbortedError`; no chrome at all when `turn.error` is absent.

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

      expect(screen.getByTestId('fresh-agent-turn-interrupted')).toHaveTextContent('interrupted')
      expect(screen.queryByTestId('fresh-agent-turn-error')).not.toBeInTheDocument()
      expect(screen.queryByRole('alert')).not.toBeInTheDocument()
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

Expected: FAIL — `getByTestId('fresh-agent-turn-error')` / `getByTestId('fresh-agent-turn-interrupted')` find nothing because the transcript ignores `turn.error` today. The regression test passes already.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`, inside `FreshAgentTurnArticle`, just before the closing `</div>` of `fresh-agent-transcript-copy` (after the streaming-strip block at ~:869-871):

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

Expected: PASS (the new block plus the whole existing transcript suite).

- [ ] **Step 5: Refactor while green**

The two JSX branches are intentionally small and presentational; the transcript's layout/classifiers are untouched. Confirm the module does not participate in `buildTranscriptLayout` (the field is turn-level, not an item) and that a zero-item errored turn is not treated as `absorbed` (`absorbed` requires `turn.items.length > 0`). Run `npm run lint` (jsx-a11y) and the focused test again. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The change is confined to the transcript article; the impacted set is the transcript suite plus the item-card suite (same article tree).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`

Expected: PASS.

Run: `npm run lint && npm run typecheck:client`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat(ui): render durable opencode errors and muted interrupts in fresh-agent turns"
```

---

### Task 4: Suppress the transient abort banner without losing the no-chime latch

**Files:**
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs` (bridge loop ~:3273-3279; helper near `error_event` ~:3320; test near `errored_turn_emits_no_turn_complete_but_forwards_the_error` ~:7991)
- Test: `crates/freshell-freshagent/src/opencode_ws.rs` (inline tests)

**Interfaces:**
- Consumes: `freshell_opencode::ParsedServeEvent { kind, properties }` delivered by `OpencodeServeManager::subscribe` (`session.error` properties carry `{sessionID, error: {name, data}}`).
- Produces: `fn is_opencode_abort_error(parsed: &ParsedServeEvent) -> bool`; bridge behavior — an abort `session.error` latches `turn_errored` and broadcasts no frame at all (no `freshAgent.error` banner), while the existing `message.updated` refetch and Task 1's durable projection surface the persisted `MessageAbortedError` as the muted "interrupted" marker.

Why here and not in `freshell_opencode::serve_event_to_sdk`: suppressing at the shared mapper would also stop the bridge from latching `turn_errored`, and the chime gate is `succeeded && !turn_aborted && !turn_errored` (`settle_turn_outcome`, `opencode_ws.rs:3398-3418`). A user interrupt sets `turn_aborted` in `handle_interrupt` (`:1631-1633`), but a provider-side abort without a local interrupt would then be able to chime; latching `turn_errored` in the bridge keeps "abort never chimes" true while removing the banner. The mapper stays a faithful port.

- [ ] **Step 1: Write the failing bridge test**

Add after `errored_turn_emits_no_turn_complete_but_forwards_the_error` in the `opencode_ws.rs` test module:

```rust
    #[tokio::test]
    async fn aborted_turn_emits_no_error_banner_and_no_turn_complete() {
        let (tx, mut rx) = tokio::sync::broadcast::channel::<String>(64);
        let fresh_agent = FreshAgentState::new(Arc::new("tok".to_string()), Arc::new(tx));
        let deps = ServeDeps {
            spawner: Arc::new(TrackedSpawner {
                killed: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            }),
            http: Arc::new(StatusPollFakeHttp::new(2)),
            ports: Arc::new(FakeAllocator),
            events: Arc::new(NoopEventSource),
        };
        let config = ServeConfig {
            idle_poll_interval: Duration::from_millis(15),
            ..ServeConfig::default()
        };
        let manager = OpencodeServeManager::new(deps, config);
        manager
            .ensure_started()
            .await
            .expect("healthy fake serve starts");
        fresh_agent.set_manager_for_test(manager.clone()).await;
        let st = FreshOpencodeState::new(fresh_agent);

        st.handle_create(create_msg("req-abort"), None).await;
        let placeholder = "freshopencode-req-abort";
        st.handle_send(send_msg(placeholder, "hello")).await;

        // The abort signal a mid-stream user interrupt produces: a session.error
        // whose error is OpenCode's MessageAbortedError (the CLI/TUI never raises
        // this as a loud error; it renders a muted "interrupted" instead).
        tokio::time::sleep(Duration::from_millis(5)).await;
        manager.dispatch_event(freshell_opencode::ParsedServeEvent {
            kind: "session.error".to_string(),
            session_id: Some("ses_1".to_string()),
            properties: {
                let mut m = serde_json::Map::new();
                m.insert(
                    "error".to_string(),
                    json!({ "name": "MessageAbortedError", "data": { "message": "Aborted" } }),
                );
                m
            },
            raw: serde_json::Map::new(),
        });

        let mut saw_error = false;
        let mut saw_complete = false;
        let deadline = tokio::time::Instant::now() + Duration::from_millis(400);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                break;
            }
            let Ok(Ok(raw)) = tokio::time::timeout(remaining, rx.recv()).await else {
                break;
            };
            let frame: serde_json::Value = serde_json::from_str(&raw).unwrap();
            if frame["type"] != "freshAgent.event" {
                continue;
            }
            match frame["event"]["type"].as_str() {
                Some("freshAgent.error") => saw_error = true,
                Some("freshAgent.turn.complete") => saw_complete = true,
                _ => {}
            }
        }

        assert!(!saw_error, "an abort must never raise the live error banner");
        assert!(!saw_complete, "an abort must never emit turn.complete");
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent --locked aborted_turn`

Expected: FAIL — the abort payload maps through `serve_event_to_sdk` to `SdkProviderEvent::Error { message: "Aborted" }`, so the bridge broadcasts `freshAgent.error` and `saw_error` becomes true. (`saw_complete` is already false because the same event also latches `turn_errored`.)

- [ ] **Step 3: Add the minimal production implementation**

Add the helper near `error_event` in `crates/freshell-freshagent/src/opencode_ws.rs`:

```rust
/// True when a parsed serve event is OpenCode's `MessageAbortedError` session
/// error — the one error class the CLI/TUI presents silently (muted
/// "interrupted", no toast, skipped in `run` scrollback).
fn is_opencode_abort_error(parsed: &freshell_opencode::ParsedServeEvent) -> bool {
    parsed.kind == "session.error"
        && parsed
            .properties
            .get("error")
            .and_then(|error| error.get("name"))
            .and_then(Value::as_str)
            == Some("MessageAbortedError")
}
```

In `spawn_serve_bridge`, at the top of the `Ok(SessionSignal::Event(parsed))` arm (before the `serve_event_to_sdk` call at ~:3276):

```rust
                        if is_opencode_abort_error(&parsed) {
                            // Muted like the CLI: no banner frame, but keep the
                            // errored latch so an aborted turn can never chime.
                            turn_errored.store(true, Ordering::SeqCst);
                            continue;
                        }
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent --locked aborted_turn`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Confirm the helper is used exactly once and that `serve_event_to_sdk` and `freshell-opencode` are untouched (their tests still pass unchanged). Run `cargo fmt --all` and re-run the focused test. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The bridge is covered by the `opencode_ws.rs` suite, and the mapper suite in `freshell-opencode` must stay green (it is unchanged).

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS (including `errored_turn_emits_no_turn_complete_but_forwards_the_error`, which uses a nameless error and must still behave identically).

Run: `cargo test -p freshell-opencode --features real-transport --locked`

Expected: PASS.

Run: `cargo fmt --all --check && cargo clippy -p freshell-freshagent --all-targets -- -D warnings`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/opencode_ws.rs
git commit -m "fix(fresh-agent): mute the transient opencode abort banner without losing the no-chime latch"
```

---

### Task 5: End-to-end durability of a persisted provider error through the fake opencode serve

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (`insertTextMessage` ~:165-187; `appendPromptMessages` ~:645-682)
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (`bootOpencodeLane` ~:2088-2126; new test in the `fresh-agent control surfaces — opencode lane (rust)` describe ~:2160)
- Test: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` (cloud-legal; not in `CLOUD_SKIP_SPECS`)

**Interfaces:**
- Consumes: Tasks 1-4; the fixture's existing `GET /session/:id/message` route (`fake-opencode.cjs:910-933`) and `messagesForSession` (`:549-589`), which spreads the persisted message `data` into `info` so a stored `data.error` arrives at Rust as `info.error`.
- Produces: fixture env switch `FAKE_OPENCODE_PROMPT_ERROR=<inner provider message>` — when set, the assistant message is persisted with `error: { name: 'UnknownError', data: { message: JSON.stringify({ message: <value>, type: 'request_deadline_exceeded' }) } }`, the exact double-encoded shape read from the real OpenCode DB; `bootOpencodeLane(page, extraEnv?)`; e2e test `durable provider error projects into the transcript and survives reload`.

- [ ] **Step 1: Write the failing e2e test**

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

Append this test inside the `fresh-agent control surfaces — opencode lane (rust)` describe:

```ts
  test('durable provider error projects into the transcript and survives reload', async ({ page }) => {
    const providerMessage = 'request deadline exceeded after 1195s before the response completed'
    const lane = await bootOpencodeLane(page, { FAKE_OPENCODE_PROMPT_ERROR: providerMessage })
    try {
      await sendOpencodeTurn(page, lane.harness, lane.tabId, 'opencode error turn', 1, lane.auditLogPath)

      // The snapshot was refetched after idle: the persisted info.error must be
      // visible as the durable module (the live banner may coexist).
      const errorModule = page
        .locator('[data-context="fresh-agent"]')
        .last()
        .getByTestId('fresh-agent-turn-error')
      await expect(errorModule).toBeVisible({ timeout: 30_000 })
      await expect(errorModule).toContainText(providerMessage)
      await expect(errorModule).toContainText('request_deadline_exceeded')

      // Durability: the same module re-derives from the REST snapshot after reload.
      await page.reload()
      await lane.harness.waitForHarness()
      await lane.harness.waitForConnection()
      await expect(
        page.locator('[data-context="fresh-agent-transcript"]').getByTestId('fresh-agent-turn-error'),
      ).toContainText(providerMessage, { timeout: 30_000 })
    } finally {
      await lane.server.stop().catch(() => {})
      await fs.rm(lane.sharedRoot, { recursive: true, force: true }).catch(() => {})
    }
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=chromium --grep="durable provider error" test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: FAIL because the fixture ignores `FAKE_OPENCODE_PROMPT_ERROR` and persists an ordinary text-only assistant message; no `info.error` reaches the snapshot, so `fresh-agent-turn-error` never appears. (First local run builds the client and the release Rust server via Playwright global-setup; prerequisites per Global Constraints.)

- [ ] **Step 3: Add the minimal fixture implementation**

In `test/e2e-browser/fixtures/fake-opencode.cjs`, let `insertTextMessage` carry extra persisted message fields:

```js
function insertTextMessage(db, input) {
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
```

In `appendPromptMessages`, build the error payload and pass it on the assistant insert:

```js
    const responseText = process.env.FAKE_OPENCODE_RESPONSE_TEXT || `Fake OpenCode response: ${promptText}`
    // Durable-error fixture: OpenCode persists a stream failure as UnknownError
    // whose data.message is a JSON string carrying the provider {message,type}
    // payload (the exact request_deadline_exceeded shape read from a real DB).
    const promptError = process.env.FAKE_OPENCODE_PROMPT_ERROR
    const assistantExtra = promptError
      ? {
          error: {
            name: 'UnknownError',
            data: {
              message: JSON.stringify({ message: promptError, type: 'request_deadline_exceeded' }),
            },
          },
        }
      : {}
```

```js
    insertTextMessage(db, {
      sessionId: input.sessionId,
      messageId: assistantMessageId,
      partId: `${assistantMessageId}_part_text`,
      role: 'assistant',
      text: responseText,
      now: assistantTime,
      extra: assistantExtra,
    })
```

- [ ] **Step 4: Run the focused test**

Run: `FRESHELL_E2E_BACKEND=local npm run test:e2e:local -- --project=chromium --grep="durable provider error" test/e2e-browser/specs/fresh-agent-control-rust.spec.ts`

Expected: PASS — the module shows the provider message before reload and again after reload.

- [ ] **Step 5: Refactor while green**

Keep the fixture change env-gated and off by default so every existing spec is byte-identical in behavior. Confirm no spec was added to `CLOUD_SKIP_SPECS` and no other fixture consumer changed. No further refactor needed.

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

Expected: PASS; record the run id in the progress ledger.

---

## Acceptance Mapping

| Requirement | Observable production outcome | Verification |
| --- | --- | --- |
| Every persisted OpenCode error appears in a freshopencode pane | Snapshot turn carries `error {name,message}` from `info.error` | Task 1 unit + route tests; Task 5 e2e |
| The request-deadline failure (`request_deadline_exceeded`) displays as the CLI shows it | Raw persisted `data.message` string rendered verbatim in the module | Task 1 deadline unit test; Task 3 render test; Task 5 e2e text assertion |
| Durability, not only a transient banner | Same module re-derives from `GET /api/fresh-agent/threads/freshopencode/opencode/:threadId` after reload/resume | Task 5 e2e reload assertion; REST route test Task 1 |
| Aborts are muted, never alarming, no chime implication | `MessageAbortedError` renders `interrupted`; live abort banner suppressed while `turn_errored` latches | Task 3 abort render test; Task 4 bridge test; existing `errored_turn_*` test stays green |
| No transcript item-union / classifier churn | Turn-level optional field only | Task 2 schema diff; Task 3 render diff |
| Dismiss work undisturbed | No edits to `FreshAgentApprovalBanner.tsx`, `freshAgentSlice.ts`, `fresh-agent-ws.ts`, `FreshAgentView.tsx` | Commit file lists per task |

## Self-Review

1. **Spec coverage.** Every active obligation maps to a task and an observable outcome (table above). The three explicit constraints are enforced by Global Constraints (the-usual process is the run itself; base `f9aac2746`; no PR; dismiss branch untouched) and verified by the per-task file lists.
2. **No silent deferrals.** No stubs or test-only seams: the production path is `lib.rs` projection → REST snapshot → zod contract → transcript module, with the Task 5 e2e driving the real Rust server and fake serve through `GET /session/:id/message`. The one deliberate non-implementation is live-banner dedupe, which the run direction explicitly declines; coexistence is stated in Global Constraints and covered by the acceptance mapping. The client-surface explorer's item-kind recommendation is deliberately not adopted (smaller turn-field surface; recorded in Global Constraints).
3. **File and interface consistency.** Task 1 emits `{name, message}`; Task 2 accepts exactly that shape; Task 3 consumes `FreshAgentTurn['error']`; Task 4's helper consumes `ParsedServeEvent` fields that exist (`kind`, `properties`); Task 5 uses `fresh-agent-turn-error`, the exact testid Task 3 emits. Commands are repo-owned forms (`npm run test:vitest -- run ...`, `cargo test -p ... --locked`, `npm run test:e2e:local/cloud`). `fresh-agent-turn-interrupted` is produced and queried consistently.
4. **Executable tests.** Each task's positive tests fail before its production step for the intended missing behavior (verified against the current source: strict zod rejects the undeclared key; the transcript ignores `turn.error`; `serve_event_to_sdk` maps aborts to `Error`; the fixture ignores the env). Absence/malformed/regression tests are labeled as guards that pass in both states, so no reviewer mistake about vacuous reds. Every test asserts behavior, not static copy: the deadline assertion pins the exact real persisted payload string.
5. **Placeholder scan.** No `TBD`/`TODO`/“implement later”/“handle edge cases”; every path, function, env var, fixture switch, testid, and command is defined in this plan. All Rust/TS snippets are complete and use real anchors from the current tree.
6. **Operational completeness.** No migration or config change; no server restart. Structured logs already cover the live bridge (`freshAgent.error` frames) and are unchanged. Rollback is a branch revert. `docs/index.html` is intentionally untouched (not a major UI change). Broad-suite and cloud e2e evidence is owned by the-usual Stage 5 plus the Task 5 post-commit cloud run; broad runs go through the test coordinator.

**UNRESOLVED COVERAGE GAP:** none.
