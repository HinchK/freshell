# Fresh-Agent Summary Provenance Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Re-layer fresh-agent turn summaries in one the-usual run, delivering all of: (1) the Rust server tags every fresh-agent turn summary with a provenance field (`summaryKind: 'echo' | 'authored'`) — echo means the summary is a mechanical projection of the turn's own items, authored means provider-written prose (currently only codex reasoning summaries); (2) Rust-side summary dialects are unified across providers: one truncation policy (140 characters), one tool-result label, and consistent claude fallback chains across producer paths; (3) the shared fresh-agent client consumes the provenance tag instead of reverse-engineering producer recipes — the client echo classifier (`itemEchoes`, `SUMMARY_LABEL_BY_KIND`, segment-matching/tiling logic) and the write-only client-side summarizer path are deleted, the synthetic coalescing join is kept with provenance recomputed as echo only if both sides are echo; (4) foldable captions in the fresh-agent transcript UI: echo captions render between turns until superseded by later activity, then fold into the expanded activity line, authored prose remains a permanent boundary, and stashed captions are visible inside a line's expansion.

### Explicit constraints
- Only the Rust server is in scope; do not change the Node/TypeScript server or its adapters.
- Work happens in the dedicated git worktree; no behavior changes committed directly to main; no PR creation without explicit user approval.
- Never silently fall back from the configured cloud test backends to local.
- Provenance tagging, dialect unification, client classifier deletion, and the foldable-captions feature are all delivered together in this single run.

### Accepted tradeoffs and residuals
- `summaryKind` is an optional schema field; a client talking to a server that does not emit it treats unknown provenance as `authored` (conservative: no folding).
- Echo captions disappear from the live stream with a one-time fold transition when superseded, instead of remaining painted permanently (accepted behavior change vs. the previously shipped model).
- Folding applies to echo captions only; authored prose summaries are never folded.

**Goal:** Fresh-agent turn summaries carry a server-tagged provenance (`echo` vs `authored`) that the client consumes directly — echo captions fold into activity-line expansions when superseded, authored prose stays a permanent boundary — with one Rust-side summary dialect across providers.

**Architecture:** The Rust `freshell-freshagent` crate is the single summary producer: a new `summary.rs` module owns the dialect policy (140-char truncation, `Tool result`/`Tool error` labels, the two provenance constants) and the claude/codex/opencode snapshot builders tag every turn. The shared zod contract gains an optional `summaryKind` field plus a `turnSummaryIsAuthored` helper (missing tag = authored, conservative). The React transcript deletes its echo classifier, painted-summary store, and the write-only client summarizer, and drives line-absorb boundaries, caption folding into activity-strip expansions, and fully-filtered-turn handling purely from the tag.

**Tech Stack:** Rust (freshell-freshagent crate, cargo test/clippy/fmt), TypeScript/React 18 (FreshAgentTranscript, freshAgentSlice), Zod shared contract (`shared/`), Vitest (unit), Playwright (e2e, routed-snapshot freshcodex panes).

## Global Constraints

- **Worktree only.** All work in `/home/dan/code/freshell/.worktrees/freshagent-summary-provenance` on branch `the-usual/freshagent-summary-provenance` (base `233f3ad28c8e641bef85b5b98d15a7f9887b5a6c`, whose full coordinated suite is green per `reports/workspace-baseline.md`). No direct commits to `main`; no PR creation without explicit user approval.
- **Rust server only.** Do not modify `server/` (the Node/TypeScript server) or its adapters. The client under `src/` is shared and in scope; `test/unit/server/rust-claude-snapshot-contract.test.ts` is a Rust-output contract test and stays green via Tasks 1–2.
- **Process safety.** Never restart or stop the production Rust server on port 3001. Scratch servers only via `scripts/launch-rust.sh --port 3499` (or another unique port), stopped via the same script. Never use broad kill patterns.
- **Test backends.** Never silently fall back from a configured cloud test backend to local. Check `printenv FRESHELL_E2E_BACKEND` / `printenv FRESHELL_VITEST_BACKEND` before broad runs; if unset, ask the user before running cloud tests. Commit before any cloud run (a dirty tree is non-addressable and pays a ~13 min cold rebuild). Use repo-owned test paths: `npm run test:vitest -- ...`, `npm test` / `npm run check` for the coordinated suite; check `npm run test:status` before broad runs and set `FRESHELL_TEST_SUMMARY`.
- **Environment setup** (per `reports/workspace-baseline.md`): fresh worktree needs `npm ci` before any npm test command. Rust toolchain 1.96.x; Rust gates are `cargo test --workspace --exclude freshell-tauri`, `cargo fmt --all --check`, `cargo clippy --workspace --all-targets -- -D warnings`.
- **Server/ESM note:** relative imports under `server/` need `.js` extensions (not touched here); `shared/` imports already use `.js` (`shared/fresh-agent-turns.ts` imports `./fresh-agent-contract.js`) — match that style.
- **A11y:** caption rows are non-interactive text (`<div>`, no role/tabIndex); `npm run lint` (eslint-plugin-jsx-a11y) must pass.
- **`summaryKind` is optional everywhere**; a missing tag is treated as `authored` (conservative) by the client.

---

## Planning decisions and deviations

1. **DEVIATION — opencode reasoning excerpts tag `echo`, not `authored`.** The coordination input suggested opencode `reasoning.summary[0]` could tag `authored`. The user request defines authored as "provider-written prose (currently only codex reasoning summaries)", and the producer inventory (`reports/plan-rust-producers.md`) found opencode's `summary[0]` is the adapter's own mechanical projection of the part's full reasoning text (`crates/freshell-freshagent/src/lib.rs:1395-1439`), not provider summary prose. Tagging it `authored` would permanently paint full hidden reasoning in default-config (`showThinking=false`) opencode transcripts — an unrequested regression. **Every opencode summary tags `echo`.** This deviation is called out in the run's final report.
2. **The `freshAgent.assistant` reducer is KEPT; only its summary write dies.** `addAssistantMessage` (`src/store/freshAgentSlice.ts:580-601`) also clears `streamingText`/`streamingActive`, which is live-read through `pane-activity.ts`. The write-only piece is `summarizeFreshAgentItems` (`freshAgentSlice.ts:130-143`) — the summary it computes has no remaining reader once the classifier is gone — so the reducer writes `summary: ''` and the function is deleted. The WS dispatch path (`src/lib/fresh-agent-ws.ts:269-275`) is untouched.
3. **Fully-filtered echo turns are dropped, not stashed.** A hidden-thinking turn (`showThinking=false`) whose summary is an echo disappears when superseded and is NOT stashed into expansions: the user chose to hide that content, and the stashed caption would leak it. Stash sources are only (a) summaries of absorbed turns whose items render, and (b) zero-item echo captions superseded by a later same-role activity line.
4. **E2e lives in the existing `test/e2e-browser/specs/fresh-agent.spec.ts` (default chromium project).** The specs route the snapshot REST response and inject `freshAgent.session.changed` through the test harness — they never need a real Rust server — so no `RUST_ONLY_SPECS`/`testMatch` registration in `test/e2e-browser/playwright.config.ts` is required. `fresh-agent-control-rust.spec.ts` (rust-chromium) runs as impacted surface.
5. **`docs/index.html` and `AGENTS.md` need no change** (Task 6 re-verifies): the docs mock renders a settled activity strip and no streaming echo captions; `AGENTS.md` references none of the deleted machinery. The historical plan `docs/plans/2026-08-23-freshagent-activity-line.md` is not modified.

## File responsibility map

| File | Responsibility | Task |
| --- | --- | --- |
| `shared/fresh-agent-contract.ts` | Turn schema: optional `summaryKind` enum | 1 |
| `shared/fresh-agent-turns.ts` | `turnSummaryIsAuthored` provenance helper | 1 |
| `test/unit/shared/fresh-agent-turns.test.ts` | Schema + helper pins | 1 |
| `test/unit/shared/fresh-agent-contract.test.ts` | Snapshot round-trip carries `summaryKind` | 1 |
| `test/fixtures/fresh-agent/claude/contract-fixtures.ts` | Claude contract turn carries `summaryKind: 'echo'` | 1 |
| `test/fixtures/fresh-agent/codex/contract-fixtures.ts` | Codex contract turn carries `summaryKind: 'echo'` | 1 |
| `crates/freshell-freshagent/src/summary.rs` | NEW: shared dialect policy (truncation, labels, kind constants) | 2 |
| `crates/freshell-freshagent/src/claude_snapshot.rs` | 140-char truncation, shared labels, `summaryKind: "echo"` on every turn | 2 |
| `crates/freshell-freshagent/src/codex.rs` | `summarize_codex_items` returns `(String, kind)`; authored iff codex reasoning `summary[]` | 2 |
| `crates/freshell-freshagent/src/lib.rs` | `mod summary;`; opencode summary tuple + tag | 2 |
| `test/fixtures/fresh-agent/claude-snapshot-golden.json` | Golden snapshot regenerated with `summaryKind` + `Tool result` | 2 |
| `src/components/fresh-agent/FreshAgentTranscript.tsx` | Provenance consumption (3), caption fold (4) | 3–4 |
| `src/store/freshAgentSlice.ts` | Delete write-only summarizer; `summary: ''` | 3 |
| `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx` | Rewritten pins + new fold tests | 3–4 |
| `test/unit/client/lib/fresh-agent-ws.test.ts` | `summary: ''` expectation | 3 |
| `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` | `summary: ''` expectation | 3 |
| `test/e2e-browser/specs/fresh-agent.spec.ts` | `foldable echo captions` describe | 5 |
| `docs/index.html` | Re-assessed; no change (recorded) | 6 |
| `AGENTS.md` | Re-checked; no change (recorded) | 6 |

**Interfaces between tasks**

- Task 1 produces `FreshAgentTurn['summaryKind']?: 'echo' | 'authored'` (zod-optional) and `turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean` (`=== 'echo'` → false; missing/`'authored'` → true).
- Task 2 emits `summaryKind: "echo" | "authored"` on every turn of every Rust snapshot; consumes Task 1's schema (the golden-fixture contract test parses strictly).
- Task 3 consumes Task 1's helper; produces the provenance absorb guard, new `filterTurnsForDisplay` rules, and `appendTurnItems` kind recomputation (`echo` only when both sides are `'echo'`).
- Task 4 consumes Task 3's guard; produces `ActivityRow` caption rows, `buildActivity(items, captions)`, the absorb-stash + pending-caption fold, and `data-testid="fresh-agent-activity-caption"`.
- Task 5 consumes Task 4's UI (the caption testid and fold transitions).

### Task 1: Contract `summaryKind` field + `turnSummaryIsAuthored` helper

**Files:**
- Modify: `shared/fresh-agent-contract.ts:164-175`
- Modify: `shared/fresh-agent-turns.ts`
- Modify: `test/fixtures/fresh-agent/claude/contract-fixtures.ts:3-19`
- Modify: `test/fixtures/fresh-agent/codex/contract-fixtures.ts:3-21`
- Test: `test/unit/shared/fresh-agent-turns.test.ts`
- Test: `test/unit/shared/fresh-agent-contract.test.ts`

**Interfaces:**
- Consumes: existing `FreshAgentTurnSchema` (strict), existing helper module.
- Produces: `FreshAgentTurn['summaryKind']?: 'echo' | 'authored'`; `turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean`.

- [ ] **Step 1: Write the failing behavioral test**

Append to `test/unit/shared/fresh-agent-turns.test.ts` inside the existing `describe('fresh-agent display turn helpers')`, and extend the import from `../../../shared/fresh-agent-turns.js` with `turnSummaryIsAuthored`:

```ts
  it('accepts an optional summaryKind provenance tag on turn schema', () => {
    const base = { id: '1', turnId: 't-1', summary: 'summary', items: [] }
    expect(FreshAgentTurnSchema.parse({ ...base, summaryKind: 'echo' }).summaryKind).toBe('echo')
    expect(FreshAgentTurnSchema.parse({ ...base, summaryKind: 'authored' }).summaryKind).toBe('authored')
    // Graceful absence: a server that does not emit the field still parses.
    expect(FreshAgentTurnSchema.parse(base).summaryKind).toBeUndefined()
    // The enum is closed and the object stays strict.
    expect(() => FreshAgentTurnSchema.parse({ ...base, summaryKind: 'bogus' })).toThrow()
  })

  it('treats only an explicit echo tag as non-authored (missing is conservative)', () => {
    expect(turnSummaryIsAuthored({ summaryKind: 'echo' })).toBe(false)
    expect(turnSummaryIsAuthored({ summaryKind: 'authored' })).toBe(true)
    expect(turnSummaryIsAuthored({})).toBe(true)
  })
```

Add to `test/unit/shared/fresh-agent-contract.test.ts` at the end of the `it('parses Claude and Codex snapshots through one shared durable contract', ...)` body (after the existing assertions, which bind the parsed claude snapshot as `claudeSnapshot`):

```ts
    expect(claudeSnapshot.turns[0].summaryKind).toBe('echo')
    expect(FreshAgentSnapshotSchema.parse(codexContractSnapshot).turns[0].summaryKind).toBe('echo')
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts test/unit/shared/fresh-agent-contract.test.ts`

Expected: FAIL because `FreshAgentTurnSchema` is `.strict()` and rejects the unknown `summaryKind` key, `turnSummaryIsAuthored` does not exist (import/type error), and the contract fixtures carry no `summaryKind` — not because of a syntax or setup accident.

- [ ] **Step 3: Add the minimal production implementation**

In `shared/fresh-agent-contract.ts`, add one field to `FreshAgentTurnSchema` after `summary: z.string(),` (line 173):

```ts
  summary: z.string(),
  // Provenance of `summary`: 'echo' = mechanical projection of the turn's own
  // items (foldable caption); 'authored' = provider-written prose (permanent
  // boundary). Optional: a server that predates the field omits it and the
  // client treats unknown provenance as authored (conservative).
  summaryKind: z.enum(['echo', 'authored']).optional(),
```

In `shared/fresh-agent-turns.ts`, append:

```ts
/**
 * A turn summary is "authored" — provider-written prose that must remain a
 * permanent transcript boundary — unless the server explicitly tagged it as an
 * 'echo' of the turn's own items. A missing tag is conservative (authored):
 * no absorb, no folding.
 */
export function turnSummaryIsAuthored(turn: Pick<FreshAgentTurn, 'summaryKind'>): boolean {
  return turn.summaryKind !== 'echo'
}
```

In `test/fixtures/fresh-agent/claude/contract-fixtures.ts`, add `summaryKind: 'echo',` after `summary: 'Workspace is clean.',` (line 12). In `test/fixtures/fresh-agent/codex/contract-fixtures.ts`, add `summaryKind: 'echo',` after `summary: 'Codex finished a review pass',` (line 10). (Both fixtures model mechanical projections: claude summarizes from the first text item; codex from the first item's kind-specific text.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/shared/fresh-agent-turns.test.ts test/unit/shared/fresh-agent-contract.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: one schema field, one two-line helper, two fixture keys. The helper is deliberately placed beside `getFreshAgentDisplayTurnKey` so all turn-display semantics live in one shared module.

- [ ] **Step 6: Run impacted-test verification**

The schema is shared by every fresh-agent surface; the fixtures feed the contract test, `test/fixtures/fresh-agent/contract-traceability.ts`, and the fetch-mock tests in `test/unit/client/lib/api.test.ts` (the additive optional key must not break them). Impacted set: all shared-contract consumers plus the strict-schema Rust golden-fixture contract test, plus typecheck (the new optional field must not break existing turn construction).

Run: `npm run test:vitest -- run test/unit/shared/ test/unit/server/rust-claude-snapshot-contract.test.ts test/unit/client/lib/api.test.ts && npm run typecheck`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add shared/fresh-agent-contract.ts shared/fresh-agent-turns.ts test/unit/shared/fresh-agent-turns.test.ts test/unit/shared/fresh-agent-contract.test.ts test/fixtures/fresh-agent/claude/contract-fixtures.ts test/fixtures/fresh-agent/codex/contract-fixtures.ts
git commit -m "feat(freshagent): add optional summaryKind provenance to turn contract"
```

### Task 2: Rust provenance tagging + summary dialect unification

**Files:**
- Create: `crates/freshell-freshagent/src/summary.rs`
- Modify: `crates/freshell-freshagent/src/lib.rs` (mod decl between `spawn_gate` and `target_resolver`, ~line 52; `opencode_turn_summary` :1395-1439; `build_opencode_turn_json` :1491)
- Modify: `crates/freshell-freshagent/src/claude_snapshot.rs` (`summarize` :515-550; turn insert :495)
- Modify: `crates/freshell-freshagent/src/codex.rs` (`summarize_codex_items` :3485-3567; turn json :3793-3801)
- Modify: `test/fixtures/fresh-agent/claude-snapshot-golden.json`
- Test: in-module `#[cfg(test)]` suites of the three modified Rust files

**Interfaces:**
- Consumes: Task 1's `summaryKind` schema field (the strict-schema contract test parses the golden fixture).
- Produces: every Rust-emitted turn carries `summaryKind: "echo" | "authored"`; the shared policy constants `SUMMARY_MAX_CHARS` (140), `TOOL_RESULT_LABEL` (`"Tool result"`), `TOOL_ERROR_LABEL` (`"Tool error"`), `SUMMARY_KIND_ECHO`, `SUMMARY_KIND_AUTHORED`, and `truncate_summary`.

- [ ] **Step 1: Write the failing behavioral test**

Add to the `#[cfg(test)]` module of `crates/freshell-freshagent/src/claude_snapshot.rs`:

```rust
#[test]
fn claude_turns_tag_every_summary_echo() {
    let built = build_claude_snapshot_json("freshclaude", "t", SAMPLE_TRANSCRIPT, 0);
    let turns = built["turns"].as_array().unwrap();
    assert_eq!(turns.len(), 6);
    for turn in turns {
        assert_eq!(turn["summaryKind"], json!("echo"), "turn {:?}", turn["turnId"]);
    }
}

#[test]
fn summarize_unifies_truncation_and_tool_result_labels() {
    let long_text = "x".repeat(200);
    let items = vec![json!({ "kind": "text", "text": long_text })];
    assert_eq!(summarize(&items).chars().count(), 140);

    let ok = vec![json!({ "kind": "tool_result", "content": "out", "isError": false })];
    assert_eq!(summarize(&ok), "Tool result");
    let err = vec![json!({ "kind": "tool_result", "content": "boom", "isError": true })];
    assert_eq!(summarize(&err), "Tool error");
}
```

Add to `crates/freshell-freshagent/src/codex.rs` tests (and update the existing `summarize_codex_items_uses_first_items_kind_specific_text_not_a_join` at :9837 to the tuple shape):

```rust
#[test]
fn summarize_codex_items_uses_first_items_kind_specific_text_not_a_join() {
    let items = vec![
        json!({ "id": "a", "kind": "reasoning", "summary": ["thinking hard"], "content": [], "text": "thinking hard" }),
        json!({ "id": "b", "kind": "command", "command": "ls", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
    ];
    // A reasoning item WITH a provider summary array is the only authored case.
    assert_eq!(
        summarize_codex_items(&items),
        ("thinking hard".to_string(), SUMMARY_KIND_AUTHORED)
    );
}

#[test]
fn summarize_codex_items_tags_reasoning_without_a_provider_summary_echo() {
    let items = vec![
        json!({ "id": "a", "kind": "reasoning", "summary": [], "content": ["raw chain"], "text": "raw chain" }),
    ];
    assert_eq!(
        summarize_codex_items(&items),
        ("raw chain".to_string(), SUMMARY_KIND_ECHO)
    );
}

#[test]
fn summarize_codex_items_tags_tool_previews_echo() {
    let items = vec![
        json!({ "id": "c", "kind": "command", "command": "cat a.txt", "status": "completed", "output": null, "exitCode": null, "extensions": {} }),
    ];
    assert_eq!(
        summarize_codex_items(&items),
        ("cat a.txt".to_string(), SUMMARY_KIND_ECHO)
    );
}
```

Also add to the existing `get_snapshot_renders_tool_reasoning_and_file_change_items_end_to_end` (:9846), after the summary assertion at :9911:

```rust
        assert_eq!(turns[0]["summaryKind"], json!("authored"));
        assert_eq!(turns[1]["summaryKind"], json!("echo"));
```

and to `get_snapshot_returns_a_schema_shaped_snapshot_with_turn_text` (:9389), next to its turn assertions:

```rust
        assert_eq!(snapshot["turns"][0]["summaryKind"], json!("echo"));
```

Add to `crates/freshell-freshagent/src/lib.rs` tests:

```rust
#[test]
fn opencode_turn_summary_truncates_the_text_join_and_tags_echo() {
    let long = "y".repeat(200);
    let items = vec![
        json!({ "id": "p-0", "kind": "text", "text": long }),
    ];
    let (summary, kind) = opencode_turn_summary(&items);
    assert_eq!(summary.chars().count(), 140);
    assert_eq!(kind, SUMMARY_KIND_ECHO);

    // The reasoning fallback is the adapter's own projection of full reasoning
    // text — echo, NOT authored (see the plan's deviation note).
    let reasoning_only = vec![
        json!({ "id": "p-1", "kind": "reasoning", "summary": ["full reasoning text"], "content": [], "text": "full reasoning text" }),
    ];
    assert_eq!(
        opencode_turn_summary(&reasoning_only),
        ("full reasoning text".to_string(), SUMMARY_KIND_ECHO)
    );
}
```

Also add `assert_eq!(turns[1]["summaryKind"], json!("echo"));` beside the summary assertion at lib.rs:3355, and `assert_eq!(turn["summaryKind"], json!("echo"));` beside :3846.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent`

Expected: FAIL because no turn carries a `summaryKind` key, `summarize` still caps at 120 and emits the `'[tool result]'` dialect, and `summarize_codex_items`/`opencode_turn_summary` return `String` rather than the `(String, &'static str)` tuple (a compile error in the new tests counts as the intended red: the missing behavior is the tuple+tag). Not a syntax/setup accident.

- [ ] **Step 3: Add the minimal production implementation**

Create `crates/freshell-freshagent/src/summary.rs`:

```rust
//! Shared fresh-agent turn-summary dialect policy. Every provider adapter's
//! snapshot builder produces a per-turn `summary` plus a `summaryKind`
//! provenance tag:
//!
//! - [`SUMMARY_KIND_ECHO`] — the summary is a mechanical projection of the
//!   turn's own items (a tool name, a command line, a text excerpt, a
//!   tool-result label). It carries no content beyond what the items render,
//!   so the client may treat it as a foldable caption.
//! - [`SUMMARY_KIND_AUTHORED`] — provider-written summary prose with no item
//!   counterpart (today: ONLY codex `reasoning` items with a non-empty
//!   provider `summary` array). The client treats it as a permanent
//!   transcript boundary and never folds it.
//!
//! One truncation policy (140 chars) and one tool-result label set apply to
//! every producer. 140 matches the reference TS codex normalizer's
//! `.slice(0, 140)`; char-based (not UTF-16 code-unit) is the documented,
//! acceptable divergence for non-BMP text.

/// Character cap for every fresh-agent turn summary, all providers.
pub(crate) const SUMMARY_MAX_CHARS: usize = 140;

/// Char-safe truncation to [`SUMMARY_MAX_CHARS`].
pub(crate) fn truncate_summary(text: &str) -> String {
    text.chars().take(SUMMARY_MAX_CHARS).collect()
}

/// The single tool-result summary label (unifies codex's `"Tool result"` and
/// claude's `"[tool result]"` dialects).
pub(crate) const TOOL_RESULT_LABEL: &str = "Tool result";

/// Error variant of [`TOOL_RESULT_LABEL`].
pub(crate) const TOOL_ERROR_LABEL: &str = "Tool error";

/// `summaryKind` value for mechanical projections of the turn's own items.
pub(crate) const SUMMARY_KIND_ECHO: &str = "echo";

/// `summaryKind` value for provider-written summary prose.
pub(crate) const SUMMARY_KIND_AUTHORED: &str = "authored";
```

In `crates/freshell-freshagent/src/lib.rs`, declare the module between `pub mod spawn_gate;` (:52) and `pub mod target_resolver;` (:53):

```rust
pub mod spawn_gate;
pub(crate) mod summary;
pub mod target_resolver;
```

and add `use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO};` to lib.rs's own `use` block (the opencode functions reference both).

In `crates/freshell-freshagent/src/claude_snapshot.rs`: import the policy (`use crate::summary::{truncate_summary, SUMMARY_KIND_ECHO, TOOL_ERROR_LABEL, TOOL_RESULT_LABEL};` with the existing crate imports), replace `summarize` (:515-550) with:

```rust
/// Turn summary: first non-empty `text` item's text, falling back to the first
/// non-empty `thinking` item's text (char-safe truncate to the shared
/// [`SUMMARY_MAX_CHARS`] policy), else a tool label -- `FreshAgentTurnSchema.summary`
/// is REQUIRED. Text is preferred over thinking so an assistant turn's summary
/// is its visible answer, not its reasoning preamble (golden fixture turn 1:
/// items `[thinking "pondering", text "first answer"]` must summarize to
/// `"first answer"`). Every claude summary is a mechanical projection of the
/// turn's own items, so every claude turn tags `summaryKind: "echo"`.
fn summarize(items: &[Value]) -> String {
    let first_text_of = |kind: &str| -> Option<String> {
        items.iter().find_map(|item| {
            if item.get("kind").and_then(Value::as_str) != Some(kind) {
                return None;
            }
            let trimmed = item.get("text").and_then(Value::as_str)?.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(truncate_summary(trimmed))
            }
        })
    };
    if let Some(summary) = first_text_of("text").or_else(|| first_text_of("thinking")) {
        return summary;
    }
    for item in items {
        match item.get("kind").and_then(Value::as_str) {
            Some("tool_use") => {
                if let Some(name) = item.get("name").and_then(Value::as_str) {
                    return name.to_string();
                }
            }
            Some("tool_result") => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                return if is_error { TOOL_ERROR_LABEL } else { TOOL_RESULT_LABEL }.to_string();
            }
            _ => {}
        }
    }
    "[claude turn]".to_string()
}
```

and tag the turn at the insert site (:495):

```rust
        turn.insert("summary".into(), json!(summary));
        turn.insert("summaryKind".into(), json!(SUMMARY_KIND_ECHO));
        turn.insert("items".into(), json!(items));
```

In `crates/freshell-freshagent/src/codex.rs`: import the policy, then replace `summarize_codex_items` (:3485-3567) with the tuple-returning version — every arm identical except `truncate140` → `truncate_summary`, the reasoning arm gains the authored check, and returns gain the kind:

```rust
/// `summarizeFreshAgentItems(items)` (`normalize.ts:168-207`): the turn's `summary` string is
/// the FIRST item's kind-specific preview text (NOT a concatenation of every item) -- e.g. a
/// turn with a `reasoning` item followed by a `command` item summarizes from the reasoning
/// alone. Truncation is the shared 140-char policy (`crate::summary`).
///
/// Provenance: the summary is AUTHORED only when it comes from a `reasoning`
/// item's non-empty provider `summary` array (codex is the one provider that
/// ships provider-written summary prose). Everything else — including a
/// reasoning item reduced to its raw `content` text — is a mechanical
/// projection and tags ECHO.
fn summarize_codex_items(items: &[Value]) -> (String, &'static str) {
    for item in items {
        let kind = item.get("kind").and_then(Value::as_str).unwrap_or("");
        let text = match kind {
            "text" | "thinking" => item.get("text").and_then(Value::as_str).map(truncate_summary),
            "reasoning" => {
                let provider_summary = item
                    .get("summary")
                    .and_then(Value::as_array)
                    .map(|arr| {
                        arr.iter()
                            .filter_map(Value::as_str)
                            .collect::<Vec<_>>()
                            .join("\n")
                    })
                    .filter(|joined| !joined.is_empty());
                if let Some(summary) = provider_summary {
                    return (truncate_summary(&summary), SUMMARY_KIND_AUTHORED);
                }
                let direct = item
                    .get("text")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty());
                let text = direct.map(str::to_string).unwrap_or_else(|| {
                    item.get("content")
                        .and_then(Value::as_array)
                        .map(|arr| {
                            arr.iter()
                                .filter_map(Value::as_str)
                                .collect::<Vec<_>>()
                                .join("\n")
                        })
                        .unwrap_or_default()
                });
                Some(truncate_summary(&text))
            }
            "command" => item.get("command").and_then(Value::as_str).map(truncate_summary),
            "file_change" => Some("File change".to_string()),
            "mcp_tool" => {
                let server = item.get("server").and_then(Value::as_str).unwrap_or("");
                let tool = item.get("tool").and_then(Value::as_str).unwrap_or("");
                Some(truncate_summary(&format!("{server}:{tool}")))
            }
            "dynamic_tool" | "collab_agent" => {
                item.get("tool").and_then(Value::as_str).map(truncate_summary)
            }
            "web_search" => item.get("query").and_then(Value::as_str).map(truncate_summary),
            "image_view" => item.get("path").and_then(Value::as_str).map(truncate_summary),
            "image_generation" => item.get("result").and_then(Value::as_str).map(truncate_summary),
            "review_mode" => {
                let event = item.get("event").and_then(Value::as_str).unwrap_or("");
                Some(truncate_summary(&format!("{event} review mode")))
            }
            "context_compaction" => Some("Context compacted".to_string()),
            "tool_use" => item.get("name").and_then(Value::as_str).map(truncate_summary),
            "tool_result" => {
                let is_error = item
                    .get("isError")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                Some(if is_error {
                    TOOL_ERROR_LABEL.to_string()
                } else {
                    TOOL_RESULT_LABEL.to_string()
                })
            }
            _ => None,
        };
        if let Some(text) = text {
            return (text, SUMMARY_KIND_ECHO);
        }
    }
    (String::new(), SUMMARY_KIND_ECHO)
}
```

and the turn builder (:3793-3801):

```rust
            let (summary, summary_kind) = summarize_codex_items(&row.items);
            json!({
                "id": row_turn_id,
                "turnId": row_turn_id,
                "ordinal": ordinal,
                "source": "durable",
                "role": row.role,
                "summary": summary,
                "summaryKind": summary_kind,
                "items": row.items,
            })
```

In `crates/freshell-freshagent/src/lib.rs`, change `opencode_turn_summary` (:1395-1439) to return `(String, &'static str)`. Keep the `text_items` collection (:1396-1404) and the source-id grouping loop (:1405-1429) byte-for-byte; only the two return sites change — the text-join return becomes `return (truncate_summary(&groups.join("\n\n")), SUMMARY_KIND_ECHO);` and the reasoning fallback becomes:

```rust
    let reasoning_excerpt = items
        .iter()
        .find(|item| item.get("kind").and_then(Value::as_str) == Some("reasoning"))
        .and_then(|item| item.get("summary").and_then(Value::as_array))
        .and_then(|arr| arr.first())
        .and_then(Value::as_str)
        .unwrap_or("");
    (truncate_summary(reasoning_excerpt), SUMMARY_KIND_ECHO)
}
```

Tag the turn in `build_opencode_turn_json` (:1491):

```rust
    let (summary, summary_kind) = opencode_turn_summary(&items);
    turn.insert("summary".to_string(), json!(summary));
    turn.insert("summaryKind".to_string(), json!(summary_kind));
    turn.insert("items".to_string(), json!(items));
```

Finally regenerate `test/fixtures/fresh-agent/claude-snapshot-golden.json` to the new builder output — every turn gains `"summaryKind": "echo"` and turn 5's summary becomes the unified label (complete file):

```json
{
  "sessionType": "freshclaude",
  "provider": "claude",
  "threadId": "44444444-4444-4444-8444-444444444444",
  "sessionId": "44444444-4444-4444-8444-444444444444",
  "revision": 1753437600000,
  "latestTurnId": "44444444-4444-4444-8444-444444444444:5",
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
      "summaryKind": "echo",
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
      "summaryKind": "echo",
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
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:2-i0", "kind": "text", "text": "plain string question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:3",
      "turnId": "44444444-4444-4444-8444-444444444444:3",
      "ordinal": 3,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:02.500Z",
      "summary": "cli string content question",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:3-i0", "kind": "text", "text": "cli string content question" }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:4",
      "turnId": "44444444-4444-4444-8444-444444444444:4",
      "ordinal": 4,
      "source": "durable",
      "role": "assistant",
      "timestamp": "2026-07-25T10:00:03.000Z",
      "summary": "bash",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:4-i0", "kind": "tool_use", "toolUseId": "toolu_01", "name": "bash", "input": { "command": "ls" } }
      ]
    },
    {
      "id": "44444444-4444-4444-8444-444444444444:5",
      "turnId": "44444444-4444-4444-8444-444444444444:5",
      "ordinal": 5,
      "source": "durable",
      "role": "user",
      "timestamp": "2026-07-25T10:00:04.000Z",
      "summary": "Tool result",
      "summaryKind": "echo",
      "items": [
        { "id": "44444444-4444-4444-8444-444444444444:5-i0", "kind": "tool_result", "toolUseId": "toolu_01", "content": "file-a\nfile-b", "isError": false }
      ]
    }
  ],
  "extensions": {}
}
```

(Note the sequencing truthfully in the commit: the golden-fixture test goes red the moment the builder tags turns, and returns to green when the fixture lands — both inside this task.)

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Delete the now-dead inner `truncate140` helper in `codex.rs` (fully replaced by `truncate_summary`); verify `cargo fmt --all --check` and `cargo clippy --workspace --all-targets -- -D warnings` are clean (unused-import and dead-code lints included).

- [ ] **Step 6: Run impacted-test verification**

The turn JSON shape is a shared contract crossing into the freshell-server routes and the TS strict-schema test. Impacted set: the whole Rust workspace suite (the contract type is workspace-shared) plus the TS contract tests that parse the golden fixture and the shared schema.

Run: `cargo test --workspace --exclude freshell-tauri && npm run test:vitest -- run test/unit/server/rust-claude-snapshot-contract.test.ts test/unit/shared/`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/summary.rs crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/claude_snapshot.rs crates/freshell-freshagent/src/codex.rs test/fixtures/fresh-agent/claude-snapshot-golden.json
git commit -m "feat(freshagent): tag rust snapshot summaries with echo/authored provenance, unify dialect"
```

### Task 3: Client consumes provenance; classifier, painted store, and write-only summarizer deleted

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (delete :223-311 classifier block, :456-465 `DisplayTurn`, :467-501 painted store, :903-906 ref, :923-935 recording effect, :1067-1069 placeholder branch; rewrite `filterTurnsForDisplay` :503-525, `appendTurnItems` :412-421, absorb guard :343-359; `buildTranscriptLayout` signature drops the painted param)
- Modify: `src/store/freshAgentSlice.ts` (delete `summarizeFreshAgentItems` :130-143; `summary: summarizeFreshAgentItems(items)` → `summary: ''` at :595)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
- Test: `test/unit/client/lib/fresh-agent-ws.test.ts:462-466`
- Test: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:1215-1219`

**Interfaces:**
- Consumes: `turnSummaryIsAuthored` and `FreshAgentTurn['summaryKind']` (Task 1).
- Produces: the absorb guard (`absorb iff open.originIndex === turnIndex || turn.summary.trim() === '' || !turnSummaryIsAuthored(turn)`), the new `filterTurnsForDisplay` rules, and `appendTurnItems` kind recomputation that Task 4 builds the fold on.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`:

(a) NEW test, anywhere in `describe('activity line collapse')`:

```tsx
    it('treats an explicit authored summary as a boundary even when its text echoes an item', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            { id: 'turn-a', turnId: 'turn-a', role: 'assistant', summary: '',
              items: [{ id: 'tool-c1', kind: 'tool_use', toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }] },
            { id: 'turn-c', turnId: 'turn-c', role: 'assistant', summary: 'Read', summaryKind: 'authored',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })
```

(b) NEW coalescing-provenance tests (they REPLACE the classifier-era `'merges a follower whose coalesced summary carries the Rust claude [tool result] label'` at :1802 — delete that test):

```tsx
    it('keeps a coalesced synthetic tool-result turn echo when both sides are echo', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-x', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
            { id: 'turn-r', turnId: 'turn-r', role: 'user', summary: 'Tool result', summaryKind: 'echo',
              items: [{ id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false }] },
          ]}
        />,
      )
      // turn-r coalesces into turn-b (echo + echo stays echo), which absorbs
      // into turn-x's line.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.getByRole('region', { name: 'Activity strip' })).toHaveTextContent('2 tools used')
    })

    it('tags a coalesced synthetic tool-result turn authored when either side is authored', () => {
      render(
        <FreshAgentTranscript
          isStreaming
          turns={[
            toolTurn('turn-x', [['c1', 'src/a.ts']]),
            { id: 'turn-b', turnId: 'turn-b', role: 'assistant', summary: 'Read', summaryKind: 'echo',
              items: [{ id: 'tool-c2', kind: 'tool_use', toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }] },
            { id: 'turn-r', turnId: 'turn-r', role: 'user', summary: 'Tool result', summaryKind: 'authored',
              items: [{ id: 'result-c2', kind: 'tool_result', toolUseId: 'c2', content: 'file body', isError: false }] },
          ]}
        />,
      )
      // echo + authored -> authored: the coalesced turn is a boundary and
      // keeps its own line.
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
    })
```

(c) REWRITE `'pins the hidden-thinking cadence: ...'` (:1859) — the fold model drops the superseded echo caption instead of leaving an invisible permanent boundary:

```tsx
    it('drops a superseded hidden-thinking echo caption instead of holding a permanent boundary', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const thinkingTurn = {
        id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
        summary: 'Considering options', summaryKind: 'echo' as const,
        items: [{ id: 'think-1', kind: 'thinking' as const, text: 'Considering options' }],
      }
      // Frame 1 (showThinking=false, the production default): the thinking-only
      // streaming tail paints its echo caption.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn]} />,
      )
      expect(screen.getByText('Considering options')).toBeInTheDocument()

      // Frame 2: the next tool arrives in a NEW turn. The echo caption is
      // superseded: it disappears from the stream and the tool runs merge —
      // no permanent boundary, and the hidden thinking text is NOT stashed
      // into the expansion (the user chose to hide it).
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
    })
```

(d) REWRITE `'keeps the hidden-thinking boundary after the session goes idle'` (:1888) — same scenario as (c), then a third frame with `isStreaming={false}` (same turns) STILL expects one strip and no caption:

```tsx
    it('keeps the fold after the session goes idle (isStreaming flips false)', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const thinkingTurn = {
        id: 'turn-thinking', turnId: 'turn-thinking', role: 'assistant' as const,
        summary: 'Considering options', summaryKind: 'echo' as const,
        items: [{ id: 'think-1', kind: 'thinking' as const, text: 'Considering options' }],
      }
      const turnB = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const, summary: 'Read', summaryKind: 'echo' as const,
        items: [{ id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } }],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn]} />,
      )
      expect(screen.getByText('Considering options')).toBeInTheDocument()
      rerender(<FreshAgentTranscript isStreaming showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
      // The session completes (FreshAgentView passes isStreaming=isBusy). The
      // fold is a layout function of the turn list, not of paint history, so
      // the idle flip changes nothing.
      rerender(<FreshAgentTranscript isStreaming={false} showThinking={false} turns={[turnA, thinkingTurn, turnB]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
    })
```

(e) REWRITE `'keeps a painted summary boundary when the same turn later gains items that echo it'` (:1979) — provenance replaces paint history; Task 4 extends this test with expansion-stash assertions:

```tsx
    it('absorbs a painted echo caption when its turn gains items (fold baseline)', () => {
      const turnA = {
        id: 'turn-a', turnId: 'turn-a', role: 'assistant' as const, summary: '',
        items: [{ id: 'tool-c1', kind: 'tool_use' as const, toolUseId: 'c1', name: 'Read', input: { file_path: 'src/a.ts' } }],
      }
      const turnBEmpty = {
        id: 'turn-b', turnId: 'turn-b', role: 'assistant' as const,
        summary: 'Wrapping up shortly', summaryKind: 'echo' as const, items: [],
      }
      // Frame 1: the summary-only streaming tail paints its echo caption.
      const { rerender } = render(
        <FreshAgentTranscript isStreaming showThinking turns={[turnA, turnBEmpty]} />,
      )
      expect(screen.getByText('Wrapping up shortly')).toBeInTheDocument()

      // Frame 2: the same turn gains items; the echo caption is superseded and
      // leaves the stream (Task 4 stashes it into the line's expansion).
      const turnBWithItems = {
        ...turnBEmpty,
        items: [
          { id: 'think-1', kind: 'thinking' as const, text: 'Wrapping up shortly' },
          { id: 'tool-c2', kind: 'tool_use' as const, toolUseId: 'c2', name: 'Read', input: { file_path: 'src/b.ts' } },
        ],
      }
      rerender(<FreshAgentTranscript isStreaming showThinking turns={[turnA, turnBWithItems]} />)
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
      expect(screen.queryByText('Wrapping up shortly')).not.toBeInTheDocument()
    })
```

(f) Tag-only updates: :1759 (`summaryKind: 'echo'` on turn-c), :1774 (`summaryKind: 'authored'` on `turnCEmpty` — assertions unchanged), :1917 (`summaryKind: 'echo'` on the thinking turn — it now drops via the echo rule rather than "never painted"), :1938 and :1961 (`summaryKind: 'echo'` on turn-b), and the `thinkingOnly` helper in the jp70 describe (:1094) gains `summaryKind: 'echo' as const` (keeps `'drops a non-streaming turn when all items are filtered out'` :1223 green under the new filter rules; the streaming-tail siblings are unaffected). Rename :1741 to `'permanently separates tool runs when the follower turn carries an untagged (unknown-provenance) summary'` — fixtures unchanged (untagged = conservative authored), with an updated comment: `// Conservative rule: a server that does not emit summaryKind leaves every non-blank summary authored — no absorb, no folding.`

(g) DELETE the classifier/painted-era pins whose machinery no longer exists: :1822 (`'merges a follower whose live summary space-joins several item echoes'` — the live summarizer is deleted), :1843 (`'merges a codex image-generation follower whose summary echoes its result'` — classifier-specific; generic echo coverage is the :1759 pin plus the server-side tags), :2008 (`'does not let a painted summary mark a different turn that shares its turnId'`), :2042 (`'keeps the painted boundary when a streaming summary grows after painting'`) — the painted-summary store is deleted; folding is deterministic per the turn list, so there is no paint-history identity to confuse.

(h) In `test/unit/client/lib/fresh-agent-ws.test.ts:462-466`, change the expectation to `summary: ''`. In `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx:1215-1219`, change `summary: 'Final answer'` to `summary: ''`.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: FAIL on the intended behaviors: the explicit-authored echo-text pin merges under the old classifier (expects 2 strips, gets 1); the echo+authored coalescing pin merges (expects 2, gets 1); the superseded-caption pins hold the painted placeholder boundary (expect 1 strip/caption gone, get 2 strips); the slice pins still compute a summary (expect `''`). Not syntax/setup accidents. (The tag-only updates in (f) may already pass — they are pins, not reds.)

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

1. Import: `import { getFreshAgentDisplayTurnKey, turnSummaryIsAuthored } from '@shared/fresh-agent-turns'`.
2. DELETE the classifier block (:223-311: the echo/authored comment, `SUMMARY_LABEL_BY_KIND`, `itemEchoes`, `segmentMatchesEchoes`, `summaryIsAuthoredContent`), the `DisplayTurn` type + doc (:440-465), and the painted store (:467-501: comment, `PaintedSummaryStore`, `recordPaintedSummary`, `paintedSummaryMatches`).
3. Replace `filterTurnsForDisplay` with:

```ts
function filterTurnsForDisplay(
  turns: FreshAgentTurn[],
  options: TranscriptDisplayOptions,
  isStreaming: boolean,
): FreshAgentTurn[] {
  return turns
    .map((turn, index): FreshAgentTurn | null => {
      const items = turn.items.filter((item) => shouldDisplayTranscriptItem(item, options))
      if (turn.items.length > 0 && items.length === 0) {
        // The streaming tail keeps painting so the busy caption does not flash
        // out and back while the turn produces only hidden items.
        if (isStreaming && index === turns.length - 1) {
          return { ...turn, items: [] }
        }
        // Blank summary: nothing ever painted — drop the turn outright.
        if (turn.summary.trim().length === 0) return null
        // Authored prose is real content: keep it painted as a summary-only
        // article (a permanent boundary between the surrounding lines).
        if (turnSummaryIsAuthored(turn)) return { ...turn, items: [] }
        // Echo caption of now-hidden items: superseded — drop it. Its content
        // stays hidden, matching the user's showThinking choice.
        return null
      }
      if (items.length === turn.items.length) return turn
      return { ...turn, items }
    })
    .filter((turn): turn is FreshAgentTurn => turn !== null)
}
```

4. `appendTurnItems` recomputes provenance:

```ts
function appendTurnItems(previous: FreshAgentTurn, next: FreshAgentTurn): FreshAgentTurn {
  return {
    ...previous,
    id: `${previous.id}:${next.id}`,
    summary: [previous.summary, next.summary].filter(Boolean).join('\n\n'),
    // Echo only when BOTH sides are echo: an authored segment must never be
    // laundered into a foldable caption, and an untagged side is conservative.
    summaryKind: previous.summaryKind === 'echo' && next.summaryKind === 'echo' ? 'echo' : 'authored',
    items: [...previous.items, ...next.items],
    model: next.model ?? previous.model,
    timestamp: next.timestamp ?? previous.timestamp,
  }
}
```

5. `buildTranscriptLayout(turns: FreshAgentTurn[])` (drop the painted param); the absorb guard becomes:

```ts
        // The boundary guard applies only to absorbing into a PREVIOUS turn's
        // line. Once this turn has opened its own line, its later activity
        // items chain into it normally. A non-blank AUTHORED summary (or an
        // untagged one — conservative) is "something between": it can render,
        // so the runs behind it are permanently separated. Blank and
        // echo-tagged summaries carry no extra rendering and never block a
        // merge.
        if (
          open
          && open.role === turn.role
          && (
            open.originIndex === turnIndex
            || turn.summary.trim().length === 0
            || !turnSummaryIsAuthored(turn)
          )
        ) {
```

6. In the component: delete `paintedSummaryKeysRef` (:903-906), the recording effect (:923-935), and the `turn.filteredPlaceholder` render branch (:1067-1069). The `displayTurns` memo calls `filterTurnsForDisplay(coalesceSyntheticToolResultTurns(turns), displayOptions, isStreaming)`; the layout memo calls `buildTranscriptLayout(displayTurns)`.

In `src/store/freshAgentSlice.ts`: delete `summarizeFreshAgentItems` (:130-143) and write `summary: ''` at :595 (the reducer stays — it still clears `streamingText`/`streamingActive`, which `pane-activity.ts` live-reads).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Confirm no dead references remain: `rg -n "DisplayTurn|echoItems|filteredPlaceholder|paintedSummary|itemEchoes|segmentMatchesEchoes|summaryIsAuthoredContent|SUMMARY_LABEL_BY_KIND|summarizeFreshAgentItems" src/ test/` returns zero hits. `npm run typecheck` and `npm run lint` clean.

- [ ] **Step 6: Run impacted-test verification**

The transcript and slice are consumed by every fresh-agent view (desktop + mobile) and the WS layer. Impacted set: the whole fresh-agent client test surface plus typecheck.

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/lib/ test/unit/client/store/freshAgentSlice.test.ts && npm run typecheck && npm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx src/store/freshAgentSlice.ts test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/lib/fresh-agent-ws.test.ts test/unit/client/components/fresh-agent/FreshAgentView.test.tsx
git commit -m "refactor(freshagent): consume server summaryKind; delete client echo classifier and painted-summary store"
```

### Task 4: Foldable echo captions (stash + expansion rendering)

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (`ActivityRow` :91-93, `buildActivity` :95-157, `buildTranscriptLayout` :313-404, `FreshAgentActivityStrip` expansion :719-723, `selectLiveActivityBlockIdFromLayout` settled branch :582-585, render loop :1062-1092)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

**Interfaces:**
- Consumes: Task 3's provenance absorb guard and `turnSummaryIsAuthored`.
- Produces: `ActivityRow` gains `{ type: 'caption'; id: string; text: string }`; `buildActivity(items, captions?)`; `TurnLayout.captionFolded?: true`; `data-testid="fresh-agent-activity-caption"`.

- [ ] **Step 1: Write the failing behavioral test**

Add a `describe('foldable echo captions')` inside `describe('activity line collapse')` (it reuses the `toolTurn` helper):

```tsx
    it('folds a zero-item echo caption into the next same-role activity line', () => {
      const captionTurn = {
        id: 'turn-cap', turnId: 'turn-cap', role: 'assistant' as const,
        summary: 'Considering options', summaryKind: 'echo' as const, items: [],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), captionTurn]} />,
      )
      expect(screen.getByText('Considering options')).toBeInTheDocument()

      rerender(
        <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), captionTurn, toolTurn('turn-b', [['c2', 'src/b.ts']])]} />,
      )
      // The caption left the stream; the zero-item turn still split the lines.
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
      const strips = screen.getAllByRole('region', { name: 'Activity strip' })
      expect(strips).toHaveLength(2)
      // Stashed into the FOLLOWING line's expansion, before its tool row.
      fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[1])
      const caption = screen.getByTestId('fresh-agent-activity-caption')
      expect(caption).toHaveTextContent('Considering options')
      expect(
        caption.compareDocumentPosition(screen.getByText('src/b.ts')) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      // The first line's expansion does not carry it.
      fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[0])
      expect(screen.getAllByTestId('fresh-agent-activity-caption')).toHaveLength(1)
    })

    it('keeps an echo caption painted until later activity supersedes it', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-cap', turnId: 'turn-cap', role: 'assistant',
              summary: 'Considering options', summaryKind: 'echo', items: [] },
          ]}
        />,
      )
      expect(screen.getByText('Considering options')).toBeInTheDocument()
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(1)
    })

    it('never folds authored prose: it stays painted and keeps the lines separate', () => {
      const proseTurn = {
        id: 'turn-prose', turnId: 'turn-prose', role: 'assistant' as const,
        summary: 'Pausing to plan the next step', summaryKind: 'authored' as const, items: [],
      }
      const { rerender } = render(
        <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), proseTurn]} />,
      )
      expect(screen.getByText('Pausing to plan the next step')).toBeInTheDocument()
      rerender(
        <FreshAgentTranscript isStreaming turns={[toolTurn('turn-a', [['c1', 'src/a.ts']]), proseTurn, toolTurn('turn-b', [['c2', 'src/b.ts']])]} />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.getByText('Pausing to plan the next step')).toBeInTheDocument()
      fireEvent.click(screen.getAllByRole('button', { name: 'Toggle activity details' })[1])
      expect(screen.queryByTestId('fresh-agent-activity-caption')).not.toBeInTheDocument()
    })

    it('does not fold an echo caption across a role-change activity line', () => {
      render(
        <FreshAgentTranscript
          turns={[
            toolTurn('turn-a', [['c1', 'src/a.ts']]),
            { id: 'turn-cap', turnId: 'turn-cap', role: 'assistant',
              summary: 'Considering options', summaryKind: 'echo', items: [] },
            { ...toolTurn('turn-b', [['c2', 'src/b.ts']]), role: 'tool' as const },
          ]}
        />,
      )
      expect(screen.getAllByRole('region', { name: 'Activity strip' })).toHaveLength(2)
      expect(screen.getByText('Considering options')).toBeInTheDocument()
    })
```

And EXTEND the Task-3 `'absorbs a painted echo caption when its turn gains items (fold baseline)'` test — after the two existing frame-2 assertions, add the stash assertions and rename it `'stashes a painted echo caption into the line expansion when its turn gains items and absorbs'`:

```tsx
      // ...existing frame-2 assertions (1 strip, caption gone from stream)...
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      const caption = screen.getByTestId('fresh-agent-activity-caption')
      expect(caption).toHaveTextContent('Wrapping up shortly')
      // The stash lands between the earlier turn's tool row and this turn's rows.
      const toolB = screen.getByText('src/b.ts')
      expect(caption.compareDocumentPosition(toolB) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
```

Also extend `'drops a superseded hidden-thinking echo caption instead of holding a permanent boundary'` with the no-leak assertion at the end:

```tsx
      fireEvent.click(screen.getByRole('button', { name: 'Toggle activity details' }))
      expect(screen.queryByText('Considering options')).not.toBeInTheDocument()
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: FAIL because there is no `fresh-agent-activity-caption` testid, folded captions' articles still render (the zero-item fold test finds 'Considering options' still painted), and absorbed-turn summaries are not stashed — not syntax/setup accidents.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/fresh-agent/FreshAgentTranscript.tsx`:

1. Extend `ActivityRow` and `buildActivity` (captions interleave by ITEM index; stitching/merging keep the first contributing item's index):

```ts
type ActivityRow =
  | { type: 'thinking'; id: string; text: string }
  | { type: 'tool'; tool: FreshAgentToolDisplay }
  | { type: 'caption'; id: string; text: string }

/** One stashed echo caption, positioned by the line's ITEM index it preceded. */
type LineCaption = { id: string; text: string; atItemIndex: number }

function buildActivity(
  items: FreshAgentTranscriptItem[],
  captions: LineCaption[] = [],
): ActivityRow[] {
  const rows: ActivityRow[] = []
  // First item index that produced each row (tool_use/tool_result stitching and
  // thinking merges keep the FIRST contributing item's index) so captions
  // interleave at the position where they painted.
  const rowStartItemIndexes: number[] = []
  const toolIndexById = new Map<string, number>()
  // Providers stream thinking in chunks; consecutive thinking/reasoning items
  // merge into one row instead of stacking N "Thinking:" fragments.
  const pushThinking = (id: string, text: string, itemIndex: number) => {
    if (!text) return
    const last = rows[rows.length - 1]
    if (last?.type === 'thinking') {
      rows[rows.length - 1] = { ...last, text: `${last.text}\n\n${text}` }
      return
    }
    rowStartItemIndexes.push(itemIndex)
    rows.push({ type: 'thinking', id, text })
  }
  for (const [itemIndex, item] of items.entries()) {
    if (item.kind === 'thinking') {
      pushThinking(item.id, stripSystemReminders(item.text), itemIndex)
      continue
    }
    if (item.kind === 'reasoning') {
      pushThinking(item.id, item.summary.length > 0 ? item.summary.join('\n') : (item.text ?? ''), itemIndex)
      continue
    }
    if (item.kind === 'tool_result') {
      const index = toolIndexById.get(item.toolUseId)
      if (index !== undefined) {
        const existing = rows[index] as Extract<ActivityRow, { type: 'tool' }>
        rows[index] = {
          type: 'tool',
          tool: {
            ...existing.tool,
            output: formatJson(item.content),
            isError: item.isError,
            status: 'complete',
          },
        }
      } else {
        toolIndexById.set(item.id, rows.length)
        rowStartItemIndexes.push(itemIndex)
        rows.push({
          type: 'tool',
          tool: {
            id: item.id,
            name: 'Result',
            output: formatJson(item.content),
            isError: item.isError,
            status: 'complete',
          },
        })
      }
      continue
    }
    const tool = itemToToolDisplay(item)
    if (!tool) continue
    const existingIndex = toolIndexById.get(tool.id)
    if (existingIndex !== undefined) {
      rows[existingIndex] = { type: 'tool', tool }
    } else {
      toolIndexById.set(tool.id, rows.length)
      rowStartItemIndexes.push(itemIndex)
      rows.push({ type: 'tool', tool })
    }
  }
  if (captions.length === 0) return rows
  const withCaptions: ActivityRow[] = []
  const ordered = [...captions].sort((a, b) => a.atItemIndex - b.atItemIndex)
  let captionIndex = 0
  for (const [rowIndex, row] of rows.entries()) {
    while (
      captionIndex < ordered.length
      && ordered[captionIndex].atItemIndex <= rowStartItemIndexes[rowIndex]
    ) {
      withCaptions.push({ type: 'caption', id: ordered[captionIndex].id, text: ordered[captionIndex].text })
      captionIndex += 1
    }
    withCaptions.push(row)
  }
  for (; captionIndex < ordered.length; captionIndex++) {
    withCaptions.push({ type: 'caption', id: ordered[captionIndex].id, text: ordered[captionIndex].text })
  }
  return withCaptions
}
```

2. `TurnLayout` gains the fold marker: `type TurnLayout = { blocks: RenderBlock[]; captionFolded?: true }`. Also update the layout doc comment (:216-218) — zero-item turns still hard-close any open line, but an echo-tagged one's summary now folds into the next same-role line's expansion and its article is suppressed.

3. `buildTranscriptLayout` — full replacement (changes vs Task 3: `open` carries `captions`, absorb-time stash, zero-item echo captions queue in `pendingCaptions` and fold into the next same-role line, `captionSeq` ids):

```ts
function buildTranscriptLayout(
  turns: FreshAgentTurn[],
): {
  layouts: TurnLayout[]
  lineEndIndex: Map<number, number>
  tail: { blockId: string; turnIndex: number } | null
} {
  const layouts: TurnLayout[] = []
  let open: {
    originIndex: number
    role: FreshAgentTurn['role']
    items: FreshAgentTranscriptItem[]
    captions: LineCaption[]
  } | null = null
  const lineEndIndex = new Map<number, number>()
  let lineSeq = 0
  let captionSeq = 0
  let lastAbsorbedTurnIndex = -1
  // Echo summaries of zero-item turns, painted as captions and waiting for the
  // next same-role activity line to fold into. Authored/blank zero-item turns,
  // visible message blocks, and role changes clear the queue (those captions
  // stay painted where they are).
  let pendingCaptions: Array<{ turnIndex: number; role: FreshAgentTurn['role']; text: string }> = []

  const flushOpen = () => {
    if (!open) return
    const rows = buildActivity(open.items, open.captions)
    if (rows.length > 0) {
      const id = `line:${lineSeq++}`
      layouts[open.originIndex].blocks.push({ kind: 'activity', id, rows })
    }
    open = null
  }

  for (const [turnIndex, turn] of turns.entries()) {
    const layout: TurnLayout = { blocks: [] }
    layouts.push(layout)
    if (turn.items.length === 0) {
      flushOpen()
      const summary = turn.summary.trim()
      if (summary && !turnSummaryIsAuthored(turn)) {
        // Echo caption: painted now, folded into the next same-role activity
        // line's expansion when one opens (superseded by later activity). The
        // queue is single-role: a role change between caption turns is a
        // boundary, so the older captions stay painted where they are.
        if (pendingCaptions.length > 0 && pendingCaptions[pendingCaptions.length - 1].role !== turn.role) {
          pendingCaptions = []
        }
        pendingCaptions.push({ turnIndex, role: turn.role, text: summary })
      } else {
        pendingCaptions = []
      }
      continue
    }
    for (const item of turn.items) {
      if (isActivityLike(item)) {
        // (Guard comment from Task 3 stands: authored or untagged non-blank
        // summaries are "something between"; blank/echo never block a merge.)
        if (
          open
          && open.role === turn.role
          && (
            open.originIndex === turnIndex
            || turn.summary.trim().length === 0
            || !turnSummaryIsAuthored(turn)
          )
        ) {
          // Absorbing a later turn into an earlier line: a non-blank echo
          // summary would vanish with the turn's article — stash it as a
          // caption row inside the line's expansion instead (once per turn,
          // positioned before the turn's first absorbed item).
          if (
            open.originIndex !== turnIndex
            && lastAbsorbedTurnIndex !== turnIndex
            && turn.summary.trim().length > 0
            && !turnSummaryIsAuthored(turn)
          ) {
            open.captions.push({
              id: `caption:${captionSeq++}`,
              text: turn.summary.trim(),
              atItemIndex: open.items.length,
            })
            lastAbsorbedTurnIndex = turnIndex
          }
          const taken = new Set(open.items.map((openItem) => openItem.id))
          let displayItem = item
          let counter = 2
          while (taken.has(displayItem.id)) {
            displayItem = { ...item, id: `${item.id}:d${counter}` }
            counter += 1
          }
          open.items.push(displayItem as FreshAgentTranscriptItem)
          lineEndIndex.set(open.originIndex, turnIndex)
        } else {
          flushOpen()
          // A same-role line opening supersedes pending echo captions: fold
          // them into this line's expansion (before its first row) and
          // suppress their articles.
          const folded: LineCaption[] = []
          if (pendingCaptions.length > 0 && pendingCaptions[0].role === turn.role) {
            for (const pending of pendingCaptions) {
              folded.push({ id: `caption:${captionSeq++}`, text: pending.text, atItemIndex: 0 })
              layouts[pending.turnIndex].captionFolded = true
            }
          }
          pendingCaptions = []
          open = { originIndex: turnIndex, role: turn.role, items: [item], captions: folded }
        }
        continue
      }
      if (!rendersVisibly(item)) {
        // Invisible content only. Same-role turns merge freely (nothing renders
        // between the lines). A different-role turn still paints its header, so
        // it closes the open line and keeps its (invisible-bodied) block —
        // and any pending captions stay painted in front of it.
        if (open && turn.role !== open.role) {
          flushOpen()
          layout.blocks.push({ kind: 'item', item })
          pendingCaptions = []
        }
        continue
      }
      flushOpen()
      layout.blocks.push({ kind: 'item', item })
      pendingCaptions = []
    }
  }
  flushOpen()

  // tail = last rendered block overall when it is an activity line; null when
  // the transcript visibly ends in a message.
  let tail: { blockId: string; turnIndex: number } | null = null
  for (let i = layouts.length - 1; i >= 0; i--) {
    const blocks = layouts[i].blocks
    if (blocks.length === 0) continue
    const last = blocks[blocks.length - 1]
    if (last.kind === 'activity') tail = { blockId: last.id, turnIndex: i }
    break
  }
  return { layouts, lineEndIndex, tail }
}
```

4. Render caption rows in the strip expansion (replace the `displayRows.map` at :719-723; caption rows are non-interactive text — a11y-clean):

```tsx
          {displayRows.map((row) => {
            if (row.type === 'caption') {
              return (
                <div
                  key={row.id}
                  data-testid="fresh-agent-activity-caption"
                  className="fresh-agent-activity-caption my-0.5 px-2 py-0.5 text-xs italic text-muted-foreground"
                >
                  {row.text}
                </div>
              )
            }
            return row.type === 'thinking'
              ? <FreshAgentThinkingRow key={row.id} text={row.text} />
              : <FreshAgentToolBlock key={row.tool.id} tool={row.tool} initialExpanded={initialExpanded || singleToolExpand} />
          })}
```

5. Liveness: caption rows are not activity — the settled branch judges the last NON-caption row (replace :582-585):

```ts
    const candidate = [...layouts.flatMap((l) => l.blocks)].find((b) => b.kind === 'activity' && b.id === candidateId)
    if (candidate?.kind !== 'activity') return null
    const contentRows = candidate.rows.filter((row) => row.type !== 'caption')
    return contentRows.at(-1)?.type === 'thinking' ? candidate.id : null
```

6. Render loop: suppress the folded caption's article (add next to the absorbed check at :1064-1066; the Task-3-deleted `filteredPlaceholder` branch is already gone):

```tsx
          const absorbed = turn.items.length > 0 && blocksForTurn.length === 0
          if (absorbed) return null
          // Echo caption folded into a following line's expansion: the article
          // is suppressed so the text renders exactly once (inside the strip).
          if (turnLayouts[index]?.captionFolded) return null
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`

Expected: PASS

- [ ] **Step 5: Refactor while green**

Verify `normalizeActivityRows`, `activityTools`, and `settledSummary` need no caption awareness (caption rows pass through untouched and never count as tools/thinking — confirm by reading, not by adding code). `npm run typecheck && npm run lint` clean.

- [ ] **Step 6: Run impacted-test verification**

Same surface as Task 3 (the strip renders in desktop and mobile fresh-agent views).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ && npm run typecheck && npm run lint`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx
git commit -m "feat(freshagent): fold superseded echo captions into activity line expansions"
```

### Task 5: E2E fold-transition coverage

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent.spec.ts` (extract `toolTurn` + the leaf-walk from the `activity line collapse` describe to file scope; add `describe('foldable echo captions')` after :1153)
- Test: `test/e2e-browser/specs/fresh-agent.spec.ts` (the spec IS the test)

**Interfaces:**
- Consumes: Task 4's `data-testid="fresh-agent-activity-caption"` and fold behavior; the existing routed-snapshot seeding pattern (`seedCollapsePane`, :1007-1097) and harness injection (`harness.receiveWsMessage`, wired `test/e2e-browser/helpers/test-harness.ts:120-126` → `ws.receiveMessageForTest` → `handleFreshAgentMessage`; `freshAgent.session.changed` ∈ `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS`, `FreshAgentView.tsx:82-83`, so the pane re-fetches the routed snapshot).
- Produces: e2e proof of the two user-visible fold outcomes. No `RUST_ONLY_SPECS`/`testMatch` registration: the spec stays in the default chromium project because the snapshot is routed (no real Rust server involved).

- [ ] **Step 1: Write the failing behavioral test**

Extract to file scope (after `suppressFreshAgentNetworkForActivePane`, :44): the `toolTurn` helper (moved verbatim from :1099-1113) and the leaf-pointer below; update `seedCollapsePane` to call the leaf-pointer (its :1053-1096 body is replaced by `await pointActiveFreshcodexLeafAtSession(page, sessionId)`), and delete the describe-local `toolTurn`.

```ts
async function pointActiveFreshcodexLeafAtSession(page: any, sessionId: string) {
  await expect.poll(async () => page.evaluate((sid) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const findFreshcodexLeaf = (node: any): any => {
      if (!node) return null
      if (
        node.type === 'leaf'
        && node.content?.kind === 'fresh-agent'
        && node.content.sessionType === 'freshcodex'
      ) {
        return node
      }
      if (node.type === 'split') {
        return findFreshcodexLeaf(node.children?.[0]) ?? findFreshcodexLeaf(node.children?.[1])
      }
      return null
    }
    let tabId: string | null = null
    let leaf: any = null
    for (const [candidateTabId, layout] of Object.entries(state?.panes?.layouts ?? {})) {
      const candidateLeaf = findFreshcodexLeaf(layout)
      if (candidateLeaf) {
        tabId = candidateTabId
        leaf = candidateLeaf
      }
    }
    if (!tabId || !leaf) return false
    harness?.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId: leaf.id,
        content: {
          ...leaf.content,
          sessionId: sid,
          sessionRef: { provider: 'codex', sessionId: sid },
          resumeSessionId: sid,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
    return true
  }, sessionId), { timeout: 10_000 }).toBe(true)
}
```

Append the new describe at the end of the file:

```ts
test.describe('foldable echo captions', () => {
  async function seedFoldablePane(
    page: Parameters<typeof openPanePicker>[0],
    terminal: { waitForTerminal: () => Promise<void> },
    harness: { receiveWsMessage: (message: unknown) => Promise<void> },
    sessionId: string,
    initialTurns: unknown[],
  ) {
    // Same freshcodex picker flow as 'activity line collapse' above, but the
    // routed snapshot body is MUTABLE: pushSnapshot swaps the turn list, bumps
    // the revision, and injects a freshAgent.session.changed frame so the pane
    // re-fetches — the live-stream seam a real sidecar would drive.
    let turns = initialTurns
    let revision = 1
    await terminal.waitForTerminal()
    await enableClaudeAndCodex(page)

    const picker = await openPanePicker(page)
    await suppressFreshAgentNetworkForActivePane(page)
    await picker.getByRole('button', { name: /^Freshcodex$/i }).click({ force: true })
    await page.getByRole('option').first().click()
    await expect(page.locator('[data-context="fresh-agent"]').last()).toBeVisible({ timeout: 10_000 })

    await page.route(`**/api/fresh-agent/threads/freshcodex/codex/${sessionId}*`, async (route) => {
      const lastTurnId = ((turns[turns.length - 1] as { id?: string } | undefined)?.id) ?? ''
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessionType: 'freshcodex',
          provider: 'codex',
          threadId: sessionId,
          sessionId,
          revision,
          latestTurnId: lastTurnId,
          status: 'idle',
          summary: '',
          capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: true },
          settings: { model: 'gpt-5.4-flash', permissionMode: 'on-request', effort: 'high', plugins: [] },
          tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
          pendingApprovals: [],
          pendingQuestions: [],
          worktrees: [],
          diffs: [],
          turns,
        }),
      })
    })
    await pointActiveFreshcodexLeafAtSession(page, sessionId)

    return async function pushSnapshot(nextTurns: unknown[]) {
      turns = nextTurns
      revision += 1
      await harness.receiveWsMessage({
        type: 'freshAgent.event',
        sessionType: 'freshcodex',
        provider: 'codex',
        sessionId,
        event: { type: 'freshAgent.session.changed', sessionId },
      })
    }
  }

  test('an echo caption folds into the next activity line when superseded', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    const echoTurn = {
      id: 'turn-caption', turnId: 'turn-caption', role: 'assistant',
      summary: 'Considering options', summaryKind: 'echo', items: [],
    }
    const pushSnapshot = await seedFoldablePane(page, terminal, harness, 'fold-thread', [
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      echoTurn,
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane.getByText('Considering options')).toBeVisible({ timeout: 10_000 })
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(1)

    await pushSnapshot([
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      echoTurn,
      toolTurn('turn-b', [['c2', 'src/b.ts']]),
    ])
    // Superseded: the caption left the stream and lives only in the new line's
    // expansion; the zero-item turn still split the lines.
    await expect(pane.getByText('Considering options')).toHaveCount(0, { timeout: 10_000 })
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(2)
    await pane.getByRole('button', { name: 'Toggle activity details' }).nth(1).click()
    const caption = pane.getByTestId('fresh-agent-activity-caption')
    await expect(caption).toHaveCount(1)
    await expect(caption).toContainText('Considering options')
  })

  test('authored prose never folds', async ({ freshellPage: _freshellPage, page, harness, terminal }) => {
    const proseTurn = {
      id: 'turn-prose', turnId: 'turn-prose', role: 'assistant',
      summary: 'Pausing to plan the next step', summaryKind: 'authored', items: [],
    }
    const pushSnapshot = await seedFoldablePane(page, terminal, harness, 'fold-authored-thread', [
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      proseTurn,
    ])
    const pane = page.locator('[data-context="fresh-agent"]').last()
    await expect(pane.getByText('Pausing to plan the next step')).toBeVisible({ timeout: 10_000 })

    await pushSnapshot([
      toolTurn('turn-a', [['c1', 'src/a.ts']]),
      proseTurn,
      toolTurn('turn-b', [['c2', 'src/b.ts']]),
    ])
    await expect(pane.getByRole('region', { name: 'Activity strip' })).toHaveCount(2, { timeout: 10_000 })
    await expect(pane.getByText('Pausing to plan the next step')).toBeVisible()
    await pane.getByRole('button', { name: 'Toggle activity details' }).nth(0).click()
    await pane.getByRole('button', { name: 'Toggle activity details' }).nth(1).click()
    await expect(pane.getByTestId('fresh-agent-activity-caption')).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts --grep "foldable echo captions"`

Expected: FAIL because the echo caption never leaves the stream and no `fresh-agent-activity-caption` testid exists (run against the pre-Task-4 client build, or skip this red run if Tasks 3–4 already landed — the red was then observed in Task 4's unit step; state which in the task record).

- [ ] **Step 3: Add the minimal production implementation**

No production code — the implementation is Tasks 1–4; this task adds only the spec. (The helper extraction inside the spec file is the whole change.)

- [ ] **Step 4: Run the focused test**

Run: `npm run test:e2e:local -- --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts --grep "foldable echo captions|activity line collapse"`

Expected: PASS (the grep also re-runs the neighboring collapse specs that share the extracted helpers).

- [ ] **Step 5: Refactor while green**

Confirm the extraction is behavior-preserving: the two collapse specs still pass unchanged (Step 4's grep covers them). No other refactor.

- [ ] **Step 6: Run impacted-test verification**

Impacted e2e surface: the full fresh-agent spec on the default project, plus the Rust-control spec on its own project (it exercises real-server snapshot flow the routed specs bypass). Check `printenv FRESHELL_E2E_BACKEND` first; if unset, ask the user which backend to configure before any cloud run. Commit the task BEFORE any cloud run (dirty trees are non-addressable and cold-rebuild).

Run: `npm run test:e2e:local -- --project=rust-chromium test/e2e-browser/specs/fresh-agent-control-rust.spec.ts && npm run test:e2e -- --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS (the second command uses the configured `FRESHELL_E2E_BACKEND`).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "test(freshagent): e2e coverage for foldable echo captions"
```

### Task 6: Docs reassessment + final full gate

**Files:**
- Modify: none (verification task — the docs decision is recorded here)
- Test: none new

**Interfaces:**
- Consumes: Tasks 1–5.
- Produces: the green full-suite gate the PR needs.

- [ ] **Step 1: Write the failing behavioral test**

Not applicable — this task adds no behavior. Its checks are the documentation-reference scan and the full gate below (each with its expected output).

- [ ] **Step 2: Run the documentation scan and verify no stale references**

Run: `rg -n "itemEchoes|paintedSummary|filteredPlaceholder|summarizeFreshAgentItems|segmentMatchesEchoes|summaryIsAuthoredContent|SUMMARY_LABEL_BY_KIND" AGENTS.md docs/ README.md || true`

Expected: no hits (zero matches). The docs mock (`docs/index.html:836-845`) renders a settled activity strip with no streaming echo captions, so the foldable-captions change does not alter what the mock shows — no `docs/index.html` update. `AGENTS.md` documents none of the deleted machinery — no update. The historical plan `docs/plans/2026-08-23-freshagent-activity-line.md` stays untouched. If the scan DOES find a hit, update that reference in this task.

- [ ] **Step 3: Add the minimal production implementation**

None — no doc changes required (per Step 2's expected result).

- [ ] **Step 4: Run the coordinated full suite**

Check `npm run test:status` first (coordinator gate); set `FRESHELL_TEST_SUMMARY='freshagent-summary-provenance final gate'`.

Run: `npm run check`

Expected: PASS (typecheck + coordinated full suite, on the configured vitest backend).

- [ ] **Step 5: Refactor while green**

Nothing to refactor — verification task.

- [ ] **Step 6: Run impacted-test verification (Rust workspace + e2e impacted set)**

Run: `cargo test --workspace --exclude freshell-tauri && cargo fmt --all --check && cargo clippy --workspace --all-targets -- -D warnings`

Expected: PASS

- [ ] **Step 7: Commit the task**

Nothing to commit if Step 2 found no stale references (the expected case) — state that in the task record. If Step 2 did surface a doc fix:

```bash
git add AGENTS.md docs/
git commit -m "docs: update fresh-agent summary references for provenance tagging"
```
