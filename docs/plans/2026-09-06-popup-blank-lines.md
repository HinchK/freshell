# Fresh-Agent Turn Right-Click Double-Menu Fix Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** Right-clicking (or long-pressing) a fresh-agent transcript turn opens exactly one menu — the transcript's own turn menu / action sheet — instead of two overlapping menus stacked at the same point.

**Architecture:** `ContextMenuProvider` registers its `contextmenu` listener on `document` in the **capture** phase (`ContextMenuProvider.tsx:1232`, unchanged since the original implementation 39cb1f96d — capture is load-bearing for xterm/Monaco surfaces that swallow bubble-phase contextmenu). `FreshAgentTranscript` owns turn-level context menu handling on its `article[data-turn-role]` elements with `preventDefault() + stopPropagation()` in the bubble phase — which can never beat capture. Result: on every turn right-click the provider opens the pane menu AND the transcript opens the turn menu at the same coordinates. The turn menu was invisible until PR #723 defined the `popover` tokens, so the collision became user-visible then ("formatted strangely with blank lines between entries"). Fix: the provider skips events originating inside `article[data-turn-role]` — a boundary owned exclusively by `FreshAgentTranscript` (verified: sole producer of the attribute), which always installs exactly one turn handler per pointer kind (menu for fine pointers, action sheet for coarse).

**Tech Stack:** React 18 + TypeScript client, Vitest + Testing Library, Playwright e2e.

## Global Constraints

- Do not change the provider's capture-phase registration or the ordering of any existing global listener.
- Do not change the transcript's turn-menu/action-sheet behavior itself.
- Work happens only in `/home/dan/code/freshell/.worktrees/popup-blank-lines` on branch `the-usual/popup-blank-lines`.

## Requirements

- **R1 — Outcome:** A right-click on a fresh-agent transcript turn produces exactly one `role="menu"` element, and it is the turn menu ("Turn context menu"). Long-press on a turn likewise opens only the transcript's action sheet, not also the provider's pane menu.
- **R2 — Constraint:** Right-clicking anywhere else in a fresh-agent pane (outside a turn article), and right-clicking in terminal/editor/picker panes, still opens the provider's normal context menu. All existing menu behavior, touch long-press menus for non-turn surfaces, and keyboard Shift+F10 path are unchanged.
- **R3 — Evidence:** Unit tests red-before/green-after, and the existing Playwright turn-menu pin extended to assert the single-menu invariant red-before/green-after.

---

### Task 1: Provider carve-out for transcript turn contextmenu events

**Requirements served:** R1, R2, R3

**Behavior:**
- In `src/components/context-menu/ContextMenuProvider.tsx`, the provider's `handleContextMenu` returns early (no `openMenu`, no `preventDefault` — leave the event for the transcript's handler) when the event target is inside `article[data-turn-role]`.
- The same predicate guards the provider's touch long-press path (`handleTouchStart`), so Android/hold gestures on a turn open only the transcript's action sheet.
- Implement as one small module-scope predicate in `ContextMenuProvider.tsx`, e.g. `isFreshAgentTurnTarget(el: HTMLElement | null): boolean { return !!el?.closest?.('article[data-turn-role]') }`, used by both paths.

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx` (handleContextMenu near the start, after `const target = e.target as HTMLElement | null`; handleTouchStart where the long-press timer is armed)
- Test (unit): `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test (e2e): `test/e2e-browser/specs/fresh-agent.spec.ts` (extend the existing `turn context menu renders on an opaque popover surface` test)

**Interfaces:**
- Consumes: `article[data-turn-role]` markup contract from `src/components/fresh-agent/FreshAgentTranscript.tsx`'s turn `article`.
- Produces: `isFreshAgentTurnTarget` (module-private).

**Test cases:**
- Unit — `fireEvent.contextMenu` on an element inside `<article data-turn-role="user">` within a `<div data-context="fresh-agent" data-tab-id=… data-pane-id=…>` → provider renders no app menu.
- Unit — same event one level up, inside the fresh-agent pane container but OUTSIDE any turn article → provider menu opens (pane entries such as "Reopen as Claude CLI" present). (Mirror the existing pane-menu test fixtures in ContextMenuProvider.test.tsx.)
- e2e — in the existing turn-menu pin (freshclaude stub with one user turn): after `turnText.click({ button: 'right' })`, assert `page.getByRole('menu')` has count 1 and it is named "Turn context menu". (Pre-fix this is red: two menus exist.)

- [ ] **Step 1: Write the failing behavioral test**

Add to `test/unit/client/components/ContextMenuProvider.test.tsx` a test (new `describe('fresh-agent turn carve-out')`): render the provider around a fresh-agent pane container with a turn article inside (as in Test cases), `fireEvent.contextMenu` on the inner turn element, assert the provider opened no menu (no element with `role="menu"` attributed to the provider — the provider's menu is portaled with `aria-orientation="vertical"`). Add the control test (outside the article → menu opens).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx`

Expected: FAIL on the carve-out test because the provider currently opens its pane menu for turn targets; the control test passes.

- [ ] **Step 3: Add the minimal production implementation**

Add `isFreshAgentTurnTarget` in `ContextMenuProvider.tsx`; early-return in `handleContextMenu` and skip arming the long-press timer in `handleTouchStart` when it matches.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx`

Expected: PASS (new tests plus all pre-existing provider tests — watch the long-press/contextmenu-race cases especially, since the touch path changes).

- [ ] **Step 5: Refactor while green**

One predicate, two call sites, comment referencing the transcript's ownership contract. No other edits.

- [ ] **Step 6: Run broader verification**

6a. Extend the e2e pin (count-1 + named assertion) and run:

Run: `bash scripts/e2e-cloud.sh run --local --project=chromium --grep='turn context menu' test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS.

6b. Also verify no regression in the pane-menu flows: `bash scripts/e2e-cloud.sh run --local --project=chromium --grep='context menu' test/e2e-browser/specs/` only if such a cross-spec grep matches real tests (check first) — otherwise the unit coverage in step 4 plus the targeted e2e suffice, and the broad `npm test` at delta-review time covers the rest.

6c. Typecheck + build: `npm run build`.

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "fix(fresh-agent): provider skips turn contextmenu events so right-clicking a turn opens only the turn menu"
```

---

## Stage-2 revision record

Supersedes the initial composer-subtitle plan. Findings:

- **Falsified (LB-1/LB-2):** the composer slash menu renders empty-description rows without visual blank lines (empty spans are zero-height), and the real Claude catalog (76 commands probed live via the Agent SDK) contains no empty or whitespace-only descriptions. The live slash menu was observed healthy (shot-09). The description-gate idea is recorded as an out-of-scope hygiene finding.
- **Verified (LB-3):** the defect is the double-open of provider pane menu + transcript turn menu on turn right-click; previously masked by the missing `popover` surface and exposed by PR #723. Evidence: two `div[role="menu"]` at identical origin in the live app DOM; screenshot evidence in run logs (shot-18, menu-composite-2x).
- **Verified (LB-4):** `article[data-turn-role]` belongs exclusively to FreshAgentTranscript, which always handles the gesture itself (turn menu for fine pointers, action sheet for coarse).
- **Accepted (LB-5):** rejected switching the provider listener to bubble phase (blast radius on xterm/Monaco surfaces); carve-out is the minimal safe variant.

## Self-review record

- **Spec coverage:** R1 proven by unit red/green + e2e count-1; R2 by the unit control test and unmodified listener ordering; R3 by the two named suites.
- **No silent deferrals:** none.
- **File/interface consistency:** predicate, call sites, attribute contract, and test locations verified against the base tree (provider registration at ContextMenuProvider.tsx:1232; turn article rendered in FreshAgentTranscript.tsx with `data-turn-role`; e2e pin exists at fresh-agent.spec.ts in `describe('Fresh Agent')`).
- **Executable tests:** unit red predicated on the currently-missing early return; e2e red predicated on the currently-present second menu (directly observed at the base commit).
