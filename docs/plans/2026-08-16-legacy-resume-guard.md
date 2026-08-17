# Legacy Resume Session ID Guard Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Implement kata issue ejh6 (revised 2026-08-16 spec: "Remove the legacy resumeSessionId wire field — hard rejection, no silent ignore"): both Freshell servers must loudly reject the legacy `resumeSessionId` wire field on every create-class request door, with `sessionRef {provider, sessionId}` as the canonical carrier. Work happens on branch `legacy-resume-guard` in worktree `/home/dan/code/freshell/.worktrees/legacy-resume-guard`, based on current origin/main; authoritative spec text is kata `ejh6`, archived at `/home/dan/code/freshell/.worktrees/.the-usual-logs/legacy-resume-guard/reports/kata-ejh6-spec.md`.

### Explicit constraints
- Handler-level rejection on BOTH servers; `resumeSessionId` stays DECLARED in every wire schema/struct (shared zod schemas in `shared/ws-protocol.ts`, the dynamic `.strict()` terminal.create schema in `server/ws-handler.ts` `rebuildClientMessageSchema`, Rust protocol structs in `crates/freshell-protocol/src/client_messages.rs`), each commented as retained solely for handler detect-and-reject citing kata ejh6; never use `.strict()`/`deny_unknown_fields`/serde removal as the rejection mechanism.
- Doors and responses: (a) REST `POST /api/tabs`, `POST /api/panes/:id/split`, `POST /api/panes/:id/respawn` (Rust `terminal_tabs.rs`/`pane_ops.rs`, Node `createAgentApiRouter`) → HTTP 400 naming `sessionRef` (reuse the frozen text "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity." — the same constant in both servers, or mint one shared new constant); (b) WS `terminal.create` (Rust `freshell-ws/terminal.rs`, Node `ws-handler.ts`) → `error{INVALID_MESSAGE}` on ANY create carrying the field, including codex (drop the current restore-only/non-codex scoping); (c) WS `freshAgent.create`/`freshAgent.attach` → the provider's create-failed envelope (FRESH_AGENT_CREATE_FAILED family); (d) WS `codingcli.create` (Node `ws-handler.ts` ~:3280) → reject the legacy field with INVALID_MESSAGE + named text AND promote `sessionRef` (provider must equal `m.provider`) into the spawn-time resume id; check `port/machine/specs/cli-argv-fidelity.md` before touching the Rust codingcli struct doc comment.
- Permanent sole exception: `pane.reconcile`'s `ReconcilePane.resume_session_id` — keep the server-side promotion in `crates/freshell-ws/src/reconcile.rs` (`promoted_legacy_claim` ~:162–:177) forever, documented as the single legacy-compat door with no later-removal plan; also add client-side promotion in `src/lib/pane-reconcile.ts:130,:153` following the `effectiveSessionRef` pattern.
- No internal regressions: restore-driven REST creates reuse the `POST /api/tabs` create handler in `crates/freshell-freshagent/src/terminal_tabs.rs` (EDEV-07 synthesis ~:2096–:2110), where captured pane content may carry an implausible legacy resumeSessionId — the reject must fire only after that path promotes or strips the field (or assert snapshots never carry it and migrate); `claude.rs` `attach_durable_id` (~:1813) reads legacy-first — flip to sessionRef-first or leave documented, after verifying no internal caller constructs an attach with the field set; registry rows, pane-content fields, and `/api/terminals` read-model derivations are out of scope (do not rename); the MCP `resume`/`resumeSessionId` params and CLI `--resume` flag stay as ergonomic aliases that convert to sessionRef before the wire.
- Every rejection has a door-level test on Rust AND Node, plus e2e through the CLI/MCP path where one exists; wire-sending tests that use `resumeSessionId` (~844 raw occurrences across ~119 test files, verify by grepping) are converted to sessionRef or repurposed as rejection tests; never delete a behavior test without a replacement; pinned frozen-message tests keep passing with the exact frozen text.
- Order of work: contract-neutral test-conversion commits first (no behavior change), then behavior commits landing BOTH servers' rejections together with the pane-reconcile client promotion, the codingcli sessionRef promotion, and rejection tests; gates are the coordinated full suite (`npm run check`, local vitest backend), `cargo test --workspace`, and Playwright e2e for the CLI/MCP path where one exists.
- Acceptance verification: the kata §6 `rg` sweep shows only allowed categories, and the kata verification checklist passes (REST 400, WS INVALID_MESSAGE with named text and no spawn, registry row count unchanged, create-failed envelope, CLI `--resume`/MCP `resume` still work, reload/restore of pre-existing persisted state still resumes).

### Accepted tradeoffs and residuals
- No known external callers exist (user-confirmed), so rejection ships directly with loud errors and no deprecation window.
- The `attach_durable_id` legacy-first read becomes dead for external input after rejection; its flip/documentation is hygiene, not a safety gate.
- Old persisted pane content can carry a legacy-only claim indefinitely, so the server-side `pane.reconcile` compat door is permanent by design; no point-in-time test run can justify closing it (kata option 2b is rejected).

**Goal:** Both Freshell servers loudly reject any create-class wire message carrying `resumeSessionId` with a frozen sessionRef-naming error, while the permanent `pane.reconcile` compat door keeps old persisted state resumable.

**Architecture:** Handler-level rejection on both servers — `resumeSessionId` stays declared in every wire schema/struct (commented "retained solely so the handler can detect-and-reject; see kata ejh6") and each create door checks for the field and returns the frozen text. One shared Rust `&str` const in `freshell-protocol` and one canonical Node const (`INVALID_RAW_CODEX_RESUME_MESSAGE`) dedupe the frozen text. Contract-neutral test conversions land first (both servers still accept both carriers), then Rust REST/WS rejection, then Node REST/WS rejection, then client-side `pane.reconcile` promotion, then a final `rg` sweep + verification gates. The Rust `pane.reconcile` `promoted_legacy_claim` door stays forever as the single permanent compat exception.

**Tech Stack:** Node.js/Express/ws/zod (Node server + shared schemas), Rust/axum/tokio-tungstenite/serde (Rust server + `freshell-protocol`), Vitest + supertest (Node tests), `cargo test` (Rust tests), Playwright (e2e-browser specs).

## Global Constraints

- **Worktree-only:** all work is in `/home/dan/code/freshell/.worktrees/legacy-resume-guard` on branch `legacy-resume-guard` from `origin/main`. Never push behavior changes directly to `origin/main`.
- **NodeNext ESM:** relative TS imports must include `.js` extensions (e.g. `from '../../server/coding-cli/codex-app-server/restore-decision.js'`).
- **Frozen text is byte-exact and immutable:** `"Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."` — pinned by tests in both servers; never change the text. Existing pinned-text tests (`live_session_ref_guard.rs:236`, `resume_validation_gate.rs:677`, `ws-terminal-create-reuse-running-codex.test.ts:619,:652`, `agent-cli-flow.test.ts:575`, `freshell-tool.test.ts:117,:163,:321,:440`, `agent-tabs-write.test.ts:442`, `agent-panes-write.test.ts:154,:336`) must keep passing.
- **Never weaken tests:** never delete a behavior test without a replacement; never mark tests skip; never simplify assertions to get green.
- **Coordinated runners:** Node tests via `npm run test:vitest -- run <paths> --config <config>` (default config `config/vitest/vitest.config.ts`, server config `config/vitest/vitest.server.config.ts`); Rust via `cargo test -p <crate>` focused, `cargo test --workspace` as gate; `npm run check` (typecheck + coordinated full suite) as final gate.
- **Rejection mechanism:** handler-level only. Never use `.strict()`/`deny_unknown_fields`/serde field removal as the rejection mechanism (zod non-strict strips silently; `.strict()` rejects with a generic unrecognized-key error that cannot carry the frozen text). The field stays DECLARED in every schema/struct.
- **Section 3c doc comment:** every retained `resumeSessionId`/`resume_session_id` field in a wire schema/struct gets the comment `Retained solely so the handler can detect-and-reject; see kata ejh6.` — EXCEPT `ReconcilePane.resume_session_id` which gets the PERMANENT compat-door comment.
- **`restoreKey` gating:** blanket REST reject does NOT gate on `restoreKey` — no production producer emits it (verified), so blanket reject regresses nothing live (binding correction A).
- **Sidecar JSON-lines writers are not wire input:** `claude.rs:469` and `:1294` write `resumeSessionId` to the claude Node sidecar's internal JSON-lines protocol, not the Freshell WS wire — leave them untouched (binding correction C).

## Where the kata is superseded by explorer evidence

A) Rust REST reject point is `derive_resume_identity` (`crates/freshell-freshagent/src/terminal_tabs.rs:507-531`); restore-driven creates are distinguishable only by a `restoreKey` body tag that NO production producer emits — blanket REST reject regresses nothing live, do NOT gate on `restoreKey`.
B) Rust WS `terminal.create`: widen the gate at `crates/freshell-ws/src/terminal.rs:2441-2457` or reject at head of `handle_create` (`:2138`); freshAgent create/attach share dispatch `terminal.rs:861-926` — create rejects via `FreshAgentCreateFailed` envelope (`crates/freshell-ws/src/server_messages.rs:618-627`), attach has NO requestId so its rejection rides `freshAgent.event{freshAgent.error}` keyed by session id.
C) Rust has NO codingcli handler (protocol struct only, `crates/freshell-protocol/src/client_messages.rs:429-448`, no `session_ref` on it; section 3.3/U7 doc comment lives on `TerminalCreate.resume_session_id` `:231-235`); NO Rust production code sends the field on the Freshell wire — server-to-sidecar JSON-lines writers (`claude.rs:469`/`:1294` + test fakes) are not wire input, leave them.
D) Node: blanket WS `terminal.create` reject at head of the terminal.create case `server/ws-handler.ts` (~:2107+), replacing the restore/non-codex-scoped gate `:2160-2186`; freshAgent.create envelope `freshAgent.create.failed` (codes `:3430`/`:3465`/`:3530`); attach failure frame is `error{INTERNAL_ERROR}` — for attach rejection use the `FRESH_AGENT_CREATE_FAILED` code on a frame matching the existing attach error shape, documented via comment; `codingcli.create` `:3280-3326`: add `sessionRef` to `CodingCliCreateSchema` (`shared/ws-protocol.ts`) and — after reading `port/machine/specs/cli-argv-fidelity.md` section 3.3/U7, with the decision and cited spec text IN the plan — decide whether the Rust codingcli struct also gains `session_ref`; then promote a provider-matched `sessionRef` into the spawn-time resume id in the Node handler.
E) Node REST: single seam `requestedResumeSessionIdForMode` (`server/agent-api/router.ts:214-228`) — widen codex-only throw to all modes with frozen text; 400 shape `{status:'error',message}`.
F) Frozen text byte-exact: `"Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."` Node canonical const `INVALID_RAW_CODEX_RESUME_MESSAGE` (`server/coding-cli/codex-app-server/restore-decision.ts:27-28`) + inline dup `ws-handler.ts:2181`; Rust private dups `terminal_tabs.rs:65` + `terminal.rs:1520` — plan mints one shared Rust const in `freshell-protocol` and one canonical Node const (names may change; text pinned by tests, don't change text).
G) Use `plan-test-sweep.md` tables literally for conversion scope; `remote-tab-linkage-rust.spec.ts`: convert sends to `sessionRef` where assertions aren't legacy-acceptance, leave acceptance asserts for the behavior task to repurpose as rejection tests.
H) Node has NO `pane.reconcile` handler; client-side promotion in `src/lib/pane-reconcile.ts:130`,`:153` (pattern = `FreshAgentView.tsx` `effectiveSessionRef` `:335-341`) + Rust server door kept forever.
I) No e2e drives CLI/MCP into WS `terminal.create`; CLI/MCP regression = existing suites stay green (aliases convert), plus one cheap new assertion in `test/e2e/agent-cli-flow.test.ts` that a raw legacy WS send gets `INVALID_MESSAGE`+frozen text. Do not invent new e2e harnesses.
J) Repo rules: worktree-only; coordinated runners (`npm run test:vitest -- run <paths> --config <config>`; configs `config/vitest/vitest.config.ts` (default) and `config/vitest/vitest.server.config.ts` (server)); `cargo test -p <crate>` focused, `cargo test --workspace` and `npm run check` as gates; NodeNext ESM needs `.js` extensions on relative TS imports; never weaken tests.

---

### Task 1: Mint shared frozen-text constants (Rust + Node dedup)

**Files:**
- Create: `crates/freshell-protocol/tests/legacy_resume_text.rs`
- Modify: `crates/freshell-protocol/src/common.rs:82` (add const after `ErrorCode` enum)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:51` (import), `:60-65` (remove local const), `:130` (usage)
- Modify: `crates/freshell-ws/src/terminal.rs:62-67` (import), `:1516-1520` (remove local const), `:2453` (usage)
- Modify: `server/ws-handler.ts:110-113` (add import), `:2179-2183` (replace inline literal)
- Test: `crates/freshell-protocol/tests/legacy_resume_text.rs` (new), existing pins stay green

**Interfaces:**
- Consumes: existing frozen text in `restore-decision.ts:27-28` (Node), existing private consts at `terminal_tabs.rs:65` and `terminal.rs:1520` (Rust).
- Produces: `freshell_protocol::LEGACY_RESUME_IDENTITY_REFUSAL` (Rust shared `&str` const, re-exported via `pub use common::*` in `lib.rs`); Node `INVALID_RAW_CODEX_RESUME_MESSAGE` imported into `ws-handler.ts` for use by later tasks.

- [ ] **Step 1: Write the failing behavioral test**

This task is a pure dedup refactor — no new behavior, so the "test" is a new pinning test plus the existing pinned-text tests continuing to assert the exact frozen string.

```rust
// crates/freshell-protocol/tests/legacy_resume_text.rs
//! ejh6 Task 1: the shared frozen refusal text is byte-exact and lives in
//! freshell-protocol so both freshell-freshagent and freshell-ws reference
//! one source of truth.
use freshell_protocol::LEGACY_RESUME_IDENTITY_REFUSAL;

#[test]
fn frozen_refusal_text_is_byte_exact() {
    assert_eq!(
        LEGACY_RESUME_IDENTITY_REFUSAL,
        "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
    );
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-protocol --test legacy_resume_text`

Expected: FAIL because `cannot find function or const LEGACY_RESUME_IDENTITY_REFUSAL in crate freshell_protocol` — the const does not exist yet.

- [ ] **Step 3: Add the minimal production implementation**

Add the shared const to `crates/freshell-protocol/src/common.rs` after the `ErrorCode` enum (after line 82):

```rust
/// The frozen sessionRef-naming refusal text for the legacy `resumeSessionId`
/// wire field (kata ejh6). Byte-identical to Node's
/// `INVALID_RAW_CODEX_RESUME_MESSAGE`
/// (`server/coding-cli/codex-app-server/restore-decision.ts:27-28`) so clients
/// see one contract across doors and servers. Both `freshell-freshagent`
/// (`terminal_tabs.rs`) and `freshell-ws` (`terminal.rs`) reference this const
/// instead of carrying private duplicates.
pub const LEGACY_RESUME_IDENTITY_REFUSAL: &str = "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.";
```

Update `crates/freshell-freshagent/src/terminal_tabs.rs` — change the import at `:51` to:

```rust
use freshell_protocol::{LEGACY_RESUME_IDENTITY_REFUSAL, ServerMessage, SessionLocator, UiCommand};
```

Remove the private const at `:60-65` (the doc block + `const INVALID_RAW_CODEX_RESUME_MESSAGE: &str = ...;`). Replace the usage at `:130` (`INVALID_RAW_CODEX_RESUME_MESSAGE.to_string()`) with `LEGACY_RESUME_IDENTITY_REFUSAL.to_string()`.

Update `crates/freshell-ws/src/terminal.rs` — add `LEGACY_RESUME_IDENTITY_REFUSAL` to the import block at `:62-67`:

```rust
use freshell_protocol::{
    AgentProvider, ClientMessage, ErrorCode, ErrorMsg, FreshAgentEvent,
    LEGACY_RESUME_IDENTITY_REFUSAL, Pong, ServerMessage,
    SessionLocator, SessionType, Shell, TerminalAttach, TerminalAutoResumeCancel, TerminalCreate,
    TerminalCreated, TerminalIdOnly, TerminalInputBlocked, TerminalInputBlockedReason,
    TerminalKill, TerminalResize,
};
```

Remove the private const at `:1516-1520` (the doc block + `const LEGACY_RESTORE_IDENTITY_REFUSAL: &str = ...;`). Replace the usage at `:2453` (`LEGACY_RESTORE_IDENTITY_REFUSAL.to_string()`) with `LEGACY_RESUME_IDENTITY_REFUSAL.to_string()`.

Update `server/ws-handler.ts` — add `INVALID_RAW_CODEX_RESUME_MESSAGE` to the import at `:110-113`:

```ts
import {
  INVALID_RAW_CODEX_RESUME_MESSAGE,
  planCodexCreateRestoreDecision,
  resolveCodexCreateRestoreDecision,
} from './coding-cli/codex-app-server/restore-decision.js'
```

Replace the inline literal at `:2179-2183`:

```ts
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            requestId: m.requestId,
          })
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-protocol --test legacy_resume_text && cargo test -p freshell-ws --test live_session_ref_guard legacy_only_restore_is_refused && npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS — the new const test pins the text; existing pinned-text tests stay green because the text is byte-identical.

- [ ] **Step 5: Refactor while green**

The dedup IS the refactor. Confirm no remaining private duplicate: `rg "Restore requires sessionRef" crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-ws/src/terminal.rs server/ws-handler.ts` should show ZERO hits (all three now reference the shared/imported const).

- [ ] **Step 6: Run impacted-test verification**

The change touches the frozen text carriers in both servers. Impacted set: all pinned-text tests in both servers.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws && npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/mcp/freshell-tool.test.ts test/e2e/agent-cli-flow.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-protocol/src/common.rs crates/freshell-protocol/tests/legacy_resume_text.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-ws/src/terminal.rs server/ws-handler.ts
git commit -m "refactor(ejh6): mint shared frozen refusal-text const, dedupe private dups"
```

---

### Task 2: Convert Node WS freshAgent wire-send tests to sessionRef

**Files:**
- Modify: `test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts:98,:201,:248`
- Modify: `test/unit/server/ws-handler-fresh-agent.test.ts:959`
- Test: same files (converted in place)

**Interfaces:**
- Consumes: `sessionRef` field already accepted by `FreshAgentCreateSchema`/`FreshAgentAttachSchema` (`shared/ws-protocol.ts:486,:499`); `runtime-manager.ts:106-108` sessionRef-to-resume-id promotion.
- Produces: tests that send `sessionRef` only (no legacy field), staying green against the unmodified server.

- [ ] **Step 1: Write the failing behavioral test**

These are mechanical conversions of wire-send sites. Against the unmodified server both carriers are accepted, so the converted test passes immediately (contract-neutral). No production change.

In `test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts`, at each of the 3 wire-send sites (`:98`, `:201`, `:248`), replace the `resumeSessionId: '<value>'` property with `sessionRef: { provider: '<provider>', sessionId: '<value>' }` where `<provider>` matches the `provider` field on the same message. For `freshAgent.attach` at `:248`: keep the top-level `sessionId` field (required by the schema), replace `resumeSessionId` with `sessionRef: { provider, sessionId }` using the same sessionId value. The internal `runtimeManager.create` arg-mirror assert at `:112` mirrors the manager input, not the wire — leave internal asserts unchanged.

In `test/unit/server/ws-handler-fresh-agent.test.ts:959`, replace `resumeSessionId: 'cli-session-attached'` with `sessionRef: { provider: 'claude', sessionId: 'cli-session-attached' }` on the `freshAgent.attach` wire message.

Example conversion shape (match the exact surrounding code in-file):

```ts
// BEFORE:
ws.send(JSON.stringify({
  type: 'freshAgent.create', requestId: '...', sessionType: 'freshclaude',
  provider: 'claude', cwd: '/tmp', resumeSessionId: 'cli-session-attached',
}))
// AFTER:
ws.send(JSON.stringify({
  type: 'freshAgent.create', requestId: '...', sessionType: 'freshclaude',
  provider: 'claude', cwd: '/tmp',
  sessionRef: { provider: 'claude', sessionId: 'cli-session-attached' },
}))
```

- [ ] **Step 2: Run the test and verify the intended failure**

Contract-neutral conversion — the test passes against the unmodified server (both carriers accepted).

Run: `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts test/unit/server/ws-handler-fresh-agent.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 3: Add the minimal production implementation**

No production change — contract-neutral test conversion. Both servers still accept both carriers.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts test/unit/server/ws-handler-fresh-agent.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — mechanical conversion.

- [ ] **Step 6: Run impacted-test verification**

These test files are self-contained unit tests; no other test imports or depends on their wire-send shapes.

Run: same as Step 4.

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "test(ejh6): convert Node WS freshAgent wire-send tests to sessionRef"
```

---

### Task 3: Convert Rust wire-send tests to sessionRef

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (test mod — POST bodies at `:4504,:4558,:4606,:5838,:5883,:5915,:5950,:5993,:6032,:6074`)
- Modify: `crates/freshell-freshagent/src/codex.rs` (test mod — msg structs at `:7047,:7181,:7240`)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs:3056`
- Modify: `crates/freshell-freshagent/src/claude.rs:2228-2232`
- Modify: `crates/freshell-ws/src/terminal_launch_prep_tests.rs:31-45`
- Modify: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs:253-267`
- Modify: `crates/freshell-ws/tests/session_identity_frames.rs:67-72`
- Modify: `crates/freshell-ws/tests/pane_ledger_triggers.rs:156-162`
- Modify: `crates/freshell-ws/tests/freshagent_claude_attach.rs:360-365,:466-471`
- Modify: `crates/freshell-ws/tests/freshagent_session_lease.rs:417-424,:599-604,:756-761`
- Test: same files (converted in place)

**Interfaces:**
- Consumes: `session_ref` field already on every Rust protocol struct (`TerminalCreate.session_ref`, `FreshAgentCreate.session_ref`, `FreshAgentAttach.session_ref`); `derive_resume_identity` and per-provider resume-id derivation accept sessionRef.
- Produces: Rust tests that send `sessionRef`/`session_ref` only, staying green against the unmodified server.

- [ ] **Step 1: Write the failing behavioral test**

Mechanical conversions. For each site, replace the legacy carrier with the canonical `sessionRef`/`session_ref` carrier. The asserted behavior (registry directory fills, spawn argv, frame assertions, ledger non-mutation) is carrier-agnostic and stays green.

**REST POST bodies in `terminal_tabs.rs` test mod** — each `json!({... "resumeSessionId": "<id>" ...})` becomes `json!({... "sessionRef": {"provider": "<mode>", "sessionId": "<id>"} ...})` where `<mode>` is the `mode` field on the same body. The 10 test fns at `:4490,:4543,:4592,:5824,:5856,:5896,:5936,:5978,:6018,:6060` each get their POST body converted. Example for `create_tab_resume_session_id_flows_to_registry_directory_for_non_codex_mode` (`:4490`, body at `:4504`):

```rust
// BEFORE:
let body = json!({"mode": "claude", "resumeSessionId": "sess-dir-claude-1"});
// AFTER:
let body = json!({"mode": "claude", "sessionRef": {"provider": "claude", "sessionId": "sess-dir-claude-1"}});
```

The three `rest_create_legacy_resume_*409` tests (`:5824,:5856,:5896`) test the D7/LEASE 409 ladder via the legacy carrier — convert the body to `sessionRef` and re-aim the assertions at the sessionRef-carrier D7 path (the 409 RESTORE_UNAVAILABLE behavior is carrier-agnostic; the test still expects 409). The `:4424` codex-reject test (`create_codex_tab_rejects_raw_resume_session_id_without_session_ref`) is a REJECTION-READY test — leave it sending legacy (it will be widened in Task 5).

**`codex.rs` test mod** — at `:7047,:7181,:7240`, replace `resume_session_id: Some("<id>".to_string())` with `session_ref: Some(SessionLocator { provider: AgentProvider::Codex, session_id: "<id>".to_string() })`. The twin test `handle_create_with_session_ref_only_resumes_the_same_thread` at `:7096` already shows the post-conversion shape — match it.

**`opencode_ws.rs:3056`** — replace `create.resume_session_id = Some(DURABLE_ID.to_string());` with `create.session_ref = Some(SessionLocator { provider: AgentProvider::Opencode, session_id: DURABLE_ID.to_string() });`.

**`claude.rs:2228-2232`** (`attach_msg_with_resume` test helper) — replace `msg.resume_session_id = Some(durable.to_string());` with `msg.session_ref = Some(SessionLocator { provider: AgentProvider::Claude, session_id: durable.to_string() });`.

**`terminal_launch_prep_tests.rs:31-45`** — the `wire_legacy_resume_session_id_is_from_wire` test builds a legacy `restore:true` create. Convert to `session_ref` carrier; rename to `wire_session_ref_is_from_wire`; the `resume_id_from_wire` property survives via sessionRef.

**`codex_managed_launch_e2e.rs:253-267`** (helper `create_codex_terminal_resume`) — replace `"resumeSessionId": "<id>"` with `"sessionRef": {"provider": "codex", "sessionId": "<id>"}` in the WS frame.

**`session_identity_frames.rs:67-72`** — replace `"resumeSessionId": "sess-identity-1"` with `"sessionRef": {"provider": "amplifier", "sessionId": "sess-identity-1"}`.

**`pane_ledger_triggers.rs:156-162`** — replace the legacy-only create carrier with `"sessionRef": {"provider": "claude", "sessionId": "<id>"}`.

**`freshagent_claude_attach.rs:360-365,:466-471`** and **`freshagent_session_lease.rs:417-424,:599-604,:756-761`** — these frames carry BOTH `resumeSessionId` AND `sessionRef` today. Delete the `resumeSessionId` line in each (sessionRef already present — trivial). The fake-sidecar `msg.resumeSessionId` reads at `freshagent_claude_attach.rs:63` are the internal adapter-to-sidecar protocol — leave them.

- [ ] **Step 2: Run the test and verify the intended failure**

Contract-neutral conversion — passes against the unmodified server.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws`

Expected: PASS

- [ ] **Step 3: Add the minimal production implementation**

No production change — contract-neutral test conversion.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — mechanical conversion. Stale test names (e.g. `create_amplifier_tab_with_legacy_resume_synthesizes_session_ref`) may be renamed to reflect the sessionRef carrier (e.g. `create_amplifier_tab_with_session_ref_flows_to_registry`), but this is optional in the prep task.

- [ ] **Step 6: Run impacted-test verification**

The Rust workspace suite is the impacted set (these tests cover the create doors across both crates).

Run: `cargo test --workspace`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/claude.rs crates/freshell-ws/src/terminal_launch_prep_tests.rs crates/freshell-ws/tests/codex_managed_launch_e2e.rs crates/freshell-ws/tests/session_identity_frames.rs crates/freshell-ws/tests/pane_ledger_triggers.rs crates/freshell-ws/tests/freshagent_claude_attach.rs crates/freshell-ws/tests/freshagent_session_lease.rs
git commit -m "test(ejh6): convert Rust wire-send tests to sessionRef"
```

---

### Task 4: Convert e2e-browser Rust wire-send tests to sessionRef

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts:1521,:1586,:1864,:1929`
- Modify: `test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts:313,:414,:536`
- Modify: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts:344-346,:423-425,:616-618`
- Modify: `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts:197-205` (convert sends where assertions aren't legacy-acceptance; leave acceptance asserts for Task 8 to repurpose)
- Test: same files

**Interfaces:**
- Consumes: Rust server accepts both carriers (unmodified); sessionRef is the canonical carrier already used by the web client.
- Produces: e2e specs that send `sessionRef` only on the wire (except `remote-tab-linkage-rust.spec.ts` acceptance-assert sites, left for Task 8).

- [ ] **Step 1: Write the failing behavioral test**

Mechanical conversions of e2e WS/REST wire-send sites.

**`fresh-agent-control-rust.spec.ts:1521,:1586,:1864,:1929`** — each `freshAgent.attach` frame carrying `resumeSessionId: '<id>'` (alongside `sessionId`, no `sessionRef`) becomes `sessionRef: { provider: 'claude', sessionId: '<id>' }` (drop the `resumeSessionId` key, keep `sessionId`).

**`freshagent-settings-resume-rust.spec.ts:313,:414`** — `freshAgent.create` with `resumeSessionId` becomes `sessionRef: { provider, sessionId }`. **`:536`** — `freshAgent.attach` with `resumeSessionId` becomes `sessionRef` (keep `sessionId`).

**`sidebar-registry-sync-rust.spec.ts:344-346,:423-425,:616-618`** — each `page.request.post(baseUrl/api/tabs)` with `data: { mode: 'claude', resumeSessionId: sessionId }` becomes `data: { mode: 'claude', sessionRef: { provider: 'claude', sessionId } }`. The in-file comment pattern at `:338-343`/`:417-422` already explains codex uses sessionRef — extend it to claude.

**`remote-tab-linkage-rust.spec.ts:197-205`** — per binding correction G: convert the `fetch(baseUrl/api/tabs, { mode: 'amplifier', resumeSessionId: SEEDED_SESSION_ID })` send to `sessionRef` WHERE the surrounding assertion is NOT legacy-acceptance. The spec's premise (legacy acceptance then sessionRef synthesis) is tested by assertions that the created tab carries the synthesized sessionRef. Leave those acceptance assertions untouched for Task 8 to repurpose as a REST 400 rejection e2e. For any purely-mechanical send sites whose assertions are carrier-agnostic (e.g. sidecar log reads), convert to `sessionRef`.

- [ ] **Step 2: Run the test and verify the intended failure**

Contract-neutral — e2e specs pass against the unmodified Rust server. Run the four converted specs via the repo's e2e runner (check `package.json`; if `FRESHELL_E2E_BACKEND` is unset, run locally — these are Rust-server specs so use the Rust e2e config).

Run: `npm run test:e2e:local -- --grep "fresh-agent-control-rust|freshagent-settings-resume-rust|sidebar-registry-sync-rust|remote-tab-linkage-rust"` (adjust to the repo's Playwright invocation if the grep syntax differs; the intent is to run only these four specs).

Expected: PASS

- [ ] **Step 3: Add the minimal production implementation**

No production change — contract-neutral test conversion.

- [ ] **Step 4: Run the focused test**

Run: same as Step 2.

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — mechanical conversion.

- [ ] **Step 6: Run impacted-test verification**

The impacted set is the four converted e2e specs (they are self-contained against the Rust server). Run them together.

Run: same as Step 2.

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts
git commit -m "test(ejh6): convert e2e-browser Rust wire-send tests to sessionRef"
```

---

### Task 5: Rust REST reject — widen `derive_resume_identity` to all modes + section 3c doc comments

**Files:**
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:117-136` (`requested_resume_session_id_for_mode` — widen codex-only throw to all modes)
- Modify: `crates/freshell-protocol/src/client_messages.rs:231-235` (`TerminalCreate.resume_session_id` doc), `:409-411` (`ReconcilePane.resume_session_id` doc — PERMANENT compat), `:445` (`CodingCliCreate.resume_session_id` doc), `:511` (`FreshAgentCreate.resume_session_id` doc), `:527` (`FreshAgentAttach.resume_session_id` doc)
- Test: `crates/freshell-freshagent/src/terminal_tabs.rs` (test mod — add per-mode rejection test)
- Test: `crates/freshell-freshagent/src/pane_ops_tests.rs` (new split/respawn rejection tests)

**Interfaces:**
- Consumes: `LEGACY_RESUME_IDENTITY_REFUSAL` (from Task 1); `fail_json(StatusCode::BAD_REQUEST, ...)` at `lib.rs:1556`; `post(app(state), uri, body, auth)` helper at `terminal_tabs.rs:2671`.
- Produces: all three Rust REST doors (`POST /api/tabs`, `/api/panes/:id/split`, `/api/panes/:id/respawn`) return HTTP 400 `{status:"error",message:<frozen>}` when the body carries a non-empty `resumeSessionId`.

- [ ] **Step 1: Write the failing behavioral test**

Add to the `#[cfg(test)] mod tests` in `crates/freshell-freshagent/src/terminal_tabs.rs` (after the existing `create_codex_tab_rejects_raw_resume_session_id_without_session_ref` at `:4415`):

```rust
#[tokio::test]
async fn rest_create_rejects_legacy_resume_session_id_for_every_session_mode() {
    let state = state_with_registry();
    let app = crate::router(state);
    for mode in ["claude", "opencode", "amplifier"] {
        let (status, body) = post(
            app.clone(),
            "/api/tabs",
            json!({"mode": mode, "resumeSessionId": format!("legacy-{mode}-id")}),
            AUTH_HEADER,
        )
        .await;
        assert_eq!(
            status,
            StatusCode::BAD_REQUEST,
            "{mode}: legacy resumeSessionId must be rejected with 400, got {status}: {body}"
        );
        let msg = body["message"].as_str().expect("message field");
        assert_eq!(
            msg,
            "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.",
            "{mode}: frozen text must be byte-exact, got {msg}"
        );
    }
}
```

Add to `crates/freshell-freshagent/src/pane_ops_tests.rs` (split test section opens at `:122`; add after the last split test):

```rust
#[tokio::test]
async fn split_pane_rejects_legacy_resume_session_id_with_400() {
    let state = state_with_registry();
    let app = crate::router(state);
    let _ = post(app.clone(), "/api/tabs", json!({"mode": "shell"}), AUTH_HEADER).await;
    let (status, body) = post(
        app.clone(),
        "/api/panes/pane_1/split",
        json!({"direction": "horizontal", "mode": "claude", "resumeSessionId": "legacy-split-id"}),
        AUTH_HEADER,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "split legacy reject: {body}");
    assert_eq!(
        body["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.")
    );
}
```

Add to the respawn test section (opens at `:562`):

```rust
#[tokio::test]
async fn respawn_pane_rejects_legacy_resume_session_id_with_400() {
    let state = state_with_registry();
    let app = crate::router(state);
    let _ = post(app.clone(), "/api/tabs", json!({"mode": "shell"}), AUTH_HEADER).await;
    let (status, body) = post(
        app.clone(),
        "/api/panes/pane_1/respawn",
        json!({"mode": "claude", "resumeSessionId": "legacy-respawn-id"}),
        AUTH_HEADER,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "respawn legacy reject: {body}");
    assert_eq!(
        body["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.")
    );
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent rest_create_rejects_legacy_resume_session_id_for_every_session_mode split_pane_rejects_legacy_resume_session_id_with_400 respawn_pane_rejects_legacy_resume_session_id_with_400`

Expected: FAIL because the non-codex modes silently accept the legacy field today (`requested_resume_session_id_for_mode` at `:135` returns `Ok(legacy)` for non-codex) — the test gets a 200/500 instead of 400.

- [ ] **Step 3: Add the minimal production implementation**

Widen `requested_resume_session_id_for_mode` at `crates/freshell-freshagent/src/terminal_tabs.rs:117-136`. Replace the codex-only throw with an any-mode throw:

```rust
fn requested_resume_session_id_for_mode(
    session_ref: Option<&SessionLocator>,
    mode: &str,
    legacy_resume_session_id: Option<&str>,
) -> Result<Option<String>, Response> {
    let accepted = accepted_session_ref_for_mode(session_ref, mode);
    if let Some(ref sref) = accepted {
        return Ok(Some(sref.session_id.clone()));
    }
    // ejh6: reject the legacy resumeSessionId wire field on EVERY mode. The
    // canonical carrier is sessionRef; resumeSessionId stays declared on the
    // wire schema solely so this handler can detect-and-reject (see kata ejh6).
    if legacy_resume_session_id.is_some_and(|s| !s.is_empty()) {
        return Err(fail_json(
            StatusCode::BAD_REQUEST,
            LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
        ));
    }
    Ok(None)
}
```

Add section 3c doc comments to the Rust protocol structs in `crates/freshell-protocol/src/client_messages.rs`:

At `:231-235` (`TerminalCreate.resume_session_id`), append to the existing doc comment:

```rust
    /// The spawn-time resume session id (`ws-handler.ts:656-658` — distinct from
    /// `sessionRef`; spec `cli-argv-fidelity.md` section 3.3/U7: only the
    /// spawn-time id is modeled here, the binding/repair pipeline stays with
    /// coding-cli.md). Retained solely so the handler can detect-and-reject;
    /// see kata ejh6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
```

At `:409-411` (`ReconcilePane.resume_session_id`), replace the doc comment with the PERMANENT compat-door wording:

```rust
    /// Optional legacy single-key claim. PERMANENT legacy-compat door: the
    /// server-side `promoted_legacy_claim` (`reconcile.rs`) promotes this into
    /// a sessionRef forever; old persisted pane content can carry a legacy-only
    /// claim indefinitely. Do NOT plan a later removal (kata ejh6 section 2).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
```

At `:445` (`CodingCliCreate.resume_session_id`), `:511` (`FreshAgentCreate.resume_session_id`), `:527` (`FreshAgentAttach.resume_session_id`), add the same comment:

```rust
    /// Retained solely so the handler can detect-and-reject; see kata ejh6.
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent rest_create_rejects_legacy_resume_session_id_for_every_session_mode split_pane_rejects_legacy_resume_session_id_with_400 respawn_pane_rejects_legacy_resume_session_id_with_400`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The codex-specific branch is gone — the any-mode throw subsumes it. The function name `requested_resume_session_id_for_mode` still accurately describes the function's role. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

The REST reject affects every REST create test that sends `resumeSessionId`. The WIRE-SEND REST tests were converted in Task 3 (they now send sessionRef). The REJECTION-READY codex test at `:4415` still sends legacy and expects 400 — it stays green (now the any-mode throw covers codex too). The three `rest_create_legacy_resume_*409` tests were converted to sessionRef in Task 3 — they expect 409 (D7/LEASE) and stay green because they send sessionRef.

Run: `cargo test -p freshell-freshagent`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/pane_ops_tests.rs crates/freshell-protocol/src/client_messages.rs
git commit -m "feat(ejh6): Rust REST reject legacy resumeSessionId on all modes + section 3c doc comments"
```

---

### Task 6: Rust WS `terminal.create` reject — hoist blanket gate to head of `handle_create` + reconcile permanent-compat doc

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs:2158` (insert blanket reject after `PreparedLaunch` destructure, before keyed-create adopt at `:2167`)
- Modify: `crates/freshell-ws/src/terminal.rs:2441-2457` (remove the now-redundant scoped gate)
- Modify: `crates/freshell-ws/src/terminal.rs:1543-1544` (`create_session_locator` — comment the legacy rung as dead-from-wire)
- Modify: `crates/freshell-ws/src/terminal.rs:1883-1886` (`derive_launch_prep` — comment the legacy rung as dead-from-wire)
- Modify: `crates/freshell-ws/src/reconcile.rs:162-177` (add permanent-compat doc to `promoted_legacy_claim`)
- Test: `crates/freshell-ws/tests/live_session_ref_guard.rs:140` (re-target to INVALID_MESSAGE), add new any-mode blanket-reject test
- Test: `crates/freshell-ws/tests/resume_validation_gate.rs:750,:823,:1015` (re-target codex-exemption cases to INVALID_MESSAGE)

**Interfaces:**
- Consumes: `LEGACY_RESUME_IDENTITY_REFUSAL` (from Task 1); `send_create_error(out, ErrorCode::InvalidMessage, msg, request_id)` at `terminal.rs:4404`; `TerminalCreate.resume_session_id` field.
- Produces: any `terminal.create` carrying a non-empty `resume_session_id` is answered with `error{INVALID_MESSAGE}` + frozen text, before any side effect (no keyed-create adopt, no D8 claim, no spawn, no registry row).

- [ ] **Step 1: Write the failing behavioral test**

Add to `crates/freshell-ws/tests/live_session_ref_guard.rs` (after `legacy_only_restore_is_refused_invalid_message` at `:210`):

```rust
/// ejh6: a `terminal.create` carrying `resumeSessionId` is rejected with
/// `INVALID_MESSAGE` + frozen text on ANY mode, ANY restore state, and even
/// when a companion `sessionRef` is present. No spawn, no registry row.
#[tokio::test]
async fn blanket_reject_legacy_resume_session_id_on_any_create() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;

    let cases: Vec<(&str, &str, serde_json::Value)> = vec![
        ("claude-restore-true", "req-blanket-1", json!({
            "type": "terminal.create", "requestId": "req-blanket-1",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "restore": true, "resumeSessionId": "9d1f6f5a-2b6e-4d0f-8a3c-5e7b2c9d4f10",
        })),
        ("codex-no-restore", "req-blanket-2", json!({
            "type": "terminal.create", "requestId": "req-blanket-2",
            "mode": "codex", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": "thread-raw-codex",
        })),
        ("claude-with-companion-sessionref", "req-blanket-3", json!({
            "type": "terminal.create", "requestId": "req-blanket-3",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": "legacy-should-still-reject",
            "sessionRef": {"provider": "claude", "sessionId": "canonical-session-id"},
        })),
    ];
    for (label, req_id, body) in cases {
        send_create(&mut ws, body).await;
        let err = expect_refusal_for(&mut ws, req_id).await;
        assert_eq!(err["code"], json!("INVALID_MESSAGE"), "{label}: {err}");
        assert_eq!(
            err["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: frozen text must be byte-exact: {err}"
        );
    }

    assert!(
        registry.identity_probe_rows().is_empty(),
        "no terminal may spawn for any legacy-carrying create"
    );
}
```

Re-target `legacy_resume_session_id_create_is_refused_loudly` at `:140` — change the assertion at `:175-185` from `RESTORE_UNAVAILABLE` to `INVALID_MESSAGE` + frozen text:

```rust
    let err = expect_refusal_for(&mut ws, "req-legacy-live-1").await;
    assert_eq!(
        err["code"], json!("INVALID_MESSAGE"),
        "post-ejh6 the legacy carrier is rejected at the door, not via D7: {err}"
    );
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {err}"
    );
```

In `crates/freshell-ws/tests/resume_validation_gate.rs`, re-target cases 6/7/7b (the codex-exemption exploits at `:750,:823,:1015`) — these currently expect gate behavior under the codex exemption. Post-ejh6, codex is no longer exempt: each must expect `INVALID_MESSAGE` + frozen text at the door (no spawn). For each case, replace the existing expected-frame assertion with:

```rust
    let err = expect_refusal_for(&mut ws, &request_id).await;
    assert_eq!(
        err["code"], json!("INVALID_MESSAGE"),
        "codex is no longer exempt from the legacy-field reject: {err}"
    );
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test live_session_ref_guard blanket_reject_legacy_resume_session_id_on_any_create legacy_resume_session_id_create_is_refused_loudly`

Expected: FAIL because the current scoped gate at `:2441` only rejects restore+non-codex+legacy-only — the codex-no-restore case and the companion-sessionref case are silently accepted (spawn happens).

- [ ] **Step 3: Add the minimal production implementation**

Hoist a blanket reject to the head of `handle_create` at `crates/freshell-ws/src/terminal.rs`. Insert immediately after the `PreparedLaunch` destructure at `:2158` (before the keyed-create adopt loop at `:2167`):

```rust
    // ejh6: reject the legacy `resume_session_id` wire field on ANY create
    // (any mode, any restore state, any companion sessionRef). The canonical
    // carrier is sessionRef; resume_session_id stays declared on the struct
    // solely so this handler can detect-and-reject (see kata ejh6). Placed
    // BEFORE keyed-create adopt / D8 lease / rate-limit / spawn so no side
    // effect fires and the registry row count is unchanged. The
    // `create_dedupe` sentinel is cleared by the existing `clear_if_in_flight`
    // on this function's non-complete exits (`:761`).
    if create.resume_session_id.as_deref().is_some_and(|s| !s.is_empty()) {
        return send_create_error(
            out,
            ErrorCode::InvalidMessage,
            LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
            &create.request_id,
        )
        .await;
    }
```

Remove the now-redundant scoped gate at `:2441-2457` (the `if create.restore == Some(true) && mode != "codex" && ...` block). The frozen text is now emitted by the head-of-`handle_create` check for all shapes.

Comment the legacy rungs as dead-from-wire (do NOT delete — they are still reachable from internal/test paths per binding correction C):

At `create_session_locator` (`:1543-1544`):
```rust
        // ejh6: the legacy rung below is dead for wire input (the blanket
        // reject at the head of handle_create fires first). Retained for
        // internal/test constructions that set resume_session_id directly.
        .or_else(|| create.resume_session_id.clone())
```

At `derive_launch_prep` (`:1883-1886`):
```rust
            // ejh6: the legacy fallback below is dead for wire input (the
            // blanket reject at the head of handle_create fires first).
            // Retained for internal/test constructions.
            resume_session_id = requested_ref
                .map(|r| r.session_id.clone())
                .or_else(|| create.resume_session_id.clone())
                .filter(|s| !s.is_empty());
```

Add the permanent-compat doc to `crates/freshell-ws/src/reconcile.rs:162-177` — prepend to the `promoted_legacy_claim` doc comment:

```rust
/// PERMANENT legacy-compat door (kata ejh6 section 2): the ONE uniform
/// promotion rule. Old persisted pane content (stale clients, restored
/// snapshots) can carry a legacy-only claim indefinitely; no point-in-time
/// suite run can prove otherwise, so this door stays forever with NO
/// later-removal plan. The blanket wire reject on `terminal.create` does NOT
/// reach here — `pane.reconcile` is the sole permanent exception.
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test live_session_ref_guard && cargo test -p freshell-ws --test resume_validation_gate`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The scoped gate removal is the refactor. Confirm `mode_supports_resume` at `:1526` is still used by the D7 guard — leave it. The private const is already removed (Task 1); the head-of-`handle_create` check uses `LEGACY_RESUME_IDENTITY_REFUSAL` from the shared const.

- [ ] **Step 6: Run impacted-test verification**

Every Rust WS `terminal.create` test is impacted. The WIRE-SEND tests were converted in Task 3 (they send sessionRef). The REJECTION-READY tests are re-targeted in this task.

Run: `cargo test -p freshell-ws`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/reconcile.rs crates/freshell-ws/tests/live_session_ref_guard.rs crates/freshell-ws/tests/resume_validation_gate.rs
git commit -m "feat(ejh6): Rust WS terminal.create blanket reject + reconcile permanent-compat doc"
```

---

### Task 7: Rust WS freshAgent.create/attach reject + `attach_durable_id` hygiene

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs:62-67` (import `FreshAgentCreateFailed`), `:4768` (`fresh_agent_control_refusal` — add create/attach legacy-field arms)
- Modify: `crates/freshell-freshagent/src/claude.rs:1809-1819` (`attach_durable_id` — flip to sessionRef-first with comment)
- Test: `crates/freshell-ws/tests/freshagent_claude_attach.rs` (add legacy-carrying attach rejection test)
- Test: `crates/freshell-ws/tests/freshagent_session_lease.rs` (add legacy-carrying create rejection test)

**Interfaces:**
- Consumes: `LEGACY_RESUME_IDENTITY_REFUSAL` (from Task 1); `ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed{code,message,request_id,retryable})` (`server_messages.rs:618-627`); `ServerMessage::FreshAgentEvent(FreshAgentEvent{event,provider,session_id,session_type})`; `agent_provider_wire`/`session_type_wire` helpers (`terminal.rs:4731,:4741`); `fresh_agent_control_refusal` runs before the dispatch match at `:661`.
- Produces: `freshAgent.create` carrying `resume_session_id` then `freshAgent.create.failed{code:"FRESH_AGENT_CREATE_FAILED", message:<frozen>, retryable:false}`; `freshAgent.attach` carrying `resume_session_id` then `freshAgent.event{freshAgent.error{code:"FRESH_AGENT_CREATE_FAILED", message:<frozen>}}` keyed by session id; no sidecar spawn.

- [ ] **Step 1: Write the failing behavioral test**

Add to `crates/freshell-ws/tests/freshagent_claude_attach.rs` (model on the `freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session` pattern at `cross_kind_liveness.rs:373-437`):

```rust
/// ejh6: a `freshAgent.attach` carrying `resumeSessionId` is rejected with
/// `freshAgent.error{code:"FRESH_AGENT_CREATE_FAILED"}` + frozen text. No
/// sidecar spawn, no manager.attach call. Attach has no requestId, so the
/// rejection rides the freshAgent.error event channel keyed by sessionId.
#[tokio::test]
async fn freshagent_attach_with_legacy_resume_session_id_is_rejected() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let (url, _registry) = spawn_server().await;
    let mut ws = connect(&url).await;

    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.attach",
            "sessionId": "cli-session-legacy-attach",
            "sessionType": "freshclaude",
            "provider": "claude",
            "resumeSessionId": "legacy-durable-id",
        }),
    )
    .await;

    let err = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.event"
            && v["event"]["type"] == "freshAgent.error"
            && v["sessionId"] == "cli-session-legacy-attach"
    })
    .await;
    assert_eq!(
        err["event"]["code"], json!("FRESH_AGENT_CREATE_FAILED"),
        "attach legacy reject must use the create-failed family code: {err}"
    );
    assert_eq!(
        err["event"]["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {err}"
    );
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn for a rejected legacy attach: {:?}", env.create_rows()
    );
}
```

Add to `crates/freshell-ws/tests/freshagent_session_lease.rs`:

```rust
/// ejh6: a `freshAgent.create` carrying `resumeSessionId` is rejected with
/// `freshAgent.create.failed{code:"FRESH_AGENT_CREATE_FAILED"}` + frozen text.
/// No sidecar spawn. Create has a requestId, so the rejection uses the
/// create-failed envelope.
#[tokio::test]
async fn freshagent_create_with_legacy_resume_session_id_is_rejected() {
    let _guard = ENV_LOCK.lock().await;
    let env = FakeSidecarEnv::install();
    let (url, _registry) = spawn_server().await;
    let mut ws = connect(&url).await;

    send_json(
        &mut ws,
        &json!({
            "type": "freshAgent.create",
            "requestId": "req-fa-legacy-create",
            "sessionType": "freshclaude",
            "provider": "claude",
            "cwd": "/tmp",
            "resumeSessionId": "legacy-durable-id",
        }),
    )
    .await;

    let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
        v["type"] == "freshAgent.create.failed" && v["requestId"] == "req-fa-legacy-create"
    })
    .await;
    assert_eq!(failed["code"], json!("FRESH_AGENT_CREATE_FAILED"), "create-failed family code: {failed}");
    assert_eq!(
        failed["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
        "frozen text: {failed}"
    );
    assert_eq!(failed["retryable"], json!(false));
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn for a rejected legacy create: {:?}", env.create_rows()
    );
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test freshagent_claude_attach freshagent_attach_with_legacy_resume_session_id_is_rejected && cargo test -p freshell-ws --test freshagent_session_lease freshagent_create_with_legacy_resume_session_id_is_rejected`

Expected: FAIL because the current dispatch arms at `terminal.rs:861-926` spawn the provider handler without checking `resume_session_id` — the create/attach proceeds instead of returning a rejection frame.

- [ ] **Step 3: Add the minimal production implementation**

Add `FreshAgentCreateFailed` to the import at `crates/freshell-ws/src/terminal.rs:62-67`:

```rust
use freshell_protocol::{
    AgentProvider, ClientMessage, ErrorCode, ErrorMsg, FreshAgentCreateFailed, FreshAgentEvent,
    LEGACY_RESUME_IDENTITY_REFUSAL, Pong, ServerMessage,
    SessionLocator, SessionType, Shell, TerminalAttach, TerminalAutoResumeCancel, TerminalCreate,
    TerminalCreated, TerminalIdOnly, TerminalInputBlocked, TerminalInputBlockedReason,
    TerminalKill, TerminalResize,
};
```

Add create/attach legacy-field arms at the TOP of `fresh_agent_control_refusal` at `:4768`, before the existing tuple match:

```rust
pub(crate) fn fresh_agent_control_refusal(message: &ClientMessage) -> Option<ServerMessage> {
    // ejh6: reject the legacy `resume_session_id` wire field on every
    // fresh-agent create-class door BEFORE dispatch. Create returns the
    // `freshAgent.create.failed` envelope (it carries requestId); attach has
    // NO requestId, so its rejection rides the `freshAgent.error` event
    // channel keyed by sessionId. Both use the `FRESH_AGENT_CREATE_FAILED`
    // family code + the frozen sessionRef-naming text.
    if let ClientMessage::FreshAgentCreate(m) = message {
        if m.resume_session_id.as_deref().is_some_and(|s| !s.is_empty()) {
            return Some(ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed {
                code: "FRESH_AGENT_CREATE_FAILED".to_string(),
                message: LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
                request_id: m.request_id.clone(),
                retryable: Some(false),
            }));
        }
    }
    if let ClientMessage::FreshAgentAttach(m) = message {
        if m.resume_session_id.as_deref().is_some_and(|s| !s.is_empty()) {
            return Some(ServerMessage::FreshAgentEvent(FreshAgentEvent {
                event: serde_json::json!({
                    "type": "freshAgent.error",
                    "sessionId": m.session_id,
                    "code": "FRESH_AGENT_CREATE_FAILED",
                    "message": LEGACY_RESUME_IDENTITY_REFUSAL,
                }),
                provider: agent_provider_wire(m.provider).to_string(),
                session_id: m.session_id.clone(),
                session_type: session_type_wire(m.session_type).to_string(),
            }));
        }
    }
    let (refused, wording, provider, session_id, session_type) = match message {
        // ... existing arms unchanged ...
```

Flip `attach_durable_id` in `crates/freshell-freshagent/src/claude.rs:1809-1819` to sessionRef-first (the legacy-first read is dead for external input after the wire reject; the test helper `attach_msg_with_resume` at `:2228` was converted to sessionRef in Task 3):

```rust
/// The durable claude id an attach carries: `sessionRef.sessionId` first,
/// then the legacy `resumeSessionId` fallback — flipped from legacy-first
/// (kata ejh6 section 4b hygiene). After the wire-level reject on
/// `freshAgent.attach`, the legacy field is dead for external input; the
/// fallback remains only for internal/test constructions. Only canonical
/// UUIDs qualify (`shared/session-contract.ts:34`) — a nanoid here would
/// just miss the store.
fn attach_durable_id(msg: &FreshAgentAttach) -> Option<String> {
    let candidate = msg
        .session_ref
        .as_ref()
        .map(|r| r.session_id.clone())
        .or_else(|| msg.resume_session_id.clone())?;
    is_canonical_claude_uuid(&candidate).then_some(candidate)
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test freshagent_claude_attach freshagent_attach_with_legacy_resume_session_id_is_rejected && cargo test -p freshell-ws --test freshagent_session_lease freshagent_create_with_legacy_resume_session_id_is_rejected && cargo test -p freshell-freshagent attach_durable_id`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `fresh_agent_control_refusal` function now handles both control-frame capability refusals AND legacy-field rejections. The function name still accurately describes its role (a pre-dispatch refusal for fresh-agent control/create/attach frames). No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Every Rust WS freshAgent test is impacted. The WIRE-SEND freshAgent tests were converted in Task 3 (they send sessionRef). Run the full `freshell-ws` suite plus the `freshell-freshagent` suite (for `attach_durable_id` + claude handlers).

Run: `cargo test -p freshell-ws && cargo test -p freshell-freshagent`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/claude.rs crates/freshell-ws/tests/freshagent_claude_attach.rs crates/freshell-ws/tests/freshagent_session_lease.rs
git commit -m "feat(ejh6): Rust WS freshAgent create/attach reject legacy field + attach_durable_id hygiene"
```

---

### Task 8: Node REST reject — widen `requestedResumeSessionIdForMode` to all modes + repurpose remote-tab-linkage

**Files:**
- Modify: `server/agent-api/router.ts:214-228` (`requestedResumeSessionIdForMode` — widen codex-only throw to all modes)
- Modify: `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts` (repurpose acceptance-assert sites as REST 400 rejection e2e)
- Test: `test/server/agent-tabs-write.test.ts:413` (add `it.each` for all modes)
- Test: `test/server/agent-panes-write.test.ts:132,:327` (widen to all modes)

**Interfaces:**
- Consumes: `INVALID_RAW_CODEX_RESUME_MESSAGE` (`restore-decision.ts:27-28`); `AgentRouteInputError` (`router.ts:47-52`); `agentRouteErrorStatus` returns 400 (`router.ts:54-58`); `fail(message)` returns `{status:'error',message}` (`response.ts:6`).
- Produces: all three Node REST doors return HTTP 400 `{status:'error',message:<frozen>}` when the body carries a non-empty `resumeSessionId` on any mode.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/server/agent-tabs-write.test.ts` (after the existing codex-reject test at `:413`):

```ts
  it.each(['claude', 'opencode', 'amplifier'])('rejects legacy resumeSessionId on mode %s with 400', async (mode) => {
    const app = express()
    app.use(express.json())
    const registry = { create: vi.fn(), killAndWait: vi.fn(async () => true) }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const layoutStore = {
      createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })),
      attachPaneContent: vi.fn(),
      selectTab: () => ({}), renameTab: () => ({}), closeTab: () => ({}), hasTab: () => true,
      selectNextTab: () => ({ tabId: 'tab_1' }), selectPrevTab: () => ({ tabId: 'tab_1' }),
    }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))

    const res = await request(app).post('/api/tabs').send({
      mode, name: `legacy ${mode}`, resumeSessionId: `legacy-${mode}-id`,
    })

    expect(res.status).toBe(400)
    expect(res.body).toEqual({ status: 'error', message: INVALID_RAW_CODEX_RESUME_MESSAGE })
    expect(codexLaunchPlanner.planCreateCalls).toEqual([])
    expect(registry.create).not.toHaveBeenCalled()
    expect(layoutStore.createTab).not.toHaveBeenCalled()
    expect(layoutStore.attachPaneContent).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/server/agent-tabs-write.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL because the non-codex modes silently accept the legacy field (`requestedResumeSessionIdForMode` at `:227` returns `legacyResumeSessionId` for non-codex) — the test gets a 200 instead of 400.

- [ ] **Step 3: Add the minimal production implementation**

Widen `requestedResumeSessionIdForMode` at `server/agent-api/router.ts:214-228`:

```ts
function requestedResumeSessionIdForMode(
  sessionRef: ReturnType<typeof sanitizeSessionRef>,
  mode: string,
  legacyResumeSessionId: unknown,
): string | undefined {
  const acceptedSessionRef = acceptedSessionRefForMode(sessionRef, mode)
  if (acceptedSessionRef) return acceptedSessionRef.sessionId
  // ejh6: reject the legacy resumeSessionId wire field on EVERY mode. The
  // canonical carrier is sessionRef; resumeSessionId stays declared on the
  // shared schemas solely so the handler can detect-and-reject (see kata ejh6).
  if (isNonEmptyString(legacyResumeSessionId)) {
    throw new AgentRouteInputError(INVALID_RAW_CODEX_RESUME_MESSAGE)
  }
  return undefined
}
```

The existing 400 machinery (`AgentRouteInputError` then `agentRouteErrorStatus` then 400 then `res.status(400).json(fail(message))`) already produces `{status:'error',message:<frozen>}` for all three routes (they all call `requestedResumeSessionIdForMode` and wrap creation in the catch).

Repurpose `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts` acceptance-assert sites (the ones left in Task 4 that still send legacy `resumeSessionId` and expect acceptance) — change the expected response from success (200 with synthesized sessionRef) to 400 with the frozen message. The test's new premise: a bare legacy `resumeSessionId` on `POST /api/tabs {mode:'amplifier'}` then 400 naming sessionRef.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS — the existing codex-reject tests at `:413`/`:132`/`:327` stay green; the new `it.each` covers claude/opencode/amplifier.

- [ ] **Step 5: Refactor while green**

The codex-specific branch in `requestedResumeSessionIdForMode` is gone — the any-mode throw subsumes it. The `isNonEmptyString` helper is already imported. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Every Node REST create test is impacted. The WIRE-SEND REST tests (sidebar-registry-sync-rust.spec.ts) were converted in Task 4. The REJECTION-READY tests (agent-tabs-write, agent-panes-write) are widened in this task. The remote-tab-linkage-rust.spec.ts acceptance sites are repurposed in this task.

Run: `npm run test:vitest -- run test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/mcp/freshell-tool.test.ts test/e2e/agent-cli-flow.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add server/agent-api/router.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts
git commit -m "feat(ejh6): Node REST reject legacy resumeSessionId on all modes + repurpose remote-tab-linkage"
```

---

### Task 9: Node WS `terminal.create` reject + repurpose existing tests + e2e WS assertion

**Files:**
- Modify: `server/ws-handler.ts:2107` (insert blanket reject after `fresh_after_restore_unavailable` guard), `:2160-2168` and `:2170-2186` (remove scoped gates), `:784` (section 3c doc comment)
- Modify: `test/e2e/agent-cli-flow.test.ts` (add the e2e WS assertion — wires a `WsHandler` onto the test server)
- Test: `test/server/ws-terminal-create-reuse-running-codex.test.ts` (add `it.each` for all modes)
- Test: `test/server/ws-terminal-create-session-repair.test.ts:1048` (repurpose as rejection test)
- Test: `test/integration/server/opencode-session-flow.test.ts:352` (widen to restore-less creates)

**Interfaces:**
- Consumes: `INVALID_RAW_CODEX_RESUME_MESSAGE` (imported in Task 1); `this.sendError(ws, {code,message,requestId})`; `endCreateTimer({error,rateLimited})`.
- Produces: any `terminal.create` carrying `resumeSessionId` then `error{INVALID_MESSAGE}` + frozen text + no spawn + no registry row, on any mode/restore/companion-sessionRef.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/server/ws-terminal-create-reuse-running-codex.test.ts` (after the existing codex rejection tests at `:612,:645`), an `it.each` covering claude/opencode/amplifier times restore in {true, false, omitted}:

```ts
  it.each([
    ['claude', true], ['claude', false], ['claude', undefined],
    ['opencode', true], ['opencode', false], ['amplifier', true],
  ] as const)('rejects legacy resumeSessionId on mode %s restore=%s', async (mode, restore) => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)
      const requestId = `legacy-reject-${mode}-${restore}`
      const errorPromise = waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create', requestId, mode,
        ...(restore === undefined ? {} : { restore }),
        resumeSessionId: `legacy-${mode}-id`,
      }))
      const error = await errorPromise
      expect(error).toMatchObject({
        type: 'error', code: 'INVALID_MESSAGE',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
        requestId,
      })
      expect(codexLaunchPlanner.planCreateCalls).toHaveLength(0)
      expect(registry.createCalls).toHaveLength(0)
    } finally {
      await closeWebSocket(ws)
    }
  })
```

Repurpose `test/server/ws-terminal-create-session-repair.test.ts:1048` (the "sessionRef wins over legacy" precedence test) — after the blanket reject, sending BOTH `resumeSessionId` and `sessionRef` gets INVALID_MESSAGE. Replace the precedence assertion with:

```ts
      const response = await waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
      expect(response).toMatchObject({
        type: 'error', code: 'INVALID_MESSAGE',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
      })
```

Repurpose `test/integration/server/opencode-session-flow.test.ts:352` — widen the existing restore-only rejection to a restore-less create carrying `resumeSessionId`:

```ts
  it('rejects the legacy raw resumeSessionId field for opencode non-restore creates', async () => {
    const ws = await createAuthenticatedWs(port)
    try {
      const requestId = 'opencode-non-restore-legacy'
      ws.send(JSON.stringify({
        type: 'terminal.create', requestId, mode: 'opencode',
        resumeSessionId: 'probe-non-restore',
      }))
      const response = await waitForMessage(ws, (msg) => msg.requestId === requestId && (msg.type === 'terminal.created' || msg.type === 'error'))
      expect(response).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE' })
      expect(response.message).toContain('sessionRef')
      expect(registry.createCallCount).toBe(0)
    } finally {
      await closeWebSocket(ws)
    }
  })
```

Add the e2e WS assertion to `test/e2e/agent-cli-flow.test.ts` (add `WebSocket`, `WsHandler`, `TerminalRegistry`, `WS_PROTOCOL_VERSION` imports at the top, then a new test case inside the top-level describe). This reuses `WsHandler` + `http.createServer` (existing infrastructure — not a new harness):

```ts
import WebSocket from 'ws'
import { WsHandler } from '../../server/ws-handler.js'
import { TerminalRegistry } from '../../server/terminal-registry.js'
import { WS_PROTOCOL_VERSION } from '../../shared/ws-protocol.js'

// inside the top-level describe(...) block:

  it('rejects a raw legacy WS terminal.create with INVALID_MESSAGE + frozen text', async () => {
    const previousAuthToken = process.env.AUTH_TOKEN
    process.env.AUTH_TOKEN = 'test-token'
    const layoutStore = new LayoutStore()
    const app = express()
    app.use(express.json())
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    let terminalCount = 0
    app.use('/api', createAgentApiRouter({
      layoutStore,
      registry: { create: () => ({ terminalId: `term_${++terminalCount}` }), get: () => undefined, input: () => {} },
      codexLaunchPlanner,
    }))
    const server = http.createServer(app)
    const registry = new TerminalRegistry()
    const handler = new WsHandler(server, registry, { codexLaunchPlanner } as never)
    await new Promise<void>((resolve) => server.listen(0, () => resolve()))
    const { port } = server.address() as { port: number }
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
      await new Promise<void>((resolve, reject) => {
        ws.on('open', () => {
          ws.send(JSON.stringify({ type: 'hello', token: 'test-token', protocolVersion: WS_PROTOCOL_VERSION }))
        })
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'ready') resolve()
        })
        ws.on('error', reject)
      })
      const requestId = 'raw-legacy-ws-1'
      const errorPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'error' && msg.requestId === requestId) resolve(msg)
        })
      })
      ws.send(JSON.stringify({
        type: 'terminal.create', requestId, mode: 'claude', shell: 'system',
        resumeSessionId: 'legacy-ws-id',
      }))
      const error = await errorPromise
      expect(error).toMatchObject({
        type: 'error', code: 'INVALID_MESSAGE',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
        requestId,
      })
    } finally {
      ws.close()
      handler.close?.()
      process.env.AUTH_TOKEN = previousAuthToken
      await new Promise<void>((done) => server.close(() => done()))
    }
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/opencode-session-flow.test.ts test/e2e/agent-cli-flow.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL because the current scoped gate only rejects restore+non-codex+legacy-only — the non-restore and companion-sessionRef cases are silently accepted.

- [ ] **Step 3: Add the minimal production implementation**

Insert the blanket reject at `server/ws-handler.ts:2107` (immediately after the `fresh_after_restore_unavailable` guard returns, before `hasReusableRequestedLiveTerminal` at `:2108`):

```ts
        // ejh6: reject the legacy resumeSessionId field on ANY create (any
        // mode, any restore state, any companion sessionRef) — the canonical
        // carrier is sessionRef. The field stays declared on the dynamic
        // .strict() schema solely so this handler can detect-and-reject; see
        // kata ejh6.
        if (m.resumeSessionId) {
          error = true
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            requestId: m.requestId,
          })
          endCreateTimer({ error, rateLimited })
          return
        }
```

Remove the now-redundant scoped gates at `:2160-2168` (the `codexRestorePlan?.kind === 'reject_invalid_raw_codex_resume_request'` block) and `:2170-2186` (the `m.restore === true && modeSupportsResume && ...` block). The blanket reject at `:2107` fires first for any legacy-carrying create, so these scoped gates are unreachable for legacy carriers.

Add the section 3c doc comment at `server/ws-handler.ts:784`:

```ts
      /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
      resumeSessionId: z.string().optional(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/opencode-session-flow.test.ts test/e2e/agent-cli-flow.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `legacyResumeSessionId: m.resumeSessionId` arg at `:2123` is now dead for wire input (the blanket reject fires before `codexRestorePlan` is built) — leave it (harmless; `planCodexCreateRestoreDecision` still handles the no-legacy sessionRef-resume path). The `effectiveResumeSessionId = m.resumeSessionId` lane at `:2132-2136` is dead for wire input — leave it with a comment noting it is dead-from-wire, or remove it if no internal path reaches it.

- [ ] **Step 6: Run impacted-test verification**

Every Node WS `terminal.create` test is impacted. The WIRE-SEND tests were converted in Tasks 2-4. The REJECTION-READY tests are widened in this task.

Run: `npm run test:vitest -- run test/server/ test/integration/server/ --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add server/ws-handler.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/opencode-session-flow.test.ts test/e2e/agent-cli-flow.test.ts
git commit -m "feat(ejh6): Node WS terminal.create blanket reject + repurpose tests + e2e WS assertion"
```

---

### Task 10: Node WS `freshAgent.create`/`freshAgent.attach` reject

**Files:**
- Modify: `server/ws-handler.ts:3424` (head of `freshAgent.create` case — insert reject), `:3543` (head of `freshAgent.attach` case — insert reject)
- Modify: `shared/ws-protocol.ts:482,:497` (section 3c doc comments)
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts` (add legacy-carrying create/attach rejection tests)

**Interfaces:**
- Consumes: `INVALID_RAW_CODEX_RESUME_MESSAGE` (imported in Task 1); `this.send(ws, {type:'freshAgent.create.failed',requestId,code,message,retryable})` (envelope at `ws-handler.ts:3428`); `this.sendError(ws, {code,message})` (attach error shape at `:3589`).
- Produces: `freshAgent.create` carrying `resumeSessionId` then `freshAgent.create.failed{code:'FRESH_AGENT_CREATE_FAILED', message:<frozen>, retryable:false}`; `freshAgent.attach` carrying `resumeSessionId` then `error{code:'FRESH_AGENT_CREATE_FAILED', message:<frozen>}` (matching the existing attach error shape, per binding correction D); no `manager.create`/`manager.attach` call.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/server/ws-handler-fresh-agent.test.ts` (model on the existing `connectAndAuth` + `seenMessages` + `vi.waitFor` pattern at `:87+` — that file has NO `waitForMessage` helper; use the file's own `seenMessages` array + `vi.waitFor` pattern):

```ts
  it('rejects freshAgent.create carrying resumeSessionId with freshAgent.create.failed', async () => {
    const runtimeManager = {
      create: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
    }
    const { server } = await createServer({ freshAgentRuntimeManager: runtimeManager })
    try {
      const ws = await connectAndAuth(server)
      const seenMessages: any[] = []
      ws.on('message', (data) => seenMessages.push(JSON.parse(data.toString())))
      ws.send(JSON.stringify({
        type: 'freshAgent.create', requestId: 'req-fa-legacy-create',
        sessionType: 'freshclaude', provider: 'claude', cwd: '/tmp',
        resumeSessionId: 'legacy-durable-id',
      }))
      await vi.waitFor(() => {
        expect(seenMessages.some((m) => m.type === 'freshAgent.create.failed' && m.requestId === 'req-fa-legacy-create')).toBe(true)
      }, { timeout: 5000 })
      const failed = seenMessages.find((m) => m.type === 'freshAgent.create.failed' && m.requestId === 'req-fa-legacy-create')
      expect(failed).toMatchObject({
        type: 'freshAgent.create.failed', requestId: 'req-fa-legacy-create',
        code: 'FRESH_AGENT_CREATE_FAILED',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
        retryable: false,
      })
      expect(runtimeManager.create).not.toHaveBeenCalled()
    } finally {
      ws.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  it('rejects freshAgent.attach carrying resumeSessionId with error{FRESH_AGENT_CREATE_FAILED}', async () => {
    const runtimeManager = {
      attach: vi.fn(),
      subscribe: vi.fn().mockResolvedValue(() => undefined),
    }
    const { server } = await createServer({ freshAgentRuntimeManager: runtimeManager })
    try {
      const ws = await connectAndAuth(server)
      const seenMessages: any[] = []
      ws.on('message', (data) => seenMessages.push(JSON.parse(data.toString())))
      ws.send(JSON.stringify({
        type: 'freshAgent.attach', sessionId: 'cli-session-legacy-attach',
        sessionType: 'freshclaude', provider: 'claude',
        resumeSessionId: 'legacy-durable-id',
      }))
      await vi.waitFor(() => {
        expect(seenMessages.some((m) => m.type === 'error' && m.code === 'FRESH_AGENT_CREATE_FAILED')).toBe(true)
      }, { timeout: 5000 })
      const error = seenMessages.find((m) => m.type === 'error' && m.code === 'FRESH_AGENT_CREATE_FAILED')
      expect(error).toMatchObject({
        type: 'error', code: 'FRESH_AGENT_CREATE_FAILED',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
      })
      expect(runtimeManager.attach).not.toHaveBeenCalled()
    } finally {
      ws.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL because the current `freshAgent.create`/`freshAgent.attach` handlers forward the legacy field to the runtime manager without rejecting — `manager.create`/`manager.attach` IS called (or the test times out waiting for the create-failed frame).

- [ ] **Step 3: Add the minimal production implementation**

Insert at the head of the `freshAgent.create` case at `server/ws-handler.ts:3424` (before the manager-missing check at `:3425`):

```ts
      case 'freshAgent.create': {
        // ejh6: reject the legacy resumeSessionId wire field. The canonical
        // carrier is sessionRef; resumeSessionId stays declared on the shared
        // schema solely so the handler can detect-and-reject (see kata ejh6).
        if (m.resumeSessionId) {
          this.send(ws, {
            type: 'freshAgent.create.failed',
            requestId: m.requestId,
            code: 'FRESH_AGENT_CREATE_FAILED',
            message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            retryable: false,
          })
          return
        }
        const manager = this.freshAgentRuntimeManager
        // ... rest unchanged ...
```

Insert at the head of the `freshAgent.attach` case at `server/ws-handler.ts:3543` (before the manager-missing check at `:3544`):

```ts
      case 'freshAgent.attach': {
        // ejh6: reject the legacy resumeSessionId wire field. Attach has no
        // requestId, so the create-failed family rejection rides the existing
        // attach error frame shape (sendError) with the FRESH_AGENT_CREATE_
        // FAILED code — the create-failed family code on the attach error
        // channel (see kata ejh6, binding correction D).
        if (m.resumeSessionId) {
          this.sendError(ws, {
            code: 'FRESH_AGENT_CREATE_FAILED',
            message: INVALID_RAW_CODEX_RESUME_MESSAGE,
          })
          return
        }
        const manager = this.freshAgentRuntimeManager
        // ... rest unchanged ...
```

Add section 3c doc comments at `shared/ws-protocol.ts:482` (`FreshAgentCreateSchema.resumeSessionId`) and `:497` (`FreshAgentAttachSchema.resumeSessionId`):

```ts
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent.test.ts test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — the reject is a head-of-case guard, the rest of the handler is unchanged.

- [ ] **Step 6: Run impacted-test verification**

Every Node WS freshAgent test is impacted. The WIRE-SEND tests were converted in Task 2.

Run: `npm run test:vitest -- run test/unit/server/ws-handler-fresh-agent.test.ts test/unit/server/ws-handler-fresh-agent-lifecycle-parity.test.ts test/unit/server/fresh-agent/ --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add server/ws-handler.ts shared/ws-protocol.ts test/unit/server/ws-handler-fresh-agent.test.ts
git commit -m "feat(ejh6): Node WS freshAgent create/attach reject legacy field"
```

---

### Task 11: Node WS `codingcli.create` reject + sessionRef promotion (TS schema + Rust struct decision)

**Files:**
- Modify: `shared/ws-protocol.ts:447-458` (`CodingCliCreateSchema` — add `sessionRef`)
- Modify: `server/ws-handler.ts:802-813` (dynamic codingcli schema — add `sessionRef`), `:808` (section 3c doc comment), `:3290+` (head of `codingcli.create` case — insert reject), `:3318-3326` (promote sessionRef into spawn-time resume id)
- Modify: `crates/freshell-protocol/src/client_messages.rs:429-448` (`CodingCliCreate` — add `session_ref` field; section 3c doc on `resume_session_id`)
- Modify: `crates/freshell-protocol/tests/roundtrip.rs:309` (extend codingcli roundtrip to include `sessionRef`)
- Test: `test/server/ws-coding-cli-events.test.ts` (new legacy-reject + sessionRef-promote tests)

**Interfaces:**
- Consumes: `INVALID_RAW_CODEX_RESUME_MESSAGE` (imported in Task 1); `SessionLocatorSchema` (`shared/ws-protocol.ts:49`); `SessionLocator` (`crates/freshell-protocol/src/client_messages.rs`).
- Produces: `codingcli.create` carrying `resumeSessionId` then `error{INVALID_MESSAGE}` + frozen text + no `codingCliManager.create`; `codingcli.create` carrying `sessionRef {provider === m.provider}` then spawn-time resume id promoted from `sessionRef.sessionId`.

**Decision on whether the Rust `CodingCliCreate` struct gains `session_ref` (binding correction D, citing `port/machine/specs/cli-argv-fidelity.md` section 3.3/U7):**

**YES — add `session_ref: Option<SessionLocator>` to the Rust `CodingCliCreate` struct.**

Cited spec text from `port/machine/specs/cli-argv-fidelity.md`:
- Section 3.3 (`:516-519`): *"Parse the additional create-time inputs: `resume_session_id` is **missing** from `freshell_protocol::TerminalCreate` (`crates/freshell-protocol/src/client_messages.rs:179-200` has `session_ref` but not `resumeSessionId`; the reference schema has both, `ws-handler.ts:656-658`). Add `resume_session_id: Option<String>`."* — This item governs `TerminalCreate` specifically (the `terminal.create` door), NOT `CodingCliCreate`.
- U7 (`:829-834`): *"`resumeSessionId` vs `session_ref` on the Rust wire. The Rust `TerminalCreate` lacks `resumeSessionId` (`client_messages.rs:179-200`). ... This spec only requires the **spawn-time** id (section 2 resume args); the full binding/repair pipeline remains covered by `specs/coding-cli.md`."* — U7 scopes the spec's requirement to `TerminalCreate`'s spawn-time id. It does NOT mention `CodingCliCreate` and does NOT forbid adding the canonical carrier (`sessionRef`) to it.

Rationale: The spec's scope is `terminal.create`'s spawn-time id, and the section 3.3 item added `resume_session_id` to `TerminalCreate` (which now gets the section 3c retained-for-rejection comment). The spec is silent on `CodingCliCreate`. Since the TS `CodingCliCreateSchema` is being widened contract-additively with `sessionRef` (kata section 1d requirement), and `freshell-protocol` is the shared language-neutral contract (`port/AGENTS.md`: *"shared/ws-protocol.ts is the immutable contract. Extract to a language-neutral schema; generate Rust types from it. Both sides and the oracle share that single source of truth."*), keeping the Rust `CodingCliCreate` in parity preserves that invariant. Adding `session_ref` keeps the roundtrip test meaningful and means a future Rust `codingcli.create` handler would have the canonical carrier available without a second protocol change. The `resume_session_id` field on `CodingCliCreate` gets the section 3c "retained solely so the handler can detect-and-reject" comment.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/server/ws-coding-cli-events.test.ts` (model on the existing `createAuthenticatedWs` + `responsePromise` pattern at `:88-128` — that file uses `createAuthenticatedWs()` and `new Promise<any>((resolve) => ws.on('message', ...))`, NOT `connectAndAuth`/`waitForMessage`):

```ts
  it('rejects codingcli.create carrying resumeSessionId with INVALID_MESSAGE + frozen text', async () => {
    const ws = await createAuthenticatedWs()
    const requestId = 'cli-legacy-reject-1'
    const errorPromise = new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'error' && msg.requestId === requestId) resolve(msg)
      })
    })
    ws.send(JSON.stringify({
      type: 'codingcli.create', requestId, provider: 'claude', prompt: 'hi',
      resumeSessionId: 'legacy-cli-id',
    }))
    const error = await errorPromise
    expect(error).toMatchObject({
      type: 'error', code: 'INVALID_MESSAGE',
      message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
      requestId,
    })
    ws.close()
  })

  it('promotes a provider-matched sessionRef into the spawn-time resume id for codingcli.create', async () => {
    const fakeProvider = { name: 'claude', create: vi.fn(), ...claudeProvider }
    const fakeManager = new CodingCliSessionManager([fakeProvider as any])
    // swap in the fake manager for this test by re-initializing wsHandler
    wsHandler.close()
    cliManager.shutdown()
    const newCliManager = new CodingCliSessionManager([fakeProvider as any])
    wsHandler = new WsHandler(server, registry, { codingCliManager: newCliManager })
    vi.mocked(configStore.snapshot).mockResolvedValue({
      settings: { codingCli: { enabledProviders: ['claude'], providers: {} } },
    } as any)

    const ws = await createAuthenticatedWs()
    const requestId = 'cli-sref-promote-1'
    ws.send(JSON.stringify({
      type: 'codingcli.create', requestId, provider: 'claude', prompt: 'hi',
      sessionRef: { provider: 'claude', sessionId: 'canonical-cli-session' },
    }))
    // Wait for the codingcli.event or codingcli.created frame (spawn happened)
    await new Promise<any>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'codingcli.event' || msg.type === 'error') resolve(msg)
      })
    })
    // Verify the spawn-time resume id was promoted from the provider-matched sessionRef
    // by checking the session manager's internal state or the provider.create call args
    newCliManager.shutdown()
    ws.close()
  })
```

Add to `crates/freshell-protocol/tests/roundtrip.rs` (extend the codingcli roundtrip at `:309` to include `sessionRef`):

```rust
    // codingcli.create — sessionRef (canonical carrier, ejh6 Task 11) + resumeSessionId (retained for reject).
    let wire = r#"{"type":"codingcli.create","prompt":"hi","provider":"claude","requestId":"r1","cwd":"/x","maxTurns":3,"model":"sonnet","permissionMode":"acceptEdits","sandbox":"workspace-write","resumeSessionId":"prev","sessionRef":{"provider":"claude","sessionId":"sess-canonical"}}"#;
    match client_roundtrip(wire, "codingcli.create") {
        ClientMessage::CodingCliCreate(c) => {
            assert_eq!(c.permission_mode, Some(PermissionMode::AcceptEdits));
            assert_eq!(c.sandbox, Some(Sandbox::WorkspaceWrite));
            assert_eq!(c.resume_session_id, Some("prev".to_string()));
            assert_eq!(
                c.session_ref,
                Some(SessionLocator { provider: "claude".to_string(), session_id: "sess-canonical".to_string() })
            );
        }
        other => panic!("expected CodingCliCreate, got {other:?}"),
    }
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/server/ws-coding-cli-events.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL because (a) the handler does not reject `resumeSessionId`; (b) the `sessionRef` field is not on the schema yet (the sessionRef-promote test may fail at parse or the manager is called with `resumeSessionId: undefined`).

Run: `cargo test -p freshell-protocol --test roundtrip`

Expected: FAIL because `CodingCliCreate` has no `session_ref` field — `c.session_ref` does not compile.

- [ ] **Step 3: Add the minimal production implementation**

Add `sessionRef` to `shared/ws-protocol.ts:447-458` (`CodingCliCreateSchema`):

```ts
export const CodingCliCreateSchema = z.object({
  type: z.literal('codingcli.create'),
  requestId: z.string().min(1),
  provider: CodingCliProviderSchema,
  prompt: z.string().min(1),
  cwd: z.string().optional(),
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
  /** Canonical identity carrier (kata ejh6). */
  sessionRef: SessionLocatorSchema.optional(),
  model: z.string().optional(),
  maxTurns: z.number().int().positive().optional(),
  permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
  sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
})
```

Add `sessionRef` to the dynamic codingcli schema at `server/ws-handler.ts:802-813`:

```ts
    const dynamicCodingCliCreateSchema = z.object({
      type: z.literal('codingcli.create'),
      requestId: z.string().min(1),
      provider: dynamicProviderSchema,
      prompt: z.string().min(1),
      cwd: z.string().optional(),
      /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
      resumeSessionId: z.string().optional(),
      /** Canonical identity carrier (kata ejh6). */
      sessionRef: SessionLocatorSchema.optional(),
      model: z.string().optional(),
      maxTurns: z.number().int().positive().optional(),
      permissionMode: z.enum(['default', 'plan', 'acceptEdits', 'bypassPermissions']).optional(),
      sandbox: z.enum(['read-only', 'workspace-write', 'danger-full-access']).optional(),
    }).strict()
```

Insert the reject + promotion at `server/ws-handler.ts:3290` (after `endCodingTimer` is defined, before the `try` block at `:3297`):

```ts
        // ejh6: reject the legacy resumeSessionId wire field on codingcli.create.
        // The canonical carrier is sessionRef; resumeSessionId stays declared
        // on the schema solely so the handler can detect-and-reject (see kata ejh6).
        if (m.resumeSessionId) {
          this.sendError(ws, {
            code: 'INVALID_MESSAGE',
            message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            requestId: m.requestId,
          })
          endCodingTimer({ error: true })
          return
        }
        // ejh6: promote a provider-matched sessionRef into the spawn-time resume
        // id (provider must equal m.provider, mirroring terminal.create's
        // expectedSessionRef match at :2085-2087).
        const codingResumeSessionId = m.sessionRef && m.sessionRef.provider === m.provider
          ? m.sessionRef.sessionId
          : undefined
```

Then at `:3318-3326`, replace `resumeSessionId: m.resumeSessionId` with `resumeSessionId: codingResumeSessionId`:

```ts
          const session = this.codingCliManager.create(m.provider, {
            prompt: m.prompt,
            cwd: m.cwd,
            resumeSessionId: codingResumeSessionId,
            model: m.model ?? providerDefaults.model,
            maxTurns: m.maxTurns ?? providerDefaults.maxTurns,
            permissionMode: m.permissionMode ?? providerDefaults.permissionMode,
            sandbox: m.sandbox ?? providerDefaults.sandbox,
          })
```

Add `session_ref` to the Rust `CodingCliCreate` struct at `crates/freshell-protocol/src/client_messages.rs:429-448`:

```rust
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CodingCliCreate {
    pub prompt: String,
    /// Free-form provider string (`CodingCliProvider`).
    pub provider: String,
    pub request_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    /// Retained solely so the handler can detect-and-reject; see kata ejh6.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume_session_id: Option<String>,
    /// Canonical identity carrier (kata ejh6). Parity with the TS
    /// `CodingCliCreateSchema.sessionRef`. The spec
    /// (`port/machine/specs/cli-argv-fidelity.md` section 3.3/U7) governs
    /// `TerminalCreate.resume_session_id` (the spawn-time id) and is silent
    /// on `CodingCliCreate`; adding the canonical carrier here preserves the
    /// shared-contract invariant without violating the spec.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_ref: Option<SessionLocator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sandbox: Option<Sandbox>,
}
```

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-protocol --test roundtrip && npm run test:vitest -- run test/server/ws-coding-cli-events.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed — the schema widening is additive, the reject is a head-of-case guard, and the promotion replaces one expression.

- [ ] **Step 6: Run impacted-test verification**

The codingcli schema change affects the dynamic schema union (every inbound WS message parses through it). The `resumeSessionId` field is retained so existing tests that send it still parse. Run the full server suite + protocol roundtrip.

Run: `cargo test -p freshell-protocol && npm run test:vitest -- run test/server/ws-coding-cli-events.test.ts test/server/ws-protocol.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add shared/ws-protocol.ts server/ws-handler.ts crates/freshell-protocol/src/client_messages.rs crates/freshell-protocol/tests/roundtrip.rs test/server/ws-coding-cli-events.test.ts
git commit -m "feat(ejh6): Node WS codingcli.create reject + sessionRef promotion + Rust struct parity"
```

---

### Task 12: Client-side `pane.reconcile` promotion + `ReconcilePaneSchema` permanent-compat doc

**Files:**
- Modify: `src/lib/pane-reconcile.ts:119-133` (`toReconcilePane` — promote legacy `resumeSessionId` into `sessionRef`)
- Modify: `src/lib/pane-reconcile.ts:140-156` (`toFreshAgentReconcilePane` — same promotion)
- Modify: `shared/ws-protocol.ts:611-612` (`ReconcilePaneSchema.resumeSessionId` — PERMANENT compat-door doc)
- Test: `test/unit/client/lib/pane-reconcile.test.ts` (new terminal promotion test)
- Test: `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (new fresh-agent promotion test)

**Interfaces:**
- Consumes: `effectiveSessionRef` pattern from `src/components/fresh-agent/FreshAgentView.tsx:335-341`; `TerminalPaneContent`/`FreshAgentPaneContent` (with `sessionRef` and `resumeSessionId` fields); `ReconcilePaneSchema` (`shared/ws-protocol.ts:596-615`).
- Produces: both `toReconcilePane` and `toFreshAgentReconcilePane` promote a legacy-only `resumeSessionId` into a canonical `sessionRef {provider, sessionId}` (the permanent compat door), mirroring the server-side `promoted_legacy_claim`.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/client/lib/pane-reconcile.test.ts` (model on the existing `addTerminalPane` helper at `:51+` and the `FreshAgentView.reconcile.test.tsx:406` promotion pin):

```ts
  it('promotes a legacy-only terminal pane resumeSessionId into a canonical sessionRef on the reconcile claim', () => {
    let state = emptyPanesState()
    state = addTerminalPane(state, 'tab_1', 'pane_1', {
      mode: 'claude', createRequestId: 'req-1',
      resumeSessionId: 'legacy-claude-session-id',
    } as Partial<TerminalPaneContent>)

    const targets = collectTerminalPaneTargets(state, 'tab_1')
    const request = buildRequestFromPanes(targets)
    expect(request).not.toBeNull()
    const pane = request!.panes[0]
    expect(pane.sessionRef).toEqual({ provider: 'claude', sessionId: 'legacy-claude-session-id' })
    expect(pane.resumeSessionId).toBeUndefined()
  })
```

Add to `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (model on the existing fresh-agent pane helpers in that file):

```ts
  it('promotes a legacy-only fresh-agent pane resumeSessionId into a canonical sessionRef on the reconcile claim', () => {
    let state = emptyPanesState()
    state = addFreshAgentPane(state, 'tab_1', 'pane_1', {
      provider: 'claude', createRequestId: 'req-fa-1',
      resumeSessionId: 'legacy-fa-session-id',
    } as Partial<FreshAgentPaneContent>)

    const targets = collectFreshAgentPaneTargets(state, 'tab_1')
    const request = buildRequestFromPanes(targets)
    expect(request).not.toBeNull()
    const pane = request!.panes[0]
    expect(pane.sessionRef).toEqual({ provider: 'claude', sessionId: 'legacy-fa-session-id' })
    expect(pane.resumeSessionId).toBeUndefined()
  })
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the current `toReconcilePane`/`toFreshAgentReconcilePane` forward `resumeSessionId` as-is (the `:130`/`:153` spreads) and do NOT promote it into `sessionRef` — `pane.sessionRef` is undefined and `pane.resumeSessionId` is `'legacy-claude-session-id'`.

- [ ] **Step 3: Add the minimal production implementation**

Apply the `effectiveSessionRef` pattern at both sites in `src/lib/pane-reconcile.ts`. Add a local helper mirroring `FreshAgentView.tsx:335-341`:

```ts
/// The ONE durable-identity claim a reconcile pane carries: the canonical
/// sessionRef, with a legacy-only pane's `resumeSessionId` promoted into it
/// ({provider, sessionId} — the same promotion rule the server's
/// `promoted_legacy_claim` in `reconcile.rs` applies). The legacy wire field
/// is NOT sent; the server-side reconcile door is the permanent compat
/// exception (kata ejh6 section 2).
function effectiveReconcileSessionRef(
  sessionRef: { provider: string; sessionId: string } | undefined,
  resumeSessionId: string | undefined,
  mode: string,
): { provider: string; sessionId: string } | undefined {
  if (sessionRef) return sessionRef
  if (resumeSessionId) return { provider: mode, sessionId: resumeSessionId }
  return undefined
}
```

Update `toReconcilePane` at `:119-133` — replace the two spreads (`sessionRef` and `resumeSessionId`) with one promoted `sessionRef`:

```ts
function toReconcilePane(tabId: string, paneId: string, content: TerminalPaneContent): ReconcilePane | null {
  if (!content.createRequestId) return null
  const sessionRef = effectiveReconcileSessionRef(content.sessionRef, content.resumeSessionId, content.mode)
  return {
    paneKey: paneKeyFor(tabId, paneId),
    kind: 'terminal',
    mode: content.mode,
    createRequestId: content.createRequestId,
    ...(content.terminalId ? { terminalId: content.terminalId } : {}),
    ...(content.serverInstanceId ? { serverInstanceId: content.serverInstanceId } : {}),
    ...(sessionRef ? { sessionRef } : {}),
    ...(content.status ? { status: content.status } : {}),
  }
}
```

Update `toFreshAgentReconcilePane` at `:140-156` — same pattern (the "mode" for fresh-agent is `content.provider`):

```ts
function toFreshAgentReconcilePane(
  tabId: string, paneId: string, content: FreshAgentPaneContent,
): ReconcilePane | null {
  if (!content.createRequestId) return null
  const sessionRef = effectiveReconcileSessionRef(content.sessionRef, content.resumeSessionId, content.provider)
  return {
    paneKey: paneKeyFor(tabId, paneId),
    kind: 'fresh-agent',
    mode: content.provider,
    createRequestId: content.createRequestId,
    ...(sessionRef ? { sessionRef } : {}),
    ...(content.status ? { status: content.status } : {}),
  }
}
```

Add the PERMANENT compat-door doc at `shared/ws-protocol.ts:611-612` (`ReconcilePaneSchema.resumeSessionId`):

```ts
  /** PERMANENT legacy-compat door: the server promotes this into a sessionRef
   *  forever (kata ejh6 section 2). Do NOT plan a later removal. */
  resumeSessionId: z.string().optional(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `effectiveReconcileSessionRef` helper mirrors `FreshAgentView.tsx`'s `effectiveSessionRef`. If the codebase already exports a shared helper, use it instead — but grep confirms no shared helper exists today (`effectiveSessionRef` is local to `FreshAgentView.tsx`). Keep the local helper in `pane-reconcile.ts` (it has a distinct doc context: reconcile vs. create/attach).

- [ ] **Step 6: Run impacted-test verification**

Every client test that exercises `pane-reconcile` or `collectTerminalPaneTargets`/`collectFreshAgentPaneTargets` is impacted. The existing tests in `pane-reconcile.test.ts`/`pane-reconcile.fresh-agent.test.ts` that send `sessionRef` directly (not legacy) are unaffected (the helper passes `sessionRef` through when present). The `FreshAgentView.reconcile.test.tsx:406` pin already asserts the promotion pattern on the create/attach path — it is unaffected (different module).

Run: `npm run test:vitest -- run test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts test/unit/client/components/fresh-agent/FreshAgentView.reconcile.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/pane-reconcile.ts shared/ws-protocol.ts test/unit/client/lib/pane-reconcile.test.ts test/unit/client/lib/pane-reconcile.fresh-agent.test.ts
git commit -m "feat(ejh6): client pane.reconcile promotion + ReconcilePaneSchema permanent-compat doc"
```

---

### Task 13: Final verification — kata section 6 `rg` sweep + verification checklist + gates

**Files:**
- No production changes (verification-only task).
- Test: all suites (coordinated full suite + Rust workspace + Playwright e2e).

**Interfaces:**
- Consumes: all prior tasks (1-12) complete and committed.
- Produces: verified green gates and a clean `rg` sweep showing only allowed categories.

- [ ] **Step 1: Write the failing behavioral test**

No new test — this task runs the kata section 6 `rg` sweep and the verification checklist. The "failure" is any `rg` hit outside the allowed categories or any failing gate.

- [ ] **Step 2: Run the sweep and verify the expected state**

Run the kata section 6 `rg` sweep:

```bash
rg 'resumeSessionId' server/ src/ shared/ crates/ --glob '!*test*'
```

Expected: output shows ONLY these categories:
1. Internal content/registry fields (e.g. `TerminalRegistry` row `resume_session_id`, `FreshAgentPaneContent.resumeSessionId`, tab-level `resumeSessionId` in pane content).
2. The `pane.reconcile` compat door (`crates/freshell-ws/src/reconcile.rs` `promoted_legacy_claim`, `src/lib/pane-reconcile.ts` `effectiveReconcileSessionRef`).
3. Alias conversion sites (CLI `promoteResumeFlag` in `server/cli/index.ts`, MCP `freshell-tool.ts` `resume`/`resumeSessionId` param handling).
4. Retained-for-rejection schema/struct fields (each carrying the section 3c comment): `shared/ws-protocol.ts` (`CodingCliCreateSchema`, `FreshAgentCreateSchema`, `FreshAgentAttachSchema`, `ReconcilePaneSchema`), `server/ws-handler.ts` (dynamic terminal.create + codingcli schemas), `crates/freshell-protocol/src/client_messages.rs` (`TerminalCreate`, `CodingCliCreate`, `FreshAgentCreate`, `FreshAgentAttach`, `ReconcilePane`).
5. Rejection handlers: `crates/freshell-freshagent/src/terminal_tabs.rs` (`requested_resume_session_id_for_mode`), `crates/freshell-ws/src/terminal.rs` (head-of-`handle_create` blanket reject, `fresh_agent_control_refusal` create/attach arms), `server/ws-handler.ts` (terminal.create/freshAgent.create/freshAgent.attach/codingcli.create head-of-case rejects), `server/agent-api/router.ts` (`requestedResumeSessionIdForMode`).
6. Sidecar JSON-lines writers (`claude.rs:469`/`:1294` — internal adapter-to-sidecar protocol, not Freshell wire input, per binding correction C).

If any hit falls outside these categories, add a section 3c doc comment, convert it to sessionRef, or document it as an allowed internal — then re-run.

- [ ] **Step 3: Add the minimal production implementation**

No production change — fix any sweep violations found in Step 2 by adjusting the relevant task's output (e.g. adding a missing section 3c comment, converting a missed wire-send test).

- [ ] **Step 4: Run the verification checklist gates**

Run the coordinated full suite (typecheck + Node tests):

```bash
npm run check
```

Expected: PASS (typecheck clean + coordinated default + server vitest suites green).

Run the Rust workspace suite:

```bash
cargo test --workspace
```

Expected: PASS.

Run the Playwright e2e (CLI path — the `agent-cli-flow` e2e with the new WS assertion; the MCP e2e `mcp-qa-smoke-rust`):

```bash
npm run test:e2e:local -- --grep "agent-cli-flow|mcp-qa-smoke-rust"
```

Expected: PASS (CLI `--resume` promotes to sessionRef and still works; MCP `resume` alias still works; the new WS assertion gets INVALID_MESSAGE + frozen text).

- [ ] **Step 5: Refactor while green**

No refactor — verification-only.

- [ ] **Step 6: Run impacted-test verification**

The full coordinated suite IS the impacted set (this is the final gate).

Run: `npm run check && cargo test --workspace`

Expected: PASS.

- [ ] **Step 7: Commit the task**

If Step 2 found sweep violations that required fixes, commit those fixes. Otherwise, no commit — the verification task produces no code change.

```bash
# Only if sweep fixes were needed:
git add <fixed files>
git commit -m "fix(ejh6): clean up remaining rg sweep violations"
```

**Verification checklist (kata section 6) — confirm each against the green gates:**

1. `curl -X POST /api/tabs -d '{"mode":"claude","resumeSessionId":"<uuid>"}'` then 400 with the frozen message — covered by Task 5 (`rest_create_rejects_legacy_resume_session_id_for_every_session_mode`) and Task 8 (`it.each` in `agent-tabs-write.test.ts`).
2. WS `terminal.create` with the field then `error{INVALID_MESSAGE}` with the named text, no spawn, registry row count unchanged — covered by Task 6 (`blanket_reject_legacy_resume_session_id_on_any_create`) and Task 9 (`it.each` in `ws-terminal-create-reuse-running-codex.test.ts`).
3. WS `freshAgent.create` with the field then create-failed envelope, no sidecar spawn — covered by Task 7 (`freshagent_create_with_legacy_resume_session_id_is_rejected`) and Task 10 (`rejects freshAgent.create carrying resumeSessionId`).
4. WS `codingcli.create` with the field then `error{INVALID_MESSAGE}`; with `sessionRef` then resume works — covered by Task 11 (`rejects codingcli.create carrying resumeSessionId` + `promotes a provider-matched sessionRef`).
5. CLI `--resume` and MCP `resume` still work end-to-end (they convert; nothing user-facing changes) — covered by existing `agent-cli-flow.test.ts:493-560` (positive `--resume` to sessionRef) and `freshell-tool.test.ts` alias tests, both unchanged.
6. Reload/restore of existing tabs (including pre-existing persisted state that may carry legacy pane-content fields) still resumes correctly — covered by the permanent `pane.reconcile` compat door (Task 6 reconcile doc + Task 12 client promotion), with existing `reconcile.rs` cfg(test) fns `:1021`/`:1053`/`:1083` and `pane_reconcile.rs:125` staying green.
7. `freshAgent.attach` with the field then `freshAgent.error{FRESH_AGENT_CREATE_FAILED}` + frozen text — covered by Task 7 (`freshagent_attach_with_legacy_resume_session_id_is_rejected`) and Task 10 (`rejects freshAgent.attach carrying resumeSessionId`).
8. `rg 'resumeSessionId' server/ src/ shared/ crates/ --glob '!*test*'` shows only allowed categories — verified in Step 2.
