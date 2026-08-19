# Dynamic provider-advertised slash-command catalogs in fresh-agent panes

> **For agentic workers:** REQUIRED: Use the usual-subagents (subagent-driven-development / executing-plans) and the-usual TDD (test-driven-development) subskills to implement this plan task-by-task and subtask-by-subtask. Steps use checkbox (`- [ ]`) syntax for tracking.

**User Request:**

> Port the fork's dynamic slash-command advertising to main's fresh-agent panes, with the general-then-provider layering the user directed:
> 1. **Generic fresh-agent layer:** the composer merges the existing static action commands (`new`/`compact`/`fork`/`model` — UI-level orchestration actions, byte-identical behavior) with provider-advertised **session commands** (chosen → composed as `/name ` text, sent verbatim as user text); a generic per-session server-fed slot that is absent/empty for providers with nothing to advertise.
> 2. **freshclaude/kilroy specifics:** probe the installed Claude Agent SDK 0.3.235's advertised commands (init payload + `supportedCommands()`), keep current via the SDK's `commands_changed` push.
> 3. **freshopencode:** wire a second provider IFF the serve API's command surface proves out (E4: `GET /command` exists with `{name, description?, source, template, hints}`; invocation semantics gated in Stage 2).
> 4. **freshcodex:** no-op (empty slot).
> 5. Static action-command behavior, menu ARIA conventions (menu/combobox semantics only while open), and the typed-Enter fall-through (`/unknown` sent verbatim) all preserved.
> The user approved running "the slash command thing ... generally in fresh agent and then the specifics in fresh cl[au]de" through the-usual.

## 1. Context lineage

- Prior completed work: the fork inventory (5 features triaged; slash commands = fork changes.md item 15, built on the deleted legacy agent-chat composer — intent re-derived here, code not ported); PR #664 (SDK 0.3.235) landed and is this run's enabler (`supportedCommands()` + init `commands` + `commands_changed` all present).
- Workspace stage: worktree `.worktrees/slash-command-catalogs`, branch `the-usual/slash-command-catalogs`, base_ref `9a6b8fc39` (origin/main = PR #664 merge), `npm ci` exit 0; base gate ADOPTED (final-gate exit 0 at bf8322897; diff to base = 2 docs lines).
- Stage 1 exploration (all reports in logs dir `reports/`): **E1-client** (composer/View seams, verified anchors), **E2-server** (slot verdict: snapshot field wins decisively; hook points; Rust-port caveat), **E3-sdk** (SlashCommand 4 fields verbatim from installed sdk.d.ts; commands_changed REPLACE semantics; init-vs-probe recommendation), **E4-opencode** (`GET /command` EXISTS, 44 live entries incl. user custom commands; invocation semantics UNPROVEN → Stage-2 gate).

## 2. Goal

A fresh-agent pane's `/` menu shows two groups — **Pane actions** (today's statics, identical behavior) and **Agent session** (provider-advertised commands) — where the session group is populated from the provider's live catalog, stays current as the session evolves, works for freshclaude+kilroy from one implementation, extends to freshopencode if its serve surface proves out, and costs freshcodex nothing. Selecting a session command composes `/name ` text (never auto-sends); submitting typed `/cmd args` sends it verbatim.

## 3. Architecture

**Data flow (slot = snapshot field — E2's verdict):** adapters normalize a per-session command catalog into the thread snapshot (`FreshAgentSnapshotSchema`, strict at `shared/fresh-agent-contract.ts:230-246`; new OPTIONAL `commands` field → graceful absence incl. the Rust port which keeps vendored SDK 0.2.x). Clients fetch snapshots on `freshAgent.session.changed` (existing invalidation edge, `FreshAgentView.tsx:78-89`), so refresh = mark + broadcast; no new WS message types, no new redux state, no REST TTL machine (pull-per-open with per-session keys was rejected by E2 as misfit).

**Kind split (the one discrimination the layer must model):** `FreshAgentSlashCommand` gains an explicit `kind`: statics are `kind:'action'` (name/description/aliases/requiresCapability/action, unchanged dispatch), catalog rows are `kind:'session'` (+`argumentHint`). Name collisions across kinds are allowed (e.g. SDK `/compact` vs static `compact`): typed-Enter dispatch consults **actions only** (statics-first semantics preserved); menu shows both groups.

**Claude specifics:** `sdk-bridge.createSession` retains the query handle (L189-225); after create, fire-and-forget `supportedCommands()` (cached after init — zero extra round-trips, E3) → store normalized full-objects in per-session bridge state. Also capture the init message's `slash_commands` name-list in the `system/init` arm (L369-385) as the placeholder until the probe lands. `system/commands_changed` gets its own arm (currently falls through to the benign default arm at L503-504): REPLACE the stored list + broadcast `freshAgent.session.changed` → clients refetch → next snapshot carries the new list. `normalizeClaudeThreadSnapshot` (`server/fresh-agent/adapters/claude/normalize.ts:206-256`) maps state.commands → snapshot.commands. Kilroy shares the adapter instance (registered twice, `server/index.ts:383-392`) — one implementation covers both. Detached/durable snapshots have no live session → no commands (acceptable).

**Opencode specifics (gated):** E4 verified `GET /command?directory=<cwd>` on serve 1.18.18 (44 rows; nulls present in optional fields — schema must tolerate user-JSON nulls; refresh caveat: project commands scanned at sidecar start). Stage-2 must prove invocation semantics: whether sending `/cmd args` as prompt text expands commands server-side, or whether the client must expand `template` with `$ARGUMENTS`. Wire-in point: `model-catalog.ts:166-194` `fetchWithTimeout` pattern, refreshed at session create/attach. If the probe fails → empty slot, decision recorded, kata filed (not a run failure).

**Client composition:** `FreshAgentView` merges `getFreshAgentSlashCommands(sessionType)` with `snapshot.commands` via a new pure shared helper and passes one grouped list into the composer. Composer renders two labelled groups inside the existing single `role="menu"` (group headers non-interactive; existing test query conventions preserved). Selection: `kind:'action'` → existing `executeCommand` path; `kind:'session'` → `setText('/name ')` + focus, never send. `executeSlashText` (L337-346) matches only `kind:'action'` entries so typed `/clear args` falls through to the existing verbatim send (L403-404).

**A11y:** keep main's existing menu pattern (conditionally-rendered menu only while open); group headers as plain labelled, non-focusable dividers; composer textarea gains no permanent combobox attrs.

## 4. Tech stack

Existing only: React 18 + Redux Toolkit + Vitest (client/server configs) + Playwright; claude SDK 0.3.235 (installed); opencode serve 1.18.18 (discovery arm only). No new dependencies.

## 5. Global constraints

- **Worktree only**; `main` and production untouched; no PR without explicit user approval; scratch servers on recorded ports only (opencode probes used 4199 rules from E4).
- **TDD** with RED-witness pastes; mechanical steps record why no RED. Tests = behavior contracts; mocks through real schema boundaries (snapshot schema is Zod-strict; publisher fixtures must parse).
- **Contract traceability:** any new shared schema/type names for the fresh-agent contract must be registered in `test/fixtures/fresh-agent/contract-traceability.js` (E2-verified requirement) — traceability tests otherwise fail.
- **Byte-identical elsewhere:** static action behavior, freshcodex paths, opencode paths outside the gated arm, and the composer action dispatch must not move.
- **Server test commands always carry explicit `--config config/vitest/vitest.server.config.ts`** (coordinator bare-`run` filter bug, known). Client/default-config suites use plain `run`.
- **Fork = design witness only** (`/tmp/opencode/fork-analysis/freshell`, changes.md item 15): its composer/menu/ARIA choices inform semantics (insert-never-send; combobox-only-while-open); all diffs re-derived against this tree.

## 6. File responsibility map

| File | Change |
|---|---|
| `shared/fresh-agent-slash-commands.ts` | `kind:'action'` on statics; `FreshAgentSessionCommand`-typed catalog merge helper `buildFreshAgentSlashCommandMenu(statics, catalog)` → `{ action: [...], session: [...] }` (dedupe within kinds by name; cross-kind collisions allowed) |
| `shared/fresh-agent-contract.ts` | `FreshAgentSessionCommandSchema` (name/description/argumentHint?/aliases?) + optional `commands` on `FreshAgentSnapshotSchema` |
| `test/fixtures/fresh-agent/contract-traceability.js` | register new schema/type names |
| `src/store` (view selectors) | pass `snapshot.commands` through to the view (read-only; verify existing slice exposure first) |
| `src/components/fresh-agent/FreshAgentView.tsx` | compute grouped list via helper; pass to composer |
| `src/components/fresh-agent/FreshAgentComposer.tsx` | grouped rendering; session-kind select → insert `/name `; executeSlashText action-only |
| `server/sdk-bridge.ts` | per-session `commands` state; init-arm name capture; post-create `supportedCommands()` probe; `commands_changed` arm → REPLACE + `freshAgent.session.changed` broadcast |
| `server/fresh-agent/adapters/claude/normalize.ts` | snapshot.commands mapping |
| `server/fresh-agent/adapters/opencode/` (gated) | commands fetch at create/attach via serve client; template-expansion decision per Stage-2 probe |
| Tests | per-task lists in §7 |
| Rollback | §8 |

## 7. Tasks

### Task 1: Shared catalog types + snapshot schema + merge helper (TDD)

**Files:** `shared/fresh-agent-slash-commands.ts`, `shared/fresh-agent-contract.ts`, `test/fixtures/fresh-agent/contract-traceability.js`, `test/unit/shared/fresh-agent-slash-commands.test.ts`, `test/unit/shared/fresh-agent-contract.test.ts` (+ traceability test if it enumerates names)

- [ ] **Step 1 (RED):** tests for `buildFreshAgentSlashCommandMenu`: statics arrive unchanged in `action` group; catalog rows normalized (trim name of leading `/`; drop empties; dedupe by name within session group) into `session` group; cross-kind same-name coexistence; null/undefined/empty catalog → session group empty; malformed catalog rows dropped (never throw).
- [ ] **Step 2 (GREEN):** implement types + helper. `FreshAgentSessionCommandSchema = { name: string(min1), description: string, argumentHint?: string, aliases?: string[] }`; `FreshAgentSnapshotSchema` gains `commands: z.array(FreshAgentSessionCommandSchema).optional()`. Verify traceability registration requirement exact (register names so `fresh-agent-contract-traceability.test.ts` passes).
- [ ] **Step 3 (REFACTOR + verify):** `npm run test:vitest -- run test/unit/shared/` (default config) → all green incl. existing slash-command tests (name-list regression witness).
- [ ] **Step 4:** Commit: `feat(fresh-agent): shared session-command catalog schema + grouped menu merge helper`.

### Task 2: Composer + View wiring (TDD)

**Files:** `src/components/fresh-agent/FreshAgentComposer.tsx`, `src/components/fresh-agent/FreshAgentView.tsx`, `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`

- [ ] **Step 1 (RED):** composer tests (existing api-mock conventions): (a) menu shows labelled action + session groups when catalog rows present; (b) selecting a session command sets textbox value `/name ` and does NOT call onSend or any action dispatch; (c) selecting an action behaves exactly as today (regression witness); (d) typed `/clear x` + Enter with session command listed sends verbatim via onSend (no action dispatch); (e) typed `/compact` still dispatches the static action (statics-first); (f) ARIA: no combobox/menu semantics leak when menu closed (existing pins keep passing); (g) capability gating (/fork hidden without flag) unchanged with catalog present.
- [ ] **Step 2 (GREEN):** implement: View computes grouped list from `getFreshAgentSlashCommands(sessionType)` + `snapshot?.commands` (read the existing snapshot flow at view L674-680 — commands arrive there) and passes grouped structure (or flat list + helper grouping in composer — pick the composition that keeps composer props narrowest); composer renders groups; session selection inserts `/name ` + focuses; executeSlashText filters to `kind==='action'`.
- [ ] **Step 3 (REFACTOR + verify):** focused runs for both component files + `npm run test:vitest -- run test/unit/client/components/fresh-agent/`; `npm run typecheck`.
- [ ] **Step 4 (e2e):** `npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent.spec.ts` (menu-adjacent coverage) → PASS.
- [ ] **Step 5:** Commit: `feat(fresh-agent): grouped slash menu — provider session commands compose text, actions unchanged`.

### Task 3: Claude catalog — probe + live updates + snapshot surface (TDD)

**Files:** `server/sdk-bridge.ts`, `server/fresh-agent/adapters/claude/normalize.ts`, `server/fresh-agent/adapters/claude/adapter.ts` (if the probe belongs at adapter level), tests: `test/unit/server/sdk-bridge.test.ts`, `test/unit/server/fresh-agent/claude-adapter.test.ts`, `test/unit/server/fresh-agent/claude-normalize.test.ts` (verify exact names), parity/contract suites.

- [ ] **Step 1 (RED, bridge):** tests: createSession with mock SDK exposing `supportedCommands()` → stored normalized catalog (name/desc/argumentHint/aliases); `system/commands_changed` arm → REPLACE + one `freshAgent.session.changed` broadcast; init-arm captures `slash_commands` names as placeholder ordering (probe overwrites). RED-witness via temporarily-wrong assertion, paste.
- [ ] **Step 2 (GREEN):** implement in `handleSdkMessage` arms + post-create fire-and-forget probe (catch → keep placeholder, debug-log; never reject the session create).
- [ ] **Step 3 (adapter normalize):** `normalizeClaudeThreadSnapshot` maps bridge state.commands → snapshot.commands (omit when absent — field is optional); kilroy inherits (verify same adapter registration). Tests incl. snapshot-schema round-trip.
- [ ] **Step 4 (verify):** `npm run test:vitest -- run test/unit/server/sdk-bridge.test.ts test/unit/server/fresh-agent/ --config config/vitest/vitest.server.config.ts` then `npm run test:vitest -- run test/unit/server/ --config config/vitest/vitest.server.config.ts`.
- [ ] **Step 5 (live smoke):** scratch server on a recorded port (3494): create freshclaude pane via REST, assert snapshot REST contains non-empty `commands` (curl + jq), send `/clear`? NO — do not mutate session state needlessly: assertion stops at presence+shape. Teardown by PID; `.env` copy removed after.
- [ ] **Step 6:** Commit: `feat(freshclaude): advertise SDK slash commands on the session snapshot (init capture + probe + commands_changed REPLACE)`.

### Task 4: Opencode arm (GATED on Stage-2 validator result)

- [ ] **Gate outcome `expand-server-side`:** commands listed on snapshot; session select inserts `/name ` verbatim (serve expands). Wire: adapter fetch `GET {baseUrl}/command?directory=<pane cwd>` at create and on attach (mirror `model-catalog.ts` `fetchWithTimeout`), null-tolerant mapping (`description??''`, drop `source`-irrelevant fields), dedupe by name; tests with serve-client mocked at the fetch boundary; client behavior unchanged from Task 2.
- [ ] **Gate outcome `expand-client-side`:** Task 2's session-insert remains `/name `, but the SEND path for freshopencode session commands expands `template` with `$ARGUMENTS` ← args (only in composer execute-at-submit for a matched opencode catalog row with template); server arm identical to above. Record the decision + template snapshots in the report.
- [ ] **Gate outcome `vacuous` (no usable invocation):** ship empty slot; write kata; record in recap. This task becomes docs-only: a short comment in the adapter noting the probe outcome.
- [ ] **Step final:** Commit per outcome: `feat(freshopencode): serve-advertised commands in the slash catalog` or `docs: record opencode command-surface probe outcome`.

### Task 5: Close-out gate

- [ ] `npm run typecheck && npm run lint`; `FRESHELL_TEST_SUMMARY="slash-command-catalogs close-out" npm test` (record holder/status); e2e fresh-agent + restore-matrix specs; update run-state; STOP for delta Fresh Eyes.

## 8. Rollback

Worktree branch; rollback = abandon. Granular: Task 2 revert restores static-only menu; Task 3/4 reverts drop provider rows from snapshots (schema field is optional so old clients parse fine); Task 1 revert removes the helper/schema field (covered by ripple tests).

## Appendix A: deferred questions

- Whether to show opencode `source:"skill"` rows distinctly (E4: 39 of 44 rows are skills) — during Task 4 presentation polish only if cheap; default = one session group regardless of source.
