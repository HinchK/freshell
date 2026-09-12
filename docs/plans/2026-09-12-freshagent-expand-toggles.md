# Plan: fresh-agent "Expand thinking" / "Expand tools" redesign (redo cycle)

## User Request

### Requested result
Fresh-agent panes always render thinking rows and the tool activity line (never hidden). Settings → Coding Agents has two separate switches, "Expand thinking" and "Expand tools" (both default off = compact), that control only whether each starts expanded; users can temporarily expand/collapse in the pane without affecting the settings. The old "Show thinking"/"Show tools" switches and their show/hide semantics are removed.

### Explicit constraints
- Run this work with the-usual.
- Repo rules: work in a worktree; TDD with unit and e2e coverage; never open a PR without explicit user approval.

### Accepted tradeoffs and residuals
- None stated.

## Context

This is the redo cycle of the the-usual run on branch `the-usual/freshagent-display-toggles`
(worktree `.worktrees/freshagent-display-toggles`, base_ref `2e05dd9e2f8a4dce393689d228e21ad123c474a5`).
Cycle 1 shipped "Show thinking"/"Show tools" visibility toggles (defaults true, tool detail
expanded at mount) through HEAD `4731fc66e`, reviewed and gate-passed. The user then clarified
the intended design — compact-by-default, expandable, with switches controlling only the
starting state — and directed this redo. All cycle-1 artifacts remain valid history; this plan
supersedes the cycle-1 design on the same branch.

Exploration reports (authoritative for byte-level detail; this plan cites them rather than
duplicating their tables):

- `reports/redo-rust-persistence.md` — settings-key rename surface, old-data behavior, Rust seed
- `reports/redo-display-components.md` — component change map, dead-code list, strip contract, test classification
- `reports/redo-pane-payload-e2e.md` — per-pane field decision inputs, e2e inventory, new coverage

(All under `.worktrees/.the-usual-logs/freshagent-display-toggles/`; file:line refs below are to
worktree HEAD `4731fc66e` unless stated.)

## Design contract (pinned decisions)

**D1 — Always-visible.** Thinking/reasoning transcript items are never filtered. The entire
display-filter subsystem is deleted: `TranscriptDisplayOptions` + `shouldDisplayTranscriptItem`
(`FreshAgentTranscript.tsx:71-83`), `filterTurnsForDisplay` (`:467-495`), the
`DisplayTurn.hadFilteredItems` marker (`:457-465`), its `foldCaption` clause (`:295`), the
filtered-echo null-render branch (`:870-875`), and the `displayOptions` memo (`:969-972`).
"Visible" for a collapsed strip means the `settledSummary` part `'thought'`
(`FreshAgentTranscript.tsx:210-219`) — a thinking-only line reads `thought`, a mixed line reads
`thought · N tools used` — and the `Thinking` disclosure rows render whenever the strip is
expanded. No filtering, turn-dropping, or caption-gating for hidden content remains.

**D2 — Two expansion-default settings, compact by default.** Browser-local keys
`freshAgent.expandThinking` / `freshAgent.expandTools` (both default `false`), replacing
`showThinking`/`showTools` everywhere (`shared/settings.ts:97-101` FRESH_AGENT_LOCAL_KEYS,
`:229-233` LocalSettings type, `:631-645` normalizeLocalPatch, `:920-924` defaults,
`:942-956` sanitize pick; `browserPreferencesPersistence.ts:132-138`). Old-key values are
deliberately NOT mapped (show/hide has no meaning-preserving mapping to expansion);
stale keys are stripped on read by the existing pick-list machinery and scrubbed from
storage on the next wholesale flush — accepted residual, no migration code.
- `expandTools` feeds the strip's existing `initialExpanded` pipe (`:861-866`, `:883-885`).
  The strip's live re-sync effect (`:614-615`) is **kept** (renamed source): a live settings
  flip re-expands/re-collapses mounted strips, preserving the cross-tab propagation pinned by
  `FreshAgentView.test.tsx:822-873` and `persistBroadcast`→`crossTabSync.ts:257`. "Controls the
  default" holds at mount; the stomp-on-settings-change is cycle-1's shipped behavior.
- `expandThinking` feeds a new `initialExpanded` prop on `FreshAgentThinkingRow` (`:582-603`,
  `useState(initialExpanded)` — **mount-only**, matching the `FreshAgentToolBlock` precedent at
  `FreshAgentItemCard.tsx:71`). Strip collapse/expand already unmounts the row subtree
  (`{!expanded ? … : …}` at `:653-711`), so strip re-expansion re-applies row initial state.
- Component prop defaults: `expandThinking = false`, `expandTools = false`
  (`:916-917`, `:944-945`).

**D3 — Per-pane display-override fields are removed.** No production writer has set
`paneContent.showThinking`/`showTools` since `6d0f4ef84` (2026-04-06, popover removal); no
REST/MCP surface accepts them. Removing: `paneTypes.ts:243-244` (showTimecodes at `:245` STAYS —
out of scope), `panesSlice.ts:202-203, 282-283`, `paneTreeValidation.ts:93-94`,
`tab-registry-open.ts:169-170`, `tab-registry-snapshot.ts:61-62`, `shared/fresh-agent.ts:50-51`
(the `...rest` passthrough in `migrateLegacyFreshAgentContent` then drops them from legacy
agent-chat panes), and `FreshAgentView.tsx:596-597` resolution (View reads globals only).
Rust `crates/freshell-ws/src/tabs_persist_validation.rs:391-392`: **keep** the two
`optional_bool` lines as legacy tolerance (old persisted generations still validate their
boolean shape; wrong-typed legacy values still rejected) with a "legacy-only, no writer since
2026-04" comment. Rust `crates/freshell-server/src/legacy_local_seed.rs:31`
FRESH_AGENT_LOCAL_KEYS renames to `["expandThinking","expandTools","showTimecodes"]`; legacy
`agentChat.showThinking/showTools` stop migrating (dropped by the pick loop) — the requested
behavior; byte-exact oracle fixtures at `:467/:474/:578-589` follow.

**D4 — Settings UI + docs mock.** `CodingAgentsSettings.tsx:154-175`: section description →
"Whether fresh-agent panes start with thinking and tool details expanded"; rows relabeled
**Expand thinking** / **Expand tools**, `checked={…expandThinking ?? false}` /
`…expandTools ?? false`, patch keys renamed, aria-labels match the labels, and a short help
line conveying: details are always shown compact; these switches set whether they start
expanded; in-pane expand/collapse is temporary. `docs/index.html:1050-1067`: relabel rows,
`aria-checked="false"`, switch visuals off, reworded description.

**D5 — Branch strategy: continue on this branch.** Restart-from-`origin/main` was considered
(both reports note the redo subsumes cycle 1) and declined: the redo adapts branch-only
structures (the settings section, the fixed `openSettingsSection` helper, the strict-mode-safe
locators) that do not exist on main; discarding commits requires an explicit user request; the
final PR diff vs main is identical either way. Cycle-1 commits stay as history.

**D6 — Rust deploy dependency.** The Rust changes are test-verified in-workflow via
`cargo test`, but production parity lands only with a server rebuild+restart at deploy time —
gated on the user's explicit "APPROVED" per AGENTS.md. No restarts in this run.

Out of scope (recorded, not built): the `showTimecodes` per-pane field (last vestigial member
of the trio — possible follow-up); the unreachable `FreshAgentItemCard.tsx:251-268/:284-295`
thinking/reasoning cards (pre-existing dead code).

## Files

- `shared/settings.ts` — D2 five sites
- `src/store/browserPreferencesPersistence.ts:132-138`
- `src/components/fresh-agent/FreshAgentTranscript.tsx` — D1 + D2 change map (redo-display-components.md §a)
- `src/components/fresh-agent/FreshAgentView.tsx:584-597, 2927-2928`
- `src/components/settings/CodingAgentsSettings.tsx:154-175`
- `src/store/paneTypes.ts`, `src/store/panesSlice.ts`, `src/store/paneTreeValidation.ts`,
  `src/lib/tab-registry-open.ts`, `src/lib/tab-registry-snapshot.ts`, `shared/fresh-agent.ts` — D3
- `crates/freshell-server/src/legacy_local_seed.rs`, `crates/freshell-ws/src/tabs_persist_validation.rs` — D3
- `docs/index.html:1050-1067` — D4
- Unit suites per redo-display-components.md §d + redo-pane-payload-e2e.md A3/A4 test lists
- `test/e2e-browser/specs/fresh-agent.spec.ts`, `test/e2e-browser/specs/settings.spec.ts` — Task 5

## Task 1: Rename the settings data model (shared + persistence + Rust seed)

TDD on the unit suites; Rust on cargo. No component changes yet (Task 2 rewrites those tests'
failures into Task 2's RED — Task 1's GREEN scope is the data layer only: keys, defaults,
patch/sanitize/seed paths, persistence writes).

- [ ] **Step 1: RED.** Rewrite the data-layer tests to pin the new keys:
  - `test/unit/shared/settings.test.ts`: @156 (resolves expand keys; old show*/agentChat display
    keys dropped), @258-269 (server-patch rejection assertions for `expandThinking`/`expandTools`;
    `showTimecodes` stays), @351-401 (legacy seed picks expand keys; `agentChat.showThinking/showTools`
    NOT picked), @674-713 (new defaults `{expandThinking:false, expandTools:false, showTimecodes:false}`
    across the fontScale describe rewrites).
  - `test/unit/client/store/browserPreferencesPersistence.test.ts`: @192 (persists
    `expandThinking:true` while defaults stay absent), @208 (all three when each deviates),
    @226 (no freshAgent blob section when equal to defaults), @240 (round-trip a true value),
    @274 (legacy fontScale rehydration fixture → expand key).
  - `test/unit/client/browser-preferences.fresh-agent-settings.test.ts`: @15/@42 — expand-key
    seeds resolve; stale show*/fontScale dropped.
  - `test/unit/server/` Rust-parity note: the `legacy_local_seed` oracle lives in Rust (below).
  Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/browser-preferences.fresh-agent-settings.test.ts`
  Expected: the rewritten tests fail (old keys/defaults in code); all other tests in those files pass.
- [ ] **Step 2: Verify the intended failure matches** — failures are key-name/defaults mismatches only.
- [ ] **Step 3: Implement.** `shared/settings.ts` five sites (D2), `browserPreferencesPersistence.ts:132-138`,
  `crates/freshell-server/src/legacy_local_seed.rs:31` + its byte-exact oracle fixtures/tests
  (`:467`, `:474`, `:578-589` — per redo-rust-persistence.md §7.4; legacy agentChat display keys
  drop via the pick-list rename, no mapping code).
- [ ] **Step 4: GREEN.** Re-run Step 1's command: all pass. Then `cargo test -p freshell-server`
  (worktree root) — legacy_local_seed tests pass with the renamed keys and dropped legacy values.
- [ ] **Step 5: Refactor while green.** Dead paths: none expected beyond the renamed picks.
- [ ] **Step 6: Impacted-test verification.** `npm run test:vitest -- run test/unit/client/store/persisted-state.fresh-agent.test.ts test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  Expected: cycle-1 default-flip assertions fail (they pin show*=true defaults and Show*/Expand
  labels) — this is Task 2/4 RED material, recorded, not fixed here. Unit suites untouched by
  the rename must pass.
- [ ] **Step 7: Commit.** `feat(settings): rename fresh-agent display keys to expandThinking/expandTools`

## Task 2: Always-visible transcript + expansion plumbing

- [ ] **Step 1: RED.** In `test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx`
  apply redo-display-components.md §d: DELETE @244 (hide pin), @1148, @1260, @2007, @2045, @2076;
  REWRITE @273 ("starts the strip expanded when expandTools is true"), @1160 (genuinely-zero-item
  streaming fixture), @1175 (zero-item↔tool transitions), @1221 (one spinner; visible
  thinking-only tail), @1273-light, @2097/@2120 (visible-thinking merge rationale), @2178
  split (positive stash survives; negative gated lane deleted), @2222; ADD-MISSING T1-T7:
  T1 "renders thinking rows regardless of the expandThinking setting" (strip expanded via
  `expandTools`; trigger visible, body absent until click), T2 "starts thinking rows expanded
  when expandThinking is true", T3 "starts thinking rows collapsed by default", T4 "mounts the
  strip collapsed by default (expandTools unset)" (`aria-expanded="false"`, settled summary,
  no tool rows), T5 "a thinking-only turn renders an activity strip and is never dropped",
  T6 "stashes a superseded echo caption from a thinking-bearing turn", T7 "in-pane expansion
  is temporary state, not a setting" (rerender with unchanged props keeps state; rerender with
  CHANGED `expandTools` re-syncs the strip — F1=keep).
  In `FreshAgentView.test.tsx`: REWRITE @709 ("flows expandThinking/expandTools from global
  settings into the transcript"), @775 ("mounts thinking rows and a collapsed strip by
  default"), @822 (DELETE hide semantics; REPLACE with "re-renders the strip expansion when
  expandTools changes on the live store" + "keeps thinking visible when expandThinking flips").
  Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx`
  Expected: new/rewritten tests fail (filter still hides; no initialExpanded plumb; props
  still show*); all KEEP tests still pass.
- [ ] **Step 2: Verify the intended failure matches.**
- [ ] **Step 3: Implement** per redo-display-components.md §a: delete the filter subsystem
  (D1 list); `FreshAgentThinkingRow` gains `initialExpanded` (mount-only); strip gains
  `initialThinkingExpanded`, keeps re-sync on `initialExpanded` (source renamed to expandTools);
  `FreshAgentTurnArticle` props renamed `expandTools` + added `expandThinking` (`:748/:763`,
  `:861-866`, `:883-885`, `:707-709`, `:1155`); component props/defaults per D2
  (`:916-917`, `:944-945`); `displayTurns = useMemo(() => coalesceSyntheticToolResultTurns(turns), [turns])`
  (`:973-979`); FreshAgentView: global `expandThinking`/`expandTools` selectors (`?? false`),
  per-pane resolution lines deleted, transcript call site updated (`:584-597`, `:2927-2928`).
- [ ] **Step 4: GREEN.** Step 1's command: all pass.
- [ ] **Step 5: Refactor while green.** Confirm zero references to `shouldDisplayTranscriptItem`,
  `filterTurnsForDisplay`, `hadFilteredItems`, `TranscriptDisplayOptions` remain.
- [ ] **Step 6: Impacted-test verification.** `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/fresh-agent-pane-migration.test.ts test/unit/client/store/persisted-state.fresh-agent.test.ts`
  Expected: pane-payload migration tests (per-pane fields) fail — Task 3 RED material, recorded.
- [ ] **Step 7: Commit.** `feat(fresh-agent): always render thinking; expansion settings control initial state`

## Task 3: Remove per-pane display-override fields

- [ ] **Step 1: RED.** Re-base the migration-preservation tests per redo-pane-payload-e2e.md A3:
  `persisted-state.fresh-agent.test.ts` @92/@204, `panesPersistence.test.ts` @1116/@1161/@1241,
  `panesSlice.test.ts` @438/@4956, `fresh-agent-pane-migration.test.ts` @158,
  `tab-registry-snapshot.test.ts` @128-129, `tab-registry-fresh-agent-migration.test.ts` @70/@90,
  `test/unit/server/agent-layout-schema.test.ts` @151/@169,
  `test/unit/server/tabs-registry/fresh-agent-migration.test.ts` @133/@149 — from "preserves …
  as pane overrides" to "drops legacy display fields during migration" (legacy panes load;
  the two fields vanish; `showTimecodes` behavior unchanged).
  Run: `npm run test:vitest -- run <the eight files>`
  Expected: rewritten tests fail (fields still copied/stamped/validated).
- [ ] **Step 2: Verify the intended failure matches.**
- [ ] **Step 3: Implement** D3: delete the fields from `paneTypes.ts`, the two normalizePaneContent
  copies, the validation clauses, both registry stamps, `shared/fresh-agent.ts:50-51`; Rust
  `tabs_persist_validation.rs:391-392` keep-with-comment; no Rust seed change (Task 1 done).
- [ ] **Step 4: GREEN.** Step 1's command passes; then `cargo test -p freshell-ws` — the
  persist-validation suite stays green (tolerated legacy fields still validate).
- [ ] **Step 5: Refactor while green.** Grep: `paneContent.showThinking|showTools` → no client refs.
- [ ] **Step 6: Impacted-test verification.** `npm run test:vitest -- run test/unit/client/store/ test/unit/client/lib/tab-registry-snapshot.test.ts`
  Expected: green (Task 2 already removed the reader).
- [ ] **Step 7: Commit.** `refactor(panes): drop vestigial per-pane display override fields`

## Task 4: Settings UI + docs mock

- [ ] **Step 1: RED.** Rewrite `test/unit/client/components/SettingsView.agent-chat.test.tsx`:
  @24 rows → 'Expand thinking'/'Expand tools' (keep the negative no-timecodes/no-font-size
  assertions); @50 toggle test → new labels/keys, `aria-checked` starts 'false', click flips the
  store key, `api.patch` still never called; ADD: the section's help text mentions the
  always-shown/starts-expanded contract (assert a description/help element exists).
  Run: `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx`
  Expected: fails (current UI shows Show* labels/keys).
- [ ] **Step 2: Verify the intended failure matches.**
- [ ] **Step 3: Implement** D4: `CodingAgentsSettings.tsx` relabel + help text + new keys;
  `docs/index.html` mock relabel + off-state.
- [ ] **Step 4: GREEN.** Step 1 passes; `npm run lint` — 0 errors in changed files.
- [ ] **Step 5: Refactor while green.**
- [ ] **Step 6: Impacted-test verification.** `npm run test:vitest -- run test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/shared/settings.test.ts`
- [ ] **Step 7: Commit.** `feat(settings): expand thinking/tools switches control initial expansion`

## Task 5: E2E rework + new coverage

- [ ] **Step 1: RED — verify the broken pins.** Tasks 1-4 change the components these specs
  pin, so BEFORE any spec edit, run the current specs and record the intended failure:
  `export GCLOUD_ROBOT_HOME="$HOME/.codex/skills/gcloud-robot"; scripts/e2e-cloud.sh run --local --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts`
  Expected failures (the removed behavior): the cycle-1 default test (`:1698`) pins
  expanded-by-default + Show* switch loops; `:1647`/`:1678`/`:1836`/`:1874`/`:814` choreographies
  assume expanded mounts or per-pane `showThinking` seeds; `settings.spec.ts:181` pins Show*
  labels/keys. Tests that must still PASS: every KEEP-classified test (#7/#8/#9 in B1, the
  settings.spec helper + non-fresh-agent tests) — they pin behavior the redesign preserves.
- [ ] **Step 2: Verify the intended failure matches** — each failure is a mount-state,
  label/key, or per-pane-seed mismatch; no infrastructure or unrelated failure.
- [ ] **Step 3: Implement the rewrite.** Apply redo-pane-payload-e2e.md B1/B2/B3:
  - fresh-agent.spec.ts: REWRITE #1 (`:1647`, collapsed mount `5 tools used` + strict-safe
    expanded assertions), #2 (`:1678`, two collapsed `1 tool used` summaries), #4 (`:1836`,
    strip-toggle click before caption/pre assertions; reword name), #5 (`:1874`, stripTwo
    expand click before Thinking; comment updates), #6 (`:814` — delete the `:957` per-pane
    seed; restore the strip-expand Enter-press before the Thinking press; rename the
    'should stay hidden' string); DELETE+REPLACE #3 (`:1698`) with the new default test:
    compact mount (`aria-expanded="false"`, `thought · 1 tool used` summary), expand →
    `Read tool call` + `pre[data-tool-input]` visible AND `Thinking` disclosure visible,
    click Thinking → body visible; new settings loop per B3.2/B3.3 (flip "Expand tools" on →
    strip mounts expanded on return; "Expand thinking" on → Thinking mounts expanded; both
    off again → compact; Thinking trigger NEVER absent in any state); new B3.4 test
    (temporary in-pane expansion never writes settings: expand in-pane → Settings shows
    "Expand tools" `aria-checked="false"` → return → compact remount; blob gained no key).
    KEEP #7 (`:1111`, delete only the `:1199` seed; helper is state-robust), #8, #9.
    Fold in the recap's optional improvements on touched lines: `getByRole('switch', { name })`
    locators; a named constant for the 600ms debounce wait.
  - settings.spec.ts: REWRITE the `:181` toggle test per B2 (labels, `aria-checked` false
    default, `freshAgent.expandThinking/expandTools` keys in settings+blob, reset-to-default
    drops keys, switch locators by accessible name). KEEP the helper and all other tests.
    Fold in the recap's optional improvements on touched lines: `getByRole('switch', { name })`
    locators; a named constant for the 600ms debounce wait.
  New tests written in this task run against the already-shipped Tasks 1-4 components, so their
  RED is Step 1's broken pins; the task reviewer must verify each new test is non-vacuous
  (asserts states that differ across settings values).
  Constraints that carry over (redo-pane-payload-e2e.md B4): exact-name settings-open pin
  `'Settings (Ctrl+B ,)'` (the pane-header "Agent settings" button makes a /settings/i regex a
  strict-mode violation); `openSettingsSection` id-derived tabpanel name; return via
  `getByTitle('Coding Agents (Ctrl+B T)')`; `pre[data-tool-input]` strict-safe assertions; no
  CLOUD_SKIP_SPECS membership; thinking triggers never asserted absent in any state.
- [ ] **Step 4: GREEN (local).** Re-run Step 1's command: all tests in both specs pass.
- [ ] **Step 5: Refactor while green.** No dead choreography left (no orphaned expand helpers).
- [ ] **Step 6: GREEN (cloud).** `export GCLOUD_ROBOT_HOME="$HOME/.codex/skills/gcloud-robot"; scripts/e2e-cloud.sh run --project=chromium test/e2e-browser/specs/fresh-agent.spec.ts test/e2e-browser/specs/settings.spec.ts`
  Expected: PASS (both specs cloud-runnable; required before any PR).
- [ ] **Step 7: Commit.** `test(e2e): pin compact default and expand-settings behavior`

## Verification and gates

1. After Task 5: `cargo test -p freshell-server -p freshell-ws` (worktree root) — Rust parity green.
2. Stage-4 final gate: coordinated `npm test` on the redo HEAD (cloud backends,
   `GCLOUD_ROBOT_HOME` exported, `FRESHELL_TEST_SUMMARY` set). Pass criterion: green excluding
   the two ledger-recorded pre-existing flakes (`agent-cli-flow` rename, `ws-terminal-idle` 1 ms
   boundary — receipts R1-R3 in run-state.md); electron + port phases green (direct phase runs
   if a ledger flake aborts phase 1 — same assembled-gate procedure as cycle 1).
3. Stage-5 delta review: fresh eyes on the FULL delta `base_ref..HEAD` (both cycles), up to 5
   rounds + focused episodes per the skill.
4. Stage-6 recap: outcome block, both cycles accounted; no PR without explicit user approval;
   Rust deploy (rebuild+restart) flagged as needing the user's "APPROVED" at deploy time.
5. Lint: `npm run lint` after Task 4 and again after Task 5 (spec edits) — the a11y plugin
   requires the new switch labels/aria to stay consistent; 0 new errors in changed files.
