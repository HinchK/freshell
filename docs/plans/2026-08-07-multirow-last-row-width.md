# Multirow Tab Bar: Uniform Last-Row Tab Width — Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** In multirow tab-bar mode with 2+ wrapped rows, lock every tab — including the partial bottom row — to exactly the width the full rows render at, so the last row ends short of the right edge instead of stretching wider.

**Architecture:** Widths in the multirow strip are currently pure CSS (`flex-wrap` + `grow basis-[150px] min-w-[150px] max-w-[200px]`), and CSS flexbox distributes free space *per flex line* — so a sparse last row stretches its tabs wider (up to the 200px cap) than the full rows above. The fix adds a pure width computation to `src/lib/tab-bar-metrics.ts` (compute tabs-per-full-row at the 150px minimum, stretch to fill, cap at 200px, floor to an integer), measures the strip's `clientWidth` inside `TabBar.tsx`'s existing ResizeObserver effect, and applies the resulting width as an inline `style` uniformly to every tab wrapper — but only when the tabs actually wrap to 2+ rows. When all tabs fit on one row (or the width is unmeasured, e.g. jsdom), the helper returns `null` and the existing stretch-to-fill CSS classes remain untouched.

**Tech Stack:** React 18 + Redux Toolkit, Tailwind (arbitrary-value classes), Vitest 3 + @testing-library/react (jsdom), Playwright (chromium) e2e.

## Global Constraints

- Multirow tab width bounds are exactly **min 150px / max 200px**; single-row (multirow=false) tabs are exactly **175px** — all deliberately absolute px (they do NOT scale with `--ui-scale`), matching the shipped Tailwind classes `basis-[150px] min-w-[150px] max-w-[200px]` and `w-[175px] shrink-0` in `src/components/TabBar.tsx:139-140`.
- The inter-tab gap is `gap-0.5` = `TAB_ROW_GAP_REM` = **0.125rem** (2px at the default 16px root) and IS rem-based/scale-aware — width math must take the gap in px as a parameter, computed as `TAB_ROW_GAP_REM * getRootFontSizePx()`.
- Tailwind JIT cannot generate interpolated classes: a **computed width MUST be an inline `style`**, never `` `w-[${n}px]` ``.
- `Math.floor` the computed width — rounding up crosses the packing knife-edge and re-wraps a full row's last tab onto the next row (layout oscillation under ResizeObserver).
- Guard `clientWidth === 0` (jsdom / pre-layout): fall back to today's stretch classes so every existing TabBar unit test stays green.
- `react-hooks/exhaustive-deps` is **warning-only** in this repo: any new value passed through `renderSortableTab` MUST be hand-added to its `useCallback` dependency array (`src/components/TabBar.tsx:401-418`).
- `console.error` is fatal in unit tests (`test/setup/dom.ts` throws in afterEach).
- Red-Green-Refactor TDD is mandatory (AGENTS.md); every behavior change gets unit AND e2e coverage.
- Broad test runs go through the shared coordinator; use `npm run test:vitest -- ...` for direct Vitest runs (never raw `npx vitest`). If the e2e `prebuild-guard` refuses because a production server holds the port, stop and report — never kill a foreign holder.
- Do not create or open a PR until the user explicitly approves.
- All work happens inside the worktree `/home/dan/code/freshell/.worktrees/multirow-last-row-width` — every command below runs from that directory.

## Out of Scope / Intentionally Unchanged

- **Single-row mode (`multirowTabs: false`)**: `w-[175px] shrink-0` at `TabBar.tsx:140` — untouched; existing unit + e2e assertions must stay green as-is.
- **Single-row-in-multirow** (all tabs fit on one line): stretch-to-fill (`grow basis-[150px] min-w-[150px] max-w-[200px]`) applies exactly as today.
- **Drag-ghost width** (`className="w-[175px]"` in the `<DragOverlay>` at `TabBar.tsx:638`): a pre-existing hard-coded value from PR #616, unrelated to row packing — unchanged.
- **`docs/index.html`**: its mock tab strip has no per-tab width rules, and this is a bug fix restoring the intended uniform look rather than a new user-facing feature — no update needed (AGENTS.md's "significant UI change" bar considered and not met).
- **Screenshot baselines** (`multiple-tabs`, `default-layout`): both render 3 or fewer tabs on a single row, which keeps stretch-to-fill — no baseline regeneration expected. If a baseline unexpectedly diffs, that signals a regression in the single-row branch: investigate, do not blindly `--update-snapshots`.

## Background: the exact bug mechanism (read before Task 1)

The strip (`src/components/TabBar.tsx:589-601`) is `flex flex-wrap gap-0.5`; each tab wrapper is `grow basis-[150px] min-w-[150px] max-w-[200px]`. CSS Flexbox resolves flexible lengths **per flex line**: each line splits *its own* free space among *its own* items. A line holding `n` tabs renders each at `min(200, (W - (n-1)·gap) / n)` — strictly decreasing in `n`. Full rows hold `N_full = floor((W + gap) / (150 + gap))` tabs; the last row holds fewer, so its tabs come out wider (e.g. W=1000, gap=2: full rows render 165px tabs, a 2-tab last row clamps at 200px — a 35px visible mismatch). Nothing in the code names "last row"; it is emergent layout. The fix therefore computes ONE width from the full rows and pins every tab to it with `flex-grow` removed.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/lib/tab-bar-metrics.ts` | Modify (add exports) | Pure, DOM-free width math: `MULTIROW_TAB_MIN_WIDTH_PX`, `MULTIROW_TAB_MAX_WIDTH_PX`, `multirowUniformTabWidthPx()` |
| `test/unit/client/lib/tab-bar-metrics.test.ts` | Modify (new describe) | Table-driven unit coverage of the width math |
| `src/components/TabBar.tsx` | Modify (5 focused edits) | Measure `clientWidth` in the existing ResizeObserver effect; thread `uniformWidthPx` to `SortableTab`; apply inline width + `shrink-0` when locked |
| `test/unit/client/components/TabBar.multirow.test.tsx` | Modify (extend `describe('tab widths')`) | Component-level contract: locked inline width across all wrappers; stretch classes preserved when tabs fit one row |
| `test/e2e-browser/specs/multirow-tabs.spec.ts` | Modify (new test) | Real-browser proof: with a partial last row, ALL tabs measure the same width and the last row ends short of the right edge |

`src/components/TabItem.tsx` is `w-full` inside the wrapper and owns no width — **not touched**. `src/components/TabBarResizeHandle.tsx` — not touched.

---

### Task 1: Pure width math in `tab-bar-metrics.ts`

**Files:**
- Modify: `src/lib/tab-bar-metrics.ts` (append after `tabBarMultiRowThresholdPx`, ~line 57; plus one JSDoc edit at line 13)
- Test: `test/unit/client/lib/tab-bar-metrics.test.ts`

**Interfaces:**
- Consumes: nothing new — `MULTIROW_TAB_MIN_WIDTH_PX`/`MULTIROW_TAB_MAX_WIDTH_PX` are self-contained; the module's existing "take px inputs explicitly, never read the DOM" convention.
- Produces (Task 2 relies on these exact names/types):
  - `export const MULTIROW_TAB_MIN_WIDTH_PX = 150`
  - `export const MULTIROW_TAB_MAX_WIDTH_PX = 200`
  - `export function multirowUniformTabWidthPx(containerWidthPx: number, tabCount: number, gapPx: number): number | null` — returns the locked integer px width when tabs wrap to 2+ rows, or `null` when the lock must not apply (all tabs fit on one row, `containerWidthPx <= 0`, or `tabCount <= 0`).

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/lib/tab-bar-metrics.test.ts`, add `multirowUniformTabWidthPx` to the existing import block:

```ts
import {
  getRootFontSizePx,
  multirowUniformTabWidthPx,
  tabBarHeightPxToRows,
  tabBarMultiRowThresholdPx,
  tabBarRowPitchPx,
  tabBarRowsToMaxHeightCss,
  tabBarRowsToMaxHeightPx,
} from '@/lib/tab-bar-metrics'
```

Then append this new describe block at the end of the file (after the existing `describe('tab-bar-metrics', ...)` closes):

```ts
describe('multirowUniformTabWidthPx', () => {
  const GAP = 2 // TAB_ROW_GAP_REM (0.125rem) at the 16px default root

  it('returns null when all tabs fit on a single row', () => {
    // 1000px strip, 2px gap: floor((1000 + 2) / 152) = 6 tabs per full row.
    expect(multirowUniformTabWidthPx(1000, 1, GAP)).toBeNull()
    expect(multirowUniformTabWidthPx(1000, 6, GAP)).toBeNull()
  })

  it('locks wrapped tabs to the full-row width', () => {
    // 6 tabs per full row: (1000 - 5*2) / 6 = 165.
    expect(multirowUniformTabWidthPx(1000, 7, GAP)).toBe(165)
    // The width comes from the container, not the tab count.
    expect(multirowUniformTabWidthPx(1000, 20, GAP)).toBe(165)
  })

  it('floors fractional widths so a full row never overflows', () => {
    // (1003 - 5*2) / 6 = 165.5 -> 165.
    expect(multirowUniformTabWidthPx(1003, 7, GAP)).toBe(165)
  })

  it('caps the locked width at 200px', () => {
    // 2 tabs per full row: (450 - 2) / 2 = 224 -> capped to 200.
    expect(multirowUniformTabWidthPx(450, 3, GAP)).toBe(200)
  })

  it('never returns less than the 150px minimum', () => {
    // Degenerate 120px strip: 1 tab per row at raw width 120 -> clamped to 150,
    // matching the CSS min-width floor (the tab overflows, same as today).
    expect(multirowUniformTabWidthPx(120, 2, GAP)).toBe(150)
  })

  it('returns null for unmeasured or empty strips', () => {
    expect(multirowUniformTabWidthPx(0, 10, GAP)).toBeNull() // jsdom / pre-layout
    expect(multirowUniformTabWidthPx(-5, 10, GAP)).toBeNull()
    expect(multirowUniformTabWidthPx(1000, 0, GAP)).toBeNull()
  })

  it('is gap-aware for scaled roots', () => {
    // At a 20px root, gap-0.5 is 2.5px: floor((1000 + 2.5) / 152.5) = 6 per row,
    // (1000 - 5*2.5) / 6 = 164.58 -> 164.
    expect(multirowUniformTabWidthPx(1000, 8, 2.5)).toBe(164)
  })

  it('locked width preserves the full-row packing (no re-wrap knife-edge)', () => {
    for (let width = 320; width <= 2000; width += 7) {
      const tabsPerFullRow = Math.floor((width + GAP) / (150 + GAP))
      const locked = multirowUniformTabWidthPx(width, tabsPerFullRow + 1, GAP)
      expect(locked).not.toBeNull()
      // A full row of locked tabs still fits in the strip...
      expect(tabsPerFullRow * locked! + (tabsPerFullRow - 1) * GAP).toBeLessThanOrEqual(width)
      // ...and one more locked tab would not fit on that row.
      expect((tabsPerFullRow + 1) * locked! + tabsPerFullRow * GAP).toBeGreaterThan(width)
    }
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd /home/dan/code/freshell/.worktrees/multirow-last-row-width
npm run test:vitest -- run test/unit/client/lib/tab-bar-metrics.test.ts
```

Expected: **FAIL** — the named export does not exist yet. Typically the 9 existing tests pass and all 8 new tests fail with `TypeError: multirowUniformTabWidthPx is not a function`; depending on the module runner the missing named export may instead fail the whole file at import time. Either form is the required RED.

- [ ] **Step 3: Implement the width math**

In `src/lib/tab-bar-metrics.ts`, first update the `TAB_ROW_GAP_REM` JSDoc (line 12-13) — the width math is about to rely on it being the *horizontal* gap too. Replace:

```ts
/** Vertical gap between wrapped rows: the strip uses gap-0.5 (0.125rem). */
export const TAB_ROW_GAP_REM = 0.125
```

with:

```ts
/**
 * Gap between tabs: the strip uses gap-0.5 (0.125rem), which is BOTH the
 * vertical gap between wrapped rows and the horizontal gap between tabs
 * within a row (single `gap` shorthand).
 */
export const TAB_ROW_GAP_REM = 0.125
```

Then append at the end of the file (after `tabBarMultiRowThresholdPx`):

```ts
/**
 * Multirow tab width bounds. Deliberately absolute px — matching the Tailwind
 * `basis-[150px] min-w-[150px] max-w-[200px]` classes on the tab wrappers —
 * so tab WIDTHS do not scale with --ui-scale, unlike the rem-based row
 * heights above. The e2e suite asserts these exact px values at scale 1.
 */
export const MULTIROW_TAB_MIN_WIDTH_PX = 150
export const MULTIROW_TAB_MAX_WIDTH_PX = 200

/**
 * Uniform per-tab width for a wrapped (2+ row) multirow strip, or null when
 * the lock must not apply (all tabs fit on one row, or the width is unknown).
 *
 * The width is derived from the FULL rows: pack as many tabs as fit at the
 * 150px minimum, stretch them to fill the row, cap at 200px — then apply that
 * same width to every tab, so a partial last row ends short of the right edge
 * instead of stretching wider than the rows above.
 *
 * `Math.floor` guards the re-wrap knife-edge: rounding up would push a full
 * row past the container width and drop its last tab onto the next row,
 * oscillating on every ResizeObserver tick.
 *
 * Pure px math — callers pass the strip's clientWidth and the gap in px
 * (TAB_ROW_GAP_REM * root font-size); this function never reads the DOM.
 */
export function multirowUniformTabWidthPx(
  containerWidthPx: number,
  tabCount: number,
  gapPx: number,
): number | null {
  if (containerWidthPx <= 0 || tabCount <= 0) return null
  const tabsPerFullRow = Math.max(
    1,
    Math.floor((containerWidthPx + gapPx) / (MULTIROW_TAB_MIN_WIDTH_PX + gapPx)),
  )
  if (tabCount <= tabsPerFullRow) return null
  const stretched = (containerWidthPx - (tabsPerFullRow - 1) * gapPx) / tabsPerFullRow
  return Math.max(
    MULTIROW_TAB_MIN_WIDTH_PX,
    Math.min(MULTIROW_TAB_MAX_WIDTH_PX, Math.floor(stretched)),
  )
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/lib/tab-bar-metrics.test.ts
```

Expected: **PASS** — `Test Files 1 passed (1)`, `Tests 17 passed (17)` (9 existing + 8 new).

- [ ] **Step 5: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/multirow-last-row-width
git add src/lib/tab-bar-metrics.ts test/unit/client/lib/tab-bar-metrics.test.ts
git commit -m "fix(tabs): add multirowUniformTabWidthPx full-row width math"
```

---

### Task 2: Apply the uniform width in `TabBar.tsx`

**Files:**
- Modify: `src/components/TabBar.tsx` (import block :46-49; `SortableTab` props interface ~:73; `SortableTab` style/className ~:118-142; measurement effect ~:456-478; `renderSortableTab` pass site ~:361 and its deps array ~:401-418 — line anchors are pre-change positions, verify against the quoted code)
- Test: `test/unit/client/components/TabBar.multirow.test.tsx` (extend `describe('tab widths')` at :272-295)

**Interfaces:**
- Consumes (from Task 1): `multirowUniformTabWidthPx(containerWidthPx: number, tabCount: number, gapPx: number): number | null`, plus existing `TAB_ROW_GAP_REM: number` and `getRootFontSizePx(): number` from `@/lib/tab-bar-metrics`.
- Produces (the DOM contract Task 3's e2e measures): when multirow tabs wrap to 2+ rows, every direct child `<div>` of `[data-testid="tab-strip"]` carries inline `style.width = '<N>px'` (same integer N for all) and class `shrink-0`, with NO `grow`/`basis-[150px]`/`max-w-[200px]` classes; when all tabs fit one row, the classes remain exactly `grow basis-[150px] min-w-[150px] max-w-[200px]` with no inline width. `SortableTab` gains required prop `uniformWidthPx: number | null`.

- [ ] **Step 1: Write the failing test (plus one pin test for the single-row branch)**

In `test/unit/client/components/TabBar.multirow.test.tsx`, add these two tests inside the existing `describe('tab widths', () => { ... })` block (after the `'sizes tabs between 150px and 200px in multirow mode'` test). They reuse the file's existing `createTab`, `createStore`, `renderWithStore` helpers and the established `vi.spyOn(Element.prototype, ..., 'get')` geometry-faking idiom:

```tsx
    it('locks every tab to the full-row width when tabs wrap to multiple rows', () => {
      // Fake geometry (jsdom has no layout): a 1000px-wide strip whose content
      // wraps (scrollHeight 67 > the 2-row threshold at a 16px root).
      const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000)
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      try {
        const tabs = Array.from({ length: 8 }, (_, i) =>
          createTab({ id: `tab-${i + 1}`, title: `Tab ${i + 1}` }),
        )
        const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        const strip = screen.getByTestId('tab-strip')
        const wrappers = Array.from(strip.children) as HTMLElement[]
        expect(wrappers.length).toBe(8)
        for (const wrapper of wrappers) {
          // 1000px strip, 2px gap -> 6 tabs per full row -> floor((1000 - 5*2)/6) = 165.
          expect(wrapper.style.width).toBe('165px')
          expect(wrapper.className).toContain('shrink-0')
          expect(wrapper.className).not.toContain('grow')
          expect(wrapper.className).not.toContain('basis-[150px]')
          expect(wrapper.className).not.toContain('max-w-[200px]')
        }
      } finally {
        clientWidthSpy.mockRestore()
        scrollHeightSpy.mockRestore()
      }
    })

    it('keeps stretch-to-fill when all tabs fit on a single multirow row', () => {
      // 1000px strip fits 6 tabs per row; 3 tabs -> single row -> no width lock.
      const clientWidthSpy = vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(1000)
      try {
        const tabs = [
          createTab({ id: 'tab-1', title: 'Tab 1' }),
          createTab({ id: 'tab-2', title: 'Tab 2' }),
          createTab({ id: 'tab-3', title: 'Tab 3' }),
        ]
        const store = createStore({ tabs, activeTabId: 'tab-1', multirowTabs: true })
        renderWithStore(<TabBar />, store)
        const wrapper = screen.getByTestId('tab-strip').firstElementChild as HTMLElement
        expect(wrapper.style.width).toBe('')
        expect(wrapper.className).toContain('grow')
        expect(wrapper.className).toContain('basis-[150px]')
        expect(wrapper.className).toContain('min-w-[150px]')
        expect(wrapper.className).toContain('max-w-[200px]')
      } finally {
        clientWidthSpy.mockRestore()
      }
    })
```

- [ ] **Step 2: Run the tests to verify the lock test fails (RED — this reproduces the bug's mechanism)**

```bash
cd /home/dan/code/freshell/.worktrees/multirow-last-row-width
npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx -t 'tab widths'
```

Expected: **1 failed, 3 passed**. The lock test fails at `expect(wrapper.style.width).toBe('165px')` with `expected '' to be '165px'` — today no width lock exists, every wrapper keeps the per-line stretch classes. The single-row pin test passes already (it guards the branch that must NOT change). The 2 pre-existing width tests pass.

- [ ] **Step 3: Implement the TabBar wiring (5 focused edits)**

**Edit 1 — import block.** Replace (currently `TabBar.tsx:47`):

```tsx
import { getRootFontSizePx, tabBarMultiRowThresholdPx, tabBarRowsToMaxHeightCss } from '@/lib/tab-bar-metrics'
```

with:

```tsx
import {
  TAB_ROW_GAP_REM,
  getRootFontSizePx,
  multirowUniformTabWidthPx,
  tabBarMultiRowThresholdPx,
  tabBarRowsToMaxHeightCss,
} from '@/lib/tab-bar-metrics'
```

**Edit 2 — `SortableTab` props.** In the `SortableTab` props interface (the one declaring `multirow: boolean`, ~`TabBar.tsx:73`), add directly below `multirow: boolean`:

```tsx
  /** Locked uniform width when the strip wraps to 2+ rows; null keeps CSS stretch-to-fill. */
  uniformWidthPx: number | null
```

Then add `uniformWidthPx` to `SortableTab`'s destructured parameters, alongside where `multirow` is destructured.

**Edit 3 — `SortableTab` style + className.** Replace the wrapper's style object (currently `TabBar.tsx:118-121`):

```tsx
  const style = {
    transform: DndCSS.Translate.toString(transform),
    transition: transition || 'transform 150ms ease',
  }
```

with:

```tsx
  const style = {
    transform: DndCSS.Translate.toString(transform),
    transition: transition || 'transform 150ms ease',
    // Locked uniform width (2+ wrapped rows). Inline style, never a Tailwind
    // class: the JIT cannot generate w-[Npx] from a computed value.
    ...(multirow && uniformWidthPx != null ? { width: `${uniformWidthPx}px` } : {}),
  }
```

and replace the wrapper's width classes (currently `TabBar.tsx:134-141`):

```tsx
      // Multirow: pack rows at a 150px minimum, stretch to fill the row, cap at 200px.
      // Single row: fixed 175px at all times; the strip scrolls horizontally.
      className={cn(
        multirow
          ? "grow basis-[150px] min-w-[150px] max-w-[200px]"
          : "w-[175px] shrink-0"
      )}
```

with:

```tsx
      // Multirow, wrapped to 2+ rows: every tab is locked to the full-row width
      // (multirowUniformTabWidthPx via the inline style above) so the partial
      // last row cannot stretch wider than the rows above.
      // Multirow, single row: pack at a 150px minimum, stretch to fill the row,
      // cap at 200px.
      // Single-row mode: fixed 175px at all times; the strip scrolls horizontally.
      className={cn(
        multirow
          ? uniformWidthPx != null
            ? "shrink-0"
            : "grow basis-[150px] min-w-[150px] max-w-[200px]"
          : "w-[175px] shrink-0"
      )}
```

**Edit 4 — measurement effect.** Replace the existing multiple-rows detection effect (currently `TabBar.tsx:456-478`):

```tsx
  // The resize handle only appears when the strip actually wraps to 2+ rows.
  const [hasMultipleRows, setHasMultipleRows] = useState(false)
  useEffect(() => {
    if (!multirowTabs) {
      setHasMultipleRows(false)
      return
    }
    const node = multirowContainerRef.current
    if (!node) return
    const update = () => {
      // Threshold computed at measure time from the live root font-size: scrollHeight
      // and threshold scale together under any --ui-scale, including the pre-hydration
      // window where the CSS fallback (1.25) still governs (child effects run before
      // App's useTheme effect writes --ui-scale; the scale write resizes the strip,
      // which re-fires the ResizeObserver and re-measures).
      setHasMultipleRows(node.scrollHeight > tabBarMultiRowThresholdPx(getRootFontSizePx()))
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [multirowTabs, tabs.length])
```

with:

```tsx
  // The resize handle only appears when the strip actually wraps to 2+ rows.
  const [hasMultipleRows, setHasMultipleRows] = useState(false)
  // Locked uniform tab width when the tabs wrap to 2+ rows; null = CSS stretch.
  const [uniformTabWidthPx, setUniformTabWidthPx] = useState<number | null>(null)
  useEffect(() => {
    if (!multirowTabs) {
      setHasMultipleRows(false)
      setUniformTabWidthPx(null)
      return
    }
    const node = multirowContainerRef.current
    if (!node) return
    const update = () => {
      // Threshold computed at measure time from the live root font-size: scrollHeight
      // and threshold scale together under any --ui-scale, including the pre-hydration
      // window where the CSS fallback (1.25) still governs (child effects run before
      // App's useTheme effect writes --ui-scale; the scale write resizes the strip,
      // which re-fires the ResizeObserver and re-measures).
      const rootFontSizePx = getRootFontSizePx()
      setHasMultipleRows(node.scrollHeight > tabBarMultiRowThresholdPx(rootFontSizePx))
      // Lock every tab to the full-row width whenever the tabs wrap to 2+ rows.
      // clientWidth excludes the overflow-y-auto scrollbar; a 0 measurement
      // (jsdom / pre-layout) makes the helper return null, keeping the CSS
      // stretch-to-fill classes. Scale changes re-fire the observer (above),
      // so the rem-based gap term stays fresh.
      setUniformTabWidthPx(
        multirowUniformTabWidthPx(node.clientWidth, tabs.length, TAB_ROW_GAP_REM * rootFontSizePx),
      )
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [multirowTabs, tabs.length])
```

**Edit 5 — thread the prop through `renderSortableTab`.** At the pass site (currently `TabBar.tsx:361`), directly below:

```tsx
        multirow={multirowTabs}
```

add:

```tsx
        uniformWidthPx={uniformTabWidthPx}
```

Then in `renderSortableTab`'s `useCallback` dependency array (currently `TabBar.tsx:401-418`, the array containing `multirowTabs` at ~line 412), add `uniformTabWidthPx` alongside `multirowTabs`. **This is mandatory and manual** — `react-hooks/exhaustive-deps` is warning-only here, and omitting it renders stale widths on live resize.

- [ ] **Step 4: Run the component tests to verify they pass**

```bash
npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx
```

Expected: **PASS** — `Tests 24 passed (24)` (22 existing + 2 new). Note the two pre-existing width tests pass untouched: the multirow one renders a single tab at jsdom `clientWidth` 0 → helper returns `null` → stretch classes; the single-row-mode one never enters the multirow branch.

- [ ] **Step 5: Run the full tab-bar unit slice and the client typecheck**

```bash
npm run test:vitest -- run \
  test/unit/client/lib/tab-bar-metrics.test.ts \
  test/unit/client/components/TabBar.multirow.test.tsx \
  test/unit/client/components/TabBar.test.tsx \
  test/unit/client/components/TabBar.overflow.test.tsx \
  test/unit/client/components/TabBar.mobile.test.tsx \
  test/unit/client/components/TabBarResizeHandle.test.tsx \
  test/unit/client/components/TabItem.test.tsx
npm run typecheck:client
```

Expected: all test files pass; typecheck exits 0 with no errors.

- [ ] **Step 6: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/multirow-last-row-width
git add src/components/TabBar.tsx test/unit/client/components/TabBar.multirow.test.tsx
git commit -m "fix(tabs): lock last-row multirow tabs to the full-row width"
```

---

### Task 3: E2E proof of the uniform-width invariant across rows

**Files:**
- Modify: `test/e2e-browser/specs/multirow-tabs.spec.ts` (append one test inside the existing `test.describe('Multi-row tabs', ...)` block)

**Interfaces:**
- Consumes (DOM contract from Task 2): direct child `<div>`s of `[data-testid="tab-strip"]` are the width-bearing tab wrappers; `[data-context="tab-add"]` is the + button; `harness.waitForTabCount(n)` waits for Redux tab count; multirow is the default mode.
- Produces: nothing consumed later — this is the terminal verification layer.

> The RED phase for this invariant was demonstrated against the real component in
> Task 2 Step 2 (the same DOM contract this spec measures, failing on unpatched
> code). This spec proves the production outcome in a real browser layout engine,
> where flex-wrap row assignment actually happens. It uses 11 tabs deliberately:
> 11 is prime, so the last row is a strict partial row for ANY tabs-per-row the
> viewport yields — the assertion `lastRowCount < firstRowCount` can never be
> defeated by an evenly-divisible packing.

- [ ] **Step 1: Write the e2e test**

Append inside `test.describe('Multi-row tabs', ...)` in `test/e2e-browser/specs/multirow-tabs.spec.ts` (after the `'single-row tabs are fixed at 175px'` test):

```ts
  test('last-row tabs match the width of the full rows above', async ({ freshellPage: page, harness }) => {
    // 11 tabs at a >=150px basis is >1650px of tabs — guaranteed to wrap to 2+
    // rows at the default 1280px viewport, with a strict partial last row
    // (11 is prime, so it never divides evenly into full rows).
    for (let i = 0; i < 10; i++) {
      await page.locator('[data-context="tab-add"]').click()
    }
    await harness.waitForTabCount(11)

    const wrappers = page.getByTestId('tab-strip').locator(':scope > div')
    await expect(wrappers).toHaveCount(11)

    const boxes: { x: number; y: number; width: number; height: number }[] = []
    for (let i = 0; i < 11; i++) {
      const box = await wrappers.nth(i).boundingBox()
      expect(box).not.toBeNull()
      boxes.push(box!)
    }

    // Recover rows from geometry: tabs on the same wrapped row share a y.
    const rowYs = [...new Set(boxes.map((b) => Math.round(b.y)))].sort((a, b) => a - b)
    expect(rowYs.length).toBeGreaterThanOrEqual(2) // the scenario really wraps

    const tabsPerRow = rowYs.map((y) => boxes.filter((b) => Math.round(b.y) === y).length)
    const lastRowCount = tabsPerRow[tabsPerRow.length - 1]
    // The bug's trigger condition: the bottom row is a strict partial row.
    expect(lastRowCount).toBeLessThan(tabsPerRow[0])

    // THE invariant: every tab — full rows AND the partial last row — renders
    // at the same width (1px tolerance for sub-pixel rounding).
    const widths = boxes.map((b) => b.width)
    const minWidth = Math.min(...widths)
    const maxWidth = Math.max(...widths)
    expect(maxWidth - minWidth).toBeLessThanOrEqual(1)

    // The locked width still respects the multirow 150-200px bounds.
    expect(minWidth).toBeGreaterThanOrEqual(149)
    expect(maxWidth).toBeLessThanOrEqual(201)

    // And the partial last row ends short of the strip's right edge (it is
    // missing at least one >=150px tab relative to the full rows).
    const stripBox = await page.getByTestId('tab-strip').boundingBox()
    expect(stripBox).not.toBeNull()
    const lastRowY = rowYs[rowYs.length - 1]
    const lastRowRight = Math.max(
      ...boxes.filter((b) => Math.round(b.y) === lastRowY).map((b) => b.x + b.width),
    )
    expect(lastRowRight).toBeLessThan(stripBox!.x + stripBox!.width - 100)
  })
```

- [ ] **Step 2: Run the new e2e test**

```bash
cd /home/dan/code/freshell/.worktrees/multirow-last-row-width
npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs --project=chromium -g 'last-row tabs match'
```

Expected: **1 passed**. Note: `globalSetup` rebuilds `dist/` first (takes a few minutes). If `prebuild-guard` refuses because a production server holds the configured PORT, stop and report the conflict — do not kill the foreign holder (AGENTS.md test coordination).

- [ ] **Step 3: Run both tab-bar e2e suites for regression**

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs tab-bar-resize --project=chromium
```

Expected: **11 passed** (6 in `multirow-tabs.spec.ts` including the new test, 5 in `tab-bar-resize.spec.ts`). In particular these pre-existing tests must stay green untouched:
- `'multirow tabs render between 150 and 200px wide'` (2 tabs = single row → stretch-to-fill still applies, capped at 200px, within [149, 201]),
- `'single-row tabs are fixed at 175px'` (multirow=false path unchanged),
- the 20-tab and 10-tab resize-handle tests (row heights and handle behavior are independent of the width lock).

- [ ] **Step 4: Final unit + lint sweep**

```bash
npm run test:vitest -- run \
  test/unit/client/lib/tab-bar-metrics.test.ts \
  test/unit/client/components/TabBar.multirow.test.tsx \
  test/unit/client/components/TabBar.test.tsx \
  test/unit/client/components/TabBar.overflow.test.tsx \
  test/unit/client/components/TabBar.mobile.test.tsx \
  test/unit/client/components/TabBarResizeHandle.test.tsx \
  test/unit/client/components/TabItem.test.tsx
npm run lint
```

Expected: all test files pass; `npm run lint` exits 0 (a11y linting is a CI requirement).

- [ ] **Step 5: Commit**

```bash
cd /home/dan/code/freshell/.worktrees/multirow-last-row-width
git add test/e2e-browser/specs/multirow-tabs.spec.ts
git commit -m "test(e2e): cover uniform multirow tab width across wrapped rows"
```

---

## Spec Coverage Map

| Spec requirement | Covering task(s) | Production proof |
|---|---|---|
| Last-row tabs locked to exactly the full-row width | Task 1 (math), Task 2 (application) | Task 3 e2e: all 11 wrappers measure equal width in a real browser |
| Width computed from full rows: min 150px, fit as many as possible, stretch to fill, 200px cap | Task 1 | Unit: `165` @ W=1000, cap case `200` @ W=450, floor case, min-clamp case, packing invariant loop; Task 3 e2e bounds check [149, 201] |
| Uniform width applied to ALL tabs; last row ends short of the right edge | Task 2, Task 3 | Task 3 e2e: partial-row precondition (`lastRowCount < firstRowCount`) + equal widths + last-row right edge short of strip edge |
| Single row in multirow mode keeps stretch-to-fill as-is | Task 1 (`null` return), Task 2 (pin test) | Existing e2e `'multirow tabs render between 150 and 200px wide'` (2 tabs, one row) stays green in Task 3 Step 3 |
| Single-row mode (multirow=false) fixed 175px unchanged | No code change (branch untouched) | Existing unit test `'fixes tabs at 175px in single-row mode'` + existing e2e `'single-row tabs are fixed at 175px'` re-run green in Tasks 2/3 |
| Unit + e2e coverage of the uniform-width invariant (repo TDD conventions) | Tasks 1–3 | Red-green at unit level (Task 1 Step 2, Task 2 Step 2); e2e invariant test in Task 3 |

No stubs, mocks-as-deliverables, or deferred behavior remain: the jsdom geometry spies in Task 2 are test scaffolding for a unit environment without layout, and the real behavior is proven end-to-end in Task 3 against the production DOM in chromium.
