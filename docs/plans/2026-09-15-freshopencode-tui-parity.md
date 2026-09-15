# freshopencode TUI-Parity (Inline Delegations, Thought Durations, Retries) Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- freshopencode panes show all inline information the opencode TUI shows for a session (excluding content only visible in the TUI's right-hand-side expanded panel):
  - Reasoning: settled thought rows carry the duration (e.g. `Thought · 3.4s`), with optional topic title (`Thought: <title> · <duration>`); live rows keep the existing "Thinking" behavior.
  - Task delegation: the opencode `task` tool part renders as a first-class activity-strip member with a `General Task — <description>` header (title-cased subagent type, ` (background)` marker when applicable), status icon (spinner/✓/✗), duration, nested compact non-expandable child-session tool rows (`↳ Bash sed -n …`, with ` (failed)` suffix on errors), the clamped `<task_result>` output, and an "Open session" link to the child session.
  - Retry: opencode retry parts render as strip rows (`Retrying (attempt 2)` with the error's short text in the expanded row).
  - Child session context: the child session's first user turn renders its `subtask` part as a one-line muted caption (`Delegated — General · <description>`).
- Child-session activity reaches the parent transcript via a server-side join: the adapter registers child session ids found in task tool parts (`state.metadata.sessionId`), child `message.*` events refresh the parent snapshot, and the server embeds compact child activity rows (`{tool, status, preview}`). opencode persists no `toolCalls` metadata — the TUI performs this join live, and the server-side join mirrors that with server-authoritative data.
- Contract changes are additive (`shared/fresh-agent-contract.ts` + zod); the Node and Rust normalizers stay in sync.

### Explicit constraints
- Match Freshell's existing activity-strip / tool-block / thinking-row UX grammar.
- The active information is showing: the live strip line names the running thing via its existing SlotReel preview, including `General Task — <desc>` for delegations and `Retrying (attempt N)` for retries.
- Everything between assistant responses folds together into a single line; no new element renders as a standalone article between assistant messages; the delegation block is one strip row with its nesting inside; thought and retry rows are activity-like strip members.
- Nested child tool rows stay compact and non-expandable; full detail remains in the child session (already listed in the sidebar) plus the "Open session" link.
- Red-Green-Refactor TDD with unit and e2e coverage for the new behavior.

### Accepted tradeoffs and residuals
- Out of scope / already matching: text markdown, file chips, patch diffs, compaction card, step-start/step-finish structural parts, agent part (the turn header already shows the agent label).
- Reasoning keeps the existing expandable thinking-row pattern; only the settled label gains the duration/title.

**Goal:** freshopencode panes render everything the opencode TUI shows inline — thought durations, subagent task delegations with nested child activity, retries, and child-session delegation context — inside the existing one-line folding activity strip.

**Architecture:** Add three additive `FreshAgentTranscriptItem` union variants (`task_delegation`, `retry`, `delegated_task`) and two optional `reasoning` fields (`durationMs`, `title`) to the shared zod contract. The Rust freshagent crate's opencode normalizer (the only production normalizer — the Node server was retired before this run's base) emits them from opencode wire parts, and `get_opencode_snapshot` post-processes each built snapshot with a server-side child-session join (fetch child messages via the shared `opencode serve` sidecar, embed compact `{tool, status, preview}` rows, and re-broadcast `sdk.session.changed` for the parent when the child session emits `message.*` events). The client folds all new kinds into the existing activity strip: a dedicated delegation block (header + nested `↳` rows + clamped result + "Open session" link), a muted retry row, a delegated-task caption in child sessions, and settled `Thought · 3.4s` labels on thinking rows.

**Tech Stack:** TypeScript + zod (shared contract), Rust + serde_json (freshell-freshagent / freshell-opencode crates), React 18 + Redux Toolkit (client), Vitest + cargo test + Playwright (tests).

## Global Constraints

- **Rust-only backend.** The Node server is fully retired at base_ref (commit a7d36d5f8); `server/fresh-agent/**` does not exist. The User Request's "Node and Rust normalizers stay in sync" is satisfied vacuously; the live surfaces are `shared/fresh-agent-contract.ts` (zod), the Rust normalizer in `crates/freshell-freshagent/src/lib.rs`, and the client. Never re-create Node-side adapters.
- **Strict schemas.** Every zod variant is `.strict()`: every field the Rust producer emits must exist in the schema, and vice versa. Contract changes must be additive (new union members + optional fields) so old payloads keep parsing. The client zod-parses snapshots and THROWS `FreshAgentApiContractError` on unknown item kinds (src/lib/api.ts:445–449) — additive contract growth therefore relies on the repo's established buildId self-heal (the `ready` frame's buildId mismatch reloads a stale client once per tab session; see AGENTS.md "WebSocket Protocol"). Client and server must ship atomically in one PR, exactly as every prior item-kind addition did. Never widen the contract without shipping the client rendering in the same change.
- **NodeNext/ESM.** Relative TypeScript imports need explicit `.js` extensions. Path aliases: `@/` → src/, `@shared` → shared/, `@test` → test/.
- **A11y.** New interactive elements (the "Open session" button) need real button semantics + `aria-label`; icon-only indicators need `aria-label`s. `npm run lint` (jsx-a11y) is a CI requirement.
- **Test commands.** Focused vitest: `npm run test:vitest -- run <paths> --config config/vitest/vitest.config.ts` (repo-owned passthrough). Focused Rust: `cargo test -p freshell-freshagent --lib <filter> --locked` (narrowed selectors are delegated/uncoordinated). E2E local: `npm run test:e2e:chromium -- test/e2e-browser/specs/<spec>.ts`. Broad suites only via the coordinator (`npm test`) — never raw broad runs. Do NOT add the new spec to `CLOUD_SKIP_SPECS` (test/e2e-browser/playwright.cloud.config.ts); affected e2e specs must pass on the configured backend (local this run).
- **Process safety.** Never restart the production server on port 3001; never use broad kill patterns. This plan's verification is build/test only — no deploys.
- **Commits.** Conventional commit messages, focused commits per task. The repo's git identity is already configured — never override author/committer email.
- **Reference evidence.** Exploration findings with verified file:line anchors live in `.worktrees/.the-usual-logs/freshopencode-tui-parity/reports/plan-exploration.md` (workspace baseline in the same `reports/` directory). Wire shapes in that report come from the live opencode 1.18.30 database and binary and are authoritative for fixture payloads.

---

### Task 1: Shared contract — task_delegation, retry, delegated_task items + reasoning duration/title

**Files:**
- Modify: `shared/fresh-agent-contract.ts` (FreshAgentTranscriptItemSchema union, lines 69–180; reasoning variant 80–86; insert new variants after `dynamic_tool` at 128–137)
- Test: `test/unit/shared/fresh-agent-contract.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 2–6): three new `FreshAgentTranscriptItem` union variants —
  `task_delegation = { id; kind:'task_delegation'; status:'running'|'completed'|'failed'; title:string; description?:string; subagent?:string; background?:boolean; childSessionId?:string; startedAtMs?:number; endedAtMs?:number; durationMs?:number; activity?:{tool:string; status:'running'|'completed'|'failed'; preview:string}[]; result?:string }`;
  `retry = { id; kind:'retry'; attempt:number(int,>0); error?:string }`;
  `delegated_task = { id; kind:'delegated_task'; agent?:string; description?:string; command?:string }`;
  and `reasoning += durationMs?:number(≥0); title?:string`.

- [ ] **Step 1: Write the failing contract tests**

Append to `test/unit/shared/fresh-agent-contract.test.ts` (keep the file's existing import style — it already imports the item schema; add `FreshAgentTranscriptItemSchema` to the import list if absent):

```ts
describe('task_delegation transcript item', () => {
  const fullItem = {
    id: 'part_task_1',
    kind: 'task_delegation',
    status: 'running',
    title: 'General Task — Fix the flaky harness',
    description: 'Fix the flaky harness',
    subagent: 'general',
    background: false,
    childSessionId: 'ses_child_1',
    startedAtMs: 1789406370320,
    endedAtMs: 1789408126081,
    durationMs: 1755761,
    activity: [
      { tool: 'bash', status: 'completed', preview: 'sed -n 92,112p src/store/paneTypes.ts' },
      { tool: 'grep', status: 'failed', preview: 'reasoningEffort in src' },
    ],
    result: '<task id="ses_child_1" state="completed"><task_result>ok</task_result></task>',
  }

  it('parses a full task_delegation item', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse(fullItem).success).toBe(true)
  })

  it('parses a minimal task_delegation item (title + status only)', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_task_1', kind: 'task_delegation', status: 'completed', title: 'General Task — x',
    }).success).toBe(true)
  })

  it('rejects unknown keys on task_delegation (strict)', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ ...fullItem, bogus: 1 }).success).toBe(false)
  })

  it('rejects an invalid delegation status', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ ...fullItem, status: 'finished' }).success).toBe(false)
  })
})

describe('retry transcript item', () => {
  it('parses attempt with error', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_retry_1', kind: 'retry', attempt: 2, error: 'stream disconnected',
    }).success).toBe(true)
  })

  it('parses attempt without error', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ id: 'part_retry_1', kind: 'retry', attempt: 1 }).success).toBe(true)
  })

  it('rejects non-positive attempts', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ id: 'r', kind: 'retry', attempt: 0 }).success).toBe(false)
  })
})

describe('delegated_task transcript item', () => {
  it('parses agent, description and command', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_sub_1', kind: 'delegated_task', agent: 'general',
      description: 'Fix the flaky harness', command: '/fix',
    }).success).toBe(true)
  })

  it('parses a bare marker', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({ id: 'part_sub_1', kind: 'delegated_task' }).success).toBe(true)
  })
})

describe('reasoning duration and title fields', () => {
  it('parses reasoning with durationMs and title', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'part_reasoning_1', kind: 'reasoning',
      summary: ['weighing options'], content: ['weighing options'], text: 'weighing options',
      durationMs: 1831, title: 'planning the fix',
    }).success).toBe(true)
  })

  it('rejects negative durationMs', () => {
    expect(FreshAgentTranscriptItemSchema.safeParse({
      id: 'p', kind: 'reasoning', summary: [], content: [], durationMs: -1,
    }).success).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL — the new `kind` literals are not in the discriminated union yet (`safeParse` returns false for `task_delegation`/`retry`/`delegated_task` kinds and for `durationMs`/`title` on reasoning), while all pre-existing assertions in the file still pass.

- [ ] **Step 3: Add the contract implementation**

In `shared/fresh-agent-contract.ts`:

3a. Extend the `reasoning` variant (line 80–86) with the two optional fields:

```ts
  z.object({
    id: z.string().min(1),
    kind: z.literal('reasoning'),
    summary: z.array(z.string()),
    content: z.array(z.string()),
    text: z.string().optional(),
    durationMs: z.number().nonnegative().optional(),
    title: z.string().optional(),
  }).strict(),
```

3b. Insert after the `dynamic_tool` variant (after line 137), inside the same `z.discriminatedUnion('kind', [...])` array:

```ts
  z.object({
    id: z.string().min(1),
    kind: z.literal('task_delegation'),
    status: z.enum(['running', 'completed', 'failed']),
    title: z.string(),
    description: z.string().optional(),
    subagent: z.string().optional(),
    background: z.boolean().optional(),
    childSessionId: z.string().optional(),
    startedAtMs: z.number().optional(),
    endedAtMs: z.number().optional(),
    durationMs: z.number().nonnegative().optional(),
    activity: z.array(z.object({
      tool: z.string(),
      status: z.enum(['running', 'completed', 'failed']),
      preview: z.string(),
    }).strict()).optional(),
    result: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('retry'),
    attempt: z.number().int().positive(),
    error: z.string().optional(),
  }).strict(),
  z.object({
    id: z.string().min(1),
    kind: z.literal('delegated_task'),
    agent: z.string().optional(),
    description: z.string().optional(),
    command: z.string().optional(),
  }).strict(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None needed — the change is a pure additive schema extension with no duplication.

- [ ] **Step 6: Run impacted-test verification**

The schema list (`FRESH_AGENT_CONTRACT_SCHEMA_NAMES`) is unchanged, but the union is consumed by snapshot parsing, traceability, and Rust↔zod contract suites. Run them together:

Run: `npm run test:vitest -- run test/unit/shared test/unit/contracts --config config/vitest/vitest.config.ts`

Expected: PASS (pre-existing suites accept the widened union because all additions are optional fields and new union members).

Also run the no-write typecheck so downstream TS consumers surface any exhaustiveness surprises early:

Run: `npm run typecheck:client`

Expected: PASS (typecheck may temporarily pass because consumers switch on `kind` without exhaustive checks; if it fails, fix the switch exhaustiveness in `src/components/fresh-agent/**` — that is Task 4/5 territory and fixing it now is allowed).

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-contract.ts test/unit/shared/fresh-agent-contract.test.ts
git commit -m "feat(contract): task_delegation, retry, delegated_task items + reasoning duration/title"
```

---

### Task 2: Rust normalizer — emit the new items from opencode wire parts

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (`opencode_item_from_part` at line 1272–1355; add helpers near it)
- Test: `crates/freshell-freshagent/src/lib.rs` (`mod tests` at line 3198 — same style as `opencode_item_from_part_tool_part_renders_dynamic_tool_kind_with_exact_schema_keys` at 3848)

**Interfaces:**
- Consumes: the contract from Task 1 (exact field names/keys; zod is strict).
- Produces: `opencode_item_from_part` now returns items of kinds `task_delegation` (for tool parts with `tool == "task"`), `retry` (for `type:"retry"` parts), `delegated_task` (for `type:"subtask"` parts), and `reasoning` items carrying optional `durationMs`/`title`. Also a `pub(crate) fn opencode_child_activity_preview(tool: &str, input: &Value) -> String` helper consumed by Task 3.

- [ ] **Step 1: Write the failing Rust unit tests**

Add to `mod tests` in `crates/freshell-freshagent/src/lib.rs` (follow the exact-JSON assertion style of the existing opencode item tests):

```rust
#[test]
fn opencode_item_from_part_reasoning_part_carries_duration_without_title() {
    let items = opencode_item_from_part(
        &json!({
            "type": "reasoning", "id": "part_r1", "text": "weighing options",
            "time": { "start": 1789417896153i64, "end": 1789417897984i64 },
            "metadata": { "anthropic": { "signature": "sig" } }
        }),
        "fallback",
        Some("assistant"),
        false,
    );
    assert_eq!(items, vec![json!({
        "id": "part_r1", "kind": "reasoning",
        "summary": ["weighing options"], "content": ["weighing options"],
        "text": "weighing options", "durationMs": 1831u64
    })]);
}

#[test]
fn opencode_item_from_part_reasoning_without_time_has_no_duration() {
    let items = opencode_item_from_part(
        &json!({ "type": "reasoning", "id": "part_r2", "text": "hmm" }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0].get("durationMs"), None);
    assert_eq!(items[0].get("title"), None);
}

#[test]
fn opencode_item_from_part_reasoning_leading_bold_block_becomes_title() {
    // Mirrors the opencode TUI's reasoningSummary (thinking.ts): a leading bold
    // block "**Title**" followed by a blank line is disclosure metadata.
    let items = opencode_item_from_part(
        &json!({
            "type": "reasoning", "id": "part_r3",
            "text": "**Planning the fix**\n\nweighing options",
            "time": { "start": 1000, "end": 4200 }
        }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0]["durationMs"], json!(3200u64));
    assert_eq!(items[0]["title"], json!("Planning the fix"));
    assert_eq!(items[0]["text"], json!("weighing options"));
    assert_eq!(items[0]["summary"], json!(["weighing options"]));
}

#[test]
fn opencode_item_from_part_reasoning_bold_title_awaiting_body_is_title_only() {
    // The TUI also treats a complete title still awaiting its body (streaming)
    // as disclosure metadata: "**Title**" with nothing after it.
    let items = opencode_item_from_part(
        &json!({ "type": "reasoning", "id": "part_r4", "text": "**Planning**" }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0]["title"], json!("Planning"));
    assert_eq!(items[0]["summary"], json!([]));
}

#[test]
fn opencode_item_from_part_reasoning_bold_without_blank_line_is_not_a_title() {
    // No blank line after the bold block => the TUI regex does not match; the
    // text stays whole and no title is emitted.
    let items = opencode_item_from_part(
        &json!({ "type": "reasoning", "id": "part_r5", "text": "**bold intro** still the same paragraph" }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0].get("title"), None);
    assert_eq!(items[0]["text"], json!("**bold intro** still the same paragraph"));
}

#[test]
fn opencode_item_from_part_task_tool_part_becomes_task_delegation() {
    let items = opencode_item_from_part(
        &json!({
            "type": "tool", "tool": "task", "id": "part_t1",
            "state": {
                "status": "completed",
                "input": { "description": "Fix the flaky harness", "prompt": "…", "subagent_type": "general" },
                "metadata": { "parentSessionId": "ses_p", "sessionId": "ses_c", "model": { "modelID": "m", "providerID": "p" } },
                "output": "<task id=\"ses_c\" state=\"completed\"><task_result>ok</task_result></task>",
                "title": "Fix the flaky harness",
                "time": { "start": 1000, "end": 3000 }
            }
        }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items, vec![json!({
        "id": "part_t1", "kind": "task_delegation", "status": "completed",
        "title": "General Task — Fix the flaky harness",
        "description": "Fix the flaky harness", "subagent": "general", "background": false,
        "childSessionId": "ses_c", "startedAtMs": 1000i64, "endedAtMs": 3000i64,
        "durationMs": 2000u64,
        // The <task …><task_result>…</task_result></task> envelope is unwrapped:
        // users see the task-result content, never the internal markup.
        "result": "ok"
    })]);
}

#[test]
fn opencode_task_result_text_unwraps_envelope_and_passes_raw_through() {
    assert_eq!(
        opencode_task_result_text("<task id=\"x\" state=\"completed\"><task_result>\n  all green  \n</task_result></task>"),
        "all green"
    );
    assert_eq!(opencode_task_result_text("plain output"), "plain output");
    assert_eq!(opencode_task_result_text(""), "");
}

#[test]
fn opencode_item_from_part_task_tool_part_minimal_has_title_and_no_child() {
    let items = opencode_item_from_part(
        &json!({ "type": "tool", "tool": "task", "id": "part_t2",
            "state": { "status": "running", "input": { "description": "Do things" } } }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0]["kind"], json!("task_delegation"));
    assert_eq!(items[0]["title"], json!("General Task — Do things"));
    assert_eq!(items[0].get("childSessionId"), None);
    assert_eq!(items[0].get("result"), None);
}

#[test]
fn opencode_item_from_part_task_tool_part_background_and_custom_subagent() {
    let items = opencode_item_from_part(
        &json!({ "type": "tool", "tool": "task", "id": "part_t3",
            "state": { "status": "error", "input": { "description": "side quest", "subagent_type": "fixer" },
                       "metadata": { "background": true, "sessionId": "ses_bg" } } }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0]["title"], json!("Fixer Task (background) — side quest"));
    assert_eq!(items[0]["status"], json!("failed"));
    assert_eq!(items[0]["background"], json!(true));
    assert_eq!(items[0]["childSessionId"], json!("ses_bg"));
}

#[test]
fn opencode_item_from_part_retry_part_becomes_retry_item() {
    // Authoritative serialized shape: NamedError.toObject() => {name, data:{message,…}}
    // (retry.ts reads error.data.message).
    let items = opencode_item_from_part(
        &json!({ "type": "retry", "id": "part_rr1", "attempt": 2,
                 "error": { "name": "APIError", "data": { "message": "stream disconnected" } } }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items, vec![json!({
        "id": "part_rr1", "kind": "retry", "attempt": 2i64, "error": "stream disconnected"
    })]);
}

#[test]
fn opencode_item_from_part_retry_part_defaults_attempt_and_string_error() {
    let items = opencode_item_from_part(
        &json!({ "type": "retry", "id": "part_rr2", "error": "boom" }),
        "fallback", Some("assistant"), false,
    );
    assert_eq!(items[0]["attempt"], json!(1i64));
    assert_eq!(items[0]["error"], json!("boom"));
}

#[test]
fn opencode_item_from_part_subtask_part_becomes_delegated_task() {
    let items = opencode_item_from_part(
        &json!({ "type": "subtask", "id": "part_s1", "agent": "general",
                 "description": "Fix the flaky harness", "command": "/fix" }),
        "fallback", Some("user"), false,
    );
    assert_eq!(items, vec![json!({
        "id": "part_s1", "kind": "delegated_task", "agent": "general",
        "description": "Fix the flaky harness", "command": "/fix"
    })]);
}

#[test]
fn opencode_child_activity_preview_formats_common_tools() {
    assert_eq!(opencode_child_activity_preview("bash", &json!({ "command": "sed -n 92,112p src/store/paneTypes.ts" })), "sed -n 92,112p src/store/paneTypes.ts");
    assert_eq!(opencode_child_activity_preview("read", &json!({ "filePath": "src/index.css" })), "src/index.css");
    assert_eq!(opencode_child_activity_preview("grep", &json!({ "pattern": "reasoningEffort" })), "reasoningEffort");
    assert_eq!(opencode_child_activity_preview("glob", &json!({ "pattern": "*.rs" })), "*.rs");
    assert_eq!(opencode_child_activity_preview("task", &json!({ "description": "inner task" })), "inner task");
    assert_eq!(opencode_child_activity_preview("webfetch", &json!({ "url": "https://example.test/x" })), "https://example.test/x");
    assert_eq!(opencode_child_activity_preview("unknown", &json!({ "a": "b" })), r#"{"a":"b"}"#);
}
```

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib opencode_item_from_part_ --locked`

Expected: FAIL — new tests fail because `opencode_item_from_part` still maps `task` to `dynamic_tool`, drops `retry`/`subtask` parts, omits reasoning `durationMs`/`title`, and `opencode_child_activity_preview` does not exist (compile error for the preview test is the intended failure mode for the missing helper; the behavioral failures are the intended failures for the rest).

- [ ] **Step 3: Add the production implementation**

In `crates/freshell-freshagent/src/lib.rs`:

3a. Add helpers above `opencode_item_from_part`:

```rust
/// Duration of a wire part from its `time` (ms). Absent/incomplete time yields None.
fn opencode_part_duration_ms(part: &Value) -> Option<u64> {
    let time = part.get("time")?;
    let start = time.get("start").and_then(Value::as_i64)?;
    let end = time.get("end").and_then(Value::as_i64)?;
    (end >= start).then_some((end - start) as u64)
}

/// Unwrap the opencode task output envelope — `state.output` carries
/// `<task …><task_result>BODY</task_result></task>` — so users see the task-result
/// content, never the internal markup. Any other shape passes through raw.
fn opencode_task_result_text(output: &str) -> String {
    const OPEN: &str = "<task_result>";
    const CLOSE: &str = "</task_result>";
    let (Some(open) = output.find(OPEN)) else { return output.to_string() };
    let (Some(close) = output.rfind(CLOSE)) else { return output.to_string() };
    if close > open {
        output[open + OPEN.len()..close].trim().to_string()
    } else {
        output.to_string()
    }
}

/// The opencode TUI header: `titlecase(subagent_type ?? "General") + " Task"` (+ " (background)") + " — " + description.
fn opencode_task_delegation_title(subagent: &str, background: bool, description: &str) -> String {
    let mut chars = subagent.chars();
    let titlecased = match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
        None => String::new(),
    };
    let name = if titlecased.trim().is_empty() { "General".to_string() } else { titlecased };
    format!("{name} Task{} — {description}", if background { " (background)" } else { "" })
}

/// One-line child-activity preview (the client's `getToolPreview` core cases).
pub(crate) fn opencode_child_activity_preview(tool: &str, input: &Value) -> String {
    let get = |key: &str| input.get(key).and_then(Value::as_str).unwrap_or("");
    let preview = match tool {
        "bash" | "shell" => get("command"),
        "read" | "write" | "edit" => get("filePath"),
        "grep" => get("pattern"),
        "glob" => get("pattern"),
        "task" => get("description"),
        "webfetch" => get("url"),
        _ => "",
    };
    // Unknown tools fall back to compact JSON verbatim — mirroring the client's
    // getToolPreview `JSON.stringify(input).slice(0, 100)` (braces included).
    let text = if preview.is_empty() {
        serde_json::to_string(input).unwrap_or_else(|_| "{}".to_string())
    } else {
        preview.to_string()
    };
    text.chars().take(120).collect()
}
```

3b. In `opencode_item_from_part`, extend the `Some("reasoning")` arm (line ~1293) to derive duration and the TUI-style title:

```rust
        Some("reasoning") => {
            let raw = part.get("text").and_then(Value::as_str).unwrap_or("");
            // The opencode TUI (packages/tui/src/context/thinking.ts reasoningSummary)
            // treats a leading bold block — "**Title**\n\n<body>" — as disclosure
            // metadata, styling the header independently of the markdown body.
            // Mirror that: the title splits off and the body carries the rest.
            let (title, text) = opencode_reasoning_title_and_body(raw);
            let segment = if text.is_empty() { vec![] } else { vec![text.clone()] };
            let mut item = json!({ "id": id, "kind": "reasoning", "summary": segment.clone(), "content": segment, "text": text });
            if let Some(duration) = opencode_part_duration_ms(part) {
                item["durationMs"] = json!(duration);
            }
            if let Some(title) = title {
                item["title"] = json!(title);
            }
            vec![item]
        }
```

with the helper (place near `opencode_part_duration_ms`):

```rust
/// Mirror of the opencode TUI's `reasoningSummary` (thinking.ts): a leading bold
/// block `**Title**` followed by a blank line (or end of text — a title still
/// awaiting its body while streaming) is disclosure metadata; the text after the
/// blank line is the body. The TUI regex is `/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n|$)/`.
fn opencode_reasoning_title_and_body(raw: &str) -> (Option<String>, String) {
    let content = raw.trim();
    let Some(rest) = content.strip_prefix("**") else { return (None, content.to_string()) };
    let Some(close) = rest.find("**") else { return (None, content.to_string()) };
    let candidate = &rest[..close];
    if candidate.is_empty() || candidate.contains('\n') || candidate.contains('*') {
        return (None, content.to_string());
    }
    let after = rest[close + 2..].trim_start_matches('\r');
    // Require end-of-text or a blank line (the TUI's `\r?\n\r?\n`), matching \r\n too.
    let body = if after.is_empty() {
        String::new()
    } else if let Some(stripped) = after.strip_prefix('\n') {
        let stripped = stripped.trim_start_matches('\r');
        if stripped.starts_with('\n') {
            stripped.trim().trim_end().to_string()
        } else {
            return (None, content.to_string());
        }
    } else {
        return (None, content.to_string());
    };
    (Some(candidate.trim().to_string()), body)
}
```

(After implementing, cross-check the helper against the four unit tests above — they encode the TUI's documented cases verbatim.)

3c. In the `Some("tool")` arm (line ~1308), branch on `tool == "task"` BEFORE the existing dynamic_tool mapping, and add the two new part types:

```rust
        Some("tool") => {
            let state = part.get("state").cloned().unwrap_or_else(|| json!({}));
            if part.get("tool").and_then(Value::as_str) == Some("task") {
                let input = state.get("input").cloned().unwrap_or_else(|| json!({}));
                let description = input.get("description").and_then(Value::as_str)
                    .or_else(|| state.get("title").and_then(Value::as_str))
                    .unwrap_or("");
                let subagent = input.get("subagent_type").and_then(Value::as_str).unwrap_or("general");
                let background = state.pointer("/metadata/background").and_then(Value::as_bool).unwrap_or(false);
                let status = match state.get("status").and_then(Value::as_str) {
                    Some("completed") => "completed",
                    Some("error") => "failed",
                    _ => "running",
                };
                let mut item = json!({
                    "id": id, "kind": "task_delegation", "status": status,
                    "title": opencode_task_delegation_title(subagent, background, description),
                    "subagent": subagent, "background": background,
                });
                if !description.is_empty() { item["description"] = json!(description); }
                if let Some(child) = state.pointer("/metadata/sessionId").and_then(Value::as_str) {
                    item["childSessionId"] = json!(child);
                }
                if let Some(start) = state.pointer("/time/start").and_then(Value::as_i64) { item["startedAtMs"] = json!(start); }
                if let Some(end) = state.pointer("/time/end").and_then(Value::as_i64) { item["endedAtMs"] = json!(end); }
                if let Some(duration) = opencode_part_duration_ms(&json!({ "time": state.get("time").cloned().unwrap_or(Value::Null) })) {
                    item["durationMs"] = json!(duration);
                }
                if let Some(output) = state.get("output").and_then(Value::as_str) {
                    item["result"] = json!(opencode_task_result_text(output));
                }
                return vec![item];
            }
            // … existing dynamic_tool mapping unchanged …
        }
        Some("retry") => {
            let attempt = part.get("attempt").and_then(Value::as_i64).unwrap_or(1).max(1);
            // Serialized NamedError shape is {name, data:{message,…}} (retry.ts reads
            // error.data.message); tolerate legacy {message} and bare-string shapes.
            let error = part.get("error").and_then(|err| {
                err.pointer("/data/message").and_then(Value::as_str)
                    .or_else(|| err.get("message").and_then(Value::as_str))
                    .or_else(|| err.as_str())
                    .or_else(|| err.get("name").and_then(Value::as_str))
            });
            let mut item = json!({ "id": id, "kind": "retry", "attempt": attempt });
            if let Some(error) = error { item["error"] = json!(error); }
            vec![item]
        }
        Some("subtask") => {
            let mut item = json!({ "id": id, "kind": "delegated_task" });
            if let Some(agent) = part.get("agent").and_then(Value::as_str) { item["agent"] = json!(agent); }
            if let Some(description) = part.get("description").and_then(Value::as_str) { item["description"] = json!(description); }
            if let Some(command) = part.get("command").and_then(Value::as_str) { item["command"] = json!(command); }
            vec![item]
        }
```

Note: the `retry` part's error shape is `{name, message}` (opencode `ErrorSchema`), a plain string, or absent — mirror the defensive extraction the crate already uses for message errors.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib opencode_ --locked`

Expected: PASS (new tests plus all pre-existing `opencode_*` tests).

- [ ] **Step 5: Refactor while green**

Extract the shared "status triple" mapping (`completed`/`error`→`failed`/else `running`) used by both the `dynamic_tool` path and the new delegation path into one small `fn opencode_tool_status(state: &Value) -> &'static str` if the duplication reads poorly; keep behavior identical and re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

The item shapes feed snapshot building (`opencode_message_turn_json`, `build_opencode_snapshot_json`, `get_opencode_snapshot`) and the zod contract suites. Run the whole freshagent lib plus the client contract suites together:

Run: `cargo test -p freshell-freshagent --lib --locked && npm run test:vitest -- run test/unit/contracts test/unit/shared --config config/vitest/vitest.config.ts`

Expected: PASS. (If a pre-existing Rust test pinned `tool:'task'` producing a `dynamic_tool` item, update that test to the new expectation — it is a behavioral change this task intentionally makes; record the change in the commit message.)

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/lib.rs
git commit -m "feat(freshagent): opencode task delegations, retry + subtask items, reasoning duration"
```

---

### Task 3: Rust child-session join — embed child activity rows and refresh the parent on child events

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs` (`get_opencode_snapshot` at line 820 — attach the join + registration after `build_opencode_snapshot_json`; add `attach_child_activity`, `opencode_child_activity_rows`, the child-watcher registry and `spawn_child_watcher` on `FreshAgentState`)
- Test: `crates/freshell-freshagent/src/lib.rs` (`mod tests` at line 3198)

**Load-bearing decisions baked into this task (Stage 2, ledger LB-2/LB-3/LB-6/LB-7/LB-8):**
- The join, the child→parent registry, and the watcher all live on **`FreshAgentState`** (lib.rs) — NOT on `opencode_ws.rs`'s `FreshOpencodeState`. The join call site is the REST `get_opencode_snapshot` (the single client-visible snapshot producer; the WS module only broadcasts events), and `FreshOpencodeState` cannot be reached from there. `FreshAgentState` already owns `ensure_manager`, the broadcast, and the serve bridge — everything the watcher needs.
- Registration re-arms on EVERY snapshot build: each `get_opencode_snapshot` call re-discovers child ids and ensures a watcher exists per child (active-watcher set). A watcher that exits removes its registry entry, so the next parent build re-arms it — dead watchers never cause permanent refresh loss.
- The watcher's recv loop mirrors `spawn_serve_bridge`'s exact tolerance arms (opencode_ws.rs:3310–3315): `Ok(SessionSignal::Lost) => {}` continue, `Err(RecvError::Lagged(_)) => {}` continue, `Err(RecvError::Closed) => break`. A burst of child events must not silently kill the live refresh.
- Activity rows are capped at 200 per delegation (full detail lives in the child session pane — recorded residual). Child fetches use the parent's Route (children share the parent's cwd by task-tool semantics) and accept a single message page per child (serve's `list_messages` does not thread the pagination cursor; truncation is acceptable for a summary). A 404 child yields an empty array — silent BY DESIGN (a pruned child correctly contributes no rows); `tracing::warn!` fires only on transport errors.
- If the REAL opencode serve ever fails to emit child-session `message.*` events on `/global/event`, the join degrades gracefully: the parent's own `message.updated` events (task part state changes at start/end) still rebuild the snapshot and refresh the rows — no compensating machinery (ledger LB-5 residual).

**Interfaces:**
- Consumes: `OpencodeServeManager::list_messages(id, route)` (crates/freshell-opencode/src/serve.rs:961 — `GET /session/:id/message`, 404→empty array), `OpencodeServeManager::subscribe(session_id)` (serve.rs:1162), `SessionSignal::Event` + `parse_serve_event` (events.rs:121 — child session ids arrive via `properties.sessionID`/`part.sessionID`/`info.sessionID`), the ws `changed_event`/`event_frame` helpers used by `spawn_serve_bridge` (opencode_ws.rs ~3265–3305 — locate the definitions once and reuse; if they are private to `opencode_ws`, make them `pub(crate)` in place), and Task 2's `opencode_child_activity_preview`.
- Produces: every client-visible opencode snapshot's `task_delegation` items carry `activity: [{tool, status, preview}]` for their child sessions; a child session `message.*` event causes a `freshAgent.session.changed` frame for the PARENT session id (reason `opencode-message`), which drives the client's existing snapshot refetch; and background delegations display the child-derived live status (spinner while the child works, child-span duration when it finishes — plan-review round 2, Finding 12) instead of the outer task part's immediately-completed state.

- [ ] **Step 1: Write the failing Rust tests**

1a. Pure row extraction test in lib.rs `mod tests`:

```rust
#[test]
fn opencode_child_activity_rows_collects_tool_parts_from_child_messages() {
    let messages = json!([
        { "info": { "id": "m_u", "role": "user" }, "parts": [
            { "type": "subtask", "agent": "general", "description": "Fix the flaky harness" },
            { "type": "text", "text": "go" } ] },
        { "info": { "id": "m_a", "role": "assistant" }, "parts": [
            { "type": "reasoning", "text": "hmm" },
            { "type": "tool", "tool": "bash", "state": { "status": "completed", "input": { "command": "sed -n 92,112p src/store/paneTypes.ts" } } },
            { "type": "tool", "tool": "grep", "state": { "status": "error", "input": { "pattern": "reasoningEffort" } } },
            { "type": "tool", "tool": "read", "state": { "status": "running", "input": { "filePath": "src/index.css" } } } ] },
    ]);
    let rows = opencode_child_activity_rows(messages.as_array().unwrap());
    assert_eq!(rows, vec![
        json!({ "tool": "bash", "status": "completed", "preview": "sed -n 92,112p src/store/paneTypes.ts" }),
        json!({ "tool": "grep", "status": "failed", "preview": "reasoningEffort" }),
        json!({ "tool": "read", "status": "running", "preview": "src/index.css" }),
    ]);
}

#[test]
fn opencode_child_activity_rows_cap_at_200() {
    let parts: Vec<Value> = (0..250)
        .map(|i| json!({ "type": "tool", "tool": "bash", "state": { "status": "completed", "input": { "command": format!("echo {i}") } } }))
        .collect();
    let messages = vec![json!({ "info": { "id": "m", "role": "assistant" }, "parts": parts })];
    assert_eq!(opencode_child_activity_rows(&messages).len(), 200);
}

#[test]
fn background_delegation_stays_running_while_child_is_active() {
    // opencode completes the outer task part immediately for background launches
    // (plan-review round 2, Finding 12); the child's live state must win.
    let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": true, "durationMs": 200u64 });
    let messages = vec![
        json!({ "info": { "id": "u", "role": "user", "time": { "created": 1000 } }, "parts": [] }),
        json!({ "info": { "id": "a", "role": "assistant", "time": { "created": 1100 } }, "parts": [
            json!({ "type": "tool", "tool": "bash", "state": { "status": "running", "input": {} } })
        ] }),
    ];
    opencode_apply_background_child_status(&mut item, &messages);
    assert_eq!(item["status"], json!("running"));
    assert!(item.get("durationMs").is_none());
}

#[test]
fn background_delegation_completes_with_child_span_duration() {
    let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": true, "durationMs": 5u64 });
    let messages = vec![
        json!({ "info": { "id": "u", "role": "user", "time": { "created": 1000 } }, "parts": [] }),
        json!({ "info": { "id": "a", "role": "assistant", "time": { "created": 1100, "completed": 61000 } }, "parts": [
            json!({ "type": "tool", "tool": "bash", "state": { "status": "completed", "input": {} } })
        ] }),
    ];
    opencode_apply_background_child_status(&mut item, &messages);
    assert_eq!(item["status"], json!("completed"));
    assert_eq!(item["durationMs"], json!(60000u64));
}

#[test]
fn non_background_and_errored_delegations_keep_parent_status() {
    let mut item = json!({ "kind": "task_delegation", "status": "completed", "background": false, "durationMs": 7u64 });
    opencode_apply_background_child_status(&mut item, &[json!({ "info": { "role": "assistant" }, "parts": [] })]);
    assert_eq!(item["durationMs"], json!(7u64));
    let mut item = json!({ "kind": "task_delegation", "status": "failed", "background": true });
    opencode_apply_background_child_status(&mut item, &[]);
    assert_eq!(item["status"], json!("failed"));
}
```

1b. End-to-end join test (lib.rs `mod tests`, using the crate's existing fake-serve seam the way `get_opencode_snapshot_returns_a_schema_shaped_snapshot_with_turn_text` at line 3457 drives `get_opencode_snapshot`): the fake serve answers `GET /session/ses_p` + `GET /session/ses_p/message` with the parent (its assistant message contains the Task-2 task tool part with `state.metadata.sessionId = "ses_c"`) and `GET /session/ses_c/message` with the child messages above. Assert `get_opencode_snapshot("ses_p", None)` returns a snapshot whose `task_delegation` item has the three activity rows. Extend the existing fake's routed responses for the child session id (follow the fake's existing message-serving structure).

1c. Live-refresh test (same seam): after `get_opencode_snapshot("ses_p", …)` RETURNS (its `ensure_child_watchers` has synchronously created the child's broadcast receiver before the join fetch — plan-review round 1 Finding 4 makes this ordering load-bearing), dispatch a `message.updated` serve event carrying the CHILD session id (`properties.info.sessionID = "ses_c"`) through the manager's scripted event path, then assert a `freshAgent.session.changed` frame addressed to `ses_p` with reason `opencode-message` reaches the broadcast sink (use the existing `frames_until(&mut rx, |f| is_event(f, "freshAgent.session.changed", …))` helper pattern). Dispatching only after the build returned makes the test deterministic: the receiver exists before the event.

1d. Graceful-degradation tests: when `GET /session/ses_c/message` 404s (child pruned), `get_opencode_snapshot` still succeeds and the `task_delegation` item simply has no `activity` key; when the child fetch errors on transport, the snapshot still succeeds (warn logged).

- [ ] **Step 2: Run the tests and verify the intended failure**

Run: `cargo test -p freshell-freshagent --lib --locked`

Expected: FAIL — `opencode_child_activity_rows` does not exist (compile error for 1a), snapshots contain no `activity` on delegation items (1b), and no parent `changed` frame follows child events (1c).

- [ ] **Step 3: Add the production implementation**

3a. lib.rs — row collector + snapshot post-processor:

```rust
/// Compact child-session activity rows for a task delegation (opencode TUI's
/// nested `↳ <tool> <summary>` lines, joined server-side from the child session).
pub(crate) fn opencode_child_activity_rows(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .flat_map(|message| message.get("parts").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]))
        .filter(|part| part.get("type").and_then(Value::as_str) == Some("tool"))
        .map(|part| {
            let tool = part.get("tool").and_then(Value::as_str).unwrap_or("tool");
            let state = part.get("state").cloned().unwrap_or_else(|| json!({}));
            let status = match state.get("status").and_then(Value::as_str) {
                Some("completed") => "completed",
                Some("error") => "failed",
                _ => "running",
            };
            let input = state.get("input").cloned().unwrap_or_else(|| json!({}));
            json!({ "tool": tool, "status": status, "preview": opencode_child_activity_preview(tool, &input) })
        })
        .collect()
}

/// Server-side child-session join: for every task_delegation item referencing a
/// child session, fetch the child's messages and embed compact activity rows.
/// Graceful on any child fetch failure (pruned child, sidecar hiccup): the item
/// keeps its own fields and simply gains no `activity`.
async fn attach_child_activity(manager: &OpencodeServeManager, route: &Route, snapshot: &mut Value) {
    let Some(turns) = snapshot.get_mut("turns").and_then(Value::as_array_mut) else { return };
    for turn in turns.iter_mut() {
        let Some(items) = turn.get_mut("items").and_then(Value::as_array_mut) else { continue };
        for item in items.iter_mut() {
            if item.get("kind").and_then(Value::as_str) != Some("task_delegation") { continue; }
            let Some(child) = item.get("childSessionId").and_then(Value::as_str).map(str::to_string) else { continue };
            match manager.list_messages(&child, route).await {
                Ok(Value::Array(messages)) if !messages.is_empty() => {
                    item["activity"] = Value::Array(opencode_child_activity_rows(&messages));
                    opencode_apply_background_child_status(item, &messages);
                }
                Ok(_) => {}
                Err(err) => {
                    // Structured warn, never a hard failure: a pruned child or a
                    // sidecar hiccup must not break the parent's snapshot.
                    tracing::warn!(child_session = %child, error = %err, "opencode child activity join skipped");
                }
            }
        }
    }
}

/// Background delegations (plan-review round 2, Finding 12): opencode completes the
/// outer task part IMMEDIATELY for a background launch while the child session keeps
/// running. The TUI (session/index.tsx) shows the delegation as running while the
/// child session isn't idle and derives its duration from the child's messages
/// (first user message created → last assistant completed). Mirror that from the
/// fetched child messages. Non-background items keep the parent part's
/// authoritative status (a foreground task part completes only when the child
/// finishes), and a parent 'running'/'error' status always stays authoritative.
pub(crate) fn opencode_apply_background_child_status(item: &mut Value, messages: &[Value]) {
    if item.get("background").and_then(Value::as_bool) != Some(true) { return; }
    if item.get("status").and_then(Value::as_str) != Some("completed") { return; }
    let mut child_active = false;
    for message in messages {
        if let Some(parts) = message.get("parts").and_then(Value::as_array) {
            if parts.iter().any(|p| p.pointer("/state/status").and_then(Value::as_str) == Some("running")) {
                child_active = true;
            }
        }
        if message.pointer("/info/role").and_then(Value::as_str) == Some("assistant")
            && message.pointer("/info/time/completed").is_none() {
            child_active = true;
        }
    }
    if child_active {
        // Live background work: spinner, no duration (the TUI shows none while running).
        item["status"] = json!("running");
        item.as_object_mut().map(|o| o.remove("durationMs"));
        return;
    }
    // Child finished: duration = last assistant completed − first user created.
    let first_user_created = messages.iter()
        .find(|m| m.pointer("/info/role").and_then(Value::as_str) == Some("user"))
        .and_then(|m| m.pointer("/info/time/created").and_then(Value::as_i64));
    let last_assistant_completed = messages.iter()
        .filter(|m| m.pointer("/info/role").and_then(Value::as_str) == Some("assistant"))
        .filter_map(|m| m.pointer("/info/time/completed").and_then(Value::as_i64))
        .max();
    if let (Some(start), Some(end)) = (first_user_created, last_assistant_completed) {
        if end >= start {
            item["durationMs"] = json!((end - start) as u64);
        }
    }
}
```

Call both pieces in `get_opencode_snapshot` (line ~820): replace the final `Ok(build_opencode_snapshot_json(thread_id, &info, &messages, rollback.as_ref()))` with:

```rust
        let mut snapshot = build_opencode_snapshot_json(thread_id, &info, &messages, rollback.as_ref());
        // Server-side child-session join (Stage-2 ledger LB-2): this REST builder is the
        // single client-visible snapshot producer, so the join AND the live-refresh
        // registry live here, on FreshAgentState — reachable for every session
        // (live or sidebar-opened durable), re-armed on every build (LB-8).
        // ORDER (plan-review round 1, Finding 4): watch FIRST, fetch SECOND. The
        // subscribe call creates the broadcast receiver synchronously BEFORE the
        // child-history fetch runs, so a child event racing the fetch is buffered
        // in the channel instead of lost — a tokio broadcast receiver does not replay.
        self.ensure_child_watchers(&manager, thread_id, &snapshot);
        attach_child_activity(&manager, &route, &mut snapshot).await;
        Ok(snapshot)
```

And the registry + watcher on `FreshAgentState` (lib.rs, near the other shared opencode state):

```rust
/// Child→parent session links discovered from task_delegation items, with the
/// set of children that have a live watcher spawned. Guarded by a std Mutex
/// with short critical sections. Watchers self-remove on exit; every snapshot
/// build re-arms missing ones.
child_watchers: std::sync::Mutex<std::collections::HashMap<String, String>>,

const OPENCODE_CHILD_ACTIVITY_ROW_CAP: usize = 200;
/// Idle retire bound for orphaned watchers (plan review round 1, Finding 5):
/// 2 hours covers realistic long-running delegations and post-"Open session"
/// child resumes; a quieter child than that rearms on the parent's next build.
const OPENCODE_CHILD_WATCHER_IDLE_SECS: u64 = 7200;

fn ensure_child_watchers(&self, manager: &OpencodeServeManager, parent_id: &str, snapshot: &Value) {
    for child in opencode_snapshot_child_session_ids(snapshot) {
        let mut watchers = self.child_watchers.lock().expect("child_watchers poisoned");
        if watchers.contains_key(&child) { continue; }
        watchers.insert(child.clone(), parent_id.to_string());
        drop(watchers);
        // Subscribe BEFORE spawning (spawn_serve_bridge discipline): the tokio
        // broadcast receiver is created on THIS line, synchronously, so events
        // racing the spawned task's startup are buffered, not lost.
        let rx = manager.subscribe(&child);
        let fresh_agent = self.clone_for_bridge();        // same clone shape spawn_serve_bridge uses for its task
        let registry = self.child_watchers_handle_for_task(); // Arc/clone giving the spawned task removal access
        let parent_id = parent_id.to_string();
        tokio::spawn(async move {
            let mut rx = rx;
            loop {
                match tokio::time::timeout(Duration::from_secs(OPENCODE_CHILD_WATCHER_IDLE_SECS), rx.recv()).await {
                    Err(_elapsed) => break,
                    Ok(Ok(SessionSignal::Event(parsed))) => {
                        if !parsed.kind.starts_with("message.") { continue; }
                        fresh_agent.broadcast(&event_frame(&parent_id, changed_event(&parent_id, "opencode-message")));
                    }
                    Ok(Ok(SessionSignal::Lost)) => {}
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(_))) => {} // LB-3: bursts must not kill the refresh
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                }
            }
            registry.lock().expect("child_watchers poisoned").remove(&child); // re-arms on the next parent build
        });
    }
}

/// Child session ids referenced by this snapshot's task_delegation items.
fn opencode_snapshot_child_session_ids(snapshot: &Value) -> Vec<String> { /* walk turns[].items[] */ }
```

(Adapt the clone/sharing shapes to exactly what `spawn_serve_bridge` (opencode_ws.rs:3258–3305) already does to move a manager + `FreshAgentState` into a spawned task — it solved the identical problem for per-session bridges; if `changed_event`/`event_frame` are private helpers of `opencode_ws`, make them `pub(crate)` in place rather than duplicating them. Also cap `opencode_child_activity_rows` output at `OPENCODE_CHILD_ACTIVITY_ROW_CAP` (take the first 200; full detail lives in the child session pane).)

Residual recorded from plan-review round 1 (Finding 5): a child session resumed more than `OPENCODE_CHILD_WATCHER_IDLE_SECS` after its last event, while its parent pane receives no parent-driven snapshot builds in that window, shows its next child activity only after the parent's next snapshot build rather than on the child's first event. Accepted — the alternative (unbounded watcher lifetime) leaks; the window is 2 hours; the "Open session" flow itself opens the child pane whose own live view is authoritative.

- [ ] **Step 4: Run the focused tests**

Run: `cargo test -p freshell-freshagent --lib --locked`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

If the parent-scan for child ids duplicates traversal logic with `attach_child_activity`, extract one `fn opencode_snapshot_child_session_ids(snapshot: &Value) -> Vec<String>` used by both. Re-run Step 4.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent --locked`

Expected: PASS (lib + integration surface of the crate). This change touches the snapshot path consumed by the REST route (snapshot.rs) and ws — the crate-level run covers both.

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/lib.rs
git add crates/freshell-freshagent/src/opencode_ws.rs 2>/dev/null || true  # only if changed_event/event_frame needed pub(crate)
git commit -m "feat(freshagent): join opencode child-session activity into task delegation snapshots"
```

---

### Task 4: Client item cards — delegation block, retry row, delegated-task caption

**Files:**
- Create: `src/components/fresh-agent/shared/format-duration.ts`
- Modify: `src/components/fresh-agent/FreshAgentItemCard.tsx` (new `FreshAgentDelegationBlock`, `FreshAgentRetryRow`, `FreshAgentDelegatedTaskCaption`, `FreshAgentOpenSessionContext`; extend `FreshAgentToolDisplay` with `previewOverride?: string`; `FreshAgentToolBlock` honors it)
- Modify: `src/components/fresh-agent/shared/tool-preview.ts` (only if a `Retrying` preview case is needed — not required by the final design)
- Test: `test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx`

**Interfaces:**
- Consumes: Task 1 contract types (`FreshAgentTranscriptItem` union).
- Produces (consumed by Tasks 5–6):
  - `export const FreshAgentOpenSessionContext: Context<(sessionId: string, title?: string) => void>` (default value: a no-op, so cards render without a provider).
  - `FreshAgentToolDisplay.previewOverride?: string` — when present, `FreshAgentToolBlock` and the strip's SlotReel use it instead of `getToolPreview(name, input)`.
  - `export function formatThoughtDuration(ms: number): string` (`1831` → `"1.8s"`, `75000` → `"1m 15s"`, `3_720_000` → `"1h 2m"`).
  - Rendering: `task_delegation` → `FreshAgentDelegationBlock`; `retry` → `FreshAgentRetryRow`; `delegated_task` → muted caption.

- [ ] **Step 1: Write the failing component tests**

Append to `test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx` (the file's existing style renders exported components with plain item literals and asserts with testing-library queries):

```tsx
import { FreshAgentItemCard, FreshAgentDelegationBlock, FreshAgentOpenSessionContext } from '@/components/fresh-agent/FreshAgentItemCard'

const longTaskResult = Array.from({ length: 30 }, (_, i) => `line ${i + 1}: harness output sample`).join('\n')

const delegationItem = {
  id: 'part_t1', kind: 'task_delegation' as const, status: 'running' as const,
  title: 'General Task — Fix the flaky harness', description: 'Fix the flaky harness',
  subagent: 'general', childSessionId: 'ses_child_1', durationMs: 1755761,
  activity: [
    { tool: 'bash', status: 'completed' as const, preview: 'sed -n 92,112p src/store/paneTypes.ts' },
    { tool: 'grep', status: 'failed' as const, preview: 'reasoningEffort' },
    { tool: 'read', status: 'running' as const, preview: 'src/index.css' },
  ],
  result: longTaskResult,
}

describe('task_delegation rendering', () => {
  it('renders the delegation header with title, duration and running spinner', () => {
    render(<FreshAgentDelegationBlock item={delegationItem} />)
    expect(screen.getByText('General Task — Fix the flaky harness')).toBeInTheDocument()
    expect(screen.getByText('29m 16s')).toBeInTheDocument() // formatThoughtDuration(1755761)
    expect(screen.getByLabelText('running')).toBeInTheDocument()
  })

  it('renders nested child rows with title-cased tool labels and (failed) on errors', () => {
    render(<FreshAgentDelegationBlock item={delegationItem} />)
    expect(screen.getByText('Bash')).toBeInTheDocument()
    expect(screen.getByText('Grep')).toBeInTheDocument()
    expect(screen.getByText(/sed -n 92,112p src\/store\/paneTypes\.ts/)).toBeInTheDocument()
    expect(screen.getByText('(failed)')).toBeInTheDocument()
  })

  it('renders the clamped task result: full content in a bounded, scrollable box', () => {
    render(<FreshAgentDelegationBlock item={delegationItem} />)
    const result = screen.getByTestId('fresh-agent-delegation-result')
    // Content-presence: the LAST line proves the whole result body is carried…
    expect(result).toHaveTextContent('line 30: harness output sample')
    // …and the clamp classes prove the box is bounded + scrollable (max-h-24 + overflow).
    expect(result.className).toContain('max-h-24')
    expect(result.className).toContain('overflow-y-auto')
  })

  it('renders an Open session button that calls the context handler with the child session', () => {
    const openSession = vi.fn()
    render(
      <FreshAgentOpenSessionContext.Provider value={openSession}>
        <FreshAgentDelegationBlock item={delegationItem} />
      </FreshAgentOpenSessionContext.Provider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /open session/i }))
    expect(openSession).toHaveBeenCalledWith('ses_child_1', 'Fix the flaky harness')
  })

  it('omits the Open session button without a child session id', () => {
    render(<FreshAgentDelegationBlock item={{ ...delegationItem, childSessionId: undefined }} />)
    expect(screen.queryByRole('button', { name: /open session/i })).not.toBeInTheDocument()
  })

  it('shows completed check and failed cross statuses', () => {
    const { rerender } = render(<FreshAgentDelegationBlock item={delegationItem} />)
    rerender(<FreshAgentDelegationBlock item={{ ...delegationItem, status: 'completed' }} />)
    expect(screen.getByLabelText('complete')).toBeInTheDocument()
    rerender(<FreshAgentDelegationBlock item={{ ...delegationItem, status: 'failed' }} />)
    expect(screen.getByLabelText('error')).toBeInTheDocument()
  })
})

describe('retry rendering', () => {
  it('renders a muted retry row with attempt and error text', () => {
    render(<FreshAgentItemCard item={{ id: 'rr', kind: 'retry', attempt: 2, error: 'stream disconnected' }} />)
    expect(screen.getByTestId('fresh-agent-retry-row')).toHaveTextContent('Retrying (attempt 2) — stream disconnected')
  })
})

describe('delegated_task rendering', () => {
  it('renders a one-line muted caption with the title-cased agent', () => {
    render(<FreshAgentItemCard item={{ id: 's1', kind: 'delegated_task', agent: 'general', description: 'Fix the flaky harness' }} />)
    expect(screen.getByTestId('fresh-agent-delegated-task')).toHaveTextContent('Delegated — General · Fix the flaky harness')
  })
})

describe('formatThoughtDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatThoughtDuration(1831)).toBe('1.8s')
    expect(formatThoughtDuration(3_400)).toBe('3.4s')
    expect(formatThoughtDuration(61_000)).toBe('1m 1s')
    expect(formatThoughtDuration(3_720_000)).toBe('1h 2m')
  })
})
```

(Import `formatThoughtDuration` in the test; keep the file's existing mock setup untouched.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — `FreshAgentDelegationBlock`/`FreshAgentOpenSessionContext`/`formatThoughtDuration` don't exist (import error) and the retry/delegated_task kinds render nothing today.

- [ ] **Step 3: Add the production implementation**

3a. `src/components/fresh-agent/shared/format-duration.ts`:

```ts
/** Compact wall duration for thought/delegation labels: `3.4s`, `1m 12s`, `1h 2m`. */
export function formatThoughtDuration(ms: number): string {
  if (ms < 0) ms = 0
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSeconds = Math.round(ms / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${minutes % 60}m`
}
```

3b. In `FreshAgentItemCard.tsx`:

- Add `previewOverride?: string` to `FreshAgentToolDisplay` and use `const preview = useMemo(() => tool.previewOverride ?? getToolPreview(tool.name, tool.input), [tool])` in `FreshAgentToolBlock`.
- Add the context with a no-op default:

```ts
export const FreshAgentOpenSessionContext = createContext<(sessionId: string, title?: string) => void>(() => {})
```

- Add the display-casing helper (plan-review round 1, Finding 7 — the User Request's output is `↳ Bash …` / `Delegated — General · …`, and opencode title-cases tool labels):

```ts
/** First-letter uppercase display transform for wire-provided labels. */
function titleCaseFirst(value: string): string {
  const trimmed = value.trim()
  if (!trimmed) return value
  return trimmed[0].toUpperCase() + trimmed.slice(1)
}
```

- Add `FreshAgentDelegationBlock` (status icon per existing tool-block conventions — `Loader2`/`Check`/`X` from lucide-react):

```tsx
export function FreshAgentDelegationBlock({ item }: { item: Extract<FreshAgentTranscriptItem, { kind: 'task_delegation' }> }) {
  const openSession = useContext(FreshAgentOpenSessionContext)
  const activity = item.activity ?? []
  return (
    <div className="fresh-agent-delegation-block my-0.5 text-xs" data-testid="fresh-agent-delegation-block" data-status={item.status}>
      <div className="flex min-w-0 items-center gap-2 rounded-r px-2 py-0.5">
        {item.status === 'running' ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="running" /> : null}
        {item.status === 'completed' ? <Check className="h-3 w-3 shrink-0 text-green-500" aria-label="complete" /> : null}
        {item.status === 'failed' ? <X className="h-3 w-3 shrink-0 text-destructive" aria-label="error" /> : null}
        <span className="fresh-agent-delegation-title truncate font-medium">{item.title}</span>
        {item.durationMs !== undefined ? (
          <span className="shrink-0 text-muted-foreground">{formatThoughtDuration(item.durationMs)}</span>
        ) : null}
      </div>
      {activity.length > 0 ? (
        <div className="border-t border-border/50 px-3 py-1">
          {activity.map((row, index) => (
            <div key={`${row.tool}-${index}`} className="flex min-w-0 items-center gap-2 py-0.5 text-muted-foreground" data-testid="fresh-agent-delegation-row">
              <span aria-hidden="true">↳</span>
              <span className="shrink-0 font-medium">{titleCaseFirst(row.tool)}</span>
              {row.preview ? <span className="truncate font-mono">{row.preview}</span> : null}
              {row.status === 'failed' ? <span className="shrink-0 text-destructive">(failed)</span> : null}
              {row.status === 'running' ? <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-label="running" /> : null}
            </div>
          ))}
        </div>
      ) : null}
      {item.result ? (
        <div className="border-t border-border/50 px-3 py-1">
          <pre data-testid="fresh-agent-delegation-result" className="fresh-agent-delegation-result max-h-24 overflow-y-auto whitespace-pre-wrap break-words font-mono opacity-80">
            {item.result}
          </pre>
        </div>
      ) : null}
      {item.childSessionId ? (
        <div className="border-t border-border/50 px-3 py-1">
          <button
            type="button"
            className="rounded p-0.5 text-muted-foreground underline-offset-2 transition-colors hover:bg-accent/50 hover:underline"
            onClick={() => openSession(item.childSessionId!, item.description)}
            aria-label={`Open session ${item.description ?? item.childSessionId}`}
          >
            Open session
          </button>
        </div>
      ) : null}
    </div>
  )
}
```

- Add the retry row and the delegated-task caption (caption agent title-cased per Finding 7):

```tsx
export function FreshAgentRetryRow({ attempt, error }: { attempt: number; error?: string }) {
  return (
    <div data-testid="fresh-agent-retry-row" className="my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground">
      {`Retrying (attempt ${attempt})${error ? ` — ${error}` : ''}`}
    </div>
  )
}
```

```tsx
// In FreshAgentItemCard's kind dispatch:
  if (item.kind === 'task_delegation') return <FreshAgentDelegationBlock item={item} />
  if (item.kind === 'retry') return <FreshAgentRetryRow attempt={item.attempt} error={item.error} />
  if (item.kind === 'delegated_task') {
    return (
      <div data-testid="fresh-agent-delegated-task" className="my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground">
        {`Delegated — ${titleCaseFirst(item.agent ?? 'Task')}${item.description ? ` · ${item.description}` : ''}`}
      </div>
    )
  }
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

If the `Loader2/Check/X` status-icon triple now appears in three places (tool block, delegation block, elsewhere), extract a small `ToolStatusIcon({ status, isError })` component within the file and use it in the new block only if it does not churn the existing tool block (scope rule: do not rewrite pre-existing rendering).

- [ ] **Step 6: Run impacted-test verification**

`FreshAgentItemCard` and `FreshAgentToolDisplay` are consumed by `FreshAgentTranscript` (strip) and its tests, plus snapshot-scheduler/store fixtures that construct tool displays. Run the fresh-agent component suite:

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent --config config/vitest/vitest.config.ts`

Expected: PASS (the transcript suite will exercise the new kinds only after Task 5; no existing test may break from the additive display plumbing).

Also run the a11y lint gate:

Run: `npm run lint`

Expected: PASS (the new button carries a real `aria-label`; rows are non-interactive).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentItemCard.tsx src/components/fresh-agent/shared/format-duration.ts test/unit/client/components/fresh-agent/FreshAgentItemCard.test.tsx
git commit -m "feat(client): fresh-agent delegation block, retry row, delegated-task caption"
```

---

### Task 5: Strip integration — fold delegations and retries, settled thought durations, live slot naming

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (`isToolLike` line 51, `isActivityLike` line 67, `ActivityRow`/`buildActivity` lines 80–174, `settledSummary` 196, `FreshAgentThinkingRow` 529, `FreshAgentActivityStrip` 554–704)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: Task 4's `FreshAgentDelegationBlock`, `FreshAgentRetryRow`, `FreshAgentOpenSessionContext` (no-op default keeps the strip working without Task 6), `formatThoughtDuration`, and `FreshAgentToolDisplay.previewOverride`.
- Produces: the transcript folds `task_delegation` (as a strip member rendered by `FreshAgentDelegationBlock`, counted as a tool in `settledSummary`, named `Task` + title in the live reel) and `retry` (activity-like muted row; live reel names `Retrying (attempt N)` when it is the strip's last row); thinking rows show `Thought · <duration>` (or `Thought: <title> · <duration>`) once a duration exists; `reasoning` items feed duration/title into the thinking-row merge.

- [ ] **Step 1: Write the failing transcript tests**

Append to `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` (same plain-turn-literal style as the file):

```tsx
const delegationTurn = {
  id: 't_deleg', turnId: 't_deleg', role: 'assistant' as const, summary: '',
  items: [
    { id: 'r1', kind: 'reasoning' as const, summary: ['planning'], content: ['planning'], durationMs: 3400 },
    {
      id: 'task1', kind: 'task_delegation' as const, status: 'running' as const,
      title: 'General Task — Fix the flaky harness', description: 'Fix the flaky harness',
      childSessionId: 'ses_child_1',
      activity: [
        { tool: 'bash', status: 'completed' as const, preview: 'sed -n 92,112p src/store/paneTypes.ts' },
        { tool: 'grep', status: 'failed' as const, preview: 'reasoningEffort' },
      ],
    },
    { id: 'rr1', kind: 'retry' as const, attempt: 2, error: 'stream disconnected' },
  ],
}

describe('task delegation + retry folding', () => {
  it('folds a delegation turn into a single activity line with a live Task slot', () => {
    // Plan-review round 2, Finding 13: this turn must NOT include the retry item —
    // the retry-last reel precedence (its own test below) would otherwise name
    // "Retrying" instead of the running delegation on the live line.
    render(<FreshAgentTranscript turns={[{ ...delegationTurn, items: [delegationTurn.items[0], delegationTurn.items[1]] }]} />)
    const strip = screen.getByRole('region', { name: 'Activity strip' })
    // One collapsed line: the SlotReel names the running thing.
    expect(within(strip).getByText('Task')).toBeInTheDocument()
    expect(within(strip).getByText('General Task — Fix the flaky harness')).toBeInTheDocument()
    // Nothing rendered as a standalone article between assistant messages
    // (queryAllByTestId — getAllBy* throws on zero matches and cannot assert absence).
    expect(within(strip).queryAllByTestId('fresh-agent-delegation-block')).toHaveLength(0)
  })

  it('expands to the delegation block and the retry row', () => {
    render(<FreshAgentTranscript turns={[delegationTurn]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
    expect(screen.getByTestId('fresh-agent-delegation-block')).toBeInTheDocument()
    expect(screen.getByText(/sed -n 92,112p src\/store\/paneTypes\.ts/)).toBeInTheDocument()
    expect(screen.getByText('(failed)')).toBeInTheDocument()
    expect(screen.getByTestId('fresh-agent-retry-row')).toHaveTextContent('Retrying (attempt 2) — stream disconnected')
  })

  it('settled delegation turns summarize like other tool lines', () => {
    render(<FreshAgentTranscript turns={[{ ...delegationTurn, items: [{ ...delegationTurn.items[1], status: 'completed' }] }]} />)
    // settledSummary counts the delegation as one used tool: "1 tool used".
    expect(screen.getByText(/1 tool used/)).toBeInTheDocument()
  })

  it('names Retrying on the live line when a retry is the last activity', () => {
    render(<FreshAgentTranscript turns={[{ ...delegationTurn, items: [{ ...delegationTurn.items[1], status: 'completed' as const }, delegationTurn.items[2]] }]} /* through the file's existing live/streaming path — see adaptation rules */ />)
    const strip = screen.getByRole('region', { name: 'Activity strip' })
    // The settled delegation must not mask the between-attempts retry marker (LB-4).
    expect(within(strip).getByText('Retrying')).toBeInTheDocument()
    expect(within(strip).getByText('attempt 2')).toBeInTheDocument()
    expect(within(strip).queryByText('Task')).not.toBeInTheDocument()
  })
})

describe('thought duration labels', () => {
  it('labels a settled reasoning row with its duration', () => {
    render(<FreshAgentTranscript turns={[{ id: 't1', turnId: 't1', role: 'assistant', summary: '', items: [delegationTurn.items[0]] }]} />)
    expect(screen.getByRole('button', { name: 'Thought · 3.4s' })).toBeInTheDocument()
    expect(screen.getByText('Thought · 3.4s')).toBeInTheDocument()
  })

  it('keeps the Thinking label for rows without a duration', () => {
    render(<FreshAgentTranscript turns={[{ id: 't1', turnId: 't1', role: 'assistant', summary: '', items: [{ id: 'r0', kind: 'reasoning', summary: ['x'], content: ['x'] }] }]} />)
    expect(screen.getByRole('button', { name: 'Thinking' })).toBeInTheDocument()
  })
})
```

Two adaptation rules for this step (read the test file first):
- The live-strip assertions in the first `describe` must render through the transcript's EXISTING live/streaming path — the SlotReel only names a running tool while the strip is live. Find the file's existing live-strip test (search for `fresh-agent-activity-status-slot` / `animate-spin` assertions) and copy how it marks the last turn as streaming; the collapsed-line assertions above then hold. If no live-path helper exists, render with the transcript's streaming prop pattern the FreshAgentView uses.
- All other assertion details follow the file's actual aria/label patterns; the behavioral contract is fixed: one line when collapsed, named live slot, delegation block + retry row only when expanded, settled duration label on the thinking disclosure.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — `task_delegation`/`retry` are not activity-like today (the turn renders nothing/no folding), and thinking rows never show a duration.

- [ ] **Step 3: Add the production implementation**

3a. Membership:

```ts
function isToolLike(item: FreshAgentTranscriptItem): boolean {
  return /* existing kinds */ || item.kind === 'task_delegation'
}

function isActivityLike(item: FreshAgentTranscriptItem): boolean {
  return isToolLike(item) || item.kind === 'thinking' || item.kind === 'reasoning' || item.kind === 'retry'
}
```

3b. Rows — extend the `ActivityRow` union and `buildActivity`:

```ts
type ActivityRow =
  | { type: 'thinking'; id: string; text: string; durationMs?: number; title?: string }
  | { type: 'tool'; tool: FreshAgentToolDisplay }
  | { type: 'delegation'; item: Extract<FreshAgentTranscriptItem, { kind: 'task_delegation' }>; tool: FreshAgentToolDisplay }
  | { type: 'retry'; id: string; attempt: number; error?: string }
  | { type: 'caption'; id: string; text: string }
```

In `buildActivity`: thinking/reasoning merge keeps working and carries `durationMs`/`title` (only `reasoning` items have them; consecutive merges keep the LAST non-undefined duration); `task_delegation` items push `{ type: 'delegation', item, tool: { id: item.id, name: 'Task', previewOverride: item.title, output: item.result, isError: item.status === 'failed', status: item.status === 'running' ? 'running' : 'complete' } }`; `retry` items push `{ type: 'retry', ... }`.

3c. Strip rendering in `FreshAgentActivityStrip`:

- `activityTools(rows)` includes `row.type === 'delegation' ? row.tool : row.type === 'tool' ? row.tool : null` so `settledSummary` counts delegations as tools and `hasErrors` sees `isError`.
- Expanded view: `row.type === 'delegation'` renders `<FreshAgentDelegationBlock item={row.item} />`; `row.type === 'retry'` renders `<FreshAgentRetryRow ... />` (both inside the existing expanded-rows map).
- Live reel (LB-4 from the load-bearing ledger: a retry marker as the last row IS the running thing — a settled tool display must not mask it):
  ```ts
  const runningTool = live ? [...tools].reverse().find((tool) => tool.status === 'running') ?? null : null
  const retryLast = live && lastRow?.type === 'retry' ? lastRow : null
  const liveTool = !thinkingLive && live && !runningTool && !retryLast ? (tools[tools.length - 1] ?? null) : null
  const activeTool = runningTool ?? liveTool
  const reelName = retryLast ? 'Retrying' : activeTool ? activeTool.name : thinkingLive ? 'Thinking' : null
  const reelPreview = retryLast
    ? `attempt ${retryLast.attempt}`
    : activeTool
      ? (activeTool.previewOverride ?? getToolPreview(activeTool.name, activeTool.input))
      : null
  const running = live && (activeTool !== null || thinkingLive || retryLast !== null)
  ```
  (running-tool detection already iterates `tools`, which now includes delegation displays via 3b. Priority: an actually-running tool → the between-attempts retry marker → the last settled tool, matching "the live strip line names the running thing".)

3d. `FreshAgentThinkingRow` label — the button's `aria-label` MUST match its visible label (a11y lint + the "identifiable interactive elements" rule):

```tsx
function FreshAgentThinkingRow({ text, durationMs, title, expanded, onToggle }: {
  text: string
  durationMs?: number
  title?: string
  expanded: boolean
  onToggle: () => void
}) {
  const label = durationMs !== undefined
    ? `Thought${title ? `: ${title}` : ''} · ${formatThoughtDuration(durationMs)}`
    : 'Thinking'
  // …existing button markup, with `aria-label={label}` and `{label}` as the visible label…
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

The strip's expanded-rows map now has five row types — if the branch chain reads poorly, extract `renderActivityRow(row)` while preserving per-type keys and the thinking-row override plumbing (the `thinkingExpandedById` mechanics must stay owned by the strip).

- [ ] **Step 6: Run impacted-test verification**

The strip's folding semantics are covered by the whole transcript suite, the ItemCard suite (Task 4), and the pane suites. Run them together:

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent test/unit/client/fresh-agent-ws.test.ts --config config/vitest/vitest.config.ts && npm run lint`

Expected: PASS. If a pre-existing folding test asserted exact row rendering for an unrelated provider and breaks because `activityTools` now includes delegation rows, that test needs updating ONLY if it constructed task_delegation items (none exist in fixtures today) — otherwise PASS unchanged.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat(client): fold opencode delegations and retries into the activity strip"
```

---

### Task 6: Open-session link wiring — dispatch openSessionTab from the delegation block

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (provide `FreshAgentOpenSessionContext` around the transcript render at line ~2929; the view already holds `useAppDispatch` at line 575)
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

**Interfaces:**
- Consumes: `openSessionTab` (src/store/tabsSlice.ts:980 — payload includes `sessionId`, `title`, `cwd`, `provider`, `sessionType`, `isSubagent`, …), the pane's `cwd`, and Task 4's context.
- Produces: clicking a delegation block's "Open session" button dispatches `openSessionTab({ sessionId: <childSessionId>, title: <description or session id>, cwd: <pane cwd>, provider: 'opencode', sessionType: 'freshopencode', isSubagent: true })`, which opens (or focuses) a freshopencode pane resuming the child durable session.

- [ ] **Step 1: Write the failing view test**

Append to `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` following the file's existing harness for rendering the view with a pane + snapshot (reuse its store setup; if the harness dispatches real thunks, assert on the dispatched action type `tabs/openSessionTab/pending` and its `meta.arg`):

```tsx
it('dispatches openSessionTab with the child session when the delegation Open session button is clicked', async () => {
  const { store } = renderFreshOpencodeViewWithSnapshot({
    sessionId: 'ses_parent',
    turns: [{
      id: 't1', turnId: 't1', role: 'assistant', summary: '',
      items: [{
        id: 'task1', kind: 'task_delegation', status: 'completed',
        title: 'General Task — Fix the flaky harness', description: 'Fix the flaky harness',
        childSessionId: 'ses_child_1',
      }],
    }],
  })
  // Plan-review round 2, Finding 14: delegation details (and the Open session
  // button) render only inside the EXPANDED activity strip — the existing
  // transcript tests open details via Toggle activity details first.
  fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
  fireEvent.click(screen.getByRole('button', { name: /open session/i }))
  const action = store.getActions().find((a: { type: string }) => a.type === 'tabs/openSessionTab/pending')
  expect(action).toBeDefined()
  expect(action.meta.arg).toMatchObject({
    sessionId: 'ses_child_1', provider: 'opencode', sessionType: 'freshopencode', isSubagent: true,
  })
})
```

(Read the test file first and adapt the harness to what it already provides for rendering a freshopencode view with a pane + snapshot; the assertion contract above must hold. If the file has no such helper, create one following its existing view-render setup — do NOT leave the helper undefined. The assertion targets the dispatched action type `tabs/openSessionTab/pending` with the `meta.arg` fields above.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL — no provider is wired, so the context's default no-op runs and no action is dispatched.

- [ ] **Step 3: Add the production implementation**

In `FreshAgentView.tsx`:

```tsx
import { FreshAgentOpenSessionContext } from './FreshAgentItemCard'
import { openSessionTab } from '@/store/tabsSlice'

  const openDelegationSession = useCallback((sessionId: string, title?: string) => {
    dispatch(openSessionTab({
      sessionId,
      title: title ?? sessionId,
      cwd: paneCwd,
      provider: 'opencode',
      sessionType: 'freshopencode',
      isSubagent: true,
    }))
  }, [dispatch, paneCwd])
```

and wrap the transcript render (line ~2929):

```tsx
<FreshAgentOpenSessionContext.Provider value={openDelegationSession}>
  <FreshAgentTranscript /* existing props */ />
</FreshAgentOpenSessionContext.Provider>
```

(`paneCwd` — use the pane's existing cwd source in the view; if the pane content carries `cwd`, read it from there; if absent, pass `undefined` and let the thunk resolve the session's own cwd, matching how the sidebar opens sessions whose cwd is unknown.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentView.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

None expected — a single provider wrap. If the view file has an existing context provider region, colocate it there.

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent test/unit/client/tab-registry-fresh-agent-migration.test.ts --config config/vitest/vitest.config.ts && npm run typecheck:client`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentView.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "feat(client): open-session link on opencode task delegation blocks"
```

---

### Task 7: E2E — freshopencode inline parity spec against the fake opencode sidecar

**Files:**
- Modify: `test/e2e-browser/fixtures/fake-opencode.cjs` (extend the fake serve's data + SSE)
- Create: `test/e2e-browser/specs/freshopencode-tui-parity.spec.ts`
- Test: the spec itself.

**Interfaces:**
- Consumes: the existing e2e harness (`TestHarness`, `RustServer`, `installFakeOpencode`, openPanePicker — see `freshopencode-db-history.spec.ts` for the setup pattern), the fake serve's existing `/session/:id`, `/session/:id/message`, `/global/event` SSE implementation, and the wire shapes documented in `.worktrees/.the-usual-logs/freshopencode-tui-parity/reports/plan-exploration.md` §6.
- Produces: end-to-end proof that a freshopencode pane renders the delegation block, nested child rows, thought durations, retry rows, the child session's delegated-task caption, and that the Open-session link opens the child session pane.

- [ ] **Step 1: Write the failing e2e spec (RED — fixture untouched)**

Write ONLY the spec file now; do NOT touch `fake-opencode.cjs` yet (plan-review round 1, Finding 10: the red phase must be reachable, and after Tasks 4–6 the client already renders the new UI — the only missing input is fixture data).

Setup model (plan-review round 2, Finding 15: the pane picker creates a NEW session by working directory — a seeded `ses_p` is never opened that way. Use the established send-materializes pattern from `freshopencode-db-history.spec.ts` instead): install the fake `opencode` binary, create a freshopencode pane via the picker in a temp cwd, then SEND a prompt (`sendFreshAgentPrompt`-style flow). The fake sidecar's scripted prompt flow (added in Step 3) responds by materializing the PARENT session — the pane's own minted `ses_*` id — with the delegation message: its task tool part's `state.metadata.parentSessionId` is the pane's minted session id and `state.metadata.sessionId` is the statically-served child `ses_c`. The child sessions (`ses_c`, and `ses_bg` for the background case) exist as static fixture data served by the fake's `GET /session/:id/message`.

The spec (`test/e2e-browser/specs/freshopencode-tui-parity.spec.ts`) asserts, in order:

1. The pane opens and after the send, the parent transcript folds into a single collapsed activity line (existing `fresh-agent-activity-summary` visible; NO standalone delegation article outside the strip while collapsed).
2. Expanding the strip (`Toggle activity details`) shows: the delegation header `General Task — Fix the flaky harness`, a nested row `↳ Bash sed -n 92,112p src/store/paneTypes.ts` (title-cased tool label), a failed row with `(failed)`, the `Retrying (attempt 2) — stream disconnected` retry row, and the `fresh-agent-delegation-result` body — which the fixture serves as a LONG multi-line result — rendered with a REAL-browser bounded box: `const box = await resultElement.boundingBox(); expect(box!.height).toBeLessThanOrEqual(160)` (the `max-h-24` clamp ≈ 96px + padding; plan-review round 1, Finding 6 makes this assertion protective).
3. The thinking disclosure shows the settled duration label with the extracted title: `Thought: Planning the fix · 3.4s` (the fixture pins the reasoning part's `time` window to exactly 3400 ms and its leading bold block to the title — matching the Task 5 label formula and the TUI's `reasoningSummary` derivation).
4. The BACKGROUND delegation (a second task tool part in the same message, `background: true`, completed outer state, child `ses_bg` still active with a running tool part and no assistant `time.completed`) shows the child-derived LIVE state per plan-review round 2, Finding 12: its block displays the running spinner (`aria-label="running"`) and NO duration — not the outer part's completed check.
5. Clicking `Open session` (on the foreground delegation block) opens a pane on the child session `ses_c`, whose transcript shows the muted caption `Delegated — General · Fix the flaky harness` (title-cased agent) above the child's prompt.
6. Live refresh of the server-side join: the spec triggers the fake sidecar's scripted child event (see Step 3), and the parent pane's expanded delegation block gains the NEW child activity row that the event's state mutation added.

Use role/aria/testid selectors (never CSS classes) per the repo's a11y-first e2e conventions.

- [ ] **Step 2: Run the spec and verify the intended failure**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-tui-parity.spec.ts`

Expected: FAIL for the missing fixture data — the pane renders and the send completes (the fake sidecar answers with its plain scripted response), but no delegation block appears, so the first delegation assertion times out. This is the missing-behavior failure mode, not a harness error: the pane, strip, and testid vocabulary all exist from Tasks 4–6.

- [ ] **Step 3: Land the fixture changes (GREEN)**

Extend `test/e2e-browser/fixtures/fake-opencode.cjs` (following its existing session/message serving and env-driven scripting structure — read it first; keep all existing scripted behaviors intact so sibling specs stay green; gate the new behavior behind a new `FAKE_OPENCODE_*` env var so sibling specs are provably unaffected):

- A scripted prompt flow (enabled by the new env var) that responds to the pane's first send by materializing the PARENT session — the pane's own minted `ses_*` id — with an assistant message containing:
  - a `reasoning` part `{ type:'reasoning', text:'**Planning the fix**\n\nweighing options', time:{ start:<pinned>, end:<pinned+3400> } }` (leading-bold title + pinned 3400 ms window);
  - a FOREGROUND `task` tool part with `state.status:'completed'`, `state.input:{ description:'Fix the flaky harness', subagent_type:'general' }`, `state.metadata:{ parentSessionId:<the pane's minted id>, sessionId:'ses_c', model:{…} }`, `state.output:'<task id="ses_c" state="completed"><task_result>' + <40 lines of sample output> + '</task_result></task>'` (long content → clamp assertion is meaningful; the server unwraps the envelope), `state.time:{…}`;
  - a BACKGROUND `task` tool part with `state.status:'completed'` (opencode completes the outer part immediately for background launches), `state.input:{ description:'Index the repository', subagent_type:'general' }`, `state.metadata:{ background:true, sessionId:'ses_bg' }` — its child `ses_bg` stays ACTIVE;
  - a `retry` part `{ type:'retry', attempt:2, error:{ name:'APIError', data:{ message:'stream disconnected' } } }` (authoritative serialized shape).
- Child session `ses_c` served statically by `GET /session/ses_c/message`: a user message with a `subtask` part (`{ type:'subtask', agent:'general', description:'Fix the flaky harness' }`) and an assistant message with `bash` tool parts — one `completed` (`sed -n 92,112p src/store/paneTypes.ts`) and one `error` (grep `reasoningEffort`);
- Child session `ses_bg` served statically: a user message and an assistant message WITHOUT `info.time.completed` carrying a `bash` tool part with `state.status:'running'` (so the join's background derivation shows the live spinner — plan-review round 2, Finding 12);
- A scripted SSE trigger on `/global/event` for the child that BOTH emits a `message.updated` event carrying `ses_c`'s id AND mutates the fake's served child message state by appending a third `bash` tool part (e.g. `echo live-join-refresh`) — plan-review round 1, Finding 9: the parent watcher responds to the event by triggering a refetch of `/session/:id/message`, so only a fixture whose REST-visible state grows alongside the event makes the "new row appears" assertion pass and prove the live join refresh. If the fake's SSE emitter does not support scripted child-session events yet, add the minimal injection the existing fake uses for `session.idle` scripting.

- [ ] **Step 4: Run the focused spec**

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-tui-parity.spec.ts`

Expected: PASS (all five assertion groups).

- [ ] **Step 5: Refactor while green**

Extract shared fixture constants (the parent/child payloads) into named constants in the spec file; keep `fake-opencode.cjs` additions scoped to new sessions/behind the spec's own setup so other specs are unaffected.

- [ ] **Step 6: Run impacted-test verification**

The fake-opencode fixture changes can affect every spec that installs it. Run all freshopencode/fake-opencode-dependent specs plus the fresh-agent suite locally:

Run: `npm run test:e2e:chromium -- test/e2e-browser/specs/freshopencode-db-history.spec.ts test/e2e-browser/specs/freshopencode-model-picker.spec.ts test/e2e-browser/specs/freshopencode-restart-recovery.spec.ts test/e2e-browser/specs/opencode-terminal-restore-rust.spec.ts test/e2e-browser/specs/opencode-replay-write-progression.spec.ts test/e2e-browser/specs/sidebar-opencode-rail.spec.ts test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts test/e2e-browser/specs/freshopencode-tui-parity.spec.ts`

Expected: PASS. Confirm the new spec is NOT in `CLOUD_SKIP_SPECS` (test/e2e-browser/playwright.cloud.config.ts) so it also covers the cloud backend when configured.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/fixtures/fake-opencode.cjs test/e2e-browser/specs/freshopencode-tui-parity.spec.ts
git commit -m "test(e2e): freshopencode inline delegation/duration/retry parity spec"
```

---

## Verification summary (whole plan)

- Unit: contract (Task 1), Rust normalizer + join (Tasks 2–3), client cards (Task 4), strip folding + durations (Task 5), link wiring (Task 6).
- E2E: one new browser spec proving the user-visible result end to end against the fake sidecar (Task 7), with all sibling fake-opencode specs kept green.
- The stage gate (coordinated full suite) runs per the executing stage's own procedure — not as a plan task.
- docs/index.html: no update — the change is an in-pane rendering refinement, not a new top-level experience (repo rule: only major changes need the mock updated).
