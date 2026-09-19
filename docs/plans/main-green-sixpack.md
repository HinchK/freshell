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

**Goal:** All six standing failures on main go green — the four e2e specs pass with the title-precedence contract restored in the product, and the two Rust flakes (59nb capture race, hsrh session-init race) are fixed at their diagnosed mechanisms — proven by a green full local suite.

**Architecture:** One coherent product-side title-precedence resolution (Task 1: explicit creator/user titles outrank mirrored and auto titles; server-fabricated live-terminal session rows carry no title, while the client's sidebar label falls back to the provider label so placeholder rows stay meaningful) that the four e2e specs already encode, so they flip red→green as the regression proofs; two Rust test-infrastructure fixes — migrate the freshell-ws lib capture util to the repo's e08g process-global OnceLock pattern with per-test-unique-field filtering (Task 3), and delete the merge-repair-resurrected zombie test while landing the stranded either-order combined drain on its live siblings (Tasks 4–5); a full-suite gate closes the campaign (Task 6).

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
4. **The 59nb capture migration's consumer-filter audit is complete and load-bearing.** Converting `capture()` to a process-global OnceLock subscriber routes EVERY test's events into one shared vec; each of the 26 consumer call sites across 5 files must filter by a per-test-unique field (`root`/`path`/`device_id`/`terminal_id`), and colliding ids must be made unique per test — in `invariants.rs` the shared ids are REAL: `t-ev` is used by BOTH `:760` (expects exactly one warning) and `:801` (expects none), `t-late` by BOTH `:1154` (expects a warning) and `:939` (expects none), and `t-young` (`:585`/`:992`) and `t-idle` (`:709`/`:1234`) are each shared by two tests as well; the unresolved-warning event carries ONLY `terminal_id`/`mode`/`age_ms` (`invariants.rs:232-237`), so terminal-id renaming per test is the ONLY available discriminator there. A missed consumer (or a missed id collision) turns the rare race into a deterministic false-fail (exact-count/negative assertions) or false-pass (`.any()` assertions) under parallelism. The same weakness applies to the two OTHER thread-local `set_default` captures in the binary (`pane_ledger_tests.rs`'s `lock_failure_capture`, `create_dedupe.rs`'s DIAG-01 inline capture) — Task 3 folds them into the same migration, so after it NO thread-local capture remains. Task 3 enumerates every site and every collision; none may be skipped.

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

**Plus: fabricated live-terminal session rows carry NO title, and the client keeps their label meaningful at display time.** Two halves:
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
- **sidebar-opencode-rail :326-328** — the pane is harness-created (no REST name in play); under the fabricated-row rule the child2 placeholder row carries no title → the mirror never fires → the pane title stays the `initLayout`-derived cwd-leaf `railsubagentpane` → `Pane: railsubagentpane` renders. Passes as written; this spec IS the red→green regression test for the fabricated-row fix.

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

**Interfaces:**
- Consumes: `addTab` payload field `titleSetByUser?: boolean` (`src/store/tabsSlice.ts:293`, reducer stores it at `:330`); `getTabDisplayTitle`'s `titleSetByUser` branch (`src/lib/tab-title.ts:28-30`); the mirror's `if (!session.title) continue` guard (`src/store/sessionTitleMirror.ts:44`); `getProviderLabel` (`src/lib/coding-cli-utils.ts:33`, already imported by `sidebarSelectors.ts:8`).
- Produces: the contract that every `ui.command{tab.create}` broadcast carrying a non-empty `payload.title` (only ever caller-provided: verified across all three emitters) folds into Redux with `titleSetByUser: true`; that `DirItem`s synthesized by `build_live_terminal_session_item` carry `title: None` (`provider_display_name` DELETED together with its `mod join_tests` parity test — after the fabrication is removed its only consumer is its own unit test, which then protects no shipped behavior; deleting both is cleaner than `#[cfg(test)]`-gating, and a now-unused module-level fn would also fail clippy `-D warnings` and the pre-push gate); and that the sidebar row's main label for a title-less running live-terminal row is `getProviderLabel(provider)`. Task 2 and the four e2e specs depend on all three.

- [ ] **Step 1: Baseline red confirmation at dbbfd0752 (BEFORE any fix)**

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

- [ ] **Step 2: Write the failing unit tests (client fold + sidebar label)**

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

- [ ] **Step 3: Run them and verify the intended failures**

Run: `npm run test:vitest -- run test/unit/client/ui-commands.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts`

Expected: FAIL both — the fold test fails because the fold never sets `titleSetByUser` (first expectation receives `undefined`); the selector test fails because the title-less running rows render `'terminal'`/`'ses-chil'` (the `sessionId.slice(0, 8)` fallback). The trailing unnamed-create and real-row expectations are the pins that must hold after the change.

- [ ] **Step 4: Minimal production implementation (client + server + contract doc)**

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

- [ ] **Step 5: Run the focused tests green**

```bash
npm run test:vitest -- run test/unit/client/ui-commands.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/sessionTitleMirror.test.ts test/unit/client/store/tabsPersistence.test.ts test/unit/client/lib/terminal-inventory-titles.test.ts
cargo test -p freshell-server --locked --bin freshell-server session_directory
```

Expected: PASS on all (the Step-3 reds and the 4b reds are now green).

- [ ] **Step 6: Refactor while green**

Small but real: confirm `provider_display_name`'s deletion left NOTHING behind (`rg -n "provider_display_name" crates/freshell-server/src/` — ZERO hits: the fn, its doc comment, and the `join_tests` parity test are all gone), and confirm no other `tab.create` consumer in the client reads `titleSetByUser` from the payload (grep `titleSetByUser` in `src/lib/` — the fold is the only writer of the flag outside explicit renames). Confirm `hasTitle` semantics are unchanged in `buildSessionItems` (still `!!session.title`; the provider-label rung is display-only).

- [ ] **Step 7: Impacted-test verification**

Impacted set: everything that renders or persists tab titles, everything that consumes fabricated session rows, and both analyzed `titleSetByUser` side effects:
- Unit: `npm run test:vitest -- run test/unit/client/` (the whole client unit tree is fast; it covers tabsSlice/persistMiddleware/persistedState/tab-registry-snapshot/TabBar/HistoryView/Sidebar selectors that touch titles and fabricated rows — including the `shouldKeepClosedTab` keep-policy suites for named agent tabs and the OSC/`(exit N)` title-freeze behavior, both analyzed as intended consequences in the Resolution).
- Rust: `cargo test -p freshell-server --locked --bin freshell-server` (the whole server bin unit suite — session_directory feeds /api/sessions consumers).
- Fabricated-title consumers audit (grep-verified baseline, confirm and record): the sidebar row's main label is `sidebarSelectors.ts:264` rendered at `Sidebar.tsx:1175` — now the provider-label rung (4c-2); `Sidebar.tsx:1199` is the tooltip's project line and is untouched. `src/components/HistoryView.tsx:479-483` keeps `session.title || sessionId.slice(0, 8)` for its main label WITH its existing `getProviderLabel` badge right beside it — accepted residual (the cited regression is the sidebar row, which has no badge). Unit fixtures in `test/unit/client/store/selectors/sidebarSelectors.runningTerminal.test.ts` exercise the client-side fallback rows (`buildSessionItems([], …, terminals, …)`), which already use `getProviderLabel` — unaffected by the server change. No e2e spec asserts a provider label ON a live-terminal fabricated row (verified by grep over `test/e2e-browser/specs/`; re-grep `OpenCode`/`Codex CLI`/`Claude CLI` sidebar-row assertions to confirm — the current hits are pickers, pane headers, and banners).
- The four e2e specs re-run green in Task 2 (do not double-run here).

Run: `npm run test:vitest -- run test/unit/client/ && cargo test -p freshell-server --locked --bin freshell-server`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ui-commands.ts src/store/selectors/sidebarSelectors.ts crates/freshell-server/src/session_directory.rs test/unit/client/ui-commands.test.ts test/unit/client/store/selectors/sidebarSelectors.test.ts test/unit/client/store/sessionTitleMirror.test.ts docs/development/rename-scope-contract.md
git commit -m "fix(titles): explicit creator tab names outrank mirrored/auto pane titles; fabricated live-terminal rows carry no title"
```

### Task 2: The four e2e specs — derived expectations applied and verified red→green

Standing ledger items (no kata). The four specs keep their original assertions (they encode the restored contract); this task applies the two derived spec-side updates, hardens identity, and proves the family green.

**Files:**
- Modify: `test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts:255-267` (stale NOTE comment + creator-title preservation pin)
- Modify: `test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts:207` (add tabKey identity hardening)
- No change: `test/e2e-browser/specs/rest-tab-persistence.spec.ts`, `test/e2e-browser/specs/sidebar-opencode-rail.spec.ts` — they are the regression tests as written.

**Interfaces:**
- Consumes: Task 1's precedence contract (both client fold and server fabricated-row halves must be committed).
- Produces: green focused runs for all four families (the campaign's e2e evidence), plus the two spec updates that pin the new contract.

- [ ] **Step 1: remote-tab-linkage — correct the stale NOTE and pin creator-title preservation**

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

- [ ] **Step 2: deploy-tab-diff — add the tabKey identity hardening**

At `:207`, keep the contract assertion and add the stable-identity belt (the MISSING row prints `tab=<tabName> (<deviceId>:<tabId>)`; `codex.data.tabId` is already in scope from the `:154` create):

```ts
      expect(bad.out).toContain('tab=work')                // names the diverged tab (explicit REST name survives the restart — display precedence)
      expect(bad.out).toContain(codex.data.tabId)          // and names its stable tabKey identity (deviceId:tabId)
```

- [ ] **Step 3: Run the four specs focused — green**

```bash
npm run test:e2e:local -- test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/rest-tab-persistence.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/sidebar-opencode-rail.spec.ts
```

Expected: **PASS** — all tests in all four files green, first attempt, including the previously-failing `:81`/`:107`/`:117`/`:143` tests. Record the green receipts in run-state.

- [ ] **Step 4: Refactor while green**

None — two comment/assert edits only.

- [ ] **Step 5: Impacted-test verification (named-create family)**

The Task 1 change affects every spec that REST/MCP-creates a NAMED tab and asserts strip/DOM text. Run the known named-create family focused:

```bash
npm run test:e2e:local -- test/e2e-browser/specs/git-badges-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/fresh-agent-rest-resume-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/tabs-client-retire.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/mcp-focus-neutrality-rust.spec.ts
npm run test:e2e:local -- test/e2e-browser/specs/createrequestid-stabilization-rust.spec.ts
```

Expected: PASS (grep-verified: none asserts a session title displacing a REST name in the strip; `git-badges-rust:190` asserts the REST name itself and becomes strictly more stable). The full local e2e lane in Task 6 is the complete net.

- [ ] **Step 6: Commit**

```bash
git add test/e2e-browser/specs/remote-tab-linkage-rust.spec.ts test/e2e-browser/specs/deploy-tab-diff-rust.spec.ts
git commit -m "test(e2e): pin creator-title precedence in remote-tab-linkage; harden deploy-tab-diff divergence identity"
```

### Task 3: Kata 59nb — migrate the freshell-ws lib capture to the e08g OnceLock pattern; worst-case-order proof; consumer-filter audit

Closes **kata 59nb**. Root cause (proven): tracing-core caches each callsite's Interest process-wide on first registration (`Rebuilder::JustOne` consults the registering thread's default — `NoSubscriber` → `Interest::never`); an unguarded sibling test executing the shared `tracing::error!` site after our `capture()` but before our emission poisons it, and the `event!` macro short-circuits before dispatch — capture sees `got: []`. A thread-local `set_default` capture cannot defend a presence assertion against this; a process-global capture sees every thread's events, so whoever registers first, the interest is right.

**Files:**
- Modify: `crates/freshell-ws/src/invariants.rs:363-441` (`capture()` → OnceLock global) and its internal `mod tests` consumers
- Modify: `crates/freshell-ws/src/pane_ledger_tests.rs:8837-8974` (the guarded tests' filters + the worst-case-order proof; ALSO narrow the `{events:?}` failure dumps at `:8861,:8899` to the filtered hits) AND `:2983-2996,:3100-3200` (the `lock_log_capture` thread-local helper and its one consumer — same OnceLock/filter migration; delete the helper)
- Modify: `crates/freshell-ws/src/tabs_persist_tests.rs:1217,1270,1321,1376` (unique-field filters + unique ids) AND `:1228,:1313,:1367,:1415` (narrow the `{events:?}` failure dumps to the filtered hits)
- Modify: `crates/freshell-ws/src/claude_signal.rs:440,598` (guard-drop + path filter)
- Modify: `crates/freshell-ws/src/opencode_signal.rs:758,816,832` (path/terminal_id filters + per-test unique ids)
- Modify: `crates/freshell-ws/src/create_dedupe.rs:949-977` (the DIAG-01 waiter test's inline thread-local capture — same OnceLock/filter migration)

**Interfaces:**
- Consumes: the e08g precedent shape at `crates/freshell-ws/tests/pane_reconcile_freshagent.rs:838-858` (OnceLock + `set_global_default` + loud `.expect` on install); `CapturedEvent { target, message, fields }` (unchanged).
- Produces: `capture() -> Arc<Mutex<Vec<CapturedEvent>>>` — one process-global subscriber per lib-test binary, installed once (first call), never torn down; every consumer filters by a per-test-unique field — INCLUDING the two pre-existing thread-local `set_default` captures this task folds in (`pane_ledger_tests.rs`'s `lock_log_capture::lock_failure_capture` and `create_dedupe.rs`'s DIAG-01 inline capture), so after this task NO thread-local capture remains anywhere in the lib-test binary. No later task consumes this; Task 6's gate re-runs the binary.

- [ ] **Step 1: Write the failing worst-case-order regression proof**

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

- [ ] **Step 2: Run it and verify the intended failure**

Run: `cargo test -p freshell-ws --locked --lib load_index_dir_io_errors`

Expected: FAIL — `got:` shows zero scan-fault events for our root: the poisoner thread registered the shared `pane_ledger.rs:~1530` callsite against `NoSubscriber` (`Interest::never` cached process-wide), so the main thread's `PaneLedger::new` emission short-circuits before dispatch. In this narrowed single-test run no sibling can pre-heal the callsite, so the failure is deterministic. (If it unexpectedly passes, the mechanism claim is wrong — STOP and re-diagnose.)

- [ ] **Step 3: Migrate `capture()` to the process-global OnceLock pattern**

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

- [ ] **Step 4: Convert every consumer to unique-field filtering**

Mechanical rule for every site: `let events = capture();` (drop the `(events, _guard)` destructure — there is no guard), make every presence/count/negative assertion filter by a per-test-unique field, AND narrow every failure message that today dumps the whole vec via `{events:?}` to print the FILTERED hits instead (`{hits:?}` / a bound filtered slice) — the shared vec now holds every event from every test in the binary, so an unfiltered dump is unreadable noise working against the clear-failure-diagnostics goal. Six `{events:?}` sites: `pane_ledger_tests.rs:8861,:8899` (both already bind `hits` — print it) and `tabs_persist_tests.rs:1228,:1313,:1367,:1415` (hoist each inline `.any()` predicate into a `hits` binding and print that). Verified emission fields and required edits:

| Site | Assertion today | Emission's unique field | Required edit |
| --- | --- | --- | --- |
| `pane_ledger_tests.rs:8847` (`load_index_dir_io_errors_disable_the_ledger_loudly`) | exact-1 by target+message; `fields.contains_key("root")` | `root` (temp path, per-test label `load-loud-dir`; poisoner uses its own root) | filter adds `e.fields.get("root").map(String::as_str) == Some(&root.display().to_string())`; keep exact-1 |
| `pane_ledger_tests.rs:8885` (`load_index_row_io_errors_are_loud_per_row`) | exact-1 by message, then asserts `fields["path"]` | `path` (contains per-test temp root `load-loud-row`) | move the path into the filter: exact-1 by message + `fields["path"] == want_path` |
| `tabs_persist_tests.rs:1217` | `.any()` by message `tabs_snapshot_dropped_oversize` | `device_id` (test's device is `"dev"`) | rename the test's device id to a per-binary-unique `dev-oversize` and filter by `e.fields.get("device_id") == Some("dev-oversize")` |
| `tabs_persist_tests.rs:1270` | `.any()` by message `tabs_snapshot_corrupt_dir_exempt_from_eviction` | `path` (device dir under the test's tempdir) | filter adds `e.fields.get("path")` containing this test's tempdir path |
| `tabs_persist_tests.rs:1321` (`cap_unenforceable_fails_the_write_and_preserves_all_evidence`) | `.any()` by message `tabs_snapshot_device_cap_unenforceable` (asserted at `:1366` — NOT the corrupt-dir-exempt message) | `root` — the cap-unenforceable emission (`tabs_persist_retention.rs:114-116`) carries `root = %root.display()` and `corrupt_exempt`, and NO `path` field | filter adds `e.fields.get("root").map(String::as_str) == Some(&dir.path().display().to_string())`. TRAP — do not take the other branch: this test ALSO emits `tabs_snapshot_corrupt_dir_exempt_from_eviction` (with `path`) for every corrupt device dir under its tempdir, so filtering on that message+path would keep the test green while silently dropping the cap-alarm check it exists to make. No device-id rename needed: its per-test tempdir already makes every `root`/`path` value distinct from `:1270`'s |
| `tabs_persist_tests.rs:1376` | `.any()` by message `tabs_snapshot_device_identity_conflict` | `dir` (device dir path), plus `first`/`conflicting` | filter adds `e.fields.get("dir")` containing this test's tempdir path |
| `claude_signal.rs:440` | guard held only to keep registration warm (comment documents the poisoning) | — | keep the call as `let _ = crate::invariants::capture::capture();` (installs the global early; no assertions on events). Update the comment to point at the global capture |
| `claude_signal.rs:598` (`drain_warns_on_rejected_files`) | `.any()` by message `claude_signal_rejected` | `path` (junk file under this test's tempdir) | filter adds `e.fields.get("path")` == the test's junk-file path (or contains its tempdir) |
| `opencode_signal.rs:758` (`hello_files_never_hit_the_reject_warn_lane`) | NEGATIVE `.any()` by message `opencode_signal_rejected` | `path` | negative filter scoped to this test's tempdir: `!events.iter().any(rejected && path contains my dir)` |
| `opencode_signal.rs:816` (`warns_once_for_an_opencode_pane_past_grace_with_no_hello`) | exact-1 by message `opencode_rebind_heartbeat_missing` | `terminal_id` (currently `"term-1"` — collides with the next test's rows) | rename its probe terminal to a unique `term-hb-once` and filter by `fields["terminal_id"] == "term-hb-once"` |
| `opencode_signal.rs:832` (`no_warn_when_hello_seen_young_non_opencode_or_injection_disabled`) | negative by same message | `terminal_id` (currently `"term-1"` rows) | rename its rows to per-test-unique ids (`term-hello`, `term-young`, `term-nonoc`, `term-injdis`) and scope the negative filter to those ids |
| `invariants.rs` internal `mod tests` — 15 call sites spanning `:544`–`:1234`: `warns_once_per_unresolved…` (`t-lost`), `never_warns_inside_the_grace_window` (`t-young`), `never_warns_for_shell_or_exited_terminals` (`t-shell`/`t-gone`), `never_warns_when_either_identity_home_resolves…` (`t-identity`/`t-rest-resume`), `error_claude_restore_unresolved_emits_on_invariants_target` (`:632`), and the opencode probe-phase family `:698`–`:1234` (`:709`, `:760`, `:801`, `:835`, `:875`, `:902`, `:939`, `:992`, `:1154`, `:1234`) | the `unresolved_warnings` helper (`:466`) filters by target+message ONLY; several tests assert exact counts or emptiness | `terminal_id` ONLY for the unresolved-warning sites — the event carries just `terminal_id`/`mode`/`age_ms` (`invariants.rs:232-237`), so NO home-root/path filter is possible there; `request_id` for the claude-restore test (its event carries the field, `:342`) | **the terminal ids are NOT already unique — four are shared by two tests each and must be renamed per test:** `t-ev` (`:760` `…stale_candidate_evidence_still_warns` expects EXACTLY ONE warning; `:801` `…fresh_candidate_evidence_does_not_warn_yet` expects NONE), `t-late` (`:1154` `probe_phase_closes_the_late_row_hole…` expects a warning; `:939` `opencode_latch_miss…` expects NONE), `t-young` (`:585`/`:992`), `t-idle` (`:709`/`:1234`). The t-ev and t-late pairs are hard false-fails under the shared never-cleared vec (the warning-free sibling sees its sibling's warning); the t-young/t-idle pairs are negative-negative today but are renamed anyway so a later positive sibling can't silently recreate the race. Rename per test (e.g. `t-ev-stale`/`t-ev-fresh`, `t-late-hole`/`t-late-latch`, `t-young-grace`/`t-young-boundary`, `t-idle-grace`/`t-idle-never`), then extend `unresolved_warnings` (or its call sites) to also filter by the test's terminal id(s); the claude-restore test filters by its `request_id`. Every other capture site in the file keeps its already-unique id (`t-lost`, `t-shell`, `t-gone`, `t-bound`, `t-noloc`, `t-resume`, `t-identity`, `t-rest-resume`) — audit each `capture()` the same way |
| `pane_ledger_tests.rs:3100` (`new_locked_degrades_to_disabled_when_another_holder_exists`, the f3wp deflake) — NOT a `capture::capture()` site: it uses the thread-LOCAL `lock_log_capture::lock_failure_capture()` (`:2983-2996`, its own `set_default` at `:2992`) | presence via `find` on `log[seen_before..]`; its `None => panic!` arm (`:3185`) requires the production `pane_ledger_lock_unavailable` (or scan-unavailable) event from `pane_ledger.rs:1573` | `root` (the lock-unavailable emission carries `root` + `error`) | migrate to the global capture: `let events = crate::invariants::capture::capture();` (drop the `_trace_guard` binding), keep the `seen_before` mark slicing, and add a root filter to the find (`e.fields.get("root")` == this test's `temp_root` path) so sibling lock failures from other roots cannot be misclassified; the `error`-contains-`would_block_marker` match arms stay unchanged. Then DELETE the now-caller-less `lock_log_capture` helper (`:2983-2996`) — a helper with no callers fails `clippy -D warnings` |
| `create_dedupe.rs:949` (`settle_forwards_terminal_created_to_in_flight_waiter_connection`, DIAG-01) — also NOT a `capture::capture()` site: inline thread-local `set_default` capture | presence via `.find` + `.expect` (`:977`) on the production `ws.terminal.create.settled` join event | `terminal_id` (`"tX"`) + `path` (`"duplicate_in_flight_waiter"`) — both grep-unique to this one test across the whole lib at base | migrate to the global capture: drop the inline `L` layer + `set_default` guard, use `crate::invariants::capture::capture()`, and adapt the tuple find to `CapturedEvent`'s `e.message`/`e.fields` (the inline capture's i64-fields-to-string convention is identical to `invariants.rs`'s `FieldVisitor`, so `fields.get("connection_id") == Some("2")` transfers as-is); keep the existing `terminal_id`+`path` predicate as the per-test-unique filter — no rename needed |

Any site not in this table that greps as `capture::capture()` — OR as a thread-local `tracing::subscriber::set_default` capture anywhere in the lib (`set_default`/`DefaultGuard` outside `invariants.rs`'s own `capture()`) — must get the same treatment. Stage-2's grep at base dbbfd0752 verified the full census: **26 `capture::capture()` call sites in 5 files** — `pane_ledger_tests.rs:8847,:8885`; `tabs_persist_tests.rs:1217,:1270,:1321,:1376`; `claude_signal.rs:440,:598`; `opencode_signal.rs:758,:816,:832`; and `invariants.rs` ×15 (`:544,:585,:610,:632,:661,:709,:760,:801,:835,:875,:902,:939,:992,:1154,:1234` — the seven beyond `:830` are the opencode probe-phase family, outside the 59nb report's original `:544-801` range) — PLUS the two thread-local `set_default` captures migrated by the last two table rows (`pane_ledger_tests.rs:2992` via `lock_failure_capture`, consumed at `:3100`; `create_dedupe.rs:949`, asserted at `:977`): 28 guarded capture sites across 6 files. The Step 6 re-grep remains the mechanical completeness gate — it greps BOTH patterns.

- [ ] **Step 5: Run the focused proof and the consumer files green**

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

- [ ] **Step 6: Refactor while green**

Remove the `tracing::subscriber::DefaultGuard` return type and every now-unused `(events, _guard)` guard binding across the six files (neither is an import — both are fully qualified in the source; there is no `set_default` import to remove). Re-grep BOTH `capture::capture()` AND `set_default`/`DefaultGuard` in `crates/freshell-ws/src/` to confirm every consumer was converted and NO thread-local capture remains (`invariants.rs`'s global `capture()` is the only subscriber install; `lock_failure_capture` and the create_dedupe inline layer are gone) — AND audit filter uniqueness, which the call-site census alone cannot detect: every id literal used AS a shared-vec filter must identify exactly ONE test — the `terminal_id` literals asserted against the vec, the oversize test's renamed `dev-oversize` `device_id`, and every `temp_root` label in `pane_ledger_tests.rs` (the `dev-000`-series device ids appear in two tabs_persist tests by design and are fine — they are never vec filters there; those tests filter by per-test-unique tempdir `root`/`path`). The known collisions to confirm gone: `t-ev`, `t-late`, `t-young`, `t-idle` in `invariants.rs` (each was shared by two tests; see the Step 4 table), and the `term-1`/`term-hb-once` renames in `opencode_signal.rs`.

- [ ] **Step 7: Impacted-test verification**

The whole lib binary shares the capture; the impacted set is the entire `freshell-ws` lib test suite, run repeatedly to mirror the original flake conditions:

```bash
cargo test -p freshell-ws --locked --lib            # full lib binary, expect 700+ passed, 0 failed
for i in $(seq 1 5); do cargo test -p freshell-ws --locked --lib || break; done
for i in $(seq 1 30); do taskset -c 0,1 cargo test -p freshell-ws --locked --lib pane_ledger -- --test-threads 8 || break; done
```

Expected: every run green (the pinned-combo taskset loop is the investigation's reproduction recipe — 1 failure in 30 pre-fix; 0/30 post-fix). Also run `cargo test -p freshell-ws --locked --lib capture` if the invariants internal tests are named accordingly (covered by the full-lib runs above regardless).

- [ ] **Step 8: Commit**

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

- [ ] **Step 1: Reproduce the deterministic red**

Run: `cargo test -p freshell-freshagent --locked session_init_with_all_blank`

Expected: FAIL — `session_init_with_all_blank_settings_records_no_binding` panics at the semantic assert ("an all-blank settings snapshot must not be persisted …") in ~0.2s, while `session_init_with_all_blank_settings_records_the_lineage_row` passes. This is the red receipt for the deletion.

- [ ] **Step 2: Delete the zombie**

Delete the doc-comment block starting `/// No-laundering guard (V7/A10, parity with codex's` through the end of the `session_init_with_all_blank_settings_records_no_binding` test (claude.rs:18319-18367). Do not touch the live reshape (`:18087-18150` region) or the provenance sibling that follows.

- [ ] **Step 3: Run the family green**

Run: `cargo test -p freshell-freshagent --locked session_init`

Expected: PASS — the whole `session_init` family green (7 passed, 0 failed — was 7 passed / 1 failed).

- [ ] **Step 4: Refactor while green**

None (pure deletion of a superseded duplicate).

- [ ] **Step 5: Impacted-test verification**

Run the whole crate (narrowed selector, delegated): `cargo test -p freshell-freshagent --locked`

Expected: PASS (the crate is green at this point; the two-phase-drain flake is fixed in Task 5, not here — if the 15s budget flake fires during this run under co-load, that is the Task 5 mechanism, not a regression from this deletion; re-run and proceed).

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "test(freshagent): delete the merge-repair-resurrected records_no_binding zombie (kata hsrh part 1) — superseded by the r27 F4 lineage-row reshape"
```

### Task 5: Kata hsrh (part 2) — land the stranded either-order combined drain on the three live siblings

Closes part 2 of **kata hsrh**. Root cause (proven, and already root-caused on the stranded branch `origin/fix-session-init-provenance-flake`, commit `8186d9f3e`, 2026-09-14 — never merged, no PR): `handle_create` spawns the stdout consumer task BEFORE it broadcasts `freshAgent.created` (`claude.rs:2274` → `tokio::spawn` at `:7716`, tail broadcast at `:2466`), and the fake sidecar prints `sdk.session.init` in the same synchronous burst as its `created` answer; on the multi_thread runtime the consumer can broadcast `freshAgent.session.init` FIRST, the test's created-only drain discards it, and the second drain waits out its full 15s budget for a frame already consumed. No budget raise can fix a lost frame. The load-immune fix is the deterministic either-order combined drain (keep the 15s as a now-sound dead-man switch). Reuse the stranded branch's helper verbatim rather than rewriting it.

**Files:**
- Modify: `crates/freshell-freshagent/src/claude.rs` — add `await_claude_created_and_session_init` after the `await_claude_created` helper (which starts at `:11009`); replace the two-phase drain in the three LIVE family tests: `session_init_records_binding_with_create_settings` (`:18033`, request id `req-binding-init`), `session_init_with_all_blank_settings_records_the_lineage_row` (`:18098`, `req-binding-blank`), `session_init_binding_carries_the_creates_connection_provenance` (`:18376`, `req-binding-prov`).

**Interfaces:**
- Consumes: the stranded branch `origin/fix-session-init-provenance-flake` @ `8186d9f3e` — the helper is taken verbatim from `git show 8186d9f3e -- crates/freshell-freshagent/src/claude.rs` (reproduce it below so the task is self-contained); `await_claude_created` (unchanged); the 64-frame broadcast bus + `Lagged`-resync idiom shared by every drain in the file.
- Produces: no production change (test-only). The family is race-immune: no frame is ever discarded.

- [ ] **Step 1: Add the combined either-order drain helper (verbatim from 8186d9f3e)**

Insert immediately after the `await_claude_created` helper (after its closing `}` around `claude.rs:11033`):

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

- [ ] **Step 2: Replace the two-phase drain in the three live siblings**

In each of the three tests named above, replace the `await_claude_created(&mut rx, "<id>").await;` call PLUS the following `tokio::time::timeout(... 15 ...)` init-drain block with the single call (keeping each test's own explanatory comment about what the init frame proves):

```rust
        await_claude_created_and_session_init(&mut rx, "req-binding-init").await;
```

(respectively `"req-binding-blank"` in the lineage-row test and `"req-binding-prov"` in the provenance test). Everything after the drain (binding/lineage-row assertions) is untouched. Verify against `git show 8186d9f3e` that the call-site shape matches the stranded branch's intent. Do NOT apply the stranded commit by cherry-pick or merge: stage 2 verified via read-only `git merge-tree` that a mechanical 3-way merge onto dbbfd0752 is textually clean but applies the `req-binding-blank` hunk onto the ZOMBIE's drain copy (`:18336-18359`), leaving the LIVE lineage-row test's two-phase drain (`:18110-18130`) unconverted — the conversion MUST be applied by test name as this step prescribes, and the zombie's copy disappears with Task 4's deletion.

- [ ] **Step 3: Run the family green**

Run: `cargo test -p freshell-freshagent --locked session_init`

Expected: PASS (7 passed, 0 failed).

Note on red-first: the race's natural red is the recorded load-flake receipt (base-gate panic `freshAgent.session.init consumed within budget` at `claude.rs`'s old `:11189`, retained at `/tmp/base-gate-run2.log:7031`), but a DETERMINISTIC red receipt is reproducible with the stranded commit's own throwaway harness — `8186d9f3e`'s message records: "Evidence (temporary harness, not committed: a 200ms sleep before the created broadcast): before, all 3 tests failed; after, 50/50 runs of the tests passed pinned to 8 CPUs with busy loops on them." Note the evidence's SHAPE: the stranded commit's green was also collected WITH the sleep in place — the harness forces the interleave deterministically, so green-under-harness is the load-immunity proof. Repro recipe, three beats (UNCOMMITTED, never part of any commit):
1. RED: before applying Step 2, temporarily insert a 200ms `tokio::time::sleep` in `handle_create` between the stdout-consumer spawn and the `freshAgent.created` broadcast, run `cargo test -p freshell-freshagent --locked session_init` → expect the three live siblings to FAIL on the init-drain budget (record the receipts in run-state).
2. GREEN UNDER THE FORCED INTERLEAVE: with the sleep STILL in place, apply Step 2's combined-drain conversion, re-run the same selector → expect the three live siblings to PASS (without this beat the green loops below exercise only the rare natural interleave and would pass even if the helper did nothing — the reorder fix is proven under the forced timing, matching the stranded commit's own 50/50 evidence).
3. CLEANUP: revert the sleep and confirm the working tree contains ONLY the Step 2 conversion (`git diff` shows no `tokio::time::sleep` hunk) before continuing.
This is a throwaway repro harness, not a committed production seam (repo precedent stands: no order-forcing seam is shipped). The deterministic committed coverage is Task 4's zombie red; this task's verification is repeated green under load:

```bash
for i in 1 2 3; do cargo test -p freshell-freshagent --locked || break; done
```

Expected: PASS ×3 (the full crate spawns real node sidecars under parallel load — the exact condition that fired the flake).

- [ ] **Step 4: Refactor while green**

None — the helper is the stranded branch's reviewed shape verbatim; `await_claude_created` remains for the tests that legitimately need created-only waits.

- [ ] **Step 5: Impacted-test verification**

Impacted set: every test that drains this bus in claude.rs (the family plus any `await_claude_created` consumer) — covered by the Step 3 full-crate runs. Also confirm no remaining standalone two-phase init drain: `grep -n "freshAgent.session.init" crates/freshell-freshagent/src/claude.rs` — expected hit classes are the module doc comment (~:22), the `normalize_sdk_type` mapping arm (~:8628), the frame-shape assertions in `normalize_maps_the_known_sdk_set_and_ignores_others` (~:10138) and the `sdk_line_to_frame` wire test (~:10197), and the combined helper's own comment/matcher; none is a standalone timeout drain (a `tokio::time::timeout` block matching `freshAgent.session.init` outside the combined helper). The zombie's drain copy is already gone with Task 4.

- [ ] **Step 6: Commit**

```bash
git add crates/freshell-freshagent/src/claude.rs
git commit -m "test(freshagent): wait for created and session.init in either order (kata hsrh part 2, from 8186d9f3e) — fixes the lost-frame 15s budget flake"
```

Kata bookkeeping: disposition **hsrh** with BOTH findings (lost-frame race fixed by the either-order drain; zombie resurrected by merge repair `9e56e8bb6` and deleted). The still-open sibling katas 3fxd/y5fw are a separate family — record them as untouched in run-state, do not fix here.

### Task 6: Full-suite gate + campaign wrap

Closes the campaign. No new code.

**Files:**
- No production files. Receipts go to the logs dir (`<logs_dir>/reports/`) and run-state.

**Interfaces:**
- Consumes: Tasks 1–5 committed on branch `main-green-sixpack`.
- Produces: the green full-suite receipt that unblocks the-usual review → PR → merge stages; kata closures for 59nb and hsrh; the standing-ledger disposition for the e2e four.

- [ ] **Step 1: Cheap checks first**

```bash
cargo fmt --check
npm run typecheck:client
cargo clippy -p freshell-ws -p freshell-server -p freshell-freshagent --all-targets -- -D warnings
```

Expected: PASS (the pre-push gate runs the same filtered checks on push; run them explicitly so failures surface before the gate).

- [ ] **Step 2: Coordinated full suite + the full local e2e lane**

`npm test` does NOT run the browser suite: it routes to `test:balanced` → `scripts/run-standard-tests.ts`, whose lanes are client, source-runtime, rust, electron, electron-runtime ONLY (verified at the base: no Playwright invocation anywhere in the file). The four e2e specs therefore need their own explicit gate — AGENTS.md requires the affected e2e specs to pass before a PR, and Task 1 changes behavior for every REST/MCP-named tab and every placeholder session row, so the net is the FULL local lane, not just the nine focused specs from Tasks 1–2.

2a. Coordinated non-e2e suite (broad runs wait for the shared gate; use the holder/status reason):

```bash
npm run test:status
FRESHELL_TEST_SUMMARY="main-green-sixpack campaign gate: six standing failures fixed" npm test
```

Expected: PASS — client, source-runtime, Rust (59nb/hsrh lanes covered here), electron, electron-runtime.

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

- [ ] **Step 3: Zero-flake acceptance**

The full suite must be green with no recovered-retry flakes in the four campaign families. If any campaign family flakes or fails, that is a campaign defect — fix it within the branch before any PR (record the failure + receipt in run-state; do not weaken the suite). A NON-campaign spec failure is not treated as a campaign defect until Step 2c classifies it against the base — after classification, a campaign-caused one is a campaign defect (fix it); a pre-existing one is recorded and left (no scope creep).

- [ ] **Step 4: Kata + ledger bookkeeping**

- Close kata **59nb** (Task 3) and kata **hsrh** (Tasks 4+5) via the repo's kata tooling; record both dispositions with their evidence receipts in run-state `artifacts` and `important decisions and blockers`.
- Record the e2e four (deploy-tab-diff-rust :81, remote-tab-linkage-rust :107, rest-tab-persistence :117, sidebar-opencode-rail :143) as CLEARED standing ledger items with their green receipts — they are not katas.

- [ ] **Step 5: Branch hand-off (stop before PR)**

Push the branch (the pre-push gate runs automatically):

```bash
git push -u origin main-green-sixpack
```

Then STOP and ask the user for explicit PR-creation approval (repo rule: no `gh pr create` without it). After approval, the-usual stages handle PR → required checks → merge → local `main` fast-forward → worktree cleanup per the repo rules.

- [ ] **Step 6: No commit step**

No files change in this task; run-state (outside the tracked worktree) carries the receipts.

---

## Verification summary (what proves the User Request's result)

1. **Requested result — six failures fixed:** Task 1 Step 1 records the four e2e red receipts at base; Task 2 Step 3 records them green; Task 3 Steps 2/5 record the 59nb proof red→green plus 0/30 pinned-combo; Tasks 4/5 Steps 1/3 record the hsrh zombie red, the forced-interleave red→green under the uncommitted 200ms harness, and family green ×3 under load; Task 6 Step 2a records the coordinated non-e2e suite green, Step 2b records the FULL local e2e lane green (the complete net for the title/placeholder changes — `npm test` alone runs no Playwright), and Step 2c classifies any non-campaign spec failure against the base dbbfd0752 (pre-existing → recorded, not fixed; campaign-caused → fixed in-branch).
2. **Explicit constraint — root-cause-first, no patience raises:** no timeout value is raised anywhere in the plan; the hsrh 15s budget is retained as a dead-man switch while the wait shape becomes order-immune; the e2e fixes restore a product contract rather than extending waits.
3. **Explicit constraint — rename-scope coherence:** the Resolution section reconciles the precedence with docs/development/rename-scope-contract.md; Task 1 Step 4e records the display-precedence ladders in the contract doc exactly as the code composes them (tab ladder + the pane-kind split, so no inaccurate blanket rule enters the contract) and adds the Tab-label "Written by" create-time entry; no hard rule is violated (write-scoping untouched).
4. **Explicit constraint — one branch/PR via the campaign pattern:** single branch `main-green-sixpack` from `dbbfd0752`; PR only after explicit user approval (Task 6 Step 5).
5. **Explicit constraint — production safety:** every command runs from the linked worktree; e2e/cargo runs spawn their own ephemeral servers; nothing touches the port-3001 production process.
