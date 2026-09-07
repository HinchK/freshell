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

- **R1 — Outcome:** A right-click on a fresh-agent transcript turn produces exactly one `role="menu"` element, and it is the turn menu ("Turn context menu"). On touch-primary (coarse-pointer) devices — the only devices where the transcript owns a touch turn gesture — a long-press on a turn opens only the transcript's action sheet (never also the provider's pane menu), and the gesture's release does not dismiss the just-opened sheet or activate an item, including when the transcript rerenders mid-gesture. (Scope note, delta-review round 1: hybrid devices with a fine primary pointer + touch, e.g. iPad + trackpad, never had a transcript turn gesture — the pre-existing provider long-press → pane-menu fallback there is unchanged by design and is R2 territory, not R1.)
- **R2 — Constraint:** Right-clicking anywhere else in a fresh-agent pane (outside a turn article), and right-clicking in terminal/editor/picker panes, still opens the provider's normal context menu. All existing menu behavior, long-press menus for non-turn surfaces (including their release suppression), and the keyboard Shift+F10 path are unchanged.
- **R3 — Evidence:** Unit tests red-before/green-after; the existing Playwright turn-menu pin extended to assert the single-menu invariant, run and recorded RED before the production change and GREEN after.

---

### Task 1: Provider carve-out + transcript release suppression for turn gestures

**Requirements served:** R1, R2, R3

**Behavior:**
- **Half 1 — provider carve-out** (`src/components/context-menu/ContextMenuProvider.tsx`):
  - `handleContextMenu` (capture phase) returns early — no `openMenu`, no `preventDefault` — when the event target is inside `article[data-turn-role]`.
  - `handleTouchStart` captures the gesture target (`e.target as HTMLElement | null`); when the 500ms long-press timer fires, if the ORIGINAL gesture target is inside `article[data-turn-role][data-longpress-owned="true"]`, the provider does nothing for this gesture: no `elementFromPoint` re-probe (by fire time the transcript's sheet is already open at 450ms and the probe would hit it), no haptic, no `openMenu`, and no `suppressNextTouchEnd` arming. For all other targets the current behavior is byte-identical.
  - **Ownership boundary (review-mandated):** the transcript adds `data-longpress-owned="true"` to its turn articles exactly when it installed its own long-press handlers (the coarse-pointer `onOpenActions` path — `FreshAgentTranscript.tsx` ~766-770). The provider's touch carve-out keys on that attribute, NOT bare `data-turn-role`: hybrid-input devices (iPad + trackpad: fine primary pointer — repository notes at `src/lib/pointer.ts:5-9`, MDN `pointer` = primary device only) install no transcript long-press and fire no iOS contextmenu, so they keep today's provider long-press fallback untouched. The `handleContextMenu` carve-out keys on bare `article[data-turn-role]` — safe everywhere, because whenever a `contextmenu` event reaches a turn article the transcript always handles it (turn menu on fine pointers, action sheet on coarse).
  - Two module-scope predicates in ContextMenuProvider.tsx: `isFreshAgentTurnTarget(el)` = `article[data-turn-role]`, `isFreshAgentLongPressOwnedTarget(el)` = `article[data-turn-role][data-longpress-owned="true"]`.
- **Half 2 — transcript release suppression, covering BOTH sheet-open routes** (`src/lib/pointer.ts`, `buildLongPressHandlers`):
  - The builder tracks touch gesture state per closure: `touchActive` (set on `onTouchStart` with a single touch, cleared on end/cancel) and `overlayOpenedDuringTouch`.
  - Timer route (450ms long-press completes → callback opens the sheet): the builder marks `overlayOpenedDuringTouch = true` at completion.
  - Android native-`contextmenu` route (sheet opens mid-gesture before any timer): the builder exposes a new returned member `notifyOverlayOpened()`; the transcript's coarse-pointer `onContextMenu` branch (FreshAgentTranscript.tsx ~line 784-789) calls `longPress?.notifyOverlayOpened?.()` when it calls `actions.onOpenActions`. `notifyOverlayOpened` sets the flag only while a touch is active.
  - **DOM-spread hazard (review-mandated):** the turn article spreads the builder's handlers (`{...(longPress ?? {})}`), so `notifyOverlayOpened` must NOT land in that spread — the transcript memo returns `{ handlers: { onTouchStart, onTouchMove, onTouchEnd, onTouchCancel }, notifyOverlayOpened }` (or destructures before spreading). React would otherwise warn about an unknown DOM prop and `test/setup/dom.ts` fails the suite on unexpected console.error.
  - `onTouchEnd(event)` (signature gains the event): when `overlayOpenedDuringTouch` is set and the event is cancelable, call `event.preventDefault()` — cancelling the synthesized compatibility click that would otherwise dismiss the freshly-opened sheet or activate a row. Pending/aborted presses (tap, move, cancel) behave exactly as today: no preventDefault.
  - `onTouchCancel` clears both flags without preventing anything.
  - `buildLongPressHandlers` has no other consumer (repo-wide search: `FreshAgentTranscript` only), so no other surface changes behavior.
  - **Gesture state must survive transcript rerenders (delta-review round 1):** the current `useMemo([actions, actionTurn])` rebuilds the closure with fresh state whenever the view streams new snapshots — an in-flight gesture (timer armed / overlay flag set) would be orphaned and the following release unsuppressed. The turn article instead:
    - keeps the builder product in a `useRef` created at most once per mounted article;
    - feeds the open callback the LATEST handler/turn through refs (`onOpenActionsRef.current?.(turnRef.current)`), so state survives while behavior stays current;
    - the `handlers` spread and `data-longpress-owned` key off the current `actions.onOpenActions` presence as before;
    - one regression test proves it: combined touch gesture where the transcript is RERENDERED (e.g. `rerender()` with an updated unrelated prop) between `touchstart` and `touchend` — sheet opens once, release still preventDefault'd, sheet stays open.

**Files:**
- Modify: `src/components/context-menu/ContextMenuProvider.tsx`
- Modify: `src/lib/pointer.ts`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (coarse `onContextMenu` branch calls `notifyOverlayOpened`)
- Test (unit, provider): `test/unit/client/components/ContextMenuProvider.test.tsx`
- Test (unit, pointer helper): `test/unit/client/lib/pointer.test.tsx` (create if absent; match repo conventions for lib tests — the file path differs only if a pointer test file already exists, in which case extend it; either way Steps 2/4/7 list the concrete file used)
- Test (unit, combined touch gesture): extend the coarse-pointer transcript harness in `test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx` (exactly this file — no sibling option)
- Test (e2e): `test/e2e-browser/specs/fresh-agent.spec.ts` (extend the existing `turn context menu renders on an opaque popover surface` test)

**Interfaces:**
- Consumes: `article[data-turn-role]` markup contract from `src/components/fresh-agent/FreshAgentTranscript.tsx`; `FreshAgentActionSheet` opened via `onOpenActions`.
- Produces: `isFreshAgentTurnTarget(el)` and `isFreshAgentLongPressOwnedTarget(el)` (module-private in ContextMenuProvider.tsx); `buildLongPressHandlers` extended with touch-state tracking + returned `notifyOverlayOpened()`; transcript coarse-path calls it alongside `onOpenActions`; transcript articles carry `data-longpress-owned="true"` when their own long-press is installed.

**Test cases:**
- Unit (provider) — `fireEvent.contextMenu` on an element inside `<article data-turn-role="user">` within a `<div data-context="fresh-agent" data-tab-id=… data-pane-id=…>` → provider renders no app menu. Control: same event inside the pane container but OUTSIDE any turn article → provider menu opens.
- Unit (pointer helper) — long-press timer completes → next `onTouchEnd` receives a preventDefault'd event; `notifyOverlayOpened()` during an active touch (the contextmenu route) → next `onTouchEnd` preventDefault'd; tap / moved / cancelled press → no preventDefault.
- Unit (combined touch gesture, in FreshAgentMobile.test.tsx) — mount a coarse-pointer transcript (existing `stubCoarsePointer(true)` + TURNS harness) INSIDE the provider (the renderWithProvider wrapper pattern from ContextMenuProvider.test.tsx): `touchstart` on a turn → advance past 450ms (sheet opens) → advance past 500ms (provider timer) → assert exactly one overlay exists and it is the action sheet (no provider `role="menu"`); `touchend` (cancelable) → assert `defaultPrevented === true`; follow the existing provider-test convention and, when the event WAS prevented, do not synthesize a click — and when not prevented, synthesize the compat click over the sheet's actionable row to prove activation does not occur (assert the sheet remains and no item ran).
- Unit (combined, Android contextmenu route) — same harness: `touchstart` on a turn, `fireEvent.contextMenu` on the turn BEFORE 450ms (sheet opens via the contextmenu route), `touchend` cancelable → `defaultPrevented === true`, sheet remains open.
- Unit (hybrid-input regression) — provider long-press on a turn article WITHOUT `data-longpress-owned` (iPad-with-trackpad shape: fine primary pointer, no transcript long-press): the provider's long-press menu still opens (today's fallback preserved); and with `data-longpress-owned="true"`, it does not.
- e2e — in the existing turn-menu pin: after a right click on the turn, assert `page.getByRole('menu')` count is exactly 1 and it is named "Turn context menu".

- [ ] **Step 1: Write the failing behavioral tests + record the e2e RED first**

1a. Unit: provider carve-out describe (contextmenu) in ContextMenuProvider.test.tsx; pointer-helper completed-press suppression tests; combined touch gesture test.
1b. e2e: extend the existing pin with the count-1 assertion; RUN IT NOW (before any production change) and record the RED result showing two menus:

Run: `bash scripts/e2e-cloud.sh run --local --project=chromium --grep='turn context menu renders on an opaque popover surface' test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: FAIL with the count assertion showing 2 menus (evidence for the run record).

- [ ] **Step 2: Run the unit tests and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/lib/pointer.test.tsx test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx`

Expected: FAIL on the new carve-out/pointer/combined assertions because none of the halves exist yet; all pre-existing tests pass.

- [ ] **Step 3: Add the minimal production implementation**

Implement Half 1 (predicate + the two provider call sites, original-target capture at touchstart) and Half 2 (`buildLongPressHandlers` completed-press release suppression).

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/lib/pointer.test.tsx test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx test/unit/client/components/context-menu/ContextMenu.longpress.test.tsx`

Expected: PASS — including all pre-existing long-press/race tests.

- [ ] **Step 5: Refactor while green**

One predicate, two provider call sites; pointer helper change minimal and commented (why release suppression moved to the transcript for turn surfaces). No other edits.

- [ ] **Step 6: Run broader verification**

6a. Re-run the e2e pin (now GREEN):

Run: `bash scripts/e2e-cloud.sh run --local --project=chromium --grep='turn context menu renders on an opaque popover surface' test/e2e-browser/specs/fresh-agent.spec.ts`

Expected: PASS.

6b. Typecheck + build + lint: `npm run build && npm run lint` (lint is repository-mandated before merging, AGENTS.md a11y section).

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/context-menu/ContextMenuProvider.tsx src/lib/pointer.ts src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/ContextMenuProvider.test.tsx test/unit/client/lib/pointer.test.tsx test/unit/client/components/fresh-agent/FreshAgentMobile.test.tsx test/e2e-browser/specs/fresh-agent.spec.ts
git commit -m "fix(fresh-agent): provider skips turn gestures; transcript suppresses release click after sheet open"
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
