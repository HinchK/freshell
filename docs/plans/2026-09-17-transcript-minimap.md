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

**Architecture:** A pure geometry module (`computeMinimapLayout`) maps measured turn landmarks onto rail coordinates — every user prompt keeps a tick in a distinct, non-overlapping slot: colliding ticks abut in order, and under density the layout thins tick heights (sub-pixel allowed) or, when even abutting cannot fit, packs them in transcript order. A new `FreshAgentTranscriptMinimap` component mounts as an absolutely positioned overlay sibling of the scroller inside `FreshAgentTranscript`'s existing `relative` wrapper (the established glom-chip/scroll-to-bottom mounting pattern), measures `[data-turn-role="user"]` articles against the scroller, and jumps via `scrollIntoView({ block: 'start' })` — reusing the glom chip's exact query/jump pattern so no new scroll machinery is needed and stick-to-bottom disengages naturally via the existing `onScroll` handler. Geometry re-measures on scroll, transcript growth, scroller resize, and article-level resizes (disclosure expand/collapse, font reflow).

**Tech Stack:** React 18 + TypeScript (client), Tailwind CSS classes, existing hand-rolled `Tooltip` (`src/components/ui/tooltip.tsx`), Vitest + Testing Library (jsdom) for unit tests, Playwright (cloud backend) for e2e.

## Global Constraints

- **TDD:** Red-Green-Refactor per task. Every test fails first for the stated reason and passes after the shown implementation. Never skip the refactor step (state explicitly when none is needed).
- **Worktree:** All work happens in the coordinator-provided worktree (`.worktrees/transcript-minimap`), on the feature branch. Run every command from that directory. Do not commit or push to `main`; do not open a PR (the coordinator asks the user).
- **A11y:** Ticks are real `<button type="button">` elements with `aria-label`s. `npm run lint` (eslint-plugin-jsx-a11y) must stay clean — it is a CI gate.
- **No IntersectionObserver** — it is neither used nor stubbed anywhere in this repo. The visible-region band is computed from `scrollTop`/`scrollHeight`/`clientHeight` instead.
- **Tick completeness:** every user prompt keeps a tick in a DISTINCT, non-overlapping slot. The layout thins the minimum height under density (sub-pixel allowed) and abuts colliding ticks in order; when even abutting cannot fit, it scales heights and packs cumulative slots (Regime B). No `< 2` prompts hide gate: a lone prompt renders a one-tick rail. No two ticks ever share a y-range, so no tick occludes another's paint or hit-test.
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
  - `MINIMAP_RAIL_BOTTOM_INSET_PX: number` (= 48 — clears the serif/mono bottom-right scroll-to-bottom button, `src/index.css:761-771,1290-1301`, in every pane style)
  - `type MinimapLandmark = { index: number; offsetTop: number; height: number; label: string }`
  - `type MinimapTick = { index: number; label: string; top: number; height: number }`
  - `type MinimapViewportBand = { top: number; height: number }`
  - `type MinimapLayout = { ticks: MinimapTick[]; viewport: MinimapViewportBand; railHeight: number }` (`railHeight` echoes the input so consumers — the tooltip side rule — need no second state slot)
  - `computeMinimapLayout(input: { scrollHeight: number; viewportHeight: number; scrollTop: number; railHeight: number; landmarks: readonly MinimapLandmark[] }): MinimapLayout`
- Semantics (all pinned by tests below): ticks scale by `railHeight / scrollHeight`; under density the minimum tick height thins to `effectiveMinTickHeight = min(3, railHeight / landmarkCount)` with NO pixel floor — sub-pixel heights keep every tick in a DISTINCT, non-overlapping y-range (two ticks never share coordinates, so no tick ever occludes another's paint or hit-test). **Regime A (fits):** iterate landmarks sorted by `offsetTop` (ties by `index`); each tick's top is `min(max(proportionalTop, previousTickBottom), railHeight - height)` — proportional position preserved, colliding ticks pushed below their predecessor, single ticks past the rail clamped at the bottom edge; the regime is valid while the bottom clamp never pushes a tick below its predecessor's bottom. **Regime B (cannot fit):** when the chain would overlap, scale all tick heights by `min(1, railHeight / Σheights)` and place cumulative packed tops in transcript order — every tick keeps its own distinct slot and the whole band fits the rail exactly. The viewport band height is `min(railHeight, max(MIN_TICK, viewportHeight * scale))` and its top maps the clamped scroll fraction `scrollTop / (scrollHeight - viewportHeight)` onto `[0, railHeight - bandHeight]` so the band reaches exactly the rail bottom at max scroll; degenerate inputs (`scrollHeight <= 0` or `railHeight <= 0`) return `{ ticks: [], viewport: { top: 0, height: 0 }, railHeight: 0 }`.

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
    expect(layout.railHeight).toBe(100)
  })

  it('enforces the minimum tick height for tiny turns', () => {
    const layout = computeMinimapLayout({
      scrollHeight: 2000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 10)], // 10 * 0.05 = 0.5px -> clamped to the minimum
    })
    expect(layout.ticks[0].height).toBe(MINIMAP_MIN_TICK_HEIGHT_PX)
  })

  it('keeps every colliding tick — later ticks abut the previous tick, never drop (earlier prompt stays at its proportional spot)', () => {
    // scale 0.01, heights clamp to 3 (effectiveMin = min(3, 100/3) = 3):
    // raw proportional tops 0, 1, 5. Tick 1 is pushed down to abut tick 0
    // (top 3), tick 2 abuts tick 1 (top 6). All three prompts keep a tick —
    // the finding-1 guarantee: nothing is dropped.
    const layout = computeMinimapLayout({
      scrollHeight: 10000, viewportHeight: 400, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0), landmark(1, 100), landmark(2, 500)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1, 2])
    expect(layout.ticks[0].top).toBeCloseTo(0, 5)
    expect(layout.ticks[1].top).toBeCloseTo(3, 5)
    expect(layout.ticks[2].top).toBeCloseTo(6, 5)
    expect(layout.ticks[1].height).toBeCloseTo(3, 5)
  })

  it('thins the minimum tick height under density so every prompt keeps a visible tick', () => {
    // rail 20, 10 landmarks: effectiveMin = min(3, max(1, 20/10)) = 2.
    // Proportional heights (100 * 0.02 = 2) equal the thinned minimum, and
    // abutting stacks them monotonically 0,2,4,...,18 — an exact fit, every
    // prompt present and clickable.
    const layout = computeMinimapLayout({
      scrollHeight: 5000, viewportHeight: 400, scrollTop: 0, railHeight: 20,
      landmarks: Array.from({ length: 10 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.ticks).toHaveLength(10)
    expect(layout.ticks.map((t) => t.top)).toEqual([0, 2, 4, 6, 8, 10, 12, 14, 16, 18])
  })

  it('never drops a landmark at absurd density — every tick keeps a distinct in-bounds slot', () => {
    // rail 20, 30 landmarks: effectiveMin = min(3, 20/30) = 0.667 (sub-pixel
    // allowed). Proportional tops and the abut chain coincide exactly, so
    // Regime A holds with a 2/3px pitch — 30 distinct ticks, monotonic,
    // in-bounds. No two ticks share coordinates: nothing occludes anything.
    const layout = computeMinimapLayout({
      scrollHeight: 3000, viewportHeight: 400, scrollTop: 0, railHeight: 20,
      landmarks: Array.from({ length: 30 }, (_, i) => landmark(i, i * 100)),
    })
    expect(layout.ticks).toHaveLength(30)
    for (let i = 1; i < layout.ticks.length; i++) {
      expect(layout.ticks[i].top).toBeGreaterThan(layout.ticks[i - 1].top)
      expect(layout.ticks[i].top + layout.ticks[i].height).toBeLessThanOrEqual(20.000001)
    }
    expect(layout.ticks[29].height).toBeCloseTo(20 / 30, 5)
    expect(layout.ticks[29].top).toBeCloseTo(29 * (20 / 30), 5)
  })

  it('packs ticks in transcript order when proportional placement cannot fit (Regime B)', () => {
    // Two huge prompts: proportional heights 60px each cannot fit a 100px
    // rail while keeping proportional tops (the second would clamp back onto
    // the first), so the layout scales heights to fit (x100/120 = 50 each)
    // and packs cumulative tops 0 / 50 — both distinct and in-bounds.
    const layout = computeMinimapLayout({
      scrollHeight: 500, viewportHeight: 200, scrollTop: 0, railHeight: 100,
      landmarks: [landmark(0, 0, 300), landmark(1, 250, 300)],
    })
    expect(layout.ticks.map((t) => t.index)).toEqual([0, 1])
    expect(layout.ticks[0].top).toBeCloseTo(0, 5)
    expect(layout.ticks[0].height).toBeCloseTo(50, 5)
    expect(layout.ticks[1].top).toBeCloseTo(50, 5)
    expect(layout.ticks[1].height).toBeCloseTo(50, 5)
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
      expect(layout.railHeight).toBe(0)
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

/** Minimum rendered tick height, px — keeps every prompt clickable at sane
 * densities; under density the effective minimum thins below it (sub-pixel
 * allowed) so no prompt is ever dropped or stacked on another. */
export const MINIMAP_MIN_TICK_HEIGHT_PX = 3
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
  /** Tick height, px (>= the density-thinned minimum). */
  height: number
}

export type MinimapViewportBand = {
  top: number
  height: number
}

export type MinimapLayout = {
  ticks: MinimapTick[]
  viewport: MinimapViewportBand
  /** Echoes the input railHeight for consumers (e.g. the tooltip side rule). */
  railHeight: number
}

export function computeMinimapLayout(input: {
  scrollHeight: number
  viewportHeight: number
  scrollTop: number
  railHeight: number
  landmarks: readonly MinimapLandmark[]
}): MinimapLayout {
  if (input.scrollHeight <= 0 || input.railHeight <= 0) {
    return { ticks: [], viewport: { top: 0, height: 0 }, railHeight: 0 }
  }
  const scale = input.railHeight / input.scrollHeight
  // Under density the minimum tick height thins — sub-pixel allowed, no pixel
  // floor — so every prompt keeps a DISTINCT slot: two ticks never share a
  // y-range, so no tick ever occludes another's paint or hit-test.
  const effectiveMinTickHeight = Math.min(
    MINIMAP_MIN_TICK_HEIGHT_PX,
    input.railHeight / Math.max(1, input.landmarks.length),
  )

  const sorted = [...input.landmarks].sort((a, b) => a.offsetTop - b.offsetTop || a.index - b.index)
  let heights = sorted.map((mark) => Math.min(
    input.railHeight,
    Math.max(effectiveMinTickHeight, mark.height * scale),
  ))

  // Regime A — proportional tops with abut push-down: each tick keeps its
  // proportional position, is pushed below its predecessor on collision, and
  // a lone overshoot clamps at the rail bottom (rail - height). Valid only
  // while that clamp never pushes a tick below its predecessor's bottom,
  // which would occlude the predecessor's hit area.
  let fits = true
  const tops: number[] = []
  for (let i = 0; i < sorted.length; i++) {
    const prevBottom = i === 0 ? 0 : tops[i - 1] + heights[i - 1]
    const desired = Math.max(sorted[i].offsetTop * scale, prevBottom)
    const maxTop = input.railHeight - heights[i]
    if (maxTop < prevBottom - 1e-9) {
      fits = false
      break
    }
    tops.push(Math.min(Math.max(desired, 0), Math.max(maxTop, 0)))
  }
  if (!fits) {
    // Regime B — pack: scale every tick height by railHeight / Σheights and
    // place cumulative tops in transcript order. Every tick keeps its own
    // distinct slot and the whole band fits the rail exactly; under density
    // the rail is honestly a packed index, never an occluding stack.
    const total = heights.reduce((sum, h) => sum + h, 0)
    const factor = Math.min(1, input.railHeight / total)
    heights = heights.map((h) => h * factor)
    tops.length = 0
    let cursor = 0
    for (const h of heights) {
      tops.push(cursor)
      cursor += h
    }
  }

  const ticks = sorted.map((mark, i) => ({
    index: mark.index,
    label: mark.label,
    top: tops[i],
    height: heights[i],
  }))

  const bandHeight = Math.min(
    input.railHeight,
    Math.max(MINIMAP_MIN_TICK_HEIGHT_PX, input.viewportHeight * scale),
  )
  const maxScroll = Math.max(0, input.scrollHeight - input.viewportHeight)
  const clampedScrollTop = Math.min(Math.max(input.scrollTop, 0), maxScroll)
  const fraction = maxScroll > 0 ? clampedScrollTop / maxScroll : 0
  const bandTop = fraction * (input.railHeight - bandHeight)

  return { ticks, viewport: { top: bandTop, height: bandHeight }, railHeight: input.railHeight }
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
  - Rail container: `<div class="fresh-agent-minimap …" role="group" aria-label="Transcript minimap">` — `pointer-events-none` on the container, `pointer-events-auto` on the tick buttons only; positioned `right-2` (8px inset) so the rail sits exactly in the scroller's 12px right padding gutter, clear of the repo's 8px custom scrollbar (`src/index.css:1475` `::-webkit-scrollbar { width: 0.5rem }`) — never overlapping it; `z-30` so ticks stay clickable over the full-width z-20 glom chip at the transcript top (ticks are 12px wide; the chip keeps its click target everywhere else).
  - Visibility gate: the rail renders `null` when `scrollHeight <= clientHeight` (content fits the viewport) or the scroller is missing/zero-sized (also the jsdom default). Every user prompt with landmark text keeps a tick — no `< 2` prompts gate; a lone prompt renders a one-tick rail.
- Measurement math (exact): for each `[data-turn-role="user"]` article inside the scroller, `index = Number(el.getAttribute('data-turn-index'))` (skip missing/NaN), `turn = displayTurns[index]` (skip missing), `label = turnPlainText(turn)` (skip empty), `rect = el.getBoundingClientRect()`, `offsetTop = rect.top - scroller.getBoundingClientRect().top + scroller.scrollTop`, `height = rect.height`. `railHeight = scroller.clientHeight - MINIMAP_RAIL_BOTTOM_INSET_PX`.
- Recompute triggers: an effect keyed on `transcriptSignature` (mirrors the glom chip's effect at `FreshAgentTranscript.tsx:1241-1243`); a native `scroll` listener and a `ResizeObserver` on the scroller installed in a mount effect; and article-level observation — the signature effect also (re)subscribes a second `ResizeObserver` to every `[data-turn-role]` article (assistant articles included: their height changes move later landmarks), so content-only layout changes — tool/thinking disclosure expand-collapse, font-size reflow — re-measure even though neither `transcriptSignature` nor the scroller's border box changed. All observers/listeners call the recompute **synchronously** (see Global Constraints for why this is not rAF-throttled). Both observer subscriptions are guarded `typeof ResizeObserver !== 'undefined'` (the jsdom global stub makes them no-ops in tests unless a test stubs a capturable implementation).
- Click behavior: `scroller.querySelector('[data-turn-index="${index}"]')?.scrollIntoView?.({ block: 'start' })` — optional-call tolerance for jsdom, mirroring `handleGlomClick` (`FreshAgentTranscript.tsx:1156-1162`). The resulting scroll event flips `atBottom` false via the existing `onScroll` handler, so stick-to-bottom disengages with no fight.
- Tooltip: `side` is per-tick — `'bottom'` for ticks in the top quarter of the rail (`tick.top < layout.railHeight * 0.25`), `'top'` otherwise (the tooltip clamps horizontally but computes its `style.top` unclamped — `tooltip.tsx:89-95` — so the topmost ticks must open downward to keep multi-line previews inside the viewport) — always `align="end"`. Content is the prompt's first line truncated to 120 chars with `…`; aria-label truncates the same first line to 60 chars.

- [ ] **Step 1: Write the failing behavioral test**

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
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

/** Capturable ResizeObserver stub: records callbacks PER OBSERVED TARGET so
 * tests can fire exactly the callbacks a specific element would receive on a
 * real resize (the global jsdom stub in test/setup/dom.ts is a silent no-op).
 * Target-scoped firing is what makes the article-observation test
 * load-bearing: the scroller observer's callback is never fired there. */
const resizeCallbacksByTarget = new Map<Element, Array<() => void>>()
class CapturingResizeObserver {
  private readonly fire = () => this.cb()
  constructor(private readonly cb: () => void) {}
  observe(el: Element) {
    resizeCallbacksByTarget.set(el, [...(resizeCallbacksByTarget.get(el) ?? []), this.fire])
  }
  unobserve() {}
  disconnect() {}
}

describe('FreshAgentTranscript minimap rail', () => {
  afterEach(() => { vi.unstubAllGlobals(); cleanup() })

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
    // NO scroll event and NO extra geometry mocks after the rerender: the
    // transcriptSignature effect alone must re-measure. The new article's
    // real jsdom-zero rect places it at content offset 0 - 0 + scrollTop
    // (376) -> tick top 75.2 (sorted before the Third prompt's 450 -> its
    // tick stays at 90). If the signature recomputation effect were removed,
    // this test fails — nothing else fires.
    utils.rerender(<FreshAgentTranscript turns={grown} />)

    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(4)
    const fourth = screen.getByRole('button', { name: 'Jump to prompt: Fourth user message here' })
    expect(topOf(fourth)).toBeCloseTo(75.2, 5)
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

  it('renders a lone tick for a single-prompt transcript (no < 2 gate)', () => {
    const utils = render(<FreshAgentTranscript turns={[TRANSCRIPT[0], TRANSCRIPT[1]]} />)
    const scroller = utils.container.querySelector('[data-context="fresh-agent-transcript"]') as HTMLDivElement
    mockScroll(scroller, SCROLL_TOP, SCROLL_HEIGHT, CLIENT_HEIGHT)
    const userTurns = utils.container.querySelectorAll('[data-turn-role="user"]')
    mockRect(scroller, 0)
    mockRect(userTurns[0], -376)
    fireEvent.scroll(scroller)

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(ticks).toHaveLength(1)
    expect(ticks[0]).toHaveAttribute('aria-label', 'Jump to prompt: First user message here')
    expect(screen.getByTestId('transcript-minimap-viewport')).toBeInTheDocument()
  })

  it('re-measures when an article resizes (disclosure toggle) with no signature change', async () => {
    vi.stubGlobal('ResizeObserver', CapturingResizeObserver)
    const { scroller, userTurns } = setupScrollableTranscript()
    expect(screen.getAllByRole('button', { name: /Jump to prompt:/ })).toHaveLength(3)

    // An assistant disclosure expands, pushing the second and third user
    // prompts 200px deeper into the content (offsets 500 / 650 -> ticks
    // 100 / 130) — no rerender, no signature change, no scroll.
    mockRect(userTurns[1], 124)
    mockRect(userTurns[2], 274)
    // Fire ONLY the callbacks registered for turn articles — never the
    // scroller observer's — so this test fails if article observation is
    // removed (nothing would fire) instead of passing via the scroller
    // path. act() wraps the callbacks: they setState synchronously.
    await act(async () => {
      for (const el of scroller.querySelectorAll('[data-turn-role]')) {
        for (const fire of resizeCallbacksByTarget.get(el) ?? []) fire()
      }
    })

    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    expect(topOf(ticks[1])).toBeCloseTo(100, 5)
    expect(topOf(ticks[2])).toBeCloseTo(130, 5)
  })

  it('opens topmost ticks downward (side bottom) and lower ticks upward (side top)', () => {
    setupScrollableTranscript()
    // railHeight 200 -> top-quarter threshold 50. Tick 0 (top 0) is in the
    // top quarter and must open BELOW its tick; ticks 1 (top 60) and 2
    // (top 90) open above. tooltip.tsx:89-95 sets side "bottom" top =
    // rect.bottom + sideOffset (positive here) and side "top" top =
    // rect.top - height - sideOffset (negative here).
    const ticks = screen.getAllByRole('button', { name: /Jump to prompt:/ })
    fireEvent.mouseEnter(ticks[0])
    expect(parseFloat(screen.getByRole('tooltip').style.top)).toBeGreaterThan(0)
    fireEvent.mouseLeave(ticks[0])
    fireEvent.mouseEnter(ticks[1])
    expect(parseFloat(screen.getByRole('tooltip').style.top)).toBeLessThan(0)
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

Expected: FAIL because no minimap exists yet — the positive tests fail with Testing Library's "Unable to find an accessible element with the role "button" and name `/Jump to prompt:/`" (and "Unable to find an element by: [data-testid="transcript-minimap-viewport"]"). The two hide-case tests (fits-viewport, default-jsdom-geometry) pass vacuously at this point; they become load-bearing guards the moment the rail exists (they fail if the rail ever renders unconditionally).

- [ ] **Step 3: Add the minimal production implementation**

Create `src/components/fresh-agent/FreshAgentTranscriptMinimap.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react'
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
    setLayout(computeMinimapLayout({
      scrollHeight,
      viewportHeight: clientHeight,
      scrollTop,
      railHeight,
      landmarks,
    }))
  }, [displayTurns, scrollerRef])

  // Re-measure when transcript content changes (streaming text growth flips
  // the signature), mirroring the glom chip's recompute effect — and observe
  // every turn article so content-only layout changes (tool/thinking
  // disclosure expand-collapse, font-size reflow) re-measure too: they move
  // scrollHeight and landmark offsets without touching the signature or the
  // scroller's border box. Re-subscribed per signature so new articles are
  // observed and stale ones released.
  const articleObserverRef = useRef<ResizeObserver | null>(null)
  useEffect(() => {
    recompute()
    const scroller = scrollerRef.current
    if (!scroller || typeof ResizeObserver === 'undefined') return
    articleObserverRef.current?.disconnect()
    const observer = new ResizeObserver(recompute)
    scroller.querySelectorAll('[data-turn-role]').forEach((el) => observer.observe(el))
    articleObserverRef.current = observer
    return () => {
      observer.disconnect()
      if (articleObserverRef.current === observer) articleObserverRef.current = null
    }
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
              className="max-w-64 whitespace-pre-wrap"
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
- Consumes (Task 2 DOM contract): tick buttons with accessible names `Jump to prompt: <first line>`; `data-testid="transcript-minimap-viewport"` band; the hide gate (content-fits-viewport ⇒ no rail; a lone prompt still renders its one tick).
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
    // Two short user prompts: both prompts exist (so a 0-tick result cannot
    // mean they were missing), and the seeded content is short — the
    // content-fits-viewport gate is the only hide condition in play.
    await seedMinimapPane(page, sessionId, [
      { id: 'turn-mm2-u1', turnId: 'turn-mm2-u1', role: 'user', summary: 'Hello there', items: [{ id: 'item-mm2-u1', kind: 'text', text: 'Hello there' }] },
      { id: 'turn-mm2-a1', turnId: 'turn-mm2-a1', role: 'assistant', summary: 'Hi', items: [{ id: 'item-mm2-a1', kind: 'text', text: 'Hi!' }] },
      { id: 'turn-mm2-u2', turnId: 'turn-mm2-u2', role: 'user', summary: 'One more thing', items: [{ id: 'item-mm2-u2', kind: 'text', text: 'One more thing' }] },
      { id: 'turn-mm2-a2', turnId: 'turn-mm2-a2', role: 'assistant', summary: 'Sure', items: [{ id: 'item-mm2-a2', kind: 'text', text: 'Sure.' }] },
    ])

    const freshPane = page.locator('[data-context="fresh-agent"]')
    await expect(freshPane.getByText('One more thing', { exact: true })).toBeVisible({ timeout: 10_000 })
    const scroller = freshPane.locator('[data-context="fresh-agent-transcript"]')
    // Self-verifying precondition: this test's guarantee depends on the
    // seeded content actually fitting the pane viewport. If this assertion
    // fails on the cloud pane geometry, shorten the assistant bodies until
    // it passes — do not delete the guard.
    const fits = await scroller.evaluate((el: HTMLElement) => el.scrollHeight <= el.clientHeight)
    expect(fits).toBe(true)
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
.fresh-minimap { position: absolute; top: 0; right: 8px; bottom: 48px; width: 12px; }
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
npm run test:e2e:a11y-gate:deny
npm run test:vitest -- run test/unit/client/components/fresh-agent/ --config config/vitest/vitest.config.ts
```

Expected: PASS. The a11y selector gate must run in `--deny` mode (the plain `test:e2e:a11y-gate` script only warns and always exits 0) and report no new violations — the spec uses only `getByRole`/`getByText`/`getByTestId` and `[data-context=...]` / `article[data-turn-role="user"]` selectors, all permitted. The unit re-run confirms the docs/spec additions touched no client behavior.

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/transcript-minimap.spec.ts docs/index.html
git commit -m "test(fresh-agent): e2e coverage for transcript minimap + docs mock"
```
