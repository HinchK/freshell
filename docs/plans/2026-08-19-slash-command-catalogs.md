# Dynamic provider-advertised slash commands in fresh-agent panes — Implementation Plan

> Executed 2026-08-19 against 85b471812c5ccffd68e8e305e22ba75d581e0258; the source tree supersedes all code and patch listings in this document. Only the `## User Request` block, Goal, Architecture, Global Constraints, and task intent remain authoritative.

> **For agentic workers:** REQUIRED: Use the usual-subagents (subagent-driven-development / executing-plans) and the-usual TDD (test-driven-development) subskills to implement this plan task-by-task and subtask-by-subtask. Steps use checkbox (`- [ ]`) syntax for tracking.

**User Request:**

> Context: the fork inventory found a slash-command menu advertising SDK commands in the fork's (now-deleted) legacy agent-chat composer; main's fresh-agent composer has only a static action list.
>
> "Can we implement the slash command thing generally in fresh agent and then the specifics in fresh clod [claude] so that other agents can benefit from the pattern? Or does that not make sense because it is primarily only cloud code that can support it?" — answered: the layering makes sense; run it.
>
> "Yes." (run it through the-usual)

Derived scope (user-ratified in that exchange): (1) generic fresh-agent dynamic slash-command catalog merging static action commands with provider-advertised session commands; generic server-fed slot absent/empty for providers with nothing to advertise; (2) freshclaude/kilroy: probe the installed SDK 0.3.235's advertised commands at session create, keep current as the session evolves; (3) freshopencode: discovery said the surface EXISTS — wire it as the second provider; (4) freshcodex: no-op; (5) provider-advertised commands insert verbatim text (`/name arg text`) when chosen — never auto-send; static action-command behavior byte-identical; composer ARIA combobox-only-while-open convention preserved.

## 1. Context lineage

- Explorer reports (Stage 1, all verified-anchored): `reports/explore-e1-client.md`, `explore-e2-server.md`, `explore-e3-sdk.md`, `explore-e4-opencode.md` in the run logs dir.
- Prior the-usual run (sdk-0-3-upgrade, PR #664 merged at base 9a6b8fc39) landed the 0.3.235 SDK this feature probes — `query().supportedCommands()` and init `commands` exist and are receipt-verified.
- Consolidation note: an abandoned same-branch draft plan from 2026-08-19 00:09 (`1e99cb51c`; earlier crashed session, no live worktree) preceded this plan and was reviewed before this revision; its superior decisions are folded in (grouped menu, cross-kind collision policy, opencode invocation-semantics gate) and are cited below.
- Fork witness (design-only, never cherry-picked): `/tmp/opencode/fork-analysis/freshell`, changes.md item 15; its approach: server probes supportedCommands post-create, REPLACE-broadcasts on `commands_changed`, replays to late subscribers, client inserts `/name ` without auto-sending.

## 2. Goal

Freshclaude/kilroy/freshopencode panes' composer `/` menu shows the provider's live-advertised commands (Claude skills/plugins/builtins, opencode custom/skill/MCP commands) merged with the existing static action commands, inserting verbatim `/name ` text on select (never auto-send), staying current as sessions evolve — with freshcodex and any provider lacking the surface unaffected, and the production Rust server unaffected (graceful absence).

## 3. Architecture (decisive answers from exploration)

- **Slot = the fresh-agent session snapshot.** `FreshAgentSnapshotSchema` (`shared/fresh-agent-contract.ts:230-246`) already feeds composer gating (`capabilities.fork` precedent at `FreshAgentView.tsx:674-680`). Add OPTIONAL field `commands?: readonly FreshAgentSessionCommand[]` — strict-non-optional fails parse; optional = graceful absence for Rust port, codex, offline. `mergeSnapshotForDisplay` next-wins so updates merge cleanly. E2 rejected dedicated WS push (needs redux state + Rust porting + re-push-on-attach) and REST-route pull (wrong granularity for per-session entity, misses mid-session changes).
- **Refresh:** claude: SDK's `commands_changed` system push (REPLACE semantics — sdk.d.ts:3134, union member) → new bridge arm replaces `state.commands` and rebroadcasts the existing `freshAgent.session.changed` edge (already in `SNAPSHOT_INVALIDATING_FRESH_AGENT_EVENTS`, `FreshAgentView.tsx:78-89`) → the client refetches the snapshot. No polling. Opencode: populated once at create (sidecar scans project-layer commands at startup only — documented E4 caveat; config-global/user skills layers are stable at runtime).
- **Claude probe (shaped by VAL-B evidence):** fire `supportedCommands()` fire-and-forget when `SdkBridge.createSession` stores the query handle (`server/sdk-bridge.ts:189-225`) — NEVER awaited on the create path (probe lands in 1.2–1.5s live; an unbounded or even budgeted await in create would hold the create lock). **Publishing window:** the streamed `system/init` frame is LAZY — it arrives with the session's first turn (VAL-B: no init in 30s+ on idle), and the control-path `initializationResult()` carries the rich catalog but NOT `terminal_slash_commands`. Therefore the per-session catalog is published at the JOIN of (init frame landed, probe resolved): init supplies `slash_commands`/`terminal_slash_commands` name-lists; the probe supplies full rows. **Terminal-only subtraction is mandatory** (VAL-B LB-01a: the advertised catalog provably CONTAINS terminal-bound rows — `doctor`, `color` observed; tagging is data-driven, so filtering = drop rows whose name ∈ the session's latest `terminal_slash_commands` list; a denylist by name is forbidden). Fresh window semantics: a brand-new pane shows only Pane-actions until the first turn's init lands — honest and safe. **`commands_changed` arm:** REPLACE the catalog with the push's rows (union-typed per sdk.d.ts:3134), re-applying the session's latest terminal-subtract, then broadcast the existing invalidation edge (`freshAgent.session.changed`-class — reuse the exact broadcast the bridge already emits for snapshot-invalidating events; `.strict()` snapshot keeps late-attach replays lawful). Ordering rule (drop-stale): the fired-at-create probe result applies only if no `commands_changed` has been incorporated yet. Snapshot composition in `normalizeClaudeThreadSnapshot` (`server/fresh-agent/adapters/claude/normalize.ts:206-256`). Kilroy rides free (same adapter registered twice, `server/index.ts:383-392`). Detached/durable snapshots have no liveSession → commands absent (correct: can't send to a dead session).
- **Opencode (VAL-A adjudicated):** catalog from the LIVE shared sidecar's `GET /command?directory=<pane-cwd>` — directory scoping cross-resolves project-layer commands without rescan (VAL-A LB-02 confirmed at 1.18.18; the startup-scan freshness caveat stays as a documented limit). Never scratch-spawn a sidecar for this, never `--pure` (it silently drops config-inline user commands). Schema tolerates explicit nulls (`description/agent/model/subtask` seen null live) and missing optionals; normalize to contract rows with description ?? '', no argumentHint (hints are template-side), `aliases` omitted. **Invocation semantics (VAL-A LB-04): verbatim slash text does NOT execute opencode commands** (falsified: `/val-b-probe MARKER` recorded as raw text); the execution lane is `POST /session/{id}/command {command, arguments}` — synchronous at turn scale (~14s observed), response carries the completed `{info,parts}`. Adapter dispatch rule (client stays unchanged, composer keeps text-insert UX): on send, if submitted text parses as `/name args` where `name` ∈ the session's captured catalog → route to `POST /session/{id}/command` with `arguments` verbatim (case-insensitive name match against the catalog's canonical names; the catalog's own entry wins the casing); otherwise send verbatim as today. Turn lifecycle must be consistent: the POST path returns on turn completion — adapter must apply turn-scale timeouts and derive busy/idle edges exactly like the prompt path (SSE busyness observed unprobed by VAL-A → probe in this task's tests against a mocked sidecar; if live SSE busy signaling diverges, adapter synthesizes busy/idle around the POST).
- **Data model (shared):** `FreshAgentSessionCommand = { name: string; description: string; argumentHint?: string; aliases?: string[] }` — the SDK SlashCommand shape with `argumentHint` made optional (SDK requires it; opencode rows lack it) — i.e. the minimal useful intersect (opencode: description nullable → coerce to `''`; template/hints/agent/model dropped). SDK-side note (plan-review round 1): init's `terminal_slash_commands` is itself optional — absent ⇒ empty subtract list.
- **Menu merge (client):** new helper in `shared/fresh-agent-slash-commands.ts` — `buildFreshAgentSlashCommandMenu(statics, catalog) → { action: readonly FreshAgentSlashCommand[]; session: readonly FreshAgentSessionMenuRow[] }` (grouped shape; each session row carries `kind: 'session'` so dispatch can switch). Rendering: ONE conditionally-rendered `role="menu"` containing two labelled, non-focusable group dividers ("Pane actions" then "Agent session" — midnight-draft design, clearer than name-tag suffixes).
- **Collision policy (adopted from midnight draft, reversing the earlier static-wins dedupe):** cross-kind name collisions are ALLOWED and explicitly displayed per group (e.g. static action `compact` in Pane actions, SDK `compact` in Agent session). Typed-Enter dispatch (`executeSlashText`) consults action-kind rows ONLY (statics-first semantics unchanged); menu select of a session row inserts text. Dedupe applies WITHIN kinds by case-insensitive name. Rationale: with labelled groups the semantics are unambiguous, and hiding the provider's row would misreport the live catalog. Fresh Eyes may revisit.
- **Select behavior:** static rows: unchanged dispatch (`executeCommand` → `runSlashCommand` at `FreshAgentView.tsx:1096-1124`). Session rows: **insert** verbatim `/name ` (canonical name, never the alias) into the composer input — NO auto-send, NO dispatch; user adds args (guided by `argumentHint`) and hits Enter. Existing fallthrough for unmatched `/text` (`FreshAgentComposer.tsx:403-404`) stays as-is (unknown commands still send as text — harmless).
- **ARIA:** menu remains inline conditionally-rendered `role="menu"`/`menuitem` only while open (current pattern at `FreshAgentComposer.tsx:500-561`); no combobox-role changes; DirectoryPicker conditional-combobox precedent NOT taken (menu, not combobox).
- **Rust port (production :3001 sidecar):** untouched (vendored SDK ^0.2.40, no commands surface) — optional field means absence, never an error. Follow-up recorded in recap, chained near kata fpxj.
- **freshcodex:** untouched; statics only.

## 4. Tech stack

Existing only: Zod contracts, Express + ws, Redux Toolkit + React, Vitest, Playwright e2e. No new dependencies.

## 5. Global constraints

- Worktree-only at `/home/dan/code/freshell/.worktrees/slash-command-catalogs` (branch `the-usual/slash-command-catalogs`); never touch main checkout/3001/PRs-without-approval. TDD with real RED witnesses pasted in reports. Tests via repo wrappers with EXPLICIT `--config config/vitest/vitest.server.config.ts` for all server paths (bare `run` passthrough misfires — verified last run); client/shared tests plain `run` fine (default config). Mocks put valid data through real schema boundaries.
- **Contract traceability:** new/renamed schema types must be registered in `test/fixtures/fresh-agent/contract-traceability.ts` (convention per E2).
- **freshcodex + opencode transcript paths untouched**; static action dispatch unchanged; no Rust changes.
- **Scratch sidecars on recorded ports with PID files only, always torn down** (never touch 3001/3002 or the user's live opencode sidecar).
- **Collision policy locked:** within-kind dedupe by case-insensitive name; cross-kind collisions allowed and both groups displayed; typed-Enter consults actions only; session-command inserts use canonical `name` never an alias.
- **Null tolerance locked:** any parse of opencode rows must treat description/agent/model/subtask as possibly-null (E4 observed explicit nulls live).
- Composer menu must not regress: fresh-agent-control e2e + composer unit tests stay green byte-compatible for static lists (a11y lint included).

## 6. File responsibility map

| File | Change |
|---|---|
| `shared/fresh-agent-contract.ts` | +`FreshAgentSessionCommandSchema` (zod, strict), +optional `commands` on the snapshot schema |
| `shared/fresh-agent-slash-commands.ts` | +session-row type (`kind: 'session'` + `argumentHint?`) + `buildFreshAgentSlashCommandMenu(statics, catalog) → {action, session}` (within-kind dedupe only) |
| `test/fixtures/fresh-agent/contract-traceability.ts` | register new schema/type per convention (it is the .ts source; the .js form is the NodeNext import specifier) |
| `server/sdk-bridge.ts` | `state.commands` capture; `commands_changed` arm (REPLACE + rebroadcast `freshAgent.session.changed`-class edge); keep default-arm tolerance; probe `supportedCommands()` post-create |
| `server/fresh-agent/adapters/claude/normalize.ts` | fold `state.commands` → snapshot `commands` |
| `server/fresh-agent/adapters/opencode/` (model-catalog region or new commands-catalog.ts per implementer's read) | +fetch commands at create from sidecar `GET /command?directory=`, null-tolerant normalize, attach to snapshot |
| `src/components/fresh-agent/FreshAgentComposer.tsx` | menu list = merged rows; session-row select = insert `/name ` into input (canonical name), never auto-send |
| `src/components/fresh-agent/FreshAgentView.tsx` | pass snapshot-derived `commands` merged list into composer (slashCommands memo) |
| Tests | shared schema/merge tests; sdk-bridge commands_changed arm test; claude adapter probe test; claude normalize fold test; opencode fetch/normalize tests; composer unit tests (insert-not-send, mixed filter, ARIA untouched, dedupe); FreshAgentView wiring test; e2e extension (see Task 6) |
| Rust | none |

## 7. Tasks

### Task 1: Shared contract — session-command schema + optional snapshot field + merge helper (TDD)

**Files:** `shared/fresh-agent-contract.ts`, `shared/fresh-agent-slash-commands.ts`, `test/fixtures/fresh-agent/contract-traceability.ts`, `test/unit/shared/fresh-agent-contract.test.ts`, `test/unit/shared/fresh-agent-slash-commands.test.ts` (+ new-file-if-convention for schema tests — match existing layout)

- [ ] Step 1 RED: (a) snapshot schema accepts `commands` list of `{name,description,argumentHint?,aliases?}` and REJECTS garbage rows (missing name; extra keys if strict); (b) absence of `commands` parses identical to before (regression witness); (c) menu helper returns both groups; within-kind dedupe by case-insensitive name (canonical); cross-kind collision rows BOTH survive (e.g. static `compact` + session `compact`); session aliases preserved verbatim.
- [ ] Step 2 GREEN: implement schema + type + `buildFreshAgentSlashCommandMenu`. Exact-interface note: session row `{ name, description, argumentHint?, aliases?, kind: 'session' }`; action rows = today's shape (kind never added — dispatch checks kind only on the union). Traceability registration.
- [ ] Step 3 REFACTOR: only if real duplication with existing helpers.
- [ ] Step 4 focused: `npm run test:vitest -- run test/unit/shared/fresh-agent-contract.test.ts test/unit/shared/fresh-agent-slash-commands.test.ts test/unit/shared/fresh-agent-contract-traceability.test.ts` (all default config).
- [ ] Step 5: commit `feat(fresh-agent): session-command contract + snapshot slot + static-first merge helper`.

### Task 2: Server — claude bridge probe + commands_changed arm + snapshot fold (TDD)

**Files:** `server/sdk-bridge.ts`, `server/fresh-agent/adapters/claude/normalize.ts`, `test/unit/server/sdk-bridge.test.ts`, `test/unit/server/fresh-agent/claude-adapter.test.ts`, `test/unit/server/fresh-agent/claude-normalize.test.ts` (+ parity/contract tests if they enumerate schema fields — discover at execution)

Prerequisite interface from Task 1. Behaviors (all shaped by VAL-B receipts):
- On `createSession` (sdk-bridge.ts:189-225 region): fire `query.supportedCommands()` fire-and-forget (never awaited; .catch → absent). Probe rows normalized to contract rows (description ?? ''; drop nothing else) into a pending slot on session state.
- `system/init` arm (L369-385): capture `slash_commands` + `terminal_slash_commands` name-lists into state. Publish rule: when BOTH the init frame and the probe result are present, compute `state.commands = probeRows minus rows whose name ∈ terminal_slash_commands`, fold into the snapshot (via normalize), and emit the existing snapshot-invalidation broadcast. Late-arriving probe after init: same publish on probe resolution. Probe resolving after a `commands_changed` incorporation: dropped (stale).
- New `commands_changed` arm (currently swallowed in the system case): REPLACE pending/current catalog with the push's rows (same normalization + same terminal-subtract against the session's LATEST init list), then broadcast the same invalidation edge. Verify the invalidation edge's exact name/shape at the bridge before writing the arm (a wrong event name = silently stale menus — pin it in a test).
- `normalizeClaudeThreadSnapshot` folds `state.commands` → snapshot.commands only when defined.
- [ ] Steps RED→GREEN for: (a) init+probe JOIN publishes subtracted catalog (mock supportedCommands rows intersecting a terminal list; assert terminal rows absent from snapshot.commands); (b) `commands_changed` REPLACE + re-subtract + exact invalidation broadcast + liveness follow-up (sdk-bridge.test.ts mockGenerator pattern from last run's locks); (c) normalize fold omits when undefined (claude-normalize.test.ts); (d) probe rejection tolerance (session unaffected, commands absent); (e) pre-first-turn grace (no init → snapshot.commands absent, no crash); (f) drop-stale (commands_changed first, probe resolves after → probe ignored).
- [ ] Impacted: `npm run test:vitest -- run test/unit/server/sdk-bridge.test.ts test/unit/server/fresh-agent/ --config config/vitest/vitest.server.config.ts`.
- [ ] Commit: `feat(sdk-bridge): probe + relay claude slash-command catalogs (create-time supportedCommands + commands_changed REPLACE)`.

### Task 3: Server — freshopencode commands from sidecar `/command` (GATED on Stage-2 invocation-semantics proof; TDD)

**Gate outcome (Stage 2, VAL-A — execution lane settled):** verbatim slash text does NOT invoke commands (falsified live); `POST /session/{id}/command` executes synchronously and records the expanded template as the user part (confirmed live). Design = catalog from sidecar `/command?directory=` + adapter dispatch intercept (no client changes, no template expansion).

**Files:** new `server/fresh-agent/adapters/opencode/commands-catalog.ts` (or extend model-catalog.ts — implementer chooses per house shape, note in report), opencode adapter create path, `test/unit/server/fresh-agent/opencode-*.test.ts` matching new/changed module.

- Null-tolerant zod for sidecar rows (explicit nulls on description/agent/model/subtask proven live); normalize to contract rows (description ?? ''; argumentHint unset; aliases omitted; keep `source` OUT of the contract row — contract stays the minimal intersect).
- Catalog: at session create fetch `GET {baseUrl}/command?directory=<cwd>` with the house fetchWithTimeout pattern; failure = absent (never session-fatal). NO scratch spawn, NO --pure (drops config-inline user commands — VAL-A LB-03).
- Dispatch intercept: in the adapter's send path, parse submitted text as `/name args`; if `name` case-insensitively matches a captured catalog row → POST `{baseUrl}/session/{sessionId}/command` body `{command: row.name (canonical casing), arguments: args}`; else verbatim today-path. POST is synchronous at turn scale — apply turn-scale timeouts; busy/idle: first mirror prompt-path behavior against a mocked sidecar (exact SSE busy events unobserved live — pin the adapter's derived behavior in tests; if serve emits no busy SSE around /command turns, synthesize busy→idle around the await so pane status stays truthful).
- Attach to snapshot.commands at the freshopencode normalize path; store the captured catalog on session state for the dispatch lookup.
- [ ] RED→GREEN (mocked sidecar): row normalization incl. nulls; directory param forwarded; catalog failure → absent + verbatim send unaffected; matching `/name args` routes to POST (verbatim parts asserted: command + arguments); mismatching slash text unchanged verbatim; busy/idle edges around POST match prompt-path semantics; failure of POST surfaces a send error (no silent drop).
- [ ] Impacted server suite run.
- [ ] Commit: `feat(freshopencode): advertise sidecar /command catalog + route matching slash text to the command endpoint`.

### Task 4: Client — composer mixed menu + insert-not-send (TDD)

**Files:** `src/components/fresh-agent/FreshAgentComposer.tsx`, `src/components/fresh-agent/FreshAgentView.tsx`, `test/unit/client/components/fresh-agent/FreshAgentComposer.test.tsx`, `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`.

- FreshAgentView slashCommands memo (L674-680 region): grouped = `buildFreshAgentSlashCommandMenu(getFreshAgentSlashCommands(sessionType), snapshot?.commands ?? [])`; capability gating intact. Composer's typed-Enter path (`executeSlashText`) matches action rows only.
- Composer: render the menu in two labelled groups (non-focusable divider entries: "Pane actions", "Agent session") inside the existing single conditionally-rendered menu; filtering applies across both groups (current substring semantics: name-only — verify at L222-225 and pin); action-row select path unchanged; session-row select inserts `/canonicalName ` into the input via the same text-set mechanism typing uses, focuses input, does NOT send.
- unknown-command fallthrough unchanged.
- [ ] RED→GREEN tests: grouping order (actions group first); cross-kind collision rows both present (static compact + session compact) and typed-Enter still dispatches the ACTION; within-kind session dedupe (canonical name, case-insensitive); alias select inserts canonical name; insert does not dispatch send/onCommand; filter semantics per current behavior (verify name-substring at composer L222-225 and pin it); menu ARIA roles unchanged (extend existing structure coverage if present).
- [ ] Impacted: composer+view unit files + `npm run typecheck` + `npm run lint` (a11y clean).
- [ ] Commit: `feat(fresh-agent): composer surfaces provider-advertised slash commands (insert, never auto-send)`.

### Task 5: e2e + live smoke evidence

- [ ] e2e: extend the existing fresh-agent control spec (`test/e2e-browser/specs/fresh-agent-control-rust.spec.ts` home of capability-gate pins) or the matching node-equivalent spec if that's the harness for composer scenarios — AT EXECUTION pick whichever harness mocks/stubs the snapshot (read the spec conventions); add: snapshot with commands rows ⇒ menu shows merged rows; session row select inserts text without sending; static rows behave identically to today. `npm run test:e2e:local -- <chosen spec>` PASS; do not weaken any existing assertion.
- [ ] Live smoke: scratch dev server unique port 3597, PID-filed; copy .env (delete after). (a) freshclaude: create pane, send one cheap prompt (text: "Reply with the single word PING"), wait for idle via send-keys (timeout 120), then fetch REST snapshot ⇒ ASSERT snapshot.commands non-empty, contains a rich builtin (e.g. 'compact'), and ABSENT terminal-only rows proven terminal-tagged by VAL-B ('doctor','color' — assert only if they appear in the live catalog today; the invariant is 'no row name ∈ the session's terminal list' — fetch init is internal, so assert absence of doctor/color as the live proxy). (b) freshopencode: create pane + snapshot ⇒ commands non-empty (live sidecar catalog; no turn needed). (c) Turn-scale opencode dispatch sanity against the live sidecar: send '/review' args-free? — NO: assert-only-what's-provable: skip dispatch live-check (VAL-A already executed it); the mock tests own that behavior. Teardown + hygiene verify + receipts to run ledger. NOTE (a) needs the first-turn join — pre-turn snapshot must show commands ABSENT (assert that too as the grace-window witness).
- [ ] Commit e2e additions only.

### Task 6: Close-out gate

- [ ] `npm run typecheck && npm run lint` → 0.
- [ ] Fullsuite final gate: `FRESHELL_TEST_SUMMARY="slash-command catalogs final gate" npm test` (cloud backend expected working again — gcloud reauthed; do NOT force local).
- [ ] Update run-state; STOP for Fresh Eyes delta rounds.

## 8. Rollback

Abandon = delete branch. Targeted: revert Task 4 (menu) leaving server slot inert; revert Task 2/3 server filling; revert Task 1 contract last. Rust/prod never involved.
