# Transcript Minimap Polish Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Complete the fresh-agent transcript minimap: fix the recorded optional findings (hover-preview word-break for long unbroken tokens; the doubled per-scroll landmark scan; tick pointer-clickability at extreme prompt density; the recorded style Nits), and add a user setting that shows or hides the minimap rail, default on.

### Explicit constraints
- Run the work through "the usual" workflow (dedicated worktree, plan, load-bearing validation, Fresh Eyes reviews, TDD execution, recap).
- Continue on the existing worktree and branch (.worktrees/transcript-minimap, the-usual/transcript-minimap) from current HEAD cd55891bc; do not merge, push, or open a PR without explicit approval.
- Preserve the delivered minimap contracts: one tick per user prompt (never dropped or capped), proportional placement, hover preview via the existing tooltip, real <button> elements with aria-labels, and the repo's accessibility and TDD rules with unit and e2e coverage for all new behavior.
- The new setting defaults to ON, persists through the repo's existing settings mechanism, and hides the rail (and its work) when off.
- Fix the optional findings rather than re-litigating them; where a finding's clean fix requires a design choice (extreme-density clickability), pick the simplest design that satisfies the one-tick-per-prompt contract and have the plan review adjudicate.

### Accepted tradeoffs and residuals
- No drop-in library exists for this control; it is a small custom React component (delivered in the prior run).
- Extreme-density pointer precision may retain physical limits; any residual limitation must be documented rather than silently accepted.

**Goal:** Land four fixes on the already-delivered minimap so every recorded optional finding is cleared: (1) the hover preview wraps long unbroken tokens, (2) one landmark sweep per scroll event feeds both the glom chip and the rail, (3) dense prompt clusters get a reliable pointer affordance — one open-list hit target opening a jump menu — without dropping or capping any tick, and (4) a new local setting "Show transcript minimap" (default ON) gates the rail's mount so OFF removes the rail and all of its measurement work.

**Architecture:** The transcript (`FreshAgentTranscript.tsx`), which already owns `scrollerRef`, `displayTurns`, and both consumers, becomes the sole owner of the landmark sweep. A new helper module (`shared/transcript-measurement.ts`) performs one `querySelectorAll('[data-turn-role="user"]')` + per-element-rect sweep and produces a `TranscriptMeasurement`; the transcript stores it once, derives the glom chip's target from it (`deriveGlomTarget`), and passes it down to `FreshAgentTranscriptMinimap`, which becomes a presentational consumer (computes `MinimapLayout` from the prop) and additionally owns only the two `ResizeObserver` subscriptions it needs (article-level, keyed on `transcriptSignature`, and scroller-level), both wired to an `onRemeasure` callback that requests fresh sweeps. This ownership is load-bearing: the glom chip must never depend on the minimap's mount state, so the Task-4 setting can unmount the rail (killing its observers and rendering) while the glom chip keeps its full behavior. Dense-cluster navigation extends the pure layout with a `clusters` output — a second clickability pass over the final laid-out ticks (not the packing loop's groups), joining each next tick that begins within its predecessor's minimum 4px click row into maximal runs (ALL runs listed, singletons included; a `dense` flag marks any run containing a sub-4px member) — and renders one extra real `<button>` over each dense multi-member run's span that opens the repo's `ContextMenu` primitive listing every prompt in the run, while a lone sub-4px tick's own button expands its hit height to the 4px floor (the paint moves to an inner aria-hidden span; the click still jumps directly) — every per-prompt tick stays in the DOM (the one-tick-per-prompt contract), and non-dense ticks keep today's per-tick behavior exactly. The setting is a local browser preference (`LocalSettings.freshAgent.showTranscriptMinimap`, default `true`) wired through the repo's existing 8-point local-settings chain and consumed as a live render gate at the transcript's minimap mount site (the `showTimecodes` pattern), so OFF unmounts the component and its effects.

**Tech Stack:** React 18 + TypeScript (client), Tailwind CSS classes, existing hand-rolled `Tooltip` (`src/components/ui/tooltip.tsx`), existing `ContextMenu` (`src/components/context-menu/ContextMenu.tsx`), Redux Toolkit local-settings chain (`shared/settings.ts` → `settingsSlice` → `browserPreferencesPersistence`), Vitest + Testing Library (jsdom) for unit tests, Playwright (cloud backend) for e2e.

## Global Constraints

Carried forward from the prior plan (binding unless explicitly amended here):

- **TDD:** Red-Green-Refactor per task. Every new test fails first for the stated reason and passes after the shown implementation. Never skip the refactor step (state explicitly when none is needed). The only exceptions are the two behavior-inert style-Nit fixes in Task 1 (`const heights`, redundant-disconnect removal) and regression-pinning assertions, which get bounded-mutation RED proofs instead (exact commands given in the task).
- **Worktree:** All work happens in the coordinator-provided worktree `.worktrees/transcript-minimap` on branch `the-usual/transcript-minimap`, continuing from HEAD `cd55891bc`. Run every command from that directory. Do not merge, push, or open a PR — the coordinator gates all of those on explicit user approval.
- **A11y:** Every interactive element is a real `<button type="button">` with an `aria-label`. `npm run lint` (eslint-plugin-jsx-a11y) must stay clean — it is a CI gate. E2e specs may use only `getByRole`/`getByText`/`getByTestId`/`[data-*]` locator patterns (the a11y gate runs in `--deny` mode). **Pre-existing a11y-gate red (binding):** `npm run test:e2e:a11y-gate:deny` ALREADY exits 1 at the branch point with 11 novel violations in 5 spec files this run never touches (receipt: run-1 ledger, reproduced at origin/main). No task expects a clean exit. The requirement is ZERO violations naming this branch's specs — verify with `npm run test:e2e:a11y-gate:deny 2>&1 | grep -c "transcript-minimap"` → expect 0.
- **No IntersectionObserver** — it is neither used nor stubbed anywhere in this repo. The visible-region band is computed from `scrollTop`/`scrollHeight`/`clientHeight`.
- **Tick completeness (binding contract):** every user prompt keeps a tick in a DISTINCT, non-overlapping slot. No tick is ever dropped, capped, sampled, or virtualized — the whole-branch Nit 2 "cap/sampling" remedy is explicitly barred by this run's constraints. Task 3's clickability-run affordances are purely ADDITIVE — one extra button over each dense multi-member run, plus an expanded hit height on a lone sub-4px tick's own button (its paint preserved by an inner span); all per-prompt ticks stay in the DOM with unchanged keyboard/screen-reader access.
- **jsdom geometry:** jsdom has no layout. Tests mock `clientHeight`/`scrollHeight` with `Object.defineProperty` getters, set `scrollTop` directly, replace `getBoundingClientRect` per element, and assign `el.scrollIntoView = vi.fn()` per element. `ResizeObserver` is globally stubbed as a no-op (`test/setup/dom.ts:46-54`); tests that need firing use the suite-local `CapturingResizeObserver` (per-target callback map). Any unexpected `console.error` fails the test (`test/setup/dom.ts:127-144`) — no React key warnings, no act() warnings. For that reason all measurement work is **synchronous, not rAF-throttled**: a rAF callback would land `setState` outside `fireEvent`'s act() wrapper and fail the suite. (The `ContextMenu` primitive's internal rAF focus call is pre-existing, portal-rendered, and proven safe by its own jsdom suites.)
- **Focused test command shape** (repo-owned passthrough; raw `npx vitest` is not a coordinated workflow):
  `npm run test:vitest -- run <path> --config config/vitest/vitest.config.ts`
- **E2E backend:** `FRESHELL_E2E_BACKEND=cloud` is set in `~/.bashrc`; run e2e through `bash -lc 'npm run test:e2e:cloud -- --project=chromium <spec>'`. Never silently fall back to a local backend. Each task's first e2e run pays a one-time `~13 min` dirty-image rebuild (expected and correct — the tree is genuinely dirty mid-task); verify each run's output reports tests actually passing (a filter that matched no tests is not coverage), and confirm the spec is not in `CLOUD_SKIP_SPECS`.
- **Path aliases:** `@/` → `src/`, `@shared/` → `shared/`, `@test/` → `test/`. Relative imports inside `src/` are extensionless (bundler style); the NodeNext `.js`-extension rule applies only to `tools/`/Electron code.
- **Minimal diffs (amended):** The prior plan's "the only edit to `FreshAgentTranscript.tsx` is one import plus one render block" clause is superseded by this run's mandated shared-sweep refactor (Task 2) and setting gate (Task 4). Everything else keeps minimal diffs: no changes to files outside each task's Files list; no reformatting of untouched code.
- **Glom independence (new, binding):** the glom chip's behavior must never depend on the minimap's mount state. The shared sweep is owned by the transcript; the minimap may add re-measure triggers (its ResizeObservers) but never owns the sweep. Any design that would break the glom chip when the rail is hidden (by geometry OR by the Task-4 setting) is wrong.
- **Setting semantics (new, binding):** `showTranscriptMinimap` is a LOCAL browser preference (family: `expandThinking`/`expandTools`/`showTimecodes`) — zero Rust/server changes, and the server patch schema must continue to reject it. Default `true`. It is a LIVE gate (the `showTimecodes` pattern), not a mount-time default (the `expandTools` pattern is deliberately wrong here — the suite pins that mount-time defaults do not apply to live panes). OFF means the minimap component is unmounted: no rail DOM, no scroll listener, no ResizeObservers, no per-scroll tick rendering — "and its work" is enforced by unmount semantics, not by internal flags.
- **Process safety:** never restart the self-hosted server on port 3001; no broad kills; no `git push` / PR without explicit user approval.
- **Plan fidelity:** the code blocks below are the source of truth. Implementers never invent central behavior; any deviation is recorded in the task report and adjudicated by the task review before commit.
- **Broad validation before recap** (coordinator's recap phase, not a plan task): `FRESHELL_TEST_SUMMARY="transcript-minimap-polish" npm test`.

---

### Task 1: Minimap polish bundle — tooltip word-break, style Nits, tie-break pin

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx` (TooltipContent className at :173; redundant effect-body disconnect at :98)
- Modify: `src/components/fresh-agent/shared/transcript-minimap-layout.ts` (`let heights` → `const heights` at :70)
- Modify: `test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts` (new tie-break pin after :137)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx` (new class-presence test)
- Modify: `test/e2e-browser/specs/transcript-minimap.spec.ts` (unbroken-token prompt + text-overflow assertion in test 1)

**Interfaces:**
- Consumes: the existing `TooltipContent` className prop (`src/components/ui/tooltip.tsx:60-114` — the className lands on the portaled `role="tooltip"` element itself, so `toHaveClass` works on `screen.getByRole('tooltip')`); the existing layout module.
- Produces: no interface changes. `break-words` joins the tooltip's `max-w-64 whitespace-pre-wrap` (family precedent: `FreshAgentTranscript.tsx:954` `whitespace-pre-wrap break-words`). The tie-break comparator `a.offsetTop - b.offsetTop || a.index - b.index` (`transcript-minimap-layout.ts:69`) is unchanged — it gains its first regression pin.
- Style Nits (behavior-inert, from the recorded task reviews): `let heights` at layout.ts:70 never rebinds (only elements mutate at :111) so `const` is valid, and repo ESLint has no `prefer-const` rule, so no gate distinguishes them — the change ships with the commit message as its justification. The `articleObserverRef.current?.disconnect()` in the signature-effect body (Minimap.tsx:98) is unreachable-with-effect (React guarantees the effect cleanup at :107-110 runs before any re-run, including StrictMode double-invocation) — removal makes lifecycle ownership purely cleanup-based; again no test can distinguish, and the existing observer tests stay green either way.

- [ ] **Step 1: Write the failing behavioral test**

1a. Add to `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx`, inside the existing `describe` (e.g. after the "truncates long prompts in the aria-label (60) and tooltip (120)" test):

```tsx
  it('wraps long unbroken tokens in the hover preview (break-words)', () => {
    setupScrollableTranscript()
    const tick = screen.getByRole('button', { name: 'Jump to prompt: Second user message here' })

    fireEvent.mouseEnter(tick)
    // jsdom cannot observe visual wrapping; this class-presence pin plus the
    // e2e range assertion (transcript-minimap.spec.ts) carry the real behavior.
    expect(screen.getByRole('tooltip')).toHaveClass('break-words')
    fireEvent.mouseLeave(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })
```

1b. Add to `test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts`, immediately after the "sorts unsorted landmarks by offsetTop (ties by index)" test (ends at line 137):

```ts
  it('breaks offsetTop ties by landmark index (reversed input order)', () => {
    // Equal offsetTops: without the index tie-break, modern V8's STABLE sort
    // keeps the tied pair in INPUT order (2 before 1) and the output would be
    // [0, 2, 1] — the pre-existing test only exercises distinct offsetTops,
    // so the tie comparator was never behaviorally pinned.
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(2, 500), landmark(1, 500), landmark(0, 0)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2])
    // The tied pair collides proportionally (both tops 25 at scale 0.05) and
    // packs by abut: index 1 anchors at 25, index 2 abuts at 30.
    expect(layout.ticks[1].top).toBeCloseTo(25, 5)
    expect(layout.ticks[2].top).toBeCloseTo(30, 5)
  })
```

1c. In `test/e2e-browser/specs/transcript-minimap.spec.ts`: add next to `tallBody` at the top of the file:

```ts
/** One 200-char unbreakable token: no spaces AND no line-break opportunities
 * (no hyphens, slashes, or punctuation — CSS creates break opportunities at
 * those even without overflow-wrap, which load-bearing validation proved
 * empirically in headless Chromium), so only overflow-wrap can keep it
 * inside the 16rem tooltip box. */
const LONG_UNBROKEN_TOKEN = 'B'.repeat(200)
```

Replace the FIRST seeded turn line of test 1:

```ts
      { id: 'turn-mm-u1', turnId: 'turn-mm-u1', role: 'user', summary: 'Draft the release notes', items: [{ id: 'item-mm-u1', kind: 'text', text: 'Draft the release notes' }] },
```

with:

```ts
      { id: 'turn-mm-u1', turnId: 'turn-mm-u1', role: 'user', summary: LONG_UNBROKEN_TOKEN, items: [{ id: 'item-mm-u1', kind: 'text', text: LONG_UNBROKEN_TOKEN }] },
```

and insert this block into test 1 immediately after the existing middle-tick hover assertions (`await expect(page.getByRole('tooltip')).toHaveText('Now add the upgrade guide')`, mouse-move-away, `toHaveCount(0)`):

```ts
    // Word-break: hovering the unbreakable-token prompt must keep the rendered
    // text inside the tooltip box (break-words). Without overflow-wrap the
    // 120-char truncated token paints as one ~840px line spilling past the
    // 16rem box (verified: a plain-alphanumeric token has no CSS break
    // opportunities, so it genuinely cannot wrap without overflow-wrap).
    const first = freshPane.getByRole('button', { name: /^Jump to prompt: B/ })
    await first.hover()
    const tooltip = page.getByRole('tooltip')
    await expect(tooltip).toBeVisible()
    const textFitsBox = await tooltip.evaluate((el: HTMLElement) => {
      const range = document.createRange()
      range.selectNodeContents(el)
      return range.getBoundingClientRect().right <= el.getBoundingClientRect().right + 1
    })
    expect(textFitsBox).toBe(true)
    await page.mouse.move(0, 0)
    await expect(tooltip).toHaveCount(0)
```

(Nothing else in test 1 depends on the first prompt's exact text: the count assertion uses the `/Jump to prompt:/` regex and the hover/click flow uses the middle tick's exact name.)

- [ ] **Step 2: Run the tests and verify the intended failures**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts
```

Expected RED: "wraps long unbroken tokens in the hover preview (break-words)" fails with `Expected the element to have class "break-words"` (the current className at Minimap.tsx:173 is `max-w-64 whitespace-pre-wrap`). All other tests in the file pass.

The tie-break pin passes against current code by design — it pins implemented-but-unprotected behavior (the recorded Nit). Prove it is load-bearing with a bounded, immediately-restored mutation:

```bash
# Bounded mutation — temporarily remove the tie-break:
#   transcript-minimap-layout.ts:69
#   BEFORE: const sorted = [...input.landmarks].sort((a, b) => a.offsetTop - b.offsetTop || a.index - b.index)
#   AFTER:  const sorted = [...input.landmarks].sort((a, b) => a.offsetTop - b.offsetTop)
npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts
# Expected RED (only the new test): expected [0,1,2] — received [0,2,1]
git restore src/components/fresh-agent/shared/transcript-minimap-layout.ts
npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts
# Expected: PASS (pin restored; a stable-sort regression now has a failing test)
```

E2e RED (the spec edit is uncommitted; the tracked tree is otherwise clean):

```bash
git status --short   # expect: M test/e2e-browser/specs/transcript-minimap.spec.ts plus the unit-test edits
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
```

Expected RED: test 1 fails at `expect(textFitsBox).toBe(true)` — received `false` (the token's text range extends past the tooltip box without `break-words`). The fits-viewport test still passes. Record the failing output in the task report.

- [ ] **Step 3: Add the minimal production implementation**

Edit 1 — `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx:173`:

```tsx
              className="max-w-64 whitespace-pre-wrap break-words"
```

Edit 2 — `src/components/fresh-agent/shared/transcript-minimap-layout.ts:70`, change `let` to `const` (the binding is never reassigned; only elements mutate at :111):

```ts
  const heights = sorted.map((mark) => Math.min(
```

Edit 3 — `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx:98`, delete the line:

```tsx
    articleObserverRef.current?.disconnect()
```

(the effect cleanup at :107-110 already disconnects and nulls the ref on every re-run and on unmount — React guarantees the cleanup runs first).

- [ ] **Step 4: Run the focused tests**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
```

Expected: PASS — both unit files fully green (16 layout tests + 15 component tests), both e2e tests green, including `textFitsBox === true`.

- [ ] **Step 5: Refactor while green**

No refactor needed: the changes are one utility class, one binding keyword, one deleted defensive line, and one pinning test. There is no duplication to extract and no consumer whose usage could inform a better shape.

- [ ] **Step 6: Run impacted-test verification**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
npm run test:e2e:a11y-gate:deny 2>&1 | grep -c "transcript-minimap" || true   # expect 0 violations naming our spec (gate itself is pre-existing red — Global Constraints)
git grep -n "transcript-minimap" test/e2e-browser/playwright.cloud.config.ts || echo "not skipped"
```

Expected: PASS / clean. The spec uses only permitted locator patterns and adds zero a11y-gate violations.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx src/components/fresh-agent/shared/transcript-minimap-layout.ts test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts test/e2e-browser/specs/transcript-minimap.spec.ts
git commit -m "fix(fresh-agent): minimap tooltip word-break, cleanup nits, and sort tie-break pin"
```

Commit contents: the `break-words` class (+ its unit pin and e2e text-overflow assertion), `const heights`, the removed redundant effect-body disconnect, and the offsetTop-tie regression pin — all four recorded items of this bundle in one focused commit.

---

### Task 2: One shared user-turn landmark sweep (transcript-owned)

**Files:**
- Create: `src/components/fresh-agent/shared/transcript-measurement.ts`
- Create: `test/unit/client/components/fresh-agent/transcript-measurement.test.ts`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (state :1066; glom recompute :1132-1155; signature effect :1242-1244; onScroll :1277-1281; minimap render :1390-1394; one import)
- Modify: `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx` (full internal rewrite; props interface change)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx` (add the one-sweep spy test; the 15 existing tests are NOT edited)

**Interfaces:**
- Produces (new module `shared/transcript-measurement.ts`):
  - `type TranscriptMeasurement = { landmarks: MinimapLandmark[]; scrollHeight: number; clientHeight: number; scrollTop: number }`
  - `measureTranscriptUserTurns(scroller: HTMLDivElement | null, displayTurns: readonly FreshAgentTurn[]): TranscriptMeasurement | null` — the single DOM sweep. Null iff the scroller is missing. Reads scroller geometry + ONE scroller rect + one rect per valid `[data-turn-role="user"]` article; skip rules identical to today's minimap sweep (missing/NaN `data-turn-index`, missing `displayTurns[index]`, empty `turnPlainText`); landmarks pushed in document order; `offsetTop = rect.top - scrollerTop + scrollTop`.
  - `deriveGlomTarget(measurement: TranscriptMeasurement | null): { index: number; text: string } | null` — pure: the LAST landmark (document order) with `offsetTop < scrollTop` (strict — exactly today's `el.getBoundingClientRect().top < scrollerTop` in content coordinates), as `{ index, text: label }`.
- `FreshAgentTranscriptMinimapProps` becomes `{ scrollerRef; measurement: TranscriptMeasurement | null; onRemeasure: () => void; transcriptSignature: string }`. The child no longer receives `displayTurns`, no longer sweeps, and no longer installs a scroll listener; it computes `MinimapLayout` from the `measurement` prop via `useMemo` and owns only its two `ResizeObserver` subscriptions (scroller children, keyed on `transcriptSignature`; scroller), both wired to `onRemeasure`.
- Design rationale (committed to; plan review adjudicates): **parent-owned sweep.** The child-owned alternative (minimap sweeps, reports up via `onMeasure`) would make the glom chip depend on the minimap's lifecycle — with the Task-4 setting OFF, and on every fits-viewport render, the minimap unmounts and the glom chip would lose its data source, violating the glom-independence constraint. Parent ownership keeps the glom's triggers exactly its pre-existing ones (scroll + signature), while the minimap's additive triggers (the two ResizeObservers) live and die with the minimap — precisely the "and its work" requirement. A helper-extraction-only option (both call a shared function) still runs two DOM sweeps per scroll and does not clear the finding.
- Trigger sets after this task: transcript sweep = {scroll via onScroll, transcriptSignature change via the existing effect} — identical to today's glom triggers; the minimap re-renders on each new `measurement` prop and requests sweeps from its own observers. Every scroll event runs exactly ONE `querySelectorAll('[data-turn-role="user"]')` + ONE scroller rect + one rect per valid user article (previously two of each).
- Residual (documented): when the rail is unmounted (setting off) and a content-only resize then occurs, the stored measurement goes stale until the next scroll/signature trigger or the freshly mounted rail's ResizeObservers fire (real browsers fire RO callbacks on initial observe, self-healing within a frame). Accepted: the glom chip — the only consumer live at that moment — does not depend on article-resize freshness.

- [ ] **Step 1: Write the failing behavioral tests**

New file `test/unit/client/components/fresh-agent/transcript-measurement.test.ts` (complete):

```ts
import { describe, expect, it } from 'vitest'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import {
  deriveGlomTarget,
  measureTranscriptUserTurns,
  type TranscriptMeasurement,
} from '@/components/fresh-agent/shared/transcript-measurement'

function userTurn(id: string, text: string): FreshAgentTurn {
  return {
    id,
    role: 'user',
    summary: text,
    items: [{ id: `${id}-item`, kind: 'text', text }],
  }
}

function mockRect(el: Element, top: number, height = 50) {
  el.getBoundingClientRect = () => ({
    top,
    bottom: top + height,
    left: 0,
    right: 800,
    width: 800,
    height,
    x: 0,
    y: top,
    toJSON: () => ({}),
  })
}

function buildScroller(scrollTop: number, scrollHeight: number, clientHeight: number) {
  const scroller = document.createElement('div')
  document.body.appendChild(scroller)
  scroller.scrollTop = scrollTop
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
  return scroller
}

function addUserArticle(scroller: HTMLDivElement, index: number | string | null) {
  const el = document.createElement('article')
  el.setAttribute('data-turn-role', 'user')
  if (index !== null) el.setAttribute('data-turn-index', String(index))
  scroller.appendChild(el)
  return el
}

describe('measureTranscriptUserTurns', () => {
  it('returns null for a missing scroller', () => {
    expect(measureTranscriptUserTurns(null, [])).toBeNull()
  })

  it('collects one landmark per valid user article in document order, applying the shared skip rules', () => {
    const scroller = buildScroller(100, 2000, 300)
    const ok0 = addUserArticle(scroller, 0)
    addUserArticle(scroller, null)            // missing data-turn-index -> skipped
    addUserArticle(scroller, 'not-a-number')  // NaN index -> skipped
    addUserArticle(scroller, 7)               // no displayTurns[7] -> skipped
    const ok1 = addUserArticle(scroller, 1)
    const ok2 = addUserArticle(scroller, 2)    // empty label -> skipped
    mockRect(scroller, 500)
    mockRect(ok0, 400) // offsetTop = 400 - 500 + 100 = 0
    mockRect(ok1, 700) // offsetTop = 700 - 500 + 100 = 300
    mockRect(ok2, 900)

    const turns = [userTurn('u0', 'First prompt'), userTurn('u1', 'Second prompt'), userTurn('u2', '')]
    const measurement = measureTranscriptUserTurns(scroller, turns)

    expect(measurement).toEqual({
      landmarks: [
        { index: 0, offsetTop: 0, height: 50, label: 'First prompt' },
        { index: 1, offsetTop: 300, height: 50, label: 'Second prompt' },
      ],
      scrollHeight: 2000,
      clientHeight: 300,
      scrollTop: 100,
    })
  })
})

describe('deriveGlomTarget', () => {
  it('returns null for a null measurement or no landmarks', () => {
    expect(deriveGlomTarget(null)).toBeNull()
    const empty: TranscriptMeasurement = { landmarks: [], scrollHeight: 1000, clientHeight: 200, scrollTop: 400 }
    expect(deriveGlomTarget(empty)).toBeNull()
  })

  it('derives the LAST user turn above the viewport top', () => {
    // Landmarks are document order; the glom chip keeps overwriting its
    // target so the last above-viewport turn wins (the pre-refactor behavior).
    const measurement: TranscriptMeasurement = {
      landmarks: [
        { index: 0, offsetTop: 0, height: 100, label: 'First prompt' },
        { index: 2, offsetTop: 300, height: 100, label: 'Second prompt' },
        { index: 4, offsetTop: 450, height: 100, label: 'Third prompt' },
      ],
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 400,
    }
    expect(deriveGlomTarget(measurement)).toEqual({ index: 2, text: 'Second prompt' })
  })

  it('treats a turn exactly at the viewport top as NOT above it (strict <)', () => {
    const measurement: TranscriptMeasurement = {
      landmarks: [{ index: 1, offsetTop: 400, height: 100, label: 'At the top' }],
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 400,
    }
    expect(deriveGlomTarget(measurement)).toBeNull()
  })
})
```

New component spy test — add to `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx` inside the existing `describe` (e.g. after "renders no rail under default jsdom geometry"):

```tsx
  it('runs ONE shared landmark sweep per scroll event, feeding both the glom chip and the rail', () => {
    const { scroller } = setupScrollableTranscript()
    // Both consumers render from the shared sweep: the glom chip names the
    // last prompt above the viewport; the rail shows all three ticks.
    expect(screen.getByRole('button', { name: /Jump to your message/ })).toHaveTextContent('Second user message here')
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    const sweepQuery = vi.spyOn(scroller, 'querySelectorAll')
    const scrollerRect = vi.spyOn(scroller, 'getBoundingClientRect')
    fireEvent.scroll(scroller)

    // ONE querySelectorAll('[data-turn-role="user"]') per scroll event — the
    // pre-refactor code ran two (recomputeGlom + the minimap's own sweep).
    const landmarkQueries = sweepQuery.mock.calls.filter(
      ([selector]) => selector === '[data-turn-role="user"]',
    )
    expect(landmarkQueries).toHaveLength(1)
    // One scroller rect read per sweep (shared), not one per consumer.
    expect(scrollerRect).toHaveBeenCalledTimes(1)
    // Both consumers updated from that single sweep.
    expect(screen.getByRole('button', { name: 'Jump to your message: Second user message here' })).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    sweepQuery.mockRestore()
    scrollerRect.mockRestore()
  })
```

- [ ] **Step 2: Run the tests and verify the intended failures**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-measurement.test.ts --config config/vitest/vitest.config.ts
```

Expected RED: the whole file errors at import — the module `@/components/fresh-agent/shared/transcript-measurement` does not exist yet (the standard red state for a new module).

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts
```

Expected RED: only the new spy test fails — `landmarkQueries` received length **2** (expected 1): the parent's `recomputeGlom` and the minimap's native-listener `recompute` each sweep (`scrollerRect` also receives 2). All 15 pre-existing tests still pass (the new spy test is the file's 16th and its only RED).

- [ ] **Step 3: Add the minimal production implementation**

Create `src/components/fresh-agent/shared/transcript-measurement.ts` (complete):

```ts
// src/components/fresh-agent/shared/transcript-measurement.ts
//
// The single shared landmark sweep for the fresh-agent transcript: measures
// every user turn against the scroller ONCE per trigger and produces a
// TranscriptMeasurement consumed by BOTH the glom chip (deriveGlomTarget) and
// the minimap rail (FreshAgentTranscriptMinimap). Owned by the transcript so
// the glom chip never depends on the minimap's mount state.

import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { turnPlainText } from '../FreshAgentTurnActions'
import type { MinimapLandmark } from './transcript-minimap-layout'

export type TranscriptMeasurement = {
  /** Valid user-turn landmarks, in document order. */
  landmarks: MinimapLandmark[]
  /** Scroller geometry captured in the same pass. */
  scrollHeight: number
  clientHeight: number
  scrollTop: number
}

/** One DOM sweep: scroller geometry + one rect per valid user-turn article.
 *  Returns null when the scroller is missing. Synchronous by design (jsdom
 *  act() gate — see the plan's Global Constraints). */
export function measureTranscriptUserTurns(
  scroller: HTMLDivElement | null,
  displayTurns: readonly FreshAgentTurn[],
): TranscriptMeasurement | null {
  if (!scroller) return null
  const { scrollHeight, clientHeight, scrollTop } = scroller
  const scrollerTop = scroller.getBoundingClientRect().top
  const landmarks: MinimapLandmark[] = []
  scroller.querySelectorAll<HTMLElement>('[data-turn-role="user"]').forEach((el) => {
    const indexAttr = el.getAttribute('data-turn-index')
    if (indexAttr == null) return
    const index = Number(indexAttr)
    if (Number.isNaN(index)) return
    const turn = displayTurns[index]
    if (!turn) return
    const label = turnPlainText(turn)
    if (!label) return
    const rect = el.getBoundingClientRect()
    landmarks.push({
      index,
      offsetTop: rect.top - scrollerTop + scrollTop,
      height: rect.height,
      label,
    })
  })
  return { landmarks, scrollHeight, clientHeight, scrollTop }
}

/** Glom chip target: the LAST user turn (document order) above the viewport
 *  top — `offsetTop < scrollTop` is exactly the glom's historical
 *  `el.getBoundingClientRect().top < scrollerTop` condition in content
 *  coordinates, same strictness. Pure; no DOM reads. */
export function deriveGlomTarget(
  measurement: TranscriptMeasurement | null,
): { index: number; text: string } | null {
  if (!measurement) return null
  let target: { index: number; text: string } | null = null
  for (const mark of measurement.landmarks) {
    if (mark.offsetTop < measurement.scrollTop) {
      target = { index: mark.index, text: mark.label }
    }
  }
  return target
}
```

Modify `src/components/fresh-agent/FreshAgentTranscript.tsx` — six edits:

Edit 1 (import, next to the minimap import):

```tsx
import { deriveGlomTarget, measureTranscriptUserTurns, type TranscriptMeasurement } from './shared/transcript-measurement'
```

Edit 2 (state — replace the `glomTarget` state at :1066):

```tsx
  const [transcriptMeasurement, setTranscriptMeasurement] = useState<TranscriptMeasurement | null>(null)
```

Edit 3 (replace the whole `recomputeGlom` callback at :1132-1155 with):

```tsx
  // ONE shared landmark sweep per trigger (scroll + transcriptSignature). The
  // result feeds BOTH the glom chip (derived below) and the minimap rail
  // (passed down as a prop), so a scroll event scans the user-turn articles
  // exactly once. Synchronous on purpose (jsdom act() gate).
  const sweepTranscript = useCallback(() => {
    setTranscriptMeasurement(measureTranscriptUserTurns(scrollerRef.current, displayTurns))
  }, [displayTurns])

  const glomTarget = useMemo(
    () => deriveGlomTarget(transcriptMeasurement),
    [transcriptMeasurement],
  )
```

Edit 4 (signature effect at :1242-1244):

```tsx
  useEffect(() => {
    sweepTranscript()
  }, [sweepTranscript, transcriptSignature])
```

Edit 5 (onScroll handler at :1277-1281 — `recomputeGlom()` becomes `sweepTranscript()`):

```tsx
        onScroll={(event) => {
          const node = event.currentTarget
          setAtBottom(computeAtBottom(node))
          sweepTranscript()
        }}
```

Edit 6 (minimap render block at :1390-1394):

```tsx
      <FreshAgentTranscriptMinimap
        scrollerRef={scrollerRef}
        measurement={transcriptMeasurement}
        onRemeasure={sweepTranscript}
        transcriptSignature={transcriptSignature}
      />
```

`handleGlomClick` (:1157-1163) and the glom chip render (:1354-1365) are UNCHANGED — they consume the derived `glomTarget` exactly as before.

Replace the internals of `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx` (complete new file; note `break-words` from Task 1 is retained):

```tsx
import { useCallback, useEffect, useMemo } from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  computeMinimapLayout,
  MINIMAP_RAIL_BOTTOM_INSET_PX,
  type MinimapLayout,
} from './shared/transcript-minimap-layout'
import type { TranscriptMeasurement } from './shared/transcript-measurement'

const ARIA_LABEL_MAX_LENGTH = 60
const TOOLTIP_MAX_LENGTH = 120

function truncatePrompt(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

export type FreshAgentTranscriptMinimapProps = {
  /** The transcript's scroll container: owns the turn landmarks and geometry. */
  scrollerRef: { current: HTMLDivElement | null }
  /** The transcript's SINGLE shared landmark sweep result — the same
   *  measurement that feeds the glom chip. Null when the scroller is missing. */
  measurement: TranscriptMeasurement | null
  /** Requests a fresh shared sweep. Fired by this component's ResizeObservers
   *  (article-level and pane-level resize); the transcript owns the sweep. */
  onRemeasure: () => void
  /** Content signature; a change re-subscribes child observation (new articles). */
  transcriptSignature: string
}

/**
 * ChatGPT-style scroll minimap for the fresh-agent transcript: one tick per
 * user prompt (proportional to transcript length), a hover/focus prompt
 * preview, click-to-jump, and a band marking the visible region. Presentational
 * on top of the transcript's shared landmark sweep: geometry arrives via the
 * `measurement` prop; the only work this component owns is its two
 * ResizeObserver subscriptions, which request re-measurement through
 * `onRemeasure` — so unmounting it (the show/hide setting, pane teardown)
 * removes exactly its own work while the glom chip keeps its data.
 */
export function FreshAgentTranscriptMinimap({
  scrollerRef,
  measurement,
  onRemeasure,
  transcriptSignature,
}: FreshAgentTranscriptMinimapProps) {
  const layout = useMemo<MinimapLayout | null>(() => {
    if (!measurement) return null
    const railHeight = measurement.clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX
    // Hidden when the content fits the viewport or the rail has no room; also
    // the state jsdom sits in by default (zero geometry), which keeps the
    // rest of the transcript suite free of minimap buttons.
    if (measurement.scrollHeight <= measurement.clientHeight || railHeight <= 0) return null
    return computeMinimapLayout({
      scrollHeight: measurement.scrollHeight,
      viewportHeight: measurement.clientHeight,
      scrollTop: measurement.scrollTop,
      railHeight,
      landmarks: measurement.landmarks,
    })
  }, [measurement])

  // Observe every direct child of the scroller, not just turn articles: the
  // rolled-back-history disclosure section (and any caption) sits outside the
  // articles, and its expand/collapse changes scrollHeight without touching
  // transcriptSignature (derived only from displayTurns) or the scroller's
  // own border box. Re-subscribed per signature so new articles are observed
  // and stale ones released.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onRemeasure)
    Array.from(scroller.children).forEach((el) => observer.observe(el))
    return () => observer.disconnect()
  }, [onRemeasure, scrollerRef, transcriptSignature])

  // Pane resize: the scroller's border box changes with no scroll event, no
  // signature change, and no child resize — request a fresh sweep.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(onRemeasure)
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [onRemeasure, scrollerRef])

  const handleTickClick = useCallback((index: number) => {
    const scroller = scrollerRef.current
    if (!scroller) return
    const el = scroller.querySelector<HTMLElement>(`[data-turn-index="${index}"]`)
    // Optional call: jsdom has no scrollIntoView — the glom chip guards the
    // same way. The resulting scroll event flips atBottom false via the
    // transcript's existing onScroll handler, so stick-to-bottom disengages.
    el?.scrollIntoView?.({ block: 'start' })
  }, [scrollerRef])

  if (!layout) return null

  return (
    <div
      className="fresh-agent-minimap pointer-events-none absolute right-2 top-0 z-30 w-3"
      style={{ bottom: MINIMAP_RAIL_BOTTOM_INSET_PX }}
      role="group"
      aria-label="Transcript minimap"
    >
      <div
        data-testid="transcript-minimap-viewport"
        aria-hidden="true"
        className="pointer-events-none absolute right-0 w-full rounded-sm bg-foreground/10"
        style={{ top: layout.viewport.top, height: layout.viewport.height }}
      />
      {layout.ticks.map((tick) => {
        const firstLine = tick.label.split('\n')[0]
        return (
          <Tooltip key={tick.index}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="fresh-agent-minimap-tick pointer-events-auto absolute left-0 w-full rounded-sm bg-muted-foreground/40 transition-colors hover:bg-primary focus-visible:bg-primary"
                style={{ top: tick.top, height: tick.height }}
                aria-label={`Jump to prompt: ${truncatePrompt(firstLine, ARIA_LABEL_MAX_LENGTH)}`}
                onClick={() => handleTickClick(tick.index)}
              />
            </TooltipTrigger>
            <TooltipContent
              side={tick.top < layout.railHeight * 0.25 ? 'bottom' : 'top'}
              align="end"
              className="max-w-64 whitespace-pre-wrap break-words"
            >
              {truncatePrompt(firstLine, TOOLTIP_MAX_LENGTH)}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
```

Implementer notes: the removed pieces are the local `useState`/`recompute`/scroll-listener effect and `articleObserverRef` (Task 1 already deleted the redundant body disconnect; this rewrite deletes the whole ref). The component suite needs NO edits to its 16 tests (15 pre-existing + the new spy test, written against the target behavior): they render the transcript, mock geometry, and fire scroll — the parent's sweep now drives everything through the same observable behavior (the "recomputes ticks when the transcript grows" test's no-scroll design still holds: the PARENT's signature-keyed effect sweeps; the observer tests fire per-target callbacks that now route through `onRemeasure` → the parent sweep, all synchronously inside act()).

- [ ] **Step 4: Run the focused tests**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-measurement.test.ts test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscript.test.tsx --config config/vitest/vitest.config.ts
```

Expected: PASS — the new module tests (5), the component suite (16, including the one-sweep spy test now counting exactly 1), and the full transcript suite (including the untouched glom block at :1800-1930: last-above-viewport target, no-chip-when-none-above, click-jump, full-text aria-label/title, signature recompute — all preserved by construction: same landmarks, same strictness, same trigger set).

- [ ] **Step 5: Refactor while green**

No refactor needed. The sweep is a single small module with two functions; the transcript's wiring is one state slot + one callback + two call sites; the child is presentational with two observer effects. There is no duplication left to extract — the shared sweep IS the extraction the finding asked for.

- [ ] **Step 6: Run impacted-test verification**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
```

Expected: PASS / clean. The e2e regression run matters here: no DOM contract changed, but the scroll path was re-owned, and the spec proves hover/click/jump/hide in a real browser on the new sweep (the full spec from Task 1 is in the tree and must stay green).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/shared/transcript-measurement.ts test/unit/client/components/fresh-agent/transcript-measurement.test.ts src/components/fresh-agent/FreshAgentTranscript.tsx src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx
git commit -m "refactor(fresh-agent): share one user-turn landmark sweep between glom chip and minimap"
```

---

### Task 3: Dense-cluster click-list affordance for extreme prompt density

**Files:**
- Modify: `src/components/fresh-agent/shared/transcript-minimap-layout.ts` (new constant + `MinimapCluster` type + `clusters` output via a second clickability pass)
- Modify: `test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts` (6 new tests)
- Modify: `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx` (dense-run hit targets + ContextMenu + lone-tick expanded hit heights)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx` (4 new tests + two fixture helpers (dense-cluster, evenly-dense); add `within` to the testing-library import)
- Modify: `test/e2e-browser/specs/transcript-minimap.spec.ts` (dense-cluster e2e with self-verifying density guard)

**Interfaces:**
- Layout module (additive output — no existing field changes):
  - `export const MINIMAP_TICK_MIN_CLICKABLE_PX = 4` — the clickable floor. Evidence for ~4px: sub-4px hit targets are not reliably individually clickable with a pointer on a 1× display (the recorded delta Finding 1), and 4px is the smallest height the repo's own UI scale treats as a comfortable row (Tailwind `h-1`, the size class used across the minimap/band rounding scale); "strictly below 4" therefore marks unreliable ticks while leaving 4px ticks direct-clickable. The plan guidance's ~4px suggestion, concretized; plan review adjudicates.
  - `export type MinimapCluster = { top: number; height: number; startIndex: number; endIndex: number; dense: boolean }` — derived by a SECOND pass over the final laid-out ticks, NOT from the packing loop's groups: a cluster is a maximal run of consecutive `layout.ticks` (sorted order) where each next tick begins within its predecessor's minimum click row — `ticks[i+1].top < ticks[i].top + MINIMAP_TICK_MIN_CLICKABLE_PX`. `top` is the first member's top; `height` is the last member's bottom minus the first member's top; `startIndex`/`endIndex` are INCLUSIVE positions into `layout.ticks`; `dense` is true iff at least one member tick's height is strictly below `MINIMAP_TICK_MIN_CLICKABLE_PX`. (Join-rule arithmetic: within a packed run each member's top is its predecessor's top plus the predecessor's height, so every multi-member run necessarily contains a sub-4px member — `dense` is what distinguishes menu-bearing multi-member runs and expanded-hit lone ticks from comfortably-clickable runs.)
  - `MinimapLayout` gains `clusters: MinimapCluster[]` (ALL runs, singletons included — `dense: false` when no member is sub-clickable); the degenerate return gains `clusters: []`.
- Component, dense MULTI-MEMBER runs (membership ≥ 2): ONE additional real `<button type="button">` over the run (`style={{ top: cluster.top, height: Math.min(Math.max(cluster.height, MINIMAP_TICK_MIN_CLICKABLE_PX), layout.railHeight - cluster.top) }}` — the run's span, floored at the clickable minimum, clamped to the rail bounds — full rail width, `pointer-events-auto`, `z-10` so it wins pointer events over the abutting ticks), `aria-haspopup="menu"`, `aria-label="Prompts {startIndex + 1}-{endIndex + 1} — open list"`. Clicking it opens the repo's `ContextMenu` (`src/components/context-menu/ContextMenu.tsx` — controlled, portaled to `document.body`, `role="menu"`, z-50, keyboard-complete, self-closing on selection) positioned at the BUTTON's rect (a keyboard click event carries clientX/clientY 0, so cursor coordinates are unusable; `clampToViewport` handles overflow), listing one `MenuItem` per run prompt (label = the prompt's first line truncated to 60 via the same `truncatePrompt` the tick aria-labels use; `onSelect` = the existing `handleTickClick(tick.index)`). Member ticks stay in the DOM.
- Component, LONE sub-4px ticks (a dense run with membership 1): the tick's OWN button gets an expanded hit height — `Math.min(MINIMAP_TICK_MIN_CLICKABLE_PX, layout.railHeight - tick.top)`; by construction an isolated tick has ≥ 4px pitch on both sides (else it would have joined a run), so the 4px hit box never overlaps a neighbor. The painted line becomes an inner `<span aria-hidden="true">` with the tick's visual height (same bg classes, absolute inset-x-0); the button keeps its aria-label and jumps DIRECTLY on click — no menu, the target is unambiguous.
- Non-dense runs render NOTHING extra — per-tick behavior byte-identical.
- The tooltip cannot host the menu (`TooltipContent` is `pointer-events-none`, tooltip.tsx:104); `ContextMenu` is the repo's controlled menu primitive and is not bound to the right-click gesture — instantiating it directly is the intended usage.
- Residual (documented, not silently accepted): cluster-member ticks remain visually sub-4px (the one-tick-per-prompt contract forbids merging their paint; their pointer path is the cluster menu; keyboard/AT access to every individual tick is unchanged). A lone sub-4px tick is no longer a residual — its button's expanded hit height is a first-class affordance (above).

- [ ] **Step 1: Write the failing behavioral tests**

Layout tests — add to `test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts` after the Task-1 tie-break pin, and add `MINIMAP_TICK_MIN_CLICKABLE_PX` to the import list from the layout module (it is used implicitly by the threshold test's arithmetic; import it for the assertion):

```ts
  it('exposes clickability clusters with span and membership (3-colliding case)', () => {
    // The 3-colliding case: laid-out tops 0/3/6 at 3px heights. The
    // clickability pass (a second pass over the FINAL ticks, not the
    // packing loop's groups) joins each next tick that begins within its
    // predecessor's 4px click row — 3 < 0+4 and 6 < 3+4 — forming ONE run
    // spanning rail 0..9; every member is under the 4px clickable floor,
    // so the cluster is dense.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(1, 100), landmark(2, 500)],
    })
    expect(layout.clusters).toEqual([
      { top: 0, height: 9, startIndex: 0, endIndex: 2, dense: true },
    ])
  })

  it('keeps individually-clickable packed ticks as separate non-dense runs', () => {
    // Two huge prompts scale to 50px ticks (final-group scaling 60 -> 50)
    // packed at tops 0/50. They collide for PACKING purposes, but the
    // clickability pass does not join them (50 >= 0+4): two singleton runs,
    // each comfortably clickable — no open-list affordance. This is the
    // case the packing-group cluster design wrongly merged.
    const layout = computeMinimapLayout({
      scrollHeight: 500, viewportHeight: 200, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 300), landmark(1, 250, 300)],
    })
    expect(layout.clusters).toEqual([
      { top: 0, height: 50, startIndex: 0, endIndex: 0, dense: false },
      { top: 50, height: 50, startIndex: 1, endIndex: 1, dense: false },
    ])
  })

  it('treats the clickable floor as inclusive — 4px ticks stay directly clickable', () => {
    // scale 0.04: 100px turns land exactly at the 4px floor. Both ticks
    // are exactly 4px and abut at tops 0/4 — the clickability pass does
    // not join them (4 < prevTop+4 is false) and each singleton run is
    // dense: false (dense is strictly-below the floor). A 75px turn (3px)
    // in the same geometry stays separate too, but its singleton run is
    // dense: a lone sub-4px tick.
    const atFloor = computeMinimapLayout({
      scrollHeight: 2500, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 100), landmark(1, 10, 100)],
    })
    expect(atFloor.ticks[0].height).toBeCloseTo(MINIMAP_TICK_MIN_CLICKABLE_PX, 5)
    expect(atFloor.clusters).toEqual([
      { top: 0, height: 4, startIndex: 0, endIndex: 0, dense: false },
      { top: 4, height: 4, startIndex: 1, endIndex: 1, dense: false },
    ])

    const belowFloor = computeMinimapLayout({
      scrollHeight: 2500, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 100), landmark(1, 10, 75)],
    })
    expect(belowFloor.clusters[1].dense).toBe(true)
  })

  it('reports singleton clusters for non-colliding ticks (never dense) and none for degenerate inputs', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(2, 1000), landmark(4, 1900)],
    })
    expect(layout.clusters).toEqual([
      { top: 0, height: 5, startIndex: 0, endIndex: 0, dense: false },
      { top: 50, height: 5, startIndex: 1, endIndex: 1, dense: false },
      { top: 95, height: 5, startIndex: 2, endIndex: 2, dense: false },
    ])

    const degenerate = computeMinimapLayout({
      scrollHeight: 0, viewportHeight: 200, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0)],
    })
    expect(degenerate.clusters).toEqual([])
  })

  it('collapses absurd density into ONE dense run — 30 sub-pixel ticks, every join satisfied', () => {
    // rail 20, scrollHeight 3000, 30 landmarks at i*100: 30 ticks at 2/3px
    // pitch and 2/3px height (the packer keeps every proportional top —
    // see the pre-existing absurd-density tick test). The clickability
    // pass joins EVERY consecutive pair (2/3 < prevTop+4), so the whole
    // rail is ONE run, startIndex 0..endIndex 29, dense (every member is
    // sub-4px). This is the extreme-density case the packing-group
    // cluster design missed.
    const layout = computeMinimapLayout({
      scrollHeight: 3000, viewportHeight: 400, scrollTop: 0, railHeight: 20,
      landmarks: Array.from({ length: 30 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.clusters).toHaveLength(1)
    expect(layout.clusters[0].startIndex).toBe(0)
    expect(layout.clusters[0].endIndex).toBe(29)
    expect(layout.clusters[0].dense).toBe(true)
    expect(layout.clusters[0].top).toBeCloseTo(0, 5)
    expect(layout.clusters[0].height).toBeCloseTo(20, 5)
  })

  it('keeps evenly-dense isolated ticks as dense singletons — every lone sub-4px tick is its own run', () => {
    // rail 200, scrollHeight 10000, 50 landmarks at i*200 with 150px rects:
    // scale 0.02, proportional heights 150*0.02 = 3, effectiveMin
    // min(3, 200/50) = 3, tops at 4px pitch (i*4). The clickability pass
    // joins NOTHING (4 < prevTop+4 is false) — 50 singleton clusters, each
    // dense (membership 1, sub-4px member): lone sub-4px ticks, the
    // geometry the component's expanded-hit treatment is built for.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 200,
      landmarks: Array.from({ length: 50 }, (_, i) => landmark(i, i * 200, 150)),
    })
    expect(layout.clusters).toHaveLength(50)
    layout.clusters.forEach((cluster, i) => {
      expect(cluster.startIndex).toBe(i)
      expect(cluster.endIndex).toBe(i)
      expect(cluster.top).toBeCloseTo(i * 4, 5)
      expect(cluster.height).toBeCloseTo(3, 5)
      expect(cluster.dense).toBe(true)
    })
  })
```

Component tests — add a dense fixture helper next to `setupScrollableTranscript` in `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx`:

```tsx
/** Dense-cluster geometry: scrollHeight 1000, clientHeight 248 -> railHeight
 *  200, scale 0.2. Four short user turns bunched at content offsets
 *  500/510/520/530 with 10px rects: proportional tops 100/102/104/106
 *  at the 3px density floor (max(min(3, 200/4), 10*0.2) = 3, under the
 *  4px clickable floor), packed abutting at 100/103/106/109. The
 *  clickability pass joins every consecutive pair (103 < 100+4,
 *  106 < 103+4, 109 < 106+4) into ONE dense multi-member run spanning
 *  rail 100..112 (last bottom 109+3 minus first top 100). */
function setupDenseClusterTranscript() {
  const turns = Array.from({ length: 4 }, (_, i) => ({
    id: `du${i}`,
    role: 'user' as const,
    summary: `Dense prompt number ${i + 1}`,
    items: [{ id: `di${i}`, kind: 'text' as const, text: `Dense prompt number ${i + 1}` }],
  }))
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, 0, 1000, 248)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  userTurns.forEach((el, i) => mockRect(el, 500 + i * 10, 10))
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

/** Evenly-dense isolated-tick geometry (the lone sub-4px tick fixture):
 *  scrollHeight 10000, clientHeight 248 -> railHeight 200, scale 0.02.
 *  Fifty short user turns at content offsets i*200 with 150px rects:
 *  proportional heights 150*0.02 = 3 (effectiveMin min(3, 200/50) = 3),
 *  tops at exact 4px pitch (i*4). The clickability pass joins nothing
 *  (4 < prevTop+4 is false) — 50 dense SINGLETON clusters: every tick is
 *  a lone sub-4px tick, none collides into a multi-member run. */
function setupEvenlyDenseTranscript() {
  const turns = Array.from({ length: 50 }, (_, i) => ({
    id: `eu${i}`,
    role: 'user' as const,
    summary: `Even dense prompt number ${i + 1}`,
    items: [{ id: `ei${i}`, kind: 'text' as const, text: `Even dense prompt number ${i + 1}` }],
  }))
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, 0, 10000, 248)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  userTurns.forEach((el, i) => mockRect(el, i * 200, 150))
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}
```

and four tests inside the describe (add `within` to the `@testing-library/react` import at the top of the file):

```tsx
  it('renders one open-list target over a dense cluster; every per-prompt tick stays in the DOM', () => {
    setupDenseClusterTranscript()

    // The one-tick-per-prompt contract: all four tick buttons remain, fully
    // keyboard/screen-reader accessible as today.
    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(4)
    // The dense cluster gains exactly one hit-target button over its span.
    const clusterTarget = screen.getByRole('button', { name: 'Prompts 1-4 — open list' })
    expect(topOf(clusterTarget)).toBeCloseTo(100, 5)
    expect(heightOf(clusterTarget)).toBeCloseTo(12, 5)
    expect(clusterTarget).toHaveAttribute('aria-haspopup', 'menu')
  })

  it('keeps normal-density clusters on per-tick behavior — no open-list targets', () => {
    setupScrollableTranscript()
    expect(screen.queryByRole('button', { name: /— open list/ })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)
  })

  it('opens a ContextMenu listing every prompt in the dense cluster; selecting one jumps to it', () => {
    const { userTurns } = setupDenseClusterTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[2].scrollIntoView = scrollIntoViewSpy

    fireEvent.click(screen.getByRole('button', { name: 'Prompts 1-4 — open list' }))

    const menu = screen.getByRole('menu')
    const items = within(menu).getAllByRole('menuitem')
    expect(items).toHaveLength(4)
    expect(items[0]).toHaveTextContent('Dense prompt number 1')
    expect(items[3]).toHaveTextContent('Dense prompt number 4')

    fireEvent.click(items[2])
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    // ContextMenu closes itself after a selection.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('gives a lone sub-4px tick a 4px hit target with a 3px painted span and a direct jump (no menu)', () => {
    const { userTurns } = setupEvenlyDenseTranscript()
    const firstTick = screen.getByRole('button', { name: 'Jump to prompt: Even dense prompt number 1' })

    // The button's hit height expands to the 4px clickable floor...
    expect(heightOf(firstTick)).toBeCloseTo(4, 5)
    // ...while the painted line is an inner aria-hidden span at the tick's
    // visual 3px height (same bg classes).
    const painted = firstTick.querySelector('span')
    expect(painted).not.toBeNull()
    expect(painted).toHaveAttribute('aria-hidden', 'true')
    expect(heightOf(painted as HTMLElement)).toBeCloseTo(3, 5)

    // No menu anywhere — the target is unambiguous; clicking jumps directly.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    const scrollIntoViewSpy = vi.fn()
    userTurns[0].scrollIntoView = scrollIntoViewSpy
    fireEvent.click(firstTick)
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
```

E2e — add to `test/e2e-browser/specs/transcript-minimap.spec.ts`. New helper next to `tallBody`:

```ts
function veryTallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 240 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog, and then it jumps again.`,
  ).join('\n\n')
}
```

New test inside the describe (unique sessionId `…aa103`):

```ts
  test('dense prompt clusters get one open-list target whose menu jumps to any prompt', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa103'
    const turns: unknown[] = []
    for (let i = 0; i < 4; i++) {
      turns.push({
        id: `turn-dense-a${i}`, turnId: `turn-dense-a${i}`, role: 'assistant', summary: `Body ${i}`,
        items: [{ id: `item-dense-a${i}`, kind: 'text', text: veryTallBody(`Body${i}`) }],
      })
    }
    for (let i = 0; i < 12; i++) {
      turns.push({
        id: `turn-dense-u${i}`, turnId: `turn-dense-u${i}`, role: 'user', summary: `Dense prompt ${i + 1}`,
        items: [{ id: `item-dense-u${i}`, kind: 'text', text: `Dense prompt ${i + 1}` }],
      })
    }
    await seedMinimapPane(page, sessionId, turns)

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane.getByText('Dense prompt 12', { exact: true })).toBeVisible({ timeout: 20_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible()

    // Every prompt keeps its tick (one-tick-per-prompt contract).
    const ticks = freshPane.getByRole('button', { name: /Jump to prompt:/ })
    await expect(ticks).toHaveCount(12)

    // Self-verifying density guard: the first prompt tick must be under the
    // 4px clickable floor in THIS pane geometry — otherwise the cluster
    // affordance is not in play and the test proves nothing. If this fails
    // on cloud geometry, grow veryTallBody's paragraph count — do not
    // delete the guard.
    const firstTickHeight = await ticks.first().evaluate((el: HTMLElement) => el.getBoundingClientRect().height)
    expect(firstTickHeight).toBeLessThan(4)

    // One open-list target covers the bunched cluster; clicking it opens a menu.
    const clusterTargets = freshPane.getByRole('button', { name: /— open list/ })
    await expect(clusterTargets.first()).toBeVisible()
    await clusterTargets.first().click()
    const menu = page.getByRole('menu')
    await expect(menu).toBeVisible()
    const itemCount = await page.getByRole('menuitem').count()
    expect(itemCount).toBeGreaterThanOrEqual(2)
    expect(itemCount).toBeLessThanOrEqual(12)

    // Selecting a listed prompt jumps there: the transcript loads pinned to
    // the bottom and the bunched prompts sit ~600px above it, so scrollTop drops.
    const before = await scroller.evaluate((el: HTMLElement) => el.scrollTop)
    await page.getByRole('menuitem').first().click()
    await expect(menu).toHaveCount(0)
    await expect.poll(
      async () => scroller.evaluate((el: HTMLElement) => el.scrollTop),
      { timeout: 5_000 },
    ).toBeLessThan(before)
    // The ticks never went anywhere.
    await expect(ticks).toHaveCount(12)
  })
```

- [ ] **Step 2: Run the tests and verify the intended failures**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts
```

Expected RED: the six new tests fail on `layout.clusters` being `undefined` (`toEqual` receives `undefined`; the direct field/`forEach` assertions fail on the `undefined` value), and the import of `MINIMAP_TICK_MIN_CLICKABLE_PX` fails to resolve. The 16 pre-existing layout tests still pass.

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts
```

Expected RED: the dense-target and menu tests fail with "Unable to find an accessible element with the role 'button' and name 'Prompts 1-4 — open list'"; the lone-tick test fails on the tick button's unexpanded height (3, not 4 — and no inner span). The normal-density no-target test passes vacuously — it is a regression pin, so prove it load-bearing with a bounded, immediately-restored mutation (the Global-Constraints proof for pins):

```bash
# Bounded mutation — make the negative test's subject fail: point it at the
# DENSE fixture, the world it must reject.
#   FreshAgentTranscriptMinimap.test.tsx, 'keeps normal-density clusters on
#   per-tick behavior — no open-list targets':
#   BEFORE: setupScrollableTranscript()
#   AFTER:  setupDenseClusterTranscript()
npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts
# Expected RED (only the mutated test): the dense fixture renders 4 prompt
# ticks — toHaveLength(3) receives 4. The test is wired to a world its
# expectations reject; it is not structurally incapable of failing.
# Restore the fixture call MANUALLY (do NOT git-restore — this file holds
# the task's uncommitted Step-1 tests) and re-run: the file returns to its
# intended RED state. AFTER Step 3 lands the feature, repeat the same swap:
# the failure moves to the open-list queryByRole assertion itself (the
# dense world HAS an '— open list' target) — the load-bearing proof for
# that assertion. Record both observations in the task report.
```

```bash
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
```

Expected RED: the new dense-cluster e2e fails at `await expect(clusterTargets.first()).toBeVisible()` (no open-list button renders). Record the failing output.

- [ ] **Step 3: Add the minimal production implementation**

`src/components/fresh-agent/shared/transcript-minimap-layout.ts` — three changes:

(a) New constant after `MINIMAP_RAIL_BOTTOM_INSET_PX`:

```ts
/** Tick heights at or above this remain individually pointer-clickable;
 *  below it, individual hits are physically unreliable on a 1× display, so
 *  the component layer adds one open-list hit target over each dense
 *  multi-member clickability run and expands a lone sub-4px tick's own hit
 *  height (every per-prompt tick still renders — never dropped or capped). */
export const MINIMAP_TICK_MIN_CLICKABLE_PX = 4
```

New type after `MinimapViewportBand`:

```ts
export type MinimapCluster = {
  /** Rail-space top of the run's first member tick. */
  top: number
  /** Run span, px: last member's bottom minus first member's top. */
  height: number
  /** Inclusive position of the first member tick within layout.ticks. */
  startIndex: number
  /** Inclusive position of the last member tick within layout.ticks. */
  endIndex: number
  /** True when at least one member tick's height is strictly below the
   *  clickable floor: dense multi-member runs get the open-list hit target;
   *  dense singletons (lone sub-4px ticks) get the expanded-hit treatment
   *  in the component. */
  dense: boolean
}
```

(b) `MinimapLayout` gains the field (between `viewport` and `railHeight`):

```ts
export type MinimapLayout = {
  ticks: MinimapTick[]
  viewport: MinimapViewportBand
  /** Clickability runs over the final laid-out ticks — ALL runs, singletons
   *  included (see the second pass at the end of computeMinimapLayout). */
  clusters: MinimapCluster[]
  /** Echoes the input railHeight for consumers (e.g. the tooltip side rule). */
  railHeight: number
}
```

and the degenerate return at the top of `computeMinimapLayout` becomes:

```ts
  if (input.scrollHeight <= 0 || input.railHeight <= 0) {
    return { ticks: [], viewport: { top: 0, height: 0 }, clusters: [], railHeight: 0 }
  }
```

(c) Add the clickability pass AFTER the packing loop — the packing loop itself stays byte-identical to the shipped code (clusters are no longer the packing loop's groups; that design missed both the 30-tick absurd-density case, where one group per tick still forms one clickability run, and the two-50px-tick case, where one packed group is two comfortably-clickable runs). Immediately after the `const ticks = sorted.map(...)` statement, add:

```ts
  // Clickability pass — a SECOND pass over the final laid-out ticks, NOT
  // the packing loop's groups: a cluster is a maximal run of consecutive
  // ticks where each next tick begins within its predecessor's minimum
  // click row (ticks[i + 1].top < ticks[i].top + MINIMAP_TICK_MIN_CLICKABLE_PX).
  // Packed-but-clickable ticks stay separate runs; sub-4px-pitched ticks
  // merge even when the packer kept every proportional top. ALL runs are
  // listed (singletons included); `dense` marks any sub-clickable member.
  const clusters: MinimapCluster[] = []
  for (let k = 0; k < ticks.length; k++) {
    const runStart = k
    while (
      k + 1 < ticks.length &&
      ticks[k + 1].top < ticks[k].top + MINIMAP_TICK_MIN_CLICKABLE_PX
    ) {
      k++
    }
    clusters.push({
      top: ticks[runStart].top,
      height: ticks[k].top + ticks[k].height - ticks[runStart].top,
      startIndex: runStart,
      endIndex: k,
      dense: ticks.slice(runStart, k + 1).some((tick) => tick.height < MINIMAP_TICK_MIN_CLICKABLE_PX),
    })
  }
```

and the return statement becomes:

```ts
  return { ticks, clusters, viewport: { top: bandTop, height: bandHeight }, railHeight: input.railHeight }
```

(`startIndex`/`endIndex` are sorted-array positions; `layout.ticks` is built from `sorted` in that same order, so `layout.ticks.slice(cluster.startIndex, cluster.endIndex + 1)` is exactly the member run.)

`src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx` — four changes on top of the Task-2 file:

(a) Imports: add `useState` to the react import, add `MINIMAP_TICK_MIN_CLICKABLE_PX` to the existing `transcript-minimap-layout` import, and add after the tooltip import:

```tsx
import { ContextMenu } from '@/components/context-menu/ContextMenu'
import type { MenuItem } from '@/components/context-menu/context-menu-types'
```

(b) Menu state, after the `handleTickClick` callback:

```tsx
  const [clusterMenu, setClusterMenu] = useState<{ items: MenuItem[]; position: { x: number; y: number } } | null>(null)
```

(c) Lone-tick lookup — immediately after the `if (!layout) return null` guard:

```tsx
  // Dense-singleton clusters are lone sub-4px ticks: their OWN buttons get
  // the expanded-hit treatment (dense multi-member clusters get the
  // open-list button below instead). Keyed by the member tick's landmark
  // index (tick.index), which is unique across the rail.
  const loneDenseTickIndexes = new Set(
    layout.clusters
      .filter((cluster) => cluster.dense && cluster.startIndex === cluster.endIndex)
      .map((cluster) => layout.ticks[cluster.startIndex].index),
  )
```

(d) Render, two edits inside the rail `<div>`:

First, replace the whole `layout.ticks.map(...)` block with:

```tsx
      {layout.ticks.map((tick) => {
        const firstLine = tick.label.split('\n')[0]
        // LONE sub-4px tick (dense-singleton run member): it never joined a
        // clickability run, so it has >= 4px pitch on both sides — expanding
        // the button's hit height to the clickable floor can never overlap a
        // neighbor (clamped to the rail bottom). The paint moves to an inner
        // aria-hidden span at the tick's visual height; the button keeps its
        // aria-label and jumps DIRECTLY on click (no menu — one tick, one
        // unambiguous target).
        const loneSubFloorTick = loneDenseTickIndexes.has(tick.index)
        const hitHeight = loneSubFloorTick
          ? Math.min(MINIMAP_TICK_MIN_CLICKABLE_PX, layout.railHeight - tick.top)
          : tick.height
        return (
          <Tooltip key={tick.index}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={loneSubFloorTick
                  ? 'fresh-agent-minimap-tick pointer-events-auto absolute left-0 w-full rounded-sm transition-colors hover:bg-primary/15 focus-visible:bg-primary/15'
                  : 'fresh-agent-minimap-tick pointer-events-auto absolute left-0 w-full rounded-sm bg-muted-foreground/40 transition-colors hover:bg-primary focus-visible:bg-primary'}
                style={{ top: tick.top, height: hitHeight }}
                aria-label={`Jump to prompt: ${truncatePrompt(firstLine, ARIA_LABEL_MAX_LENGTH)}`}
                onClick={() => handleTickClick(tick.index)}
              >
                {loneSubFloorTick ? (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-0 top-0 rounded-sm bg-muted-foreground/40"
                    style={{ height: tick.height }}
                  />
                ) : null}
              </button>
            </TooltipTrigger>
            <TooltipContent
              side={tick.top < layout.railHeight * 0.25 ? 'bottom' : 'top'}
              align="end"
              className="max-w-64 whitespace-pre-wrap break-words"
            >
              {truncatePrompt(firstLine, TOOLTIP_MAX_LENGTH)}
            </TooltipContent>
          </Tooltip>
        )
      })}
```

Second, after that block, still inside the rail `<div>` before its close:

```tsx
      {layout.clusters
        .filter((cluster) => cluster.dense && cluster.endIndex > cluster.startIndex)
        .map((cluster) => (
          <button
            key={`cluster-${cluster.startIndex}`}
            type="button"
            className="pointer-events-auto absolute left-0 z-10 w-full rounded-sm bg-transparent transition-colors hover:bg-primary/15 focus-visible:bg-primary/15"
            style={{
              top: cluster.top,
              height: Math.min(
                Math.max(cluster.height, MINIMAP_TICK_MIN_CLICKABLE_PX),
                layout.railHeight - cluster.top,
              ),
            }}
            aria-haspopup="menu"
            aria-label={`Prompts ${cluster.startIndex + 1}-${cluster.endIndex + 1} — open list`}
            onClick={(event) => {
              // Button-rect positioning works for pointer AND keyboard
              // activation (a keyboard click event carries clientX/Y 0).
              const rect = event.currentTarget.getBoundingClientRect()
              const memberTicks = layout.ticks.slice(cluster.startIndex, cluster.endIndex + 1)
              setClusterMenu({
                items: memberTicks.map((tick) => ({
                  type: 'item' as const,
                  id: `cluster-prompt-${tick.index}`,
                  label: truncatePrompt(tick.label.split('\n')[0], ARIA_LABEL_MAX_LENGTH),
                  onSelect: () => handleTickClick(tick.index),
                })),
                position: { x: rect.left, y: rect.top },
              })
            }}
          />
        ))}
      <ContextMenu
        open={clusterMenu !== null}
        items={clusterMenu?.items ?? []}
        position={clusterMenu?.position ?? { x: 0, y: 0 }}
        onClose={() => setClusterMenu(null)}
      />
```

Semantics: the open-list target is transparent and sits above the run (`z-10`), so pointer events over a dense multi-member run route to the open-list button while every tick button remains in the DOM, tab-focusable, and directly Enter/Space-clickable (keyboard/screen-reader access unchanged; tick tab order is untouched because the cluster buttons render after the ticks). A lone sub-4px tick's expanded hit height lives on its OWN button — same DOM position, same aria-label, same tab stop; only the hit box grows (the paint is preserved by the inner span), and by the run rule its 4px box never overlaps a neighbor tick's box. The open-list button's height is the run's span floored at the clickable minimum (`max(cluster.height, 4)`, so even a run of sub-pixel ticks gets a 4px target) and clamped to the rail bounds. `ContextMenu` portals to `document.body` (outside the rail's `pointer-events-none` container) at z-50, closes on Escape/Tab/selection, and its `clampToViewport` handles overflow. If geometry hides the rail mid-interaction, the menu unmounts with it — accepted edge, no dangling state.

- [ ] **Step 4: Run the focused tests**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
```

Expected: PASS — 22 layout tests (16 post-Task-2 pre-existing + the 6 cluster tests), 20 component tests (15 post-Task-1 pre-existing + the Task-2 spy test + the 4 cluster tests), and all 3 e2e tests (2 pre-existing + the dense-cluster test) including the dense-cluster flow with its density guard satisfied.

- [ ] **Step 5: Refactor while green**

No refactor needed. The clickability pass is one self-contained loop over the already-final `ticks` array (the packing loop is untouched); the component adds one state slot, one small lookup set, one conditional in the tick map, and one render block on pre-existing primitives (button, span, ContextMenu).

- [ ] **Step 6: Run impacted-test verification**

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
npm run test:e2e:a11y-gate:deny 2>&1 | grep -c "transcript-minimap" || true   # expect 0 violations naming our spec (gate itself is pre-existing red — Global Constraints)
git grep -n "transcript-minimap" test/e2e-browser/playwright.cloud.config.ts || echo "not skipped"
```

Expected: PASS / clean. A11y: the new button carries a real role + aria-label + aria-haspopup; the lone-tick paint span is aria-hidden (its button keeps the accessible name and role); the menu is the repo's own role="menu"/menuitem primitive; all spec locators stay in the permitted set, and zero gate violations name transcript-minimap.spec.ts. No `docs/index.html` change for this task: the cluster affordances (open-list targets, expanded lone-tick hit heights) are extreme-density-only, not part of the default experience the mock depicts (AGENTS.md's "only major changes" rule).

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/shared/transcript-minimap-layout.ts test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx test/e2e-browser/specs/transcript-minimap.spec.ts
git commit -m "feat(fresh-agent): dense-cluster click-list affordance for minimap ticks"
```

---

### Task 4: "Show transcript minimap" setting (local, default ON)

**Files:**
- Modify: `shared/settings.ts` (5 sites: keys allowlist :97-101, type :229-233, defaults :920-924, seed normalizer :631-645, patch sanitizer :942-956)
- Modify: `src/store/browserPreferencesPersistence.ts` (`buildLocalSettingsPatch` freshAgent block :132-138)
- Modify: `src/components/settings/CodingAgentsSettings.tsx` (new SettingsRow + Toggle in "Fresh agent display"; section description update)
- Modify: `src/components/fresh-agent/FreshAgentView.tsx` (selector after :599; prop at :3029)
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx` (prop type :1016, destructure :1049, conditional render :1390-1394)
- Modify: `docs/index.html` (settings mock row in the "Fresh agent display" block, after the "Expand tools" row ending at :1076)
- Modify: `test/unit/shared/settings.test.ts` (new tests + schema-rejection line + 2 existing full-shape updates)
- Modify: `test/unit/client/store/settingsSlice.test.ts` (new test)
- Modify: `test/unit/client/store/browserPreferencesPersistence.test.ts` (new test)
- Modify: `test/unit/client/components/SettingsView.agent-chat.test.tsx` (new test)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx` (gate test)
- Modify: `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` (consumer flow test)
- Modify: `test/e2e-browser/specs/transcript-minimap.spec.ts` (setting toggle e2e)

**Interfaces:**
- Setting key: `LocalSettings.freshAgent.showTranscriptMinimap: boolean`, default `true`, LOCAL track (same family as `expandThinking`/`expandTools`/`showTimecodes`). Zero Rust/server changes — the server patch schema must continue to REJECT it (the local/server split is load-bearing and pinned). Consequence stated for the recap: the setting does not roam across devices/browsers (same as its siblings today).
- Wiring points (the settings report §4 table, exact locations):
  1. `shared/settings.ts:97-101` `FRESH_AGENT_LOCAL_KEYS` += `'showTranscriptMinimap'`
  2. `shared/settings.ts:229-233` `LocalSettings.freshAgent` type += `showTranscriptMinimap: boolean`
  3. `shared/settings.ts:920-924` `defaultLocalSettings.freshAgent` += `showTranscriptMinimap: true`
  4. `shared/settings.ts:631-645` `normalizeExtractedLocalSeed` freshAgent block += boolean clause
  5. `shared/settings.ts:942-956` `sanitizeFreshAgentLocalSettingsPatchInput` += boolean clause
  6. `src/store/browserPreferencesPersistence.ts:132-138` += `assignChangedScalar(..., 'showTranscriptMinimap')`
  7. Settings UI: new `SettingsRow` in `CodingAgentsSettings.tsx`'s "Fresh agent display" section
  8. Consumer: `FreshAgentView` selector → `FreshAgentTranscript` prop → conditional render at the minimap mount (`FreshAgentTranscript.tsx:1390-1394`)
- Consumer semantics: the `showTimecodes` LIVE-gate pattern (NOT the expandTools mount-time pattern — the suite pins that mount-time defaults apply only on remount, which is wrong for a visibility toggle). The transcript is consumed via its named (non-memo) export by `FreshAgentView` (`FreshAgentView.tsx:90`), so a changed boolean prop re-renders it live.
- Default-ON nuance: the localStorage blob stores only non-default values, so ON writes nothing and OFF writes `false`; every new assertion inverts relative to the default-false siblings.
- Existing-test updates (legitimate shape changes, NOT weakenings — record both in the task report): `test/unit/shared/settings.test.ts:682-686` and `:691-695` assert the full `freshAgent` local shape with `toEqual` and must gain `showTranscriptMinimap: true`. Verified no other full-shape assertion is affected: `browserPreferencesPersistence.test.ts:230` is a dispatch payload (its diff-vs-defaults blob assertion at :236 stays `undefined` because the untouched default-true key writes nothing); `FreshAgentView.test.tsx:715` is a dispatch payload; the e2e `settings.spec.ts:252` blob-drop assertion also stays green for the same reason.

- [ ] **Step 1: Write the failing behavioral tests**

1. `test/unit/shared/settings.test.ts` — extend the existing "rejects representative local-only fields in the server patch schema" test (lines 261-274) with one line after the `showTimecodes` rejection (line 272):

```ts
    expect(schema.safeParse({ freshAgent: { showTranscriptMinimap: true } }).success).toBe(false)
```

   and add new tests (e.g. after "defaults local sort mode to activity"):

```ts
  it('defaults the transcript minimap setting on', () => {
    expect(resolveLocalSettings(undefined).freshAgent.showTranscriptMinimap).toBe(true)
  })

  it('round-trips the transcript minimap setting and drops non-boolean values', () => {
    expect(resolveLocalSettings({ freshAgent: { showTranscriptMinimap: false } }).freshAgent.showTranscriptMinimap).toBe(false)
    expect(resolveLocalSettings({ freshAgent: { showTranscriptMinimap: 'yes' } } as never).freshAgent.showTranscriptMinimap).toBe(true)
  })
```

2. `test/unit/client/store/settingsSlice.test.ts` — new test inside the top-level describe (uses the file's existing `importFreshSettingsSlice` helper, same shape as the :171 test):

```ts
  it('applies the showTranscriptMinimap local setting and defaults it on', async () => {
    const {
      default: settingsReducer,
      updateSettingsLocal,
    } = await importFreshSettingsSlice()

    const initialState = settingsReducer(undefined, { type: 'unknown' })
    expect(initialState.localSettings.freshAgent.showTranscriptMinimap).toBe(true)
    expect(initialState.settings.freshAgent.showTranscriptMinimap).toBe(true)

    const state = settingsReducer(initialState, updateSettingsLocal({
      freshAgent: { showTranscriptMinimap: false },
    }))
    expect(state.localSettings.freshAgent.showTranscriptMinimap).toBe(false)
    expect(state.settings.freshAgent.showTranscriptMinimap).toBe(false)
    // Local patch only: server fields untouched.
    expect(state.serverSettings).toEqual(initialState.serverSettings)
  })
```

3. `test/unit/client/store/browserPreferencesPersistence.test.ts` — new test inside the freshAgent describe:

```ts
  it('persists a showTranscriptMinimap opt-out and drops it back at the default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: false } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    const optedOut = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    // Default-ON key: only the NON-default value appears in the diff-vs-defaults blob.
    expect(optedOut.settings.freshAgent).toEqual({ showTranscriptMinimap: false })

    store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: true } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)
    const restored = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(restored.settings?.freshAgent).toBeUndefined()
  })
```

4. `test/unit/client/components/SettingsView.agent-chat.test.tsx` — new test:

```tsx
  it('toggles the transcript minimap locally, default on, without calling the server', () => {
    const store = createSettingsViewStore()
    renderSettingsView(store)
    switchSettingsTab('Coding Agents')

    const minimapToggle = screen.getByRole('switch', { name: 'Show transcript minimap' })
    // Default ON — the first default-true switch in this family.
    expect(minimapToggle).toHaveAttribute('aria-checked', 'true')
    expect(store.getState().settings.settings.freshAgent.showTranscriptMinimap).toBe(true)

    fireEvent.click(minimapToggle)
    expect(store.getState().settings.settings.freshAgent.showTranscriptMinimap).toBe(false)
    expect(api.patch).not.toHaveBeenCalled()

    fireEvent.click(minimapToggle)
    expect(store.getState().settings.settings.freshAgent.showTranscriptMinimap).toBe(true)
    expect(api.patch).not.toHaveBeenCalled()
  })
```

5. `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx` — gate test (after the "hides the rail when the transcript fits the viewport" test; it proves the SETTING hides the rail under geometry that would otherwise render it, and that the rail's work never starts):

```tsx
  it('hides the rail and its measurement work when showTranscriptMinimap is false', () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} showTranscriptMinimap={false} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockUserTurnRects(userTurns)
    fireEvent.scroll(scroller)

    // The rail is absent under geometry that renders it when the setting is
    // on (this suite's canonical mocks) — the setting, not geometry, hid it.
    expect(screen.queryByRole('group', { name: 'Transcript minimap' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('transcript-minimap-viewport')).not.toBeInTheDocument()
    // "And its work": the unmounted rail registered no ResizeObserver
    // subscriptions (fresh elements cannot have stale entries in the shared
    // per-target callback map).
    for (const el of [scroller, ...Array.from(scroller.children)]) {
      expect(resizeCallbacksByTarget.get(el)).toBeUndefined()
    }
    // The glom chip still works — the shared sweep survives the rail's absence.
    expect(screen.getByRole('button', { name: 'Jump to your message: Second user message here' })).toBeInTheDocument()
  })
```

   (Default-ON rendering is already pinned by the pre-existing tests, which never pass the prop.)

6. `test/unit/client/components/fresh-agent/FreshAgentView.test.tsx` — consumer flow test (add after the "applies a changed expandTools default on remount, not on live re-render" test; mirrors its store/render shape):

```tsx
  it('hides and shows the transcript minimap rail live when the setting changes', async () => {
    const store = createStore()
    apiMock.getFreshAgentThreadSnapshot.mockResolvedValueOnce({
      status: 'idle',
      summary: 'Display summary',
      capabilities: { send: true, interrupt: true, fork: false },
      turns: [
        { id: 'mm-v-u1', turnId: 'mm-v-u1', role: 'user', summary: 'First minimap prompt', items: [{ id: 'mm-v-i1', kind: 'text', text: 'First minimap prompt' }] },
        { id: 'mm-v-a1', turnId: 'mm-v-a1', role: 'assistant', summary: 'r1', items: [{ id: 'mm-v-i2', kind: 'text', text: 'A'.repeat(400) }] },
        { id: 'mm-v-u2', turnId: 'mm-v-u2', role: 'user', summary: 'Second minimap prompt', items: [{ id: 'mm-v-i3', kind: 'text', text: 'Second minimap prompt' }] },
        { id: 'mm-v-a2', turnId: 'mm-v-a2', role: 'assistant', summary: 'r2', items: [{ id: 'mm-v-i4', kind: 'text', text: 'B'.repeat(400) }] },
      ],
    })

    const { container } = render(
      <Provider store={store}>
        <FreshAgentView
          tabId="tab-1"
          paneId="pane-1"
          paneContent={{
            kind: 'fresh-agent', sessionType: 'freshclaude', provider: 'claude',
            createRequestId: 'req-minimap-setting', sessionId: CLAUDE_THREAD_ID, status: 'connected',
          }}
        />
      </Provider>,
    )

    await waitFor(() => {
      expect(screen.getByText('Second minimap prompt')).toBeInTheDocument()
    })

    // Scrollable-geometry mocks (the minimap suite's canonical numbers) so
    // the rail would render under the default-ON setting.
    const scroller = container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => 248 })
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => 1000 })
    scroller.scrollTop = 376
    const userTurns = container.querySelectorAll('[data-turn-role="user"]')
    const mockRect = (el: Element, top: number, height = 50) => {
      el.getBoundingClientRect = () => ({
        top,
        bottom: top + height,
        left: 0,
        right: 800,
        width: 800,
        height,
        x: 0,
        y: top,
        toJSON: () => ({}),
      })
    }
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    mockRect(userTurns[1], 74)
    fireEvent.scroll(scroller)

    // Default ON: the rail renders.
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(2)
    })

    // Flip the setting off through the live store (the reducer path the
    // Settings toggle drives): the transcript re-renders and the rail unmounts.
    act(() => {
      store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: false } }))
    })
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'Transcript minimap' })).not.toBeInTheDocument()

    // Flip back on: the rail returns.
    act(() => {
      store.dispatch(updateSettingsLocal({ freshAgent: { showTranscriptMinimap: true } }))
    })
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(2)
  })
```

7. E2e — `test/e2e-browser/specs/transcript-minimap.spec.ts`. Update the top of the file:

```ts
import { test, expect } from '../helpers/fixtures.js'
import { isCloudLaneWindowConfigured } from '../helpers/test-harness.js'

const PERSIST_DEBOUNCE_WAIT_MS = 600

/** Navigate to the settings view (the sidebar button's title doubles as its
 *  accessible name) — same helper as settings.spec.ts, kept local per the
 *  repo's spec-local-helper convention. */
async function openSettings(page: any) {
  const settingsButton = page.getByRole('button', { name: /settings/i })
  await settingsButton.click()
  await expect(page.getByRole('tab', { name: /^Appearance$/i })).toBeVisible({ timeout: 5_000 })
}
```

   and add the test (unique sessionId `…aa104`) inside the describe:

```ts
  test('the Show transcript minimap setting defaults on and hides the rail when toggled off', async ({ freshellPage: _freshellPage, page, terminal, harness, serverInfo }) => {
    // Two reloads with self-healing connection waits (opted in on the cloud
    // lane); each leg needs the wait's envelope, so declare generously.
    if (isCloudLaneWindowConfigured()) test.setTimeout(240_000)
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa104'
    const seedTurns = () => seedMinimapPane(page, sessionId, [
      { id: 'turn-mm4-u1', turnId: 'turn-mm4-u1', role: 'user', summary: 'Draft the release notes', items: [{ id: 'item-mm4-u1', kind: 'text', text: 'Draft the release notes' }] },
      { id: 'turn-mm4-a1', turnId: 'turn-mm4-a1', role: 'assistant', summary: 'Notes body', items: [{ id: 'item-mm4-a1', kind: 'text', text: tallBody('Notes') }] },
      { id: 'turn-mm4-u2', turnId: 'turn-mm4-u2', role: 'user', summary: 'Now add the upgrade guide', items: [{ id: 'item-mm4-u2', kind: 'text', text: 'Now add the upgrade guide' }] },
      { id: 'turn-mm4-a2', turnId: 'turn-mm4-a2', role: 'assistant', summary: 'Guide body', items: [{ id: 'item-mm4-a2', kind: 'text', text: tallBody('Guide') }] },
      { id: 'turn-mm4-u3', turnId: 'turn-mm4-u3', role: 'user', summary: 'Finally, summarize the risks', items: [{ id: 'item-mm4-u3', kind: 'text', text: 'Finally, summarize the risks' }] },
      { id: 'turn-mm4-a3', turnId: 'turn-mm4-a3', role: 'assistant', summary: 'Risks body', items: [{ id: 'item-mm4-a3', kind: 'text', text: tallBody('Risks') }] },
    ])

    // Default ON: the rail renders with one tick per prompt.
    await seedTurns()
    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane.getByText('Finally, summarize the risks', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(freshPane.getByRole('button', { name: /Jump to prompt:/ })).toHaveCount(3)

    // Toggle the real switch off in Settings → Coding Agents.
    await openSettings(page)
    await page.getByRole('tab', { name: /^Coding Agents$/i }).click()
    const minimapSwitch = page.getByRole('switch', { name: 'Show transcript minimap' })
    await expect(minimapSwitch).toHaveAttribute('aria-checked', 'true')
    await minimapSwitch.click()
    await expect(minimapSwitch).toHaveAttribute('aria-checked', 'false')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const settings = await harness.getSettings()
    expect(settings.freshAgent.showTranscriptMinimap).toBe(false)
    const blob = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blob ?? '{}').settings?.freshAgent?.showTranscriptMinimap).toBe(false)

    // Reload with the persisted OFF blob; the rail stays hidden. Persistence
    // restored the CONVERTED pane — it comes back as a fresh-agent pane, so
    // no terminal exists on this leg: wait for the restored pane itself
    // (the settings.spec.ts reload precedent — harness waits, then assert
    // on the restored UI; never waitForTerminal() here).
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, { selfHealReload: isCloudLaneWindowConfigured() })
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    await seedTurns()
    await expect(freshPane.getByText('Finally, summarize the risks', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(freshPane.getByRole('button', { name: /Jump to prompt:/ })).toHaveCount(0)

    // Toggle the real switch back on; the diff-vs-defaults blob drops the
    // key again (a default-ON key writes nothing when ON).
    await openSettings(page)
    await page.getByRole('tab', { name: /^Coding Agents$/i }).click()
    await minimapSwitch.click()
    await expect(minimapSwitch).toHaveAttribute('aria-checked', 'true')
    await page.waitForTimeout(PERSIST_DEBOUNCE_WAIT_MS)
    const blobOn = await page.evaluate(() => localStorage.getItem('freshell.browser-preferences.v1'))
    expect(JSON.parse(blobOn ?? '{}').settings?.freshAgent).toBeUndefined()

    // Reload once more; the rail is back. Same restored-pane wait — the
    // persisted pane is a fresh-agent pane on this leg too.
    await page.goto(`${serverInfo.baseUrl}/?token=${serverInfo.token}&e2e=1`)
    await harness.waitForHarness()
    await harness.waitForConnection(undefined, { selfHealReload: isCloudLaneWindowConfigured() })
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    await seedTurns()
    await expect(freshPane.getByText('Finally, summarize the risks', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(freshPane.getByRole('button', { name: /Jump to prompt:/ })).toHaveCount(3)
  })
```

- [ ] **Step 2: Run the tests and verify the intended failures**

```bash
npm run test:vitest -- run test/unit/shared/settings.test.ts test/unit/client/store/settingsSlice.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/components/SettingsView.agent-chat.test.tsx --config config/vitest/vitest.config.ts
```

Expected RED (each for its own stated reason):
- settings.test.ts: "defaults the transcript minimap setting on" fails — `resolveLocalSettings(undefined).freshAgent.showTranscriptMinimap` is `undefined`, not `true`. The round-trip assertions fail the same way. The new schema-rejection line: verify the observed result — the strict server schema may already reject the unknown key (then the line is a pin of existing behavior, like the Task-1 tie-break pin; record which occurred) or it may pass (then it is RED until the local key is properly split; either way the final state must be `false`). The pin case needs its Global-Constraints bounded-mutation RED proof — temporarily make the assertion's subject fail:

```bash
# Bounded mutation — temporarily ADMIT the local-only key into the server
# patch schema's freshAgent object (the assertion's subject is "the server
# schema rejects this key"; admitting it must flip the pin to RED):
#   shared/settings.ts, buildServerSettingsPatchSchema, the freshAgent
#   z.object (:818-823) — temporarily ADD after the `enabled` clause (:819):
#     showTranscriptMinimap: z.coerce.boolean().optional(),
npm run test:vitest -- run test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts
# Expected RED (the schema-rejection line): safeParse({ freshAgent:
#   { showTranscriptMinimap: true } }) now SUCCEEDS — expected `false`,
#   received `true`. The pin detects a local/server split regression.
# (The other new settings tests keep their own stated RED.)
git restore shared/settings.ts
npm run test:vitest -- run test/unit/shared/settings.test.ts --config config/vitest/vitest.config.ts
# Expected: the pin passes again (the strict schema rejects the key) and the
# file returns to its intended RED state. Record the round trip.
```
- settingsSlice.test.ts: `initialState.localSettings.freshAgent.showTranscriptMinimap` is `undefined` — both expectations fail.
- browserPreferencesPersistence.test.ts: `optedOut.settings.freshAgent` is `undefined` (the key is never persisted — `buildLocalSettingsPatch` doesn't know it yet).
- SettingsView.agent-chat.test.tsx: "Unable to find an accessible element with the role 'switch' and name 'Show transcript minimap'".

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
```

Expected RED: the transcript gate test fails — the rail renders under canonical geometry because the prop doesn't exist yet (esbuild strips types, so the unknown prop is silently ignored and `queryByRole('group', …)` finds the rail). The FreshAgentView flow test fails at the "flip off" step — the rail still shows 2 ticks. (`npm run typecheck:client` also fails on the unknown prop until Step 3 — expected mid-task; the behavioral RED above is the evidence.)

```bash
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts --grep "Show transcript minimap"'
```

Expected RED: the new e2e fails at `await expect(minimapSwitch).toHaveAttribute('aria-checked', 'true')` (or the locator's click timeout) — no such switch renders in Settings. Note: each in-test reload restores the persisted pane as a fresh-agent pane, so no terminal exists on the reload legs — they wait for the restored pane's visibility, never `terminal.waitForTerminal()` (only the pre-conversion first leg has a terminal). Record the failing output. (Also confirm the `--grep` filter matched exactly 1 test in the output.)

- [ ] **Step 3: Add the minimal production implementation**

`shared/settings.ts` — five edits:

1. `FRESH_AGENT_LOCAL_KEYS` (:97-101):

```ts
const FRESH_AGENT_LOCAL_KEYS = [
  'expandThinking',
  'expandTools',
  'showTimecodes',
  'showTranscriptMinimap',
] as const
```

2. `LocalSettings.freshAgent` type (:229-233):

```ts
  freshAgent: {
    expandThinking: boolean
    expandTools: boolean
    showTimecodes: boolean
    showTranscriptMinimap: boolean
  }
```

3. `defaultLocalSettings.freshAgent` (:920-924):

```ts
  freshAgent: {
    expandThinking: false,
    expandTools: false,
    showTimecodes: false,
    showTranscriptMinimap: true,
  },
```

4. `normalizeExtractedLocalSeed` freshAgent block (:631-645) — add after the `showTimecodes` clause:

```ts
    if (typeof patch.freshAgent.showTranscriptMinimap === 'boolean') {
      freshAgent.showTranscriptMinimap = patch.freshAgent.showTranscriptMinimap as boolean
    }
```

5. `sanitizeFreshAgentLocalSettingsPatchInput` (:942-956) — add after the `showTimecodes` clause:

```ts
  if (typeof rawFreshAgent.showTranscriptMinimap === 'boolean') {
    freshAgent.showTranscriptMinimap = rawFreshAgent.showTranscriptMinimap
  }
```

`src/store/browserPreferencesPersistence.ts` — in `buildLocalSettingsPatch`'s freshAgent block (:132-138), add after the `showTimecodes` line:

```ts
  assignChangedScalar(freshAgent, localSettings.freshAgent, defaultLocalSettings.freshAgent, 'showTranscriptMinimap')
```

`src/components/settings/CodingAgentsSettings.tsx` — in the "Fresh agent display" section: update the description (it currently describes only the two expansion defaults), and add the row after the "Expand tools" `SettingsRow`:

```tsx
      <SettingsSection
        title="Fresh agent display"
        description="Starting expansion of thinking rows and the tool activity line, and whether the transcript minimap rail is shown"
      >
```

```tsx
        <SettingsRow
          label="Show transcript minimap"
          description="The transcript minimap is the prompt-tick rail beside fresh-agent transcripts; turn this off to hide it."
        >
          <Toggle
            checked={settings.freshAgent?.showTranscriptMinimap ?? true}
            onChange={(checked) => {
              applyLocalSetting({ freshAgent: { showTranscriptMinimap: checked } })
            }}
            aria-label="Show transcript minimap"
          />
        </SettingsRow>
```

`src/components/fresh-agent/FreshAgentView.tsx` — two edits. After the `effectiveShowTimecodes` line (:599):

```tsx
  const showTranscriptMinimap = useAppSelector(
    (state) => state.settings.settings.freshAgent?.showTranscriptMinimap
      ?? true,
  )
```

and at the `FreshAgentTranscript` render, after `showTimecodes={effectiveShowTimecodes}` (:3029):

```tsx
                showTranscriptMinimap={showTranscriptMinimap}
```

`src/components/fresh-agent/FreshAgentTranscript.tsx` — three edits. Props type (after `showTimecodes?: boolean` at :1016):

```ts
  /** "Show transcript minimap" (local setting, default on): a LIVE gate —
   *  false unmounts the rail and its measurement work; the glom chip's shared
   *  sweep is unaffected. */
  showTranscriptMinimap?: boolean
```

Destructure (after `showTimecodes,` at :1049):

```ts
  showTranscriptMinimap = true,
```

Minimap render block (:1390-1394, the Task-2 shape) becomes:

```tsx
      {showTranscriptMinimap ? (
        <FreshAgentTranscriptMinimap
          scrollerRef={scrollerRef}
          measurement={transcriptMeasurement}
          onRemeasure={sweepTranscript}
          transcriptSignature={transcriptSignature}
        />
      ) : null}
```

`docs/index.html` — in the "Fresh agent display" settings mock section, add a third row after the "Expand tools" row (whose `settings-row` div closes at line 1076), before the closing `</div>` of `settings-list`:

```html
                <div class="settings-row">
                  <div class="settings-label"><div class="settings-label-title">Show transcript minimap</div><div class="settings-label-desc">The transcript minimap is the prompt-tick rail beside fresh-agent transcripts; turn this off to hide it.</div></div>
                  <div class="settings-control settings-switch-wrap">
                    <button class="settings-switch on" type="button" role="switch" aria-checked="true" aria-label="Show transcript minimap"></button>
                  </div>
                </div>
```

(`class="settings-switch on"` + `aria-checked="true"` mirror the mock's default-ON switch convention at docs/index.html:1058.)

- [ ] **Step 4: Run the focused tests**

```bash
npm run test:vitest -- run test/unit/shared/settings.test.ts test/unit/client/store/settingsSlice.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
```

Expected: PASS — all new tests green; the two updated full-shape assertions in settings.test.ts (now including `showTranscriptMinimap: true`) green; every pre-existing fresh-agent test green; the full e2e spec (all 4 tests — 3 post-Task-3 + the setting test with its two reload legs) green on the cloud backend.

- [ ] **Step 5: Refactor while green**

No refactor needed. The wiring is the family's established 8-point pattern copied key-for-key; the consumer gate is three lines (selector, prop, conditional); the tests mirror existing precedents file-for-file. Nothing is duplicated beyond what the settings architecture itself prescribes (each sanitizer clause is intentionally explicit per the repo's allowlist style).

- [ ] **Step 6: Run impacted-test verification**

```bash
npm run test:vitest -- run test/unit/shared/ test/unit/client/store/ test/unit/client/components/fresh-agent/ test/unit/client/components/SettingsView.agent-chat.test.tsx --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
npm run test:e2e:a11y-gate:deny 2>&1 | grep -c "transcript-minimap" || true   # expect 0 violations naming our spec (gate itself is pre-existing red — Global Constraints)
git grep -n "transcript-minimap" test/e2e-browser/playwright.cloud.config.ts || echo "not skipped"
grep -c 'Show transcript minimap' docs/index.html   # expect 2 (label title, aria-label)
```

Expected: PASS / clean, with zero a11y-gate violations naming transcript-minimap.spec.ts (the gate itself stays pre-existing red). The broader unit sweep (all of `test/unit/shared/` + `test/unit/client/store/`) catches any other consumer of the freshAgent local shape the plan's scan may have missed — if any fails on the new key, fix the assertion by adding `showTranscriptMinimap` to its expected shape only if the test asserts defaults; never delete the assertion (record any such edit in the task report).

- [ ] **Step 7: Commit the task**

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts src/components/settings/CodingAgentsSettings.tsx src/components/fresh-agent/FreshAgentView.tsx src/components/fresh-agent/FreshAgentTranscript.tsx docs/index.html test/unit/shared/settings.test.ts test/unit/client/store/settingsSlice.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts test/unit/client/components/SettingsView.agent-chat.test.tsx test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx test/unit/client/components/fresh-agent/FreshAgentView.test.tsx test/e2e-browser/specs/transcript-minimap.spec.ts
git commit -m "feat(fresh-agent): add Show transcript minimap setting (default on)"
```

---

## Recorded residuals (carry into the recap verbatim)

1. **Extreme-density physical limits** (accepted by the User Request): cluster-member ticks remain visually sub-4px — the one-tick-per-prompt contract forbids merging their paint; their pointer path is the cluster's open-list menu. A LONE sub-4px tick is directly clickable via its button's expanded 4px hit height (a one-item menu would add nothing — the tick itself is the affordance). Keyboard/screen-reader access to every individual tick is unchanged.
2. **Stale measurement while the rail is unmounted**: with the setting OFF, a content-only resize (disclosure toggle) leaves the stored shared measurement stale until the next scroll/signature trigger; when the rail remounts, real browsers self-heal within a frame (ResizeObserver fires on initial observe). (The fits-viewport-hidden mode is NOT stale: the component stays mounted with live observers there, so content-only resizes still re-sweep.) The glom chip — the only consumer live at that moment — does not depend on article-resize freshness.
3. **Local-only setting**: `showTranscriptMinimap` persists per-browser (localStorage diff-vs-defaults blob) and does not roam across devices — identical to its `expandThinking`/`expandTools`/`showTimecodes` siblings. The server track exists (settings report §3) if roaming is ever wanted; it is out of scope here.
4. **Mount-cost note**: the initial transcript mount runs the shared sweep once (parent signature effect). The one-sweep guarantee covers the scroll trigger; the rail's own ResizeObserver subscriptions still deliver an initial callback on observe/remount (ResizeObserver fires on initial observe), so a rail (re)mount can request one bounded extra sweep — mount-time only, it does not reintroduce per-scroll double-sweeping. Per-SCROLL cost is the finding's subject and is exactly one sweep.

## Convergence checklist (for the recap)

- Delta Finding 1 (extreme-density clickability) → CLEARED by Task 3 (second-pass clickability runs: open-list affordance over dense multi-member runs, expanded hit heights on lone sub-4px ticks; one-tick-per-prompt preserved; residual physical limits documented above).
- Delta Finding 2 / whole-branch Nit 1 (doubled per-scroll scan) → CLEARED by Task 2 (one sweep per scroll, proven by the spy test; glom behavior and its tests unchanged).
- Delta Finding 3 (tooltip word-break) → CLEARED by Task 1 (class + unit pin + e2e text-range assertion).
- Task-001 Nit 1 (`let heights`) → CLEARED by Task 1 (`const`).
- Task-002 Nit 1 (redundant defensive disconnect) → CLEARED by Task 1 (line removed; superseded structurally by Task 2's cleanup-only observer lifecycle).
- Task-001 Nit 2 (unpinned tie-break) → CLEARED by Task 1 (pinning test with bounded-mutation RED proof).
- New setting → Task 4 (default ON, 8 wiring points, live gate, "and its work" proven by unmount semantics + the no-observer-registration assertion; unit + e2e coverage; docs mock updated).
