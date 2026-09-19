# main-green-sixpack Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
- Fix, in a single the-usual run, the six recurring/standing test failures on main: four e2e spec families (deploy-tab-diff-rust :81, remote-tab-linkage-rust :107, rest-tab-persistence :117, sidebar-opencode-rail :143) and two Rust test flakes (59nb pane_ledger invariants-capture race, hsrh freshell-freshagent session-init budget) — all root-caused by the completed investigation phase.

### Explicit constraints
- Root-cause-first: each fix must address the diagnosed mechanism, not a blind patience raise (no evidence-free wall-clock raises).
- Fixes must be coherent with the repo's rename-scope contract (docs/development/rename-scope-contract.md) where they touch tab/pane/session title precedence.
- Land as one branch/PR from origin/main via the established campaign pattern (review + gate + PR + merge).
- Never restart the production server on port 3001; standard process-safety rules apply.

### Accepted tradeoffs and residuals
- Deterministic-red specs found by investigation (deploy-tab-diff, rest-tab-persistence, sidebar-opencode-rail, hsrh zombie test) are in scope to fix or reshape as the root cause dictates.
- The stranded branch origin/fix-session-init-provenance-flake (8186d9f3e) may be reused for the hsrh fix rather than rewritten.

**Goal:** All six standing failures on main go green — the four e2e specs pass with the title-precedence contract restored in the product, and the two Rust flakes (59nb capture race, hsrh session-init race) are fixed at their diagnosed mechanisms — proven by a full local suite that is green in every lane EXCEPT the Rust lane's ten recorded pre-existing standing reds on main (D4: base-verified deterministic reds, disjoint from the six, out of scope under no-scope-creep; one kata per family filed at wrap), which the campaign gate excludes by name.

**Architecture:** One coherent product-side title-precedence resolution (Task 1: explicit creator/user titles outrank mirrored and auto titles, and the client's sidebar label for title-less running rows falls back through the fallback row's name order so pre-transcript rows stay meaningful — the originally-planned server-side "fabricated rows carry no title" half was REVERTED at delta review round 1; see D5) that the four e2e specs already encode, so they flip red→green as the regression proofs; two Rust test-infrastructure fixes — migrate the freshell-ws lib capture util to the repo's e08g process-global OnceLock pattern with per-test-unique-field filtering (Task 3), and delete the merge-repair-resurrected zombie test while landing the stranded either-order combined frame drain — extended with a binding-row barrier required by the base's `54850ac5c` pre-registration deferral — on its live siblings (Tasks 4–5); a full-suite gate closes the campaign (Task 6).

**Tech Stack:** React 18 + Redux Toolkit (client fold, display-title precedence), Rust (freshell-server session directory, freshell-ws test capture, freshell-freshagent claude tests), Vitest (unit), Playwright (e2e), tracing/tracing-subscriber (callsite Interest cache mechanics).

## Global Constraints

- **Process safety:** Never restart or stop the self-hosted production Rust server on port 3001 (requires the user's explicit "APPROVED"). No broad kill patterns. All builds and focused test runs in this campaign run from THIS linked worktree (`.worktrees/main-green-sixpack`) — `scripts/prebuild-guard.ts` fails closed on the main checkout while production holds the configured PORT, and exempts linked worktrees.
- **Test coordination:** Broad repo-supported runs (`npm test`, zero-argument server/integration invocations) wait for the shared coordinator gate (`npm run test:status`); narrowed/focused selectors run directly (delegated). The e2e lanes are NOT wired to the coordinator (`scripts/e2e-cloud.sh` execs Playwright directly; the coordinator command matrix has no e2e entry) — before any broad e2e lane, check `npm run test:status` BY HAND and wait out any active holder (Task 6 Step 2b). Set `FRESHELL_TEST_SUMMARY` with a human-meaningful reason when holding the coordinator gate (used in Task 6 Step 2a; it does nothing for e2e lanes). `FRESHELL_VITEST_BACKEND` and `FRESHELL_E2E_BACKEND` are UNSET in this environment — the default backend is local; do not switch backends.
- **No evidence-free patience raises:** every timeout that changes in this campaign changes because the diagnosed mechanism demands it (the hsrh 15s budget stays; the wait shape changes). No wall-clock raise anywhere.
- **TDD:** red-green-refactor per task. Every production bug fix gets a regression test that fails first for the missing behavior.
- **TypeScript NodeNext/ESM:** relative imports in `src/` and `test/` TS files carry `.js` extensions.
- **Rust test lanes:** narrowed Cargo selectors (`cargo test -p <crate> --locked <filter>`) run directly; the full coordinated suite happens once, in Task 6.
- **Commits/branch/PR:** focused conventional commit messages; every `git push` runs the pre-push gate (cargo fmt, typecheck, clippy filtered by the push) — see docs/development/pre-push-gate.md. This worktree's branch is `main-green-sixpack` from base `dbbfd0752`; never push to `main`; PR creation only after the user explicitly approves (the-usual stage 5).
- **Kata attribution:** the Rust two are katas — Task 3 closes **59nb**, Tasks 4+5 close **hsrh**. The e2e four (deploy-tab-diff, remote-tab-linkage, rest-tab-persistence, sidebar-opencode-rail) are **standing ledger items, NOT katas**.
- **Rename-scope contract:** docs/development/rename-scope-contract.md governs title/naming changes; Task 1 extends it with the resolved display precedence and must not violate any hard rule in it (verified in the Resolution section below).
- **No scope creep:** do not fix unrelated failures found along the way; record them in the run-state `important decisions and blockers` instead.

## Load-Bearing Assumptions to Validate (stage 2)

These are the plan's riskiest claims; stage 2 validates each before/while executing:

1. **PR #799 (pane-header-mobile-v3, in base dbbfd0752) did not change the sidebar-opencode-rail failure shape.** The investigation ran at `22a6083ee`/`34f425fae`; #799 rewrote the pane header (`src/components/PaneHeader.tsx` → `src/components/panes/PaneHeader.tsx`). Verified statically at dbbfd0752: `role="banner"` + `aria-label={`Pane: ${title}`}` survive at `src/components/panes/PaneHeader.tsx:176-177`. Task 1 Step 1 re-runs the spec focused at this base BEFORE any fix; if the failure is not the diagnosed `Pane: OpenCode` clobber at spec line 327 (banner missing, renamed, or a new #799-induced failure), STOP and re-diagnose before touching production code.
2. **Title-precedence conflict between investigations, resolved product-side.** The deploy-tab-diff investigation prescribed a TEST-SIDE fix (assert `tabId`, and explicitly warned the `titleSetByUser` product change "must not be slipped in under this test"); the rest-tab-persistence investigation prescribed exactly that PRODUCT fix as minimal-and-correct. The User Request resolves this in favor of ONE product-side precedence (see Resolution section) applied campaign-wide. Consequence: the four specs pass with their ORIGINAL assertions (they were authored against this contract; the Sep-15 title-pipeline campaign broke it). The deploy-tab-diff tabId hardening (Task 2) is added, not substituted.
3. **The sidebar dedupe click preserves the explicit REST name under the new precedence** (the click on an already-open session returns early in the sidebar handler at `Sidebar.tsx:486-489` — `findPaneForSession` finds the pane — so the guard that actually fires is the `!existingTab.titleSetByUser` title-sync check at `Sidebar.tsx:487`; the click never reaches `openSessionTab`/`tabsSlice.ts:1141`, whose own `!existingTab.titleSetByUser` guard carries the same semantic on the not-already-open path — once Task 1 sets the flag, the click's session-title sync is blocked either way), so remote-tab-linkage's post-restart leg (:310, `tabTitleAfterClick` read dynamically from raw Redux `tab.title`) passes with the REST name. The spec's stale NOTE comment (:255-260) claimed the opposite; Task 2 corrects the comment and adds a pin.
4. **The 59nb capture migration's consumer-filter audit is complete and load-bearing.** Converting `capture()` to a process-global OnceLock subscriber routes EVERY test's events into one shared vec; each of the 26 consumer call sites across 5 files must filter by a per-test-unique field (`root`/`path`/`device_id`/`terminal_id`), and colliding ids must be made unique per test — in `invariants.rs` the shared ids are REAL: `t-ev` is used by BOTH `:760` (expects exactly one warning) and `:801` (expects none), `t-late` by BOTH `:1154` (expects a warning) and `:939` (expects none), and `t-young` (`:585`/`:992`) and `t-idle` (`:709`/`:1234`) are each shared by two tests as well; the unresolved-warning event carries ONLY `terminal_id`/`mode`/`age_ms` (`invariants.rs:232-237`), so terminal-id renaming per test is the ONLY available discriminator there. A missed consumer (or a missed id collision) turns the rare race into a deterministic false-fail (exact-count/negative assertions) or false-pass (`.any()` assertions) under parallelism. The same weakness applies to the two OTHER thread-local `set_default` captures in the binary (`pane_ledger_tests.rs`'s `lock_failure_capture`, `create_dedupe.rs`'s DIAG-01 inline capture) — Task 3 folds them into the same migration, so after it no thread-local capture-util capture remains (three scoped `tracing::subscriber::with_default` FILTER-SHAPE captures in `terminal.rs` — `:10008`, `:10067`, `:10093` — stay BY DESIGN: they test EnvFilter pass-through behavior that an unfiltered process-global capture cannot express; Task 3 records them as deliberate exceptions). Task 3 enumerates every site and every collision; none may be skipped.

## The Title-Precedence Resolution (authoritative for Tasks 1–2)

**Canonical display-title precedence, resolved (as the code actually composes it — verified against `src/lib/tab-title.ts` and `src/store/sessionTitleMirror.ts` at the base):**

1. **Tab display title** (`getTabDisplayTitle`, `src/lib/tab-title.ts`):
   1. **Explicit title** — `tab.title` with `titleSetByUser: true`: a TabBar inline rename, a `PATCH /api/tabs/:id`, or an explicit non-empty `name` on a REST/MCP tab create (all three `ui.command{tab.create}` emitters put only caller-provided names in `payload.title`: `terminal_tabs.rs:300` `create_content_tab`, `terminal_tabs.rs:3356` `create_terminal_tab`, `lib.rs:4709` `broadcast_tab_create`). An empty explicit title falls through.
   2. **Single-pane override** — the sole leaf pane's stored non-derived pane title, *whatever composed it* (see the pane ladder below — this is why a registry "Codex CLI" or a mirrored session title can show as the tab title).
   3. **Stored non-derived `tab.title`** set without the user flag (create-time mode labels like "Amplifier" that reached `tab.title`).
   4. **cwd-leaf derived titles** — `deriveTabName`/`derivePaneTitle` fallbacks.
2. **Pane title**, composed per pane kind (NOT a blanket mirror-over-auto rule):
   - A **user-set pane title** (`paneTitleSetByUser`) is never mirrored over.
   - **Terminal panes**: a **cached terminal-level title outranks the session-title mirror** — `collectSessionTitleTargets` (`sessionTitleMirror.ts:111`) skips any terminal pane whose terminalId has a cached title, so registry auto-titles ("Codex CLI"), `PATCH /api/terminals/:id` renames, and inventory/live folds own that pane; the mirror only titles terminal panes with NO cached terminal title (unattached/exited/not-yet-reattached panes). This is load-bearing for deploy-tab-diff: post-restart the "Codex CLI" inventory fold owns the pane, and only the tab-level rung 1 (explicit title) keeps the display `work`.
   - **Fresh-agent panes**: no registry pipeline — the session-title mirror is their runtime title source (always eligible).
   - Fallback: the `initLayout`-derived cwd-leaf.

**Plus (AMENDED by D5 — the server half below was REVERTED at delta review round 1; the client display-fallback half stands, composed in the fallback row's name order): fabricated live-terminal session rows carry NO title, and the client keeps their label meaningful at display time.** Two halves:
- **Server:** `build_live_terminal_session_item` (`crates/freshell-server/src/session_directory.rs:1265`) must stop fabricating `title: Some(provider_display_name(...))`; the mirror's existing `if (!session.title) continue` guard (`sessionTitleMirror.ts:44`) then skips them naturally. A provider label is not a session name.
- **Client:** the sidebar row's main label is NOT "subtitle || projectPath" — it is `sidebarSelectors.ts:264`'s `session.title || session.sessionId.slice(0, 8)`, rendered at `Sidebar.tsx:1175` (`:1199` is the tooltip's project line). With the server half alone, a fabricated `terminal:<id>` row would read literally "terminal" and a bound-but-unindexed row would read as an 8-char id prefix. `buildSessionItems`' server-row mapping therefore gains a provider-label rung, stated precisely: a title-less row whose `isRunning && runningTerminalId` are set (the wire shape EVERY `build_live_terminal_session_item` row carries, both variants — `terminal:<id>` sessionIds and bound-but-unindexed session ids) falls back to `getProviderLabel(provider)` (the same helper as the client-side fallback row's LAST rung at `sidebarSelectors.ts:511` — pane title, then terminal title, then the provider label; an honest cosmetic consequence: `getProviderLabel` without extension data renders `Opencode`/`Codex`/`Claude` where the server's deleted `provider_display_name` fabricated `OpenCode`/`Codex CLI`/`Claude CLI`), while every other title-less row (real transcript rows, running or not) keeps today's `sessionId.slice(0, 8)` fallback. `hasTitle` stays `!!session.title` — the provider label is a display fallback, not a session title, so a later title-carrying fetch or the `pushFallbackItem` merge still overrides it. Accepted residual: a REAL running session whose transcript has not yet yielded a title also takes the provider-label rung (indistinguishable at the wire level from a fabricated row without new protocol machinery; strictly more meaningful than the id prefix it replaces); HistoryView's main label keeps the id-prefix fallback with its existing provider badge (`HistoryView.tsx:481`) — the cited regression is the sidebar row, which has no badge.

**Reconciliation with the rename-scope contract:** the contract governs WRITE scoping (who owns which rename surface); this resolution governs DISPLAY composition (which stored label a tab renders when several exist). No hard rule is violated: rule 5's "pane/tab labels can no longer mint a user-rung [session] override" is untouched (the fold sets a TAB-local `titleSetByUser`, never a session override); rule 1's "no sessionRef fallback write" is untouched (nothing durable is written). The existing guard in `openSessionTab` (`tabsSlice.ts:1141`, `!existingTab.titleSetByUser`) already establishes the product semantic that explicit titles beat session-title sync — Task 1 extends "explicit" to creator-provided names. The contract doc gains a short display-precedence subsection (Task 1 Step 4e) recording the ladders above EXACTLY as the code composes them (including the pane-kind split — a blanket "mirror over auto-labels" rule would be false for terminal panes and must not be written into the contract), the fabricated-row rule with its client display fallback, and one scope-table update: the Tab label row's "Written by" column gains the create-time explicit name (`name` on a REST/MCP tab create), since Task 1 makes that a tab-label write.

**Intended consequences of setting `titleSetByUser` on every named REST/MCP tab (analyzed, accepted):**
1. `shouldKeepClosedTab` (`src/lib/tab-registry-snapshot.ts:167-176`, called from the removeTab flow at `src/store/tabsSlice.ts:785-789`) keys on `titleSetByUser`, so every closed named agent tab now keeps a closed-tab registry record (recoverable from the closed-tab list). Intended: an explicitly named tab is user-meaningful and worth a keep-record, same as an inline rename today.
2. OSC terminal-title updates (`TerminalView.tsx` ~:2719), the `terminal.title.updated` fold (~:4965), and the `(exit N)` suffix (~:4946) all gate on `!tab.titleSetByUser`, so a named tab's TAB title freezes at the creator name (an exited named tab shows `work`, not `work (exit 3)`). Intended: that is precisely rung 1 — auto/OSC titles no longer overwrite an explicit name. Pane titles are independently guarded (`paneTitleSetByUser`) and keep flowing.
Task 1 Step 7 verifies both through the whole client unit tree (`tabsPersistence`, `tab-registry-snapshot`, `tabsSlice` suites live there).

**Derived final expectation per spec (all four keep their original assertions):**

- **deploy-tab-diff-rust :207** — REST `name: 'work'` is rung 1 → the tabs-sync `tabName` is `"work"` at every capture (the pre-restart session-title mirror and post-restart "Codex CLI" inventory fold no longer win the display) → `verify` prints `tab=work`. The original assertion passes as written; it becomes the e2e proof that an explicit REST name survives a restart as the canonical title. Task 2 adds the identity hardening `toContain(codex.data.tabId)`.
- **remote-tab-linkage-rust :213** — `TAB_NAME` ('remote-linkage-tab') is rung 1 → visible in the strip immediately and stably (the mirror still titles the PANE with the session name — pane-level canonical — but the tab display shows the creator name). **:310** — `tabTitleAfterClick` is read dynamically from raw Redux after the dedupe click; under the new precedence the click's sync is blocked by the `titleSetByUser` guard, so it reads `'remote-linkage-tab'`, and the post-restart strip shows the same (rung 1 persisted through `freshell.layout.v3`). Passes as written; the stale NOTE comment is corrected and a preservation pin added (Task 2).
- **rest-tab-persistence :142/:176** — 'amplifier-poison-tab' is rung 1 pre-reload (the racy create-time "Amplifier" fold can no longer flip the display) and post-reload: `stripTabVolatileFields` (`src/store/persistMiddleware.ts:82`) spreads `...tab`, so `titleSetByUser` lands in the localStorage `freshell.layout.v3.<window-id>` payload, and the rehydrate path admits it — `persistedState.ts:53`'s `zTab` schema carries `titleSetByUser: z.boolean().optional()` (NOT `tabsSlice.ts:788`, which is the closed-tab keep policy). Passes as written.
- **sidebar-opencode-rail :326-328** — **AMENDED (execution-evidenced, see Decision Notes):** the original diagnosis (session-title mirror over a fabricated row) was wrong for this shape — the fabricated `is_subagent` row is dropped server-side (`session_directory.rs:1723`), so the mirror never fires; the real banner writer is the terminal-directory title replay (`e78c25c8c`): registry auto-title `"OpenCode"` (`terminal.rs:5218` `mode_label`) → `terminals.changed` → `recordTerminalTitleForReplay` (`terminalDirectoryThunks.ts:198`) → `initLayout` replay. Per the pane ladder this plan itself establishes (registry auto-titles own terminal panes — the same rule that makes deploy-tab-diff print `tab=Codex CLI`), the spec's cwd-leaf expectation rotted when `e78c25c8c` landed. **Resolution: reshape the spec** — assert `Pane: OpenCode` (the pane's canonical registry auto-title) with a comment documenting the ladder + writer path; keep the rail-flow assertions intact. ~~The Task 1 fabricated-row fix still stands on its own merits (sidebar provider-label honesty; unit-proven; contract-documented) but is NOT what makes this spec green.~~ (superseded by D5: the server half is reverted; the client label fallback stands in the fallback row's name order.)

**Impacted-by-derivation (not the campaign four):** any spec that REST/MCP-creates a NAMED tab and asserts strip text. Verified greps: `git-badges-rust.spec.ts:190` asserts the REST name `'badge-rest-tab'` (T1 makes it strictly more stable); `fresh-agent-rest-resume-rust.spec.ts:378` already carries `titleSetByUser: true` as a field in its tabs-sync record fixture and `tabs-client-retire.spec.ts:73` already dispatches it via an `addTab` payload (consistent conventions — note :378 is a fixture field, not a dispatch); no spec asserts a session title replacing a REST name in the strip. Task 2 Step 5 runs the named-create family focused; the full local e2e lane added to Task 6 is the complete net.

---

### Task 1: Title-precedence product fix — creator-named tabs keep their names; fabricated live-terminal rows carry no title

Standing ledger item (e2e four, no kata). This is the product change that turns the four e2e specs red→green.

**Files:**
- Modify: `src/lib/ui-commands.ts:80-90` (the `tab.create` fold)
- Modify: `src/store/selectors/sidebarSelectors.ts:264` (provider-label rung for title-less running live-terminal rows)
- Modify: `crates/freshell-server/src/session_directory.rs:1282` (`title: Some(...)` → `title: None`)
- Delete: `crates/freshell-server/src/session_directory.rs:1226-1234` (`provider_display_name` + its doc comment) AND its `mod join_tests` parity test (`:1454-1462`) — after the fabrication is removed, the fn's only remaining consumer is its own unit test
- Modify: `crates/freshell-server/src/session_directory.rs:1514,:1558` (the two fabricated-item unit tests) AND `:3621-3631` (`persisted_identity_collision_keeps_a_matching_live_terminal_as_a_safe_placeholder` — asserts the SAME fabricated row's `"Claude CLI"` title at `:3625`; THREE fabricated-title assertions change, not two)
- Test: `test/unit/client/ui-commands.test.ts` (fold regression, red-first)
- Test: `test/unit/client/store/selectors/sidebarSelectors.test.ts` (provider-label fallback, red-first)
- Test: `test/unit/client/store/sessionTitleMirror.test.ts` (fabricated title-less row pin)
- Modify: `docs/development/rename-scope-contract.md` (display-precedence subsection + Tab-label "Written by" row)
- **AMENDED (D5, delta review round 1)** the server-side fabricated-title entries in THIS task's Files list are REVERTED: `crates/freshell-server/src/session_directory.rs` is byte-identical to dbbfd0752 again (`provider_display_name` + its parity test + `title: Some(...)` + the three base unit assertions restored), the sessionTitleMirror fabricated-row pin (Step 4d) is deleted, and the contract-doc fabricated-row paragraph (Step 4e) is replaced by the surviving title-less-running-row display rule. The client entries (ui-commands fold; sidebarSelectors label rung — now in the fallback row's name order per delta review Minor 1) stand.

**Interfaces:**
- Consumes: `addTab` payload field `titleSetByUser?: boolean` (`src/store/tabsSlice.ts:293`, reducer stores it at `:330`); `getTabDisplayTitle`'s `titleSetByUser` branch (`src/lib/tab-title.ts:28-30`); the mirror's `if (!session.title) continue` guard (`src/store/sessionTitleMirror.ts:44`); `getProviderLabel` (`src/lib/coding-cli-utils.ts:33`, already imported by `sidebarSelectors.ts:8`).
- Produces: the contract that every `ui.command{tab.create}` broadcast carrying a non-empty `payload.title` (only ever caller-provided: verified across all three emitters) folds into Redux with `titleSetByUser: true`; that `DirItem`s synthesized by `build_live_terminal_session_item` carry `title: None` (`provider_display_name` DELETED together with its `mod join_tests` parity test — after the fabrication is removed its only consumer is its own unit test, which then protects no shipped behavior; deleting both is cleaner than `#[cfg(test)]`-gating, and a now-unused module-level fn would also fail clippy `-D warnings` and the pre-push gate); and that the sidebar row's main label for a title-less running live-terminal row is `getProviderLabel(provider)`. Task 2 and the four e2e specs depend on all three.

- [x] **Step 1: Baseline red confirmation at dbbfd0752 (BEFORE any fix)**

Run each focused ONCE from this worktree (the prebuild guard exempts linked worktrees; each boots its own ephemeral Rust e2e server — production on 3001 is untouched):

```bash
npm run test:e2e:local -- test/e2e-browser/specs/sidebar-opencode-rail.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/rest-tab-persistence.spec.ts
```

Expected: each file reports **1 failed / rest passed** with EXACTLY the diagnosed shapes:
- sidebar-opencode-rail: `:143` test fails at `:327` — `getByRole('banner', { name: 'Pane: railsubagentpane' })` not found; failure snapshot shows `Pane: OpenCode` (**PR #799 re-verification point**: the banner element must still exist with that aria-label shape; if the failure differs — banner gone, renamed, or a different clobber — STOP, record in run-state, and re-diagnose before continuing).
- deploy-tab-diff-rust: `:81` test fails at `:207` — expected substring `"tab=work"`, received row `tab=Codex CLI (<deviceId>:<tabId>)`.
- remote-tab-linkage-rust: `:107` test fails at `:213` — strip text `remote-linkage-tab` never appears; snapshot shows `remote-tab-linkage seeded session`.
- rest-tab-persistence: `:117` test fails at `:176` (or `:142`) — strip shows `Amplifier`, never `amplifier-poison-tab`.

Record each failure output path under the logs dir (`reports/`) in run-state. These runs are the campaign's red receipts.

- [x] **Step 2: Write the failing unit tests (client fold + sidebar label)**

Add to `test/unit/client/ui-commands.test.ts` (same idiom as the existing `tab.create` tests — actions-array dispatch spy):

```ts
  it('tab.create folds a non-empty caller-provided title as a user-set title; unnamed creates stay unset', () => {
    const actions: any[] = []
    const dispatch = (action: any) => { actions.push(action); return action }

    // Named create (REST/MCP `name`) — the title is an explicit creator title
    // and must outrank pane-title overrides (mirror / registry auto-titles)
    // in getTabDisplayTitle, before AND after a reload or restart.
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't-named', title: 'work' } }, dispatch)
    expect(actions[0].type).toBe('tabs/addTab')
    expect(actions[0].payload.titleSetByUser).toBe(true)

    // Unnamed create — no caller title; derived/mirror behavior unchanged.
    const actions2: any[] = []
    const dispatch2 = (action: any) => { actions2.push(action); return action }
    handleUiCommand({ type: 'ui.command', command: 'tab.create', payload: { id: 't-unnamed', title: null } }, dispatch2)
    expect(actions2[0].payload.titleSetByUser).toBeUndefined()
  })
```

Add to `test/unit/client/store/selectors/sidebarSelectors.test.ts` (inside the existing `describe('buildSessionItems', …)` block, reusing its `emptyTabs`/`emptyPanes`/`emptyTerminals`/`emptyActivity` consts at :125-128; both fabricated-row variants plus the unchanged real-row fallback):

```ts
  it('keeps a provider label on title-less running live-terminal rows instead of an id prefix', () => {
    const projects = [{
      projectPath: '/repo',
      sessions: [
        // Fabricated variant A: terminal:<id> sessionId (today would render
        // literally "terminal" once the server stops fabricating titles).
        { provider: 'codex', sessionId: 'terminal:term-9', projectPath: '/repo', lastActivityAt: 1_000, isRunning: true, runningTerminalId: 'term-9' },
        // Fabricated variant B: bound-but-unindexed session id (the
        // sidebar-opencode-rail child2 shape).
        { provider: 'opencode', sessionId: 'ses-child2', projectPath: '/repo', lastActivityAt: 1_000, isRunning: true, runningTerminalId: 'term-c2' },
        // Real title-less row, NOT running: keeps today's id-prefix fallback.
        { provider: 'claude', sessionId: 'claude-real-no-title', projectPath: '/repo', lastActivityAt: 900 },
      ] as any,
    }]
    const items = buildSessionItems(projects, emptyTabs, emptyPanes, emptyTerminals, emptyActivity)
    expect(items.find((i) => i.sessionId === 'terminal:term-9')?.title).toBe('Codex')
    expect(items.find((i) => i.sessionId === 'ses-child2')?.title).toBe('Opencode')
    expect(items.find((i) => i.sessionId === 'claude-real-no-title')?.title).toBe('claude-r')
    // Display fallback only — the row still reports no session title.
    expect(items.find((i) => i.sessionId === 'terminal:term-9')?.hasTitle).toBe(false)
  })
```

- [x] **Step 3: Run them and verify the intended failures**

Run: `npm run test:vitest -- run test/unit/client/ui-commands.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts`

Expected: FAIL both — the fold test fails because the fold never sets `titleSetByUser` (first expectation receives `undefined`); the selector test fails because the title-less running rows render `'terminal'`/`'ses-chil'` (the `sessionId.slice(0, 8)` fallback). The trailing unnamed-create and real-row expectations are the pins that must hold after the change.

- [x] **Step 4: Minimal production implementation (client + server + contract doc)**

4a. `src/lib/ui-commands.ts` — in `case 'tab.create'`, add one field to the `addTab` payload (after `title:`):

```ts
      dispatch(addTab({
        id: msg.payload.id,
        title: msg.payload.title,
        // Explicit creator-provided name (REST/MCP `name`): an explicit title
        // outranks mirrored session titles and registry auto-titles in
        // getTabDisplayTitle (rename-scope-contract display precedence).
        titleSetByUser: msg.payload.title ? true : undefined,
        mode: msg.payload.mode,
```

4b. Red-first for the server side — update the THREE fabricated-title assertions in `crates/freshell-server/src/session_directory.rs` to assert the NEW contract (they currently assert the fabrication; `freshell-server` has NO library target — `Cargo.toml` declares only `[[bin]] freshell-server` — so the selector is `--bin freshell-server`, verified: `--lib` fails with "no library targets found in package `freshell-server`"):

In `build_live_terminal_session_item_with_session_id_is_not_live_terminal_only` (~:1515):
```rust
        // A fabricated live-terminal row is a placeholder, not a session:
        // its "title" was the generic provider label, which the session-title
        // mirror then folded over real pane titles. Fabricated rows carry NO
        // title (rename-scope-contract display precedence).
        assert_eq!(item.title, None);
```
In `build_live_terminal_session_item_without_session_id_is_live_terminal_only` (~:1562): replace `assert_eq!(item.title.as_deref(), Some("Codex CLI"));` with `assert_eq!(item.title, None);`.
In `persisted_identity_collision_keeps_a_matching_live_terminal_as_a_safe_placeholder` (~:3621-3631): the joined safe-placeholder row is built by the same `build_live_terminal_session_item` (its `projectPath` is the identity's cwd `/live-terminal`), so its `&& item["title"] == "Claude CLI"` at `:3625` breaks too — replace that conjunct with `&& item.get("title").is_none()` (`to_value` omits absent titles; keep the surrounding `provider`/`sessionId`/`projectPath`/`isRunning`/`runningTerminalId` conjuncts and the `liveTerminalOnly != true` pin below unchanged).

Run: `cargo test -p freshell-server --locked --bin freshell-server session_directory`
Expected: FAIL — exactly the three updated assertions fail (current code fabricates `Some("OpenCode")` / `Some("Codex CLI")` / `"Claude CLI"`).

4c. Apply the one-line production change in `build_live_terminal_session_item` (`session_directory.rs:1282`):

```rust
        // A synthesized live-terminal item has no session name. Fabricating
        // provider_display_name here made the session-title mirror clobber
        // real pane titles with a generic label ("OpenCode") for every
        // unlisted-session resume (e.g. subagent children, root-filtered).
        // Title-less rows are skipped by the mirror (`if (!session.title)
        // continue`); the client keeps the row's label meaningful at display
        // time (sidebarSelectors provider-label rung for title-less running
        // live-terminal rows; HistoryView keeps its id-prefix + provider
        // badge).
        title: None,
```

`provider_display_name` (`session_directory.rs:1227`) now has NO non-test caller (its only one was this line) — its only remaining consumer is its own parity test, `join_tests::provider_display_name_matches_known_providers_and_falls_back_to_raw` (`:1457-1461`, inside `mod join_tests` at `:1349` — NOT `mod tests`, which starts at `:1939`). A test whose only subject is a function no shipped code calls protects no shipped behavior (repo rule) — DELETE the fn (`:1226-1234`, with its doc comment) and the test (`:1454-1462`, with its `// ── provider_display_name ──` section marker) rather than `#[cfg(test)]`-gating it. (Gating would also keep a module-level fn that is dead code in the non-test build — failing `cargo clippy --all-targets -- -D warnings`, Task 6 Step 1, and the pre-push gate; deletion makes that failure impossible by construction.)

Run: `cargo test -p freshell-server --locked --bin freshell-server session_directory`
Expected: PASS (all session_directory tests, including the three updated ones and the join tests, which assert no title).

4c-2. Apply the client display-fallback production change in `buildSessionItems` (`src/store/selectors/sidebarSelectors.ts:264`) — the sidebar row's main label, rendered at `Sidebar.tsx:1175` (NOT the `:1199` tooltip, whose `subtitle || projectPath || sessionLabel` line is untouched):

```ts
        // A title-less RUNNING live-terminal row (a server-fabricated
        // placeholder — build_live_terminal_session_item, either variant:
        // `terminal:<id>` sessionIds or a bound-but-unindexed session id)
        // keeps its provider label instead of degrading to "terminal" or an
        // id prefix. Every fabricated row carries isRunning +
        // runningTerminalId on the wire; real title-less rows keep today's
        // id-prefix fallback. Same helper as the client-side fallback row's
        // LAST rung (:511 composes the pane title, then the terminal title,
        // then getProviderLabel), so the label is stable when the server row
        // replaces the fallback row — with one honest cosmetic change:
        // getProviderLabel without extension data renders
        // Opencode/Codex/Claude, where the server's now-deleted fabricated
        // titles read OpenCode/Codex CLI/Claude CLI (provider_display_name).
        // hasTitle stays !!session.title — this is a display fallback, not a
        // session title; later title-carrying fetches still override it.
        title: session.title
          || ((session.isRunning && session.runningTerminalId)
            ? getProviderLabel(provider)
            : session.sessionId.slice(0, 8)),
```

(`getProviderLabel` is already imported at `sidebarSelectors.ts:8`; no other line of the item mapping changes.)

4d. Add the fabricated-row pin to `test/unit/client/store/sessionTitleMirror.test.ts` (guards the client-side half of the contract the server fix relies on; it fails if anyone removes the `!session.title` skip). The file's existing `buildStore()` and `landSessionRow()` helpers plus the imported `addTab`/`initLayout` provide everything needed — this is the e2e sidebar-opencode-rail shape in miniature (terminal pane bound by sessionRef to a session whose only "row" is a title-less fabricated placeholder):

```ts
  it('never folds a fabricated live-terminal row (title-less) over a session-bound terminal pane — a provider label is not a session name', () => {
    const store = buildStore()
    store.dispatch(addTab({ id: 'tab-z', title: 'OpenCode' }))
    store.dispatch(initLayout({
      tabId: 'tab-z',
      paneId: 'pane-z',
      content: {
        kind: 'terminal',
        mode: 'opencode',
        createRequestId: 'req-rail',
        status: 'running',
        terminalId: 'term-rail-child2',
        sessionRef: { provider: 'opencode', sessionId: 'ses-child2' },
        initialCwd: '/tmp/e2e/work/railsubagentpane',
      },
    }))
    const derived = store.getState().panes.paneTitles['tab-z']['pane-z'] // initLayout-derived cwd leaf ('railsubagentpane')
    landSessionRow(store, { surface: 'sidebar', sessionId: 'ses-child2', provider: 'opencode' }) // no title — fabricated placeholder shape
    expect(store.getState().panes.paneTitles['tab-z']?.['pane-z']).toBe(derived)
  })
```

Run: `npm run test:vitest -- run test/unit/client/store/sessionTitleMirror.test.ts`
Expected: PASS (pins existing guard behavior; it is the companion to 4c, not red-first — its red would only fire if the guard is later removed).

4e. Update `docs/development/rename-scope-contract.md` — TWO edits, both recording ACTUAL behavior (do not write an inaccurate blanket rule into the governing contract):
   - Append a short "Display precedence (composition of stored labels)" subsection recording the Resolution's ladders EXACTLY as the code composes them: the tab ladder (explicit `titleSetByUser` title → single-pane override → stored non-derived `tab.title` → derived cwd-leaf), the PANE-KIND-SPLIT rule (terminal panes: a cached terminal-level title outranks the session-title mirror — `sessionTitleMirror.ts:111`'s cache-aware skip; fresh-agent panes: the mirror is the runtime title source), the fabricated-row rule (server placeholder rows carry no title; the client's sidebar label for a title-less running live-terminal row falls back to the provider label), and a note that the subsection governs display composition while the hard rules govern write scoping and the "Persists" column is untouched. The tab ladder is enforced by `getTabDisplayTitle` (`src/lib/tab-title.ts`); the pane split by the terminal-title cache + `sessionTitleMirrorMiddleware` (`src/store/sessionTitleMirror.ts`) — name both mechanisms, not the mirror alone.
   - Scope-table update: the Tab label row's "Written by" column gains the create-time explicit name — `name` on a REST/MCP tab create (agent API / MCP) — since Task 1 makes that a tab-label write in the same rung as TabBar inline rename / `PATCH /api/tabs/:id`. No other row changes.

- [x] **Step 5: Run the focused tests green**

```bash
npm run test:vitest -- run test/unit/client/ui-commands.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/sessionTitleMirror.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/lib/terminal-inventory-titles.test.ts
cargo test -p freshell-server --locked --bin freshell-server session_directory
```

Expected: PASS on all (the Step-3 reds and the 4b reds are now green).

- [x] **Step 6: Refactor while green**

Small but real: confirm `provider_display_name`'s deletion left NOTHING behind (`rg -n "provider_display_name" crates/freshell-server/src/` — ZERO hits: the fn, its doc comment, and the `join_tests` parity test are all gone), and confirm no other `tab.create` consumer in the client reads `titleSetByUser` from the payload (grep `titleSetByUser` in `src/lib/` — the fold is the only writer of the flag outside explicit renames). Confirm `hasTitle` semantics are unchanged in `buildSessionItems` (still `!!session.title`; the provider-label rung is display-only).

- [x] **Step 7: Impacted-test verification**

Impacted set: everything that renders or persists tab titles, everything that consumes fabricated session rows, and both analyzed `titleSetByUser` side effects:
- Unit: `npm run test:vitest -- run test/unit/client/` (the whole client unit tree is fast; it covers tabsSlice/persistMiddleware/persistedState/tab-registry-snapshot/TabBar/HistoryView/Sidebar selectors that touch titles and fabricated rows — including the `shouldKeepClosedTab` keep-policy suites for named agent tabs and the OSC/`(exit N)` title-freeze behavior, both analyzed as intended consequences in the Resolution).
- Rust: `cargo test -p freshell-server --locked --bin freshell-server` (the whole server bin unit suite — session_directory feeds /api/sessions consumers).
- Fabricated-title consumers audit (grep-verified baseline, confirm and record): the sidebar row's main label is `sidebarSelectors.ts:264` rendered at `Sidebar.tsx:1175` — now the provider-label rung (4c-2); `Sidebar.tsx:1199` is the tooltip's project line and is untouched. `src/components/HistoryView.tsx:479-483` keeps `session.title || sessionId.slice(0, 8)` for its main label WITH its existing `getProviderLabel` badge right beside it — accepted residual (the cited regression is the sidebar row, which has no badge). Unit fixtures in `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` exercise the client-side fallback rows (`buildSessionItems([], …, terminals, …)`), which already use `getProviderLabel` — unaffected by the server change. No e2e spec asserts a provider label ON a live-terminal fabricated row (verified by grep over `test/e2e-browser/specs/`; re-grep `OpenCode`/`Codex CLI`/`Claude CLI` sidebar-row assertions to confirm — the current hits are pickers, pane headers, and banners).
- The four e2e specs re-run green in Task 2 (do not double-run here).

Run: `npm run test:vitest -- run test/unit/client/ && cargo test -p freshell-server --locked --bin freshell-server`

Expected: PASS.

- [x] **Step 8: Commit**

```bash
git add src/lib/ui-commands.ts src/store/selectors/sidebarSelectors.ts crates/freshell-server/src/session_directory.rs test/unit/client/ui-commands.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/sessionTitleMirror.test.ts docs/development/rename-scope-contract.md
git commit -m "fix(titles): explicit creator tab names outrank mirrored/auto pane titles; fabricated live-terminal rows carry no title"
```

### Task 2: The four e2e specs — derived expectations applied and verified red→green

Standing ledger items (no kata). The four specs keep their original assertions (they encode the restored contract); this task applies the two derived spec-side updates, hardens identity, and proves the family green.

**Files:**
- Modify: `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts:255-267` (stale NOTE comment + creator-title preservation pin)
- Modify: `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts:207` (add tabKey identity hardening)
- **AMENDED** Modify: `test/e2e-browser/specs/sidebar-opencode-rail.spec.ts:326-328` — reshape the banner assertion from the rotted cwd-leaf expectation to the pane's canonical registry auto-title: assert `Pane: OpenCode` (per the amended derived-expectation bullet in the Title-Precedence Resolution; writer path `terminal.rs:5218` → `terminalDirectoryThunks.ts:198` → `initLayout` replay; add a comment documenting the ladder + writer), keep all rail-flow assertions unchanged.
- No change: `test/e2e-browser/specs/rest-tab-persistence.spec.ts` — the regression test as written.

**Interfaces:**
- Consumes: Task 1's precedence contract (the client fold must be committed; ~~the server fabricated-row half~~ — AMENDED by D5: the server half was REVERTED at delta round 1 and is no longer a dependency; all four families were re-verified green focused after the revert).
- Produces: green focused runs for all four families (the campaign's e2e evidence), plus the two spec updates that pin the new contract.

- [x] **Step 1: remote-tab-linkage — correct the stale NOTE and pin creator-title preservation**

At `:255-267` the NOTE claims the dedupe click "SYNCS the real session title into the focused tab … so the tab is now titled with the seeded session's name, not the REST `name`". Under the restored precedence the click does NOT retitle an explicitly-named tab: the already-open click returns early at `Sidebar.tsx:486-489` and its `!existingTab.titleSetByUser` check (`:487`) yields to the creator title (`openSessionTab`'s `tabsSlice.ts:1141` guard is the same semantic on the not-already-open path — the click never reaches it). Replace the NOTE block and add a preservation assertion after the `:253` tab-count check:

```ts
        // NOTE (display precedence, docs/development/rename-scope-contract.md):
        // the dedupe click finds and FOCUSES the existing tab; its historical
        // session-title sync yields to the tab's explicit creator title (the
        // already-open click returns early at Sidebar.tsx:486-489; the
        // `!existingTab.titleSetByUser` check at :487 blocks the sync — same
        // semantic as openSessionTab's tabsSlice.ts:1141 guard, which the
        // click never reaches), so the REST `name` survives the click. The
        // pane title still mirrors the session title (pane-scope canonical);
        // only the tab display keeps the name.
        const tabTitleAfterClick: string = await expect.poll(async () => {
          const s = await harness.getState()
          return s?.tabs?.tabs?.find((t: any) => t.id === restTabId)?.title ?? null
        }, { timeout: 10_000 }).not.toBeNull().then(async () => {
          const s = await harness.getState()
          return s.tabs.tabs.find((t: any) => t.id === restTabId).title
        })
        expect(tabTitleAfterClick).toBe(TAB_NAME)
```

(The existing `:310` post-restart assertion is unchanged and now resolves against `TAB_NAME` through the persisted `titleSetByUser`.)

- [x] **Step 2: deploy-tab-diff — add the tabKey identity hardening**

At `:207`, keep the contract assertion and add the stable-identity belt (the MISSING row prints `tab=<tabName> (<deviceId>:<tabId>)`; `codex.data.tabId` is already in scope from the `:154` create):

```ts
      expect(bad.out).toContain('tab=work')                // names the diverged tab (explicit REST name survives the restart — display precedence)
      expect(bad.out).toContain(codex.data.tabId)          // and names its stable tabKey identity (deviceId:tabId)
```

- [x] **Step 3: Run the four specs focused — green**

  Complete. deploy-tab-diff-rust, remote-tab-linkage-rust, and
  rest-tab-persistence all PASS with their original assertions plus the
  Step-1/2 hardening (T1/T2 implementer; receipts
  `reports/t2-green-{deploy-tab-diff-rust,remote-tab-linkage-rust,rest-tab-persistence}.log`).
  sidebar-opencode-rail initially remained red at :327-328 with the same
  `Pane: OpenCode` symptom — a SECOND writer the investigation's model
  missed (terminal create-time registry auto-title 'OpenCode' →
  terminals.changed → terminal-directory fetch → recordTerminalTitleForReplay
  → initLayout replay; see `<git-dir>/sixpack-t1t2-report.md` and probe
  receipts `reports/t1-probe-rail-title-writer*.log`). Fabricated-row mirror
  path confirmed dead (the row is also server-side is_subagent-filtered from
  the client's pages). STOPPED per the plan-contradiction rule — RESOLVED by
  the plan owner: registry-title ownership is the ladder rule (this plan's
  own Title-Precedence Resolution; the same rule deploy-tab-diff encodes),
  the cwd-leaf expectation rotted with `e78c25c8c`, and the spec is reshaped
  per the amended Files list (D3): assert `Pane: OpenCode`, ladder + writer
  path documented in the spec, rail-flow assertions unchanged. Fresh focused
  run after the reshape: PASS — 1 passed (receipt
  `reports/t2-rail-reshape.log`). All four campaign families green.

```bash
npm run test:e2e:local -- test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/rest-tab-persistence.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/sidebar-opencode-rail.spec.ts
```

Expected: **PASS** — all tests in all four files green, first attempt, including the previously-failing `:81`/`:107`/`:117`/`:143` tests. Record the green receipts in run-state.

- [x] **Step 4: Refactor while green**

None — two comment/assert edits only.

- [x] **Step 5: Impacted-test verification (named-create family)**

  Result: git-badges-rust, tabs-client-retire, mcp-focus-neutrality-rust,
  createrequestid-stabilization-rust all PASS. fresh-agent-rest-resume-rust
  fails :401 (`409 SESSION_RESERVED` on the durable-id resume after
  restartAbrupt) — verified IDENTICAL at base dbbfd0752 (base-run receipt
  `reports/t2-step5-fresh-agent-rest-resume-base-run.log`): a pre-existing
  standing failure on main, disjoint from the campaign's six, recorded for
  Task 6's non-campaign base-comparison triage.

The Task 1 change affects every spec that REST/MCP-creates a NAMED tab and asserts strip/DOM text. Run the known named-create family focused:

```bash
npm run test:e2e:local -- test/e2e-browser/specs/git-badges-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/tabs-client-retire.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts
```

Expected: PASS (grep-verified: none asserts a session title displacing a REST name in the strip; `git-badges-rust:190` asserts the REST name itself and becomes strictly more stable). The full local e2e lane in Task 6 is the complete net.

- [x] **Step 6: Commit**

```bash
git add test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts
git commit -m "test(e2e): pin creator-title precedence in remote-tab-linkage; harden deploy-tab-diff divergence identity"
```

### Task 3: Kata 59nb — migrate the freshell-ws lib capture to the e08g OnceLock pattern; worst-case-order proof; consumer-filter audit

Closes **kata 59nb**. Root cause (proven): tracing-core caches each callsite's Interest process-wide on first registration (`Rebuilder::JustOne` consults the registering thread's default — `NoSubscriber` → `Interest::never`); an unguarded sibling test executing the shared `tracing::error!` site after our `capture()` but before our emission poisons it, and the `event!` macro short-circuits before dispatch — capture sees `got: []`. A thread-local `set_default` capture cannot defend a presence assertion against this; a process-global capture sees every thread's events, so whoever registers first, the interest is right.

**Files:**
- Modify: `crates/freshell-ws/src/invariants.rs:363-441` (`capture()` → OnceLock global) and its internal `mod tests` consumers
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs:8837-8974` (the guarded tests' filters + the worst-case-order proof; ALSO narrow the `{events:?}` failure dumps at `:8861,:8899` to the filtered hits) AND `:2919-2997,:3100-3200` (the WHOLE `mod lock_log_capture` — `CapturedEvent`, `CapVisitor`, `LogCapture`, `lock_failure_capture` — plus its one consumer: the consumer migrates to the same OnceLock/filter pattern, after which every item in the module is dead code and the entire module is deleted; deleting only the function would leave `CapturedEvent`/`CapVisitor`/`LogCapture` caller-less and failing `clippy -D warnings`)
- Modify: `crates/freshell-ws/src/tabs_persist_tests.rs:1217,1270,1321,1376` (unique-field filters + unique ids) AND `:1228,:1313,:1367,:1415` (narrow the `{events:?}` failure dumps to the filtered hits)
- Modify: `crates/freshell-ws/src/claude_signal.rs:440,598` (guard-drop + path filter)
- Modify: `crates/freshell-ws/src/opencode_signal.rs:758,816,832` (path/terminal_id filters + per-test unique ids)
- Modify: `crates/freshell-ws/src/create_dedupe.rs:949-977` (the DIAG-01 waiter test's inline thread-local capture — same OnceLock/filter migration)

**Interfaces:**
- Consumes: the e08g precedent shape at `crates/freshell-ws/tests/pane_reconcile_freshagent.rs:838-858` (OnceLock + `set_global_default` + loud `.expect` on install); `CapturedEvent { target, message, fields }` (unchanged).
- Produces: `capture() -> Arc<Mutex<Vec<CapturedEvent>>>` — one process-global subscriber per lib-test binary, installed once (first call), never torn down; every consumer filters by a per-test-unique field — INCLUDING the two pre-existing thread-local `set_default` captures this task folds in (`pane_ledger_tests.rs`'s `lock_log_capture::lock_failure_capture` and `create_dedupe.rs`'s DIAG-01 inline capture), so after this task no thread-local capture-util capture remains anywhere in the lib-test binary. THREE deliberate exceptions stay, recorded for the census: the scoped `tracing::subscriber::with_default` FILTER-SHAPE tests at `terminal.rs:10008`, `:10067`, `:10093` (`ws_conn_context_guarantee_envelope_across_filter_shapes` and its siblings) keep their per-thread registry+EnvFilter subscribers — they test filter pass-through behavior an unfiltered process-global capture cannot express, so converting them would delete the behavior under test. Their residual is recorded honestly, not fixed here: the `:10093` case `.expect`s an event from the SHARED `log_create_settled` callsite (the same call the DIAG-01 test asserts), so before any test in the binary installs the global capture it keeps the pre-existing first-registration Interest exposure — an exposure that predates this campaign and is unchanged by the migration (post-migration, whichever test calls `capture()` first heals the callsite for the whole process). No later task consumes this; Task 6's gate re-runs the binary.

- [x] **Step 1: Write the failing worst-case-order regression proof**

In `pane_ledger_tests.rs`, extend `load_index_dir_io_errors_disable_the_ledger_loudly` (currently at `:8837`): after `capture()`, force the worst-case order — a subscriber-less thread executes the same emission path BEFORE the guarded assertion (its own scan-faulted root, joined before the main constructor):

```rust
    let root = temp_root("load-loud-dir");
    std::fs::write(root.join("bindings"), b"not a dir").unwrap();
    std::fs::write(root.join("pending"), b"not a dir").unwrap();
    // 59nb worst-case order: force the shared callsite's FIRST execution to
    // happen on a subscriber-less thread AFTER capture() and BEFORE the
    // guarded emission below — the exact interleave that poisons tracing-core's
    // process-global Interest cache under the old thread-local capture.
    let poison_root = temp_root("load-loud-dir-poisoner");
    std::fs::write(poison_root.join("bindings"), b"not a dir").unwrap();
    std::fs::write(poison_root.join("pending"), b"not a dir").unwrap();
    let (events, guard) = crate::invariants::capture::capture();
    std::thread::spawn(move || {
        // clone: `PaneLedger::new(root: Option<PathBuf>)` (pane_ledger.rs:1491)
        // takes ownership — without the clone, `remove_dir_all(&poison_root)`
        // would borrow a moved value (E0382), and Step 2's red would be a
        // compile error instead of the diagnosed mechanism.
        let _poisoned = PaneLedger::new(Some(poison_root.clone()));
        std::fs::remove_dir_all(&poison_root).ok();
    })
    .join()
    .unwrap();
    let ledger = PaneLedger::new(Some(root.clone()));
    drop(guard);
```

(The remainder of the test's assertions are unchanged at this step; the poisoner thread's own root is distinct, and later the root filter added in Step 4 excludes it.)

- [x] **Step 2: Run it and verify the intended failure**

Run: `cargo test -p freshell-ws --locked --lib load_index_dir_io_errors`

Expected: FAIL — `got:` shows zero scan-fault events for our root: the poisoner thread registered the shared `pane_ledger.rs:~1530` callsite against `NoSubscriber` (`Interest::never` cached process-wide), so the main thread's `PaneLedger::new` emission short-circuits before dispatch. In this narrowed single-test run no sibling can pre-heal the callsite, so the failure is deterministic. (If it unexpectedly passes, the mechanism claim is wrong — STOP and re-diagnose.)

- [x] **Step 3: Migrate `capture()` to the process-global OnceLock pattern**

Replace the body of `capture()` in `crates/freshell-ws/src/invariants.rs` (e08g shape; the layer, visitor, and `CapturedEvent` stay as-is):

```rust
    /// Process-global capture for this lib-test binary (the e08g pattern,
    /// `tests/pane_reconcile_freshagent.rs:838-858`). Do NOT replace this
    /// with a scoped `set_default`: tracing-core caches each callsite's
    /// Interest process-wide on first registration, and while only one
    /// dispatcher exists it consults only the REGISTERING thread's default
    /// (Rebuilder::JustOne) — a subscriber-less sibling thread executing a
    /// shared emission site first caches `Interest::never` and the event!
    /// macro short-circuits before any dispatch; a thread-local capture
    /// then sees nothing (kata 59nb). One global subscriber sees every
    /// thread's events; callers MUST filter by a per-test-unique field
    /// (root/path/device_id/terminal_id) because ALL tests share this vec.
    pub fn capture() -> Arc<Mutex<Vec<CapturedEvent>>> {
        static EVENTS: OnceLock<Arc<Mutex<Vec<CapturedEvent>>>> = OnceLock::new();

        Arc::clone(EVENTS.get_or_init(|| {
            let events = Arc::new(Mutex::new(Vec::new()));
            let layer = CaptureLayer { events: Arc::clone(&events) };
            let subscriber = tracing_subscriber::registry().with(layer);
            tracing::subscriber::set_global_default(subscriber)
                .expect("install freshell-ws lib-test log capture");
            events
        }))
    }
```

Add the `std::sync::OnceLock` import. There is NO `set_default` import to remove — the old body calls `tracing::subscriber::set_default` by its full path (`invariants.rs:439`), and that call is replaced in place by the `set_global_default` call above. What must go is the `tracing::subscriber::DefaultGuard` RETURN TYPE (`:431-432`, also fully qualified — not an import) and the guard bindings it produced at the call sites. All events of the whole binary now land in one shared vec.

**Poisoning hardening — part of this step, mechanically:** `CaptureLayer::on_event` (`invariants.rs:415-426`) currently locks the shared vec with `.lock().expect("capture lock")`. Under one shared vec across the whole 748-test binary, a consumer that panics while holding the guard poisons the lock, and every subsequent log event from every thread then panics INSIDE `on_event` — one real test failure cascades into a flood of unrelated `capture lock` failures (under the old per-test captures, poisoning stayed inside one test). Replace the lock expression with recovery: `.lock().unwrap_or_else(|poisoned| poisoned.into_inner())` — recording continues after any poisoning and the cascade is impossible by construction. (Consumers get the complementary rule in Step 4: never hold this guard across an assertion in the first place.)

- [x] **Step 4: Convert every consumer to unique-field filtering**

Mechanical rule for every site: `let events = capture();` (drop the `(events, _guard)` destructure — there is no guard), make every presence/count/negative assertion filter by a per-test-unique field, AND narrow every failure message that today dumps the whole vec via `{events:?}` to print the FILTERED hits instead (`{hits:?}` / a bound filtered slice) — the shared vec now holds every event from every test in the binary, so an unfiltered dump is unreadable noise working against the clear-failure-diagnostics goal. AND never hold the events guard across an assertion — the shared-lock poisoning rule (companion to Step 3's `on_event` recovery): collect the filtered hits into a local `Vec<CapturedEvent>` while holding the guard (`.cloned()` — `CapturedEvent` already derives Clone, `invariants.rs:375`), drop the guard, then assert on the local. A panicking assertion with the guard held would poison the shared lock for every other test in the binary; with the guard dropped before any assert, a test failure can never poison anything at all. Concretely: `let hits: Vec<_> = { let guard = events.lock().unwrap_or_else(|p| p.into_inner()); guard.iter().filter(<per-test-unique predicate>).cloned().collect() };` then assert on `hits`. Six `{events:?}` sites: `pane_ledger_tests.rs:8861,:8899` (both already bind `hits` — print it) and `tabs_persist_tests.rs:1228,:1313,:1367,:1415` (hoist each inline `.any()` predicate into a `hits` binding and print that). Verified emission fields and required edits:

| Site | Assertion today | Emission's unique field | Required edit |
| --- | --- | --- | --- |
| `pane_ledger_tests.rs:8847` (`load_index_dir_io_errors_disable_the_ledger_loudly`) | exact-1 by target+message; `fields.contains_key("root")` | `root` (temp path, per-test label `load-loud-dir`; poisoner uses its own root) | filter adds `e.fields.get("root").map(String::as_str) == Some(&root.display().to_string())`; keep exact-1 |
| `pane_ledger_tests.rs:8885` (`load_index_row_io_errors_are_loud_per_row`) | exact-1 by message, then asserts `fields["path"]` | `path` (contains per-test temp root `load-loud-row`) | move the path into the filter: exact-1 by message + `fields["path"] == want_path` |
| `tabs_persist_tests.rs:1217` | `.any()` by message `tabs_snapshot_dropped_oversize` | `device_id` (test's device is `"dev"`) | rename the test's device id to a per-binary-unique `dev-oversize` and filter by `e.fields.get("device_id").map(String::as_str) == Some("dev-oversize")` — the `.map(String::as_str)` is REQUIRED, not stylistic: `fields` is a `BTreeMap<String, String>`, so bare `.get()` yields `Option<&String>`, and `== Some("dev-oversize")` (`Option<&str>`) is an E0308 mismatched-types compile error (rustc-verified; the neighbouring rows' `.map(String::as_str)` shape is the working form) |
| `tabs_persist_tests.rs:1270` | `.any()` by message `tabs_snapshot_corrupt_dir_exempt_from_eviction` | `path` (device dir under the test's tempdir) | filter adds `e.fields.get("path")` containing this test's tempdir path |
| `tabs_persist_tests.rs:1321` (`cap_unenforceable_fails_the_write_and_preserves_all_evidence`) | `.any()` by message `tabs_snapshot_device_cap_unenforceable` (asserted at `:1366` — NOT the corrupt-dir-exempt message) | `root` — the cap-unenforceable emission (`tabs_persist_retention.rs:114-116`) carries `root = %root.display()` and `corrupt_exempt`, and NO `path` field | filter adds `e.fields.get("root").map(String::as_str) == Some(&dir.path().display().to_string())`. TRAP — do not take the other branch: this test ALSO emits `tabs_snapshot_corrupt_dir_exempt_from_eviction` (with `path`) for every corrupt device dir under its tempdir, so filtering on that message+path would keep the test green while silently dropping the cap-alarm check it exists to make. No device-id rename needed: its per-test tempdir already makes every `root`/`path` value distinct from `:1270`'s |
| `tabs_persist_tests.rs:1376` | `.any()` by message `tabs_snapshot_device_identity_conflict` | `dir` (device dir path), plus `first`/`conflicting` | filter adds `e.fields.get("dir")` containing this test's tempdir path |
| `claude_signal.rs:440` | guard held only to keep registration warm (comment documents the poisoning) | — | keep the call as `let _ = crate::invariants::capture::capture();` (installs the global early; no assertions on events). Update the comment to point at the global capture |
| `claude_signal.rs:598` (`drain_warns_on_rejected_files`) | `.any()` by message `claude_signal_rejected` | `path` (junk file under this test's tempdir) | filter adds `e.fields.get("path")` == the test's junk-file path (or contains its tempdir) |
| `opencode_signal.rs:758` (`hello_files_never_hit_the_reject_warn_lane`) | NEGATIVE `.any()` by message `opencode_signal_rejected` | `path` | negative filter scoped to this test's tempdir: `!events.iter().any(rejected && path contains my dir)` |
| `opencode_signal.rs:816` (`warns_once_for_an_opencode_pane_past_grace_with_no_hello`) | exact-1 by message `opencode_rebind_heartbeat_missing` | `terminal_id` (currently `"term-1"` — collides with the next test's rows) | rename its probe terminal to a unique `term-hb-once` and filter by `fields["terminal_id"] == "term-hb-once"` |
| `opencode_signal.rs:832` (`no_warn_when_hello_seen_young_non_opencode_or_injection_disabled`) | negative by same message | `terminal_id` (currently `"term-1"` rows) | rename its rows to per-test-unique ids (`term-hello`, `term-young`, `term-nonoc`, `term-injdis`) and scope the negative filter to those ids |
| `invariants.rs` internal `mod tests` — 15 call sites spanning `:544`–`:1234`: `warns_once_per_unresolved…` (`t-lost`), `never_warns_inside_the_grace_window` (`t-young`), `never_warns_for_shell_or_exited_terminals` (`t-shell`/`t-gone`), `never_warns_when_either_identity_home_resolves…` (`t-identity`/`t-rest-resume`), `error_claude_restore_unresolved_emits_on_invariants_target` (`:632`), and the opencode probe-phase family `:698`–`:1234` (`:709`, `:760`, `:801`, `:835`, `:875`, `:902`, `:939`, `:992`, `:1154`, `:1234`) | the `unresolved_warnings` helper (`:466`) filters by target+message ONLY; several tests assert exact counts or emptiness | `terminal_id` ONLY for the unresolved-warning sites — the event carries just `terminal_id`/`mode`/`age_ms` (`invariants.rs:232-237`), so NO home-root/path filter is possible there; `request_id` for the claude-restore test (its event carries the field, `:342`) | **the terminal ids are NOT already unique — four are shared by two tests each and must be renamed per test:** `t-ev` (`:760` `…stale_candidate_evidence_still_warns` expects EXACTLY ONE warning; `:801` `…fresh_candidate_evidence_does_not_warn_yet` expects NONE), `t-late` (`:1154` `probe_phase_closes_the_late_row_hole…` expects a warning; `:939` `opencode_latch_miss…` expects NONE), `t-young` (`:585`/`:992`), `t-idle` (`:709`/`:1234`). The t-ev and t-late pairs are hard false-fails under the shared never-cleared vec (the warning-free sibling sees its sibling's warning); the t-young/t-idle pairs are negative-negative today but are renamed anyway so a later positive sibling can't silently recreate the race. Rename per test (e.g. `t-ev-stale`/`t-ev-fresh`, `t-late-hole`/`t-late-latch`, `t-young-grace`/`t-young-boundary`, `t-idle-grace`/`t-idle-never`), then extend `unresolved_warnings` (or its call sites) to also filter by the test's terminal id(s); the claude-restore test filters by its `request_id`. Every other capture site in the file keeps its already-unique id (`t-lost`, `t-shell`, `t-gone`, `t-bound`, `t-noloc`, `t-resume`, `t-identity`, `t-rest-resume`) — audit each `capture()` the same way |
| `pane_ledger_tests.rs:3100` (`new_locked_degrades_to_disabled_when_another_holder_exists`, the f3wp deflake) — NOT a `capture::capture()` site: it uses the thread-LOCAL `lock_log_capture::lock_failure_capture()` (`:2983-2996`, its own `set_default` at `:2992`) | presence via `find` on `log[seen_before..]`; its `None => panic!` arm (`:3185`) requires the production `pane_ledger_lock_unavailable` (or scan-unavailable) event from `pane_ledger.rs:1573` | `root` (the lock-unavailable emission carries `root` + `error`) | migrate to the global capture: `let events = crate::invariants::capture::capture();` (drop the `_trace_guard` binding), keep the `seen_before` mark slicing, and add a root filter to the find (`e.fields.get("root")` == this test's `temp_root` path) so sibling lock failures from other roots cannot be misclassified; the `error`-contains-`would_block_marker` match arms stay unchanged. Then DELETE the whole now-dead `mod lock_log_capture` (`pane_ledger_tests.rs:2919-2997` — `CapturedEvent`, `CapVisitor`, `LogCapture`, and `lock_failure_capture`): after the consumer migrates, EVERY item in the module is caller-less dead code failing `clippy -D warnings` (deleting only the `lock_failure_capture` fn would strand the other three items in the same failure) |
| `create_dedupe.rs:949` (`settle_logs_a_waiter_join_event_with_the_waiters_connection_id`, DIAG-01) — also NOT a `capture::capture()` site: inline thread-local `set_default` capture | presence via `.find` + `.expect` (`:977`) on the production `ws.terminal.create.settled` join event | `terminal_id` (`"tX"`) + `path` (`"duplicate_in_flight_waiter"`) — both grep-unique to this one test across the whole lib at base | migrate to the global capture: drop the inline `L` layer + `set_default` guard, use `crate::invariants::capture::capture()`, and adapt the tuple find to `CapturedEvent`'s `e.message`/`e.fields`, keeping the `.map(String::as_str)` comparison shape the test ALREADY uses (`join.1.get("connection_id").map(String::as_str)` asserted against `Some("2")` at `:977-983`; the bare `fields.get(...) == Some("2")` form is the same E0308 as the oversize row). Why `connection_id == "2"` still transfers — the honest reason: the inline visitor implements `record_u64` (Display render) while `invariants.rs`'s `FieldVisitor` implements `record_i64` (NOT a shared integer convention), but the production `log_create_settled` (`terminal.rs:155-163`) records `connection_id` as `u64`, and tracing's DEFAULT `Visit::record_u64` delegates to `record_debug` — so under the global capture the value flows `record_u64` → `record_debug` → FieldVisitor's Debug fallback, rendering `2u64` as `"2"`, identical to the inline visitor's Display render; the transfer works because Display and Debug render this integer identically, and the test keeps asserting through `.map(String::as_str)`. Keep the existing `terminal_id`+`path` predicate as the per-test-unique filter — no rename needed |

Any site not in this table that greps as `capture::capture()` — OR as a thread-local `tracing::subscriber::set_default` capture anywhere in the lib (`set_default`/`DefaultGuard` outside `invariants.rs`'s own `capture()`) — must get the same treatment. Stage-2's grep at base dbbfd0752 verified the full census: **26 `capture::capture()` call sites in 5 files** — `pane_ledger_tests.rs:8847,:8885`; `tabs_persist_tests.rs:1217,:1270,:1321,:1376`; `claude_signal.rs:440,:598`; `opencode_signal.rs:758,:816,:832`; and `invariants.rs` ×15 (`:544,:585,:610,:632,:661,:709,:760,:801,:835,:875,:902,:939,:992,:1154,:1234` — the seven beyond `:830` are the opencode probe-phase family, outside the 59nb report's original `:544-801` range) — PLUS the two thread-local `set_default` captures migrated by the last two table rows (`pane_ledger_tests.rs:2992` via `lock_failure_capture`, consumed at `:3100`; `create_dedupe.rs:949`, asserted at `:977`): 28 guarded capture sites across 6 files — AND three deliberate `with_default` NON-migrants recorded for census completeness: the scoped filter-shape captures at `terminal.rs:10008`, `:10067`, `:10093` (see Interfaces) stay thread-scoped BY DESIGN; they are not part of the 28, they must NOT be converted, and their pre-install Interest residual is the Interfaces-recorded one. The Step 6 re-grep remains the mechanical completeness gate — it greps `capture::capture()`, `set_default`/`DefaultGuard`, AND `tracing::subscriber::with_default`, expecting exactly the three terminal.rs hits as the sanctioned residue.

- [x] **Step 5: Run the focused proof and the consumer files green**

```bash
cargo test -p freshell-ws --locked --lib load_index_dir_io_errors
cargo test -p freshell-ws --locked --lib pane_ledger
cargo test -p freshell-ws --locked --lib tabs_persist
cargo test -p freshell-ws --locked --lib claude_signal
cargo test -p freshell-ws --locked --lib opencode_signal
cargo test -p freshell-ws --locked --lib create_dedupe
cargo test -p freshell-ws --locked --lib invariants
```

Expected: PASS — the worst-case-order proof passes under the global capture (the poisoner thread's emission lands in the shared vec with its own root and is filtered out; the main thread's emission dispatches because the callsite registers against the live global dispatcher), and the two migrated thread-local sites pass (the lock test's root-filtered find; the DIAG-01 waiter's `terminal_id`+`path` find).

- [x] **Step 6: Refactor while green**

Remove the `tracing::subscriber::DefaultGuard` return type and every now-unused `(events, _guard)` guard binding across the six files (neither is an import — both are fully qualified in the source; there is no `set_default` import to remove). Re-grep `capture::capture()` AND `set_default`/`DefaultGuard` AND `tracing::subscriber::with_default` in `crates/freshell-ws/src/` to confirm every consumer was converted and no thread-local capture-util capture remains (`invariants.rs`'s global `capture()` is the only subscriber install; the whole `lock_log_capture` module and the create_dedupe inline layer are gone; the ONLY `with_default` hits are the three sanctioned filter-shape tests at `terminal.rs:10008`, `:10067`, `:10093` — any other hit is a missed site and must be converted) — AND audit filter uniqueness, which the call-site census alone cannot detect: every id literal used AS a shared-vec filter must identify exactly ONE test — the `terminal_id` literals asserted against the vec, the oversize test's renamed `dev-oversize` `device_id`, and every `temp_root` label in `pane_ledger_tests.rs` (the `dev-000`-series device ids appear in two tabs_persist tests by design and are fine — they are never vec filters there; those tests filter by per-test-unique tempdir `root`/`path`). The known collisions to confirm gone: `t-ev`, `t-late`, `t-young`, `t-idle` in `invariants.rs` (each was shared by two tests; see the Step 4 table), and the `term-1`/`term-hb-once` renames in `opencode_signal.rs`.

- [x] **Step 7: Impacted-test verification**

The whole lib binary shares the capture; the impacted set is the entire `freshell-ws` lib test suite, run repeatedly to mirror the original flake conditions:

```bash
cargo test -p freshell-ws --locked --lib            # full lib binary, expect 700+ passed, 0 failed
for i in $(seq 1 5); do cargo test -p freshell-ws --locked --lib || break; done
for i in $(seq 1 30); do taskset -c 0,1 cargo test -p freshell-ws --locked --lib pane_ledger -- --test-threads 8 || break; done
```

Expected: every run green (the pinned-combo taskset loop is the investigation's reproduction recipe — 1 failure in 30 pre-fix; 0/30 post-fix). Also run `cargo test -p freshell-ws --locked --lib capture` if the invariants internal tests are named accordingly (covered by the full-lib runs above regardless).

- [x] **Step 8: Commit**

```bash
git add crates/freshell-ws/src/invariants.rs crates/freshell-ws/src/pane_ledger_tests.rs crates/freshell-ws/src/tabs_persist_tests.rs crates/freshell-ws/src/claude_signal.rs crates/freshell-ws/src/opencode_signal.rs crates/freshell-ws/src/create_dedupe.rs
git commit -m "test(ws): process-global OnceLock capture with per-test-unique filters (kata 59nb) — fixes callsite Interest-cache poisoning"
```

Kata bookkeeping: disposition **59nb** (mechanism: thread-local `set_default` capture defeated by tracing-core's process-global callsite Interest cache; fix: e08g OnceLock global + unique-field filters + worst-case-order proof).

### Task 4: Kata hsrh (part 1) — delete the merge-repair-resurrected zombie test

Closes part 1 of **kata hsrh**. Root cause (proven): r27 F4 (`129613906`) deliberately retired `session_init_with_all_blank_settings_records_no_binding` (its `bindings.is_empty()` assertion is the INVERSE of the merged unconditional lineage-row contract) and reshaped it into `session_init_with_all_blank_settings_records_the_lineage_row`; merge-repair commit `9e56e8bb6` (2026-09-17) accidentally resurrected the obsolete body. The zombie is a deterministic red at HEAD (fails in 0.19s on the semantic assert) and contradicts its own passing reshape. Deletion is coverage-preserving: the live reshape test covers the same user-level guarantee and is stronger (blank settings recorded verbatim AND the row answers neither `was_recorded` nor `load_settings` — the exact no-laundering guarantee the zombie protected).

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs:18319-18367` — delete the zombie's doc comment (`/// No-laundering guard (V7/A10, parity with codex's `record_codex_binding`): …`) plus the whole `#[tokio::test(flavor = "multi_thread")] async fn session_init_with_all_blank_settings_records_no_binding() { … }` body.

**Interfaces:**
- Consumes: nothing.
- Produces: a narrowed `cargo test -p freshell-freshagent --locked session_init` selector that is green (this also unblocks every later green-base check on the rust lane, which currently trips on the zombie).

- [x] **Step 1: Reproduce the deterministic red**

Run: `cargo test -p freshell-freshagent --locked session_init_with_all_blank`

Expected: FAIL — `session_init_with_all_blank_settings_records_no_binding` panics at the semantic assert ("an all-blank settings snapshot must not be persisted …") in ~0.2s, while `session_init_with_all_blank_settings_records_the_lineage_row` passes. This is the red receipt for the deletion.

- [x] **Step 2: Delete the zombie**

Delete the doc-comment block starting `/// No-laundering guard (V7/A10, parity with codex's` through the end of the `session_init_with_all_blank_settings_records_no_binding` test (claude.rs:18319-18367). Do not touch the live reshape (`:18087-18150` region) or the provenance sibling that follows.

- [x] **Step 3: Run the family green**

Run: `cargo test -p freshell-freshagent --locked session_init`

Expected: PASS — the whole `session_init` family green (7 passed, 0 failed — was 7 passed / 1 failed).

- [x] **Step 4: Refactor while green**

None (pure deletion of a superseded duplicate).

- [x] **Step 5: Impacted-test verification**

  Run the whole crate (narrowed selector, delegated): `cargo test -p freshell-freshagent --locked`

  Result (honest record, 2026-09-19 — receipt `reports/t4-step5-whole-crate.log`; this step's original "Expected: PASS" was a misstatement, corrected per the delta review): **1144 passed / 10 failed**. The 10 are the base-verified pre-existing standing-red set classified in D4: `claude::tests::a_settings_changing_send_broadcasts_session_metadata`, the eight `codex::tests::a_stale_{fence,generation}_*` refusals, and `opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership`. Each fails identically-or-worse at base dbbfd0752 (base receipts `reports/t4-step5-base-a_settings_changing.log`, `reports/t4-step5-base-stale-family.log` — the base stale-family run fails these 9 PLUS six more, 15 vs 9) and each fails FOCUSED on this branch as well (`reports/t4-step5-focused-{a_settings_changing,stale-family}.log` — sub-5s deterministic semantic asserts), so they are deterministic standing reds on main, not load flakes and not regressions of this deletion; out of scope under no-scope-creep (D4), and Task 6's gate expects exactly this set in the Rust lane. The campaign-relevant selectors were green in the run: the `session_init` family (this task's subject) passed, and the known-open 3fxd/y5fw sibling flake did not fire (Task 5 Step 3's focused-re-run allowance was not needed).

- [x] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "test(freshagent): delete the merge-repair-resurrected records_no_binding zombie (kata hsrh part 1) — superseded by the r27 F4 lineage-row reshape"
```

### Task 5: Kata hsrh (part 2) — land the stranded either-order combined frame drain + its binding-row barrier on the three live siblings

Closes part 2 of **kata hsrh**. Root cause (proven, and already root-caused on the stranded branch `origin/fix-session-init-provenance-flake`, commit `8186d9f3e`, 2026-09-14 — never merged, no PR): `handle_create` spawns the stdout consumer task BEFORE it broadcasts `freshAgent.created` (`claude.rs:2274` → `tokio::spawn` at `:7716`, tail broadcast at `:2466`), and the fake sidecar prints `sdk.session.init` in the same synchronous burst as its `created` answer; on the multi_thread runtime the consumer can broadcast `freshAgent.session.init` FIRST, the test's created-only drain discards it, and the second drain waits out its full 15s budget for a frame already consumed. No budget raise can fix a lost frame.

**A second mechanism exists at THIS base and was absent from the stranded branch's base (verified for this plan: `git merge-base --is-ancestor 54850ac5c dbbfd0752` succeeds, against `8186d9f3e` fails — `54850ac5c` (2026-09-11, "atomic session-init adoption") is IN dbbfd0752 and NOT in the stranded branch's history).** At dbbfd0752, `handle_create` spawns the consumer (`claude.rs:2274-2293`) BEFORE it inserts the session into `self.sessions` (`:2317`); if the consumer reads the already-buffered `sdk.session.init` line in that window, `adopt_session_init_inner` finds the session unregistered and DEFERS: `:7307-7339` calls `defer_session_init_adoption` (`:7046`) — a spawned task that polls for registration every 25 ms (`:7074-7111`) and only then runs the full adoption (claim + publication + the binding-row write) — and returns `SessionInitAdoptionOutcome::Deferred`. The consumer broadcasts the init frame IMMEDIATELY regardless of the outcome: the `.adopt_session_init(...).await` at `:8046-8055` returns (Deferred included), then `sdk_line_to_frame` + `broadcast_tx.send` run unconditionally (`:8058-8062`). The insert precedes the `freshAgent.created` broadcast (`:2466`) by microseconds, and the deferred row write lands ~25 ms after the insert. Consequence: **at this base the init frame no longer proves the binding row landed.** The stranded family's premise — asserted verbatim in the tests' own comments ("the binding write is AWAITED before the init frame broadcasts, so seeing the freshAgent.session.init envelope proves the row already landed", `claude.rs:18050`, `:18396`; "The init frame still broadcasts (durable-before-answer landed)", `:18112`) — was true on the stranded branch's base (no `defer_session_init_adoption` exists at `8186d9f3e^` — 0 hits) and is FALSE at dbbfd0752. A combined frame drain ALONE would convert the 15s-budget flake into a fast binding-assertion failure (`bindings.last().expect("binding at sdk.session.init")` at `:18073`/`:18418`; the lineage-row find at `:18135-18145`) whenever the deferred ordering wins — the flake would change shape, not disappear, and hsrh would not be fixed at its mechanism.

**The load-immune fix at this base is therefore two-part:** (1) the deterministic either-order combined FRAME drain (the stranded helper, VERBATIM — it fixes the lost-frame race; keep the 15s as a now-sound dead-man switch), PLUS (2) a binding-ROW barrier — after the frames, await the row itself in the test's `FakeIdentitySink` under the same 15s budget. The row barrier is NEW (not from the stranded branch — its base made it unnecessary). It follows the file's existing bounded-poll idiom (`a_refused_kill_keeps_the_durable_ledger_bound_and_answers_typed` polls `sink.was_recorded` on the same 15s-deadline/10ms-interval shape, `claude.rs:11372-11378`) with one necessary deviation: the barrier polls the fake's `bindings` VEC, not `was_recorded` — the all-blank lineage row NEVER enters the fake's `recorded` set (Task-3 keying excludes blank-settings bindings by design, `identity_sink.rs:609-611`), so `was_recorded` cannot witness the very row the blank test exists to assert; the `bindings` vec (`identity_sink.rs:605`) is the only honest witness shared by all three tests.

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` — add `await_claude_created_and_session_init` (verbatim from 8186d9f3e) AND the new companion `await_claude_session_init_binding_row` (the row barrier) after the `await_claude_created` helper (which starts at `:11009`); in the three LIVE family tests replace the two-phase drain, the now-FALSE premise comments, and the assertion row source: `session_init_records_binding_with_create_settings` (`:18033`, request id `req-binding-init`), `session_init_with_all_blank_settings_records_the_lineage_row` (`:18098`, `req-binding-blank`), `session_init_binding_carries_the_creates_connection_provenance` (`:18376`, `req-binding-prov`).

**Interfaces:**
- Consumes: the stranded branch `origin/fix-session-init-provenance-flake` @ `8186d9f3e` — the FRAME-drain helper is taken verbatim from `git show 8186d9f3e -- crates/freshell-freshagent/src/claude.rs` (reproduced below so the task is self-contained; its base predates `54850ac5c`'s deferral, which is exactly why the row barrier must be ADDED here); `await_claude_created` (unchanged); the 64-frame broadcast bus + `Lagged`-resync idiom shared by every drain in the file; `FakeIdentitySink::bindings` (`identity_sink.rs:605`, `std::sync::Mutex<Vec<FreshAgentBindingUpsert>>`) and `FRESH_CREATE_DURABLE_ID` (`claude.rs:12969` — the fake sidecar's fixed cliSessionId `aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`, the key every create's binding row lands under in these tests; a same-module const, so the helper can reference it regardless of declaration order).
- Produces: no production change (test-only). The family is race-immune at BOTH orderings: no frame is ever discarded (either-order drain), and no assertion races the deferred binding write (the row barrier).

- [x] **Step 1: Add the combined either-order drain helper (verbatim from 8186d9f3e) AND its row-barrier companion**

Insert the frame-drain helper immediately after the `await_claude_created` helper (after its closing `}` around `claude.rs:11033`):

```rust
    /// Drain `rx` until BOTH the `freshAgent.created` frame for `request_id` AND that
    /// session's `freshAgent.session.init` event have arrived, in EITHER order; returns
    /// the created frame.
    ///
    /// Not [`await_claude_created`] followed by a second drain for the init event:
    /// `handle_create` starts the stdout consumer BEFORE it registers the session and
    /// broadcasts `freshAgent.created`, and the fake sidecar prints `sdk.session.init`
    /// in the same burst as its `created` answer. On a multi-thread runtime another
    /// worker can run the consumer while the handler is still between those two points,
    /// so the init event can reach the bus FIRST — a created-only drain would discard it
    /// and the follow-up drain would wait out its budget for a frame already consumed.
    async fn await_claude_created_and_session_init(
        rx: &mut tokio::sync::broadcast::Receiver<String>,
        request_id: &str,
    ) -> Value {
        tokio::time::timeout(std::time::Duration::from_secs(15), async {
            let mut created: Option<Value> = None;
            let mut init_session_ids: Vec<String> = Vec::new();
            loop {
                let frame: Value = match rx.recv().await {
                    // Under host load the bounded drain can fall behind the
                    // 64-frame bus: re-sync and keep waiting (the 15s budget
                    // stays the dead-man switch); `Closed` surfaces through
                    // the same deadline as a lost sender.
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(err) => panic!("broadcast recv failed: {err}"),
                    Ok(raw) => serde_json::from_str(&raw).unwrap(),
                };
                if frame["requestId"] == request_id {
                    assert_ne!(
                        frame["type"], "freshAgent.create.failed",
                        "create for {request_id} failed: {frame}"
                    );
                    if frame["type"] == "freshAgent.created" {
                        created = Some(frame);
                    }
                } else if frame["type"] == "freshAgent.event"
                    && frame["event"]["type"] == "freshAgent.session.init"
                {
                    if let Some(sid) = frame["sessionId"].as_str() {
                        init_session_ids.push(sid.to_string());
                    }
                }
                if let Some(created) = &created {
                    if init_session_ids
                        .iter()
                        .any(|sid| created["sessionId"] == sid.as_str())
                    {
                        return created.clone();
                    }
                }
            }
        })
        .await
        .unwrap_or_else(|_| {
            panic!(
                "freshAgent.created and freshAgent.session.init for {request_id} \
                 arrive within budget"
            )
        })
    }
```

Then insert the row-barrier companion IMMEDIATELY AFTER it (NEW at this base — required by the `54850ac5c` deferral analyzed above; no stranded counterpart exists):

```rust
    /// Await the create's `sdk.session.init` binding row in the test's
    /// FakeIdentitySink — the ROW BARRIER of the combined drain.
    ///
    /// At this base the init frame does NOT prove the row: the consumer
    /// can read `sdk.session.init` before `handle_create` inserts the
    /// session, the adoption then defers (`defer_session_init_adoption`,
    /// a 25 ms registration poll that performs the binding write only
    /// once registered), and the init frame broadcasts IMMEDIATELY either
    /// way — so the frame drain orders the FRAMES while THIS barrier
    /// proves the ROW. Polls `bindings`, not `was_recorded`: the
    /// all-blank lineage row never enters the fake's `recorded` set
    /// (Task-3 keying excludes blank-settings bindings), so the vec is
    /// the only witness all three family tests share. Same bounded-poll
    /// idiom as the was_recorded poll in
    /// `a_refused_kill_keeps_the_durable_ledger_bound_and_answers_typed`
    /// — under the deferred ordering the row lands ~25 ms after the
    /// insert, so the wait is milliseconds in practice and the 15 s
    /// budget stays a dead-man switch, never a patience raise.
    async fn await_claude_session_init_binding_row(
        fake: &std::sync::Arc<crate::identity_sink::FakeIdentitySink>,
    ) -> crate::identity_sink::FreshAgentBindingUpsert {
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            let row = {
                let bindings = fake.bindings.lock().unwrap();
                bindings
                    .iter()
                    .rev()
                    .find(|b| b.provider == "claude" && b.session_id == FRESH_CREATE_DURABLE_ID)
                    .cloned()
            };
            if let Some(row) = row {
                return row;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the session-init binding row (claude, FRESH_CREATE_DURABLE_ID) \
                 never landed within budget"
            );
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }
```

(`FRESH_CREATE_DURABLE_ID` is a same-module const (`claude.rs:12969`) — items are order-independent in a module, so the helper may reference it; `FreshAgentBindingUpsert` is Clone — the lineage test already clones the row it finds at `:18141-18144`. The find predicate is exactly the lineage-row test's existing predicate (`:18138-18139`), so one barrier serves all three tests: each test's fake is private and its single create lands the row under that one durable id.)

- [x] **Step 2: Replace the two-phase drain in the three live siblings (drain + row barrier + comment corrections + row-sourced assertions)**

In each of the three tests named above, make FOUR changes:

1. Replace the `await_claude_created(&mut rx, "<id>").await;` call PLUS the following `tokio::time::timeout(... 15 ...)` init-drain block with the combined drain AND the row barrier:

```rust
        await_claude_created_and_session_init(&mut rx, "req-binding-init").await;
        let b = await_claude_session_init_binding_row(&fake).await;
```

(respectively `"req-binding-blank"` in the lineage-row test and `"req-binding-prov"` in the provenance test — the row-barrier call line is identical in all three; `fake` is each test's own `FakeIdentitySink` arc).

2. Replace each test's now-FALSE premise comment — "the binding write is AWAITED before the init frame broadcasts, so seeing the freshAgent.session.init envelope proves the row already landed" (`:18050` in the create-settings test, `:18396` in the provenance test) and "The init frame still broadcasts (durable-before-answer landed)" (`:18112` in the lineage-row test) — with the true base premise, e.g.: "the frame broadcasts unconditionally after `adopt_session_init` returns (including its `Deferred` arm, claude.rs:8046-8062), so the frame orders nothing about the row; the row BARRIER below is what proves the row landed."

3. Source each test's row assertions from the barrier's returned row (mechanically — the barrier already found exactly this row, so the expect/find it replaces can never race):
   - create-settings test: replace `let bindings = fake.bindings.lock().unwrap();` + `let b = bindings.last().expect("binding at sdk.session.init");` (`:18072-18073`) with the returned `b` from the barrier call (drop the lock binding and the expect; on each test's private one-create fake, `last()` and the durable-id find are the same row).
   - lineage-row test: replace the whole lock-find-clone block (`:18135-18145`, `let b = { let bindings = ...; bindings.iter().rev().find(...).expect(...).clone() };`) with the returned `b` — the barrier's predicate is that block's own predicate, so this is exactly equivalent, minus the race.
   - provenance test: replace `let bindings = fake.bindings.lock().unwrap();` + `let b = bindings.last().expect("binding at sdk.session.init");` (`:18417-18418`) with the returned `b`.

4. Leave everything else untouched: the field/stamp assertions that follow `b` in each test, the lineage test's `load_settings`/`was_recorded` negative assertions (they run AFTER the barrier has proven the row exists, so they are safe), and the `drop(env)` tails.

Verify against `git show 8186d9f3e` that the FRAME-drain call-site shape matches the stranded branch's intent (the row barrier has no stranded counterpart — it is this base's addition). Do NOT apply the stranded commit by cherry-pick or merge: stage 2 verified via read-only `git merge-tree` that a mechanical 3-way merge onto dbbfd0752 is textually clean but applies the `req-binding-blank` hunk onto the ZOMBIE's drain copy (`:18336-18359`), leaving the LIVE lineage-row test's two-phase drain (`:18110-18130`) unconverted — the conversion MUST be applied by test name as this step prescribes, and the zombie's copy disappears with Task 4's deletion.

- [x] **Step 3: Run the family green**

Run: `cargo test -p freshell-freshagent --locked session_init`

Expected: PASS (7 passed, 0 failed).

Note on red-first: the race's natural red is the recorded load-flake receipt (base-gate panic `freshAgent.session.init consumed within budget` at `claude.rs`'s old `:11189`, retained at `/tmp/base-gate-run2.log:7031`), but a DETERMINISTIC red receipt is reproducible with the stranded commit's own throwaway harness — `8186d9f3e`'s message records: "Evidence (temporary harness, not committed: a 200ms sleep before the created broadcast): before, all 3 tests failed; after, 50/50 runs of the tests passed pinned to 8 CPUs with busy loops on them." Note the evidence's SHAPE: the stranded commit's green was also collected WITH the sleep in place — the harness forces the interleave deterministically, so green-under-harness is the load-immunity proof. **Sleep placement at THIS base (load-bearing):** insert the 200ms `tokio::time::sleep` in `handle_create` IMMEDIATELY AFTER the `let consumer = self.spawn_consumer(...);` statement (`claude.rs:2274-2293`) — i.e. BEFORE the session insert (`:2317`) and hence before the `freshAgent.created` broadcast (`:2466`). A sleep placed after the insert (e.g. just before the created broadcast, the stranded wording) still exercises the lost-frame race but leaves the deferral ordering — and with it the row barrier — untested; the pre-insert placement forces the consumer to read `sdk.session.init` inside the pre-registration window, so the adoption DEFERS (`:7307-7339`) and the init frame broadcasts during the sleep with NO row yet — the worst case for both mechanisms at once. Repro recipe, three beats (UNCOMMITTED, never part of any commit):
1. RED: before applying Step 2, temporarily insert the 200ms sleep immediately after the `spawn_consumer` call, run `cargo test -p freshell-freshagent --locked session_init` → expect the three live siblings to FAIL on the init-drain budget — the created-only drain discards the init frame that went out during the sleep (the recorded lost-frame receipt shape, deterministically) (record the receipts in run-state).
2. GREEN UNDER THE FORCED INTERLEAVE: with the sleep STILL in place, apply Step 2's conversion (combined drain + row barrier), re-run the same selector → expect the three live siblings to PASS — this beat now proves BOTH mechanisms under the forced timing: the either-order drain recovers the init frame that preceded `freshAgent.created`, AND the row barrier waits out the deferred adoption (the insert lands at sleep end; `defer_session_init_adoption`'s 25 ms registration poll finds it and writes the row; the barrier's 10 ms poll sees the row within tens of milliseconds). Without this beat the green loops below exercise only the rare natural interleave and would pass even if the helper did nothing — the reorder fix is proven under the forced timing, matching the stranded commit's own 50/50 evidence.
3. CLEANUP: revert the sleep and confirm the working tree contains ONLY the Step 2 conversion (`git diff` shows no `tokio::time::sleep` hunk) before continuing.
This is a throwaway repro harness, not a committed production seam (repo precedent stands: no order-forcing seam is shipped). The deterministic committed coverage is Task 4's zombie red; this task's verification is repeated green under load:

```bash
for i in 1 2 3; do cargo test -p freshell-freshagent --locked || break; done
```

Result (honest record, 2026-09-19 — receipts `reports/t5-step5-x3-loop-{1,2,3}.log`; this step's original "Expected: PASS ×3" was a misstatement, corrected per the delta review): three whole-crate runs, each **1144 passed / 10 failed** with the IDENTICAL failure set — the same base-verified pre-existing standing reds classified in D4 (the same 10 named in Task 4 Step 5), not the 3fxd/y5fw flake and nothing outside the recorded set. The loop's actual criterion held in every run: the `session_init` family (the flake's own selector) was green inside all three full-crate executions under real node-sidecar parallel load, and the known-open 3fxd/y5fw sibling (`approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error`) did NOT fire — no focused-re-run classification was needed in any iteration. **Known-open sibling-flake allowance (the ×3 loop):** the same load conditions could fire the still-open kata-on-file sibling 3fxd/y5fw (`claude.rs:17450`, the a2 write-then-remove ordering pin; recorded as a load flake in the hsrh investigation). If it — or any other kata-on-file load flake — fails in a loop iteration: re-run THAT test focused (`cargo test -p freshell-freshagent --locked approval_respond_write_failure`); a focused PASS confirms the recorded flake shape — record the occurrence in run-state, do NOT count it against the ×3 (continue the loop), and do NOT fix it (out of scope: a separate kata family, recorded untouched). A focused re-run that STILL fails is a campaign defect: STOP and diagnose against Tasks 4/5 before proceeding. A failure outside the recorded D4 set that persists focused is likewise a campaign defect.

- [x] **Step 4: Refactor while green**

None — the frame-drain helper is the stranded branch's reviewed shape verbatim, the row barrier is the shape specified in Step 1, and `await_claude_created` remains for the tests that legitimately need created-only waits.

- [x] **Step 5: Impacted-test verification**

Impacted set: every test that drains this bus in claude.rs (the family plus any `await_claude_created` consumer) — covered by the Step 3 full-crate runs. Also confirm no remaining standalone two-phase init drain: `grep -n "freshAgent.session.init" crates/freshell-freshagent/src/claude.rs` — expected hit classes are the module doc comment (~:22), the `normalize_sdk_type` mapping arm (~:8628), the frame-shape assertions in `normalize_maps_the_known_sdk_set_and_ignores_others` (~:10138) and the `sdk_line_to_frame` wire test (~:10197), and the combined helper's own comment/matcher; none is a standalone timeout drain (a `tokio::time::timeout` block matching `freshAgent.session.init` outside the combined helper). The zombie's drain copy is already gone with Task 4.

- [x] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "test(freshagent): either-order created+session.init drain plus binding-row barrier (kata hsrh part 2; frame drain from 8186d9f3e, row barrier new at dbbfd0752) — fixes the lost-frame and deferred-binding-row race flake"
```

Kata bookkeeping: disposition **hsrh** with ALL THREE findings (lost-frame race fixed by the either-order frame drain from `8186d9f3e`; the pre-registration-deferral row race — a base divergence introduced by `54850ac5c`, absent from the stranded branch — fixed by the NEW binding-row barrier; zombie resurrected by merge repair `9e56e8bb6` and deleted in Task 4). The still-open sibling katas 3fxd/y5fw are a separate family — record them as untouched in run-state, do not fix here (load-condition encounters during the Task 5 loops follow the known-open allowance above: classify by focused re-run, never fix in this campaign).

### Task 6: Full-suite gate + campaign wrap

Closes the campaign. No new code.

**Files:**
- No production files. Receipts go to the logs dir (`<logs_dir>/reports/`) and run-state.

**Interfaces:**
- Consumes: Tasks 1–5 committed on branch `main-green-sixpack`.
- Produces: the green full-suite receipt that unblocks the-usual review → PR → merge stages; kata closures for 59nb and hsrh; the standing-ledger disposition for the e2e four.

- [x] **Step 1: Cheap checks first** — DONE 2026-09-19: all three PASS (cargo fmt --check exit 0; npm run typecheck:client exit 0; cargo clippy -p freshell-ws -p freshell-server -p freshell-freshagent --all-targets --locked -- -D warnings exit 0). Receipts: `t6-step1-cheap-checks.md` + the three `.log`s.

```bash
cargo fmt --check
npm run typecheck:client
cargo clippy -p freshell-ws -p freshell-server -p freshell-freshagent --all-targets -- -D warnings
```

Expected: PASS (the pre-push gate runs the same filtered checks on push; run them explicitly so failures surface before the gate).

- [x] **Step 2: Coordinated full suite + the full local e2e lane** — DONE 2026-09-19 with two recorded runner-reality deviations (see run-state):
  - 2a: `npm test` (coordinated; held the gate with the campaign summary string) — client (cloud backend, the user-configured default) GREEN, source-runtime GREEN, rust lane failures = D4's recorded 10 + one gate-discovered 11th (`session_handoff the_claude_handoff_target_binding…`, triaged PRE-EXISTING by focused re-run + base comparison, kata 84nb), electron lane collected by direct invocation (GREEN 42 files/372 tests) because the runner aborts at the first failing local phase and the rust phase (D4 reds) always precedes electron on this branch; electron-runtime is NOT in the default suite (opt-in staged-artifact lane). Receipts: `t6-step2a-npm-test.{log,md}`, `t6-step2a-final-classification.md`, `t6-step2a-electron.{log,md}`.
  - 2b: full local e2e lane — run 1: 20 failed / 529 passed; run 2 (Step 3 sample): 19 failed / 533 passed. **The four campaign families GREEN in BOTH samples.** Receipts: `t6-step2b-e2e-local.{log,md}`, `t6-step3-e2e-local-run2.log`.
  - 2c: every non-campaign failure classified against base dbbfd0752 (one full base lane: 24 failed / 528 passed + focused re-runs on both sides for every lane-inconclusive spec) — ALL 22 distinct failures PRE-EXISTING (18 same-test base-lane reds; restore-matrix :892/:1129 base-focused reds; 3 lane-load flakes focused-green both sides). None campaign-caused. Receipts: `t6-step2c-base-e2e-full.log`, `t6-step2c-classification.md`, `t6-step3-focused-{branch,base}-restore-matrix.log`, `t6-step3-final-verdict.md`.

`npm test` does NOT run the browser suite: it routes to `test:balanced` → `scripts/run-standard-tests.ts`, whose lanes are client, source-runtime, rust, electron, electron-runtime ONLY (verified at the base: no Playwright invocation anywhere in the file). The four e2e specs therefore need their own explicit gate — AGENTS.md requires the affected e2e specs to pass before a PR, and Task 1 changes behavior for every REST/MCP-named tab and every placeholder session row, so the net is the FULL local lane, not just the nine focused specs from Tasks 1–2.

2a. Coordinated non-e2e suite (broad runs wait for the shared gate; use the holder/status reason):

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="main-green-sixpack campaign gate: six standing failures fixed" npm test
```

Expected: PASS **excluding the recorded pre-existing Rust standing-red set (D4)** — client, source-runtime, electron, and electron-runtime fully green; the Rust lane (`cargo test --workspace`, `scripts/testing/run-rust-tests.ts:82`) WILL report D4's 10 freshell-freshagent failures (they fail identically-or-worse at base dbbfd0752 and are out of scope under no-scope-creep). The Rust lane's pass criterion is therefore: its failure list equals EXACTLY the recorded 10 — no more (a failure outside the set is triaged per Step 3), no fewer — and every other lane is green. This is the same campaign-ledger model the e2e standing items use: Step 2b's expected-green carries the per-spec base-comparison triage in 2c, while the Rust lane's ledger is fixed up front by D4's base receipts (no per-failure re-triage needed for the recorded 10).

2b. Full local e2e lane. Honest gate status: this lane is NOT coordinator-gated — `test:e2e:local` runs `bash scripts/e2e-cloud.sh run --local`, which execs `npx playwright test` directly (`scripts/e2e-cloud.sh:472`; the coordinator command matrix has no e2e entry), so the shared gate never engages and `FRESHELL_TEST_SUMMARY` does nothing for this command. By-hand discipline instead: run `npm run test:status` first and WAIT for any active holder to clear before starting — a ~28-minute full lane competing with another agent's broad run causes spurious failures Step 3 would then misread as campaign defects.

```bash
npm run test:status   # then WAIT for any active holder to clear — the e2e lane itself will never wait
npm run test:e2e:local
```

Expected: PASS — every spec in `test/e2e-browser/specs/`, including all four campaign families. Census note: only TWO of the four are on `CLOUD_SKIP_SPECS` (`playwright.cloud.config.ts`: `remote-tab-linkage-rust.spec.ts` and `rest-tab-persistence.spec.ts` — deploy-tab-diff-rust and sidebar-opencode-rail are cloud-legal; `LOCAL_ONLY_SPECS` adds only `mcp-qa-smoke-rust.spec.ts`), so a cloud lane would NOT be coverage for the linkage/persistence pair regardless — the local lane result is the campaign's authoritative e2e evidence.

2c. Triage any NON-campaign failure against the base. "Expected: PASS — every spec" has no standing baseline: run-state deliberately deferred the full-lane result to this task ("known-red main by premise"), and Task 1 changes behavior for every REST/MCP-named tab and every placeholder session row. If any spec OUTSIDE the four campaign families fails in 2b, classify pre-existing vs campaign-caused by re-running THAT spec at the branch base dbbfd0752 from a clean scratch worktree:

```bash
repo="$(git rev-parse --show-toplevel)"
git -C "$repo" worktree add --detach /tmp/freshell-base-compare dbbfd0752
# from inside /tmp/freshell-base-compare:
#   npm ci --no-audit --no-fund
#   npm run test:e2e:local -- test/e2e-browser/specs/<failing-spec>.spec.ts
git -C "$repo" worktree remove --force /tmp/freshell-base-compare
```

(same clean-scratch discipline as `scripts/base-gate.sh`, which cannot be used verbatim here: it is hardwired to `origin/main` — a valid base only while `origin/main` still equals dbbfd0752 — and takes an npm script NAME, not script args, so a single focused spec needs the explicit worktree). Classification: fails at base → PRE-EXISTING — record it in run-state under the no-scope-creep rule and move on; passes at base → a regression caused by this campaign (almost certainly Task 1's precedence or placeholder-row change) — fix within the branch before any PR.

- [x] **Step 3: Zero-flake acceptance** — DONE 2026-09-19: the four campaign families green, first-attempt, in BOTH full-lane samples (local retries 0 ⇒ no recovered-retry flakes exist structurally); every non-campaign failure (e2e and Rust) classified per the rules — the Rust lane's single outside-set failure followed the allowance path (focused PASS on the branch + base-verified pre-existing ⇒ recorded, kata filed, NOT a campaign defect); no outside-set Rust failure required the focused-FAIL path. Receipts: `t6-step3-e2e-run2.md`, `t6-step3-final-verdict.md`.

The full suite must be green with no recovered-retry flakes in the four campaign families. If any campaign family flakes or fails, that is a campaign defect — fix it within the branch before any PR (record the failure + receipt in run-state; do not weaken the suite). A NON-campaign spec failure is not treated as a campaign defect until Step 2c classifies it against the base — after classification, a campaign-caused one is a campaign defect (fix it); a pre-existing one is recorded and left (no scope creep). The same classification applies to NON-campaign RUST failures, with the recorded-set carve-out FIRST: a failure already on D4's recorded pre-existing list (the 10 freshell-freshagent standing reds) is EXPECTED in the workspace lane — its classification is receipted at base (D4), so it is neither a campaign defect nor "genuinely new", and it must not trigger the focused-re-run triage (a Rust lane whose failures are exactly the recorded 10 PASSES this gate). Any Rust failure OUTSIDE the recorded set: a kata-on-file load flake — e.g. the still-open 3fxd/y5fw sibling `approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error` (`claude.rs:17450`), which fires under exactly the coordinated suite's load conditions — is classified by a focused re-run: focused PASS ⇒ the recorded known-open flake — record the occurrence in run-state and proceed (NOT a campaign defect; its kata stays open, untouched by this campaign); focused FAIL ⇒ a genuinely new failure (not the recorded shape) — diagnose before proceeding, it is not covered by the allowance.

- [x] **Step 4: Kata + ledger bookkeeping**

- Close kata **59nb** (Task 3) and kata **hsrh** (Tasks 4+5) via the repo's kata tooling; record both dispositions with their evidence receipts in run-state `artifacts` and `important decisions and blockers`.
  - **CLOSED 2026-09-19 (Task 6 wrap): 59nb and hsrh both closed `--done` with evidence** (commits `01913fc28` for 59nb; `7fc324907` + `22a9682a2` for hsrh; focused repro/test commands and reviewed paths attached; full messages with the root causes and verification receipts recorded in the close events).
- File one kata per FAMILY for D4's 10 recorded pre-existing Rust standing reds — three families: the eight `codex::tests::a_stale_{fence,generation}_*` refusal tests as one family; `opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership`; and `claude::tests::a_settings_changing_send_broadcasts_session_metadata`. `kata list` was verified 2026-09-19 (delta-review round 1, item d): NONE of the three families has a kata on file, so all three filings are new (no duplicates to avoid); record the new kata IDs here and in run-state at wrap. Do NOT fix them in this campaign (D4: out of scope under no-scope-creep).
  - **FILED 2026-09-19 (Task 6 wrap), re-verified no duplicates via `kata list` immediately before filing:** **7ad4** (codex `a_stale_{fence,generation}_*` family, the 8 tests, [bug] P3), **17eh** (opencode_ws `a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership`, [bug] P3), **p6q2** (claude `a_settings_changing_send_broadcasts_session_metadata`, [bug] P3) — each body carries the failure shape and the base/focused/whole-crate receipts.
  - **Plus one gate-discovered filing (recorded deviation, same convention): 84nb** (P3, no [bug] — flake) for `session_handoff::tests::the_claude_handoff_target_binding_carries_the_handoff_generation` — the 11th Rust-lane failure in Task 6 Step 2a, base-verified PRE-EXISTING (deterministic focused red at dbbfd0752 with the identical panic; 2/3 base load-run failures; branch-focused PASS; the campaign's diff touched none of its code paths), filed so future gates triage it by name instead of re-diagnosing.
- Record the e2e four (deploy-tab-diff-rust :81, remote-tab-linkage-rust :107, rest-tab-persistence :117, sidebar-opencode-rail :143) as CLEARED standing ledger items with their green receipts — they are not katas.
  - **CLEARED 2026-09-19 (Task 6 gate): all four green in TWO full local e2e lane samples** (`t6-step2b-e2e-local.log` 529 passed / `t6-step3-e2e-local-run2.log` 533 passed — no campaign-family failure or flake in either; local retries 0), in addition to the Task 2 Step 3 and delta-revival focused green receipts; all four remain RED at base dbbfd0752 in the Task 6 base-lane run (`t6-step2c-base-e2e-full.log`) — the campaign's red→green proof.

- [ ] **Step 5: Branch hand-off (stop before PR)** — NOT EXECUTED in this gate run per the Task 6 user instruction ("branch main-green-sixpack, never push, no PR, no merge"): the push/PR stages stay with the-usual's stage 5 flow after the user's review of this gate. The branch is committed clean and ready for `git push -u origin main-green-sixpack`.

Push the branch (the pre-push gate runs automatically):

```bash
git push -u origin main-green-sixpack
```

Then STOP and ask the user for explicit PR-creation approval (repo rule: no `gh pr create` without it). After approval, the-usual stages handle PR → required checks → merge → local `main` fast-forward → worktree cleanup per the repo rules.

- [ ] **Step 6: No commit step**

No files change in this task; run-state (outside the tracked worktree) carries the receipts.

---

## Verification summary (what proves the User Request's result)

1. **Requested result — six failures fixed:** Task 1 Step 1 records the four e2e red receipts at base; Task 2 Step 3 records them green; Task 3 Steps 2/5 record the 59nb proof red→green plus 0/30 pinned-combo; Tasks 4/5 Steps 1/3 record the hsrh zombie red, the forced-interleave red→green under the uncommitted pre-insert 200ms harness (BOTH orderings forced: the lost-frame race AND the pre-registration-deferral row race), and family green ×3 under load (the whole-crate runs each ended 1144 passed / 10 failed — the recorded pre-existing set, D4; the session_init family green and 3fxd/y5fw unfired in every run); Task 6 Step 2a records the coordinated non-e2e suite green EXCLUDING D4's recorded pre-existing Rust standing reds (the Rust lane's failure list must equal exactly the recorded 10; every other lane fully green), Step 2b records the FULL local e2e lane green (the complete net for the title/placeholder changes — `npm test` alone runs no Playwright), and Step 2c classifies any non-campaign spec failure against the base dbbfd0752 (pre-existing → recorded, not fixed; campaign-caused → fixed in-branch).
2. **Explicit constraint — root-cause-first, no patience raises:** no timeout value is raised anywhere in the plan; the hsrh 15s budget is retained as a dead-man switch while the wait shape becomes order-immune at both orderings (frames drained in either order; the binding row awaited directly, so no assertion races the deferred write — the barrier's second 15s window is the SAME budget shape for the SECOND diagnosed mechanism, not a raise); the e2e fixes restore a product contract rather than extending waits.
3. **Explicit constraint — rename-scope coherence:** the Resolution section reconciles the precedence with docs/development/rename-scope-contract.md; Task 1 Step 4e records the display-precedence ladders in the contract doc exactly as the code composes them (tab ladder + the pane-kind split, so no inaccurate blanket rule enters the contract) and adds the Tab-label "Written by" create-time entry; no hard rule is violated (write-scoping untouched).
4. **Explicit constraint — one branch/PR via the campaign pattern:** single branch `main-green-sixpack` from `dbbfd0752`; PR only after explicit user approval (Task 6 Step 5).
5. **Explicit constraint — production safety:** every command runs from the linked worktree; e2e/cargo runs spawn their own ephemeral servers; nothing touches the port-3001 production process.

## Decision Notes (execution amendments)

- **D3 (Task 2, sidebar-opencode-rail):** The investigation's mirror-based diagnosis was wrong for this shape. Execution evidence (probe receipts t1-probe-rail-title-writer*.log): the fabricated is_subagent session row is dropped server-side (session_directory.rs:1723) and never reaches the client; the actual banner writer is the terminal-directory title replay (e78c25c8c): registry auto-title 'OpenCode' (terminal.rs:5218 mode_label) -> terminals.changed -> recordTerminalTitleForReplay (terminalDirectoryThunks.ts:198) -> initLayout replay. Decision by the plan owner: the pane ladder already in this plan (registry auto-titles own terminal panes) governs; the spec's cwd-leaf expectation rotted with e78c25c8c; the spec is reshaped to assert 'Pane: OpenCode' (canonical registry auto-title) with a documenting comment, rail-flow assertions unchanged. ~~The Task 1 fabricated-row fix stands independently (sidebar provider-label honesty, unit-proven, contract-documented).~~ (superseded by D5) This amendment carries to the delta review as a recorded plan deviation.
- **D4 (Tasks 4–6, the freshell-freshagent whole-crate standing reds — delta review round 1, Major):** Every whole-crate run of this campaign (Task 4 Step 5; the three Task 5 Step 3 runs — receipts `t4-step5-whole-crate.log`, `t5-step5-x3-loop-{1,2,3}.log`) ended **1144 passed / 10 failed** with an identical failure set: `claude::tests::a_settings_changing_send_broadcasts_session_metadata`, eight `codex::tests::a_stale_*` refusals (`a_stale_fence_{compact,fork,undo}_against_a_vacated_key_is_refused_typed_no_recreation`, `a_stale_generation_{compact,fork,undo}_against_a_vacated_key_is_refused_typed`, `a_stale_generation_crashed_attach_is_refused_typed_no_recreation`, `a_stale_generation_send_against_a_crashed_session_is_refused_typed`), and `opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership`. DECISION (classification): these 10 are **pre-existing standing reds on main** — not regressions of this branch and not load flakes. Evidence: each fails FOCUSED on the branch (`t4-step5-focused-{a_settings_changing,stale-family}.log` — 0.09s / 4.30s deterministic semantic asserts), and each fails IDENTICALLY-OR-WORSE at base dbbfd0752 (`t4-step5-base-a_settings_changing.log` — the same test; `t4-step5-base-stale-family.log` — the same 9 PLUS six more stale-theme failures: 15 failed at base vs 9 on the branch). They are out of scope under the no-scope-creep rule (disjoint from the campaign's six). Consequences recorded in the plan: Task 4 Step 5 and Task 5 Step 3 carry honest result annotations instead of the misstated "Expected: PASS"; Task 6's Rust-lane gate expects EXACTLY this recorded set (green excluding the recorded pre-existing set — the same campaign-ledger model as the e2e standing items); and Task 6 Step 4 files one kata per family at wrap (`kata list` verified 2026-09-19: none of the three families is on file — codex `a_stale_*` family, opencode_ws `a_stale_fence_map_hit` family, claude `a_settings_changing` family — so three new filings, no duplicates). The campaign-relevant selectors were green throughout: the `session_init` family in every run, and the known-open 3fxd/y5fw sibling never fired.
- **D5 (Task 1 / delta review round 1, Minor 2 — the fabricated-row `title: None` change is REVERTED):** The server-side half of Task 1's fabricated-row rule is reverted: `build_live_terminal_session_item` again fabricates `title: Some(provider_display_name(...))` (the fn and its join_tests parity test are restored verbatim from dbbfd0752; `crates/freshell-server/src/session_directory.rs` is byte-identical to base again), the three fabricated-title unit assertions are back to their base form, the contract doc's fabricated-row paragraph is replaced by the surviving display rule, and the sessionTitleMirror fabricated-row pin is deleted (the mirror's no-title skip keeps its pre-existing 'skips rows without a title' unit coverage). Reasoning: D3 already showed the change fixes none of the six; the delta review's user-visible regressions are real — HistoryView's main label for `terminal:<id>` rows degrades to the literal `terminal` (HistoryView.tsx:483 id-prefix fallback), the server's title-search tier stops matching placeholder rows, and the sidebar label changes; the remaining value was cosmetic honesty ("a provider label is not a session name"), and the mirror-fold the removed comment cited was the D3-disproven subagent mechanism — for the shapes that DO reach the client, the fabricated title equals the registry auto-title the pane ladder itself crowns (mode_label renders the same 'OpenCode'/'Codex CLI'/'Claude CLI' strings), so a mirror fold converges to the label the ladder would set anyway. KEPT (load-bearing, unchanged): the client `titleSetByUser` fold (`ui-commands.ts`) that makes the three named-create specs green, and the sidebar title-less-running-row display fallback — now composed in the fallback row's name order (pane title → terminal registry title → provider label; delta review Minor 1) so the label is stable when the server row replaces the fallback row, with `getProviderLabel` only the last rung. Verified after the revert: all four campaign e2e families green focused, the three Task-1 unit files green, `cargo test -p freshell-server --locked --bin freshell-server session_directory` green (receipts in the delta round-1 dispositions).


- **D6 (landing blocker, CI infra):** The brand-new required rust-gate workflow (merged as #803, ~1h before this branch's PR) runs the workspace Rust tests WITHOUT installing npm dependencies. 12 freshell-codex sidecar tests spawn the committed fake codex app-server fixture, which imports the npm package ws — on GitHub's runner the import throws and the fixture exits 1 ("fake app-server exited before listening"), failing all 12. Root cause is CI-job setup, not main content: the tests job had never actually run before (the paths filter skipped it for #803 itself; local runs always have node_modules). Fix in this branch: setup-node@v4 (node 22, npm cache) + npm ci before cargo test in the rust-tests job of .github/workflows/rust-tests.yml. This is test-infra only, outside the six, recorded as a landing-blocking amendment.
> freshell@0.7.5 postinstall
> node scripts/install-hooks.mjs

[install-hooks] core.hooksPath -> /home/dan/code/freshell/scripts/hooks (pre-push gate active)

added 1075 packages, and audited 1076 packages in 19s

319 packages are looking for funding
  run `npm fund` for details

45 vulnerabilities (5 low, 6 moderate, 30 high, 4 critical)

To address issues that do not require attention, run:
  npm audit fix

To address all issues (including breaking changes), run:
  npm audit fix --force

Run `npm audit` for details. before 
running 188 tests
test amplifier::reducer::tests::first_session_id_sticks ... ok
test amplifier::reducer::tests::orchestrator_complete_at_idle_is_a_no_op ... ok
test amplifier::reducer::tests::orchestrator_complete_ends_a_busy_turn_on_the_provider_error_path ... ok
test amplifier::reducer::tests::other_orchestrator_events_never_end_a_busy_turn ... ok
test amplifier::reducer::tests::orchestrator_complete_then_late_prompt_complete_completes_exactly_once ... ok
test amplifier::reducer::tests::prompt_complete_is_the_single_turn_boundary ... ok
test amplifier::reducer::tests::prompt_complete_then_orchestrator_complete_completes_exactly_once ... ok
test amplifier::reducer::tests::prompt_submit_begins_a_turn_and_confirms_without_duplicating ... ok
test amplifier::reducer::tests::schema_gate_degrades_once_and_goes_inert ... ok
test amplifier::reducer::tests::schema_gate_failure_kinds ... ok
test amplifier::reducer::tests::session_config_identifies_cwd ... ok
test amplifier::reducer::tests::session_end_ends_a_busy_turn_and_is_legal_at_idle ... ok
test amplifier::reducer::tests::subagent_indicators_are_observed_never_effects ... ok
test amplifier::reducer::tests::session_resume_and_noise_events_never_change_phase ... ok
test amplifier::reducer::tests::subagent_orchestrator_complete_never_ends_the_root_turn ... ok
test amplifier::tailer::tests::eof_attach_skips_history ... ok
test amplifier::tracker::tests::deadman_force_reads_but_stays_busy ... ok
test amplifier::tracker::tests::exit_removes_unconditionally ... ok
test amplifier::tracker::tests::empty_enter_force_reads_once_then_silently_reverts ... ok
test amplifier::tailer::tests::incremental_reads_only_consume_appended_bytes ... ok
test amplifier::tailer::tests::file_reset_degrades_never_guesses ... ok
test amplifier::tailer::tests::partial_trailing_line_is_buffered_until_completed ... ok
test amplifier::tracker::tests::iso_parse_matches_known_values ... ok
test amplifier::tracker::tests::output_feeds_the_deadman_only ... ok
test amplifier::tracker::tests::next_deadline_tracks_grace_then_deadman_then_none ... ok
test amplifier::tailer::tests::schema_gate_degrades_on_first_lifecycle_record ... ok
test amplifier::tailer::tests::prefilter_admits_orchestrator_complete ... ok
test amplifier::tracker::tests::prompt_complete_is_the_single_boundary_and_emits_one_completion ... ok
test amplifier::tracker::tests::pty_enter_is_provisional_and_prompt_submit_confirms ... ok
test amplifier::tailer::tests::prefilter_skips_noise_without_parsing ... ok
test amplifier::tracker::tests::session_identified_binds_and_flows_into_completions ... ok
test amplifier::tracker::tests::signal_loss_on_confirmed_busy_verifies_and_stays_busy ... ok
test amplifier::tracker::tests::signal_loss_on_provisional_busy_reverts_silently ... ok
test amplifier::tracker::tests::subagent_style_repeat_submits_never_double_begin ... ok
test amplifier::tracker::tests::verify_failed_clears_busy_and_rings_attention ... ok
test claude::tests::bel_during_provisional_confirms_and_completes ... ok
test claude::tests::bel_inside_osc_never_completes ... ok
test claude::tests::confirmable_enter_is_provisional_and_silently_reverts ... ok
test claude::tests::confirmed_submit_behaves_like_todays_turn ... ok
test claude::tests::deadman_requests_verify_and_stays_busy ... ok
test claude::tests::exit_removes_state_and_emits_remove ... ok
test claude::tests::next_deadline_exists_only_while_busy ... ok
test claude::tests::output_feeds_the_deadman ... ok
test claude::tests::probe_says_no_turn_reverts_immediately_and_unavailable_keeps_busy ... ok
test claude::tests::sandwiched_bell_from_a_subtool_never_completes ... ok
test claude::tests::session_binding_is_a_public_change_and_flows_into_completions ... ok
test claude::tests::stacked_submits_need_matching_bels ... ok
test claude::tests::submit_marks_busy_and_stop_bel_completes_exactly_once ... ok
test claude::tests::unconfirmable_enter_keeps_legacy_semantics ... ok
test claude::tests::verified_busy_refreshes_and_verify_failed_rings_attention ... ok
test claude::tests::verified_ended_clears_with_a_completion_bell ... ok
test codex::tests::absent_status_still_completes_for_the_bound_thread ... ok
test codex::tests::accepted_completion_clears_the_in_flight_proxy_turn_id ... ok
test codex::tests::approval_request_pauses_busy_to_idle_and_arms_a_boundary ... ok
test codex::tests::approval_request_without_thread_id_is_accepted ... ok
test codex::tests::approval_resolve_normalizes_pending_submit_input_state ... ok
test codex::tests::approval_resolved_returns_to_busy ... ok
test codex::tests::approval_resolved_with_no_prior_busy_stays_idle ... ok
test codex::tests::bel_clear_swallows_the_late_proxy_echo ... ok
test codex::tests::bel_clears_a_reconcile_promoted_busy_turn_exactly_once ... ok
test codex::tests::bel_echo_after_an_interrupted_clear_does_not_ring ... ok
test codex::tests::bind_session_is_idempotent_on_reannounce_and_emits_on_change ... ok
test codex::tests::bind_session_mid_turn_retroactively_stamps_the_completion ... ok
test codex::tests::bind_session_on_untracked_terminal_is_a_silent_noop ... ok
test codex::tests::busy_deadline_follows_the_force_read_rearm ... ok
test codex::tests::busy_deadman_defers_while_output_liveness_continues ... ok
test codex::tests::completion_without_turn_ids_falls_back_to_phase_semantics ... ok
test codex::tests::deadline_driven_expiry_converges_for_a_quiet_submit ... ok
test codex::tests::deadman_force_reads_and_stays_busy_then_repeats ... ok
test codex::tests::deadman_window_is_overridable_for_test_scale ... ok
test codex::tests::dup_bel_chunk_after_stale_busy_submit_completes_exactly_once ... ok
test codex::tests::duplicate_approval_request_does_not_rearm_the_boundary ... ok
test codex::tests::duplicate_bel_for_the_same_turn_is_deduped_by_turn_key ... ok
test codex::tests::exit_removes_the_record ... ok
test codex::tests::failed_status_records_a_completion ... ok
test codex::tests::failed_with_queued_submit_behaves_exactly_like_completed_with_queued_submit ... ok
test codex::tests::foreign_thread_approval_request_is_ignored ... ok
test codex::tests::foreign_thread_turn_started_does_not_promote_busy ... ok
test codex::tests::fresh_submit_disarms_all_swallow_flags ... ok
test codex::tests::has_pending_approvals_tracks_the_pending_set ... ok
test codex::tests::in_progress_status_is_a_no_op ... ok
test codex::tests::interrupted_status_clears_busy_without_completion ... ok
test codex::tests::long_streaming_turn_survives_the_pending_gate_via_output_liveness ... ok
test codex::tests::mid_pause_turn_end_silences_the_bel_echo_and_clears_anchors ... ok
test codex::tests::next_deadline_exists_only_while_pending_or_busy ... ok
test codex::tests::proxy_clear_swallows_the_late_pty_bel_echo ... ok
test codex::tests::proxy_start_disarms_a_stale_proxy_swallow ... ok
test codex::tests::proxy_turn_completes_exactly_once_per_turn ... ok
test codex::tests::proxy_turn_started_promotes_idle_to_busy ... ok
test codex::tests::queued_submit_does_not_block_the_approval_boundary ... ok
test codex::tests::queued_submit_rearms_pending_after_the_bel_and_completes_each_turn ... ok
test codex::tests::quiet_noop_submit_decays_to_idle_without_completion ... ok
test codex::tests::rebind_clears_stale_in_flight_proxy_turn_state ... ok
test codex::tests::reconcile_abort_with_interrupted_reason_clears_without_completing ... ok
test codex::tests::reconcile_abort_with_replaced_reason_clears_without_completing ... ok
test codex::tests::reconcile_abort_with_unknown_reason_records_a_completion ... ok
test codex::tests::reconcile_abort_without_reason_clears_without_completing ... ok
test codex::tests::reconcile_clear_completes_a_seeded_busy_turn_with_identity ... ok
test codex::tests::reconcile_clear_completes_a_pending_pty_turn_exactly_once ... ok
test codex::tests::reconcile_clear_swallows_the_late_proxy_echo ... ok
test codex::tests::reconcile_clear_with_queued_submit_swallows_the_late_bel_echo ... ok
test codex::tests::reconcile_ignores_an_already_resolved_rollout ... ok
test codex::tests::reconcile_on_untracked_terminal_is_a_noop ... ok
test codex::tests::reconcile_one_batch_historical_start_before_pending_submit_records_nothing ... ok
test codex::tests::reconcile_one_batch_start_and_clear_on_a_pending_turn_with_newer_start_completes ... ok
test codex::tests::reconcile_one_batch_start_and_clear_on_a_pending_turn_with_older_start_rearms ... ok
test codex::tests::reconcile_seeds_busy_for_an_unresolved_rollout ... ok
test codex::tests::reconcile_task_complete_at_or_after_an_abort_still_completes ... ok
test codex::tests::reconcile_task_started_during_pending_approval_does_not_flip_busy ... ok
test codex::tests::reconcile_turn_aborted_clears_without_completing ... ok
test codex::tests::resumed_output_disarms_the_fired_deadman_anchor ... ok
test codex::tests::session_identity_from_create_flows_into_records_and_completions ... ok
test codex::tests::stale_completion_for_a_previous_turn_id_is_ignored ... ok
test codex::tests::subagent_thread_turn_completed_mid_parent_turn_is_ignored ... ok
test codex::tests::submit_enters_pending_and_bel_completes_once ... ok
test codex::tests::submit_into_stale_busy_starts_fresh_pending_and_completes_once ... ok
test codex::tests::swallowed_and_idle_arm_proxy_echoes_retire_the_in_flight_turn_id ... ok
test codex::tests::track_terminal_rebind_branch_updates_identity_in_place ... ok
test codex::tests::turn_completion_clears_pending_approvals ... ok
test codex::tests::unbound_terminal_ignores_proxy_turn_events ... ok
test idle::tests::a_second_boundary_rearms_the_full_window ... ok
test idle::tests::activity_without_a_pending_window_arms_nothing ... ok
test idle::tests::boundary_after_the_idle_flip_arms_normally ... ok
test idle::tests::boundary_then_quiet_grace_emits_exactly_once ... ok
test idle::tests::boundary_while_busy_then_drain_emits_queue_empty ... ok
test idle::tests::busy_phase_report_cancels_a_pending_window ... ok
test idle::tests::codex_busy_to_pending_rearm_counts_as_queue_evidence ... ok
test idle::tests::busy_reentry_cancels_the_pending_emission ... ok
test idle::tests::default_gate_uses_the_production_grace_window ... ok
test idle::tests::evidence_resets_after_an_emission ... ok
test idle::tests::exit_discards_queue_evidence_with_the_rest_of_the_state ... ok
test idle::tests::exit_cancels ... ok
test idle::tests::expire_never_emits_while_busy_even_with_a_stale_deadline ... ok
test idle::tests::idle_phase_report_is_inert ... ok
test idle::tests::is_engaged_reflects_confirmed_busy_and_armed_deadlines_but_never_input_pending ... ok
test idle::tests::next_deadline_reflects_the_earliest_window ... ok
test idle::tests::pending_phase_counts_as_busy_for_the_boundary_gate ... ok
test idle::tests::pending_to_pending_is_not_queue_evidence ... ok
test idle::tests::session_file_activity_extends_the_window ... ok
test idle::tests::turn_boundary_while_busy_never_arms ... ok
test ledger::tests::latest_completions_keep_first_completion_order_with_latest_values ... ok
test ledger::tests::seq_is_monotonic_per_terminal_and_survives_retrack ... ok
test opencode::tests::abort_then_idle_clears_silently ... ok
test opencode::tests::abort_mid_pause_force_emits_the_cancel ... ok
test opencode::tests::ambiguous_drain_via_idle_clears_stale_pause_claim ... ok
test opencode::tests::ambiguous_drain_via_snapshot_clears_stale_pause_claim ... ok
test opencode::tests::ambiguous_repromotes_on_single_root_snapshot_and_then_bells ... ok
test opencode::tests::ambiguous_is_conservative_no_completions ... ok
test opencode::tests::ambiguous_with_two_true_roots_stays_conservative ... ok
test opencode::tests::busy_snapshot_does_not_clear_an_outstanding_pause ... ok
test opencode::tests::ambiguous_repromotes_when_single_root_differs_from_known ... ok
test opencode::tests::child_abort_does_not_gate_the_root ... ok
test opencode::tests::busy_snapshot_refresh_rearms_the_abort_gate ... ok
test opencode::tests::child_idle_is_suppressed_and_child_busy_remaps_to_root ... ok
test opencode::tests::child_permission_asked_resolves_to_root_and_arms ... ok
test opencode::tests::completed_turn_emits_remove_then_turn_complete ... ok
test opencode::tests::deadman_expiry_requests_verify_and_stays_busy ... ok
test opencode::tests::completion_mid_pause_mints_nothing ... ok
test opencode::tests::double_session_idle_is_deduped ... ok
test opencode::tests::death_predicates ... ok
test opencode::tests::failed_turn_rings_and_trailing_error_is_noop ... ok
test opencode::tests::first_turn_busy_root_binds_directly_and_is_death_eligible ... ok
test opencode::tests::permission_asked_demotes_then_arms_once ... ok
test opencode::tests::first_turn_pause_arms_and_completion_is_swallowed ... ok
test opencode::tests::permission_replied_resumes_busy ... ok
test opencode::tests::permissions_sync_drains_stale_pauses ... ok
test opencode::tests::retry_status_counts_as_busy ... ok
test opencode::tests::session_status_idle_then_session_idle_yields_one_completion ... ok
test opencode::tests::snapshot_empty_completes_a_known_busy_turn ... ok
test opencode::tests::snapshot_single_foreign_busy_from_quiet_known_rebinds ... ok
test opencode::tests::superseded_session_rebinds_directly ... ok
test opencode::tests::stale_cycle_idle_is_ignored ... ok
test opencode::tests::verify_failed_clears_busy_and_rings_attention ... ok
test opencode::tests::w2_abort_marker_gates_like_session_error ... ok
test opencode::tests::verify_snapshot_busy_keeps_the_record_and_empty_clears_with_completion ... ok
test signal::tests::bracketed_paste_framing_rules ... ok
test signal::tests::extract_counts_a_bare_bel_and_strips_it ... ok
test signal::tests::decrqm_reports_do_not_poison ... ok
test signal::tests::extract_passes_through_for_non_signal_modes ... ok
test signal::tests::extract_ignores_bels_inside_osc_sequences ... ok
test signal::tests::is_submit_input_matches_the_reference_regex ... ok
test signal::tests::extract_tracks_osc_state_across_chunks ... ok
test signal::tests::quit_intent_classification_rules ... ok
test signal::tests::tracker_count_rejects_a_sandwiched_bell ... ok
test signal::tests::tracker_count_accepts_leading_and_trailing_bels ... ok
test signal::tests::tracker_count_respects_carried_state ... ok
test signal::tests::tracker_count_skips_escape_enclosed_bels ... ok
test amplifier::tailer::tests::oversized_line_is_dropped_without_degrading ... ok

test result: ok. 188 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s


running 3 tests
test tests::check_auth_is_constant_time_and_rejects_absent ... ok
test tests::health_body_matches_original_seven_field_shape ... ok
test tests::health_body_satisfies_electron_discovery_predicate ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 180 tests
test app_server::tests::non_initialize_request_gates_on_initialize_first ... ok
test app_server::tests::disconnect_fails_inflight_requests_as_closed ... ok
test app_server::tests::initialize_handshake_sends_request_then_initialized_notification ... ok
test app_server::tests::compact_thread_sends_thread_compact_start_with_only_the_thread_id ... ok
test app_server::tests::compact_thread_surfaces_an_rpc_error_with_the_method_name ... ok
test app_server::tests::fork_thread_surfaces_an_rpc_error_with_the_method_name ... ok
test app_server::tests::snapshot_read_timeout_ms_matches_the_documented_30_second_budget ... ok
test app_server::tests::fork_thread_omits_absent_optional_keys ... ok
test app_server::tests::rpc_error_reply_surfaces_as_rpc_error ... ok
test app_server::tests::fork_thread_serializes_without_exclude_turns_with_last_turn_id_and_returns_the_raw_result ... ok
test app_server::tests::read_thread_sends_thread_id_and_include_turns_and_returns_raw_result ... ok
test durability::tests::codex_thread_id_shape_is_a_bare_uuid ... ok
test durability::tests::history_mode_wire_and_meta_parse ... ok
test app_server::tests::archive_thread_and_unarchive_thread_send_their_method_names_with_only_thread_id ... ok
test app_server::tests::turn_completed_notification_reaches_the_consumer ... ok
test durability::tests::ownership_id_and_needle_shapes ... ok
test durability::tests::rollout_filename_yields_embedded_thread_uuid ... ok
test durability::tests::server_instance_id_defaults_to_srv_pid_without_env ... ok
test events::tests::absent_status_never_chimes_but_still_snapshots ... ok
test events::tests::completed_flat_status_also_chimes ... ok
test events::tests::completed_status_chimes_exactly_once_after_the_idle_snapshot ... ok
test events::tests::failed_status_never_chimes ... ok
test durability::tests::read_rollout_history_mode_parses_the_meta_of_an_explicit_root ... ok
test events::tests::in_progress_status_never_chimes ... ok
test events::tests::inline_turn_status_wins_over_flat_status ... ok
test events::tests::interrupted_status_emits_snapshot_but_never_chimes ... ok
test events::tests::other_thread_completion_is_ignored ... ok
test events::tests::successive_completions_get_strictly_increasing_at_even_in_same_millisecond ... ok
test events::tests::thread_started_carries_updated_at_revision ... ok
test events::tests::thread_closed_and_exit_emit_exited_with_no_chime ... ok
test durability::tests::locate_rollout_proves_ownership_by_the_session_meta_first_line ... ok
test events::tests::thread_status_changed_clears_active_turn_when_not_running ... ok
test events::tests::thread_status_normalization_matches_reference ... ok
test json_scan::tests::scan_object_records_entry_spans ... ok
test json_scan::tests::parse_bounded_string_decodes_unicode_escape ... ok
test launch_plan::tests::binding_reason_is_none_for_non_codex_modes ... ok
test launch_lifecycle::tests::drain_forwards_tagged_events_to_the_sink ... ok
test launch_plan::tests::binding_reason_is_resume_for_codex_with_resume_id ... ok
test launch_lifecycle::tests::drain_without_a_sink_discards_and_survives ... ok
test launch_plan::tests::binding_reason_is_start_for_fresh_codex ... ok
test launch_plan::tests::binding_reason_treats_empty_resume_id_as_start_like_ts_falsiness ... ok
test launch_plan::tests::binding_reason_wire_strings_match_registry_events ... ok
test launch_plan::tests::empty_resume_session_id_plans_a_fresh_launch_like_ts_falsiness ... ok
test launch_plan::tests::every_codex_launch_plan_requires_the_proxy ... ok
test launch_plan::tests::fresh_launch_plan_golden ... ok
test launch_plan::tests::launch_plan_passes_provider_settings_through_normalized ... ok
test launch_plan::tests::invalid_sandbox_fails_the_plan_with_a_config_error ... ok
test launch_plan::tests::managed_launch_env_name_is_pinned ... ok
test launch_plan::tests::managed_launch_defaults_on_and_only_zero_disables ... ok
test launch_plan::tests::managed_remote_config_args_match_codex_managed_config_ts ... ok
test launch_plan::tests::remote_args_accept_a_loopback_ws_url_without_a_port ... ok
test launch_plan::tests::remote_args_emit_the_managed_four_tuple_for_a_loopback_ws_url ... ok
test launch_plan::tests::remote_args_error_messages_match_terminal_registry ... ok
test launch_plan::tests::remote_args_never_panic_on_malformed_input ... ok
test launch_plan::tests::remote_args_reject_non_loopback_hosts ... ok
test launch_plan::tests::remote_args_reject_non_ws_schemes_as_non_loopback ... ok
test launch_plan::tests::remote_args_reject_unparseable_urls_as_invalid ... ok
test launch_plan::tests::resume_launch_plan_golden ... ok
test launch_plan::tests::retry_defaults_match_launch_retry_ts ... ok
test launch_plan::tests::retry_delay_saturates_instead_of_panicking ... ok
test app_server::tests::start_turn_forwards_effort_verbatim_on_the_wire ... ok
test launch_plan::tests::retry_gives_up_when_attempts_are_exhausted ... ok
test launch_plan::tests::retry_never_retries_configuration_errors ... ok
test launch_plan::tests::retry_uses_linear_backoff_for_transient_failures ... ok
test launch_plan::tests::sandbox_accepts_the_three_valid_modes ... ok
test launch_plan::tests::sandbox_normalizes_ts_falsy_inputs_to_none ... ok
test launch_plan::tests::sandbox_rejects_unknown_values_with_the_exact_legacy_message ... ok
test launch_plan::tests::sandbox_wire_strings_round_trip ... ok
test launch_plan::tests::sidecar_spawn_spec_golden ... ok
test model::tests::dev_0003_full_pipeline_keeps_none_minimal_verbatim_for_spark ... ok
test model::tests::dev_0003_none_and_minimal_forward_verbatim ... ok
test launch_plan::tests::sidecar_spawn_spec_places_context_before_app_server_and_redacts_values ... ok
test model::tests::effort_for_unknown_model_uses_default_model_menu ... ok
test model::tests::effort_menu_for_gpt_56_models_keeps_current_reasoning_levels ... ok
test model::tests::max_and_xhigh_map_to_xhigh_on_the_wire ... ok
test model::tests::effort_menu_normalization_matches_reference ... ok
test model::tests::model_clamps_to_freshcodex_allowlist ... ok
test json_scan::tests::skip_value_survives_adversarially_deep_nesting_without_recursion ... ok
test model::tests::unsupported_effort_errors_like_the_reference ... ok
test model::tests::undefined_effort_stays_undefined ... ok
test protocol::server_approval_requests_are_not_dropped_as_malformed_responses ... ok
test protocol::tests::classifies_thread_lifecycle_and_fs_changed ... ok
test protocol::tests::classifies_turn_completed_flat_and_inline_shapes ... ok
test protocol::tests::classifies_turn_events_read_the_inline_turn_id_shape ... ok
test protocol::tests::classifies_turn_started_with_extra_fields ... ok
test protocol::tests::drops_malformed_and_incomplete_frames ... ok
test protocol::tests::extract_turn_event_started_and_rejections ... ok
test protocol::tests::notification_frame_omits_params_when_absent ... ok
test protocol::tests::extract_turn_event_validates_all_statuses ... ok
test protocol::tests::parses_error_envelope ... ok
test protocol::tests::parses_notification_and_tolerates_jsonrpc_tag ... ok
test protocol::tests::parses_success_envelope ... ok
test protocol::tests::parses_string_request_ids_too ... ok
test protocol::tests::request_frame_has_id_method_params_and_no_jsonrpc_tag ... ok
test protocol::tests::turn_status_prefers_inline_then_flat ... ok
test protocol::tests::unknown_notification_is_other ... ok
test remote_proxy::tests::envelope_id_to_request_id_bridges_strings_and_small_integers_losslessly ... ok
test remote_proxy::tests::envelope_id_to_request_id_rejects_fractional_and_out_of_range_numbers ... ok
test remote_proxy::tests::extract_thread_fork_parent_thread_id_is_none_for_malformed_or_missing_shapes ... ok
test remote_proxy_envelope::tests::accepts_plain_byte_slice_input_including_multi_byte_utf8 ... ok
test remote_proxy::tests::extract_thread_fork_parent_thread_id_reads_the_original_pre_rewrite_frame ... ok
test remote_proxy_envelope::tests::classifies_malformed_json_and_scalar_roots_as_unsafe ... ok
test remote_proxy_envelope::tests::classifies_root_arrays_as_unsupported_batches_not_non_object_traffic ... ok
test remote_proxy_envelope::tests::decodes_escaped_top_level_property_names_and_escaped_string_values ... ok
test remote_proxy_envelope::tests::duplicate_key_recorded_only_once_even_with_three_repeats ... ok
test remote_proxy_envelope::tests::extracts_top_level_method_and_string_or_integer_ids_regardless_of_field_order ... ok
test remote_proxy_envelope::tests::ignores_invalid_json_rpc_id_types_without_coercion ... ok
test remote_proxy_envelope::tests::matches_js_number_parsing_for_bounded_large_integer_ids ... ok
test remote_proxy_envelope::tests::never_panics_on_arbitrary_or_malformed_or_empty_input ... ok
test remote_proxy_envelope::tests::reports_duplicate_top_level_keys_while_matching_bounded_json_parse_last_wins_semantics ... ok
test remote_proxy_envelope::tests::unrelated_duplicate_top_level_keys_are_reported_too ... ok
test remote_proxy_envelope::tests::rejects_overlarge_top_level_tokens_that_would_need_to_be_decoded ... ok
test remote_proxy_side_effects::tests::appends_exclude_turns_to_an_existing_params_object_that_lacks_it ... ok
test remote_proxy_side_effects::tests::creates_params_when_the_fork_request_omits_params ... ok
test remote_proxy_side_effects::tests::changes_false_and_null_exclude_turns_values_to_true_while_preserving_true ... ok
test remote_proxy_side_effects::tests::adds_result_thread_turns_when_upstream_omitted_it ... ok
test remote_proxy_side_effects::tests::decodes_escaped_params_and_exclude_turns_keys ... ok
test remote_proxy_side_effects::tests::does_not_use_nested_decoy_fields_over_owned_paths_and_fails_cleanly_on_malformed_frames ... ok
test remote_proxy_side_effects::tests::every_extractor_never_panics_on_arbitrary_or_malformed_bytes ... ok
test remote_proxy_side_effects::tests::extracts_thread_closed_and_thread_status_changed_lifecycle_metadata ... ok
test remote_proxy_side_effects::tests::normalize_rejects_root_arrays_and_duplicate_owned_keys ... ok
test remote_proxy_side_effects::tests::preserves_unrelated_top_level_and_params_fields ... ok
test remote_proxy_side_effects::tests::fails_closed_for_duplicate_params_or_duplicate_exclude_turns_keys ... ok
test remote_proxy_side_effects::tests::preserves_an_existing_bounded_turns_array_plus_unrelated_fields ... ok
test remote_proxy_side_effects::tests::returns_a_structured_failure_for_root_arrays_and_batches ... ok
test remote_proxy_side_effects::tests::rejects_turn_completed_side_effects_with_malformed_status_values ... ok
test remote_proxy_side_effects::tests::uses_remembered_parent_attribution_and_refuses_missing_parent_ids ... ok
test sidecar_store::tests::disabled_store_is_a_silent_noop ... ok
test remote_proxy_side_effects::tests::returns_structured_failures_for_malformed_frames_and_non_object_params_values ... ok
test remote_proxy_envelope::tests::uses_only_top_level_ids_even_when_nested_ids_appear_first_or_after_large_results ... ok
test remote_proxy_side_effects::tests::rejects_unsafe_fork_response_candidates ... ok
test sidecar_sweep::tests::reap_grace_parse_honors_value_zero_and_default ... ok
test remote_proxy_side_effects::tests::extractors_never_panic_across_a_seeded_corpus_of_shuffled_json_fragments ... ok
test remote_proxy_envelope::tests::skips_adversarially_deep_nested_values_without_overflowing_the_call_stack ... ok
test sidecar_store::tests::lane_field_roundtrips_and_legacy_rows_decode_with_lane_none ... ok
test remote_proxy_envelope::tests::matches_bounded_json_parse_semantics_for_a_deterministic_corpus_of_top_level_envelopes ... ok
test sidecar_store::tests::proc_starttime_identifies_a_live_child_and_none_after_exit ... ok
test sidecar_store::tests::verify_identity_confirms_own_spawned_child ... ok
test sidecar_store::tests::verify_identity_rejects_cmdline_mismatch_without_signalling ... ok
test sidecar_store::tests::second_locked_open_comes_up_disabled ... ok
test sidecar_reconcile::tests::boot_reconcile_never_indexes_freshagent_lane_records_for_claim ... ok
test remote_proxy_side_effects::tests::extracts_fs_changed_repair_triggers_and_collapses_oversized_changed_paths ... ok
test sidecar_reconcile::tests::duplicate_session_records_claim_one_keep_the_loser_held ... ok
test app_server::tests::request_times_out_when_the_server_never_replies ... ok
test remote_proxy_side_effects::tests::rewrites_large_fork_requests_without_full_frame_parse ... ok
test sidecar_store::tests::verify_identity_reports_dead_for_missing_pid ... ok
test sidecar_store::tests::record_roundtrips_through_disk ... ok
test sidecar_store::tests::write_is_atomic_sibling_tmp_then_rename ... ok
test sidecar_store::tests::corrupt_record_is_quarantined_not_fatal ... ok
test sidecar_reconcile::tests::boot_reconcile_holds_sessionless_records_for_the_sweep ... ok
test remote_proxy_side_effects::tests::extracts_a_thread_fork_response_candidate_using_result_thread_path ... ok
test sidecar_reconcile::tests::claim_reverifies_identity_at_claim_time ... ok
test remote_proxy_side_effects::tests::rejects_root_arrays_ambiguous_duplicate_keys_and_non_pending_ids ... ok
test remote_proxy_side_effects::tests::extracts_a_thread_start_response_candidate_with_huge_turns ... ok
test sidecar_reconcile::tests::claim_for_session_returns_each_record_once ... ok
test app_server::tests::start_turn_is_unaffected_by_the_longer_read_timeout ... ok
test sidecar_reconcile::tests::boot_reconcile_prunes_dead_and_mismatched_records ... ok
test remote_proxy_side_effects::tests::extracts_thread_started_notification_candidate_and_lifecycle ... ok
test remote_proxy_side_effects::tests::extracts_turn_started_and_completed_metadata_when_the_turn_body_is_huge ... ok
test app_server::tests::read_thread_honors_the_longer_read_timeout_not_the_request_timeout ... ok
test app_server::tests::resume_thread_honors_the_longer_read_timeout_not_the_request_timeout ... ok
test sidecar_reconcile::tests::select_codex_runtime_prefers_a_claimable_survivor ... ok
test sidecar_reconcile::tests::duplicate_claim_prefers_the_live_writer_over_newer_updated_at ... ok
test sidecar_reconcile::tests::reattach_ensure_ready_returns_the_existing_listener ... ok
test sidecar_sweep::tests::late_restore_after_sweep_reattaches_mid_turn_survivor ... ok
test sidecar_reconcile::tests::reattach_reaps_verified_but_unusable_survivor ... ok
test sidecar_sweep::tests::sweep_never_touches_unverified_pids ... ok
test sidecar_sweep::tests::kill_tree_root_refusal_skips_captured_descendants ... ok
test sidecar_sweep::tests::unverifiable_verdict_decides_retain_and_commit_records_reason ... ok
test sidecar_sweep::tests::sweep_retains_ws_unreachable_writer_holding_survivor ... ok
test sidecar_sweep::tests::sweep_reaps_verified_idle_unclaimed_sidecar ... ok
test sidecar_sweep::tests::kill_verified_sidecar_tree_reaps_descendants ... ok
test sidecar_reconcile::tests::reattach_refuses_on_identity_mismatch_without_signalling ... ok
test sidecar_sweep::tests::sweep_never_kills_a_record_claimed_during_the_probe_window ... ok
test sidecar_sweep::tests::restart_reconciliation_leaves_no_sidecar_silently_orphaned ... ok
test sidecar_sweep::tests::sweep_retains_mid_turn_sidecar_with_recorded_reason ... ok
test sidecar_sweep::tests::sweep_treats_malformed_loaded_list_as_unreachable_not_idle ... ok
test sidecar_reconcile::tests::reattach_shutdown_kills_only_after_reverification ... ok
test sidecar_sweep::tests::kill_tree_reports_sigterm_sent_when_escalation_is_refused ... ok
test app_server::tests::read_thread_survives_past_the_production_default_request_timeout ... ok

test result: ok. 180 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.51s


running 6 tests
test client_request_frames_carry_no_jsonrpc_tag ... ok
test thread_revert_uses_the_experimental_wire_shape ... ok
test rpc_error_on_turn_start_surfaces_to_the_caller ... ok
test full_drive_interrupted_turn_does_not_chime ... ok
test full_drive_completed_turn_emits_the_positive_edge_with_verbatim_effort ... ok
test thread_start_sets_paginated_history_mode_and_resume_never_sends_it ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 6 tests
test resume_proxy_does_not_gate ... ok
test held_bytes_cap_fails_the_capture ... ok
test fail_candidate_capture_rejects_held_frames ... ok
test hold_queue_overflow_fails_the_capture ... ok
test capture_timeout_rejects_held_frames_and_emits_repair_trigger ... ok
test turn_start_is_held_until_mark_candidate_persisted ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.58s


running 3 tests
test absent_status_and_foreign_thread_never_chime ... ok
test only_completed_advances_the_monotonic_clock ... ok
test each_status_gates_the_completion_edge_in_both_wire_shapes ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 1 test
test installed_manager_is_returned_by_global_and_set_twice_fails ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s


running 1 test
test interrupt_turn_rpc_then_interrupted_completion_snapshots_without_chime ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 40 tests
test adopt_after_sidecar_shutdown_is_rejected_with_the_legacy_message ... ok
test adopt_transfers_ownership_out_of_the_planner ... ok
test manager_exit_for_unknown_terminal_is_a_noop ... ok
test fresh_plan_starts_a_real_proxy_with_candidate_persistence_on ... ok
test failed_adoption_discards_the_still_owned_launch ... ok
test mark_candidate_persisted_is_a_noop_for_unknown_terminals ... ok
test manager_note_session_id_reaches_adopted_runtime ... ok
test retry_never_retries_configuration_errors ... ok
test plan_create_notes_the_resume_session_id_on_the_runtime ... ok
test manager_discard_tears_down_an_unadopted_plan ... ok
test planner_shutdown_rejects_new_plans_with_the_legacy_message ... ok
test planning_error_tears_the_sidecar_down_and_surfaces_the_error ... ok
test retain_failure_still_blocks_a_later_shutdown_kill ... ok
test planner_shutdown_tears_down_unadopted_sidecars ... ok
test resume_plan_sets_session_id_and_disables_candidate_persistence ... ok
test sidecar_shutdown_is_idempotent ... ok
test retry_gives_up_after_the_attempt_budget_on_transient_failures ... ok
test relay_works_through_the_planned_proxy ... ok
test restore_class_plan_wait_cancels_when_the_watch_fires ... ok
test manager_adopts_by_terminal_id_and_tears_down_on_exit ... ok
test discard_sync_outside_runtime_context_does_not_panic ... ok
test discard_sync_tears_down_an_unadopted_plan ... ok
test restore_class_queue_overflow_fails_loud_as_queue_full ... ok
test ensure_ready_persists_a_verified_sidecar_record ... ok
test drop_without_shutdown_with_disabled_store_keeps_the_kill_on_drop_backstop ... ok
test spawned_runtime_launches_the_app_server_and_relays_through_the_proxy ... ok
test retention_with_disabled_store_tears_down_as_today ... ok
test spawned_runtime_note_session_id_enriches_the_record ... ok
test runtime_shutdown_removes_the_sidecar_record ... ok
test shutdown_still_tears_down_unadopted_planner_sidecars ... ok
test update_ownership_metadata_enriches_the_record ... ok
test plan_retry_falls_back_to_fresh_spawn_after_reattach_failure ... ok
test third_concurrent_plan_fails_fast_on_the_sidecar_budget ... ok
test plan_retry_spawns_fresh_after_claimed_reattach_ensure_ready_fails ... ok
test notify_terminal_exit_retains_under_retention_flag ... ok
test spawned_runtime_receives_context_but_reattached_runtime_does_not ... ok
test spawned_sidecar_survives_runtime_drop_without_shutdown ... ok
test shutdown_retention_retains_adopted_sidecars_and_records_reason ... ok
test eight_restore_class_plans_queue_and_drain_without_error ... ok
test manager_shutdown_tears_down_adopted_and_unadopted_and_rejects_new_plans ... ok

test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.01s


running 28 tests
test approval_request_without_thread_id_yields_none ... ok
test approval_request_frame_emits_approval_requested_and_relays_verbatim ... ok
test approval_response_emits_approval_resolved_and_forwards_upstream ... ok
test error_response_also_resolves ... ok
test close_tears_down_active_connections_and_stops_accepting_new_ones ... ok
test tui_clean_disconnect_closes_the_upstream_connection ... ok
test thread_fork_request_is_rewritten_to_exclude_turns_before_forwarding ... ok
test fs_changed_notification_emits_a_repair_trigger ... ok
test legacy_approval_reads_conversation_id ... ok
test thread_started_notification_yields_candidate_and_thread_started_lifecycle ... ok
test upstream_clean_disconnect_closes_the_tui_and_emits_a_proxy_close_repair_trigger ... ok
test thread_start_response_is_relayed_unchanged_and_yields_a_candidate_event ... ok
test relays_a_small_non_stateful_request_and_response_byte_identical_both_ways ... ok
test server_request_resolved_notification_resolves ... ok
test upstream_reconnect_clears_pending_approvals ... ok
test thread_fork_response_is_normalized_for_the_tui_and_yields_a_candidate ... ok
test malformed_frame_from_upstream_fails_closed_without_crashing ... ok
test turn_started_and_completed_notifications_carry_full_params_for_small_frames ... ok
test malformed_json_from_the_tui_is_rejected_with_an_error_and_the_proxy_survives ... ok
test rejects_client_frames_over_max_raw_forward_bytes_with_error_and_closes ... ok
test frames_are_relayed_in_order_in_both_directions ... ok
test a_slow_tui_consumer_does_not_lose_messages_from_upstream ... ok
test relays_frames_larger_than_max_full_parse_bytes_raw_forward_passthrough ... ok
test client_response_with_unknown_id_emits_nothing ... ok
test client_frame_with_id_and_method_never_resolves ... ok
test non_approval_server_request_is_relayed_without_events ... ok
test unknown_server_request_method_is_logged_not_belled ... ok
test interrupt_for_an_already_completed_turn_is_acknowledged_without_reaching_upstream ... ok

test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.36s


running 10 tests
test validate::tests::content_schema_uses_js_own_key_order_for_numeric_keys ... ok
test validate::tests::content_schema_output_preserves_manifest_field_order ... ok
test validate::tests::env_record_output_preserves_manifest_order ... ok
test validate::tests::cli_full_surface_round_trips_key_for_key ... ok
test validate::tests::field_type_as_str_matches_js_typeof_names ... ok
test validate::tests::issue_display_is_log_friendly ... ok
test validate::tests::env_record_uses_js_own_key_order_for_numeric_keys ... ok
test validate::tests::parse_manifest_splits_invalid_json_from_invalid_manifest ... ok
test validate::tests::proto_key_is_skipped_in_records_but_rejected_in_strict_objects ... ok
test validate::tests::union_default_failure_is_single_invalid_union_no_refine ... ok

test result: ok. 10 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


running 2 tests
test frozen_fixture_is_nonempty_and_schema_mutations_are_rejected ... ok
test oracle_conformance ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s


running 1154 tests
test claude::tests::a_claim_commit_against_an_advanced_dead_state_refuses_every_side_effect ... ok
test claude::tests::a_claim_is_refused_when_the_seat_it_rides_carries_a_close_fence_and_commits_over_a_clean_seat ... ok
test claude::tests::a_kill_naming_a_bare_placeholder_resolves_the_persisted_alias_record_into_the_retire_set ... ok
test claude::tests::approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error ... ok
test claude::tests::attach_durable_id_prefers_session_ref_over_legacy ... ok
test claude::tests::attach_untracked_without_any_durable_id_still_emits_lost_frame ... ok
test claude::tests::commit_session_claim_clears_every_fence_and_revives_rollback_re_raises_all_of_it ... ok
test claude::tests::compact_candidate_publication_is_atomic_under_the_tracker_lock ... ok
test claude::tests::attach_with_durable_id_already_indexed_rebinds_and_acks ... ok
test claude::tests::control_lines_are_not_forwarded_as_events ... ok
test claude::tests::emit_pending_cancellations_maps_every_parked_entry ... ok
test claude::tests::fold_normalizes_question_definitions_to_the_strict_contract_shape ... ok
test claude::tests::half_fenced_kill_refusal_carries_the_typed_invalid_fence_code ... ok
test claude::tests::handle_attach_untracked_kilroy_session_keeps_kilroy_session_type ... ok
test claude::tests::handle_attach_refuses_each_half_fenced_observation_typed ... ok
test claude::tests::handle_attach_untracked_session_emits_lost_session_frame ... ok
test claude::tests::handle_attach_tracked_session_broadcasts_nothing ... ok
test claude::tests::handle_interrupt_errors_for_unknown_session ... ok
test claude::tests::consumer_folds_permission_and_question_frames_into_the_pending_set ... ok
test claude::tests::handle_kill_after_the_alias_ttl_with_a_still_bound_row_still_retires_the_durable ... ok
test claude::tests::handle_kill_of_an_evicted_session_still_retires_the_row_it_names ... ok
test claude::tests::handle_kill_of_unknown_session_still_broadcasts_success ... ok
test claude::tests::a_compaction_starting_behind_the_absorb_aborts_at_the_quiesce_probes_recheck ... ok
test claude::tests::a_kill_whose_durable_close_fails_reports_failure_and_touches_no_live_state ... ok
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx{"type":"send","sessionId":"rb-small-pipe","text":"/compact"}
test claude::tests::a_small_fixture_pipe_blocks_compact_until_the_reader_resumes ... ok
test claude::tests::handle_rollback_redo_without_a_record_is_redo_unavailable ... ok
test claude::tests::a_kill_whose_close_persists_despite_the_reported_error_ends_the_session_and_fails_visibly ... ok
test claude::tests::a_failed_compact_write_reverts_the_armed_tracker_and_releases_the_spent_busy_truth ... ok
test claude::tests::a_failed_compact_write_keeps_the_gate_closed_while_a_garlanded_send_is_owed ... ok
test claude::tests::a_compaction_starting_mid_rollback_aborts_at_the_pre_teardown_recheck ... ok
test claude::tests::a_compact_handed_in_the_probes_tick_aborts_on_the_verdict_alone ... ok
test claude::tests::kill_for_handoff_confirms_the_tagged_tree_dead_before_reporting_reaped ... ok
test claude::tests::a_compact_with_two_garlanded_sends_holds_busy_until_the_last_sends_terminal_edge ... ok
test claude::tests::kill_for_handoff_withholds_reaped_while_a_lingering_descendant_survives ... ok
test claude::tests::normalize_maps_the_known_sdk_set_and_ignores_others ... ok
test claude::tests::ownership_id_is_unique_and_tagged ... ok
test claude::tests::question_request_broadcast_keeps_the_verbatim_payload ... ok
test claude::tests::a_dropped_compact_extinguishes_only_compacts_ahead_of_the_evidencing_send ... ok
test claude::tests::a_dropped_compacts_remnant_debt_absorbs_at_the_gate_after_the_running_compact_retires_it ... ok
test claude::tests::a_refused_configure_surfaces_the_banner_error_and_converges_nothing ... ok
test claude::tests::a_rejected_interrupt_never_retires_the_running_turn ... ok
test claude::tests::a_revived_absorbed_compact_closes_the_gate_at_its_status_frame_not_just_its_boundary ... ok
test claude::tests::a_settings_changing_send_broadcasts_session_metadata ... FAILED
test claude::tests::a_send_between_the_arm_and_the_prior_result_keeps_the_gate_closed_through_both ... ok
test claude::tests::a_signed_session_not_found_error_opens_the_gate_instead_of_wedging_it ... ok
test claude::tests::a_stale_quiesced_frame_never_closes_a_live_rollback_probe ... ok
test claude::tests::a_turns_trailing_idle_is_pair_skipped_never_attributed_to_queued_ops ... ok
test claude::tests::a_surviving_alias_tombstone_never_retires_a_durable_a_live_session_claims ... ok
test claude::tests::an_automatic_compaction_mid_turn_is_never_attributed_to_a_queued_compact ... ok
test claude::tests::an_idempotent_configure_broadcasts_no_metadata ... ok
test claude::tests::an_interrupt_inside_the_compact_candidate_window_retires_only_the_interrupted_compact ... ok
test claude::tests::an_interrupt_keeps_the_gate_closed_until_the_interrupted_turns_own_frames_land ... ok
test claude::tests::approval_respond_unknown_request_id_emits_parity_error_and_writes_nothing ... ok
test claude::tests::an_interrupt_keeps_the_gate_closed_until_the_queued_compact_and_send_both_finish ... ok
test claude::tests::session_init_frame_carries_inner_type_and_durable_uuid ... ok
test claude::tests::an_interrupted_turns_trailing_result_never_retires_the_next_queued_op ... ok
test claude::tests::approval_respond_with_a_non_object_decision_is_refused_and_keeps_the_pending_entry ... ok
test claude::tests::approval_respond_writes_the_frame_and_removes_the_pending_entry ... ok
test claude::tests::session_type_maps_claude_flavours ... ok
test claude::tests::shutdown_is_safe_with_no_sessions ... ok
test claude::tests::sidecar_death_never_yields_false_completion ... ok
test claude::tests::arming_a_compact_during_an_active_compaction_settles_its_debt_at_that_compactions_edge ... ok
test claude::tests::the_alias_cap_never_evicts_a_record_whose_row_is_still_bound ... ok
test claude::tests::the_alias_record_lives_as_long_as_the_row_it_resolves_to ... ok
test claude::tests::attach_ack_stays_idle_for_a_freshly_resumed_session ... ok
test claude::tests::attach_rebind_ack_settles_to_idle_once_the_compacted_turn_completes ... ok
test claude::tests::attach_rebind_ack_speaks_running_while_a_turn_is_in_flight ... ok
test claude::tests::attach_rebind_ack_stamps_the_tracked_live_status_not_hardcoded_idle ... ok
test claude::tests::attach_resume_falls_back_to_transcript_path_when_original_cwd_is_gone ... ok
test claude::tests::attach_transient_spawn_failure_is_not_a_lost_frame ... ok
test claude::tests::attach_untracked_with_missing_transcript_emits_lost_frame ... ok
test claude::tests::attach_untracked_with_transcript_resumes_and_emits_idle_snapshot ... ok
test claude::tests::the_fenced_prior_probe_never_signals_a_reused_pid ... ok
test claude::tests::the_kill_sweep_never_destroys_a_claim_that_committed_mid_sweep ... ok
test claude::tests::the_kill_sweep_re_retires_the_row_of_the_session_it_destroys ... ok
test claude::tests::compact_writes_send_frames_with_the_compact_command ... ok
test claude::tests::the_fenced_prior_probe_kills_a_reparented_descendant_from_the_recorded_identity ... ok
test claude::tests::the_prior_turns_terminal_edge_during_the_compact_write_window_folds_against_the_armed_tracker ... ok
test claude::tests::concurrent_send_plus_undo_serializes_on_the_turn_lock_without_deadlock ... ok
test claude::tests::concurrent_attaches_for_the_same_durable_id_spawn_at_most_one_sidecar ... ok
test claude::tests::turn_complete_frame_carries_the_success_edge ... ok
test claude::tests::configure_applies_settings_and_broadcasts_session_metadata ... ok
test claude::tests::consumer_exit_evicts_dead_session_and_index ... ok
test claude_snapshot::tests::builder_output_matches_the_golden_snapshot_fixture ... ok
test claude::tests::handle_create_concurrent_duplicate_request_id_spawns_at_most_once ... ok
test claude::tests::handle_create_distinct_request_ids_create_distinct_sessions ... ok
test claude::tests::handle_create_duplicate_request_id_reuses_the_session_and_spawns_once ... ok
test claude::tests::handle_create_duplicate_after_explicit_kill_creates_a_fresh_session ... ok
test claude::tests::handle_create_with_session_ref_only_resumes_like_legacy ... ok
test claude_snapshot::tests::claude_snapshot_without_a_record_stamps_static_caps_but_hides_the_rollback_keys ... ok
test claude_snapshot::tests::claude_turns_tag_every_summary_echo ... ok
test claude_snapshot::tests::claude_zero_item_messages_are_dropped_before_summarizing ... ok
test claude_snapshot::tests::find_transcript_locates_a_direct_project_file ... ok
test claude_snapshot::tests::find_transcript_locates_a_one_level_nested_file ... ok
test claude_snapshot::tests::find_transcript_misses_cleanly_and_rejects_traversal ... ok
test claude::tests::handle_interrupt_forwards_the_request_to_the_sidecar_for_a_known_session ... ok
test claude::tests::handle_kill_after_exit_eviction_with_the_bare_placeholder_still_retires_the_durable_row ... ok
test claude_snapshot::tests::locate_transcript_checked_finds_the_subagent_child_layout ... ok
test claude_snapshot::tests::locate_transcript_checked_misses_on_an_absent_projects_dir ... ok
test claude_snapshot::tests::locate_transcript_checked_probes_direct_across_all_roots_before_any_subagent ... ok
test claude_snapshot::tests::locate_transcript_checked_propagates_permission_denied ... ok
test claude_snapshot::tests::locate_transcript_checked_treats_a_file_project_entry_as_a_miss_enotdir_parity ... ok
test claude_snapshot::tests::pending_overlay_gates_track_each_pending_kind_independently ... ok
test claude_snapshot::tests::pending_overlay_populates_entries_and_flips_the_presence_gates ... ok
test claude_snapshot::tests::pending_overlay_with_empty_sets_leaves_the_snapshot_unchanged ... ok
test claude_snapshot::tests::raw_chain_successor_names_the_first_entry_after_a_keep_point ... ok
test claude_snapshot::tests::raw_chain_tip_is_the_last_uuid_of_the_parent_chain ... ok
test claude_snapshot::tests::raw_lcp_end_matches_on_uuid_and_message_only ... ok
test claude_snapshot::tests::redo_resume_target_on_an_empty_current_resumes_at_the_first_groups_end ... ok
test claude_snapshot::tests::redo_resume_target_step_from_a_prefix_grows_one_step_to_its_group_end ... ok
test claude_snapshot::tests::redo_resume_target_to_turn_on_an_unknown_uuid_errors ... ok
test claude_snapshot::tests::redo_resume_target_to_turn_resumes_at_the_addressed_groups_last_uuid ... ok
test claude_snapshot::tests::redo_resume_target_with_prefix_equal_to_original_has_nothing_to_restore ... ok
test claude_snapshot::tests::resolve_resume_point_at_the_first_message_resolves_before_the_first_message ... ok
test claude_snapshot::tests::resolve_resume_point_empty_transcript_is_empty ... ok
test claude_snapshot::tests::resolve_resume_point_step_on_a_single_step_resolves_before_the_first_message ... ok
test claude_snapshot::tests::resolve_resume_point_step_targets_the_last_user_step ... ok
test claude_snapshot::tests::resolve_resume_point_to_turn_middle_keeps_prefix ... ok
test claude_snapshot::tests::resolve_resume_point_unknown_target_is_not_found ... ok
test claude_snapshot::tests::resolve_resume_point_walks_the_raw_chain_through_non_display_carriers ... ok
test claude_snapshot::tests::restored_slice_turns_projects_only_the_restored_range ... ok
test claude::tests::handle_kill_retires_the_durable_row_whichever_id_addresses_it ... ok
test claude_snapshot::tests::summarize_unifies_truncation_and_tool_result_labels ... ok
test claude_snapshot::tests::transcript_cwd_bounded_never_scans_past_the_64kib_prefix ... ok
test claude_snapshot::tests::transcript_cwd_bounded_parses_a_complete_unterminated_final_line ... ok
test claude_snapshot::tests::transcript_cwd_checked_is_bounded_to_the_64kib_prefix ... ok
test claude_snapshot::tests::transcript_cwd_checked_propagates_a_permission_denied_open ... ok
test claude_snapshot::tests::transcript_cwd_checked_treats_a_raced_deletion_as_a_cwdless_hit ... ok
test claude_snapshot::tests::transcript_cwd_reads_the_first_cwd_field ... ok
test claude_snapshot::tests::turn_ids_are_unique_and_ordering_is_transcript_order ... ok
test claude_snapshot::tests::turns_carry_real_message_uuids_when_present ... ok
test claude_snapshot::tests::turns_fall_back_to_synthetic_ids_without_uuids ... ok
test claude_snapshot::tests::user_turns_carry_role_user_and_literal_prompt_text ... ok
test codex::controls::tests::codex_user_controls_approval_round_trip_preserves_ids_and_reloads_pending_cards ... ok
test claude::tests::handle_rollback_after_a_resend_re_roots_the_chain_and_redo_restores_the_new_epoch ... ok
test claude::tests::handle_rollback_mid_turn_is_busy_and_never_touches_the_sidecar ... ok
test codex::controls::tests::codex_user_controls_failed_response_keeps_request_available ... ok
test claude::tests::a_delayed_kill_after_a_handoff_never_fabricates_a_foreign_owner_claim ... ok
test codex::controls::tests::codex_user_controls_questions_use_stable_ids_and_require_all_answers ... ok
test codex::controls::tests::codex_user_controls_resolved_and_interrupted_requests_clear_without_completion_chime ... ok
test codex::tests::a_claim_commit_error_stops_the_attach_resume_and_leaves_the_close_standing ... ok
test claude::tests::a_kill_closes_the_whole_identity_set_in_one_envelope_call ... ok
test codex::tests::a_dead_sidecar_at_the_codex_close_failure_ends_vacant_never_live ... ok
test claude::tests::a_delayed_create_and_attach_during_handoff_answer_typed ... ok
test claude::tests::a_fresh_claude_create_spawn_failure_settles_the_provisional_record ... ok
test claude::tests::a_clean_close_failure_unwinds_the_grant_and_restores_the_release_stamp ... ok
test codex::tests::a_delayed_resume_create_mid_handoff_for_an_in_map_session_is_refused_typed ... ok
test claude::tests::a_completed_kill_before_publication_abandons_the_adoption ... ok
test codex::tests::a_compact_completion_inside_a_newer_turns_window_clears_only_the_compact_window ... ok
test claude::tests::a_kill_whose_alias_resolved_close_fails_aborts_before_any_live_state_destruction ... ok
test codex::tests::a_kill_whose_close_persists_despite_the_reported_error_ends_the_session_and_fails_visibly ... ok
test codex::tests::a_kill_whose_durable_close_fails_reports_failure_and_touches_no_live_state ... ok
test claude::tests::a_claim_commit_error_stops_the_resumed_create_and_leaves_the_close_standing ... ok
test codex::tests::a_refused_post_send_binding_refresh_is_logged_typed_and_never_fails_the_accepted_turn ... ok
test codex::tests::a_fenceless_compact_against_a_mid_handoff_key_is_refused_typed ... ok
test codex::tests::a_refresh_after_a_handoff_entered_still_carries_the_pre_handoff_pair ... ok
test claude::tests::a_delayed_kill_mid_handoff_answers_typed_and_does_not_race_the_handoff ... ok
test claude::tests::a_claim_commit_error_stops_the_attach_resume_and_leaves_the_close_standing ... ok
test codex::tests::a_second_compact_in_the_answered_but_unstarted_window_is_refused_busy_turn ... ok
test codex::tests::a_fresh_create_window_holds_a_coordinator_starting_record ... ok
test codex::tests::a_half_fenced_send_is_refused_typed ... ok
test codex::tests::a_kill_landing_between_the_commit_and_the_registration_still_closes_the_attached_thread ... ok
test codex::tests::a_kill_landing_between_the_commit_and_the_registration_still_closes_the_resumed_create ... ok
test codex::tests::a_kill_landing_mid_attach_resume_is_never_undone_by_the_claim_commit ... ok
test claude::tests::a_kill_landing_mid_attach_resume_is_never_undone_by_the_claim_commit ... ok
test codex::tests::a_minted_key_lost_to_a_competing_owner_refuses_typed_and_tears_down ... ok
test claude::tests::a_kill_landing_between_the_commit_and_the_registration_still_closes_the_attached_session ... ok
test codex::tests::a_normal_create_broadcasts_the_committed_owner_record ... ok
test claude::tests::a_foreign_blocked_adoption_tears_down_while_the_own_operation_proceeds ... ok
test claude::tests::a_failed_fork_rekey_publication_fails_the_adoption_through_the_completion ... ok
test claude::tests::a_half_sent_rollback_fence_is_refused_typed ... ok
test codex::tests::a_stale_prior_completion_never_clears_the_compact_window_and_only_the_matching_completion_does ... ok
test claude::tests::a_failed_session_init_binding_write_abandons_before_the_commit ... ok
test codex::tests::an_idempotent_configure_broadcasts_no_metadata ... ok
test codex::tests::an_idless_compact_completion_inside_a_newer_turns_window_stays_busy_and_retires_the_compact ... ok
test claude::tests::a_fresh_claude_create_window_holds_a_coordinator_starting_record ... ok
test codex::tests::a_slow_resume_startup_is_watchdog_evidenced_during_the_await ... ok
test codex::tests::a_send_with_changed_settings_broadcasts_session_metadata ... ok
test codex::tests::a_spawn_failure_during_the_fresh_create_window_settles_the_provisional_record ... ok
test codex::tests::build_codex_turn_json_appends_synthetic_text_item_for_turn_error ... ok
test codex::tests::build_codex_turn_json_empty_response_synthetic_row_also_carries_assistant_role ... ok
test codex::tests::build_codex_turn_json_item_missing_type_field_is_skipped_like_any_unrecognized_type ... ok
test codex::tests::build_codex_turn_json_keeps_a_single_role_raw_turn_as_one_turn_with_role_set ... ok
test codex::tests::build_codex_turn_json_role_is_present_on_every_emitted_turn_including_tool_rows ... ok
test codex::tests::build_codex_turn_json_skips_unrecognized_item_type_without_erroring_the_turn ... ok
test codex::tests::build_codex_turn_json_splits_a_raw_turn_with_user_and_assistant_items_into_two_turns ... ok
test codex::tests::build_codex_turn_json_turn_id_semantics_single_row_keeps_raw_id_multi_row_disambiguates ... ok
test codex::tests::build_codex_turn_json_unknown_item_type_does_not_perturb_role_splitting ... ok
test codex::tests::codex_fork_last_turn_id_strips_exactly_one_trailing_row_suffix ... ok
test codex::tests::codex_snapshot_exposes_actual_changed_files_and_child_threads ... ok
test codex::tests::codex_snapshot_stamps_legacy_and_unknown_history_undo_false ... ok
test codex::tests::codex_snapshot_stamps_paginated_capabilities_the_marker_bucket_and_the_revision_floor ... ok
test codex::tests::codex_snapshot_without_a_record_hides_the_rollback_keys ... ok
test codex::tests::a_stale_fence_compact_against_a_vacated_key_is_refused_typed_no_recreation ... FAILED
test codex::tests::completed_turn_yields_snapshot_then_chime_frames ... ok
test codex::tests::a_stale_fence_fork_against_a_vacated_key_is_refused_typed_no_recreation ... FAILED
test codex::tests::concurrent_compact_plus_undo_serializes_on_the_turn_lock_without_deadlock ... ok
test codex::tests::a_stale_fence_resume_create_for_a_live_session_is_refused_typed ... ok
test codex::tests::concurrent_send_plus_undo_serializes_on_the_turn_lock_without_deadlock ... ok
test codex::tests::configure_for_an_unknown_session_answers_invalid_session_id ... ok
test codex::tests::configure_normalizes_the_effort_before_recording_it ... ok
test codex::tests::a_stale_fence_undo_against_a_vacated_key_is_refused_typed_no_recreation ... FAILED
test codex::tests::configure_records_the_pair_and_broadcasts_session_metadata ... ok
test codex::tests::a_stale_generation_compact_against_a_vacated_key_is_refused_typed ... FAILED
test codex::tests::a_stale_generation_crashed_attach_is_refused_typed_no_recreation ... FAILED
test codex::tests::dead_thread_cache_entry_expires_after_its_ttl ... ok
test codex::tests::dead_thread_cache_is_bounded_by_a_hard_cap ... ok
test codex::tests::dead_thread_cache_marks_checks_and_clears ... ok
test codex::tests::deep_merge_replaces_scalars_and_merges_objects ... ok
test codex::tests::deferred_codex_confirmation_clears_binding_and_condemned_identity ... ok
test codex::tests::a_stale_generation_fork_against_a_vacated_key_is_refused_typed ... FAILED
test claude::tests::a_handoff_during_the_rollback_replace_window_is_blocked_typed ... ok
test claude::tests::handle_rollback_record_write_failure_refuses_before_any_sidecar_churn ... ok
test claude::tests::a_kill_landing_between_the_commit_and_the_registration_still_closes_the_resumed_create ... ok
test codex::tests::a_stale_generation_send_against_a_crashed_session_is_refused_typed ... FAILED
test claude::tests::a_resume_create_that_fails_midway_keeps_the_fence_and_no_orphan_rebounds_the_row ... ok
test codex::tests::a_stale_generation_undo_against_a_vacated_key_is_refused_typed ... FAILED
test claude::tests::a_mint_adoption_abandons_once_the_kills_close_gate_is_set ... ok
test claude::tests::a_refused_init_adoption_tears_the_fresh_runtime_down ... ok
test claude::tests::a_runtime_exit_during_the_close_failure_is_never_resurrected ... ok
test codex::tests::a_tracked_attach_over_a_terminal_owned_key_is_refused_typed ... ok
test codex::tests::gate_seeds_from_settings_and_defaults_off ... ok
test codex::tests::get_snapshot_is_sendable_once_thread_status_is_idle_even_if_active_turn_is_stale ... ok
test claude::tests::a_no_stamp_live_owner_close_failure_stays_live_never_vacant ... ok
test codex::tests::get_snapshot_renders_tool_reasoning_and_file_change_items_end_to_end ... ok
test codex::tests::get_snapshot_reports_running_capabilities_when_a_turn_is_tracked_active ... ok
test claude::tests::a_kill_whose_envelope_fails_clean_reopens_the_close_gate ... ok
test codex::tests::get_snapshot_reports_sendable_after_a_turn_completes_via_the_real_notification_stream ... ok
test codex::tests::get_snapshot_returns_a_schema_shaped_snapshot_with_turn_text ... ok
test claude::tests::a_sidecar_exit_after_the_live_verdict_never_gets_its_stamp_restored ... ok
test claude::tests::handle_rollback_redo_with_a_moved_original_tip_is_redo_unavailable ... ok
test codex::tests::half_fenced_kill_refusal_carries_the_typed_invalid_fence_code ... ok
test codex::tests::get_snapshot_surfaces_the_durable_rollback_record_and_floors_the_revision ... ok
test codex::tests::adopt_live_create_over_a_lineage_only_incumbent_still_restamps_the_provenance ... ok
test claude::tests::a_refused_kill_releases_the_close_gate_and_adoptions_proceed ... ok
test codex::tests::handle_attach_known_alive_session_emits_no_frame_regardless_of_turn_state ... ok
test claude::tests::a_stale_generation_rollback_is_refused_typed ... ok
test claude::tests::a_rollback_fork_rekey_never_adopts_ownership_under_the_new_id ... ok
test codex::tests::adopt_live_create_restamps_the_parked_provenance_and_the_ledger_row ... ok
test codex::tests::adopt_live_create_through_the_finish_create_eviction_guard_restamps_the_current_connection ... ok
test codex::tests::handle_compact_failed_or_interrupted_turn_produces_no_completion_chime ... ok
test codex::tests::handle_compact_issues_thread_compact_start_and_the_probed_notification_flow_completes ... ok
test codex::tests::handle_compact_rpc_error_surfaces_the_error_path_and_no_fake_completion ... ok
test codex::tests::adopt_live_create_with_no_connection_provenance_keeps_the_parked_stamps_and_writes_nothing ... ok
test codex::tests::handle_compact_unknown_session_surfaces_a_loud_nested_error ... ok
test codex::tests::handle_compact_refuses_while_a_turn_is_active_without_issuing_any_rpc ... ok
test codex::tests::handle_compact_rpc_timeout_keeps_the_busy_marker_fail_closed ... ok
test codex::tests::attach_after_unrequested_crash_recovers_and_emits_a_snapshot ... ok
test codex::tests::attach_after_unrequested_crash_resumes_and_emits_a_snapshot_with_the_same_id ... ok
test claude::tests::a_terminal_handoff_between_the_rollback_claim_and_the_adopt_arm_refuses_typed_without_spawning ... ok
test codex::tests::attach_resume_of_a_killed_lineage_only_thread_revives_the_row ... ok
test claude::tests::a_watcher_race_on_the_stamp_take_never_panics_and_completes_coherently ... ok
test claude::tests::a_refused_kill_keeps_the_durable_ledger_bound_and_answers_typed ... ok
test claude::tests::an_attach_whose_seat_carries_a_close_fence_is_refused_and_nothing_registers ... ok
test claude::tests::an_attach_over_a_clean_seat_commits_persists_its_alias_and_consumes_the_older_records ... ok
test claude::tests::an_adopt_over_a_live_runtime_commits_the_owner ... ok
test codex::tests::handle_fork_archive_failure_replies_on_the_sink_and_never_spawns ... ok
test claude::tests::a_stale_commit_tears_down_and_abandons_after_the_in_operation_binding ... ok
test claude::tests::a_stale_on_arrival_rollback_is_refused_typed ... ok
test codex::tests::attach_resume_seeds_the_parked_provenance_from_the_durable_row ... ok
test claude::tests::an_unfenced_rollback_after_a_completed_ownership_cycle_is_refused_typed ... ok
test codex::tests::handle_fork_duplicate_in_flight_is_refused_and_releases_on_failure ... ok
test codex::tests::handle_fork_malformed_fork_result_replies_and_never_archives ... ok
test codex::tests::handle_fork_builds_params_from_parent_settings_input_overrides_and_strips_row_suffix ... ok
test codex::tests::handle_fork_unknown_parent_replies_the_lost_session_shape_on_the_sink ... ok
test codex::tests::handle_interrupt_errors_for_unknown_session ... ok
test codex::tests::handle_fork_rpc_error_replies_on_the_sink_without_archiving_or_spawning ... ok
test codex::tests::attach_resume_with_a_genuinely_unattributed_row_keeps_the_parked_none ... ok
test codex::tests::handle_kill_of_an_evicted_session_still_retires_the_row_it_names ... ok
test codex::tests::handle_kill_of_unknown_session_still_broadcasts_success ... ok
test codex::tests::handle_interrupt_errors_when_no_active_turn_is_tracked ... ok
test codex::tests::handle_kill_records_the_durable_close_before_the_teardown_settles ... ok
test codex::tests::handle_interrupt_issues_rpc_for_tracked_turn_and_clears_it ... ok
test codex::tests::handle_rollback_after_a_destroyed_redo_starts_a_new_epoch_but_keeps_all_markers ... ok
test codex::tests::handle_kill_removes_session_kills_owned_child_and_broadcasts_killed ... ok
test codex::tests::handle_rollback_double_undo_within_one_epoch_keeps_the_marker_bucket_in_conversation_order ... ok
test codex::tests::handle_kill_retires_the_ledger_row_for_the_killed_thread ... ok
test codex::tests::handle_rollback_legacy_thread_refusal_maps_the_copy_and_compensates_the_record ... ok
test codex::tests::handle_rollback_empty_history_says_nothing_to_undo_and_never_reverts ... ok
test codex::tests::handle_rollback_old_cli_revert_maps_32601_to_unsupported_capability ... ok
test codex::tests::handle_rollback_redo_is_refused_codex_is_undo_only ... ok
test codex::tests::handle_rollback_mid_turn_is_busy_without_touching_the_sidecar ... ok
test codex::tests::handle_rollback_rpc_error_rejection_compensates_the_pre_op_record ... ok
test codex::tests::handle_rollback_record_write_failure_refuses_and_never_reverts ... ok
test codex::tests::handle_rollback_step_reverts_the_last_turn_and_answers_with_the_removed_prompt ... ok
test codex::tests::handle_rollback_to_turn_strips_the_row_suffix_and_removes_the_tail ... ok
test codex::tests::handle_rollback_unknown_session_answers_invalid_session_id ... ok
test codex::tests::handle_rollback_transport_error_keeps_the_ledger_and_reports_uncertain_state ... ok
test codex::tests::handle_rollback_undo_send_undo_undo_freezes_epoch_zero_and_orders_the_new_epoch_ascending ... ok
test codex::tests::handle_send_always_broadcasts_accepted_before_an_immediate_completion_snapshot_and_chime ... ok
test codex::tests::handle_send_permanently_destroys_redo ... ok
test codex::tests::handle_rollback_zero_turn_paginated_read_falls_back_and_says_nothing_to_undo ... ok
test codex::tests::idle_snapshot_frames_carry_the_snapshot_inner_type ... ok
test codex::tests::isolated_codex_env_restores_every_mutated_variable_during_unwind ... ok
test codex::tests::compact_after_unrequested_crash_respawns_the_sidecar_then_compacts ... ok
test codex::tests::legacy_read_only_permission_preserves_read_only_intent ... ok
test codex::tests::map_codex_item_command_execution_omits_cwd_key_when_absent ... ok
test codex::tests::map_codex_item_command_execution_renders_command_kind_with_exact_schema_keys ... ok
test codex::tests::map_codex_item_dynamic_tool_call_renders_dynamic_tool_kind_with_exact_schema_keys ... ok
test codex::tests::map_codex_item_file_change_renders_file_change_kind_with_exact_schema_keys ... ok
test codex::tests::map_codex_item_mcp_tool_call_renders_mcp_tool_kind_with_exact_schema_keys ... ok
test codex::tests::map_codex_item_reasoning_renders_reasoning_kind_with_exact_schema_keys ... ok
test codex::tests::map_codex_item_unrecognized_type_is_gracefully_skipped_not_an_error ... ok
test codex::tests::map_codex_item_user_message_splits_content_parts_into_text_items ... ok
test codex::tests::now_iso_is_iso8601_millis_z ... ok
test codex::tests::onexit_self_heal_emits_exited_status_with_no_chime_and_keeps_session_mapped ... ok
test codex::tests::patch_settings_requires_auth_and_flips_the_gate ... ok
test codex::tests::concurrent_attaches_against_a_not_yet_cached_dead_thread_spawn_at_most_one_sidecar ... ok
test claude::tests::an_unconfirmed_kill_fences_the_key_until_the_escalation_confirms_death ... ok
test codex::tests::quiet_deadman_arms_from_snapshot_observed_in_flight_turn ... ok
test claude::tests::attach_of_a_killed_lineage_only_session_revives_the_closed_row ... ok
test codex::tests::quiet_deadman_fires_stuck_status_without_fabricating_a_turn_complete ... ok
test codex::tests::requested_exit_watcher_reports_confirmed_reap ... ok
test codex::tests::quiet_deadman_ignores_quiet_sessions_with_no_turn_in_flight ... ok
test codex::tests::quiet_deadman_rearms_after_terminal_status_clearance ... ok
test claude::tests::in_turn_clears_on_exactly_the_four_contract_edges_fail_closed_otherwise ... ok
test claude::tests::failed_effort_records_the_model_that_already_took_effect ... ok
test codex::tests::concurrent_send_and_attach_single_flight_recovery_for_the_same_crashed_session ... ok
test claude::tests::handle_kill_records_the_close_before_the_map_removal ... ok
test codex::tests::sandbox_and_approval_wire_shapes_match_reference ... ok
test codex::tests::quiet_deadman_resets_on_lane_events_and_resolves_on_turn_completion ... ok
test codex::tests::rollback_in_the_compact_answered_but_turn_unstarted_window_is_refused_busy_turn ... ok
test claude::tests::handle_kill_while_the_adoption_write_is_in_flight_never_rebounds_the_row ... ok
test codex::tests::crash_recovery_resume_wrong_thread_id_is_rejected_not_silently_recovered ... ok
test codex::tests::send_applies_updated_model_effort_permissions_and_images ... ok
test codex::tests::shutdown_is_safe_with_no_sessions ... ok
test claude::tests::interrupting_a_queue_advanced_turn_releases_the_gate ... ok
test codex::tests::summarize_codex_items_keeps_the_shipped_reasoning_fallback_order ... ok
test codex::tests::summarize_codex_items_tags_reasoning_without_a_provider_summary_echo ... ok
test codex::tests::summarize_codex_items_tags_tool_previews_echo ... ok
test codex::tests::summarize_codex_items_uses_first_items_kind_specific_text_not_a_join ... ok
test codex::tests::create_binding_carries_the_creates_connection_provenance ... ok
test codex::tests::snapshot_pause_hook_parks_the_get_and_the_lookup_re_resolves_after_release ... ok
test codex::tests::the_compact_windows_thread_level_idle_keeps_the_newer_turns_busy_truth ... ok
test claude::tests::interrupting_a_turn_behind_a_silently_dropped_compact_retires_the_turn_not_the_compact ... ok
test codex::tests::create_records_fresh_agent_binding_with_settings ... ok
test codex::tests::the_untracked_empty_snapshot_derives_from_the_decision_time_observation ... ok
test codex::tests::turn_complete_event_frames_carry_the_inner_type ... ok
test codex::tests::the_post_send_binding_refresh_carries_the_observed_ownership_pair ... ok
test claude::tests::interrupting_the_active_turn_absorbs_ahead_queued_silently_dropped_compacts ... ok
test claude::tests::kill_in_the_exit_eviction_gap_retires_the_durable_via_the_live_alias ... ok
test codex::tests::diag01_freshagent_events_fire_on_create_and_crash_detection ... ok
test codex::tests::fail_create_frame_carries_retryable_true ... ok
test claude::tests::kilroy_approval_respond_lands_and_removes_the_pending_entry ... ok
test claude::tests::question_respond_writes_the_frame_with_the_answers_object ... ok
test claude::tests::queued_compact_disarms_on_the_garlanded_sends_result_without_observed_compacting ... ok
test claude::tests::queued_compact_pending_disarms_on_sdk_error ... ok
test codex::tests::fork_after_crash_recovery_keeps_the_create_provenance_chain ... ok
test claude::tests::queued_compact_with_a_garlanded_send_holds_busy_until_the_sends_own_terminal_edge ... ok
test claude::tests::redo_current_transcript_read_failure_is_internal_error_with_no_fork_traffic ... ok
test codex::tests::fork_after_a_mint_new_respawn_keeps_the_create_provenance_chain ... ok
test fresh_agent_create_dedup_tests::bounded_cache_evicts_the_oldest_entry_past_cap ... ok
test fresh_agent_create_dedup_tests::clear_for_session_evicts_matching_entries_so_a_later_duplicate_recreates ... ok
test claude::tests::reopened_session_survives_a_late_kill_naming_the_old_placeholder ... ok
test fresh_agent_create_dedup_tests::distinct_request_ids_never_replay_each_other ... ok
test fresh_agent_create_dedup_tests::sequential_duplicate_request_id_replays_the_cached_value ... ok
test identity_sink::tests::bind_provenance_carries_its_assertion_time ... ok
test identity_sink::tests::bind_provenance_meaningfulness_tracks_the_d8_judgment_requirements ... ok
test identity_sink::tests::fake_commit_claim_is_conditional_like_the_real_ledger ... ok
test fresh_agent_create_dedup_tests::concurrent_duplicate_request_id_serializes_and_both_see_the_same_value ... ok
test identity_sink::tests::fake_sink_blank_settings_binding_is_lineage_only ... ok
test identity_sink::tests::fake_sink_clear_provenance_erases_the_tracked_stamps ... ok
test identity_sink::tests::fake_sink_failure_knob_returns_err ... ok
test identity_sink::tests::fake_sink_load_provenance_mirrors_the_atomic_monotone_attribution_rule ... ok
test identity_sink::tests::fake_sink_load_rollback_version_gate_returns_none ... ok
test identity_sink::tests::fake_orphan_gate_applies_at_release_against_the_tombstone_state ... ok
test identity_sink::tests::fake_sink_lookup_by_create_request_id_resolves_lineage ... ok
test identity_sink::tests::fake_sink_mirrors_the_kill_tombstone_fence_and_the_claim_clear ... ok
test identity_sink::tests::fake_sink_records_and_loads_rollback ... ok
test identity_sink::tests::fake_sink_records_and_serves_settings ... ok
test in_flight_registry_tests::contains_tracks_acquire_and_drop_without_acquiring ... ok
test layout_store::persist::tests::a_dead_writer_falls_back_to_the_inline_write ... ok
test layout_store::persist::tests::offloaded_persists_land_after_flush_and_survive_a_restart ... ok
test layout_store::persist::tests::parent_dir_fsync_failure_is_best_effort_and_never_blocks_the_persist ... ok
test layout_store::persist::tests::offloaded_persists_preserve_mutation_order ... ok
test layout_store::persist::tests::persist_fsyncs_the_parent_directory_after_the_rename ... ok
test layout_store::tests::a_reconnecting_clients_stale_copy_cannot_erase_a_server_pane_recovery ... ok
test layout_store::tests::a_server_recovery_then_a_legitimate_client_reedit_is_not_blocked ... ok
test layout_store::tests::by_id_reads_and_mutations_resolve_across_clients ... ok
test layout_store::tests::close_pane_guards_only_pane_and_purges_metadata ... ok
test layout_store::tests::close_tab_preserves_cursor_for_background_closes_and_advances_on_active_close ... ok
test layout_store::tests::create_tab_and_split_pane_never_move_the_server_cursor ... ok
test layout_store::tests::derive_pane_title_full_matrix ... ok
test layout_store::tests::disconnected_clients_ids_stay_resolvable_until_superseded ... ok
test layout_store::persist::tests::the_update_path_does_not_hold_the_layout_lock_across_the_offloaded_write ... ok
test layout_store::tests::live_sync_sharing_only_broadcast_ids_does_not_evict_another_clients_stale_entry ... ok
test layout_store::tests::mutations_without_snapshot_report_no_layout_snapshot_but_create_tab_bootstraps ... ok
test layout_store::tests::next_prev_cycle_ordered_tabs_modulo_len ... ok
test layout_store::tests::normalize_pair_to_hundred_and_percent_bounds ... ok
test layout_store::tests::normalized_snapshot_with_explicit_tab_id_resolves_from_any_client_snapshot ... ok
test layout_store::tests::remove_client_evicts_and_primary_falls_back_to_most_recent_remaining ... ok
test layout_store::tests::rename_pane_mirrors_to_tab_when_single_pane_and_reports_tab_renamed ... ok
test layout_store::tests::rename_pane_updates_every_client_snapshot_containing_the_id ... ok
test layout_store::tests::rename_pane_resolves_ids_from_any_client_snapshot ... ok
test layout_store::tests::rename_tab_mirrors_to_pane_only_when_single_pane ... ok
test layout_store::tests::sole_pane_check_uses_the_snapshot_where_the_pane_resolves ... ok
test layout_store::tests::resolve_resize_target_split_id_first_then_pane_parent_split ... ok
test layout_store::tests::split_pane_select_pane_and_attach_content_reseed_derived_titles ... ok
test layout_store::tests::stale_entry_never_primary_while_live_clients_exist ... ok
test layout_store::tests::stale_cap_bounds_growth ... ok
test layout_store::tests::swap_pane_exchanges_content_and_title_maps ... ok
test layout_store::tests::update_from_ui_drops_legacy_display_override_keys_from_fresh_agent_content ... ok
test layout_store::tests::update_from_ui_migrates_legacy_agent_chat_and_fresh_agent_content ... ok
test layout_store::tests::update_from_ui_replaces_snapshot_and_seeds_nonsticky_titles ... ok
test layout_store::tests::update_from_ui_still_replaces_the_same_clients_snapshot ... ok
test layout_store::tests::update_from_ui_stores_unresolvable_fresh_agent_content_verbatim ... ok
test layout_tree::tests::collect_leaves_is_depth_first_left_to_right ... ok
test layout_tree::tests::find_parent_split_and_set_sizes ... ok
test layout_tree::tests::parse_and_reserialize_leaf_and_split_roundtrip ... ok
test model_capabilities::tests::blank_cwd_maps_to_default_cache_key ... ok
test model_capabilities::tests::claude_catalog_keeps_live_effort_choices_and_deduplicates_models ... ok
test model_capabilities::tests::cache_entry_expires_past_ttl_and_reprobes ... ok
test model_capabilities::tests::claude_catalog_probes_live_models_and_shares_cache_with_kilroy ... ok
test model_capabilities::tests::codex_serves_static_catalog ... ok
test model_capabilities::tests::concurrent_refreshes_single_flight_one_probe ... ok
test model_capabilities::tests::failed_refresh_keeps_last_successful_cache ... ok
test claude::tests::respond_error_envelopes_keep_the_kilroy_session_type ... ok
test model_capabilities::tests::get_freshcodex_serves_static_catalog_over_http ... ok
test model_capabilities::tests::get_freshopencode_returns_full_envelope_and_forwards_cwd ... ok
test model_capabilities::tests::models_returns_typed_rows_with_limits_and_shares_the_ttl_cache ... ok
test model_capabilities::tests::opencode_catalog_caches_by_cwd ... ok
test model_capabilities::tests::invalid_session_type_is_400_for_get_and_refresh ... ok
test model_capabilities::tests::probe_failure_maps_to_503_unavailable_envelope ... ok
test model_capabilities::tests::refresh_reprobes_and_reports_fresh ... ok
test model_capabilities::tests::routes_require_auth ... ok
test opencode_ws::tests::a_claim_commit_error_stops_the_resume_and_leaves_the_close_standing ... ok
test opencode_ws::tests::a_compact_while_a_handoff_owns_the_key_is_refused_typed ... ok
test claude::tests::resume_create_after_a_kill_clears_the_tombstone_and_rebinds ... ok
test opencode_ws::tests::a_delayed_create_after_a_mid_await_handoff_commit_aborts_typed ... ok
test opencode_ws::tests::a_current_observed_fence_on_a_first_send_materializes ... ok
test claude::tests::resume_for_attach_reapplies_settings_from_ledger ... ok
test opencode_ws::tests::a_fork_binding_failure_tears_the_child_down_typed ... ok
test opencode_ws::tests::a_failed_close_over_the_complete_set_leaves_nothing_durable_and_releases_the_gate ... ok
test opencode_ws::tests::a_fork_commit_that_goes_stale_tears_the_child_down_completely ... ok
test claude::tests::resume_with_prior_record_but_unrecoverable_settings_alarms ... ok
test opencode_ws::tests::a_half_fenced_send_refuses_typed_invalid_fence_and_never_materializes ... ok
test opencode_ws::tests::a_fork_while_a_handoff_owns_the_key_is_refused_typed ... ok
test opencode_ws::tests::a_half_sent_compact_fence_is_refused_typed ... ok
test opencode_ws::tests::a_handoff_during_a_parked_compact_answers_blocked_and_the_compact_completes ... ok
test opencode_ws::tests::a_kill_closes_the_whole_identity_set_in_one_envelope_call ... ok
test opencode_ws::tests::a_handoff_during_a_parked_fork_answers_blocked_and_the_child_completes ... ok
test opencode_ws::tests::a_kill_during_an_accepted_daemon_turn_aborts_it_before_the_stop_commits ... ok
test opencode_ws::tests::a_handoff_during_a_parked_revert_answers_blocked_and_the_undo_completes ... ok
test opencode_ws::tests::a_kill_whose_close_persists_despite_the_reported_error_ends_the_session_and_fails_visibly ... ok
test opencode_ws::tests::a_kill_landing_mid_resume_is_never_undone_by_the_claim_commit ... ok
test opencode_ws::tests::a_materialization_broadcasts_the_committed_owner_record ... ok
test opencode_ws::tests::a_kill_whose_durable_close_fails_reports_failure_and_touches_no_live_state ... ok
test opencode_ws::tests::a_materialization_binding_failure_tears_the_session_down_typed ... ok
test opencode_ws::tests::a_materialization_completing_behind_the_kills_park_joins_the_one_envelope ... ok
test opencode_ws::tests::a_placeholder_addressed_kill_commits_the_canonical_record_to_vacant ... ok
test opencode_ws::tests::a_rollback_while_a_handoff_owns_the_key_is_refused_typed ... ok
test opencode_ws::tests::a_refused_kill_releases_the_enumeration_gate_and_the_session_stays_sendable ... ok
test opencode_ws::tests::a_send_against_a_killed_session_is_refused_and_writes_no_binding_row ... ok
test opencode_ws::tests::a_send_with_changed_settings_broadcasts_session_metadata ... ok
test opencode_ws::tests::a_send_is_refused_while_the_kills_close_gate_is_armed ... ok
test opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership ... FAILED
test opencode_ws::tests::a_stale_fence_map_hit_resume_cannot_reclaim_vacated_ownership ... ok
test opencode_ws::tests::a_stale_observed_fence_on_a_first_send_refuses_typed_and_never_materializes ... ok
test opencode_ws::tests::a_stale_on_arrival_compact_is_refused_typed ... ok
test opencode_ws::tests::a_stale_on_arrival_fork_is_refused_typed ... ok
test opencode_ws::tests::a_stale_on_arrival_undo_is_refused_typed ... ok
test opencode_ws::tests::an_idempotent_configure_broadcasts_no_metadata ... ok
test opencode_ws::tests::an_attach_after_a_terminal_handoff_is_refused_typed ... ok
test opencode_ws::tests::a_stale_pair_existing_session_attach_refuses_typed_without_restarting_the_bridge ... ok
test opencode_ws::tests::an_invalid_fence_map_hit_create_mutates_no_ownership ... ok
test opencode_ws::tests::an_unfenced_compact_racing_a_handoff_commit_into_the_arm_window_is_refused_typed ... ok
test opencode_ws::tests::an_unfenced_compact_after_a_completed_ownership_cycle_is_refused_typed ... ok
test opencode_ws::tests::an_unfenced_mount_attach_on_a_fresh_placeholder_adopts_nothing_and_sends_still_materialize ... ok
test opencode_ws::tests::attach_of_a_killed_lineage_only_session_revives_the_row_without_a_settings_write ... ok
test opencode_ws::tests::attach_resume_binding_keeps_none_stamps_for_ledger_inheritance ... ok
test opencode_ws::tests::attach_known_materialized_session_emits_idle_snapshot ... ok
test opencode_ws::tests::attach_placeholder_addressed_session_emits_materialized_first ... ok
test opencode_ws::tests::attach_resume_parks_no_provenance_on_the_reconstructed_session ... ok
test opencode_ws::tests::attach_unknown_session_resumes_a_durable_serve_session_not_in_the_local_map ... ok
test opencode_ws::tests::attach_resume_seeds_the_durable_rows_provenance_and_fork_inherits_it ... ok
test opencode_ws::tests::attach_resume_with_a_genuinely_unattributed_row_parks_none ... ok
test opencode_ws::tests::attach_unknown_session_with_genuinely_missing_serve_session_emits_lost_session_error ... ok
test opencode_ws::tests::attach_unknown_session_with_transient_manager_failure_emits_resume_failed_error ... ok
test opencode_ws::tests::cold_resume_parks_the_resume_connections_provenance_on_the_session ... ok
test opencode_ws::tests::clean_turn_emits_busy_then_idle_then_one_monotonic_turn_complete ... ok
test opencode_ws::tests::cold_resume_then_fork_child_row_carries_the_resume_connections_provenance ... ok
test opencode_ws::tests::compact_aborted_mid_drive_keeps_redo_destroyed_and_a_later_undo_freezes_the_old_markers ... ok
test codex::tests::fork_after_unrequested_crash_respawns_the_parent_sidecar_then_forks ... ok
test opencode_ws::tests::compact_on_a_not_yet_materialized_session_is_a_silent_noop ... ok
test opencode_ws::tests::compact_after_an_interrupted_or_errored_turn_resets_the_stale_flags_and_chimes ... ok
test opencode_ws::tests::compact_falls_back_to_the_serve_config_model_when_the_session_has_none ... ok
test opencode_ws::tests::compact_serve_error_broadcasts_idle_and_a_loud_error_without_a_chime ... ok
test opencode_ws::tests::compact_summarize_answered_500_after_receipt_destroys_redo_forever ... ok
test claude::tests::resume_without_record_is_silent_and_sends_nulls ... ok
test opencode_ws::tests::compact_retires_redo_before_the_summarize_drive_and_the_snapshot_reflects_it ... ok
test opencode_ws::tests::compact_posts_summarize_with_the_session_model_then_busy_idle_and_one_chime ... ok
test opencode_ws::tests::compact_summarize_answered_error_keeps_redo_destroyed_and_a_later_undo_freezes_the_old_markers ... ok
test opencode_ws::tests::compact_summarize_midflight_transport_failure_logs_and_keeps_destroy ... ok
test opencode_ws::tests::compact_summarize_startup_failure_preserves_redo ... ok
test opencode_ws::tests::compact_summarize_undelivered_dispatch_preserves_redo ... ok
test opencode_ws::tests::compact_while_a_turn_is_in_flight_is_refused_and_never_posts ... ok
test opencode_ws::tests::compact_with_a_failed_redo_destroy_is_refused_and_never_posts ... ok
test claude::tests::rollback_during_a_compact_turn_is_refused_busy_turn_with_zero_teardown_traffic ... ok
test opencode_ws::tests::compact_with_no_resolvable_model_errors_loudly_and_never_posts ... ok
test opencode_ws::tests::compact_with_no_resolvable_model_never_destroys_redo ... ok
test opencode_ws::tests::configure_for_an_unknown_session_answers_invalid_session_id ... ok
test opencode_ws::tests::configure_on_a_killed_session_is_refused_before_any_side_effect ... ok
test opencode_ws::tests::configure_on_a_materialized_session_re_snapshots_the_binding_row ... ok
test opencode_ws::tests::create_resume_binding_carries_the_current_connections_provenance ... ok
test opencode_ws::tests::configure_records_the_pair_and_broadcasts_session_metadata ... ok
test opencode_ws::tests::event_frame_shapes_match_legacy_wire_contract ... ok
test opencode_ws::tests::create_resume_hitting_the_in_memory_map_restamps_the_current_connections_provenance ... ok
test opencode_ws::tests::create_broadcasts_created_with_placeholder_session_id ... ok
test opencode_ws::tests::create_resume_with_a_lineage_only_row_still_restamps_the_current_connections_provenance ... ok
test opencode_ws::tests::fork_child_inherits_the_parent_cwd_when_the_response_carries_no_directory ... ok
test opencode_ws::tests::create_with_session_ref_rebinds_the_durable_session ... ok
test opencode_ws::tests::fork_in_flight_guard_releases_on_the_failure_path ... ok
test opencode_ws::tests::fork_falls_back_to_the_durable_row_when_the_fork_connection_is_hollow_and_the_park_is_empty ... ok
test opencode_ws::tests::fork_duplicate_in_flight_is_refused_and_releases_on_success ... ok
test opencode_ws::tests::fork_on_an_unmaterialized_placeholder_replies_invalid_session_id_and_posts_nothing ... ok
test opencode_ws::tests::fork_on_an_unknown_session_replies_the_lost_session_shape ... ok
test opencode_ws::tests::fork_serve_error_replies_internal_error_and_registers_no_child ... ok
test opencode_ws::tests::fork_registers_the_child_and_replies_forked_on_the_requesting_sink ... ok
test opencode_ws::tests::fork_stamps_the_child_from_the_forking_connection_over_the_stale_park ... ok
test opencode_ws::tests::fork_with_a_msg_shaped_at_turn_id_passes_it_as_message_id ... ok
test opencode_ws::tests::get_opencode_snapshot_of_live_placeholder_before_first_send_is_empty_then_real_after_materialization ... ok
test opencode_ws::tests::fork_with_a_non_msg_at_turn_id_omits_message_id_entirely ... ok
test opencode_ws::tests::get_opencode_snapshot_of_unknown_ses_id_is_still_not_found ... ok
test claude::tests::rollback_spawn_rejection_compensates_by_deleting_a_fabricated_record_never_written ... ok
test opencode_ws::tests::fork_with_a_malformed_child_response_replies_internal_error_and_registers_no_child ... ok
test opencode_ws::tests::handle_create_concurrent_duplicate_request_id_constructs_session_once ... ok
test opencode_ws::tests::handle_create_distinct_request_ids_create_distinct_sessions ... ok
test opencode_ws::tests::handle_create_duplicate_request_id_preserves_materialized_session_state ... ok
test opencode_ws::tests::handle_kill_before_materialization_clears_the_marker_and_evicted_ids_still_retire ... ok
test opencode_ws::tests::handle_create_duplicate_after_explicit_kill_creates_a_fresh_session ... ok
test opencode_ws::tests::half_fenced_kill_refusal_carries_the_typed_invalid_fence_code ... ok
test opencode_ws::tests::handle_kill_never_holds_the_sessions_map_across_its_session_lock_wait ... ok
test claude::tests::send_applies_changed_settings_before_text_and_persists_them ... ok
test opencode_ws::tests::handle_kill_retires_the_materialized_row_and_clears_the_pending_marker ... ok
test opencode_ws::tests::handle_kills_enumeration_park_carries_nothing_durable_then_the_one_envelope_lands ... ok
test opencode_ws::tests::handle_rollback_after_a_resend_starts_a_new_epoch_and_redo_still_works ... ok
test opencode_ws::tests::handle_kill_records_the_close_before_the_turn_settlement ... ok
test opencode_ws::tests::handle_rollback_after_legacy_migration_a_new_undo_reestablishes_new_epoch_redo_only ... ok
test opencode_ws::tests::handle_rollback_compensates_the_record_when_the_mutation_never_left_the_process ... ok
test opencode_ws::tests::handle_kill_teardown_never_holds_the_sessions_map_across_its_session_lock_wait ... ok
test claude::tests::send_rejects_failed_settings_without_losing_text_or_changing_saved_settings ... ok
test opencode_ws::tests::handle_rollback_placeholder_session_is_lost_session_shape ... ok
test opencode_ws::tests::handle_rollback_record_write_failure_refuses_and_never_posts_revert ... ok
test opencode_ws::tests::handle_rollback_redo_full_restore_uses_unrevert ... ok
test opencode_ws::tests::handle_rollback_mid_turn_is_busy ... ok
test opencode_ws::tests::handle_rollback_redo_after_destroy_is_redo_unavailable_and_never_posts ... ok
test opencode_ws::tests::handle_rollback_redo_post_verify_read_failure_keeps_the_ledger_and_reports_internal_error ... ok
test codex::tests::fork_child_binding_carries_the_parent_connections_parked_provenance ... ok
test opencode_ws::tests::handle_rollback_redo_on_a_migrated_legacy_record_refuses_with_zero_mutation_traffic ... ok
test opencode_ws::tests::handle_rollback_redo_without_a_pointer_is_nothing_to_redo ... ok
test opencode_ws::tests::handle_rollback_redo_step_moves_the_boundary_forward_by_one_user_step ... ok
test opencode_ws::tests::handle_rollback_step_on_an_empty_active_prefix_is_nothing_to_undo ... ok
test opencode_ws::tests::handle_rollback_step_reverts_at_the_last_user_message_and_refills ... ok
test opencode_ws::tests::handle_rollback_to_turn_removes_n_turns_in_one_revert_call ... ok
test opencode_ws::tests::handle_rollback_revert_404_is_unsupported_capability ... ok
test opencode_ws::tests::handle_rollback_silent_noop_revert_is_invalid_target ... ok
test opencode_ws::tests::handle_rollback_revert_http_500_is_internal_error ... ok
test opencode_ws::tests::handle_rollback_to_turn_targeting_an_assistant_message_is_refused_preflight ... ok
test opencode_ws::tests::handle_rollback_twice_keeps_markers_in_conversation_order ... ok
test claude::tests::send_with_unsupported_sandbox_emits_unsupported_settings_ignored_log ... ok
test opencode_ws::tests::hollow_create_provenance_parks_nothing ... ok
test opencode_ws::tests::hollow_in_memory_resume_keeps_the_parked_stamps_and_writes_nothing ... ok
test opencode_ws::tests::handle_rollback_undo_post_verify_read_failure_keeps_the_ledger_and_reports_internal_error ... ok
test opencode_ws::tests::errored_turn_emits_no_turn_complete_but_forwards_the_error ... ok
test opencode_ws::tests::hollow_cold_resume_falls_back_to_the_row_seed_and_writes_nothing ... ok
test opencode_ws::tests::handle_send_issued_mid_rollback_strictly_follows_it ... ok
test opencode_ws::tests::now_iso_is_iso8601_millis_z ... ok
test opencode_ws::tests::insert_live_session_for_test_keys_the_sessions_map ... ok
test opencode_ws::tests::kill_removes_session_but_does_not_terminate_the_shared_serve_child ... ok
test opencode_ws::tests::kill_of_unknown_session_still_broadcasts_success ... ok
test opencode_ws::tests::materialization_binding_carries_the_creates_connection_provenance ... ok
test opencode_ws::tests::live_session_ids_snapshots_every_session_map_key ... ok
test claude::tests::session_init_binding_carries_the_creates_connection_provenance ... ok
test opencode_ws::tests::materialization_resolves_pending_into_binding_with_settings ... ok
test opencode_ws::tests::repeated_ambiguous_undo_retries_rebuild_never_duplicate_the_marker_slice ... ok
test opencode_ws::tests::interrupt_during_an_in_flight_compact_aborts_it_and_emits_idle_without_a_chime ... ok
test opencode_ws::tests::kill_during_an_in_flight_compact_aborts_it_without_a_false_completion ... ok
test opencode_ws::tests::resume_after_a_kill_clears_the_tombstone_and_rebinds ... ok
test opencode_ws::tests::resume_durable_session_reapplies_settings_from_ledger ... ok
test opencode_ws::tests::resume_with_prior_record_but_unrecoverable_settings_alarms ... ok
test claude::tests::session_init_records_binding_with_create_settings ... ok
test opencode_ws::tests::resume_refusal_teardown_never_holds_the_sessions_map_across_its_session_lock_wait ... ok
test opencode_ws::tests::second_send_reuses_the_same_durable_session_id ... ok
test opencode_ws::tests::send_to_unknown_session_errors ... ok
test opencode_ws::tests::send_with_unsupported_settings_emits_unsupported_settings_ignored_log ... ok
test opencode_ws::tests::send_with_changed_settings_refreshes_the_binding ... ok
test ownership_watch_tests::natural_unconfirmed_exit_has_a_typed_fence_and_confirmed_release ... ok
test ownership_watch_tests::stale_watcher_keeps_the_replacement_stamp_and_owner ... ok
test ownership_wiring_tests::fresh_agent_claim_fails_typed_when_terminal_owns ... ok
test ownership_wiring_tests::fresh_agent_claim_then_commit_is_live_then_kill_releases ... ok
test ownership_wiring_tests::fresh_agent_fail_reopens_the_key ... ok
test ownership_wiring_tests::fresh_agent_stop_during_a_handoff_is_typed_blocked_and_does_not_kill ... ok
test ownership_wiring_tests::fresh_agent_stop_with_a_stale_claim_is_typed_refused_and_does_not_kill ... ok
test ownership_wiring_tests::start_cancellation_registers_on_the_tickets_canonical_key ... ok
test opencode_ws::tests::session_materialized_emitted_exactly_once_across_two_sends ... ok
test opencode_ws::tests::send_during_an_in_flight_compact_is_refused_and_leaves_the_compact_owned ... ok
test opencode_ws::tests::reclaimless_ops_over_a_terminal_owned_key_refuse_typed_on_every_lane ... ok
test opencode_ws::tests::the_first_send_claims_the_placeholder_before_the_provider_mutation ... ok
test opencode_ws::tests::the_handoff_target_resume_binding_carries_the_handoff_generation ... ok
test opencode_ws::tests::the_fork_claims_its_operation_identity_before_the_provider_mutation ... ok
test opencode_ws::tests::the_one_envelope_is_durable_before_the_killed_flag_is_set ... ok
test opencode_ws::tests::the_ws_materialization_creates_the_placeholder_coordinator_alias ... ok
test pane_ops::store_tests::close_pane_rebuilds_the_store_layout_and_advances_active_pane ... ok
test pane_ops::store_tests::layout_snapshot_returns_real_pane_node_trees_from_the_store ... ok
test pane_ops::store_tests::list_panes_rows_are_store_leaf_order_with_optional_fields_omitted ... ok
test pane_ops::store_tests::layout_snapshot_tab_filter_narrows_and_empty_param_is_none ... ok
test ownership_wiring_tests::the_start_cancellation_direct_variant_verifies_the_incarnation ... ok
test pane_ops::store_tests::list_panes_empty_store_is_empty_array ... ok
test opencode_ws::tests::resume_durable_session_get_session_is_bounded_and_reopens_the_lease ... ok
test ownership_wiring_tests::the_start_cancellation_slot_never_signals_a_recycled_pid ... ok
test pane_ops::store_tests::pane_target_resolution_supports_tab_title_index_forms_409_and_404 ... ok
test pane_ops::store_tests::pane_routes_on_an_empty_store_404_no_layout_snapshot ... ok
test opencode_ws::tests::interrupted_turn_emits_no_turn_complete ... ok
test pane_ops::store_tests::resize_ambiguous_pane_title_target_is_409 ... ok
test pane_ops::store_tests::resize_unknown_target_and_splitless_pane_report_split_not_found ... ok
test pane_ops::store_tests::resize_pane_id_resizes_parent_split_with_x_y_and_current_fallbacks ... ok
test pane_ops::store_tests::resize_split_id_applies_normalized_sizes_and_broadcasts ... ok
test claude::tests::session_init_records_cli_session_id_in_the_index ... ok
test pane_ops::store_tests::split_unknown_pane_with_snapshot_is_approx_not_applied ... ok
test pane_ops::store_tests::select_pane_persists_active_pane_in_the_store ... ok
test pane_ops::store_tests::swap_exchanges_content_and_both_title_maps_in_the_store ... ok
test claude::tests::sidecar_entry_resolves_to_the_vendored_package ... ok
test claude::tests::session_init_with_all_blank_settings_records_the_lineage_row ... ok
test pane_ops::store_tests::swap_unknown_panes_report_200_panes_not_found_not_404 ... ok
test pane_ops::tab_tests::delete_unknown_tab_reports_not_found_but_still_broadcasts ... ok
test pane_ops::tab_tests::delete_with_no_snapshot_reports_no_layout_snapshot_but_still_broadcasts ... ok
test pane_ops::store_tests::split_registers_the_new_pane_in_the_store_with_the_same_id ... ok
test pane_ops::tab_tests::delete_tab_removes_it_from_the_store_and_advances_active ... ok
test pane_ops::tab_tests::delete_fresh_agent_tab_cleans_legacy_shadow_maps ... ok
test pane_ops::tab_tests::failed_terminal_create_rolls_back_the_store_tab ... ok
test pane_ops::tab_tests::delete_tab_requires_auth ... ok
test pane_ops::tab_tests::fresh_agent_rest_created_pane_renames_via_patch ... ok
test pane_ops::tab_tests::fresh_agent_rest_create_registers_tab_and_pane_in_the_layout_store ... ok
test pane_ops::tab_tests::delete_tab_removes_tab_and_every_owned_pane_without_killing_ptys ... ok
test pane_ops::tab_tests::get_tabs_reads_ordered_rows_from_the_layout_store ... ok
test pane_ops::tab_tests::get_tabs_lists_rest_created_tabs_in_creation_order ... ok
test pane_ops::tab_tests::rename_tab_missing_name_is_400 ... ok
test pane_ops::tab_tests::rename_with_no_snapshot_reports_no_layout_snapshot ... ok
test pane_ops::tab_tests::rename_known_tab_broadcasts_tab_rename ... ok
test pane_ops::tab_tests::rename_tab_requires_auth ... ok
test pane_ops::tab_tests::rest_browser_create_registers_content_in_the_layout_store ... ok
test codex::tests::fork_falls_back_to_the_durable_row_when_the_fork_connection_is_hollow_and_the_park_is_empty ... ok
test pane_ops::tab_tests::rename_unknown_tab_reports_not_found_and_does_not_broadcast ... ok
test pane_ops::tab_tests::rest_resume_body_model_and_effort_beat_the_ledger_record ... ok
test pane_ops::tab_tests::rename_updates_store_title_single_pane_mirror_and_legacy_record ... ok
test pane_ops::tab_tests::rest_resume_dual_carrier_hits_the_frozen_legacy_refusal ... ok
test pane_ops::tab_tests::rest_resume_malformed_sessionref_is_400 ... ok
test pane_ops::tab_tests::rest_resume_recorded_but_unrecoverable_settings_alarm_and_proceeds ... ok
test pane_ops::tab_tests::rest_resume_probe_error_other_than_notfound_or_timeout_is_502 ... ok
test pane_ops::tab_tests::rest_create_registers_tab_and_pane_content_in_the_layout_store ... ok
test pane_ops::tab_tests::rest_resume_provider_mismatch_is_400 ... ok
test pane_ops::tab_tests::rest_resume_unknown_durable_ses_is_404 ... ok
test claude::tests::the_alias_resolved_close_completes_before_any_live_state_destruction ... ok
test pane_ops::tab_tests::rest_resume_uses_body_cwd_when_ledger_and_serve_directory_are_absent ... ok
test pane_ops::tab_tests::select_tab_persists_active_tab_id_in_the_store ... ok
test pane_ops::tab_tests::rest_resume_unresolvable_placeholder_is_404_naming_it ... ok
test pane_ops::tab_tests::rest_resume_probe_timeout_is_bounded_and_504 ... ok
test pane_ops::tab_tests::select_tab_requires_auth ... ok
test pane_ops::tab_tests::tabs_has_false_for_unknown_tab_id ... ok
test pane_ops::tab_tests::tabs_has_matches_by_title_too ... ok
test claude::tests::the_create_resume_registration_persists_the_alias_record ... ok
test pane_ops::tab_tests::select_unknown_tab_still_broadcasts_but_reports_not_found ... ok
test pane_ops::tab_tests::tabs_has_empty_target_is_false_even_when_tabs_exist ... ok
test pane_ops::tab_tests::tabs_has_requires_auth ... ok
test pane_ops::tab_tests::tabs_has_false_for_missing_target ... ok
test opencode_ws::tests::lineage_only_binding_does_not_arm_settings_reset_on_resume ... ok
test pane_ops::tab_tests::select_known_tab_succeeds ... ok
test pane_ops::tab_tests::tabs_next_requires_auth ... ok
test pane_ops::tab_tests::tabs_next_cycles_in_snapshot_order_and_broadcasts_tab_select ... ok
test pane_ops::tab_tests::tabs_prev_cycles_backwards_from_the_active_tab ... ok
test opencode_ws::tests::resume_without_record_is_silent_and_uses_serve_directory ... ok
test claude::tests::the_deferred_fork_adoption_carries_supersedes_and_never_claims_the_new_key ... ok
test pane_ops::tab_tests::tabs_next_with_no_tabs_reports_no_tabs_and_does_not_broadcast ... ok
test pane_ops::tab_tests::tabs_prev_with_no_tabs_reports_no_tabs ... ok
test pane_ops::tests::attach_pane_during_a_lifecycle_transition_is_typed_conflict ... ok
test pane_ops::tab_tests::tabs_prev_requires_auth ... ok
test pane_ops::tab_tests::tabs_has_true_for_known_tab_id ... ok
test pane_ops::tests::attach_pane_binds_a_terminal_owned_session_and_broadcasts_pane_attach ... ok
test pane_ops::tests::attach_pane_against_a_dead_terminal_answers_typed_restore_unavailable ... ok
test pane_ops::tests::layout_store_survives_a_server_restart_via_disk_persistence ... ok
test pane_ops::tests::attach_pane_without_session_ref_is_typed_bad_request ... ok
test pane_ops::tests::attach_pane_for_a_fresh_owned_session_returns_typed_owner_info ... ok
test pane_ops::tests::attach_pane_for_an_unowned_session_is_typed_conflict ... ok
test pane_ops::tests::attach_pane_requires_auth ... ok
test pane_ops::tests::attach_writes_the_rebound_content_through_the_layout_store_headless ... ok
test pane_ops::tests::close_pane_requires_auth ... ok
test pane_ops::tab_tests::rest_resume_probe_carries_no_directory_without_ledger_cwd_and_serve_dir_beats_body_cwd ... ok
test pane_ops::tab_tests::rest_resume_resolves_placeholder_sessionref_through_the_ledger ... ok
test pane_ops::tests::attach_pane_for_a_rekeyed_session_resolves_the_canonical_owner ... ok
test pane_ops::tests::close_unknown_pane_is_ok_with_not_found_message ... ok
test pane_ops::tests::layout_snapshot_empty_state_has_legacy_exact_top_level_keys ... ok
test pane_ops::tests::close_only_pane_in_tab_is_refused ... ok
test pane_ops::tests::layout_snapshot_requires_auth ... ok
test pane_ops::store_tests::resize_validation_matrix_is_node_exact ... ok
test pane_ops::tests::layout_snapshot_tab_id_filter_narrows_to_one_tab ... ok
test claude::tests::the_eviction_holds_the_index_across_the_demote_and_remove ... ok
test pane_ops::tests::layout_snapshot_multi_pane_tab_is_a_real_split_node ... ok
test pane_ops::tests::navigate_pane_requires_auth ... ok
test pane_ops::tests::navigate_pane_missing_url_is_400 ... ok
test pane_ops::tests::layout_snapshot_single_pane_tab_is_a_real_leaf_node ... ok
test claude::tests::the_init_adoption_claim_records_the_provenance_initiator ... ok
test pane_ops::tests::legacy_reject_respawn ... ok
test pane_ops::tests::navigate_pane_success_sets_browser_content_and_broadcasts_pane_attach ... ok
test pane_ops::tests::legacy_reject_split ... ok
test pane_ops::tests::navigate_unknown_pane_is_404 ... ok
test pane_ops::tests::select_pane_requires_auth ... ok
test pane_ops::tests::respawn_with_a_stale_observed_fence_cannot_recreate_ownership ... ok
test pane_ops::tab_tests::rest_resume_durable_ses_is_born_durable_with_ledger_settings_and_route ... ok
test pane_ops::tests::respawn_pane_requires_auth ... ok
test pane_ops::tests::resize_pane_requires_auth ... ok
test pane_ops::tests::respawn_resolves_a_browser_created_pane_through_the_layout_store ... ok
test pane_ops::tests::respawn_resolves_a_create_failed_pane_through_the_layout_store ... ok
test pane_ops::tests::split_agent_pane_is_honest_400 ... ok
test claude::tests::the_init_adoption_defers_until_the_runtime_is_registered ... ok
test pane_ops::tests::select_pane_resolves_tab_via_pane_tabs_and_broadcasts ... ok
test claude::tests::the_kill_sweep_spares_a_session_whose_claim_cleared_the_fence ... ok
test pane_ops::tests::respawn_writes_the_recovered_content_through_the_layout_store_headless ... ok
test pane_ops::tests::select_unknown_pane_is_ok_with_not_found_message_and_no_broadcast ... ok
test pane_ops::tests::split_browser_pane_registers_cheap_content_no_terminal ... ok
test pane_ops::tests::split_pane_requires_auth ... ok
test pane_ops::tests::split_host_stats_pane_registers_cheap_content_no_terminal ... ok
test pane_ops::tests::respawn_for_a_session_live_in_a_fresh_agent_sidecar_is_refused ... ok
test pane_ops::tests::respawn_ownership_conflict_returns_typed_owner_info ... ok
test pane_ops::tests::split_terminal_pane_spawns_real_pty_and_broadcasts_pane_split ... ok
test pane_ops::tests::split_unknown_pane_on_empty_store_is_404_no_layout_snapshot ... ok
test pane_ops::tests::swap_pane_requires_auth ... ok
test rollback_record::tests::can_redo_is_a_stored_bit_and_destroy_aware ... ok
test pane_ops::tests::respawn_miss_triggers_the_layout_resync_handshake_and_recovers_the_pane ... ok
test rollback_record::tests::destroy_redo_before_compact_drive_surfaces_a_ledger_failure_and_writes_nothing ... ok
test rollback_record::tests::destroy_redo_before_compact_drive_retires_redo_and_hands_back_the_pre_record ... ok
test rollback_record::tests::destroy_redo_on_submit_is_a_no_op_without_a_record_or_with_nothing_to_destroy ... ok
test rollback_record::tests::destroy_redo_on_submit_marks_redo_destroyed_and_keeps_the_markers ... ok
test rollback_record::tests::explicit_epoch_fields_never_trigger_the_legacy_migration ... ok
test rollback_record::tests::destroy_redo_on_submit_is_idempotent_once_destroyed ... ok
test rollback_record::tests::legacy_anchorless_epochless_record_loads_with_redo_forced_off ... ok
test rollback_record::tests::legacy_claude_anchored_epochless_record_keeps_the_stored_bit ... ok
test rollback_record::tests::legacy_destroyed_epochless_record_loads_as_an_all_frozen_prefix ... ok
test rollback_record::tests::legacy_epochless_record_with_a_clear_destroyed_bit_still_loads_all_frozen ... ok
test rollback_record::tests::pre_epoch_records_parse_to_epoch_zero ... ok
test rollback_record::tests::legacy_undo_send_undo_shape_loads_frozen_appends_after_the_prefix_and_persists_epochs ... ok
test rollback_record::tests::splice_undo_entry_after_destroy_freezes_the_prior_epoch_then_orders_the_new_epoch ... ok
test rollback_record::tests::record_round_trips_through_json ... ok
test rollback_record::tests::splice_undo_entry_orders_same_epoch_undos_conversation_ascending ... ok
test rollback_record::tests::restore_redo_on_undelivered_compact_restores_only_the_row_this_destroy_wrote ... ok
test rollback_record::tests::stamp_rollback_snapshot_omits_the_keys_for_an_empty_union_but_still_floors ... ok
test rollback_record::tests::stamp_rollback_snapshot_redoable_ids_are_empty_when_redo_is_unavailable ... ok
test rollback_record::tests::stamp_rollback_snapshot_lists_only_current_epoch_user_ids_as_redoable ... ok
test rollback_record::tests::stamp_rollback_snapshot_stamps_markers_at_read_time_and_counts_user_steps ... ok
test rollback_record::tests::stamp_rollback_snapshot_stamps_restorable_on_all_roles_matching_the_redoable_rule ... ok
test pane_ops::tests::split_then_close_removes_bookkeeping_but_keeps_pty_alive_no_orphan ... ok
test pane_ops::tests::swap_pane_missing_target_is_approx ... ok
test pane_ops::tests::swap_cross_tab_panes_reports_panes_not_found ... ok
test rename_pane_tests::rename_without_layout_snapshot_is_200_with_message ... ok
test pane_ops::tests::swap_unknown_pane_is_ok_with_panes_not_found_message ... ok
test rename_pane_tests::name_exactly_500_chars_is_ok ... ok
test rename_pane_tests::missing_name_is_400_name_required ... ok
test rename_pane_tests::blank_name_is_400_name_required ... ok
test rename_pane_tests::missing_auth_is_401 ... ok
test pane_ops::tests::respawn_pane_replaces_terminal_in_place_and_broadcasts_pane_attach ... ok
test rename_pane_tests::route_is_matched_not_fallback_404 ... ok
test pane_ops::tests::swap_unknown_other_is_ok_with_panes_not_found_message ... ok
test rename_route_tests::rename_from_non_primary_client_succeeds_and_tab_renamed_uses_that_snapshot ... ok
test rename_pane_tests::name_over_500_chars_is_400_length_message ... ok
test rename_route_tests::rename_pane_renames_store_and_broadcasts_ui_command ... ok
test pane_ops::tests::swap_two_terminal_panes_in_same_tab_exchanges_bookkeeping_and_broadcasts ... ok
test rename_route_tests::rename_pane_never_cascades_for_a_syncable_claude_terminal ... ok
test claude::tests::the_kill_sweep_tears_down_a_session_registered_behind_the_still_standing_close ... ok
test rename_route_tests::rename_pane_unknown_pane_is_200_with_message ... ok
test rename_route_tests::pane_reuse_across_sessions_never_leaves_durable_titles ... ok
test claude::tests::the_live_rollback_adopt_path_rekeys_ownership_to_the_new_id ... ok
test pane_ops::tests::respawn_for_a_pane_that_never_populated_pane_tabs_is_typed_not_found ... ok
test claude::tests::the_quiesce_probe_admits_when_the_sidecar_drains_unstarted_compacts ... ok
test claude::tests::the_session_init_binding_write_precedes_the_commit_and_holds_the_operation ... ok
test claude::tests::two_queued_compacts_are_provably_quiescent_and_absorb_at_the_rollback_gate ... ok
test claude::tests::unrequested_sidecar_death_broadcasts_a_pane_unwedging_error ... ok
test claude_snapshot::tests::claude_snapshot_a_moved_original_tip_forces_can_redo_false ... ok
test claude_snapshot::tests::claude_snapshot_destroyed_redo_keeps_the_marked_bucket ... ok
test claude_snapshot::tests::claude_snapshot_first_turn_undo_keeps_the_whole_bucket_and_can_redo ... ok
test claude_snapshot::tests::claude_snapshot_surfaces_the_ledger_bucket_and_rechecks_the_original_tip ... ok
test claude_snapshot::tests::claude_snapshot_the_bucket_is_the_entries_union_across_epochs ... ok
test claude_snapshot::tests::get_claude_snapshot_floors_the_revision_at_the_record ... ok
test claude_snapshot::tests::kilroy_snapshot_stamps_identically_to_freshclaude ... ok
test claude_snapshot::tests::snapshot_with_no_resolvable_store_root_is_io_not_notfound ... ok
test model_capabilities::tests::claude_catalog_probe_uses_the_configured_sidecar_directory ... ok
test session_handoff::tests::handoff_action_contract_defaults_legacy_ack_only_to_clear ... ok
test session_handoff::tests::a_delayed_platform_limited_reap_fences_the_key_and_never_releases ... ok
test session_handoff::tests::a_flavor_write_failure_surfaces_as_the_typed_handoff_failure ... ok
test session_handoff::tests::a_foreign_commit_during_the_abort_broadcast_window_is_never_overwritten ... ok
test session_handoff::tests::a_fresh_created_claude_session_adopts_the_canonical_key_and_hands_off_atomically ... ok
test session_handoff::tests::handoff_route_refuses_each_half_fenced_observation_typed ... ok
test session_handoff::tests::a_codex_handoff_on_an_old_rebound_reference_resolves_the_permanent_alias ... ok
test session_handoff::tests::handoff_route_requires_auth_with_typed_unauthorized_code ... ok
test session_handoff::tests::a_handoff_on_a_superseded_rekeyed_id_resolves_the_canonical_owner ... ok
test session_handoff::tests::handoff_route_validates_target_kind_typed ... ok
test session_handoff::tests::a_fresh_created_kilroy_session_adopts_the_canonical_key ... ok
test session_handoff::tests::a_handoff_target_exiting_before_the_commit_never_publishes_live ... ok
test codex::tests::fork_in_flight_guard_covers_the_respawn_rekeyed_parent_id ... ok
test session_handoff::tests::a_kilroy_to_claude_cli_handoff_preserves_the_kilroy_flavor ... ok
test session_handoff::tests::a_platform_limited_fence_recovers_only_through_the_acknowledged_force_clear ... ok
test session_handoff::tests::a_platform_limited_target_reap_on_the_flavor_failure_fences_typed ... ok
test session_handoff::tests::a_prior_restored_after_reap_timeout_still_releases_when_it_later_exits ... ok
test codex::tests::fork_on_a_mint_new_respawn_keys_mid_flight_failures_to_the_resolved_parent_id ... ok
test codex::tests::fork_on_a_mint_new_respawn_keys_the_forked_reply_to_the_resolved_parent_id ... ok
test codex::tests::fork_stamps_the_child_from_the_forking_connection_over_the_stale_park ... ok
test codex::tests::get_snapshot_serves_the_empty_snapshot_for_a_thread_not_in_the_live_map ... ok
test codex::tests::get_snapshot_with_no_codex_binary_available_serves_the_empty_snapshot ... ok
test codex::tests::handle_attach_dead_thread_retries_genuinely_after_cache_ttl_expires ... ok
test codex::tests::handle_attach_repeated_dead_thread_spawns_sidecar_at_most_once ... ok
test codex::tests::handle_attach_single_flights_concurrent_resumes_for_the_same_unknown_thread ... ok
test codex::tests::handle_attach_unknown_session_resumes_via_fake_app_server_and_registers_idle_snapshot ... ok
test codex::tests::handle_attach_unknown_session_with_genuinely_missing_thread_emits_lost_session_error ... ok
test codex::tests::handle_attach_unknown_session_with_transient_resume_failure_emits_resume_failed_error ... ok
test codex::tests::handle_attach_unknown_session_wrong_thread_id_is_rejected_not_adopted ... ok
test session_handoff::tests::a_second_rest_drive_settles_the_retained_witness_before_replacing_it ... ok
test session_handoff::tests::a_restored_terminal_prior_still_releases_when_it_later_exits ... ok
test session_handoff::tests::a_stale_start_fence_recovers_through_the_acknowledged_force_clear ... ok
test session_handoff::tests::a_stale_generation_answer_is_retryable_from_the_handler_output ... ok
test session_handoff::tests::a_stale_stop_fence_recovers_through_the_handoff_runner ... ok
test session_handoff::tests::the_row_removed_but_pid_alive_window_reports_unconfirmed ... ok
test session_handoff::tests::a_terminal_target_binding_failure_fails_the_handoff_typed ... ok
test opencode_ws::tests::a_compact_aborted_during_cold_start_restores_the_durably_destroyed_redo ... ok
test session_handoff::tests::a_watcher_join_error_fences_the_key_until_the_replacement_probe_confirms_death ... ok
test session_lease::tests::a_recorded_incarnation_is_killed_through_the_pinned_pidfd ... ok
test session_lease::tests::an_unconfirmable_identity_never_signals_the_pids_occupant ... ok
test session_lease::tests::clear_binding_reopens_after_the_bound_session_exits ... ok
test session_lease::tests::different_sessions_and_providers_do_not_contend ... ok
test session_lease::tests::expired_pidless_is_revoked_and_held_closed_and_late_complete_fails ... ok
test session_lease::tests::expired_with_kill_handle_needs_kill_then_force_release_reopens ... ok
test session_lease::tests::first_claim_acquires_second_is_held ... ok
test session_lease::tests::incomplete_owned_process_evidence_keeps_the_reap_unconfirmed ... ok
test session_lease::tests::set_kill_handle_by_foreign_request_is_a_no_op ... ok
test session_lease::tests::stale_confirmed_teardown_cannot_remove_a_replacement_binding ... ok
test session_handoff::tests::a_watcher_release_mid_failure_window_leaves_the_final_frame_resolved ... ok
test session_lease::tests::the_grace_wait_treats_a_recycled_pid_as_gone_and_never_escalates ... ok
test session_lease::tests::the_recorded_kill_path_never_signals_a_recycled_pid ... ok
test session_lease::tests::winner_complete_records_binding_and_loser_claim_answers_bound_live ... ok
test session_lease::tests::winner_fail_releases_so_loser_acquires ... ok
test session_metadata::tests::metadata_frame_states_the_effective_pair_with_explicit_nulls ... ok
test session_metadata::tests::metadata_frame_survives_a_wire_roundtrip ... ok
test snapshot::tests::authorized_is_constant_time_and_requires_header ... ok
test session_lease::tests::the_grace_wait_reports_a_live_recorded_incarnation_still_present ... ok
test session_handoff::tests::a_wire_fenced_kill_at_the_handoff_generation_converges_after_a_restore ... ok
test opencode_ws::tests::a_send_landing_after_a_coldstart_compact_abort_never_resurrects_redo ... ok
test snapshot::tests::claude_locator_overlays_live_pending_and_flips_capability_gates ... ok
test snapshot::tests::claude_locator_pending_question_entry_is_contract_exact_after_normalize ... ok
test session_handoff::tests::an_abort_after_the_staged_flavor_precursor_never_persists_the_target_flavor ... ok
test snapshot::tests::claude_locator_serves_a_snapshot_from_the_transcript_store ... ok
test snapshot::tests::claude_locator_surfaces_the_durable_rollback_record ... ok
test snapshot::tests::codex_snapshot_success_returns_200_with_camelcase_body ... ok
test snapshot::tests::missing_auth_header_is_401 ... ok
test snapshot::tests::claude_locator_with_a_live_but_empty_pending_set_keeps_the_empty_shape ... ok
test snapshot::tests::opencode_snapshot_success_returns_200_with_camelcase_body ... ok
test snapshot::tests::claude_locator_with_unknown_session_id_is_404_with_lost_session_code ... ok
test snapshot::tests::unknown_session_type_is_400 ... ok
test spawn_gate::tests::acquire_uncancellable_rejects_queue_full_loudly ... ok
test spawn_gate::tests::acquire_uncancellable_times_out_as_timeout_not_cancelled ... ok
test session_handoff::tests::an_abort_cleanup_broadcasts_the_restored_prior_owner ... ok
test spawn_gate::tests::already_cancelled_never_queues ... ok
test spawn_gate::tests::acquire_uncancellable_waits_for_a_permit_and_never_cancels ... ok
test snapshot::tests::kilroy_locator_overlays_live_pending_with_kilroy_session_type ... ok
test spawn_gate::tests::cancel_signal_unblocks_queued_waiter_and_reclaims_slot ... ok
test spawn_gate::tests::bounds_concurrency_to_n_and_all_complete ... ok
test spawn_gate::tests::raii_drop_releases_permit ... ok
test spawn_gate::tests::sender_drop_cancels_queued_waiter ... ok
test spawn_gate::tests::queue_cap_fails_loud ... ok
test spawn_gate::tests::drains_fifo_in_arrival_order ... ok
test spawn_gate::tests::unbounded_acquire_still_fails_loud_on_queue_full ... ok
test spawn_gate::tests::timeout_fails_loud_and_leaks_no_permit ... ok
test spawn_gate::tests::unbounded_acquire_cancels_when_the_watch_fires ... ok
test spawn_gate::tests::unbounded_acquire_waits_past_any_timeout_and_gets_the_released_permit ... ok
test spawn_gate_seam_tests::set_spawn_gate_is_visible_to_every_clone_and_set_once ... ok
test target_resolver::tests::resolves_pane_id_tab_id_tab_title_index_form_and_ambiguous_pane_title ... ok
test spawn_gate_seam_tests::spawn_gate_wired_reflects_oncelock_state ... ok
test spawn_gate_seam_tests::unwired_state_has_no_spawn_gate ... ok
test terminal_tabs::tests::a_failing_rest_create_settles_through_the_witness_to_vacant ... ok
test terminal_tabs::tests::a_handoff_terminal_target_registration_carries_the_handoff_generation ... ok
test terminal_tabs::tests::a_rest_fresh_claude_prealloc_create_commits_live_under_the_minted_key ... ok
test terminal_tabs::tests::a_rest_resume_to_a_missing_session_answers_the_typed_missing_refusal ... ok
test terminal_tabs::tests::a_witnessed_rest_create_survives_the_stale_start_sweep_and_commits ... ok
test terminal_tabs::tests::arm_locators_for_fresh_pane_arms_the_codex_locator ... ok
test terminal_tabs::tests::capture_browser_pane_is_422_use_screenshot_pane ... ok
test terminal_tabs::tests::capture_editor_pane_returns_content_text ... ok
test terminal_tabs::tests::capture_layout_synced_legacy_fresh_agent_pane_is_422 ... ok
test terminal_tabs::tests::capture_unknown_pane_still_404s_pane_not_found ... ok
test terminal_tabs::tests::create_amplifier_tab_fresh_mints_identity_prestubs_and_spawns_resume_argv ... ok
test session_handoff::tests::an_abort_in_the_flavor_window_with_an_unconfirmed_target_teardown_fences_not_vacates ... ok
test terminal_tabs::tests::create_amplifier_tab_rejects_duplicate_live_resume_with_409 ... ok
test terminal_tabs::tests::create_amplifier_tab_rejects_terminal_placeholder_ref_with_400 ... ok
test terminal_tabs::tests::create_amplifier_tab_with_no_cwd_stubs_under_home_slug ... ok
test session_handoff::tests::an_abort_with_a_published_target_pid_outliving_the_reap_budget_fences ... ok
test terminal_tabs::tests::create_amplifier_tab_with_session_ref_flows_into_tab_create_frame ... ok
test terminal_tabs::tests::create_browser_tab_attaches_browser_pane_content_and_no_terminal ... ok
test terminal_tabs::tests::create_amplifier_tab_with_whitespace_resume_id_does_not_synthesize ... ok
test terminal_tabs::tests::create_claude_tab_with_session_ref_flows_into_pane_content ... ok
test terminal_tabs::tests::create_editor_tab_attaches_editor_pane_content ... ok
test terminal_tabs::tests::create_codex_tab_rejects_raw_resume_session_id_without_session_ref ... ok
test terminal_tabs::tests::create_claude_tab_with_non_canonical_resume_id_does_not_synthesize ... ok
test terminal_tabs::tests::abort_burst_rest_creates_stay_gated_and_leave_no_half_bookkept_terminal ... ok
test session_handoff::tests::an_aborted_from_vacant_platform_limited_target_fences_typed_and_recovers ... ok
test terminal_tabs::tests::create_fresh_claude_tab_does_not_warn_missing_identity ... ok
test terminal_tabs::tests::create_host_stats_tab_attaches_host_stats_pane_content_and_no_terminal ... ok
test terminal_tabs::tests::create_fresh_claude_tab_preallocates_session_identity ... ok
test terminal_tabs::tests::create_fresh_session_provider_tab_without_identity_warns_invariant ... ok
test terminal_tabs::tests::create_fresh_claude_tab_with_null_session_ref_still_mints ... ok
test terminal_tabs::tests::create_opencode_tab_fresh_spawns_with_hostname_port_args_and_arms_locator ... ok
test terminal_tabs::tests::create_shell_tab_requires_auth ... ok
test terminal_tabs::tests::create_opencode_tab_with_session_ref_flows_into_pane_content ... ok
test terminal_tabs::tests::create_shell_tab_invokes_terminal_created_hook_with_create_identity ... ok
test terminal_tabs::tests::create_shell_tab_spawns_real_terminal_and_broadcasts_ui_command_tab_create ... ok
test terminal_tabs::tests::create_opencode_tab_with_non_ses_resume_id_does_not_synthesize ... ok
test terminal_tabs::tests::create_shell_tab_without_hook_wired_still_creates ... ok
test terminal_tabs::tests::create_tab_passes_codex_durability_through_and_records_restore_key ... ok
test terminal_tabs::tests::create_tab_defaults_to_shell_mode_when_mode_absent ... ok
test terminal_tabs::tests::create_tab_unregistered_terminal_mode_is_400 ... ok
test terminal_tabs::tests::create_tab_without_registry_wired_is_503 ... ok
test terminal_tabs::tests::create_tab_resume_session_id_flows_to_registry_directory_for_non_codex_mode ... ok
test terminal_tabs::tests::create_tab_rollback_on_spawn_failure_leaves_no_tab_or_pane_or_registry_entry ... ok
test terminal_tabs::tests::create_tab_with_identity_or_shell_mode_does_not_warn_invariant ... ok
test terminal_tabs::tests::failed_fresh_claude_spawn_deletes_its_prespawn_binding ... ok
test terminal_tabs::tests::failed_spawn_releases_its_permit ... ok
test terminal_tabs::tests::fresh_claude_rest_create_drives_binder_prespawn_then_register ... ok
test terminal_tabs::tests::get_panes_lists_created_panes_with_id_and_terminal_id ... ok
test terminal_tabs::tests::get_panes_requires_auth ... ok
test terminal_tabs::tests::get_tabs_requires_auth ... ok
test terminal_tabs::tests::half_fenced_rest_create_answers_the_typed_invalid_fence_code ... ok
test terminal_tabs::tests::legacy_reject_rest_browser_editor_branches ... ok
test terminal_tabs::tests::legacy_reject_rest_create_all_modes ... ok
test terminal_tabs::tests::held_permit_blocks_rest_create_until_released ... ok
test terminal_tabs::tests::forced_terminal_reissue_preserves_process_environment_identity ... ok
test terminal_tabs::tests::legacy_reject_rest_create_dual_carrier ... ok
test terminal_tabs::tests::requested_powershell_shell_spawns_the_configured_powershell_program_on_wsl ... ok
test terminal_tabs::tests::queue_cap_exceeded_rest_create_is_429_spawn_queue_full ... ok
test terminal_tabs::tests::legacy_reject_rest_create_presence_edge_cases ... ok
test terminal_tabs::tests::rest_codex_launch_error_maps_config_to_400_and_failed_to_500 ... ok
test terminal_tabs::tests::rest_codex_managed_launch_gate_is_mode_and_flag_scoped ... ok
test terminal_tabs::tests::rest_codex_resume_echo_matches_router_semantics ... ok
test terminal_tabs::tests::fifteen_plus_rest_create_burst_is_bounded_and_all_complete ... ok
test terminal_tabs::tests::respawn_pane_claude_ends_with_session_identity ... ok
test terminal_tabs::tests::rest_create_honors_caller_supplied_create_request_id ... ok
test terminal_tabs::tests::rest_create_legacy_resume_completes_claim_into_binding ... ok
test terminal_tabs::tests::rest_adopt_death_acquire_settle_commits_the_surviving_terminal ... ok
test terminal_tabs::tests::rest_create_legacy_resume_while_lease_held_is_refused_409 ... ok
test terminal_tabs::tests::rest_create_legacy_resume_onto_live_session_is_refused_409 ... ok
test terminal_tabs::tests::rest_create_resume_handle_race_bound_elsewhere_409_names_the_live_terminal ... ok
test terminal_tabs::tests::rest_create_resume_completes_claim_into_binding ... ok
test terminal_tabs::tests::rest_create_resume_onto_live_session_is_refused_409_restore_unavailable ... ok
test terminal_tabs::tests::rest_create_resume_refused_when_identity_registry_owns_live_session ... ok
test terminal_tabs::tests::rest_create_resume_onto_exited_session_still_works ... ok
test terminal_tabs::tests::rest_create_resume_while_lease_held_is_refused_409 ... ok
test terminal_tabs::tests::rest_create_terminal_tab_mints_and_stamps_create_request_id ... ok
test terminal_tabs::tests::rest_gate_skips_registry_live_candidate_d7_reject_still_fires ... ok
test terminal_tabs::tests::rest_gate_fire_answers_the_typed_missing_refusal ... ok
test terminal_tabs::tests::rest_gate_fired_claude_fallback_preallocates_nothing_because_nothing_started ... ok
test terminal_tabs::tests::rest_pane_exit_retires_identity_via_binder ... ok
test terminal_tabs::tests::rest_respawn_resume_after_owner_exits_succeeds ... ok
test terminal_tabs::tests::rest_resume_amplifier_absent_answers_the_missing_verdict ... ok
test terminal_tabs::tests::rest_resume_claude_absent_answers_the_missing_verdict ... ok
test terminal_tabs::tests::rest_resume_codex_absent_drops_resume ... ok
test terminal_tabs::tests::rest_resume_unknown_and_present_fail_open ... ok
test terminal_tabs::tests::rest_resume_without_probe_is_passthrough ... ok
test terminal_tabs::tests::rest_respawn_resume_onto_live_session_is_refused_409 ... ok
test terminal_tabs::tests::rest_respawn_same_pane_own_live_session_is_refused_409 ... ok
test terminal_tabs::tests::rest_split_resume_onto_live_session_is_refused_409 ... ok
test terminal_tabs::tests::resume_claude_rest_create_registers_identity_without_prespawn_write ... ok
test terminal_tabs::tests::send_keys_then_wait_for_then_capture_round_trips_a_real_shell_command ... ok
test terminal_tabs::tests::send_keys_unknown_pane_falls_through_to_pane_not_found_404 ... ok
test terminal_tabs::tests::split_pane_claude_preallocates_fresh_session_identity ... ok
test terminal_tabs::tests::split_and_respawn_also_flow_through_the_gate ... ok
test terminal_tabs::tests::successful_rest_claim_commit_does_not_drop_its_ticket_unarmed ... ok
test terminal_tabs::tests::wait_for_requires_auth ... ok
test terminal_tabs::tests::wait_for_unknown_pane_is_404_terminal_not_found ... ok
test terminal_tabs::tests::zero_permit_gate_times_out_rest_create_with_503 ... ok
test tests::a_committed_lane_claim_broadcasts_the_owner_record ... ok
test tests::a_handoff_during_the_resume_adopt_window_is_blocked_typed ... ok
test tests::a_post_restart_resume_commits_live_and_send_keys_succeeds ... ok
test tests::a_resume_while_a_terminal_owns_answers_the_typed_owner_response ... ok
test tests::a_stale_recorded_generation_resume_is_refused_typed ... ok
test tests::authorized_is_constant_time_and_requires_header ... ok
test tests::background_delegation_completes_with_child_span_duration ... ok
test tests::background_delegation_stays_running_while_child_is_active ... ok
test tests::background_delegation_with_busy_status_map_and_only_user_message_stays_running ... ok
test tests::child_message_events_refresh_the_parent_session_changed_frame ... ok
test tests::commit_lane_claim_refuses_a_runtime_that_already_exited ... ok
test tests::concurrent_rest_materializations_yield_exactly_one_provider_mutation ... ok
test tests::concurrent_same_session_resumes_are_separate_operations ... ok
test session_handoff::tests::an_aborted_from_vacant_unconfirmed_target_fences_with_a_replacement_watcher ... ok
test terminal_tabs::tests::wait_for_never_matching_pattern_times_out_as_approx ... ok
test tests::create_tab_records_pending_marker ... ok
test tests::get_opencode_snapshot_of_unknown_session_is_not_found ... ok
test tests::get_opencode_snapshot_joins_child_activity_rows_into_the_delegation ... ok
test tests::get_opencode_snapshot_over_a_failed_captured_serve_degrades_to_disk_state ... ok
test tests::get_opencode_snapshot_returns_a_schema_shaped_snapshot_with_turn_text ... ok
test tests::get_opencode_snapshot_serves_a_session_never_created_by_this_process ... ok
test tests::get_opencode_snapshot_surfaces_the_durable_rollback_record ... ok
test tests::get_opencode_snapshot_survives_a_child_transport_error ... ok
test tests::get_opencode_snapshot_survives_a_pruned_child_session ... ok
test tests::materialized_frame_carries_placeholder_and_durable ... ok
test tests::non_background_and_errored_delegations_keep_parent_status ... ok
test tests::opencode_child_activity_preview_formats_common_tools ... ok
test tests::opencode_child_activity_rows_cap_at_200 ... ok
test tests::opencode_child_activity_rows_collects_tool_parts_from_child_messages ... ok
test tests::opencode_item_from_part_balanced_think_short_tag_alias_also_segments ... ok
test tests::opencode_item_from_part_balanced_think_tag_splits_into_thinking_and_text_items ... ok
test tests::opencode_item_from_part_blank_tool_error_is_dropped ... ok
test tests::opencode_item_from_part_completed_and_running_tool_with_lingering_error_omit_the_key ... ok
test tests::opencode_item_from_part_error_tool_carries_the_persisted_state_error_text ... ok
test tests::opencode_item_from_part_patch_renders_file_change_kind_with_exact_schema_keys ... ok
test tests::opencode_item_from_part_reasoning_bold_title_awaiting_body_is_title_only ... ok
test tests::opencode_item_from_part_reasoning_bold_without_blank_line_is_not_a_title ... ok
test tests::opencode_item_from_part_reasoning_leading_bold_block_becomes_title ... ok
test tests::opencode_item_from_part_reasoning_part_carries_duration_without_title ... ok
test tests::opencode_item_from_part_reasoning_renders_reasoning_kind ... ok
test tests::opencode_item_from_part_reasoning_without_time_has_no_duration ... ok
test tests::opencode_item_from_part_retry_part_becomes_retry_item ... ok
test tests::opencode_item_from_part_retry_part_defaults_attempt_and_string_error ... ok
test tests::opencode_item_from_part_running_tool_has_no_content_items_or_success ... ok
test tests::opencode_item_from_part_structural_step_start_is_skipped_matching_reference_default ... ok
test tests::opencode_item_from_part_subtask_part_becomes_delegated_task ... ok
test tests::opencode_item_from_part_task_tool_part_background_and_custom_subagent ... ok
test tests::opencode_item_from_part_task_tool_part_becomes_task_delegation ... ok
test tests::opencode_item_from_part_task_tool_part_minimal_has_title_and_no_child ... ok
test tests::opencode_item_from_part_text_without_any_think_tag_is_unchanged ... ok
test tests::opencode_item_from_part_tool_part_renders_dynamic_tool_kind_with_exact_schema_keys ... ok
test tests::opencode_item_from_part_unbalanced_open_tag_only_splits_text_before_and_thinking_after ... ok
test tests::opencode_item_from_part_user_text_is_never_segmented_even_with_think_tags ... ok
test tests::opencode_message_turn_json_ignores_a_malformed_error_payload ... ok
test tests::get_opencode_snapshot_timeout_never_kills_the_shared_daemon ... ok
test tests::opencode_message_turn_json_omits_error_for_a_normal_assistant_turn ... ok
test tests::opencode_message_turn_json_projects_the_persisted_unknown_error_verbatim ... ok
test tests::opencode_message_turn_json_projects_message_aborted_error ... ok
test tests::opencode_message_turn_json_renders_a_messageless_error_as_cli_pretty_json ... ok
test tests::opencode_message_turn_json_renders_both_tool_and_text_parts_in_one_message ... ok
test tests::opencode_snapshot_destroyed_redo_keeps_the_marked_bucket_alive ... ok
test tests::opencode_snapshot_filters_turns_to_the_active_prefix_and_marks_the_tail ... ok
test session_handoff::tests::an_opencode_placeholder_handoff_resolves_the_durable_owner_and_completes ... ok
test tests::opencode_snapshot_stamps_capabilities_and_the_ledger_marker_bucket ... ok
test tests::opencode_snapshot_marker_order_is_stable_across_repeated_undos ... ok
test tests::opencode_task_result_text_unwraps_envelope_and_passes_raw_through ... ok
test tests::opencode_turn_summary_truncates_the_text_join_and_tags_echo ... ok
test tests::released_owner_frame_carries_the_committed_pair_not_the_current_generation ... ok
test tests::render_transcript_collects_text_parts_and_contains_reply ... ok
test tests::render_transcript_falls_back_to_raw_for_unknown_shape ... ok
test tests::resolve_probe_timeout_ms_env_parse_wins_over_default ... ok
test tests::resolve_probe_timeout_ms_garbage_env_falls_to_default ... ok
test tests::resolve_probe_timeout_ms_missing_env_is_default ... ok
test tests::resolve_probe_timeout_ms_state_override_beats_env ... ok
test tests::opencode_snapshot_undone_depth_counts_user_steps_not_entries ... ok
test tests::rest_materialization_commit_stale_answers_the_typed_envelope ... ok
test tests::rest_materialization_refused_conflict_answers_the_typed_envelope ... ok
test tests::rest_materialization_adopt_conflict_answers_the_typed_owner_envelope ... ok
test tests::rest_send_keys_materialization_records_lineage_for_all_blank_settings ... ok
test tests::rest_send_keys_materialization_records_binding ... ok
test tests::rest_send_keys_refuses_typed_when_the_minted_key_was_lost ... ok
test tests::rest_send_keys_refuses_a_foreign_owned_session_typed ... ok
test tests::sessions_changed_revision_is_unified_across_ws_and_freshagent_producers ... ok
test tests::shutdown_is_safe_when_no_serve_started ... ok
test tests::value_as_secs_parses_number_and_string ... ok
test tests::wire_fence_rejects_each_half_fenced_combination_typed ... ok
test tests::create_tab_pending_write_failure_broadcasts_ledger_write_failed_and_still_creates ... ok
test tests::with_shared_sessions_revision_draws_from_the_injected_counter ... ok
test tests::rest_send_keys_create_failure_settles_the_provisional_record ... ok
test tests::rest_send_keys_window_holds_a_coordinator_starting_record ... ok
test codex::tests::handle_create_always_broadcasts_created_before_any_session_event ... ok
test codex::tests::handle_create_concurrent_duplicate_request_id_spawns_at_most_once ... ok
test codex::tests::handle_create_distinct_request_ids_create_distinct_sessions ... ok
test codex::tests::handle_create_duplicate_after_explicit_kill_creates_a_fresh_session ... ok
test codex::tests::handle_create_duplicate_request_id_reuses_the_session_and_spawns_once ... ok
test codex::tests::handle_create_replay_after_unrequested_exit_reuses_the_dead_session_no_new_spawn ... ok
test codex::tests::handle_create_with_resume_on_genuinely_missing_thread_emits_create_failed ... ok
test codex::tests::handle_create_with_resume_wrong_thread_id_fails_create_and_never_adopts ... ok
test codex::tests::handle_create_with_session_ref_only_resumes_the_same_thread ... ok
test session_handoff::tests::an_unconfirmable_retained_witness_refuses_the_replacement_typed ... ok
test codex::tests::handle_create_with_session_ref_resumes_the_same_thread ... ok
test codex::tests::handle_fork_child_resume_failure_replies_and_best_effort_unarchives_the_child ... ok
test session_handoff::tests::an_unconfirmed_target_reap_on_the_flavor_failure_fences_then_the_watcher_resolves ... ok
test codex::tests::handle_fork_child_spawn_failure_replies_and_best_effort_unarchives_the_child ... ok
test session_handoff::tests::handoff_abort_after_terminal_prior_kill_never_restores_a_dead_prior ... ok
test codex::tests::handle_fork_child_unarchive_failure_replies_and_best_effort_unarchives_the_child ... ok
test session_handoff::tests::handoff_abort_cleanup_spares_a_same_id_different_provider_terminal ... ok
test codex::tests::handle_fork_threads_fork_archive_then_child_unarchive_resume_across_two_sidecars_and_replies_forked ... ok
test session_handoff::tests::handoff_abort_during_fresh_target_resume_reaps_the_registered_session_and_keeps_retryability ... ok
test codex::tests::hollow_adopt_provenance_never_overrides_the_parked_stamps_or_the_row ... ok
test codex::tests::hollow_create_provenance_parks_nothing_and_stamps_nothing ... ok
test session_handoff::tests::handoff_abort_during_pre_publication_spawn_fences_until_the_spawn_settles ... ok
test session_handoff::tests::handoff_abort_during_prior_kill_reprobes_and_repairs_the_stamp ... ok
test codex::tests::ledger_write_failure_is_surfaced_as_a_live_frame ... ok
test session_handoff::tests::handoff_abort_during_target_spawn_reaps_the_uncommitted_terminal ... ok
test codex::tests::resume_after_restart_reapplies_settings_from_ledger ... ok
test codex::tests::resume_create_after_a_kill_clears_the_tombstone_and_rebinds ... ok
test codex::tests::resume_of_a_never_recorded_session_is_silent_and_writes_no_defaults_row ... ok
test session_handoff::tests::handoff_abort_holds_the_fence_until_the_uncommitted_target_continuation_settles ... ok
test session_handoff::tests::handoff_abort_of_a_fresh_target_fires_the_failed_transition_repair ... ok
test session_handoff::tests::handoff_continues_to_consistency_when_client_disconnects ... ok
test session_handoff::tests::handoff_reap_timeout_fences_the_key_until_the_detached_reap_confirms_death ... ok
test session_handoff::tests::handoff_reap_timeout_reprobes_the_prior_and_restores_only_a_live_one ... ok
test codex::tests::resume_parses_the_rollouts_durable_history_mode ... ok
test session_handoff::tests::handoff_reap_timeout_with_unconfirmable_prior_ends_vacant_typed ... ok
test codex::tests::resume_with_a_prior_record_but_unrecoverable_settings_alarms_settings_reset ... ok
test codex::tests::send_after_crash_falls_back_to_mint_new_thread_when_resume_reports_not_found ... ok
test codex::tests::send_after_crash_mint_new_thread_broadcasts_thread_memory_lost_after_materialized ... ok
test codex::tests::send_after_crash_with_transient_resume_failure_reports_respawn_failed_and_stays_exited ... ok
test codex::tests::send_after_unrequested_crash_resumes_the_same_thread_id_and_completes_with_no_error_frame ... ok
test codex::tests::the_codex_handoff_target_binding_carries_the_handoff_generation ... ok
test codex::tests::the_create_binding_write_precedes_the_commit_and_holds_the_operation ... ok
test codex::tests::the_explicit_kill_broadcasts_the_release_and_the_recreate_converges ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::create_bail_after_spawn_leaves_no_record ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::create_enriches_the_record_with_the_served_thread_id ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::create_writes_a_freshagent_laned_record_for_the_real_sidecar ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::durable_writer_fixture_exposes_live_witness_and_is_reaped_with_the_sidecar ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::durable_writer_fixture_survives_direct_app_server_exit ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::failed_spawn_leaves_no_record ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::handle_kill_leaves_no_record ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::next_generation_holds_then_reaps_a_freshagent_survivor_never_claiming_it has been running for over 60 seconds
test codex_sidecar_tracking::codex_sidecar_tracking_tests::record_is_skipped_cleanly_when_no_store_is_installed has been running for over 60 seconds
test codex_sidecar_tracking::codex_sidecar_tracking_tests::requested_kill_arm_removes_the_record has been running for over 60 seconds
test codex_sidecar_tracking::codex_sidecar_tracking_tests::shutdown_leaves_no_records has been running for over 60 seconds
test codex_sidecar_tracking::codex_sidecar_tracking_tests::spawn_record_carries_verifiable_proc_identity_and_freshagent_lane has been running for over 60 seconds
test codex_sidecar_tracking::codex_sidecar_tracking_tests::unrequested_exit_arm_removes_the_record has been running for over 60 seconds
test codex_sidecar_tracking::codex_sidecar_tracking_tests::next_generation_holds_then_reaps_a_freshagent_survivor_never_claiming_it ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::record_is_skipped_cleanly_when_no_store_is_installed ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::requested_kill_arm_removes_the_record ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::shutdown_leaves_no_records ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::spawn_record_carries_verifiable_proc_identity_and_freshagent_lane ... ok
test codex_sidecar_tracking::codex_sidecar_tracking_tests::unrequested_exit_arm_removes_the_record ... ok
test snapshot::tests::unknown_codex_thread_serves_the_side_effect_free_empty_snapshot ... ok
test terminal_tabs::tests::create_codex_tab_accepts_session_ref_and_derives_resume_args ... ok
test terminal_tabs::tests::managed_codex_terminal_tab_supplies_sidecar_context ... ok
test terminal_tabs::tests::rest_gate_skips_sidecar_live_candidate_then_d7_refuses ... ok
test terminal_tabs::tests::send_keys_enter_feeds_codex_locator ... ok
test session_handoff::tests::handoff_route_refuses_provider_mismatched_targets_typed ... ok
test session_handoff::tests::handoff_route_resolves_absent_session_type_when_unambiguous ... ok
test session_handoff::tests::handoff_target_spawn_failure_leaves_vacant_with_typed_error ... ok
test session_handoff::tests::handoff_task_abort_leaves_zero_or_one_owner ... ok
test session_handoff::tests::handoff_to_a_kilroy_target_resumes_as_kilroy_on_the_claude_lane ... ok
test session_handoff::tests::handoff_to_terminal_reaps_sidecar_before_target_start_and_commits_owner ... ok
test session_handoff::tests::handoff_with_a_platform_limited_prior_stop_fences_the_key_typed ... ok
test session_handoff::tests::handoff_with_an_unconfirmable_claude_tree_fences_the_key_until_the_escalation_lands ... ok
test session_handoff::tests::opencode_handoff_during_compaction_aborts_the_daemon_side_summarize ... ok
test session_handoff::tests::opencode_handoff_keeps_shared_serve_alive_and_session_id_stable ... ok
test session_handoff::tests::opencode_handoff_stop_aborts_a_daemon_turn_left_running_by_a_finished_local_task ... ok
test session_handoff::tests::opencode_handoff_stop_aborts_an_in_flight_rest_driven_turn_before_reaping ... ok
test session_handoff::tests::opencode_handoff_stop_aborts_the_active_turn_through_the_manager_before_reaping ... ok
test session_handoff::tests::opencode_handoff_stop_waits_for_a_mid_dispatch_rest_drive_under_the_gate has been running for over 60 seconds
test session_handoff::tests::the_acknowledged_start_over_an_already_dead_prior_proceeds has been running for over 60 seconds
test session_handoff::tests::the_acknowledged_start_reaps_the_live_prior_before_the_new_writer has been running for over 60 seconds
test session_handoff::tests::the_claude_handoff_target_binding_carries_the_handoff_generation has been running for over 60 seconds
test session_handoff::tests::the_cleared_unverified_state_requires_the_acknowledged_start has been running for over 60 seconds
test session_handoff::tests::the_confirmed_reap_flavor_failure_broadcasts_the_truthful_vacancy has been running for over 60 seconds
test session_handoff::tests::the_flavor_write_serializes_consecutive_handoffs_in_generation_order has been running for over 60 seconds
test session_handoff::tests::the_handoff_commit_writes_the_durable_flavor_server_side has been running for over 60 seconds
test session_handoff::tests::the_platform_limited_reap_failure_frame_stays_fenced_never_vacant has been running for over 60 seconds
test session_handoff::tests::opencode_handoff_stop_waits_for_a_mid_dispatch_rest_drive_under_the_gate ... ok
test session_handoff::tests::the_acknowledged_start_over_an_already_dead_prior_proceeds ... ok
test session_handoff::tests::the_acknowledged_start_reaps_the_live_prior_before_the_new_writer ... ok
test session_handoff::tests::the_prior_stop_never_confirms_on_a_missing_row has been running for over 60 seconds
test session_handoff::tests::the_replacement_probe_never_confirms_a_terminal_prior_on_a_missing_row has been running for over 60 seconds
test session_handoff::tests::the_spawn_settle_reconfirmation_does_not_confirm_a_live_recorded_pid has been running for over 60 seconds
test session_handoff::tests::the_claude_handoff_target_binding_carries_the_handoff_generation ... ok
test session_handoff::tests::the_stale_commit_unconfirmed_reap_frame_stays_fenced_never_vacant has been running for over 60 seconds
test session_handoff::tests::the_uncommitted_target_reap_never_confirms_on_a_missing_row has been running for over 60 seconds
test session_handoff::tests::the_cleared_unverified_state_requires_the_acknowledged_start ... ok
test session_handoff::tests::the_unconfirmed_reap_flavor_failure_frame_stays_fenced_never_vacant has been running for over 60 seconds
test session_handoff::tests::the_confirmed_reap_flavor_failure_broadcasts_the_truthful_vacancy ... ok
test session_handoff::tests::the_flavor_write_serializes_consecutive_handoffs_in_generation_order ... ok
test session_handoff::tests::the_handoff_commit_writes_the_durable_flavor_server_side ... ok
test session_handoff::tests::the_platform_limited_reap_failure_frame_stays_fenced_never_vacant ... ok
test session_handoff::tests::the_prior_stop_never_confirms_on_a_missing_row ... ok
test session_handoff::tests::the_replacement_probe_never_confirms_a_terminal_prior_on_a_missing_row ... ok
test session_handoff::tests::unsupported_atomic_handoff_refuses_before_mutation_and_clear_bypasses_preflight has been running for over 60 seconds
test snapshot::tests::opencode_cold_get_never_spawns_and_serves_the_empty_disk_snapshot has been running for over 60 seconds
test snapshot::tests::opencode_cold_get_owned_or_transitioning_answers_the_typed_409 has been running for over 60 seconds
test session_handoff::tests::the_spawn_settle_reconfirmation_does_not_confirm_a_live_recorded_pid ... ok
test session_handoff::tests::the_stale_commit_unconfirmed_reap_frame_stays_fenced_never_vacant ... ok
test session_handoff::tests::the_uncommitted_target_reap_never_confirms_on_a_missing_row ... ok
test session_handoff::tests::the_unconfirmed_reap_flavor_failure_frame_stays_fenced_never_vacant ... ok
test session_handoff::tests::unsupported_atomic_handoff_refuses_before_mutation_and_clear_bypasses_preflight ... ok
test snapshot::tests::opencode_cold_get_never_spawns_and_serves_the_empty_disk_snapshot ... ok
test snapshot::tests::opencode_cold_get_owned_or_transitioning_answers_the_typed_409 ... ok

failures:

---- claude::tests::a_settings_changing_send_broadcasts_session_metadata stdout ----

thread 'claude::tests::a_settings_changing_send_broadcasts_session_metadata' (2371118) panicked at crates/freshell-freshagent/src/claude.rs:22715:14:
a settings-changing send broadcasts metadata
note: run with `RUST_BACKTRACE=1` environment variable to display a backtrace

---- codex::tests::a_stale_fence_compact_against_a_vacated_key_is_refused_typed_no_recreation stdout ----

thread 'codex::tests::a_stale_fence_compact_against_a_vacated_key_is_refused_typed_no_recreation' (2383903) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_fence_fork_against_a_vacated_key_is_refused_typed_no_recreation stdout ----

thread 'codex::tests::a_stale_fence_fork_against_a_vacated_key_is_refused_typed_no_recreation' (2384021) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_fence_undo_against_a_vacated_key_is_refused_typed_no_recreation stdout ----

thread 'codex::tests::a_stale_fence_undo_against_a_vacated_key_is_refused_typed_no_recreation' (2384565) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_generation_compact_against_a_vacated_key_is_refused_typed stdout ----

thread 'codex::tests::a_stale_generation_compact_against_a_vacated_key_is_refused_typed' (2384724) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_generation_crashed_attach_is_refused_typed_no_recreation stdout ----

thread 'codex::tests::a_stale_generation_crashed_attach_is_refused_typed_no_recreation' (2385338) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_generation_fork_against_a_vacated_key_is_refused_typed stdout ----

thread 'codex::tests::a_stale_generation_fork_against_a_vacated_key_is_refused_typed' (2385721) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_generation_send_against_a_crashed_session_is_refused_typed stdout ----

thread 'codex::tests::a_stale_generation_send_against_a_crashed_session_is_refused_typed' (2385859) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- codex::tests::a_stale_generation_undo_against_a_vacated_key_is_refused_typed stdout ----

thread 'codex::tests::a_stale_generation_undo_against_a_vacated_key_is_refused_typed' (2385980) panicked at crates/freshell-freshagent/src/codex.rs:19241:9:
assertion `left == right` failed: fixture create failed: {"type":"freshAgent.create.failed","code":"FRESH_AGENT_CREATE_FAILED","message":"session ownership changed during create; torn down","requestId":"req-1","retryable":true}
  left: String("freshAgent.create.failed")
 right: "freshAgent.created"

---- opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership stdout ----

thread 'opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership' (2414089) panicked at crates/freshell-freshagent/src/opencode_ws.rs:11625:9:
the typed error answers: {"type":"freshAgent.event","event":{"type":"freshAgent.session.snapshot","sessionId":"ses_r15_f1_stale_attach","status":"idle"},"provider":"opencode","sessionId":"ses_r15_f1_stale_attach","sessionType":"freshopencode"}


failures:
    claude::tests::a_settings_changing_send_broadcasts_session_metadata
    codex::tests::a_stale_fence_compact_against_a_vacated_key_is_refused_typed_no_recreation
    codex::tests::a_stale_fence_fork_against_a_vacated_key_is_refused_typed_no_recreation
    codex::tests::a_stale_fence_undo_against_a_vacated_key_is_refused_typed_no_recreation
    codex::tests::a_stale_generation_compact_against_a_vacated_key_is_refused_typed
    codex::tests::a_stale_generation_crashed_attach_is_refused_typed_no_recreation
    codex::tests::a_stale_generation_fork_against_a_vacated_key_is_refused_typed
    codex::tests::a_stale_generation_send_against_a_crashed_session_is_refused_typed
    codex::tests::a_stale_generation_undo_against_a_vacated_key_is_refused_typed
    opencode_ws::tests::a_stale_fence_map_hit_attach_cannot_reclaim_vacated_ownership

test result: FAILED. 1144 passed; 10 failed; 0 ignored; 0 measured; 0 filtered out; finished in 129.49s in .github/workflows/rust-tests.yml. This is test-infra only, outside the six, recorded as a landing-blocking amendment.

- **D7 (landing blocker, second layer):** With D6 fixing the CI fixture boot, the rust-gate now exposes the PR #795-landed freshagent red family itself — deterministic in CI and locally. Investigation (reports/investigate-795-family.md) splits it: (a) TEST-ROT x8 codex a_stale_fence/generation tests — their fixtures script the sidecar to die at thread/start and expect create to succeed, but #795's r30 F1 deliberately refuses to publish a dead-at-commit sidecar (commit_lane_claim sees /proc/<pid> gone -> ForeignOperation teardown -> freshAgent.create.failed); fixtures updated to crash/flip exited AFTER commit, preserving each test's stale-fence/generation assertion intent; (b) TEST-ROT x1 opencode_ws a_stale_fence_map_hit — fixture seeds real_session_id: None, which #795's gate-C reclassified as observation-only placeholder; seed a materialized row; (c) REAL REGRESSION x1 a_settings_changing_send_broadcasts_session_metadata — #795 silently dropped the send-time freshAgent.session.metadata broadcast from handle_send (present at bf9b8d31a, gone at 38939b56d); restore it mirroring claude.rs:4407-4416; (d) fork_in_flight_guard — same dead-at-thread/start pattern family (Elapsed waiting for the respawn broadcast that the new teardown prevents); same fixture-pattern fix; (e) session_handoff a_codex_handoff — spawns the REAL codex binary (ENOENT on the CI runner, passes only where a host codex exists); make it hermetic via the committed fake app-server (CODEX_CMD wrapper) like its sibling tests. This unblocks every Rust-touching PR on main, not just this one. Scope: recorded plan-owner amendment under the pre-approved landing mandate; katas 7ad4/17eh/p6q2 close with it; 84nb separately recorded.
