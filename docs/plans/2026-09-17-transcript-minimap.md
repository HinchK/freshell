# Transcript Minimap Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
Build and implement a ChatGPT-style scroll minimap for Freshell's fresh-agent transcript panes: a narrow rail beside the transcript scroll area with one tick per user-prompt turn, ticks positioned proportionally to transcript length, a hover preview of each prompt, click-to-jump navigation, and an indicator of the currently visible region.

### Explicit constraints
- Run the work through "the usual" workflow (dedicated worktree, plan, load-bearing validation, Fresh Eyes reviews, TDD execution, recap).
- Integrate with the existing fresh-agent transcript (`src/components/fresh-agent/FreshAgentTranscript.tsx`), reusing its existing `data-turn-role`/`data-turn-index` turn landmarks.
- Hover previews use the existing tooltip component (`src/components/ui/tooltip.tsx`).
- Ticks must be real `<button>` elements with aria-labels, per the repo's accessibility rules.
- Follow the repo's Red-Green-Refactor TDD rules with unit and e2e coverage.

### Accepted tradeoffs and residuals
- No drop-in library exists for this control; it will be a small custom React component.

**Goal:** Fresh-agent transcript panes gain a narrow rail at the right edge of the scroll area showing one clickable tick per user prompt (positioned proportionally to transcript length), a hover/focus tooltip previewing the prompt, click-to-jump navigation, and a band marking the currently visible region.

**Architecture:** A pure geometry module (`computeMinimapLayout`) maps measured turn landmarks onto rail coordinates. A new `FreshAgentTranscriptMinimap` component mounts as an absolutely positioned overlay sibling of the scroller inside `FreshAgentTranscript`'s existing `relative` wrapper (the established glom-chip/scroll-to-bottom mounting pattern), measures `[data-turn-role="user"]` articles against the scroller, and jumps via `scrollIntoView({ block: 'start' })` — reusing the glom chip's exact query/jump pattern so no new scroll machinery is needed and stick-to-bottom disengages naturally via the existing `onScroll` handler.

**Tech Stack:** React 18 + TypeScript (client), Tailwind CSS classes, existing hand-rolled `Tooltip` (`src/components/ui/tooltip.tsx`), Vitest + Testing Library (jsdom) for unit tests, Playwright (cloud backend) for e2e.

## Global Constraints

- **TDD:** Red-Green-Refactor per task. Every test fails first for the stated reason and passes after the shown implementation. Never skip the refactor step (state explicitly when none is needed).
- **Worktree:** All work happens in the coordinator-provided worktree (`.worktrees/transcript-minimap`), on the feature branch. Run every command from that directory. Do not commit or push to `main`; do not open a PR (the coordinator asks the user).
- **A11y:** Ticks are real `<button type="button">` elements with `aria-label`s. `npm run lint` (eslint-plugin-jsx-a11y) must stay clean — it is a CI gate.
- **No IntersectionObserver** — it is neither used nor stubbed anywhere in this repo. The visible-region band is computed from `scrollTop`/`scrollHeight`/`clientHeight` instead.
- **jsdom geometry:** jsdom has no layout. Tests mock `clientHeight`/`scrollHeight` with `Object.defineProperty` getters, set `scrollTop` directly, replace `getBoundingClientRect` per element, and assign `el.scrollIntoView = vi.fn()` per element. `ResizeObserver` is globally stubbed as a no-op (`test/setup/dom.ts:46-54`). Any unexpected `console.error` fails the test (`test/setup/dom.ts:127-144`) — no React key warnings, no act() warnings. For that reason the minimap's scroll/resize handling is **synchronous, not rAF-throttled**: a rAF callback would land `setState` outside `fireEvent`'s act() wrapper and fail the suite, and the work is the same order as the transcript's existing per-scroll `recomputeGlom`.
- **Focused test command shape** (repo-owned passthrough; raw `npx vitest` is not a coordinated workflow):
  `npm run test:vitest -- run <path> --config config/vitest/vitest.config.ts`
- **E2E backend:** `FRESHELL_E2E_BACKEND=cloud` is set in `~/.bashrc`; run e2e through `bash -lc 'npm run test:e2e:cloud -- --project=chromium <spec>'`. Never silently fall back to a local backend.
- **Path aliases:** `@/` → `src/`, `@shared/` → `shared/`, `@test/` → `test/`.
- **Minimal diffs:** The only edit to `FreshAgentTranscript.tsx` is one import plus one render block. No changes to files outside each task's Files list. If an existing test breaks because the rail legitimately renders under its mocked geometry, prefer the plan's stated fix; do not weaken assertions.
- **Process safety:** never restart the self-hosted server on port 3001; no broad kills; no `git push` / PR without explicit user approval.
- **Broad validation before PR** (coordinator's recap phase, not a plan task): `FRESHELL_TEST_SUMMARY="transcript-minimap" npm test`.

---

### Task 1: Pure minimap layout math module

**Files:**
- Create: `src/components/fresh-agent/shared/transcript-minimap-layout.ts`
- Test: `test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts`

**Interfaces:**
- Consumes: nothing (new pure module).
- Produces:
  - `MINIMAP_MIN_TICK_HEIGHT_PX: number` (= 3)
  - `MINIMAP_MIN_TICK_GAP_PX: number` (= 2)
  - `MINIMAP_RAIL_BOTTOM_INSET_PX: number` (= 48 — clears the serif/mono bottom-right scroll-to-bottom button, `src/index.css:761-771,1290-1301`, in every pane style)
  - `type MinimapLandmark = { index: number; offsetTop: number; height: number; label: string }`
  - `type MinimapTick = { index: number; label: string; top: number; height: number }`
  - `type MinimapViewportBand = { top: number; height: number }`
  - `type MinimapLayout = { ticks: MinimapTick[]; viewport: MinimapViewportBand }`
  - `computeMinimapLayout(input: { scrollHeight: number; viewportHeight: number; scrollTop: number; railHeight: number; landmarks: readonly MinimapLandmark[] }): MinimapLayout`
- Semantics (all pinned by tests below): ticks scale by `railHeight / scrollHeight`; tick height clamped to `[MINIMAP_MIN_TICK_HEIGHT_PX, railHeight]`; tick top clamped to `[0, railHeight - height]`; collision rule is deterministic — iterate landmarks sorted by `offsetTop` (ties by `index`), drop a landmark when its top is `< lastKept.top + lastKept.height + MINIMAP_MIN_TICK_GAP_PX` (the EARLIER prompt wins; comparison is against the last KEPT tick so a dropped tick never shadows a later one); the viewport band height is `min(railHeight, max(MIN_TICK, viewportHeight * scale))` and its top maps the clamped scroll fraction `scrollTop / (scrollHeight - viewportHeight)` onto `[0, railHeight - bandHeight]` so the band reaches exactly the rail bottom at max scroll; degenerate inputs (`scrollHeight <= 0` or `railHeight <= 0`) return `{ ticks: [], viewport: { top: 0, height: 0 } }`.

- [ ] **Step 1: Write the failing behavioral test**

```ts
import { describe, expect, it } from 'vitest'
import {
  computeMinimapLayout,
  MINIMAP_MIN_TICK_HEIGHT_PX,
  type MinimapLandmark,
} from '@/components/fresh-agent/shared/transcript-minimap-layout'

function landmark(index: number, offsetTop: number, height = 100): MinimapLandmark {
  return { index, offsetTop, height, label: `Prompt ${index}` }
}

describe('computeMinimapLayout', () => {
  it('maps landmarks to proportional tick positions within the rail', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(2, 1000), landmark(4, 1900)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 2, 4])
    expect(layout.ticks[0].top).toBeCloseTo(0, 5)
    expect(layout.ticks[1].top).toBeCloseTo(50, 5)
    expect(layout.ticks[2].top).toBeCloseTo(95, 5)
    expect(layout.ticks[1].height).toBeCloseTo(5, 5)
    expect(layout.ticks[1].label).toBe('Prompt 2')
  })

  it('enforces the minimum tick height for tiny turns', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 10)], // 10 * 0.05 = 0.5px -> clamped to the minimum
    })
    expect(layout.ticks[0].height).toBe(MINIMAP_MIN_TICK_HEIGHT_PX)
  })

  it('drops a later tick that collides with an earlier kept tick (earlier prompt wins)', () => {
    // scale 0.01, heights clamp to 3: raw tops 0, 1, 5. The tick at top 1
    // collides (1 < 0+3+2) and is dropped; the tick at top 5 fits
    // (5 >= 0+3+2) — proving comparison is against the last KEPT tick, not
    // the dropped one (against top 1 the rule would be 5 < 1+3+2=6, dropped).
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(1, 100), landmark(2, 500)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 2])
  })

  it('sorts unsorted landmarks by offsetTop (ties by index)', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(4, 1000), landmark(0, 0)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 4])
    expect(layout.ticks[0].top).toBeCloseTo(0, 5)
    expect(layout.ticks[1].top).toBeCloseTo(50, 5)
  })

  it('keeps a single landmark', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(2, 1000)],
    })
    expect(layout.ticks).toHaveLength(1)
    expect(layout.ticks[0].top).toBeCloseTo(50, 5)
  })

  it('clamps a landmark that would overflow the rail bottom', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(6, 2100)], // 2100 * 0.05 = 105 -> clamped to 100 - 5 = 95
    })
    expect(layout.ticks[0].top).toBeCloseTo(95, 5)
  })

  it('returns no ticks for empty landmarks but still reports the viewport band', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 1000, viewportHeight: 200, scrollTop: 400, railHeight: 100,
      landmarks: [],
    })
    expect(layout.ticks).toEqual([])
    expect(layout.viewport.top).toBeCloseTo(40, 5)
    expect(layout.viewport.height).toBeCloseTo(20, 5)
  })

  it('returns empty geometry for degenerate inputs', () => {
    for (const input of [
      { scrollHeight: 0, viewportHeight: 200, scrollTop: 0, railHeight: 100 },
      { scrollHeight: 1000, viewportHeight: 200, scrollTop: 0, railHeight: 0 },
    ]) {
      const layout = computeMinimapLayout({ ...input, landmarks: [landmark(0, 0)] })
      expect(layout.ticks).toEqual([])
      expect(layout.viewport).toEqual({ top: 0, height: 0 })
    }
  })

  it('maps the band to the scroll fraction: top at 0, bottom at max scroll', () => {
    const base = { scrollHeight: 1000, viewportHeight: 200, railHeight: 100, landmarks: [] as MinimapLandmark[] }
    expect(computeMinimapLayout({ ...base, scrollTop: 0 }).viewport.top).toBeCloseTo(0, 5)
    expect(computeMinimapLayout({ ...base, scrollTop: 400 }).viewport.top).toBeCloseTo(40, 5)
    expect(computeMinimapLayout({ ...base, scrollTop: 800 }).viewport.top).toBeCloseTo(80, 5)
  })

  it('clamps out-of-range scrollTop into the band travel', () => {
    const base = { scrollHeight: 1000, viewportHeight: 200, railHeight: 100, landmarks: [] as MinimapLandmark[] }
    expect(computeMinimapLayout({ ...base, scrollTop: -50 }).viewport.top).toBeCloseTo(0, 5)
    expect(computeMinimapLayout({ ...base, scrollTop: 9999 }).viewport.top).toBeCloseTo(80, 5)
  })

  it('spans the full rail with the band when content fits the viewport', () => {
    // scrollHeight < viewportHeight: scale > 1, band height clamps to the
    // whole rail and the scroll fraction is pinned at 0. (The component hides
    // the rail in this state; the pure function still behaves sanely.)
    const layout = computeMinimapLayout({
      scrollHeight: 150, viewportHeight: 200, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 150)],
    })
    expect(layout.viewport).toEqual({ top: 0, height: 100 })
    expect(layout.ticks[0].top).toBeCloseTo(0, 5)
    expect(layout.ticks[0].height).toBeCloseTo(100, 5)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts`

Expected: FAIL because the module `@/components/fresh-agent/shared/transcript-minimap-layout` does not exist yet (import resolution error — the standard red state for a new module).

- [ ] **Step 3: Add the minimal production implementation**

```ts
// src/components/fresh-agent/shared/transcript-minimap-layout.ts
//
// Pure geometry for the fresh-agent transcript minimap rail: maps measured
// user-turn landmarks (content coordinates) onto tick rects inside the rail,
// plus the band marking the currently visible region. Kept free of DOM and
// React so it is exhaustively unit-testable without jsdom geometry mocks.

/** Minimum rendered tick height, px — keeps every prompt clickable. */
export const MINIMAP_MIN_TICK_HEIGHT_PX = 3
/** Minimum vertical gap between adjacent kept ticks, px. */
export const MINIMAP_MIN_TICK_GAP_PX = 2
/** Rail bottom inset, px. Clears the serif/mono bottom-right scroll-to-bottom
 * button (`src/index.css` `.fresh-agent-scroll-bottom` overrides) in every
 * pane style with one code path — in the default sans style the button is
 * bottom-centered and never overlaps the right edge anyway. */
export const MINIMAP_RAIL_BOTTOM_INSET_PX = 48

export type MinimapLandmark = {
  /** Index into the transcript's displayTurns (the article's data-turn-index). */
  index: number
  /** Distance from the top of the scrollable content, px. */
  offsetTop: number
  /** Rendered height of the turn article, px. */
  height: number
  /** Prompt preview text (turnPlainText of the user turn). */
  label: string
}

export type MinimapTick = {
  index: number
  label: string
  /** Distance from the rail top, px. */
  top: number
  /** Tick height, px (>= MINIMAP_MIN_TICK_HEIGHT_PX). */
  height: number
}

export type MinimapViewportBand = {
  top: number
  height: number
}

export type MinimapLayout = {
  ticks: MinimapTick[]
  viewport: MinimapViewportBand
}

export function computeMinimapLayout(input: {
  scrollHeight: number
  viewportHeight: number
  scrollTop: number
  railHeight: number
  landmarks: readonly MinimapLandmark[]
}): MinimapLayout {
  if (input.scrollHeight <= 0 || input.railHeight <= 0) {
    return { ticks: [], viewport: { top: 0, height: 0 } }
  }
  const scale = input.railHeight / input.scrollHeight

  const sorted = [...input.landmarks].sort((a, b) => a.offsetTop - b.offsetTop || a.index - b.index)
  const ticks: MinimapTick[] = []
  for (const mark of sorted) {
    const height = Math.min(
      input.railHeight,
      Math.max(MINIMAP_MIN_TICK_HEIGHT_PX, mark.height * scale),
    )
    const top = Math.min(
      Math.max(0, mark.offsetTop * scale),
      input.railHeight - height,
    )
    const previous = ticks[ticks.length - 1]
    // Deterministic collision rule: the EARLIER prompt wins; the later tick is
    // dropped. Comparison is against the last KEPT tick, so a dropped tick
    // never shadows a later landmark that would have fit.
    if (previous && top < previous.top + previous.height + MINIMAP_MIN_TICK_GAP_PX) continue
    ticks.push({ index: mark.index, label: mark.label, top, height })
  }

  const bandHeight = Math.min(
    input.railHeight,
    Math.max(MINIMAP_MIN_TICK_HEIGHT_PX, input.viewportHeight * scale),
  )
  const maxScroll = Math.max(0, input.scrollHeight - input.viewportHeight)
  const clampedScrollTop = Math.min(Math.max(input.scrollTop, 0), maxScroll)
  const fraction = maxScroll > 0 ? clampedScrollTop / maxScroll : 0
  const bandTop = fraction * (input.railHeight - bandHeight)

  return { ticks, viewport: { top: bandTop, height: bandHeight } }
}
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed: the module is a single small pure function with named exported constants; there is no duplication to extract and no consumer yet whose usage could inform a better shape. (Task 2 is the consumer; any reshaping happens there with both sides green.)

- [ ] **Step 6: Run impacted-test verification**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts --config config/vitest/vitest.config.ts`

Expected: PASS (new module with no other consumers; nothing else is impacted)

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/shared/transcript-minimap-layout.ts test/unit/client/components/fresh-agent/transcript-minimap-layout.test.ts
git commit -m "feat(fresh-agent): add pure transcript minimap layout math"
```

---

### Task 2: `TranscriptMinimap` component + integration into `FreshAgentTranscript`

**Files:**
- Create: `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx`
- Modify: `src/components/fresh-agent/FreshAgentTranscript.tsx:23` (add import after the `FreshAgentActionSheet` import) and `src/components/fresh-agent/FreshAgentTranscript.tsx:1388` (render block before the wrapper's closing `</div>`)
- Test: `test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx`

**Interfaces:**
- Consumes (from Task 1): `computeMinimapLayout`, `MINIMAP_RAIL_BOTTOM_INSET_PX`, `MinimapLandmark`, `MinimapLayout`.
- Consumes (existing): `turnPlainText(turn: FreshAgentTurn): string` from `src/components/fresh-agent/FreshAgentTurnActions.tsx:8-15`; `Tooltip`/`TooltipTrigger`/`TooltipContent` from `src/components/ui/tooltip.tsx` (opens on hover AND focus, portals `role="tooltip"` to `document.body`, `side` supports only `top`/`bottom`); the transcript's `scrollerRef` (`FreshAgentTranscript.tsx:1061`), `displayTurns` (:1097-1099), `transcriptSignature` (:1108-1129); turn landmarks `data-turn-role`/`data-turn-index` (:886-890).
- Produces (the DOM contract Task 3's e2e relies on):
  - `FreshAgentTranscriptMinimap(props: { scrollerRef: { current: HTMLDivElement | null }; displayTurns: FreshAgentTurn[]; transcriptSignature: string }): JSX.Element | null`
  - Tick buttons: `<button type="button" aria-label="Jump to prompt: <first line, truncated to 60 chars with …>">`, absolutely positioned via inline `style={{ top, height }}`.
  - Visible-region band: `<div data-testid="transcript-minimap-viewport" aria-hidden="true">` with inline `top`/`height`.
  - Rail container: `<div class="fresh-agent-minimap …" role="group" aria-label="Transcript minimap">`.
  - Visibility gate: the rail renders `null` when there are fewer than 2 user-turn landmarks with text, when `scrollHeight <= clientHeight` (content fits the viewport), or when the scroller is missing/zero-sized.
- Measurement math (exact): for each `[data-turn-role="user"]` article inside the scroller, `index = Number(el.getAttribute('data-turn-index'))` (skip missing/NaN), `turn = displayTurns[index]` (skip missing), `label = turnPlainText(turn)` (skip empty), `rect = el.getBoundingClientRect()`, `offsetTop = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop`, `height = rect.height`. `railHeight = scroller.clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX`.
- Recompute triggers: an effect keyed on `transcriptSignature` (mirrors the glom chip's effect at `FreshAgentTranscript.tsx:1241-1243`), plus a native `scroll` listener and a `ResizeObserver` on the scroller installed in a mount effect (guarded `typeof ResizeObserver !== 'undefined'`; the jsdom global stub makes this a no-op in tests). Both listeners call the recompute **synchronously** — see Global Constraints for why this is not rAF-throttled.
- Click behavior: `scroller.querySelector('[data-turn-index="${index}"]')?.scrollIntoView?.({ block: 'start' })` — optional-call tolerance for jsdom, mirroring `handleGlomClick` (`FreshAgentTranscript.tsx:1156-1162`). The resulting scroll event flips `atBottom` false via the existing `onScroll` handler, so stick-to-bottom disengages with no fight.
- Tooltip: `side="top" align="end"` (only top/bottom exist), content is the prompt's first line truncated to 120 chars with `…`; aria-label truncates the same first line to 60 chars.

- [ ] **Step 1: Write the failing behavioral test**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { FreshAgentTranscript } from '@/components/fresh-agent/FreshAgentTranscript'

// Render markdown bodies synchronously — the same LazyMarkdown mock the
// transcript's own suite uses, so assertions never race the Suspense chunk.
vi.mock('@/components/markdown/LazyMarkdown', async () => {
  const { MarkdownRenderer } = await import('@/components/markdown/MarkdownRenderer')
  return {
    LazyMarkdown: ({ content }: { content: string }) => (
      <MarkdownRenderer content={content} />
    ),
  }
})

// Canonical geometry for this suite (see transcript-minimap-layout.ts):
//   scrollTop=376, scrollHeight=1000, clientHeight=248
//   railHeight = 248 - 48 (MINIMAP_RAIL_BOTTOM_INSET_PX) = 200, scale = 0.2
//   user-turn content offsets 0 / 300 / 450 -> tick tops 0 / 60 / 90, heights ~10
//   band: height = 248 * 0.2 = 49.6, top = 0.5 * (200 - 49.6) = 75.2
const SCROLL_TOP = 376
const SCROLL_HEIGHT = 1000
const CLIENT_HEIGHT = 248

const TRANSCRIPT = [
  {
    id: 'u1',
    role: 'user' as const,
    summary: 'First user message here',
    items: [{ id: 'i1', kind: 'text' as const, text: 'First user message here' }],
  },
  {
    id: 'a1',
    role: 'assistant' as const,
    summary: 'reply 1',
    items: [{ id: 'i2', kind: 'text' as const, text: 'A'.repeat(200) }],
  },
  {
    id: 'u2',
    role: 'user' as const,
    summary: 'Second user message here',
    items: [{ id: 'i3', kind: 'text' as const, text: 'Second user message here' }],
  },
  {
    id: 'a2',
    role: 'assistant' as const,
    summary: 'reply 2',
    items: [{ id: 'i4', kind: 'text' as const, text: 'B'.repeat(200) }],
  },
  {
    id: 'u3',
    role: 'user' as const,
    summary: 'Third user message here',
    items: [{ id: 'i5', kind: 'text' as const, text: 'Third user message here' }],
  },
  {
    id: 'a3',
    role: 'assistant' as const,
    summary: 'reply 3',
    items: [{ id: 'i6', kind: 'text' as const, text: 'C'.repeat(200) }],
  },
]

function mockScroll(scroller: HTMLElement, scrollTop: number, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(scroller, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(scroller, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  scroller.scrollTop = scrollTop
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

/** Rects consistent with SCROLL_TOP=376: content offsets 0 / 300 / 450. */
function mockUserTurnRects(userTurns: NodeListOf<Element> | Element[]) {
  mockRect(userTurns[0], -376)
  mockRect(userTurns[1], -76)
  mockRect(userTurns[2], 74)
}

function setupScrollableTranscript(turns = TRANSCRIPT) {
  const utils = render(<FreshAgentTranscript turns={turns} />)
  const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
  mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
  const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
  mockRect(scroller, 0)
  mockUserTurnRects(userTurns)
  // The minimap's synchronous scroll listener recomputes landmark geometry.
  fireEvent.scroll(scroller)
  return { ...utils, scroller, userTurns }
}

const topOf = (el: HTMLElement) => parseFloat(el.style.top)
const heightOf = (el: HTMLElement) => parseFloat(el.style.height)

describe('FreshAgentTranscript minimap rail', () => {
  afterEach(() => cleanup())

  it('renders one tick per user turn, positioned proportionally to transcript length', () => {
    setupScrollableTranscript()

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(3)
    expect(ticks[0]).toHaveAttribute('aria-label', 'Jump to prompt: First user message here')
    expect(ticks[1]).toHaveAttribute('aria-label', 'Jump to prompt: Second user message here')
    expect(ticks[2]).toHaveAttribute('aria-label', 'Jump to prompt: Third user message here')
    expect(topOf(ticks[0])).toBeCloseTo(0, 5)
    expect(topOf(ticks[1])).toBeCloseTo(60, 5)
    expect(topOf(ticks[2])).toBeCloseTo(90, 5)
    expect(heightOf(ticks[0])).toBeCloseTo(10, 5)
  })

  it('renders the visible-region band at the proportional scroll position', () => {
    setupScrollableTranscript()

    const band = screen.getByTestId('transcript-minimap-viewport')
    expect(band).toHaveAttribute('aria-hidden', 'true')
    expect(topOf(band)).toBeCloseTo(75.2, 5)
    expect(heightOf(band)).toBeCloseTo(49.6, 5)
  })

  it('moves the visible-region band when the scroller scrolls', () => {
    const { scroller, userTurns } = setupScrollableTranscript()
    expect(topOf(screen.getByTestId('transcript-minimap-viewport'))).toBeCloseTo(75.2, 5)

    // Scroll to the very top; re-mock rects consistently (offsets 0/300/450
    // relative to scrollTop 0).
    mockScroll(scroller, 0, SCROLL_HEIGHT, CLIENT_HEIGHT)
    mockRect(scroller, 0)
    mockRect(userTurns[0], 0)
    mockRect(userTurns[1], 300)
    mockRect(userTurns[2], 450)
    fireEvent.scroll(scroller)

    expect(topOf(screen.getByTestId('transcript-minimap-viewport'))).toBeCloseTo(0, 5)
  })

  it('clicking a tick scrolls that prompt into view', () => {
    const { userTurns } = setupScrollableTranscript()
    const scrollIntoViewSpy = vi.fn()
    userTurns[1].scrollIntoView = scrollIntoViewSpy

    fireEvent.click(screen.getByRole('button', { name: 'Jump to prompt: Second user message here' }))

    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: 'start' })
  })

  it('previews the prompt in a tooltip on hover and on focus', () => {
    setupScrollableTranscript()
    const tick = screen.getByRole('button', { name: 'Jump to prompt: Second user message here' })

    fireEvent.mouseEnter(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Second user message here')
    fireEvent.mouseLeave(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()

    // Keyboard parity: the tooltip component also opens on focus.
    fireEvent.focus(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent('Second user message here')
    fireEvent.blur(tick)
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  })

  it('truncates long prompts in the aria-label (60) and tooltip (120)', () => {
    const longPrompt = 'A'.repeat(130)
    const turns = [
      { id: 'u1', role: 'user' as const, summary: longPrompt, items: [{ id: 'i1', kind: 'text' as const, text: longPrompt }] },
      { id: 'a1', role: 'assistant' as const, summary: 'reply 1', items: [{ id: 'i2', kind: 'text' as const, text: 'B'.repeat(200) }] },
      { id: 'u2', role: 'user' as const, summary: 'Short second prompt', items: [{ id: 'i3', kind: 'text' as const, text: 'Short second prompt' }] },
    ]
    const utils = render(<FreshAgentTranscript turns={turns} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    mockRect(userTurns[1], 74)
    fireEvent.scroll(scroller)

    const tick = screen.getByRole('button', { name: `Jump to prompt: ${'A'.repeat(59)}…` })
    expect(tick).toHaveAttribute('aria-label', `Jump to prompt: ${'A'.repeat(59)}…`)
    fireEvent.mouseEnter(tick)
    expect(screen.getByRole('tooltip')).toHaveTextContent(`${'A'.repeat(119)}…`)
  })

  it('recomputes ticks when the transcript grows', () => {
    const utils = setupScrollableTranscript()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    const grown = [
      ...TRANSCRIPT,
      { id: 'u4', role: 'user' as const, summary: 'Fourth user message here', items: [{ id: 'i7', kind: 'text' as const, text: 'Fourth user message here' }] },
      { id: 'a4', role: 'assistant' as const, summary: 'reply 4', items: [{ id: 'i8', kind: 'text' as const, text: 'D'.repeat(200) }] },
    ]
    utils.rerender(<FreshAgentTranscript turns={grown} />)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    expect(userTurns).toHaveLength(4)
    mockRect(userTurns[3], 374) // content offset 750 -> tick top 150
    fireEvent.scroll(utils.scroller)

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(4)
    expect(ticks[3]).toHaveAttribute('aria-label', 'Jump to prompt: Fourth user message here')
    expect(topOf(ticks[3])).toBeCloseTo(150, 5)
  })

  it('hides the rail when the transcript fits the viewport', () => {
    const utils = render(<FreshAgentTranscript turns={TRANSCRIPT} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, 0, 200, CLIENT_HEIGHT) // scrollHeight 200 <= clientHeight 248
    mockRect(scroller, 0)
    fireEvent.scroll(scroller)

    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
    expect(screen.queryByTestId('transcript-minimap-viewport')).not.toBeInTheDocument()
  })

  it('hides the rail when fewer than two user turns exist', () => {
    const utils = render(<FreshAgentTranscript turns={[TRANSCRIPT[0], TRANSCRIPT[1]]} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    fireEvent.scroll(scroller)

    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
  })

  it('renders no rail under default jsdom geometry (protects the rest of the suite)', () => {
    // No geometry mocks: clientHeight/scrollHeight are 0, so the rail must
    // stay hidden. This is the invariant that keeps every pre-existing
    // transcript test free of minimap buttons.
    render(<FreshAgentTranscript turns={TRANSCRIPT} />)
    expect(screen.queryByRole('button', { name: /Jump to prompt:/ })).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts`

Expected: FAIL because no minimap exists yet — the positive tests fail with Testing Library's "Unable to find an accessible element with the role "button" and name `/Jump to prompt:/`" (and "Unable to find an element by: [data-testid="transcript-minimap-viewport"]"). The three hidden-case tests pass vacuously at this point; they become load-bearing guards the moment the rail exists (they fail if the rail ever renders unconditionally).

- [ ] **Step 3: Add the minimal production implementation**

Create `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react'
import type { FreshAgentTurn } from '@shared/fresh-agent-contract'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { turnPlainText } from './FreshAgentTurnActions'
import {
  computeMinimapLayout,
  MINIMAP_RAIL_BOTTOM_INSET_PX,
  type MinimapLandmark,
  type MinimapLayout,
} from './shared/transcript-minimap-layout'

const ARIA_LABEL_MAX_LENGTH = 60
const TOOLTIP_MAX_LENGTH = 120

function truncatePrompt(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}

export type FreshAgentTranscriptMinimapProps = {
  /** The transcript's scroll container: owns the turn landmarks and geometry. */
  scrollerRef: { current: HTMLDivElement | null }
  /** The transcript's displayTurns — data-turn-index maps into this array. */
  displayTurns: FreshAgentTurn[]
  /** Content signature; a change re-measures landmark geometry. */
  transcriptSignature: string
}

/**
 * ChatGPT-style scroll minimap for the fresh-agent transcript: one tick per
 * user prompt (proportional to transcript length), a hover/focus prompt
 * preview, click-to-jump, and a band marking the visible region. Mounts as an
 * absolutely positioned overlay sibling of the scroller inside the
 * transcript's `relative` wrapper — the same pattern as the glom chip — so it
 * has zero layout impact on transcript copy in any pane style.
 */
export function FreshAgentTranscriptMinimap({
  scrollerRef,
  displayTurns,
  transcriptSignature,
}: FreshAgentTranscriptMinimapProps) {
  const [layout, setLayout] = useState<MinimapLayout | null>(null)

  const recompute = useCallback(() => {
    const scroller = scrollerRef.current
    if (!scroller) {
      setLayout(null)
      return
    }
    const { scrollHeight, clientHeight, scrollTop } = scroller
    const railHeight = clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX
    // Hidden when the content fits the viewport or the rail has no room; also
    // the state jsdom sits in by default (zero geometry), which keeps the
    // rest of the transcript suite free of minimap buttons.
    if (scrollHeight <= clientHeight || railHeight <= 0) {
      setLayout(null)
      return
    }
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
    // A single prompt needs no navigation aid.
    if (landmarks.length < 2) {
      setLayout(null)
      return
    }
    setLayout(computeMinimapLayout({
      scrollHeight,
      viewportHeight: clientHeight,
      scrollTop,
      railHeight,
      landmarks,
    }))
  }, [displayTurns, scrollerRef])

  // Re-measure when transcript content changes (streaming text growth flips
  // the signature), mirroring the glom chip's recompute effect.
  useEffect(() => {
    recompute()
  }, [recompute, transcriptSignature])

  // Re-measure on scroll and pane resize. Synchronous on purpose: the work is
  // the same order as the transcript's existing per-scroll recomputeGlom (one
  // querySelectorAll + a few rects), and a rAF hop would land the state
  // update outside act() in the jsdom suite.
  useEffect(() => {
    const scroller = scrollerRef.current
    if (!scroller) return
    scroller.addEventListener('scroll', recompute, { passive: true })
    let observer: ResizeObserver | null = null
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(recompute)
      observer.observe(scroller)
    }
    return () => {
      scroller.removeEventListener('scroll', recompute)
      observer?.disconnect()
    }
  }, [recompute, scrollerRef])

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
      className="fresh-agent-minimap absolute right-0 top-0 z-10 w-3"
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
                className="fresh-agent-minimap-tick absolute left-0 w-full rounded-sm bg-muted-foreground/40 transition-colors hover:bg-primary focus-visible:bg-primary"
                style={{ top: tick.top, height: tick.height }}
                aria-label={`Jump to prompt: ${truncatePrompt(firstLine, ARIA_LABEL_MAX_LENGTH)}`}
                onClick={() => handleTickClick(tick.index)}
              />
            </TooltipTrigger>
            <TooltipContent side="top" align="end" className="max-w-64 whitespace-pre-wrap">
              {truncatePrompt(firstLine, TOOLTIP_MAX_LENGTH)}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
```

Modify `src/components/fresh-agent/FreshAgentTranscript.tsx` — two edits only:

Edit 1 (import, after line 23 `import { FreshAgentActionSheet } from './FreshAgentActionSheet'`):

```tsx
import { FreshAgentTranscriptMinimap } from './FreshAgentTranscriptMinimap'
```

Edit 2 (render, immediately before the closing `</div>` of the `relative min-h-0 flex-1` wrapper at line 1389, i.e. after the `!atBottom ? (...) : null}` scroll-to-bottom block ending at line 1388):

```tsx
      <FreshAgentTranscriptMinimap
        scrollerRef={scrollerRef}
        displayTurns={displayTurns}
        transcriptSignature={transcriptSignature}
      />
```

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx --config config/vitest/vitest.config.ts`

Expected: PASS

- [ ] **Step 5: Refactor while green**

No refactor needed. The component is already minimal: one state slot, one memoized recompute (shared by all three triggers), one click handler. The truncation helper is 3 lines and used twice — extracting it to the shared module would add indirection without a second consumer class. Geometry is fully delegated to the Task-1 pure module, so there is no math inline to extract.

- [ ] **Step 6: Run impacted-test verification**

Run (whole fresh-agent unit dir — includes the 3200-line `FreshAgentTranscript.test.tsx` whose glom tests mock scroll geometry with 3 user turns and therefore DO render the rail now; their assertions are name-scoped to `/Jump to your message/` / `Scroll to bottom`, so they must still pass):

```bash
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
npm run typecheck:client
npm run lint
```

Expected: PASS / clean. If a pre-existing test breaks because the rail legitimately renders under its mocked geometry, do not weaken the assertion — re-scope the query by accessible name (the rail's names all match `/Jump to prompt:/`) and record the change in the task review.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx src/components/fresh-agent/FreshAgentTranscript.tsx test/unit/client/components/fresh-agent/FreshAgentTranscriptMinimap.test.tsx
git commit -m "feat(fresh-agent): add transcript minimap rail with prompt ticks"
```

---

### Task 3: E2E spec + docs mock

**Files:**
- Create: `test/e2e-browser/specs/transcript-minimap.spec.ts`
- Modify: `docs/index.html:445` (`.fresh-transcript` CSS rule — add minimap mock rules after it) and `docs/index.html:868` (inside the `.fresh-transcript` mock markup)

**Interfaces:**
- Consumes (Task 2 DOM contract): tick buttons with accessible names `Jump to prompt: <first line>`; `data-testid="transcript-minimap-viewport"` band; the hide gates (fewer than 2 prompts or content-fits-viewport ⇒ no rail).
- Consumes (existing e2e infrastructure): `freshellPage`/`page`/`terminal` fixtures from `test/e2e-browser/helpers/fixtures.ts`; the `installFreshclaudeStripPane` seeding idiom (`test/e2e-browser/specs/fresh-agent.spec.ts:264-295`) — suppress network effects, then `panes/updatePaneContent` the active terminal leaf into a freshclaude pane; the `page.route('**/api/fresh-agent/threads/freshclaude/claude/<sessionId>*')` snapshot fulfill (`freshagent-click-focus.spec.ts:15-56`); scroll assertions via `expect.poll(() => scroller.evaluate(el => el.scrollTop))` (`freshagent-click-focus.spec.ts:108-123`); tooltip assertion via portaled `page.getByRole('tooltip')`.
- Produces: e2e coverage proving the real user-facing outcome in a browser; the `docs/index.html` static mock update AGENTS.md requires for user-facing changes.

- [ ] **Step 1: Write the failing behavioral test**

```ts
import { test, expect } from '../helpers/fixtures.js'

function tallBody(tag: string): string {
  return `${tag}.\n\n` + Array.from(
    { length: 60 },
    (_, i) => `${tag} line ${i + 1}: the quick brown fox jumps over the lazy dog.`,
  ).join('\n\n')
}

/** Convert the active terminal leaf into a freshclaude pane whose routed
 * thread snapshot carries the given turns. Mirrors installFreshclaudeStripPane
 * (fresh-agent.spec.ts): network effects suppressed BEFORE the conversion so
 * the pane never WS-connects to a sidecar; the REST snapshot is the only
 * fetch. No provider binary involved, so the spec is cloud-legal. */
async function seedMinimapPane(page: any, sessionId: string, turns: unknown[]) {
  await page.route(`**/api/fresh-agent/threads/freshclaude/claude/${sessionId}*`, async (route: any) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sessionType: 'freshclaude',
        provider: 'claude',
        threadId: sessionId,
        sessionId,
        revision: 1,
        latestTurnId: (turns[turns.length - 1] as { id?: string } | undefined)?.id ?? null,
        status: 'idle',
        summary: '',
        capabilities: { send: true, interrupt: true, approvals: true, questions: true, fork: false },
        settings: { model: 'opus[1m]', permissionMode: 'default', plugins: [] },
        tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, costUsd: 0 },
        pendingApprovals: [],
        pendingQuestions: [],
        turns,
        extensions: { claude: { liveSessionId: sessionId, cliSessionId: sessionId } },
      }),
    })
  })
  await page.evaluate((currentSessionId) => {
    const harness = window.__FRESHELL_TEST_HARNESS__
    const state = harness?.getState()
    const tabId = state?.tabs?.activeTabId as string | undefined
    const paneId = tabId ? state?.panes?.activePane?.[tabId] : null
    if (!tabId || !paneId) return
    harness.setFreshAgentNetworkEffectsSuppressed(paneId, true)
    harness.dispatch({
      type: 'panes/updatePaneContent',
      payload: {
        tabId,
        paneId,
        content: {
          kind: 'fresh-agent',
          sessionType: 'freshclaude',
          provider: 'claude',
          createRequestId: `req-minimap-${currentSessionId}`,
          sessionId: currentSessionId,
          sessionRef: { provider: 'claude', sessionId: currentSessionId },
          resumeSessionId: currentSessionId,
          status: 'idle',
          settingsDismissed: true,
        },
      },
    })
  }, sessionId)
}

test.describe('Transcript minimap', () => {
  test('shows one tick per user prompt with hover preview, and clicking a tick jumps to that turn', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa101'
    await seedMinimapPane(page, sessionId, [
      { id: 'turn-mm-u1', turnId: 'turn-mm-u1', role: 'user', summary: 'Draft the release notes', items: [{ id: 'item-mm-u1', kind: 'text', text: 'Draft the release notes' }] },
      { id: 'turn-mm-a1', turnId: 'turn-mm-a1', role: 'assistant', summary: 'Notes body', items: [{ id: 'item-mm-a1', kind: 'text', text: tallBody('Notes') }] },
      { id: 'turn-mm-u2', turnId: 'turn-mm-u2', role: 'user', summary: 'Now add the upgrade guide', items: [{ id: 'item-mm-u2', kind: 'text', text: 'Now add the upgrade guide' }] },
      { id: 'turn-mm-a2', turnId: 'turn-mm-a2', role: 'assistant', summary: 'Guide body', items: [{ id: 'item-mm-a2', kind: 'text', text: tallBody('Guide') }] },
      { id: 'turn-mm-u3', turnId: 'turn-mm-u3', role: 'user', summary: 'Finally, summarize the risks', items: [{ id: 'item-mm-u3', kind: 'text', text: 'Finally, summarize the risks' }] },
      { id: 'turn-mm-a3', turnId: 'turn-mm-a3', role: 'assistant', summary: 'Risks body', items: [{ id: 'item-mm-a3', kind: 'text', text: tallBody('Risks') }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    await expect(scroller).toBeVisible({ timeout: 10_000 })

    // One tick per user-prompt turn; the visible-region band renders.
    const ticks = freshPane.getByRole('button', { name: /Jump to prompt:/ })
    await expect(ticks).toHaveCount(3)
    await expect(freshPane.getByTestId('transcript-minimap-viewport')).toBeVisible()

    // Hover preview: the existing tooltip component portals role="tooltip" to
    // document.body. The middle tick sits mid-rail, clear of the glom chip's
    // top band (which spans the full width at z-20 when visible).
    const middle = freshPane.getByRole('button', { name: 'Jump to prompt: Now add the upgrade guide', exact: true })
    await middle.hover()
    await expect(page.getByRole('tooltip')).toHaveText('Now add the upgrade guide')
    await page.mouse.move(0, 0)
    await expect(page.getByRole('tooltip')).toHaveCount(0)

    // Click-to-jump: the transcript loads pinned to the bottom (atBottom
    // layout effect), so jumping to the second prompt moves scrollTop up and
    // lands the turn at the scrollport top (block: 'start').
    const before = await scroller.evaluate((el: HTMLElement) => el.scrollTop)
    expect(before).toBeGreaterThan(0)
    await middle.click()
    await expect.poll(
      async () => scroller.evaluate((el: HTMLElement) => el.scrollTop),
      { timeout: 5_000 },
    ).toBeLessThan(before)
    const scrollerTop = await scroller.evaluate((el: HTMLElement) => el.getBoundingClientRect().top)
    const targetTop = await freshPane.locator('article[data-turn-role="user"]').nth(1)
      .evaluate((el: HTMLElement) => el.getBoundingClientRect().top)
    expect(Math.abs(targetTop - scrollerTop)).toBeLessThan(60)
  })

  test('hides the minimap when the transcript fits the viewport', async ({ freshellPage: _freshellPage, page, terminal }) => {
    await terminal.waitForTerminal()
    const sessionId = '63333000-0000-4333-8333-0000000aa102'
    // Two short user prompts: the >=2-landmarks condition IS met, so a count
    // of 0 can only mean the content-fits-viewport gate hid the rail.
    await seedMinimapPane(page, sessionId, [
      { id: 'turn-mm2-u1', turnId: 'turn-mm2-u1', role: 'user', summary: 'Hello there', items: [{ id: 'item-mm2-u1', kind: 'text', text: 'Hello there' }] },
      { id: 'turn-mm2-a1', turnId: 'turn-mm2-a1', role: 'assistant', summary: 'Hi', items: [{ id: 'item-mm2-a1', kind: 'text', text: 'Hi!' }] },
      { id: 'turn-mm2-u2', turnId: 'turn-mm2-u2', role: 'user', summary: 'One more thing', items: [{ id: 'item-mm2-u2', kind: 'text', text: 'One more thing' }] },
      { id: 'turn-mm2-a2', turnId: 'turn-mm2-a2', role: 'assistant', summary: 'Sure', items: [{ id: 'item-mm2-a2', kind: 'text', text: 'Sure.' }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane.getByText('One more thing', { exact: true })).toBeVisible({ timeout: 10_000 })
    await expect(freshPane.getByRole('button', { name: /Jump to prompt:/ })).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Run the test and verify the intended failure**

The spec is written after Task 2 landed, so demonstrate red by removing the feature from the working tree (the cloud e2e image builds from the worktree content; a dirty tree pays the one-time ~13 min `-dirty` rebuild — that is expected and correct here):

```bash
# Remove the Task-2 render block (and only it) from the transcript:
${EDITOR:-vi} src/components/fresh-agent/FreshAgentTranscript.tsx
#   delete:
#       <FreshAgentTranscriptMinimap
#         scrollerRef={scrollerRef}
#         displayTurns={displayTurns}
#         transcriptSignature={transcriptSignature}
#       />
#   (leave the import in place harmlessly, or remove it too — either way the
#   rail is gone)
bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'
git restore src/components/fresh-agent/FreshAgentTranscript.tsx
```

Expected: FAIL because the minimap rail does not render — the first test fails at `expect(ticks).toHaveCount(3)` (receives 0). (The hide-when-fits test passes vacuously without the feature; it is a guard that becomes load-bearing once the rail exists.)

- [ ] **Step 3: Add the minimal production implementation**

The production code already exists (Tasks 1-2); this task's remaining production artifact is the `docs/index.html` static mock that AGENTS.md requires for user-facing changes.

Edit 1 — `docs/index.html`, immediately after the existing rule at line 445 (`.fresh-transcript { min-height: 0; flex: 1; overflow-x: hidden; overflow-y: auto; padding: 14px 12px; }`), add:

```css
.fresh-transcript { position: relative; }
.fresh-minimap { position: absolute; top: 0; right: 0; bottom: 48px; width: 12px; }
.fresh-minimap-viewport { position: absolute; left: 0; right: 0; border-radius: 2px; background: rgba(127, 127, 127, 0.18); }
.fresh-minimap-tick { position: absolute; left: 0; right: 0; height: 3px; border-radius: 2px; background: rgba(127, 127, 127, 0.45); }
```

Edit 2 — `docs/index.html`, inside the `.fresh-transcript` mock (line 868, after the two `.fresh-turn` divs, before its closing `</div>`), add:

```html
<div class="fresh-minimap" aria-hidden="true"><span class="fresh-minimap-viewport" style="top: 52%; height: 34%"></span><span class="fresh-minimap-tick" style="top: 4%"></span><span class="fresh-minimap-tick" style="top: 46%"></span></div>
```

Verify: `grep -c 'fresh-minimap' docs/index.html` prints at least 4 (one rule + one class mention each in the mock markup lines).

Also confirm the new spec is NOT in the cloud skip list (empty output expected):

```bash
git grep -n "transcript-minimap" test/e2e-browser/playwright.cloud.config.ts || echo "not skipped"
```

- [ ] **Step 4: Run the focused test**

Run: `bash -lc 'npm run test:e2e:cloud -- --project=chromium test/e2e-browser/specs/transcript-minimap.spec.ts'`

Expected: PASS (both tests). Per AGENTS.md this run must be observed green on the configured cloud backend — a filter that matched no tests or a `CLOUD_SKIP_SPECS` entry is not coverage; the Step-3 grep proves the latter, and the run output's test count (2 passed) proves the former.

- [ ] **Step 5: Refactor while green**

No refactor needed: the spec is two tests sharing one small `seedMinimapPane` helper (mirroring the established `installFreshclaudeStripPane` idiom — deliberately a local copy, since existing fresh-agent specs keep their own seeding helpers rather than importing across spec files). The docs mock is static markup with two additive CSS rule blocks.

- [ ] **Step 6: Run impacted-test verification**

Run:

```bash
npm run test:e2e:a11y-gate
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
```

Expected: PASS. The a11y selector gate (HARNESS-11) must report no new violations — the spec uses only `getByRole`/`getByText`/`getByTestId` and `[data-context=...]` / `article[data-turn-role="user"]` selectors, all permitted. The unit re-run confirms the docs/spec additions touched no client behavior.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/transcript-minimap.spec.ts docs/index.html
git commit -m "test(fresh-agent): e2e coverage for transcript minimap + docs mock"
```
