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
- **Presence-based rejection (coordinator ruling, review findings 2+8+R3.1 — UNIFORM raw pre-parse presence guard):** rejection is PRESENCE-based, not non-empty: "any create that CARRIES the field", at every door, with the frozen text and the door-family envelope for EVERY JSON value type (string, empty, null, number, object). **REST doors** (raw `Value`/`req.body`): reject at the door-top (`body.get("resumeSessionId").is_some()` in Rust; `req.body && 'resumeSessionId' in req.body` / presence in Node). **WS doors on BOTH servers: a raw pre-parse presence guard**, placed BEFORE schema/typed parse, BEFORE dedupe/restore planning (zero side effects on reject): key-presence on the raw parsed frame decides. Rationale: typed layers cannot do this — zod `z.string().optional()` rejects null/42 generically (loses the required frozen text and, for freshAgent doors, the required create-failed family envelope), and serde `Option<String>` absorbs `null` into `None` while non-strings get silently dropped by the accept-and-strip arm. Node guard site: `server/ws-handler.ts` right before `this.clientMessageSchema.safeParse(msg)` (`:1913`); Rust guard site: after the `tabs.sync.*` fast-path and before `from_value` (`crates/freshell-ws/src/terminal.rs` dispatch). Per-family envelopes from the raw frame: `terminal.create` + `codingcli.create` → `error{INVALID_MESSAGE}` + frozen text; `freshAgent.create` → `freshAgent.create.failed{code FRESH_AGENT_CREATE_FAILED, frozen text, retryable:false}` (requestId from raw); `freshAgent.attach` → Rust rides `freshAgent.event{freshAgent.error}` (keyed by sessionId; UI-visible), Node rides `error{code FRESH_AGENT_CREATE_FAILED}` (socket-loud/UI-invisible — accepted asymmetry, coordinator ruling A). Wire schemas/structs keep `resumeSessionId: z.string().optional()`/`Option<String>` declared for parse retention only — the guard, not the schema, owns the contract. All draft checks use presence, never truthiness/`isNonEmptyString`/`is_some_and(non-empty)`. Tests: every door pins frozen text for `""` + ordinary strings; terminal.create null/42/object pinned on both servers (frozen text — the guard is raw); REST null/42 on all three routes both servers.
- **Door-top REST rejection (coordinator ruling, review finding 3):** REST rejection runs at the TOP of each route handler in BOTH servers, BEFORE any branch (agent/browser/editor/terminal) and BEFORE `layout.split_pane` in the split route. In Node, check `req.body?.resumeSessionId !== undefined` at the top of `POST /tabs`, `POST /panes/:id/split`, `POST /panes/:id/respawn`; `requestedResumeSessionIdForMode` keeps its sessionRef-resolution role but no longer throws (single check at door-top for KISS). In Rust, check `body.get("resumeSessionId").is_some()` at each axum handler entry in `terminal_tabs.rs`/`pane_ops.rs` before any branch or layout mutation. Tests: pane/layout unchanged on rejected split; browser/editor branches also 400.
- **Section 3c doc comment:** every retained `resumeSessionId`/`resume_session_id` field in a wire schema/struct gets the comment `Retained solely so the handler can detect-and-reject; see kata ejh6.` — EXCEPT `ReconcilePane.resume_session_id` which gets the PERMANENT compat-door comment.
- **`restoreKey` gating:** blanket REST reject does NOT gate on `restoreKey` — no production producer emits it (verified), so blanket reject regresses nothing live (binding correction A).
- **Sidecar JSON-lines writers are not wire input:** `claude.rs:469` and `:1294` write `resumeSessionId` to the claude Node sidecar's internal JSON-lines protocol, not the Freshell WS wire — leave them untouched (binding correction C).
- **Uniform any-carry REST rejection (coordinator final ruling, supersedes kata §1a's carrier-presence reading):** REST seams throw whenever the wire `resumeSessionId` is present, even when a matching `sessionRef` is also present — no first-party sender dual-carries, and the codex dual-carrier tolerance at `server/coding-cli/codex-app-server/restore-decision.ts:40` (`&& !codexSessionRef`) is retired by this change. Tasks 5 and 8 check legacy BEFORE the sessionRef early-return. WS §1b's any-carry language is the parity target.
- **`ErrorCode` enum extension:** add `FRESH_AGENT_CREATE_FAILED` to the shared `ErrorCode` enum in `shared/ws-protocol.ts:20-37` so Node attach rejection's `sendError({code:'FRESH_AGENT_CREATE_FAILED',...})` typechecks. Node attach rejection is socket-loud but UI-invisible (no client consumer for requestId-less `error` frames); Rust's rides `freshAgent.event{freshAgent.error}` which the client renders — this asymmetry is documented in Task 10 and accepted (kata §1c names the code family, not the frame type).
- **Sidecar-protocol file class is NOT Freshell-wire input (V5 ruling):** `crates/freshell-claude-sidecar/index.mjs:10,:240` (reader), `claude.rs:469`/`:1294` + Node `sdk-bridge.ts` writers, embedded fake sidecars in `tests/fixtures` and `test/e2e-browser/fixtures`, and the ~8 sidecar-log-reading specs (`freshagent-settings-resume-rust.spec.ts:545,:551`, `hidden-pane-rebind-rust.spec.ts:365-367`, `freshclaude-restart-parity-rust.spec.ts:309`, `freshclaude-identity-persistence-rust.spec.ts:313,:410`, `wavea-interactions-rust.spec.ts:403-407`, `restore-contract-wall-rust.spec.ts:1040,:1304`, `restore-matrix.spec.ts:400,:1099`) — none are Freshell-wire input. Task 13's §6 sweep categories must EXCLUDE this file class with an explicit ruling line.

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
K) V5's six-site omission correction: Task 3 must absorb `amplifier_launcher_identity.rs:148` (mechanical re-carrier), `claude_session_rebind.rs:546` (mechanical), `freshagent_claude_attach.rs:559` (third attach site, mechanical), and `terminal_tabs.rs:6334` (11th REST body — mechanical IF contract-neutral, else into Task 5 as a rejection assertion). Three premise-inversion sites route to behavior tasks: `amplifier_launcher_identity.rs:341` (expects RESTORE_UNAVAILABLE → becomes INVALID_MESSAGE — into Task 6), `codex_session_ref_resume.rs:363-381` (codex raw-legacy acceptance — into Task 6 as a rejection test), `cross_kind_liveness.rs:411,:460` (dual-carrier freshAgent.create sends — into Task 7: the SESSION_RESERVED dual-carrier assertion flips to the create-failed envelope; setup carry gets mechanically re-carriered).
L) Uniform any-carry REST ruling (coordinator final): REST seams (`derive_resume_identity`, `requestedResumeSessionIdForMode`) throw whenever the wire `resumeSessionId` is present, even when `sessionRef` is also present — no first-party sender dual-carries. The codex dual-carrier tolerance at `server/coding-cli/codex-app-server/restore-decision.ts:40` is retired by this change. Tasks 5 and 8 check legacy BEFORE the sessionRef early-return. Existing REST dual-carrier acceptance assertions, if any, become rejection assertions.
M) `ErrorCode` enum addition (validator V2 found Task 10's draft would not typecheck): add `FRESH_AGENT_CREATE_FAILED` to the shared `ErrorCode` enum in `shared/ws-protocol.ts:20-37`. Node attach rejection emits `error{FRESH_AGENT_CREATE_FAILED}` matching the existing attach error shape. Note the asymmetry: Node attach rejection is socket-loud but UI-invisible (no client consumer for requestId-less `error` frames — verified by V2's exhaustive sweep), while Rust's rides `freshAgent.event{freshAgent.error}` which the client renders. Kata §1c is satisfied (code family is what it names). Task 13 adds a typecheck step to catch drift.

N) **Final WS door design (post-rounds-2/3; supersedes the "head-of-case"-style wording in B/D above):** BOTH servers reject at a raw pre-parse presence guard — Rust in `crates/freshell-ws/src/terminal.rs` dispatch after the tabs.sync fast-path and before `from_value` (Task 6 arms terminal.create + codingcli.create; Task 7 arms freshAgent.create/.attach), Node in `server/ws-handler.ts` after JSON.parse and before `clientMessageSchema.safeParse(msg)` at :1913 (Task 9 arms terminal.create; Task 10 arms freshAgent.*; Task 11 arms codingcli.create). Full presence for every JSON value incl. null/42 with frozen text + per-family envelopes; typed schemas keep the field DECLARED (retention + section 3c comments) but the guard, not the schema, owns the contract. (The typed-layer first attempt was invalidated by review round 2 finding 8 — serde absorbs `null` into `None` and accept-and-strip drops non-strings — and review round 3 finding 1, which ruled Node's zod parse-boundary generic-text residual non-compliant for family envelopes.)

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
fn legacy_reject_frozen_text() {
    assert_eq!(
        LEGACY_RESUME_IDENTITY_REFUSAL,
        "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
    );
}
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-protocol --test legacy_resume_text legacy_reject_frozen_text`

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

Run: `cargo test -p freshell-protocol --test legacy_resume_text legacy_reject_ && cargo test -p freshell-ws --test live_session_ref_guard legacy_only_restore && npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS — the new const test pins the text; existing pinned-text tests stay green because the text is byte-identical.

- [ ] **Step 5: Refactor while green**

The dedup IS the refactor. Confirm no remaining private duplicate: `rg "Restore requires sessionRef" crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-ws/src/terminal.rs server/ws-handler.ts` should show ZERO hits (all three now reference the shared/imported const).

- [ ] **Step 6: Run impacted-test verification**

The change touches the frozen text carriers in both servers. Impacted set: all pinned-text tests in both servers.

Run: `cargo test -p freshell-freshagent && cargo test -p freshell-ws && npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/mcp/freshell-tool.test.ts --config config/vitest/vitest.server.config.ts && FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/e2e/agent-cli-flow.test.ts`

NOTE (V1): `test/e2e/agent-cli-flow.test.ts` is a Vitest file under the DEFAULT config (`config/vitest/vitest.config.ts`), NOT the server config — the server config's include list (`config/vitest/vitest.server.config.ts:27-36`) covers `test/server/**`, `test/unit/server/**`, `test/integration/server/**` but NOT `test/e2e/**`. Running it under `--config vitest.server.config.ts` silently drops it (vitest `list` exits 0 on empty match). The default config does NOT exclude `test/e2e/**` (only `test/e2e-browser/**`, `test/e2e-electron/**`). So `agent-cli-flow` must run as a separate default-config invocation with no `--config` flag (the coordinator auto-routes `test/e2e/...` to the default config).

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
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs` (test mod — POST bodies at `:4504,:4558,:4606,:5838,:5883,:5915,:5950,:5993,:6032,:6074,:6334`)
- Modify: `crates/freshell-freshagent/src/codex.rs` (test mod — msg structs at `:7047,:7181,:7240`)
- Modify: `crates/freshell-freshagent/src/opencode_ws.rs:3056`
- Modify: `crates/freshell-freshagent/src/claude.rs:2228-2232`
- Modify: `crates/freshell-ws/src/terminal_launch_prep_tests.rs:31-45`
- Modify: `crates/freshell-ws/tests/codex_managed_launch_e2e.rs:253-267`
- Modify: `crates/freshell-ws/tests/session_identity_frames.rs:67-72`
- Modify: `crates/freshell-ws/tests/pane_ledger_triggers.rs:156-162`
- Modify: `crates/freshell-ws/tests/freshagent_claude_attach.rs:360-365,:466-471,:559` (V5: third attach site at `:559`)
- Modify: `crates/freshell-ws/tests/freshagent_session_lease.rs:417-424,:599-604,:756-761`
- Modify: `crates/freshell-ws/tests/amplifier_launcher_identity.rs:148` (V5: mechanical re-carrier — setup create)
- Modify: `crates/freshell-ws/tests/claude_session_rebind.rs:546` (V5: mechanical — setup create, drop legacy line since sessionRef already present)
- Test: same files (converted in place)

**Premise-inversion sites routed to behavior tasks (NOT this task):** `amplifier_launcher_identity.rs:341` (expects RESTORE_UNAVAILABLE → becomes INVALID_MESSAGE — Task 6), `codex_session_ref_resume.rs:363-381` (codex raw-legacy acceptance — Task 6 rejection test), `cross_kind_liveness.rs:411,:460` (dual-carrier freshAgent.create — Task 7). `terminal_tabs.rs:6334` (11th REST body, asserts 200) — if its assertion depends on legacy acceptance it becomes a rejection assertion in Task 5; otherwise convert here. Inspect `:6334` in context: it asserts `StatusCode::OK` on a `POST /api/tabs {"mode":"amplifier","resumeSessionId":"sess-no-warn-1"}` body — this is legacy ACCEPTANCE, so it routes to Task 5 as a rejection assertion (expected 200 becomes expected 400). Leave it sending legacy in Task 3.

**Interfaces:**
- Consumes: `session_ref` field already on every Rust protocol struct (`TerminalCreate.session_ref`, `FreshAgentCreate.session_ref`, `FreshAgentAttach.session_ref`); `derive_resume_identity` and per-provider resume-id derivation accept sessionRef.
- Produces: Rust tests that send `sessionRef`/`session_ref` only (except `:6334` left for Task 5), staying green against the unmodified server.

- [ ] **Step 1: Write the failing behavioral test**

Mechanical conversions. For each site, replace the legacy carrier with the canonical `sessionRef`/`session_ref` carrier. The asserted behavior (registry directory fills, spawn argv, frame assertions, ledger non-mutation) is carrier-agnostic and stays green.

**REST POST bodies in `terminal_tabs.rs` test mod** — each `json!({... "resumeSessionId": "<id>" ...})` becomes `json!({... "sessionRef": {"provider": "<mode>", "sessionId": "<id>"} ...})` where `<mode>` is the `mode` field on the same body. The 7 test fns at `:4490,:4543,:4592,:5824,:5856,:5896,:6060` each get their POST body converted (review round 2 finding 1: the three EDEV-07 plausibility-negative tests at `:5936,:5978,:6018` are NOT converted here — a sessionRef send bypasses the plausibility branch and would invert their premise on an unmodified server; they route to Task 5 as rejection assertions). Example for `create_tab_resume_session_id_flows_to_registry_directory_for_non_codex_mode` (`:4490`, body at `:4504`):

```rust
// BEFORE:
let body = json!({"mode": "claude", "resumeSessionId": "sess-dir-claude-1"});
// AFTER:
let body = json!({"mode": "claude", "sessionRef": {"provider": "claude", "sessionId": "sess-dir-claude-1"}});
```

The three `rest_create_legacy_resume_*409` tests (`:5824,:5856,:5896`) test the D7/LEASE 409 ladder via the legacy carrier — convert the body to `sessionRef` and re-aim the assertions at the sessionRef-carrier D7 path (the 409 RESTORE_UNAVAILABLE behavior is carrier-agnostic; the test still expects 409). The `:4424` codex-reject test (`create_codex_tab_rejects_raw_resume_session_id_without_session_ref`) is a REJECTION-READY test — leave it sending legacy (it will be widened in Task 5). The `:6334` body (`create_tab_with_identity_or_shell_mode_does_not_warn_invariant`) asserts 200 on legacy amplifier — leave it sending legacy (Task 5 flips it to a 400 rejection assertion).

**`codex.rs` test mod** — at `:7047,:7181,:7240`, replace `resume_session_id: Some("<id>".to_string())` with `session_ref: Some(SessionLocator { provider: AgentProvider::Codex, session_id: "<id>".to_string() })`. The twin test `handle_create_with_session_ref_only_resumes_the_same_thread` at `:7096` already shows the post-conversion shape — match it.

**`opencode_ws.rs:3056`** — replace `create.resume_session_id = Some(DURABLE_ID.to_string());` with `create.session_ref = Some(SessionLocator { provider: AgentProvider::Opencode, session_id: DURABLE_ID.to_string() });`.

**`claude.rs:2228-2232`** (`attach_msg_with_resume` test helper) — replace `msg.resume_session_id = Some(durable.to_string());` with `msg.session_ref = Some(SessionLocator { provider: AgentProvider::Claude, session_id: durable.to_string() });`.

**`terminal_launch_prep_tests.rs:31-45`** — the `wire_legacy_resume_session_id_is_from_wire` test builds a legacy `restore:true` create. Convert to `session_ref` carrier; rename to `wire_session_ref_is_from_wire`; the `resume_id_from_wire` property survives via sessionRef.

**`codex_managed_launch_e2e.rs:253-267`** (helper `create_codex_terminal_resume`) — replace `"resumeSessionId": "<id>"` with `"sessionRef": {"provider": "codex", "sessionId": "<id>"}` in the WS frame.

**`session_identity_frames.rs:67-72`** — replace `"resumeSessionId": "sess-identity-1"` with `"sessionRef": {"provider": "amplifier", "sessionId": "sess-identity-1"}`.

**`pane_ledger_triggers.rs:156-162`** — replace the legacy-only create carrier with `"sessionRef": {"provider": "claude", "sessionId": "<id>"}`.

**`freshagent_claude_attach.rs:360-365,:466-471,:559`** and **`freshagent_session_lease.rs:417-424,:599-604,:756-761`** — these frames carry BOTH `resumeSessionId` AND `sessionRef` today. Delete the `resumeSessionId` line in each (sessionRef already present — trivial; V5 found a third attach site at `:559`). The fake-sidecar `msg.resumeSessionId` reads at `freshagent_claude_attach.rs:63` are the internal adapter-to-sidecar protocol — leave them.

**`amplifier_launcher_identity.rs:148`** (V5 omitted site) — setup create `terminal.create{mode:"amplifier",...,"resumeSessionId": requested}` expecting `terminal.created` + sessionRef echo. Mechanically re-carrier: replace `"resumeSessionId": requested` with `"sessionRef": {"provider": "amplifier", "sessionId": requested}`. The `:341` premise-inversion site (second create expects RESTORE_UNAVAILABLE) is left for Task 6.

**`claude_session_rebind.rs:546`** (V5 omitted site) — setup `freshAgent.create` carries BOTH `resumeSessionId` and `sessionRef`. Drop the `resumeSessionId` line (sessionRef already present). The `:293` fake-sidecar `msg.resumeSessionId` read is internal adapter-to-sidecar protocol — leave it.

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
git add crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/codex.rs crates/freshell-freshagent/src/opencode_ws.rs crates/freshell-freshagent/src/claude.rs crates/freshell-ws/src/terminal_launch_prep_tests.rs crates/freshell-ws/tests/codex_managed_launch_e2e.rs crates/freshell-ws/tests/session_identity_frames.rs crates/freshell-ws/tests/pane_ledger_triggers.rs crates/freshell-ws/tests/freshagent_claude_attach.rs crates/freshell-ws/tests/freshagent_session_lease.rs crates/freshell-ws/tests/amplifier_launcher_identity.rs crates/freshell-ws/tests/claude_session_rebind.rs
git commit -m "test(ejh6): convert Rust wire-send tests to sessionRef (incl. V5 omitted sites)"
```

---

### Task 4: Convert e2e-browser Rust wire-send tests to sessionRef

**Files:**
- Modify: `test/e2e-browser/specs/fresh-agent-control-rust.spec.ts:1521,:1586,:1864,:1929`
- Modify: `test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts:313,:414,:536`
- Modify: `test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts:344-346,:423-425,:616-618`
- NOTE: `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts` is NOT converted in Task 4 — its acceptance-assert sites and repurpose move to Task 5 (same Rust-behavior commit, per V6: no red window between the Rust REST reject and the spec fix). Task 4 does NOT touch this file.
- Test: same files (except remote-tab-linkage-rust.spec.ts)

**Interfaces:**
- Consumes: Rust server accepts both carriers (unmodified); sessionRef is the canonical carrier already used by the web client.
- Produces: e2e specs that send `sessionRef` only on the wire. The `remote-tab-linkage-rust.spec.ts` repurpose is deferred to Task 5.

- [ ] **Step 1: Write the failing behavioral test**

Mechanical conversions of e2e WS/REST wire-send sites.

**`fresh-agent-control-rust.spec.ts:1521,:1586,:1864,:1929`** — each `freshAgent.attach` frame carrying `resumeSessionId: '<id>'` (alongside `sessionId`, no `sessionRef`) becomes `sessionRef: { provider: 'claude', sessionId: '<id>' }` (drop the `resumeSessionId` key, keep `sessionId`).

**`freshagent-settings-resume-rust.spec.ts:313,:414`** — `freshAgent.create` with `resumeSessionId` becomes `sessionRef: { provider, sessionId }`. **`:536`** — `freshAgent.attach` with `resumeSessionId` becomes `sessionRef` (keep `sessionId`).

**`sidebar-registry-sync-rust.spec.ts:344-346,:423-425,:616-618`** — each `page.request.post(baseUrl/api/tabs)` with `data: { mode: 'claude', resumeSessionId: sessionId }` becomes `data: { mode: 'claude', sessionRef: { provider: 'claude', sessionId } }`. The in-file comment pattern at `:338-343`/`:417-422` already explains codex uses sessionRef — extend it to claude.

**`remote-tab-linkage-rust.spec.ts`** — NOT touched in Task 4. Per V6, the spec's repurpose (re-carrier sends + convert acceptance assertions to rejection assertions + add to `RUST_ONLY_SPECS`) moves to Task 5 (same Rust-behavior commit) to avoid a red window between the Task-5 REST reject and the spec fix.

- [ ] **Step 2: Run the test and verify the intended failure**

Contract-neutral — e2e specs pass against the unmodified Rust server. Run the four converted specs via the repo's e2e runner (check `package.json`; if `FRESHELL_E2E_BACKEND` is unset, run locally — these are Rust-server specs so use the Rust e2e config).

Run: `npm run test:e2e:local -- --grep "fresh-agent-control-rust|freshagent-settings-resume-rust|sidebar-registry-sync-rust" --project rust-chromium` (the three converted specs on the rust-chromium project; `remote-tab-linkage-rust` is deferred to Task 5).

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
git add test/e2e-browser/specs/fresh-agent-control-rust.spec.ts test/e2e-browser/specs/freshagent-settings-resume-rust.spec.ts test/e2e-browser/specs/sidebar-registry-sync-rust.spec.ts
git commit -m "test(ejh6): convert e2e-browser Rust wire-send tests to sessionRef"
```

---

### Task 5: Rust REST reject — door-top presence check on all routes + section 3c doc comments + remote-tab-linkage re-carrier

**Files:**
- Modify: `crates/freshell-freshagent/src/lib.rs:1620-1633` (`create_tab` handler — insert door-top presence check BEFORE the agent/browser/editor/terminal branch) and `crates/freshell-freshagent/src/terminal_tabs.rs:117-136` (`requested_resume_session_id_for_mode` — remove the legacy throw; keep sessionRef resolution only; the door-top check is the single rejection point for KISS)
- Modify: `crates/freshell-freshagent/src/pane_ops.rs:144-149` (`split_pane` handler — insert door-top check BEFORE `resolve_pane_target` and `layout.split_pane` at `:175`, so a rejection returns 400 with NO layout mutation) and `:699-745` (`respawn_pane` handler — insert door-top check BEFORE `spawn_terminal_pane` at `:719`)
- Modify: `crates/freshell-protocol/src/client_messages.rs:231-235,:409-411,:445,:511,:527` (section 3c doc comments — same as before)
- Modify: `crates/freshell-freshagent/src/terminal_tabs.rs:6334` (`create_tab_with_identity_or_shell_mode_does_not_warn_invariant` — re-carrier the positive amplifier create to sessionRef; see review-round-2 finding 4 restructure in Step 1) and `:5936-6080` (the three EDEV-07 plausibility-negative tests — moved here from Task 3 per review-round-2 finding 1; they become 400-rejection assertions, see Step 1)
- Modify: `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts` (finding 6: RE-CARRIER sends to sessionRef, KEEP all ~110 lines of downstream behavior assertions, APPEND one new rejection case; do NOT delete behavior coverage)
- Modify: `test/e2e-browser/playwright.config.ts:176` (`RUST_ONLY_SPECS` — add `/remote-tab-linkage-rust\.spec\.ts$/`)
- Test: `crates/freshell-freshagent/src/terminal_tabs.rs` (test mod — add per-mode, dual-carrier, presence-edge, browser/editor rejection tests)
- Test: `crates/freshell-freshagent/src/pane_ops_tests.rs` (new split/respawn rejection tests with layout-unchanged assertion)

**Interfaces:**
- Consumes: `LEGACY_RESUME_IDENTITY_REFUSAL` (from Task 1); `fail_json(StatusCode::BAD_REQUEST, ...)` at `lib.rs:1556`; `post(router, uri, body, auth: bool)` helper (4th arg is `bool`, use `true`); `create_shell_tab(router)` helper at `pane_ops_tests.rs:87-102`.
- Produces: all three Rust REST doors return HTTP 400 at the door-top whenever the body CONTAINS the key `resumeSessionId` with ANY JSON value (string, empty, null, number, object), BEFORE any branch or layout mutation. `requested_resume_session_id_for_mode` keeps its sessionRef-resolution role but no longer throws (single check at door-top for KISS).

- [ ] **Step 1: Write the failing behavioral test**

Add to the `#[cfg(test)] mod tests` in `crates/freshell-freshagent/src/terminal_tabs.rs` (after `:4415`). `post()` 4th arg is `auth: bool` (use `true`):

```rust
#[tokio::test]
async fn legacy_reject_rest_create_all_modes() {
    let state = state_with_registry();
    let app = crate::router(state);
    for mode in ["claude", "opencode", "amplifier"] {
        let (status, body) = post(
            app.clone(), "/api/tabs",
            json!({"mode": mode, "resumeSessionId": format!("legacy-{mode}-id")}),
            true,
        ).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{mode}: {body}");
        assert_eq!(body["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
    }
}

#[tokio::test]
async fn legacy_reject_rest_create_dual_carrier() {
    let state = state_with_registry();
    let app = crate::router(state);
    let (status, body) = post(
        app, "/api/tabs",
        json!({"mode": "claude", "resumeSessionId": "legacy", "sessionRef": {"provider": "claude", "sessionId": "canonical"}}),
        true,
    ).await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "dual-carrier must reject: {body}");
    assert_eq!(body["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
}

/// ejh6 presence-based (finding 2): the contract is "any create that CARRIES
/// the field". REST reads raw Value, so null/number/object values ARE rejected.
#[tokio::test]
async fn legacy_reject_rest_create_presence_edge_cases() {
    let state = state_with_registry();
    let app = crate::router(state);
    for (label, val) in [
        ("empty-string", json!("")),
        ("null", json!(null)),
        ("number", json!(42)),
    ] {
        let (status, body) = post(
            app.clone(), "/api/tabs",
            json!({"mode": "claude", "resumeSessionId": val}),
            true,
        ).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label}: {body}");
        assert_eq!(body["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
    }
}

/// ejh6 finding 3: browser/editor branches also 400 when carrying the field.
/// (review round 2 finding 2: serde_json json! has NO spread syntax — build
/// the Value with explicit insert.)
#[tokio::test]
async fn legacy_reject_rest_browser_editor_branches() {
    let state = state_with_registry();
    let app = crate::router(state);
    for (label, mut body) in [
        ("browser", json!({"browser": "https://example.com"})),
        ("editor", json!({"editor": "/tmp/file.ts"})),
    ] {
        body.as_object_mut().unwrap().insert("resumeSessionId".into(), json!("legacy"));
        let (status, resp) = post(app.clone(), "/api/tabs", body, true).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label} branch must reject: {resp}");
        assert_eq!(resp["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
    }
}
```

Restructure the `:6334` test (`create_tab_with_identity_or_shell_mode_does_not_warn_invariant` — review round 2 finding 4: its remainder unwraps `body["data"]["terminalId"]` and kills it, so a 200→400 flip would panic and silently drop the positive identity/invariant coverage). Instead:
1. Re-carrier the first create from `"resumeSessionId": "sess-no-warn-1"` to `"sessionRef": {"provider": "amplifier", "sessionId": "sess-no-warn-1"}` — every subsequent assertion (OK status, terminalId, no-warn invariant, kill) stays identical.
2. The legacy-rejection case for amplifier REST is already covered by `legacy_reject_rest_create_all_modes` above — nothing more to add.

Route the three EDEV-07 plausibility-negative tests (moved out of Task 3 — review round 2 finding 1) into rejection assertions, replacing the full bodies at `:5936-5983`, `:5985-6024`, and `:6026-6080` (approx; verify the exact fn spans while editing). The pattern for all three — `create_claude_tab_with_non_canonical_resume_id_does_not_synthesize`, `create_amplifier_tab_with_whitespace_resume_id_does_not_synthesize`, `create_opencode_tab_with_non_ses_resume_id_does_not_synthesize` (keep names — they can stay, the "_does_not_synthesize" suffix now reads as "the create is refused"):

```rust
#[tokio::test]
async fn create_claude_tab_with_non_canonical_resume_id_does_not_synthesize() {
    // ejh6: wire-level legacy resumeSessionId is REFUSED at the door — the
    // implausible-id "no-synthesize/keep" EDEV-07 branch is now wire-
    // unreachable; the branch stays in production code (content concern,
    // out of scope for ejh6) with a comment. This test pins the refusal:
    // 400 + frozen text, and NO ui.command frame is broadcast (no spawn).
    let argv_file = unique_argv_file("claude-implausible");
    let state =
        state_with_registry().with_cli_commands(std::sync::Arc::new(vec![recording_cli_spec(
            "claude", &argv_file,
        )]));
    let mut rx = state.broadcast_tx.subscribe();
    let tmp = std::env::temp_dir();
    let (status, body) = post(
        app(state.clone()),
        "/api/tabs",
        json!({
            "mode": "claude",
            "cwd": tmp.to_string_lossy(),
            "resumeSessionId": "not-a-canonical-uuid"
        }),
        true,
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    assert_eq!(
        body["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.")
    );
    // No spawn -> no ui.command broadcast. subscribe-before-post means any
    // frame would land in rx; a short timeout proves none arrived.
    assert!(
        tokio::time::timeout(std::time::Duration::from_millis(250), rx.recv()).await.is_err(),
        "no broadcast frame may arrive for a rejected create"
    );
    let _ = std::fs::remove_file(&argv_file);
}
```
(Same shape for the amplifier and opencode twins with their respective argv_file/spec mode names and legacy id strings `"not a plausible id"` / `"foo"`. One-paste exemplar count: write all three fns fully in the edit — do not template them away.)

Add to `crates/freshell-freshagent/src/pane_ops_tests.rs` — split test with layout-unchanged assertion (finding 3; review round 2 finding 3 rulings: `state` is moved by `crate::router(state)`, `LayoutStore` has no `snapshot()`, and `UiSnapshot` lacks `PartialEq` — instead fetch the layout view via the EXISTING `get(router, uri, auth)` helper (`pane_ops_tests.rs:106`) from the before/after `:2302` `list_tabs` route and compare the `["tabs"]` payload — `serde_json::Value` implements `PartialEq`). Per R9, presence-edge values are looped in: string, empty, null, number all 400 with frozen text:

```rust
#[tokio::test]
async fn legacy_reject_split() {
    let state = state_with_registry();
    let app = crate::router(state);
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(app.clone()).await;
    for (label, val) in [
        ("string", json!("legacy-split")),
        ("empty-string", json!("")),
        ("null", json!(null)),
        ("number", json!(42)),
    ] {
        let (s1, before) = get(app.clone(), "/api/tabs", true).await;
        assert_eq!(s1, StatusCode::OK);
        let (status, body) = post(
            app.clone(), &format!("/api/panes/{pane_id}/split"),
            json!({"direction": "horizontal", "mode": "claude", "resumeSessionId": val}),
            true,
        ).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label} split legacy reject: {body}");
        assert_eq!(body["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
        let (s2, after) = get(app.clone(), "/api/tabs", true).await;
        assert_eq!(s2, StatusCode::OK);
        // Finding 3: layout MUST be unchanged — the door-top check fires BEFORE layout.split_pane.
        assert_eq!(before["tabs"], after["tabs"], "{label}: layout must not mutate on a rejected split");
    }
}

#[tokio::test]
async fn legacy_reject_respawn() {
    let state = state_with_registry();
    let app = crate::router(state);
    let (_tab_id, pane_id, _terminal_id) = create_shell_tab(app.clone()).await;
    for (label, val) in [
        ("string", json!("legacy-respawn")),
        ("empty-string", json!("")),
        ("null", json!(null)),
        ("number", json!(42)),
    ] {
        let (status, body) = post(
            app.clone(), &format!("/api/panes/{pane_id}/respawn"),
            json!({"mode": "claude", "resumeSessionId": val}),
            true,
        ).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{label} respawn legacy reject: {body}");
        assert_eq!(body["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
    }
}
```

Re-carrier `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts` (finding 6: DO NOT delete the ~110 lines of behavior coverage. RE-CARRIER the send at `:197-206` from `resumeSessionId: SEEDED_SESSION_ID` to `sessionRef: { provider: 'amplifier', sessionId: SEEDED_SESSION_ID }`, KEEP every downstream assertion (resume argv, live broadcast, sidebar linkage, click dedupe, title sync, persisted sessionRef, restart/reload restoration, post-restart resume) as sessionRef-carrier behavior coverage, then APPEND one new rejection-focused case at the end of the describe block:

```ts
  // Review round 3 findings 3/7: this spec imports `test` (not `it`) from
  // '../helpers/fixtures.js'; the big test's locals (info, projectDir,
  // SEEDED_SESSION_ID) are out of scope here, so this case boots its OWN
  // minimal rust server (no amplifier fixtures needed — the rejection fires
  // at the door before any mode work), and asserts frozen text PLUS no
  // visible creation: /api/tabs before/after equality (no spawn, no tab).
  test('rejects a bare legacy resumeSessionId on REST create with 400 + frozen text (kata ejh6)', async ({ e2eServerKind }) => {
    expect(e2eServerKind).toBe('rust')
    const server = await createE2eServerHandle(process.env, {
      kind: e2eServerKind,
      construct: {}, // no fixtures: door-top reject needs no provider state — verify the construct type allows empty at implementation time and seed minimally if not
    })
    const info = await server.start()
    try {
      const before = await (await fetch(`${info.baseUrl}/api/tabs`, { headers: { 'x-auth-token': info.token } })).json()
      const res = await fetch(`${info.baseUrl}/api/tabs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-auth-token': info.token },
        body: JSON.stringify({ mode: 'amplifier', cwd: '/tmp', resumeSessionId: 'amp-legacy-reject-0001', name: 'legacy-reject-case' }),
      })
      expect(res.status).toBe(400)
      const body = await res.json()
      expect(body).toEqual({
        status: 'error',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
      })
      const after = await (await fetch(`${info.baseUrl}/api/tabs`, { headers: { 'x-auth-token': info.token } })).json()
      expect(after).toEqual(before) // no tab/terminal side effects on reject
    } finally {
      await server.stop()
    }
  })
```

Add `/remote-tab-linkage-rust\.spec\.ts$/` to `RUST_ONLY_SPECS` at `test/e2e-browser/playwright.config.ts:176` (pre-existing config gap fix).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-freshagent legacy_reject_ && cargo test -p freshell-freshagent does_not_synthesize`

Expected: FAIL because the non-codex modes silently accept the legacy field, the browser/editor branches bypass the check entirely, and the split door mutates the layout before reaching `spawn_terminal_pane` — the tests get 200/approx instead of 400, the layout-unchanged assertion fails, and the EDEV-07 trio (now rejection assertions) gets 200 instead of 400.

- [ ] **Step 3: Add the minimal production implementation**

First, imports (review round 2 finding 5 — without these the snippets don't compile): in `crates/freshell-freshagent/src/lib.rs` add `use freshell_protocol::LEGACY_RESUME_IDENTITY_REFUSAL;` alongside the existing `freshell_protocol` use group (mirror terminal_tabs.rs's import); in `crates/freshell-freshagent/src/pane_ops.rs` add the same `use freshell_protocol::LEGACY_RESUME_IDENTITY_REFUSAL;` to its use block.

Add a door-top presence check at the TOP of `create_tab` in `crates/freshell-freshagent/src/lib.rs:1620-1633` (BEFORE the `if agent.is_empty()` branch delegation at `:1632`):

```rust
    // ejh6 (finding 3): door-top presence check. Reject whenever the body
    // CONTAINS the key resumeSessionId with ANY JSON value (string, empty,
    // null, number, object) — BEFORE any agent/browser/editor/terminal branch.
    if body.get("resumeSessionId").is_some() {
        return fail_json(StatusCode::BAD_REQUEST, LEGACY_RESUME_IDENTITY_REFUSAL.to_string());
    }
```

Add the same door-top check at the TOP of `split_pane` in `crates/freshell-freshagent/src/pane_ops.rs:144-149` (BEFORE `resolve_pane_target` at `:154` and `layout.split_pane` at `:175`):

```rust
pub(crate) async fn split_pane(
    State(state): State<FreshAgentState>,
    Path(raw_pane_id): Path<String>,
    headers: HeaderMap,
    Json(body): Json<Value>,
) -> Response {
    if !authorized(&headers, &state.auth_token) {
        return fail_json(StatusCode::UNAUTHORIZED, "unauthorized".to_string());
    }
    // ejh6 (finding 3): door-top presence check BEFORE layout.split_pane so
    // a rejection returns 400 with NO layout mutation.
    if body.get("resumeSessionId").is_some() {
        return fail_json(StatusCode::BAD_REQUEST, LEGACY_RESUME_IDENTITY_REFUSAL.to_string());
    }
    // ... rest unchanged ...
```

Add the same door-top check at the TOP of `respawn_pane` in `crates/freshell-freshagent/src/pane_ops.rs:699-745` (BEFORE `spawn_terminal_pane` at `:719`):

```rust
    // ejh6 (finding 3): door-top presence check BEFORE spawn_terminal_pane.
    if body.get("resumeSessionId").is_some() {
        return fail_json(StatusCode::BAD_REQUEST, LEGACY_RESUME_IDENTITY_REFUSAL.to_string());
    }
```

Update `requested_resume_session_id_for_mode` at `crates/freshell-freshagent/src/terminal_tabs.rs:117-136` — remove the legacy throw (the door-top check is the single rejection point for KISS); keep sessionRef resolution only:

```rust
fn requested_resume_session_id_for_mode(
    session_ref: Option<&SessionLocator>,
    mode: &str,
    _legacy_resume_session_id: Option<&str>,
) -> Result<Option<String>, Response> {
    // ejh6: the legacy throw moved to the door-top check in each axum handler
    // (finding 3). This function keeps its sessionRef-resolution role only.
    // The _legacy param is retained in the signature for caller compatibility
    // but is intentionally unused — the door-top check already rejected any
    // body carrying the field.
    let accepted = accepted_session_ref_for_mode(session_ref, mode);
    if let Some(ref sref) = accepted {
        return Ok(Some(sref.session_id.clone()));
    }
    Ok(None)
}
```

Add section 3c doc comments to `crates/freshell-protocol/src/client_messages.rs` (same as before — `:231-235` TerminalCreate, `:409-411` ReconcilePane PERMANENT, `:445` CodingCliCreate, `:511` FreshAgentCreate, `:527` FreshAgentAttach).

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-freshagent legacy_reject_`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The codex-specific throw in `requested_resume_session_id_for_mode` is gone — the door-top check subsumes all modes. The function now does only sessionRef resolution. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Run: `cargo test -p freshell-freshagent`

Expected: PASS (WIRE-SEND REST tests converted in Task 3; REJECTION-READY codex test at `:4415` still sends legacy and expects 400 — green via door-top check; `rest_create_legacy_resume_*409` tests send sessionRef only — green; `:6334` flipped; remote-tab-linkage re-carriered + rejection case appended).

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-freshagent/src/lib.rs crates/freshell-freshagent/src/terminal_tabs.rs crates/freshell-freshagent/src/pane_ops.rs crates/freshell-freshagent/src/pane_ops_tests.rs crates/freshell-protocol/src/client_messages.rs test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts test/e2e-browser/playwright.config.ts
git commit -m "feat(ejh6): Rust REST door-top presence reject + section 3c docs + remote-tab-linkage re-carrier + RUST_ONLY_SPECS fix"
```

---

### Task 6: Rust WS `terminal.create`/codingcli reject — raw-Value pre-parse guard at dispatch + reconcile permanent-compat doc

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs:693` (insert blanket reject at the EARLIEST post-parse point in the `ClientMessage::TerminalCreate` dispatch arm — BEFORE `create_dedupe.begin` at `:699` and BEFORE `spawn_gated_restore_create` at `:735`, per finding 4: a restore:true codex carrying legacy must be rejected before any disk-gate planning)
- Modify: `crates/freshell-ws/src/terminal.rs:2441-2457` (remove the now-redundant scoped gate)
- Modify: `crates/freshell-ws/src/terminal.rs:1543-1544` (`create_session_locator` — comment the legacy rung as dead-from-wire)
- Modify: `crates/freshell-ws/src/terminal.rs:1883-1886` (`derive_launch_prep` — comment the legacy rung as dead-from-wire)
- Modify: `crates/freshell-ws/src/reconcile.rs:162-177` (add permanent-compat doc to `promoted_legacy_claim`)
- Test: `crates/freshell-ws/tests/live_session_ref_guard.rs:140` (re-target to INVALID_MESSAGE), add new any-mode blanket-reject test
- Test: `crates/freshell-ws/tests/resume_validation_gate.rs:750,:823,:1015` (re-target codex-exemption cases to INVALID_MESSAGE)
- Test: `crates/freshell-ws/tests/amplifier_launcher_identity.rs:341` (V5 premise-inversion: `amplifier_create_rejects_second_live_resume_of_same_session` — second create sends `"resumeSessionId": sid` and asserts `RESTORE_UNAVAILABLE`; post-gate the answer is `INVALID_MESSAGE` + frozen text. Re-target the assertion.)
- Test: `crates/freshell-ws/tests/codex_session_ref_resume.rs:363-381` (V5 premise-inversion: Phase 3 "the raw resumeSessionId fallback must be preserved" — codex WS raw-legacy create asserting acceptance + spawn-argv `resume <raw_id>` pins. Post-gate (codex exemption removed) this becomes a rejection test: expect `INVALID_MESSAGE` + frozen text, no spawn. Convert Phase 3 from acceptance to rejection; Phase 1/2 sessionRef argv coverage survives.)

**Interfaces:**
- Consumes: `LEGACY_RESUME_IDENTITY_REFUSAL` (from Task 1); `send_create_error(out, ErrorCode::InvalidMessage, msg, request_id)` at `terminal.rs:4404`; `TerminalCreate.resume_session_id` field.
- Produces: any `terminal.create` carrying a non-empty `resume_session_id` is answered with `error{INVALID_MESSAGE}` + frozen text, before any side effect (no keyed-create adopt, no D8 claim, no spawn, no registry row).

- [ ] **Step 1: Write the failing behavioral test**

Add to `crates/freshell-ws/tests/live_session_ref_guard.rs` (after `legacy_only_restore_is_refused_invalid_message` at `:210`). Per finding 2: use PRESENCE (`is_some()`), not `is_some_and(|s| !s.is_empty())`. Per finding 4: add duplicate-requestId and restore+codex cases:

```rust
/// ejh6: a `terminal.create` carrying `resumeSessionId` is rejected with
/// `INVALID_MESSAGE` + frozen text on ANY mode, ANY restore state, and even
/// when a companion `sessionRef` is present. No spawn, no registry row.
/// Per finding 2: presence-based — `resumeSessionId: ""` is also rejected.
#[tokio::test]
async fn legacy_reject_ws_terminal_create() {
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
        ("empty-string-presence", "req-blanket-4", json!({
            "type": "terminal.create", "requestId": "req-blanket-4",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": "",
        })),
        // ejh6 review round 2 finding 8 + T6 raw-guard redesign: Rust WS is
        // FULL presence — the raw-Value guard sees ANY JSON value, including
        // null (which serde Option<String> would absorb into None) and
        // non-strings (which accept-and-strip would silently drop). All get
        // the frozen text.
        ("null-presence", "req-blanket-5", json!({
            "type": "terminal.create", "requestId": "req-blanket-5",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": null,
        })),
        ("number-presence", "req-blanket-6", json!({
            "type": "terminal.create", "requestId": "req-blanket-6",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": 42,
        })),
        ("object-presence", "req-blanket-7", json!({
            "type": "terminal.create", "requestId": "req-blanket-7",
            "mode": "claude", "shell": "system",
            "cwd": std::env::temp_dir().to_string_lossy(),
            "resumeSessionId": {"nested": true},
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
    assert!(registry.identity_probe_rows().is_empty(), "no terminal may spawn");
}

/// ejh6 finding 4: a duplicate-requestId replay carrying legacy gets
/// INVALID_MESSAGE, not the cached terminal.created — the reject fires
/// BEFORE create_dedupe.begin.
#[tokio::test]
async fn legacy_reject_ws_duplicate_request_id_with_legacy() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    // First: a successful shell create to seed the dedupe cache.
    send_create(&mut ws, json!({
        "type": "terminal.create", "requestId": "req-dup-seed",
        "mode": "shell", "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
    })).await;
    let _created = next_frame_of_type(&mut ws, "terminal.created").await;
    // Replay: same requestId but carrying legacy — must get INVALID_MESSAGE, not cached created.
    send_create(&mut ws, json!({
        "type": "terminal.create", "requestId": "req-dup-seed",
        "mode": "claude", "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
        "resumeSessionId": "legacy-dup",
    })).await;
    let err = expect_refusal_for(&mut ws, "req-dup-seed").await;
    assert_eq!(err["code"], json!("INVALID_MESSAGE"), "duplicate replay with legacy must reject: {err}");
}

/// ejh6 finding 4: restore:true + codex + legacy is rejected BEFORE
/// spawn_gated_restore_create / prepare_launch (no disk-gate planning).
#[tokio::test]
async fn legacy_reject_ws_restore_codex_legacy() {
    let (url, registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    send_create(&mut ws, json!({
        "type": "terminal.create", "requestId": "req-restore-codex-legacy",
        "mode": "codex", "shell": "system", "cwd": std::env::temp_dir().to_string_lossy(),
        "restore": true, "resumeSessionId": "thread-raw-restore-codex",
    })).await;
    let err = expect_refusal_for(&mut ws, "req-restore-codex-legacy").await;
    assert_eq!(err["code"], json!("INVALID_MESSAGE"), "restore+codex+legacy must reject before disk gate: {err}");
    assert_eq!(err["message"], json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."));
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

In `crates/freshell-ws/tests/amplifier_launcher_identity.rs:341` (`amplifier_create_rejects_second_live_resume_of_same_session`, V5 premise-inversion): the second create sends `"resumeSessionId": sid` and currently asserts `RESTORE_UNAVAILABLE` (its doc comment `:289-296` explains the legacy carrier rides the D7 ladder). Post-gate the answer is `INVALID_MESSAGE` + frozen text at the door (the blanket reject fires before D7). Re-target the assertion:

```rust
    let err = expect_refusal_for(&mut ws, &request_id).await;
    assert_eq!(err["code"], json!("INVALID_MESSAGE"), "post-ejh6 the legacy carrier is rejected at the door, not via D7: {err}");
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
```

In `crates/freshell-ws/tests/codex_session_ref_resume.rs:363-381` (Phase 3, V5 premise-inversion): the test `create_codex_terminal(&mut ws, "req-raw-resume", json!({ "resumeSessionId": raw_id }))` currently asserts acceptance verbatim (`:381` "the raw resumeSessionId fallback must be preserved") plus spawn-argv `resume <raw_id>` pins. Post-gate (codex exemption removed) this becomes a rejection test — convert Phase 3 from acceptance to rejection:

```rust
    // Phase 3 (ejh6): the raw resumeSessionId fallback is REJECTED at the door
    // (codex exemption removed; uniform any-carry reject).
    send_json(&mut ws, &json!({
        "type": "terminal.create", "requestId": "req-raw-resume",
        "mode": "codex", "shell": "system",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "resumeSessionId": raw_id,
    })).await;
    let err = expect_refusal_for(&mut ws, "req-raw-resume").await;
    assert_eq!(err["code"], json!("INVALID_MESSAGE"), "codex raw-legacy is no longer accepted: {err}");
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
```

Phase 1/2 sessionRef argv coverage survives (those sends use sessionRef, not legacy). Delete the spawn-argv `resume <raw_id>` pins for Phase 3 (no spawn occurs on a 400).

Pin the codingcli arm of the raw guard (Rust has no codingcli handler, so the guard is the only rejector; add to `crates/freshell-ws/tests/live_session_ref_guard.rs`):

```rust
/// ejh6: a codingcli.create carrying the legacy field hits the raw-Value
/// guard with INVALID_MESSAGE + frozen text (Rust has no codingcli handler —
/// without the guard this silently no-ops; the guard is the loud rejector).
#[tokio::test]
async fn legacy_reject_ws_codingcli_create() {
    let (url, _registry) = spawn_server().await;
    let (mut ws, _inv) = connect_and_capture_inventory(&url).await;
    send_json(&mut ws, &json!({
        "type": "codingcli.create", "requestId": "req-codingcli-legacy",
        "prompt": "hi", "provider": "claude",
        "resumeSessionId": "legacy-codingcli",
    })).await;
    let err = expect_refusal_for(&mut ws, "req-codingcli-legacy").await;
    assert_eq!(err["code"], json!("INVALID_MESSAGE"), "{err}");
    assert_eq!(
        err["message"],
        json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
    );
}
```
(Verify `connect_and_capture_inventory`/`send_json`/`expect_refusal_for` exist in that file's own helper set before pasting — adapt names if the file's harness differs.)

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test live_session_ref_guard legacy_reject_ && cargo test -p freshell-ws --test live_session_ref_guard legacy_resume_session_id_create_is_refused`

Expected: FAIL because the current scoped gate at `:2441` only rejects restore+non-codex+legacy-only — the codex-no-restore case and the companion-sessionref case are silently accepted (spawn happens).

- [ ] **Step 3: Add the minimal production implementation**

Insert a raw-Value pre-parse guard in the WS dispatch in `crates/freshell-ws/src/terminal.rs` — review round 2 finding 8 demands the raw layer, because the typed path cannot deliver the contract: serde `Option<String>` absorbs JSON `null` into `None` (silent accept of `resumeSessionId: null`) and a non-string value fails the `from_value` parse into the accept-and-strip `else { return true }` arm at `:651` (total silent drop of `resumeSessionId: 42`). The guard fires BEFORE the typed parse, hence also BEFORE `create_dedupe.begin` (finding 4: duplicate-rid replay gets INVALID_MESSAGE, not cached `terminal.created`) and BEFORE `spawn_gated_restore_create`/`prepare_launch` (restore:true codex carrying legacy rejected before any disk-gate planning). Insert IMMEDIATELY after the `tabs.sync.*` fast-path block (`:638-648`) and before `let Ok(message) = serde_json::from_value::<ClientMessage>(value) else {`:

```rust
    // ejh6 (review round 2 findings 2/4/8): raw-Value legacy-resume guard.
    // Reject ANY create-class message carrying a top-level `resumeSessionId`
    // with ANY JSON value (string, empty, null, number, object) at the raw
    // layer. The typed structs' Option<String> READS CANNOT DO THIS JOB:
    // serde absorbs JSON `null` into None (silent accept), and a non-string
    // carry fails the whole typed parse into the accept-and-strip arm below
    // (silent drop, no terminal, no error). Presence must be read here, at
    // the raw layer, before dedupe/restore planning (zero side effects on
    // reject). This task arms the two INVALID_MESSAGE families
    // (terminal.create, codingcli.create); Task 7 arms the freshAgent
    // families (create.failed envelope / attach event channel).
    if let Some(resume_value) = value.get("resumeSessionId") {
        let _ = resume_value; // presence is what matters; value never read
        match value.get("type").and_then(|t| t.as_str()) {
            Some("terminal.create") | Some("codingcli.create") => {
                let reply = ServerMessage::Error(ErrorMsg {
                    code: ErrorCode::InvalidMessage,
                    message: LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
                    timestamp: crate::now_iso(),
                    actual_session_ref: None,
                    expected_session_ref: None,
                    request_id: value
                        .get("requestId")
                        .and_then(|r| r.as_str())
                        .map(str::to_string),
                    retry_after_ms: None,
                    terminal_exit_code: None,
                    terminal_id: None,
                });
                return send(ws_tx, &reply).await;
            }
            _ => {} // freshAgent.* armed in Task 7; all other types unaffected
        }
    }

    let Ok(message) = serde_json::from_value::<ClientMessage>(value) else {
        return true;
    };
```

Add the imports to `terminal.rs`'s use block at `:62-67`: `ErrorMsg` joins `freshell_protocol::{...}` (verify the exact re-export surface — `freshell_protocol::ErrorMsg`, `ErrorCode`, and `LEGACY_RESUME_IDENTITY_REFUSAL` are all re-exported via `pub use` per Task 1 + existing server_messages/common re-exports); `crate::now_iso()` exists (used at `:1629`).

Remove the now-redundant scoped gate at `:2441-2457`. Comment the legacy rungs at `:1543-1544` and `:1883-1886` as dead-from-wire (same as before). Add the permanent-compat doc to `reconcile.rs:162-177` (same as before).

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
git add crates/freshell-ws/src/terminal.rs crates/freshell-ws/src/reconcile.rs crates/freshell-ws/tests/live_session_ref_guard.rs crates/freshell-ws/tests/resume_validation_gate.rs crates/freshell-ws/tests/amplifier_launcher_identity.rs crates/freshell-ws/tests/codex_session_ref_resume.rs
git commit -m "feat(ejh6): Rust WS terminal.create blanket reject (pre-dedupe) + reconcile permanent-compat doc + amplifier/codex re-target"
```

---

### Task 7: Rust WS freshAgent.create/attach reject + `attach_durable_id` hygiene

**Files:**
- Modify: `crates/freshell-ws/src/terminal.rs:62-67` (import `FreshAgentCreateFailed`, `FreshAgentEvent`) and extend the Task-6 raw-Value guard (inserted after the tabs.sync fast-path in dispatch) with the freshAgent arms — NOT the typed `fresh_agent_control_refusal` (review round 2 finding 8: the typed layer cannot see JSON null/non-string carries)
- Modify: `crates/freshell-freshagent/src/claude.rs:1809-1819` (`attach_durable_id` — flip to sessionRef-first with comment)
- Test: `crates/freshell-ws/tests/freshagent_claude_attach.rs` (add legacy-carrying attach rejection test — use the file's own harness APIs per V3: `CLAUDE_ENV_LOCK`, `FakeClaudeResumeEnv::install(<durable>)`, `spawn_server() -> String`, `connect_and_complete_handshake(&url)`, `request_log_rows()`)
- Test: `crates/freshell-ws/tests/freshagent_session_lease.rs` (add legacy-carrying create rejection test — use the file's own harness APIs per V3: `LEASE_ENV_LOCK`, `FakeLeaseSidecarEnv::install()`, `spawn_server() -> String`, `connect(&url, true)`, `create_rows()`)
- Test: `crates/freshell-ws/tests/cross_kind_liveness.rs:411,:460` (V5 premise-inversion: `freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session` at `:411` sends dual-carrier `freshAgent.create` asserting `freshAgent.create.failed{code: SESSION_RESERVED}` — post Task 7 the refusal fires earlier with the create-failed envelope code `FRESH_AGENT_CREATE_FAILED` + frozen text; `terminal_create_is_refused_while_a_live_sidecar_owns_the_session` at `:444` setup create at `:460` sends dual-carrier expecting success — rejected outright, so the D7 scenario it stages never materializes. Mechanically re-carrier the setup sends (drop the legacy line — sessionRef already present) and re-target the `:411` assertion from `SESSION_RESERVED` to `FRESH_AGENT_CREATE_FAILED` + frozen text.)

**Interfaces:**
- Consumes: `LEGACY_RESUME_IDENTITY_REFUSAL` (from Task 1); the Task-6 raw-Value guard in `terminal.rs` dispatch (extended here); `ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed{code,message,request_id,retryable})` (`server_messages.rs:618-627`); `ServerMessage::FreshAgentEvent(FreshAgentEvent{event,provider,session_id,session_type})`; `send(ws_tx, &msg)` (`terminal.rs:85`).
- Produces: `freshAgent.create` carrying `resume_session_id` then `freshAgent.create.failed{code:"FRESH_AGENT_CREATE_FAILED", message:<frozen>, retryable:false}`; `freshAgent.attach` carrying `resume_session_id` then `freshAgent.event{freshAgent.error{code:"FRESH_AGENT_CREATE_FAILED", message:<frozen>}}` keyed by session id; no sidecar spawn.

- [ ] **Step 1: Write the failing behavioral test**

Add to `crates/freshell-ws/tests/freshagent_claude_attach.rs` (per V3 substitution table — this file is self-contained, NO `mod common`; use the file's own `CLAUDE_ENV_LOCK`, `FakeClaudeResumeEnv::install(<durable>)` (mandatory durable-id arg), `spawn_server() -> String` (bare URL, NOT a 2-tuple), `connect_and_complete_handshake(&url)`, `send_json`, `await_frame`, and `request_log_rows()` for the no-spawn pin):

```rust
/// ejh6: a `freshAgent.attach` carrying `resumeSessionId` is rejected with
/// `freshAgent.error{code:"FRESH_AGENT_CREATE_FAILED"}` + frozen text. No
/// sidecar spawn, no manager.attach call. Attach has no requestId, so the
/// rejection rides the freshAgent.error event channel keyed by sessionId.
#[tokio::test]
async fn legacy_reject_freshagent_attach() {
    let _guard = CLAUDE_ENV_LOCK.lock().await;
    let env = FakeClaudeResumeEnv::install("legacy-durable-id");
    let url = spawn_server().await;
    let mut ws = connect_and_complete_handshake(&url).await;

    // ejh6 presence (finding 9): rejection fires for any string, including "".
    for (label, legacy) in [("string", "legacy-durable-id"), ("empty-string", "")] {
        send_json(
            &mut ws,
            &json!({
                "type": "freshAgent.attach",
                "sessionId": "cli-session-legacy-attach",
                "sessionType": "freshclaude",
                "provider": "claude",
                "resumeSessionId": legacy,
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
            "{label}: attach legacy reject must use the create-failed family code: {err}"
        );
        assert_eq!(
            err["event"]["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: frozen text: {err}"
        );
    }
    // V3: this file has NO create_rows(); use request_log_rows() and filter for create rows.
    let create_count = env
        .request_log_rows()
        .into_iter()
        .filter(|r| r["msg"]["type"] == "create")
        .count();
    assert_eq!(create_count, 0, "no sidecar may spawn for a rejected legacy attach");
}
```

Add to `crates/freshell-ws/tests/freshagent_session_lease.rs` (per V3 substitution table — use `LEASE_ENV_LOCK`, `FakeLeaseSidecarEnv::install()` (no-arg), `spawn_server() -> String`, `connect(&url, true)` (2-arg, `negotiated: bool`), `create_rows()`):

```rust
/// ejh6: a `freshAgent.create` carrying `resumeSessionId` is rejected with
/// `freshAgent.create.failed{code:"FRESH_AGENT_CREATE_FAILED"}` + frozen text.
/// No sidecar spawn. Create has a requestId, so the rejection uses the
/// create-failed envelope.
#[tokio::test]
async fn legacy_reject_freshagent_create() {
    let _guard = LEASE_ENV_LOCK.lock().await;
    let env = FakeLeaseSidecarEnv::install();
    let url = spawn_server().await;
    let mut ws = connect(&url, true).await;

    // ejh6 presence (finding 9): rejection fires for any string, including "".
    for (label, legacy, req_id) in [
        ("string", "legacy-durable-id", "req-fa-legacy-create"),
        ("empty-string", "", "req-fa-legacy-create-empty"),
    ] {
        send_json(
            &mut ws,
            &json!({
                "type": "freshAgent.create",
                "requestId": req_id,
                "sessionType": "freshclaude",
                "provider": "claude",
                "cwd": "/tmp",
                "resumeSessionId": legacy,
            }),
        )
        .await;

        let failed = await_frame(&mut ws, Duration::from_secs(10), |v| {
            v["type"] == "freshAgent.create.failed" && v["requestId"].as_str() == Some(req_id)
        })
        .await;
        assert_eq!(failed["code"], json!("FRESH_AGENT_CREATE_FAILED"), "{label}: create-failed family code: {failed}");
        assert_eq!(
            failed["message"],
            json!("Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."),
            "{label}: frozen text: {failed}"
        );
        assert_eq!(failed["retryable"], json!(false));
    }
    assert!(
        env.create_rows().is_empty(),
        "no sidecar may spawn for a rejected legacy create: {:?}", env.create_rows()
    );
}
```

Re-target `crates/freshell-ws/tests/cross_kind_liveness.rs:411` (V5 premise-inversion, `freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session`): the test at `:411` sends dual-carrier `freshAgent.create` (BOTH `resumeSessionId` AND `sessionRef`) and currently asserts `freshAgent.create.failed{code: SESSION_RESERVED}` (`:425`). Post Task 7, the refusal fires earlier — the raw-Value ejh6 guard's freshAgent.create arm returns `FRESH_AGENT_CREATE_FAILED` + frozen text BEFORE the typed parse reaches the per-provider handler (which would have emitted `SESSION_RESERVED`). KEEP the legacy line in the `:411` send (so the legacy-field arm fires) and re-target the assertion:

```rust
    assert_eq!(
        failed["type"], "freshAgent.create.failed",
        "a live terminal PTY owns {session_id}: the fresh-agent resume must be refused, got {failed}"
    );
    // ejh6: the legacy field is rejected at the door BEFORE the SESSION_RESERVED
    // cross-kind guard fires (the raw-Value ejh6 guard's freshAgent.create arm
    // runs first). The code is FRESH_AGENT_CREATE_FAILED + frozen text, not
    // SESSION_RESERVED.
    assert_eq!(failed["code"], "FRESH_AGENT_CREATE_FAILED");
    assert_eq!(
        failed["message"],
        "Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity."
    );
```

Re-carrier the SETUP create at `:460` (`terminal_create_is_refused_while_a_live_sidecar_owns_the_session`) — drop the `resumeSessionId` line (sessionRef already present) so the setup `freshAgent.create` SUCCEEDS and the D7 scenario it stages can proceed (the test's own D7 `RESTORE_UNAVAILABLE` assertion is unaffected — it's driven by the `terminal.create` with sessionRef, not the freshAgent.create setup). NOTE: V3 found this file uses `ENV_LOCK`, `FakeSidecarEnv::install()` (no-arg), 2-tuple `spawn_server()`, 1-arg `connect(&url)` — the cross_kind_liveness-specific harness, NOT the per-file harnesses of the other two files. Keep those names for THIS file's edits.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `cargo test -p freshell-ws --test freshagent_claude_attach legacy_reject_freshagent_attach && cargo test -p freshell-ws --test freshagent_session_lease legacy_reject_freshagent_create`

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

Extend the Task-6 raw-Value guard in `crates/freshell-ws/src/terminal.rs` dispatch with the freshAgent arms — NOT the typed `fresh_agent_control_refusal` (review round 2 finding 8: the typed layer sits AFTER `from_value`, so JSON `null` deserializes to `None` before it and non-string values get swallowed by the accept-and-strip arm — the raw layer is the only full-presence read). Change the guard's tail (currently `_ => {}`):

```rust
        match value.get("type").and_then(|t| t.as_str()) {
            Some("terminal.create") | Some("codingcli.create") => {
                // ... unchanged Task-6 INVALID_MESSAGE + frozen text arm ...
            }
            // Task 7: freshAgent arms. The legacy field on a freshAgent
            // create-class message gets the per-family envelope. Create
            // returns `freshAgent.create.failed` (it carries requestId);
            // attach has NO requestId, so its rejection rides the
            // `freshAgent.error` event channel keyed by sessionId — the same
            // shape claude.rs:265-282 broadcasts today. Built from the raw
            // frame: presence already proven by the guard condition.
            Some("freshAgent.create") => {
                let reply = ServerMessage::FreshAgentCreateFailed(FreshAgentCreateFailed {
                    code: "FRESH_AGENT_CREATE_FAILED".to_string(),
                    message: LEGACY_RESUME_IDENTITY_REFUSAL.to_string(),
                    request_id: value
                        .get("requestId")
                        .and_then(|r| r.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    retryable: Some(false),
                });
                return send(ws_tx, &reply).await;
            }
            Some("freshAgent.attach") => {
                let session_id = value
                    .get("sessionId")
                    .and_then(|s| s.as_str())
                    .unwrap_or_default();
                let reply = ServerMessage::FreshAgentEvent(FreshAgentEvent {
                    event: serde_json::json!({
                        "type": "freshAgent.error",
                        "sessionId": session_id,
                        "code": "FRESH_AGENT_CREATE_FAILED",
                        "message": LEGACY_RESUME_IDENTITY_REFUSAL,
                    }),
                    provider: value
                        .get("provider")
                        .and_then(|p| p.as_str())
                        .unwrap_or_default()
                        .to_string(),
                    session_id: session_id.to_string(),
                    session_type: value
                        .get("sessionType")
                        .and_then(|s| s.as_str())
                        .unwrap_or_default()
                        .to_string(),
                });
                return send(ws_tx, &reply).await;
            }
            _ => {} // not a create-class type; fall through to typed parse
        }
```

(If the Task-6 guard was written as a single `if let Some(...)` around the match, keep that form — this edit only replaces the `_ => {}` tail with the two freshAgent arms plus the non-create fallthrough.)

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

Add the ordering pin alongside the flip, in claude.rs's `#[cfg(test)]` mod: a direct-call unit test named `attach_durable_id_prefers_session_ref_over_legacy` covering (i) both carriers set with DIFFERENT canonical UUIDs → returns the sessionRef's id, (ii) sessionRef-only → its id, (iii) legacy-only → its id (test-compat lane), (iv) neither → None. Use canonical-UUID shapes (e.g. `11111111-2222-4333-8444-555555555555` / `aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee`) — the helper's `is_canonical_claude_uuid` gate rejects anything else. Red evidence: against the pre-flip legacy-first ordering, case (i) returns the legacy id and fails.

- [ ] **Step 4: Run the focused test**

Run: `cargo test -p freshell-ws --test freshagent_claude_attach legacy_reject_freshagent_attach && cargo test -p freshell-ws --test freshagent_session_lease legacy_reject_freshagent_create && cargo test -p freshell-ws --test cross_kind_liveness freshagent_resume_is_refused_while_a_terminal_pty_owns_the_session && cargo test -p freshell-freshagent attach_durable_id && cargo test -p freshell-freshagent attach_untracked_without_any_durable_id_still_emits_lost_frame && cargo test -p freshell-freshagent concurrent_attaches_for_the_same_durable_id_spawn_at_most_one_sidecar && cargo test -p freshell-freshagent attach_with_durable_id_already_indexed_rebinds_and_acks`

Expected: PASS. The `attach_durable_id` filter selects the Step-3 ordering pin (`attach_durable_id_prefers_session_ref_over_legacy`) — bare helper-name filters match zero pre-existing tests, so the three durable-id attach tests are invoked by their real names to exercise the changed sessionRef-first selection through the handler.

- [ ] **Step 5: Refactor while green**

The raw-Value ejh6 guard now covers all four create-class families at one site (terminal.create + codingcli.create in Task 6; freshAgent.create + freshAgent.attach here). `fresh_agent_control_refusal` is untouched — its control-frame capability table is orthogonal. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Every Rust WS freshAgent test is impacted. The WIRE-SEND freshAgent tests were converted in Task 3 (they send sessionRef). Run the full `freshell-ws` suite plus the `freshell-freshagent` suite (for `attach_durable_id` + claude handlers).

Run: `cargo test -p freshell-ws && cargo test -p freshell-freshagent`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add crates/freshell-ws/src/terminal.rs crates/freshell-freshagent/src/claude.rs crates/freshell-ws/tests/freshagent_claude_attach.rs crates/freshell-ws/tests/freshagent_session_lease.rs crates/freshell-ws/tests/cross_kind_liveness.rs
git commit -m "feat(ejh6): Rust WS freshAgent create/attach reject legacy field + attach_durable_id hygiene + cross_kind re-target"
```

---

### Task 8: Node REST reject — door-top presence check on all routes (Node-side)

**Files:**
- Modify: `server/agent-api/router.ts:695` (top of `POST /tabs` — insert door-top check before agent/browser/editor/terminal branch), `:1250` (top of `POST /panes/:id/split`), `:1546` (top of `POST /panes/:id/respawn`); `:214-228` (`requestedResumeSessionIdForMode` — remove the legacy throw; keep sessionRef resolution only; single check at door-top for KISS per finding 3)
- Test: `test/server/agent-tabs-write.test.ts:413` (add `it.each` for all modes + dual-carrier + presence-edge + browser/editor tests)
- Test: `test/server/agent-panes-write.test.ts:132,:327` (widen to all modes + layout-unchanged on split) AND `:339` (finding 7: door-top respawn rejection now returns BEFORE target resolution — flip the existing `expect(resolveTarget).toHaveBeenCalledWith('pane_1')` to `expect(resolveTarget).not.toHaveBeenCalled()`)

**Interfaces:**
- Consumes: `INVALID_RAW_CODEX_RESUME_MESSAGE` (`restore-decision.ts:27-28`); `fail(message)` returns `{status:'error',message}` (`response.ts:6`).
- Produces: all three Node REST doors return HTTP 400 `{status:'error',message:<frozen>}` at the door-top whenever `req.body?.resumeSessionId !== undefined` (presence — any value including `""`, `null`, `42`), BEFORE any branch. `requestedResumeSessionIdForMode` keeps sessionRef resolution only.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/server/agent-tabs-write.test.ts` (after the existing codex-reject test at `:413`). Per finding 2: presence-based — `""`, `null`, `42` are also rejected. Per finding 3: browser/editor branches also 400:

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
    const res = await request(app).post('/api/tabs').send({ mode, name: `legacy ${mode}`, resumeSessionId: `legacy-${mode}-id` })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ status: 'error', message: INVALID_RAW_CODEX_RESUME_MESSAGE })
    expect(registry.create).not.toHaveBeenCalled()
    expect(layoutStore.createTab).not.toHaveBeenCalled()
  })

  it('rejects legacy resumeSessionId even with a companion sessionRef', async () => {
    const app = express()
    app.use(express.json())
    const registry = { create: vi.fn(), killAndWait: vi.fn(async () => true) }
    const codexLaunchPlanner = new FakeCodexLaunchPlanner()
    const layoutStore = { createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })), attachPaneContent: vi.fn(), selectTab: () => ({}), renameTab: () => ({}), closeTab: () => ({}), hasTab: () => true, selectNextTab: () => ({ tabId: 'tab_1' }), selectPrevTab: () => ({ tabId: 'tab_1' }) }
    app.use('/api', createAgentApiRouter({ layoutStore, registry, codexLaunchPlanner }))
    const res = await request(app).post('/api/tabs').send({ mode: 'claude', resumeSessionId: 'legacy', sessionRef: { provider: 'claude', sessionId: 'canonical' } })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ status: 'error', message: INVALID_RAW_CODEX_RESUME_MESSAGE })
  })

  // ejh6 finding 2: presence-based — "", null, 42 are all rejected.
  it.each([
    ['empty-string', ''],
    ['null', null],
    ['number', 42],
  ])('rejects resumeSessionId presence (%s)', async (_label, val) => {
    const app = express()
    app.use(express.json())
    const layoutStore = { createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })), attachPaneContent: vi.fn(), selectTab: () => ({}), renameTab: () => ({}), closeTab: () => ({}), hasTab: () => true, selectNextTab: () => ({ tabId: 'tab_1' }), selectPrevTab: () => ({ tabId: 'tab_1' }) }
    app.use('/api', createAgentApiRouter({ layoutStore, registry: { create: vi.fn() }, codexLaunchPlanner: new FakeCodexLaunchPlanner() }))
    const res = await request(app).post('/api/tabs').send({ mode: 'claude', resumeSessionId: val })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ status: 'error', message: INVALID_RAW_CODEX_RESUME_MESSAGE })
  })

  // ejh6 finding 3: browser/editor branches also 400.
  it.each([
    ['browser', { browser: 'https://example.com' }],
    ['editor', { editor: '/tmp/file.ts' }],
  ])('rejects resumeSessionId on %s branch', async (_label, extra) => {
    const app = express()
    app.use(express.json())
    const layoutStore = { createTab: vi.fn(() => ({ tabId: 'tab_1', paneId: 'pane_1' })), attachPaneContent: vi.fn(), selectTab: () => ({}), renameTab: () => ({}), closeTab: () => ({}), hasTab: () => true, selectNextTab: () => ({ tabId: 'tab_1' }), selectPrevTab: () => ({ tabId: 'tab_1' }) }
    app.use('/api', createAgentApiRouter({ layoutStore, registry: { create: vi.fn() }, codexLaunchPlanner: new FakeCodexLaunchPlanner() }))
    const res = await request(app).post('/api/tabs').send({ resumeSessionId: 'legacy', ...extra })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({ status: 'error', message: INVALID_RAW_CODEX_RESUME_MESSAGE })
  })
```

Lockstep edit (review round 2 finding 7): in `test/server/agent-panes-write.test.ts` the existing codex respawn rejection test (`:311-340`, 'rejects raw Codex resume ids before respawning a pane') ends its not-called chain with `expect(resolveTarget).toHaveBeenCalledWith('pane_1')` at `:339`. With this task's door-top guard the rejection returns BEFORE target resolution — change that one assertion to:

```ts
  expect(resolveTarget).not.toHaveBeenCalled()
```

Leave the rest of that test untouched (`planCreateCalls` empty, `registryCreate`/`attachPaneContent` not called, 400 + frozen text). Also widen the split/respawn rejection tests at `:132`/`:327` to it.each over modes `['claude','codex','opencode','amplifier']` with presence-edge bodies per Global Constraints (`'legacy-x'`, `''`, `null`, `42` — Node REST reads `req.body`, so unlike WS these DO reject with the frozen text), and keep the existing 400+message assertions.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/server/agent-tabs-write.test.ts --config config/vitest/vitest.server.config.ts`

Expected: FAIL because the non-codex modes silently accept the legacy field, the browser/editor branches bypass the check entirely, and `""`/`null`/`42` are not rejected by `isNonEmptyString` — the tests get 200 instead of 400.

- [ ] **Step 3: Add the minimal production implementation**

Add a door-top presence check at the TOP of each Express route handler in `server/agent-api/router.ts` — `POST /tabs` at `:695` (before the agent branch at `:698`), `POST /panes/:id/split` at `:1250` (before `splitPane`/`spawn_terminal_pane`), `POST /panes/:id/respawn` at `:1546` (before `spawn_terminal_pane`). Per finding 2: presence check (`!== undefined`), not `isNonEmptyString`. Per finding 3: single check at door-top for KISS.

```ts
  router.post('/tabs', async (req, res) => {
    // ejh6 (finding 3): door-top presence check BEFORE any branch.
    if (req.body?.resumeSessionId !== undefined) {
      return res.status(400).json(fail(INVALID_RAW_CODEX_RESUME_MESSAGE))
    }
    const { name, mode, shell, cwd, browser, editor, permissionMode, model, sandbox } = req.body || {}
    // ... rest unchanged ...
```

Repeat the same door-top check at the top of `POST /panes/:id/split` and `POST /panes/:id/respawn`.

Update `requestedResumeSessionIdForMode` at `:214-228` — remove the legacy throw (the door-top check is the single rejection point); keep sessionRef resolution only:

```ts
function requestedResumeSessionIdForMode(
  sessionRef: ReturnType<typeof sanitizeSessionRef>,
  mode: string,
  _legacyResumeSessionId: unknown,
): string | undefined {
  // ejh6: the legacy throw moved to the door-top check in each route handler
  // (finding 3). This function keeps its sessionRef-resolution role only.
  const acceptedSessionRef = acceptedSessionRefForMode(sessionRef, mode)
  if (acceptedSessionRef) return acceptedSessionRef.sessionId
  return undefined
}
```

Import `fail` from `./response.js` at the top of `router.ts` if not already imported.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS — the existing codex-reject tests at `:413`/`:132`/`:327` stay green; the new `it.each` + dual-carrier test cover claude/opencode/amplifier and dual-carrier.

- [ ] **Step 5: Refactor while green**

The codex-specific branch in `requestedResumeSessionIdForMode` is gone — the any-mode throw subsumes it. The `isNonEmptyString` helper is already imported. No further refactor needed.

- [ ] **Step 6: Run impacted-test verification**

Every Node REST create test is impacted. The WIRE-SEND REST tests (sidebar-registry-sync-rust.spec.ts) were converted in Task 4. The REJECTION-READY tests (agent-tabs-write, agent-panes-write) are widened in this task.

Run: `npm run test:vitest -- run test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts test/unit/server/mcp/freshell-tool.test.ts --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add server/agent-api/router.ts test/server/agent-tabs-write.test.ts test/server/agent-panes-write.test.ts
git commit -m "feat(ejh6): Node REST uniform any-carry reject legacy resumeSessionId on all modes"
```

---

### Task 9: Node WS `terminal.create` reject + repurpose existing tests + e2e WS assertion

**Files:**
- Modify: `server/ws-handler.ts:2041` (insert blanket reject at the VERY TOP of the `case 'terminal.create':` block, BEFORE `recordSessionLifecycleEvent` at `:2048` and BEFORE the `fresh_after_restore_unavailable` validation at `:2060` — finding 5: a message carrying both intents gets INVALID_MESSAGE with frozen text, not INVALID_CREATE_REQUEST), `:2160-2168` and `:2170-2186` (remove scoped gates), `:784` (section 3c doc comment)
- Modify: `shared/ws-protocol.ts:319-332` (`TerminalCreateSchema` — finding 1: add `resumeSessionId: z.string().optional()` with the retained-for-rejection comment. Nothing today parses inbound terminal.create through the shared schema — the Node server uses the dynamic schema at `ws-handler.ts:772` instead — but the kata demands fields stay declared in EVERY wire schema, and the shared `ClientMessageSchema` union at `:678` includes `TerminalCreateSchema` as the canonical contract. Verify: `rg "TerminalCreateSchema" server/` hits only `ws-handler.ts:678` (the union member) and `:772` (the comment explaining the dynamic override) — no inbound parse path uses it. Note this answer in the plan.)
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

Add presence-edge and dual-intent tests (findings 2, 5):

```ts
  // ejh6 finding 2: presence-based — "" is rejected.
  it('rejects resumeSessionId empty string on terminal.create', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)
      const requestId = 'legacy-reject-empty'
      const errorPromise = waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
      ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'claude', shell: 'system', resumeSessionId: '' }))
      const error = await errorPromise
      expect(error).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE', requestId })
      expect(error.message).toContain('sessionRef')
    } finally {
      await closeWebSocket(ws)
    }
  })

  // ejh6 finding 5: a message carrying BOTH recoveryIntent and resumeSessionId
  // gets INVALID_MESSAGE with frozen text (the mandatory error wins over
  // INVALID_CREATE_REQUEST's "Fresh recovery requests cannot include restore identity").
  it('rejects resumeSessionId even when recoveryIntent is also present', async () => {
    const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
    try {
      await waitForOpen(ws)
      await waitForReady(ws)
      const requestId = 'legacy-reject-dual-intent'
      const errorPromise = waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
      ws.send(JSON.stringify({
        type: 'terminal.create', requestId, mode: 'claude', shell: 'system',
        recoveryIntent: 'fresh_after_restore_unavailable', resumeSessionId: 'legacy',
      }))
      const error = await errorPromise
      expect(error).toMatchObject({ type: 'error', code: 'INVALID_MESSAGE', requestId })
      expect(error.message).toBe('Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.')
    } finally {
      await closeWebSocket(ws)
    }
  })

  // ejh6 review round 3 finding 1: the raw pre-parse guard intercepts ANY
  // JSON value with key-presence BEFORE zod ever runs — non-string carries
  // get the SAME INVALID_MESSAGE + frozen-text envelope as strings on Node
  // (no generic-text residual). Every value pinned with frozen text.
  it.each([['null', null], ['number', 42], ['object', { nested: true }]])(
    'rejects non-string resumeSessionId (%s) with INVALID_MESSAGE + frozen text (raw guard)', async (_label, val) => {
      const ws = trackWebSocket(new WebSocket(`ws://127.0.0.1:${port}/ws`))
      try {
        await waitForOpen(ws)
        await waitForReady(ws)
        const requestId = `legacy-reject-nonstr-${_label}`
        const errorPromise = waitForMessage(ws, (m) => m.type === 'error' && m.requestId === requestId)
        ws.send(JSON.stringify({ type: 'terminal.create', requestId, mode: 'claude', shell: 'system', resumeSessionId: val }))
        const error = await errorPromise
        expect(error).toMatchObject({
          type: 'error', code: 'INVALID_MESSAGE',
          message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
          requestId,
        })
        expect(registry.createCalls).toHaveLength(0)
      } finally {
        await closeWebSocket(ws)
      }
    },
  )
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
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    try {
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

Run: `npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/opencode-session-flow.test.ts --config config/vitest/vitest.server.config.ts && FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/e2e/agent-cli-flow.test.ts`

Expected: FAIL because the current scoped gate only rejects restore+non-codex+legacy-only — the non-restore and companion-sessionRef cases are silently accepted.

- [ ] **Step 3: Add the minimal production implementation**

Insert the Node raw pre-parse presence guard in `server/ws-handler.ts` immediately AFTER the JSON.parse of the raw frame and BEFORE `const parsed = this.clientMessageSchema.safeParse(msg)` at `:1913`. This task arms ONLY the `terminal.create` family arm (Tasks 10/11 arm freshAgent.*/codingcli.create). Review round 3 finding 1 motivates the raw placement: the field's typed schema (`z.string().optional()`) rejects `null`/`42` at parse time with GENERIC text, losing the frozen text every string carry deserves — a raw key-presence check intercepts ANY JSON value before that, and its timing also answers finding 5 (a message carrying both `recoveryIntent` and `resumeSessionId` gets `INVALID_MESSAGE` + frozen text, not the `INVALID_CREATE_REQUEST` the recovery-intent validation would have produced) and finding-4-style side-effect-freedom (**BEFORE** `recordSessionLifecycleEvent`).

```ts
      // (insertion point: ws-handler.ts immediately before `const parsed = this.clientMessageSchema.safeParse(msg)` at :1913 — msg here is the raw JSON.parse result)
      // ejh6 (R3) raw pre-parse presence guard: ANY create-class message
      // carrying a top-level resumeSessionId — string, empty, null, number,
      // object — is rejected HERE, before zod parse, so the frozen text and
      // per-family envelope survive every value type (zod would reject
      // non-strings generically; a typed field reads strings only). The
      // wire schemas keep the field declared (retention, comments in this
      // task) — the guard, not the schema, owns the contract.
      if (typeof msg === 'object' && msg !== null && 'resumeSessionId' in msg) {
        const rawMsg = msg as Record<string, unknown>
        switch (rawMsg.type) {
          case 'terminal.create': {
            this.sendError(ws, {
              code: 'INVALID_MESSAGE',
              message: INVALID_RAW_CODEX_RESUME_MESSAGE,
              requestId: typeof rawMsg.requestId === 'string' ? rawMsg.requestId : undefined,
            })
            return
          }
          // freshAgent.create / freshAgent.attach armed in Task 10;
          // codingcli.create armed in Task 11.
        }
      }
```

Then remove the now-redundant scoped gates at `:2160-2168` and `:2170-2186` (as before — the raw guard fires long before either).

Add the shared `TerminalCreateSchema` field at `shared/ws-protocol.ts:319-332` (finding 1):

```ts
export const TerminalCreateSchema = z.object({
  type: z.literal('terminal.create'),
  requestId: z.string().min(1),
  mode: z.string().default('shell'),
  shell: ShellSchema.default('system'),
  cwd: z.string().optional(),
  /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
  resumeSessionId: z.string().optional(),
  sessionRef: SessionLocatorSchema.optional(),
  // ... rest unchanged ...
}).strict()
```

Note: nothing today parses inbound terminal.create through this shared schema — the Node server's dynamic schema at `ws-handler.ts:772` overrides it — but the kata demands fields stay declared in EVERY wire schema, and `ClientMessageSchema` at `:678` includes it as the canonical contract.

Remove the now-redundant scoped gates at `:2160-2168` (the `codexRestorePlan?.kind === 'reject_invalid_raw_codex_resume_request'` block) and `:2170-2186` (the `m.restore === true && modeSupportsResume && ...` block). The blanket reject at `:2107` fires first for any legacy-carrying create, so these scoped gates are unreachable for legacy carriers.

Add the section 3c doc comment at `server/ws-handler.ts:784`:

```ts
      /** Retained solely so the handler can detect-and-reject; see kata ejh6. */
      resumeSessionId: z.string().optional(),
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/opencode-session-flow.test.ts --config config/vitest/vitest.server.config.ts && FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/e2e/agent-cli-flow.test.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

The `legacyResumeSessionId: m.resumeSessionId` arg at `:2123` is now dead for wire input (the blanket reject fires before `codexRestorePlan` is built) — leave it (harmless; `planCodexCreateRestoreDecision` still handles the no-legacy sessionRef-resume path). The `effectiveResumeSessionId = m.resumeSessionId` lane at `:2132-2136` is dead for wire input — leave it with a comment noting it is dead-from-wire, or remove it if no internal path reaches it.

- [ ] **Step 6: Run impacted-test verification**

Every Node WS `terminal.create` test is impacted. The WIRE-SEND tests were converted in Tasks 2-4. The REJECTION-READY tests are widened in this task.

Run: `npm run test:vitest -- run test/server/ test/integration/server/ --config config/vitest/vitest.server.config.ts`

Expected: PASS

- [ ] **Step 7: Commit the task**

```bash
git add server/ws-handler.ts shared/ws-protocol.ts test/server/ws-terminal-create-reuse-running-codex.test.ts test/server/ws-terminal-create-session-repair.test.ts test/integration/server/opencode-session-flow.test.ts test/e2e/agent-cli-flow.test.ts
git commit -m "feat(ejh6): Node WS terminal.create blanket reject (pre-recovery-intent) + shared TerminalCreateSchema field + repurpose tests + e2e WS assertion"
```

---

### Task 10: Node WS `freshAgent.create`/`freshAgent.attach` reject + ErrorCode enum extension

**Files:**
- Modify: `server/ws-handler.ts:1913` (the Task-9 raw pre-parse guard — extend with the freshAgent.create/freshAgent.attach arms; replaces the per-door head-of-case inserts)
- Modify: `shared/ws-protocol.ts:20-37` (`ErrorCode` enum — add `FRESH_AGENT_CREATE_FAILED` per V2 finding: Task 10's `sendError({code:'FRESH_AGENT_CREATE_FAILED',...})` would not typecheck against `ErrorCode` without this addition), `:482,:497` (section 3c doc comments)
- Test: `test/unit/server/ws-handler-fresh-agent.test.ts` (add legacy-carrying create/attach rejection tests)

**Interfaces:**
- Consumes: `INVALID_RAW_CODEX_RESUME_MESSAGE` (imported in Task 1); `this.send(ws, {type:'freshAgent.create.failed',requestId,code,message,retryable})` (envelope at `ws-handler.ts:3428`); `this.sendError(ws, {code,message})` (attach error shape at `:3589` — `code` typed `z.infer<typeof ErrorCode>`).
- Produces: `freshAgent.create` carrying `resumeSessionId` then `freshAgent.create.failed{code:'FRESH_AGENT_CREATE_FAILED', message:<frozen>, retryable:false}`; `freshAgent.attach` carrying `resumeSessionId` then `error{code:'FRESH_AGENT_CREATE_FAILED', message:<frozen>}` (matching the existing attach error shape, per binding correction D); no `manager.create`/`manager.attach` call.

**Cross-server contract asymmetry (coordinator ruling A, V2-verified):** Node attach rejection is socket-loud but UI-invisible — no client consumer exists for a requestId-less `error` frame (V2's exhaustive sweep of `src/` onMessage/handlers: `ws-client.ts:349-351` only clears tracked creates when `requestId` is a string; `fresh-agent-ws.ts:109-188` switch covers `freshAgent.created/create.failed/session.materialized/killed/event`, `'error'` falls to `default: return false`; `rg "FRESH_AGENT_CREATE_FAILED" src/ shared/` = zero hits). Rust's attach rejection rides `freshAgent.event{freshAgent.error}` which the client DOES handle (`fresh-agent-ws.ts:343-353` → `sessionError` → `freshAgentSlice.ts:441-462` → rendered at `FreshAgentView.tsx:2103-2105`). This asymmetry is ACCEPTED: kata §1c names the code family (`FRESH_AGENT_CREATE_FAILED`), not the frame type; the frozen client's senders never carry the field (`FreshAgentView.tsx:335-341` promotes via `effectiveSessionRef`), so the Node attach rejection only fires for stray external scripts. Task 13's verification checklist item 7 covers the Rust (UI-visible) path; the Node path is socket-loud-only by design.

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/server/ws-handler-fresh-agent.test.ts` (model on the existing `connectAndAuth` + `seenMessages` + `vi.waitFor` pattern at `:87+` — that file has NO `waitForMessage` helper; use the file's own `seenMessages` array + `vi.waitFor` pattern).

Presence coverage (finding 9): BOTH tests below wrap their send in a `for (const legacy of ['legacy-durable-id', ''])` loop (unique requestId/sessionId per iteration) — an empty string carries MUST also reject with the frozen text (`!== undefined` presence):

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

First, add `FRESH_AGENT_CREATE_FAILED` to the `ErrorCode` enum in `shared/ws-protocol.ts:20-37` (V2 finding: without this, `sendError({code:'FRESH_AGENT_CREATE_FAILED',...})` fails `npm run typecheck` because `sendError`'s `code` param is typed `z.infer<typeof ErrorCode>`):

```ts
export const ErrorCode = z.enum([
  // ... existing codes ...
  'FRESH_AGENT_CREATE_FAILED',
  // ... rest ...
])
```

Use the enum's existing alphabetical or logical ordering convention (inspect the current list at `:20-37` and insert in the appropriate position). The string value `'FRESH_AGENT_CREATE_FAILED'` matches the code family kata §1c names and the code Rust uses in its `FreshAgentCreateFailed` envelope.

Extend the Task-9 raw pre-parse guard in `server/ws-handler.ts` with the freshAgent arms (R3.1 — the head-of-case layer can't see null/42 carries, and review round 3 finding 1 requires the family envelope on every value type). Replace the Task-9 guard's comment tail with:

```ts
        switch (rawMsg.type) {
          case 'terminal.create': {
            // ... unchanged Task-9 arm ...
          }
          // Task 10: freshAgent families. Create rides the provider's
          // create-failed envelope (requestId from the raw frame); attach has
          // NO requestId — its rejection rides the attach error frame shape
          // (sendError) with the FRESH_AGENT_CREATE_FAILED family code (kata
          // §1c names the code family; binding correction D/ruling A
          // documents the socket-loud/UI-invisible asymmetry).
          case 'freshAgent.create': {
            this.send(ws, {
              type: 'freshAgent.create.failed',
              requestId: typeof rawMsg.requestId === 'string' ? rawMsg.requestId : '',
              code: 'FRESH_AGENT_CREATE_FAILED',
              message: INVALID_RAW_CODEX_RESUME_MESSAGE,
              retryable: false,
            })
            return
          }
          case 'freshAgent.attach': {
            this.sendError(ws, {
              code: 'FRESH_AGENT_CREATE_FAILED',
              message: INVALID_RAW_CODEX_RESUME_MESSAGE,
            })
            return
          }
        }
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
- Modify: `server/ws-handler.ts:802-813` (dynamic codingcli schema — add `sessionRef`), `:808` (section 3c doc comment), `:1913` (the Task-9 raw pre-parse guard — extend with the codingcli.create arm; the reject is config-independent, coordinator ruling J), `:3318-3326` (promote sessionRef into spawn-time resume id)
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
  // Finding 9 (presence on this door too): it.each over string + empty-string.
  // Finding 10a + review round 3 finding 5: no spawn on reject, with createMock
  // DECLARED here and the same mid-test wsHandler swap the promote test uses
  // (the suite's default is a real manager — never instantiate it, V4).
  it.each([['string', 'legacy-cli-id'], ['empty-string', '']])(
    'rejects codingcli.create resumeSessionId (%s) with INVALID_MESSAGE + frozen text and no spawn', async (_label, legacy) => {
      const createMock = vi.fn()
      class FakeSession extends EventEmitter {
        id = 'cli-session-reject'
        provider = { name: 'claude' }
      }
      const fakeManager = {
        create: (...args: any[]) => { createMock(...args); return new FakeSession() },
        hasProvider: (name: string) => name === 'claude',
        get: vi.fn(),
        remove: vi.fn(),
      } as unknown as CodingCliSessionManager
      wsHandler.close()
      wsHandler = new WsHandler(server, registry, { codingCliManager: fakeManager })

      const ws = await createAuthenticatedWs()
      const requestId = `cli-legacy-reject-${_label}`
      const errorPromise = new Promise<any>((resolve) => {
        ws.on('message', (data) => {
          const msg = JSON.parse(data.toString())
          if (msg.type === 'error' && msg.requestId === requestId) resolve(msg)
        })
      })
      ws.send(JSON.stringify({
        type: 'codingcli.create', requestId, provider: 'claude', prompt: 'hi',
        resumeSessionId: legacy,
      }))
      const error = await errorPromise
      expect(error).toMatchObject({
        type: 'error', code: 'INVALID_MESSAGE',
        message: 'Restore requires sessionRef; resumeSessionId is a legacy field and cannot be used as restore identity.',
        requestId,
      })
      expect(createMock).not.toHaveBeenCalled() // no spawn on reject
      ws.close()
    },
  )

  it('promotes a provider-matched sessionRef into the spawn-time resume id for codingcli.create', async () => {
    // V4: NEVER instantiate a real CodingCliSessionManager + real claudeProvider —
    // the real provider's getCommand()/getStreamArgs() would spawn a real `claude`
    // child process via child_process.spawn (only node-pty is mocked in this file,
    // NOT child_process). Use the file's established fake-manager pattern (:247-258):
    // a plain-object fake whose `create` is a vi.fn spy returning a FakeSession
    // EventEmitter. The promoted id is observable at the manager boundary as
    // `options.resumeSessionId` (session-manager.ts:283 forwards options verbatim
    // into new CodingCliSession; no rename/transform between manager.create and argv).
    const createMock = vi.fn()
    class FakeSession extends EventEmitter {
      id = 'cli-session-1'
      provider = { name: 'claude' }
    }
    const fakeManager = {
      create: (...args: any[]) => { createMock(...args); return new FakeSession() },
      hasProvider: (name: string) => name === 'claude',
      get: vi.fn(),
      remove: vi.fn(),
    } as unknown as CodingCliSessionManager

    // Mid-test WsHandler swap is VALID (V4 leg i): wsHandler.close() removes the
    // upgrade listener from the shared http.Server (ws 8.19.0 WSS.close() calls
    // _removeListeners), so the new WsHandler is the ONLY upgrade handler — no
    // double-processing. This is the file's established pattern (:257-258).
    wsHandler.close()
    wsHandler = new WsHandler(server, registry, { codingCliManager: fakeManager })
    vi.mocked(configStore.snapshot).mockResolvedValueOnce({
      settings: { codingCli: { enabledProviders: ['claude'], providers: {} } },
    } as any)

    const ws = await createAuthenticatedWs()
    const requestId = 'cli-sref-promote-1'
    const createdPromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'codingcli.created') resolve()
      })
    })
    ws.send(JSON.stringify({
      type: 'codingcli.create', requestId, provider: 'claude', prompt: 'hi',
      sessionRef: { provider: 'claude', sessionId: 'canonical-cli-session' },
    }))
    await createdPromise
    // V4: the assertion is the fake-manager create spy — the promoted id is
    // options.resumeSessionId at the manager boundary. Mirrors :295-303.
    expect(createMock).toHaveBeenCalledWith('claude', expect.objectContaining({
      resumeSessionId: 'canonical-cli-session',
    }))
    ws.close()
  })

  it('does NOT promote a provider-mismatched sessionRef into the spawn-time resume id', async () => {
    // Review round 2 finding 10b: a sessionRef whose provider ≠ m.provider is
    // NOT promoted — the spawn proceeds without a resume id. Same fake-manager
    // wsHandler swap as the promote test above.
    const createMock = vi.fn()
    class FakeSession extends EventEmitter {
      id = 'cli-session-2'
      provider = { name: 'claude' }
    }
    const fakeManager = {
      create: (...args: any[]) => { createMock(...args); return new FakeSession() },
      hasProvider: (name: string) => name === 'claude',
      get: vi.fn(),
      remove: vi.fn(),
    } as unknown as CodingCliSessionManager
    wsHandler.close()
    wsHandler = new WsHandler(server, registry, { codingCliManager: fakeManager })

    const ws = await createAuthenticatedWs()
    const requestId = 'cli-sref-mismatch-1'
    const createdPromise = new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'codingcli.created') resolve()
      })
    })
    ws.send(JSON.stringify({
      type: 'codingcli.create', requestId, provider: 'claude', prompt: 'hi',
      sessionRef: { provider: 'codex', sessionId: 'wrong-provider-session' },
    }))
    await createdPromise
    expect(createMock).toHaveBeenCalledTimes(1)
    const spawnOptions = createMock.mock.calls[0][1]
    expect(spawnOptions.resumeSessionId).toBeUndefined()
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

Extend the Task-9 raw pre-parse guard in `server/ws-handler.ts` with the codingcli.create arm (R3.1 + coordinator ruling J: the reject is config-independent — it fires before the manager-missing check exists at the raw layer, so `{no manager} + {resumeSessionId}` answers INVALID_MESSAGE + frozen text, not INTERNAL_ERROR):

```ts
          case 'codingcli.create': {
            this.sendError(ws, {
              code: 'INVALID_MESSAGE',
              message: INVALID_RAW_CODEX_RESUME_MESSAGE,
              requestId: typeof rawMsg.requestId === 'string' ? rawMsg.requestId : undefined,
            })
            return
          }
```

The codingcli.create handler case keeps only the PROMOTION (legacy rejection now lives in the raw guard) — at `server/ws-handler.ts:3280` the head of `case 'codingcli.create':` becomes:

```ts
      case 'codingcli.create': {
        if (!this.codingCliManager) {
          this.sendError(ws, {
            code: 'INTERNAL_ERROR',
            message: 'Coding CLI sessions not enabled',
            requestId: m.requestId,
          })
          return
        }

        const endCodingTimer = startPerfTimer(
          'codingcli_create',
          { connectionId: ws.connectionId, provider: m.provider },
          { minDurationMs: perfConfig.slowTerminalCreateMs, level: 'warn' },
        )
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

Add to `test/unit/client/lib/pane-reconcile.test.ts` (per V4: drive through the EXPORTED `buildReconcileRequest(asRootState(panes))` pattern used at `:116` — NOT `collectTerminalPaneTargets` (signature-mismatched: it takes `(layouts, terminalIds)`, a terminalId-membership filter, NOT `(state, tabId)`, and returns `[]` for a legacy-only pane with no `terminalId`) and NOT `buildRequestFromPanes` (private, not exported). Assert on `req.panes[0]`. The file already imports `buildReconcileRequest` at `:29` and `asRootState`/`emptyPanesState`/`addTerminalPane` are file-local helpers):

```ts
  it('promotes a legacy-only terminal pane resumeSessionId into a canonical sessionRef on the reconcile claim', () => {
    let state = emptyPanesState()
    state = addTerminalPane(state, 'tab_1', 'pane_1', {
      mode: 'claude', createRequestId: 'req-1',
      resumeSessionId: 'legacy-claude-session-id',
    } as Partial<TerminalPaneContent>)

    const req = buildReconcileRequest(asRootState(state))
    expect(req).not.toBeNull()
    const pane = req!.panes[0]
    expect(pane.sessionRef).toEqual({ provider: 'claude', sessionId: 'legacy-claude-session-id' })
    expect(pane.resumeSessionId).toBeUndefined()
  })
```

Add to `test/unit/client/lib/pane-reconcile.fresh-agent.test.ts` (per V4: drive through `buildReconcileRequest(asRootState(panes), { includeFreshAgent: true })` used at `:143` — NOT `collectFreshAgentPaneTargets` (does not exist) and NOT `buildRequestFromPanes` (private). The file already imports `buildReconcileRequest` at `:32` and `asRootState`/`emptyPanesState`/`addFreshAgentPane` are file-local helpers):

```ts
  it('promotes a legacy-only fresh-agent pane resumeSessionId into a canonical sessionRef on the reconcile claim', () => {
    let state = emptyPanesState()
    state = addFreshAgentPane(state, 'tab_1', 'pane_1', {
      provider: 'claude', createRequestId: 'req-fa-1',
      resumeSessionId: 'legacy-fa-session-id',
    } as Partial<FreshAgentPaneContent>)

    const req = buildReconcileRequest(asRootState(state), { includeFreshAgent: true })
    expect(req).not.toBeNull()
    const pane = req!.panes.find((p) => p.kind === 'fresh-agent')
    expect(pane).toBeDefined()
    expect(pane!.sessionRef).toEqual({ provider: 'claude', sessionId: 'legacy-fa-session-id' })
    expect(pane!.resumeSessionId).toBeUndefined()
  })
```

And in `test/unit/client/lib/pane-reconcile.test.ts` add the shell boundary case (review round 3, finding 6 — mirrors the server's exclusion):

```ts
  it('never promotes a shell-mode legacy resumeSessionId (a stateless shell has no durable identity)', () => {
    let state = emptyPanesState()
    state = addTerminalPane(state, 'tab_1', 'pane_1', {
      mode: 'shell', createRequestId: 'req-sh-1',
      resumeSessionId: 'legacy-shell-id',
    } as Partial<TerminalPaneContent>)

    const req = buildReconcileRequest(asRootState(state))
    expect(req).not.toBeNull()
    const pane = req!.panes.find((p) => p.createRequestId === 'req-sh-1')
    expect(pane).toBeDefined()
    expect(pane!.sessionRef).toBeUndefined()
    expect(pane!.resumeSessionId).toBeUndefined()
  })
```
(Verify the file's terminal-pane fixture helper name before pasting — the existing first test uses the same shape; if it's not `addTerminalPane`, use the file's actual helper.)

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
  // Mirror the server's promoted_legacy_claim exclusion
  // (crates/freshell-ws/src/reconcile.rs:~165-177): shell/empty modes NEVER
  // promote — a stateless shell has no durable identity (review round 3,
  // finding 6 — the client must match or a stale shell pane becomes a
  // structured sessionRef{provider:'shell'} and bypasses the server's
  // fresh-verdict rule).
  if (resumeSessionId && mode !== 'shell' && mode !== '') return { provider: mode, sessionId: resumeSessionId }
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

Every client test that exercises `pane-reconcile` or `buildReconcileRequest` is impacted. The existing tests in `pane-reconcile.test.ts`/`pane-reconcile.fresh-agent.test.ts` that send `sessionRef` directly (not legacy) are unaffected (the helper passes `sessionRef` through when present). The `FreshAgentView.reconcile.test.tsx:406` pin already asserts the promotion pattern on the create/attach path — it is unaffected (different module).

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
4. Retained-for-rejection schema/struct fields (each carrying the section 3c comment): `shared/ws-protocol.ts` (`TerminalCreateSchema` at `:319-332`, `CodingCliCreateSchema`, `FreshAgentCreateSchema`, `FreshAgentAttachSchema`, `ReconcilePaneSchema`), `server/ws-handler.ts` (dynamic terminal.create + codingcli schemas), `crates/freshell-protocol/src/client_messages.rs` (`TerminalCreate`, `CodingCliCreate`, `FreshAgentCreate`, `FreshAgentAttach`, `ReconcilePane`).
5. Rejection handlers: `crates/freshell-freshagent/src/lib.rs` (create_tab door-top presence check), `crates/freshell-freshagent/src/pane_ops.rs` (split/respawn door-top presence checks), `crates/freshell-ws/src/terminal.rs` (raw-Value pre-parse legacy-resume guard, all four create-class families), `server/ws-handler.ts` (terminal.create/freshAgent.create/freshAgent.attach/codingcli.create head-of-case rejects), `server/agent-api/router.ts` (door-top presence checks on all three routes).
6. Sidecar-protocol file class (V5 ruling — NOT Freshell-wire input, EXCLUDE from rejection scope): `crates/freshell-claude-sidecar/index.mjs:10,:240` (reader), `claude.rs:469`/`:1294` + Node `sdk-bridge.ts:85,:168,:193` (writers), embedded fake sidecars in `test/e2e-browser/fixtures/` and in-crate `tests/*.rs` fake-sidecar JS, and the ~8 sidecar-log-reading specs (`freshagent-settings-resume-rust.spec.ts:545,:551`, `hidden-pane-rebind-rust.spec.ts:365-367`, `freshclaude-restart-parity-rust.spec.ts:309`, `freshclaude-identity-persistence-rust.spec.ts:313,:410`, `wavea-interactions-rust.spec.ts:403-407`, `restore-contract-wall-rust.spec.ts:1040,:1304`, `restore-matrix.spec.ts:400,:1099`). None are Freshell-wire input — the adapter still emits `resumeSessionId` on the internal sidecar protocol post-conversion, and these readers stay green because the ID VALUE is preserved. Production internal-name readers (`codex.rs:500`, `claude.rs:348/:1809`, `layout_store_content.rs:254`, `tabs_store_model.rs:484`, `pane_ops.rs:686`) are also in this category.

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

Run the Vitest e2e (V1 corrected — `test/e2e/agent-cli-flow.test.ts` is a Vitest file under the DEFAULT config, NOT the server config; it must run with no `--config` flag so the coordinator auto-routes it to `config/vitest/vitest.config.ts`):

```bash
FRESHELL_VITEST_BACKEND=local npm run test:vitest -- run test/e2e/agent-cli-flow.test.ts
```

Expected: PASS (CLI `--resume` promotes to sessionRef and still works; the new WS assertion gets INVALID_MESSAGE + frozen text).

Run the Playwright e2e (MCP e2e `mcp-qa-smoke-rust`; PLUS the repurposed `remote-tab-linkage-rust` spec on the rust-chromium project — V6: this spec was repurposed in Task 5 and NO plan gate re-ran it until now):

```bash
npm run test:e2e:local -- --grep "mcp-qa-smoke-rust|remote-tab-linkage-rust" --project rust-chromium
```

Expected: PASS (MCP `resume` alias still works; the repurposed `remote-tab-linkage-rust` spec asserts REST 400 + frozen text + no spawn). NOTE: `--project rust-chromium` is required because the spec is `rust-chromium`-registered and was added to `RUST_ONLY_SPECS` in Task 5 (so the default `chromium` project no longer picks it up — the pre-existing `:111` base failure on the chromium leg is also fixed by that addition).

Run a standalone typecheck to catch any drift from the `ErrorCode` enum addition (Task 10 / coordinator ruling A):

```bash
npm run typecheck
```

Expected: PASS (the `FRESH_AGENT_CREATE_FAILED` addition to `ErrorCode` typechecks on both server and client; `sendError({code:'FRESH_AGENT_CREATE_FAILED',...})` in Task 10 resolves against the extended enum).

- [ ] **Step 5: Refactor while green**

No refactor — verification-only.

- [ ] **Step 6: Run impacted-test verification**

The full coordinated suite IS the impacted set (this is the final gate).

Run: `npm run check && cargo test --workspace`

Expected: PASS.

- [ ] **Step 7: Commit the task, then squash behavior commits (R3 finding 2)**

If Step 2 found sweep violations that required fixes, commit those fixes first. Otherwise the verification task itself produces no code change.

Then — the kata/User-Request contract requires BOTH servers' rejections (+ the reconcile client promotion, codingcli promotion, and rejection tests) to LAND TOGETHER, not as a sequence of partially-rejecting main-history commits. Task-sequenced commits 5–12 are correct locally for review/TDD, but before the PR opens, squash them into ONE behavior commit. Do it with a soft reset (the branch is unpushed during execution):

```bash
# The behavior base is the Task-5 commit. Take its SHA from the progress
# ledger entry recorded at Task 5 completion ("Task 5: complete — impl
# <task5-sha> ...") — do NOT grep commit subjects for it. Tasks 1-4 are
# contract-neutral prep and stay separate.
TASK5_SHA=<task5-sha-from-ledger>
# Verify BEFORE resetting: this range must list exactly the behavior-task
# commits (Tasks 5-12) — the oldest entry carries Task 5's subject ("feat(ejh6):
# Rust REST door-top presence reject ...") and no prep-task commit appears:
git log --format='%H %s' "${TASK5_SHA}^..HEAD"
git reset --soft "${TASK5_SHA}^"
git commit -m "feat(ejh6): reject the legacy resumeSessionId wire field on every create-class door (both servers)"
git rebase origin/main # keep current-base lineage clean; plan docs/commits 1-4 are already behind
```

(Harness note: the Task-5 commit SHA captured in the progress ledger at Task 5 completion is the single source of truth; use it directly rather than re-deriving the base from commit subjects — subject patterns drift and a pattern that matches nothing yields an empty base and a `git reset --soft "^"` abort. If the squash reveals a mixed file staged from a prep task, unstage and recommit it separately — the verification gate already ran before this step.)

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
5. CLI `--resume` and MCP `resume` still work end-to-end (they convert; nothing user-facing changes) — covered by existing `agent-cli-flow.test.ts:493-560` (positive `--resume` to sessionRef, run under the default vitest config per V1) and `freshell-tool.test.ts` alias tests, both unchanged.
6. Reload/restore of existing tabs (including pre-existing persisted state that may carry legacy pane-content fields) still resumes correctly — covered by the permanent `pane.reconcile` compat door (Task 6 reconcile doc + Task 12 client promotion), with existing `reconcile.rs` cfg(test) fns `:1021`/`:1053`/`:1083` and `pane_reconcile.rs:125` staying green.
7. `freshAgent.attach` with the field then the create-failed family envelope + frozen text — Rust rides `freshAgent.event{freshAgent.error{code:'FRESH_AGENT_CREATE_FAILED'}}` (UI-visible, covered by Task 7 `freshagent_attach_with_legacy_resume_session_id_is_rejected`); Node rides `error{code:'FRESH_AGENT_CREATE_FAILED'}` (socket-loud but UI-invisible by design — coordinator ruling A/V2; covered by Task 10 `rejects freshAgent.attach carrying resumeSessionId`). The asymmetry is accepted: kata §1c names the code family, not the frame type; the frozen client's senders never carry the field.
8. `rg 'resumeSessionId' server/ src/ shared/ crates/ --glob '!*test*'` shows only allowed categories — verified in Step 2 (sidecar-protocol file class excluded per V5 ruling).
