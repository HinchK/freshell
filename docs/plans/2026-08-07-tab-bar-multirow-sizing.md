# Tab Bar Multirow Sizing Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Make multirow tabs the default, give tabs mode-specific widths (multirow: 150–200px stretch-to-fill; single-row: fixed 175px), and let users drag-resize how many tab rows are visible (default 3), persisted per-browser.

**Architecture:** All changes are in the browser client. The multirow setting `panes.multirowTabs` already exists as a browser-local setting (persisted in the `freshell.browser-preferences.v1` localStorage blob, never sent to the server) — we flip its default. A new sibling local setting `panes.tabBarRows` (default 3, clamp 1–10) drives an inline `max-height` on the tab strip, replacing the hard-coded `max-h-32` Tailwind class. A new `TabBarResizeHandle` component wraps the existing `PaneDivider` splitter (the same one used for pane splits and sidebar width) at the bottom edge of the tab bar, converting drag deltas to row counts.

**Tech Stack:** React 18 + Redux Toolkit + Tailwind (client under `src/`), shared settings contract in `shared/settings.ts`, Vitest + Testing Library (jsdom) for unit tests under `test/unit/`, Playwright for e2e under `test/e2e-browser/specs/`.

## Global Constraints

- Repo root for all work: the worktree `/home/dan/code/freshell/.worktrees/tab-bar-multirow-sizing`. All commands below run from this directory.
- Multirow tab bar setting defaults to **TRUE** (spec item 1).
- Multirow tab width: minimum **150px**, stretch to fill the row, maximum **200px** (spec item 2).
- Single-row tab width: fixed **175px** at all times (spec item 3).
- Resizable tab bar height only when multirow is on AND more than one row of tabs exists; default **exactly 3 rows**; user can drag to more or fewer rows (spec item 4).
- The height/row-count setting persists **per-browser locally** (localStorage-backed browser preferences), **never** in server-side config (spec item 4). The server settings patch schema is `.strict()` and must keep rejecting these keys.
- Red-Green-Refactor TDD is mandatory (AGENTS.md); every behavior change gets unit AND e2e coverage.
- `console.error` is fatal in unit tests (`test/setup/dom.ts` throws in afterEach).
- Tailwind JIT cannot see interpolated class names — dynamic heights MUST use inline `style`, never `` `max-h-${n}` ``.
- Do not run `gh pr create` or push to `origin/main` (AGENTS.md).
- README.md is the only end-user markdown doc; do not create new user-facing .md files. `docs/index.html` (the marketing mock) must reflect the new default (major user-facing UI change).
- Commit after every task with a focused conventional-commit message.

**Test commands used throughout** (verified working in this repo):

```bash
# Single unit test file (fast, uncoordinated path)
npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx

# Whole unit suite (coordinated; waits on the shared test lock)
npm run test:unit

# Single e2e spec, chromium only (a real run rebuilds dist/ via globalSetup)
npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs --project=chromium

# Lint + typecheck
npm run lint && npm run typecheck
```

## File Structure

| File | Role |
|---|---|
| `shared/settings.ts` | Modify: flip `multirowTabs` default; add `tabBarRows` (type, local-key registration, default, seed normalizer, min/max/default constants) |
| `src/store/browserPreferencesPersistence.ts` | Modify: `assignChangedScalar` line for `tabBarRows` (without it the value is silently dropped on write) |
| `src/lib/tab-bar-metrics.ts` | **Create**: pure row-count ⇄ pixel-height conversion helpers + layout constants |
| `src/components/panes/PaneDivider.tsx` | Modify: optional `keyboardStep` and `ariaLabel` props (backward compatible) |
| `src/components/TabBarResizeHandle.tsx` | **Create**: drag/keyboard handle that converts PaneDivider deltas into row counts |
| `src/components/TabBar.tsx` | Modify: selector fallback, mode-specific tab widths, inline strip max-height, multiple-row detection, render handle |
| `src/components/settings/PanesSettings.tsx` | Modify: toggle fallback `?? false` → `?? true` |
| `docs/index.html` | Modify: flip the Multi-row tabs mock switch to "on" |
| `test/unit/shared/settings.test.ts` | Modify: default flip; add `panes.tabBarRows` describe block |
| `test/unit/client/store/browserPreferencesPersistence.test.ts` | Modify: round-trip tests for `tabBarRows` and opt-out `multirowTabs: false` |
| `test/unit/client/lib/tab-bar-metrics.test.ts` | **Create**: metrics unit tests |
| `test/unit/client/components/panes/PaneDivider.test.tsx` | Modify: tests for `keyboardStep` / `ariaLabel` |
| `test/unit/client/components/TabBarResizeHandle.test.tsx` | **Create**: handle component tests |
| `test/unit/client/components/TabBar.multirow.test.tsx` | Modify: default flip, width tests, max-height tests, handle integration tests |
| `test/unit/client/components/TabBar.test.tsx` / `TabBar.mobile.test.tsx` | Modify only if the default flip or width change breaks assumptions (make stores explicit) |
| `test/e2e-browser/specs/multirow-tabs.spec.ts` | Modify: default flip, width assertions, max-height assertion |
| `test/e2e-browser/specs/tab-bar-resize.spec.ts` | **Create**: drag/keyboard resize + persistence e2e |

Scope note: this is one subsystem (client tab bar + its local settings plumbing), so a single plan is appropriate. There is deliberately **no** Settings-UI row for `tabBarRows` — the drag handle is the control the spec asks for (YAGNI), and the setting still gets full persistence, validation, and cross-tab sync by living in `LocalSettings.panes`.

Key reference points in current code (line numbers approximate; the code excerpts are the source of truth):

- Tab width (both modes today): `src/components/TabBar.tsx` inside `SortableTab` — `className="w-[180px] min-w-[100px] shrink"`.
- Drag ghost width: `src/components/TabBar.tsx` inside `<DragOverlay>` — `className="w-[180px]"`.
- Strip conditional: `src/components/TabBar.tsx` `data-testid="tab-strip"` div — multirow branch `"flex-wrap max-h-32 overflow-y-auto"`.
- Setting default: `shared/settings.ts` `defaultLocalSettings.panes.multirowTabs: false` (~line 893).
- Selector: `src/components/TabBar.tsx` — `const multirowTabs = useAppSelector((s) => s.settings?.settings?.panes?.multirowTabs ?? false)` (~line 201/320 depending on revision).

Row-height math used everywhere below: a tab row is `h-8` = 32px, wrapped rows are separated by `gap-0.5` = 2px, the strip has `pt-px` = 1px top padding. So **maxHeight(n rows) = 32n + 2(n−1) + 1 = 34n − 1**: 1 row → 33px, 2 → 67px, 3 → **101px**, 4 → 135px, 5 → 169px, 10 → 339px.

---

### Task 1: Flip the multirow default to TRUE

**Files:**
- Modify: `shared/settings.ts` (defaultLocalSettings.panes.multirowTabs, ~line 893)
- Modify: `src/components/TabBar.tsx` (selector fallback)
- Modify: `src/components/settings/PanesSettings.tsx` (toggle fallback, ~line 82)
- Modify: `docs/index.html` (mock switch state)
- Test: `test/unit/shared/settings.test.ts` (~lines 566–568)
- Test: `test/unit/client/components/TabBar.multirow.test.tsx`
- Test: `test/unit/client/components/TabBar.test.tsx`, `test/unit/client/components/TabBar.mobile.test.tsx` (only if broken by the flip)
- Test: `test/unit/client/store/browserPreferencesPersistence.test.ts`
- Test: `test/e2e-browser/specs/multirow-tabs.spec.ts`

**Interfaces:**
- Consumes: existing `panes.multirowTabs: boolean` local setting.
- Produces: `resolveLocalSettings(undefined).panes.multirowTabs === true`. All later tasks assume multirow is the default. Users who explicitly turn it OFF get `multirowTabs: false` persisted (it now differs from the default, so `assignChangedScalar` writes it).

Why this is safe for existing users: the browser-preferences blob stores only diffs vs defaults. Under the old default (`false`), choosing OFF stored nothing, so no browser holds a stale `multirowTabs: false`; users who chose ON hold `true`, which matches the new default. Flipping the one canonical default takes effect everywhere.

- [ ] **Step 1: Write the failing test (RED)**

In `test/unit/shared/settings.test.ts`, find:

```ts
  it('defaults multirowTabs to false in resolved local settings', () => {
    expect(resolveLocalSettings(undefined).panes.multirowTabs).toBe(false)
  })
```

Replace with:

```ts
  it('defaults multirowTabs to true in resolved local settings', () => {
    expect(resolveLocalSettings(undefined).panes.multirowTabs).toBe(true)
  })
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts`
Expected: FAIL — `expected false to be true` on the new test.

- [ ] **Step 3: Flip the default and the inline fallbacks (GREEN)**

In `shared/settings.ts`, `defaultLocalSettings.panes`:

```ts
  panes: {
    snapThreshold: 2,
    iconsOnTabs: true,
    tabAttentionStyle: 'highlight',
    attentionDismiss: 'click',
    sessionOpenMode: 'tab',
    multirowTabs: true,
    repoIconsOnTabs: true,
  },
```

In `src/components/TabBar.tsx`, change the selector fallback:

```ts
  const multirowTabs = useAppSelector((s) => s.settings?.settings?.panes?.multirowTabs ?? true)
```

In `src/components/settings/PanesSettings.tsx`, the Multi-row tabs `Toggle`:

```tsx
            checked={settings.panes?.multirowTabs ?? true}
```

- [ ] **Step 4: Run the shared settings tests**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts`
Expected: PASS (all tests — the other multirowTabs tests use explicit patches and are unaffected).

- [ ] **Step 5: Add a persistence test for opting out (RED)**

In `test/unit/client/store/browserPreferencesPersistence.test.ts`, add inside the `describe('browserPreferencesPersistence', ...)` block (the file's harness — `createStore()`, fake timers, `BROWSER_PREFERENCES_STORAGE_KEY`, `BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS` — is already imported at the top):

```ts
  it('persists an explicit multirowTabs=false now that the default is true', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { multirowTabs: false } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.multirowTabs).toBe(false)
  })
```

Run: `npm run test:vitest -- run test/unit/client/store/browserPreferencesPersistence.test.ts`
Expected: PASS immediately IF Step 3 landed (this test documents the new opt-out behavior; it fails against the old default because `false === false` was omitted). If it passes, fine — keep it; it locks in the user's ability to opt out persistently.

- [ ] **Step 6: Fix the TabBar unit tests that encoded the old default**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx`
Expected: FAIL — the tests whose names end in "(default)" (around lines 107, 116, 161, 194) assert single-row classes but now render multirow.

In `test/unit/client/components/TabBar.multirow.test.tsx`:

(a) Make the store helper accept an explicit boolean instead of "truthy means on". Replace the `localSettings` construction inside `createStore` (currently `options.multirowTabs ? { panes: { multirowTabs: true } } : undefined`) with:

```ts
  const localSettings = resolveLocalSettings(
    options.multirowTabs === undefined
      ? undefined
      : { panes: { multirowTabs: options.multirowTabs } },
  )
```

and widen the option type from `multirowTabs?: boolean` (truthy-only usage) to explicit `multirowTabs?: boolean` semantics — no signature change needed, just the construction above.

(b) For each test currently named "... (default)" that asserts **single-row** behavior (e.g. wrapper `h-12 md:h-10`, strip `overflow-x-auto`, no `flex-wrap`): pass `multirowTabs: false` explicitly in its `createStore(...)` options and rename "(default)" to "(single-row)" in the test title.

(c) Add one new test locking in the new default (reuse the same tab fixtures the neighboring tests pass to `createStore` — the factory already defined at the top of this file):

```tsx
  it('defaults to multirow mode when no local settings are stored', () => {
    const store = createStore({ tabs: [/* same single-tab fixture the (single-row) tests use */], activeTabId: /* that tab's id */, })
    renderWithStore(<TabBar />, store)
    const strip = screen.getByTestId('tab-strip')
    expect(strip.className).toContain('flex-wrap')
    expect(strip.className).not.toContain('overflow-x-auto')
  })
```

- [ ] **Step 7: Run the whole components test directory; make any other stale assumptions explicit**

Run: `npm run test:vitest -- run test/unit/client/components/`
Expected: PASS. If `TabBar.test.tsx` or `TabBar.mobile.test.tsx` fail because their stores resolve default settings (now multirow — e.g. scroll-arrow tests, `h-12 md:h-10` wrapper assertions), apply the same fix as Step 6(a)/(b): build those stores' `localSettings` with an explicit `{ panes: { multirowTabs: false } }` so single-row-specific tests keep testing single-row behavior. Do NOT weaken any assertion; only make the mode explicit. (Note: `TabBar.mobile.test.tsx` exercises `MobileTabStrip`, which TabBar renders on mobile regardless of multirow, so it is likely already green.)

- [ ] **Step 8: Update the e2e spec for the new default**

In `test/e2e-browser/specs/multirow-tabs.spec.ts`:

Test 1 — the toggle now starts checked; flip the interaction:

```ts
  test('disables multi-row tabs via settings toggle', async ({ freshellPage: page }) => {
    await openSettings(page)

    const toggle = page.getByRole('switch', { name: /multi-row tabs/i })
    await expect(toggle).toBeVisible({ timeout: 5_000 })
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect(toggle).not.toBeChecked()
  })
```

Test 2 ('multi-row mode applies flex-wrap to tab strip') — leave as is for now (the dispatch of `multirowTabs: true` is now redundant but harmless; the `max-h-32` assertion changes in Task 5).

Test 3 — single-row is no longer the default; dispatch it explicitly first:

```ts
  test('single-row mode uses overflow-x-auto', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { multirowTabs: false } },
      })
    })

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toBeVisible({ timeout: 5_000 })
    await expect(tabStrip).toHaveClass(/overflow-x-auto/)
    await expect(tabStrip).not.toHaveClass(/flex-wrap/)
  })
```

- [ ] **Step 9: Run the e2e spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs --project=chromium`
Expected: 3 passed.

- [ ] **Step 10: Flip the docs mock switch**

Run `grep -n "Multi-row tabs" docs/index.html` (expected: a `settings-row` around lines 1039–1042). Change the switch button in that row from:

```html
<button class="settings-switch" type="button" role="switch" aria-checked="false" aria-label="Multi-row tabs"></button>
```

to:

```html
<button class="settings-switch on" type="button" role="switch" aria-checked="true" aria-label="Multi-row tabs"></button>
```

(This mirrors how the already-on rows like "Icons on tabs" are marked in the same file.)

- [ ] **Step 11: Commit**

```bash
git add shared/settings.ts src/components/TabBar.tsx src/components/settings/PanesSettings.tsx docs/index.html \
  test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts \
  test/unit/client/components/
git commit -m "feat(tabs): default multi-row tab bar to on"
```

---

### Task 2: Add the `panes.tabBarRows` browser-local setting

**Files:**
- Modify: `shared/settings.ts` (constants, `PANES_LOCAL_KEYS`, `LocalSettings['panes']` type, `normalizeExtractedLocalSeed` panes block, `defaultLocalSettings.panes`)
- Modify: `src/store/browserPreferencesPersistence.ts` (panes block of `buildLocalSettingsPatch`)
- Test: `test/unit/shared/settings.test.ts`
- Test: `test/unit/client/store/browserPreferencesPersistence.test.ts`

**Interfaces:**
- Consumes: existing helpers `normalizeRoundedClampedNumber(value: unknown, min: number, max: number): number | undefined`, `assignChangedScalar(patch, current, defaults, key)`, `mergeDefined`.
- Produces (used by Tasks 3, 5, 7):
  - `LocalSettings['panes']` gains `tabBarRows: number`.
  - Exported constants from `shared/settings.ts`: `TAB_BAR_ROWS_MIN = 1`, `TAB_BAR_ROWS_MAX = 10`, `TAB_BAR_ROWS_DEFAULT = 3`.
  - `resolveLocalSettings(undefined).panes.tabBarRows === 3`; patches merge like every other pane key; value round-trips through the browser-preferences blob.

- [ ] **Step 1: Write the failing tests (RED)**

In `test/unit/shared/settings.test.ts`, after the `describe('panes.repoIconsOnTabs (browser-local)', ...)` block, add (all helpers used are already imported at the top of this file):

```ts
  describe('panes.tabBarRows (browser-local)', () => {
    it('defaults to 3', () => {
      expect(resolveLocalSettings(undefined).panes.tabBarRows).toBe(3)
    })

    it('applies a numeric patch', () => {
      expect(resolveLocalSettings({ panes: { tabBarRows: 5 } }).panes.tabBarRows).toBe(5)
    })

    it('merges patches preserving other pane keys', () => {
      const merged = mergeLocalSettings(
        { panes: { multirowTabs: false } },
        { panes: { tabBarRows: 6 } },
      )
      expect(merged.panes?.multirowTabs).toBe(false)
      expect(merged.panes?.tabBarRows).toBe(6)
    })

    it('rounds and clamps tabBarRows in legacy seed extraction', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: { tabBarRows: 4.4 },
      } as Record<string, unknown>)).toEqual({ panes: { tabBarRows: 4 } })
      expect(extractLegacyLocalSettingsSeed({
        panes: { tabBarRows: 42 },
      } as Record<string, unknown>)).toEqual({ panes: { tabBarRows: 10 } })
    })

    it('rejects a non-numeric tabBarRows in legacy seed extraction', () => {
      expect(extractLegacyLocalSettingsSeed({
        panes: { tabBarRows: 'lots' },
      } as Record<string, unknown>)).toEqual(undefined)
    })

    it('is rejected by the server patch schema (stays local)', () => {
      const schema = buildServerSettingsPatchSchema()
      expect(schema.safeParse({ panes: { tabBarRows: 5 } }).success).toBe(false)
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts`
Expected: FAIL — TypeScript/type errors or `undefined` for `tabBarRows` (the key doesn't exist yet). The server-schema test passes already (`.strict()` rejects unknown keys) — that's fine; it's a lock-in test.

- [ ] **Step 3: Implement the setting in `shared/settings.ts` (GREEN)**

(a) Constants — next to `PANE_SNAP_THRESHOLD_MIN`/`PANE_SNAP_THRESHOLD_MAX` (~lines 64–65):

```ts
export const TAB_BAR_ROWS_MIN = 1
export const TAB_BAR_ROWS_MAX = 10
export const TAB_BAR_ROWS_DEFAULT = 3
```

(b) Register as a browser-local pane key (~line 82) — `PANES_LOCAL_KEYS` becomes:

```ts
const PANES_LOCAL_KEYS = ['snapThreshold', 'iconsOnTabs', 'tabAttentionStyle', 'attentionDismiss', 'sessionOpenMode', 'multirowTabs', 'repoIconsOnTabs', 'tabBarRows'] as const
```

(c) Type — in the `panes` block of the local settings type (~lines 205–213), add:

```ts
    tabBarRows: number
```

(If `LocalSettingsPatch` is hand-written rather than derived, add `tabBarRows?: number` there too — `npm run typecheck` will tell you.)

(d) Seed normalizer — in `normalizeExtractedLocalSeed`'s `isRecord(patch.panes)` block, after the `multirowTabs` boolean guard, add (mirroring the `snapThreshold` handling at the top of the same block):

```ts
    const normalizedTabBarRows = normalizeRoundedClampedNumber(
      patch.panes.tabBarRows,
      TAB_BAR_ROWS_MIN,
      TAB_BAR_ROWS_MAX,
    )
    if (normalizedTabBarRows !== undefined) {
      panes.tabBarRows = normalizedTabBarRows
    }
```

(e) Default — in `defaultLocalSettings.panes` (~line 893 area), after `multirowTabs: true,` add:

```ts
    tabBarRows: TAB_BAR_ROWS_DEFAULT,
```

- [ ] **Step 4: Run the shared tests**

Run: `npm run test:vitest -- run test/unit/shared/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing persistence round-trip tests (RED)**

In `test/unit/client/store/browserPreferencesPersistence.test.ts`, add:

```ts
  it('persists panes.tabBarRows when it differs from the default', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { tabBarRows: 5 } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.tabBarRows).toBe(5)
  })

  it('omits panes.tabBarRows at its default value', () => {
    const store = createStore()

    store.dispatch(updateSettingsLocal({ panes: { tabBarRows: 3, snapThreshold: 4 } }))
    vi.advanceTimersByTime(BROWSER_PREFERENCES_PERSIST_DEBOUNCE_MS)

    const blob = JSON.parse(localStorage.getItem(BROWSER_PREFERENCES_STORAGE_KEY) || '{}')
    expect(blob.settings?.panes?.snapThreshold).toBe(4)
    expect(blob.settings?.panes?.tabBarRows).toBeUndefined()
  })
```

Run: `npm run test:vitest -- run test/unit/client/store/browserPreferencesPersistence.test.ts`
Expected: FAIL on the first test — `tabBarRows` is silently dropped because `buildLocalSettingsPatch` has no line for it. **This failure is the point**: it proves the test catches the single easiest thing to forget.

- [ ] **Step 6: Add the persistence line (GREEN)**

In `src/store/browserPreferencesPersistence.ts`, in the `panes` block of `buildLocalSettingsPatch`, after the `multirowTabs` line, add:

```ts
  assignChangedScalar(panes, localSettings.panes, defaultLocalSettings.panes, 'tabBarRows')
```

- [ ] **Step 7: Run tests + typecheck**

Run: `npm run test:vitest -- run test/unit/client/store/browserPreferencesPersistence.test.ts && npm run typecheck`
Expected: PASS / no type errors. (Typecheck also proves no other site needs the new key — `mergeDefined` and `resolveLocalSettings` pick it up automatically via `defaultLocalSettings.panes`.)

- [ ] **Step 8: Commit**

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts \
  test/unit/shared/settings.test.ts test/unit/client/store/browserPreferencesPersistence.test.ts
git commit -m "feat(tabs): add browser-local panes.tabBarRows setting (default 3, clamp 1-10)"
```

---

### Task 3: Tab bar metrics module (rows ⇄ pixels)

**Files:**
- Create: `src/lib/tab-bar-metrics.ts`
- Test: `test/unit/client/lib/tab-bar-metrics.test.ts`

**Interfaces:**
- Consumes: `TAB_BAR_ROWS_MIN`, `TAB_BAR_ROWS_MAX` from `@shared/settings` (Task 2).
- Produces (used by Tasks 5, 6, 7):
  - `tabBarRowsToMaxHeightPx(rows: number): number` — clamped; 3 → 101.
  - `tabBarHeightPxToRows(px: number): number` — nearest row, clamped to 1–10.
  - `TAB_BAR_KEYBOARD_STEP_PX = 34` (one row per arrow press).
  - `TAB_BAR_MULTI_ROW_THRESHOLD_PX = 35` (strip scrollHeight above this ⇒ >1 row).

- [ ] **Step 1: Write the failing tests (RED)**

Create `test/unit/client/lib/tab-bar-metrics.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import {
  TAB_BAR_KEYBOARD_STEP_PX,
  TAB_BAR_MULTI_ROW_THRESHOLD_PX,
  tabBarHeightPxToRows,
  tabBarRowsToMaxHeightPx,
} from '@/lib/tab-bar-metrics'

describe('tab-bar-metrics', () => {
  it('computes the strip max-height for a row count (34n - 1)', () => {
    expect(tabBarRowsToMaxHeightPx(1)).toBe(33)
    expect(tabBarRowsToMaxHeightPx(2)).toBe(67)
    expect(tabBarRowsToMaxHeightPx(3)).toBe(101)
    expect(tabBarRowsToMaxHeightPx(5)).toBe(169)
  })

  it('clamps the row count to the allowed range', () => {
    expect(tabBarRowsToMaxHeightPx(0)).toBe(33)
    expect(tabBarRowsToMaxHeightPx(99)).toBe(339)
  })

  it('is inverted by tabBarHeightPxToRows', () => {
    for (const rows of [1, 2, 3, 5, 10]) {
      expect(tabBarHeightPxToRows(tabBarRowsToMaxHeightPx(rows))).toBe(rows)
    }
  })

  it('rounds a mid-drag height to the nearest row', () => {
    expect(tabBarHeightPxToRows(117)).toBe(3)
    expect(tabBarHeightPxToRows(118)).toBe(4)
  })

  it('clamps heights outside the range', () => {
    expect(tabBarHeightPxToRows(-50)).toBe(1)
    expect(tabBarHeightPxToRows(10_000)).toBe(10)
  })

  it('keyboard step is exactly one row pitch', () => {
    expect(TAB_BAR_KEYBOARD_STEP_PX).toBe(34)
  })

  it('single-row threshold sits between one and two rows', () => {
    expect(TAB_BAR_MULTI_ROW_THRESHOLD_PX).toBeGreaterThan(33)
    expect(TAB_BAR_MULTI_ROW_THRESHOLD_PX).toBeLessThan(67)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/client/lib/tab-bar-metrics.test.ts`
Expected: FAIL — module `@/lib/tab-bar-metrics` does not exist.

- [ ] **Step 3: Implement the module (GREEN)**

Create `src/lib/tab-bar-metrics.ts`:

```ts
import { TAB_BAR_ROWS_MAX, TAB_BAR_ROWS_MIN } from '@shared/settings'

/** Height of one tab row: TabItem is h-8 (32px). */
export const TAB_ROW_HEIGHT_PX = 32
/** Vertical gap between wrapped rows: the strip uses gap-0.5 (2px). */
export const TAB_ROW_GAP_PX = 2
/** Top padding of the strip: pt-px (1px). */
export const TAB_STRIP_TOP_PADDING_PX = 1
/** One keyboard arrow press on the resize handle moves exactly one row. */
export const TAB_BAR_KEYBOARD_STEP_PX = TAB_ROW_HEIGHT_PX + TAB_ROW_GAP_PX
/** A strip whose scrollHeight exceeds this is rendering more than one row. */
export const TAB_BAR_MULTI_ROW_THRESHOLD_PX =
  TAB_ROW_HEIGHT_PX + TAB_STRIP_TOP_PADDING_PX + TAB_ROW_GAP_PX

function clampRows(rows: number): number {
  return Math.min(TAB_BAR_ROWS_MAX, Math.max(TAB_BAR_ROWS_MIN, Math.round(rows)))
}

/** Max-height in px of the tab strip when showing `rows` full rows. */
export function tabBarRowsToMaxHeightPx(rows: number): number {
  const clamped = clampRows(rows)
  return clamped * TAB_ROW_HEIGHT_PX + (clamped - 1) * TAB_ROW_GAP_PX + TAB_STRIP_TOP_PADDING_PX
}

/** Nearest row count for a strip height in px (inverse of tabBarRowsToMaxHeightPx). */
export function tabBarHeightPxToRows(px: number): number {
  return clampRows(
    (px + TAB_ROW_GAP_PX - TAB_STRIP_TOP_PADDING_PX) / (TAB_ROW_HEIGHT_PX + TAB_ROW_GAP_PX),
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/lib/tab-bar-metrics.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/tab-bar-metrics.ts test/unit/client/lib/tab-bar-metrics.test.ts
git commit -m "feat(tabs): add tab bar row/pixel metrics helpers"
```

---

### Task 4: Mode-specific tab widths (multirow 150–200 stretch, single-row fixed 175)

**Files:**
- Modify: `src/components/TabBar.tsx` (`SortableTabProps`, `SortableTab` wrapper className, `renderSortableTab` call site, `DragOverlay` width)
- Test: `test/unit/client/components/TabBar.multirow.test.tsx`
- Test: `test/e2e-browser/specs/multirow-tabs.spec.ts`
- Test (conditional): any other unit test asserting `w-[180px]` / `min-w-[100px]`

**Interfaces:**
- Consumes: `multirowTabs` selector value already in `TabBar`.
- Produces: `SortableTab` gains a required `multirow: boolean` prop. Tab wrapper classes become the visual contract asserted by tests: multirow → `grow basis-[150px] min-w-[150px] max-w-[200px]`; single-row → `w-[175px] shrink-0`.

Why this satisfies the spec: in the flex-wrap strip, `flex-basis: 150px` makes the row pack as many tabs as fit at the 150px minimum; `flex-grow: 1` then stretches that row's tabs equally to the right edge; `max-width: 200px` caps the stretch. In single-row mode `w-[175px] shrink-0` fixes every tab at exactly 175px — the strip scrolls horizontally when they overflow.

- [ ] **Step 1: Write the failing width tests (RED)**

In `test/unit/client/components/TabBar.multirow.test.tsx`, add a `describe('tab widths', ...)` block (reuse the file's existing tab fixture/factory and `createStore`/`renderWithStore` helpers exactly as the neighboring tests do):

```tsx
  describe('tab widths', () => {
    it('fixes tabs at 175px in single-row mode', () => {
      const store = createStore({ tabs: [/* existing single-tab fixture */], activeTabId: /* its id */, multirowTabs: false })
      renderWithStore(<TabBar />, store)
      const wrapper = screen.getByTestId('tab-strip').firstElementChild as HTMLElement
      expect(wrapper.className).toContain('w-[175px]')
      expect(wrapper.className).toContain('shrink-0')
      expect(wrapper.className).not.toContain('grow')
      expect(wrapper.className).not.toContain('max-w-[200px]')
    })

    it('sizes tabs between 150px and 200px in multirow mode', () => {
      const store = createStore({ tabs: [/* existing single-tab fixture */], activeTabId: /* its id */, multirowTabs: true })
      renderWithStore(<TabBar />, store)
      const wrapper = screen.getByTestId('tab-strip').firstElementChild as HTMLElement
      expect(wrapper.className).toContain('grow')
      expect(wrapper.className).toContain('basis-[150px]')
      expect(wrapper.className).toContain('min-w-[150px]')
      expect(wrapper.className).toContain('max-w-[200px]')
      expect(wrapper.className).not.toContain('w-[175px]')
    })
  })
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx`
Expected: FAIL — wrapper className is `w-[180px] min-w-[100px] shrink` in both tests.

- [ ] **Step 3: Implement the width change (GREEN)**

In `src/components/TabBar.tsx`:

(a) Add `multirow: boolean` to `SortableTabProps` and to the `SortableTab` destructuring:

```ts
interface SortableTabProps {
  tab: Tab
  displayTitle: string
  isActive: boolean
  needsAttention: boolean
  busy: boolean
  busyPaneIds: string[]
  isDragging: boolean
  isRenaming: boolean
  renameValue: string
  multirow: boolean
  paneEntries?: Array<{ paneId: string; content: PaneContent; repoCwd?: string }>
  iconsOnTabs?: boolean
  repoIconsOnTabs?: boolean
  repoIcons?: Record<string, RepoIconInfo>
  tabAttentionStyle?: TabAttentionStyle
  onRenameChange: (value: string) => void
  onRenameBlur: () => void
  onRenameKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void
  onClose: (e: React.MouseEvent<HTMLButtonElement>) => void
  onClick: () => void
  onDoubleClick: () => void
}
```

(b) Replace the wrapper div's comment + className in `SortableTab` (currently `// Uniform tab width: 180px ...` and `className="w-[180px] min-w-[100px] shrink"`) with:

```tsx
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      // Multirow: pack rows at a 150px minimum, stretch to fill the row, cap at 200px.
      // Single row: fixed 175px at all times; the strip scrolls horizontally.
      className={cn(
        multirow
          ? "grow basis-[150px] min-w-[150px] max-w-[200px]"
          : "w-[175px] shrink-0"
      )}
    >
```

(`cn` is already imported in this file.)

(c) In `renderSortableTab` (the function inside the `TabBar` component that renders `<SortableTab ...>` for each tab), pass the new prop:

```tsx
      multirow={multirowTabs}
```

(d) In the `<DragOverlay>` block, change the ghost width `className="w-[180px]"` to:

```tsx
              className="w-[175px]"
```

(The ghost is a fixed-size floating copy; 175px sits inside the multirow 150–200 range and exactly matches single-row tabs.)

- [ ] **Step 4: Run the unit tests**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Sweep other tests for the old width literals**

Run: `grep -rn "w-\[180px\]\|min-w-\[100px\]" test/ src/`
Expected: no matches in `src/`. For any test match, update the assertion to the new contract from Step 3 (single-row `w-[175px]` + `shrink-0`; multirow `basis-[150px]` etc.; drag ghost `w-[175px]`). Then run the full components directory:

Run: `npm run test:vitest -- run test/unit/client/components/`
Expected: PASS.

- [ ] **Step 6: Add e2e width coverage (RED against old build, GREEN with this change)**

Append to `test/e2e-browser/specs/multirow-tabs.spec.ts` inside the `test.describe('Multi-row tabs', ...)` block:

```ts
  test('multirow tabs render between 150 and 200px wide', async ({ freshellPage: page, harness }) => {
    await page.locator('[data-context="tab-add"]').click()
    await harness.waitForTabCount(2)

    const firstTab = page.getByTestId('tab-strip').locator(':scope > div').first()
    await expect(firstTab).toBeVisible()
    const box = await firstTab.boundingBox()
    expect(box).not.toBeNull()
    expect(box!.width).toBeGreaterThanOrEqual(149)
    expect(box!.width).toBeLessThanOrEqual(201)
  })

  test('single-row tabs are fixed at 175px', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { multirowTabs: false } },
      })
    })

    const firstTab = page.getByTestId('tab-strip').locator(':scope > div').first()
    await expect(firstTab).toBeVisible()
    const box = await firstTab.boundingBox()
    expect(box).not.toBeNull()
    expect(Math.round(box!.width)).toBe(175)
  })
```

- [ ] **Step 7: Run the e2e spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs --project=chromium`
Expected: 5 passed.

- [ ] **Step 8: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/ test/e2e-browser/specs/multirow-tabs.spec.ts
git commit -m "feat(tabs): mode-specific tab widths (multirow 150-200px stretch, single-row fixed 175px)"
```

---

### Task 5: Drive the strip's visible height from `panes.tabBarRows`

**Files:**
- Modify: `src/components/TabBar.tsx` (new selector, strip className/style)
- Test: `test/unit/client/components/TabBar.multirow.test.tsx`
- Test: `test/e2e-browser/specs/multirow-tabs.spec.ts`

**Interfaces:**
- Consumes: `panes.tabBarRows` (Task 2), `tabBarRowsToMaxHeightPx` + `TAB_BAR_ROWS_DEFAULT` (Tasks 2–3).
- Produces: the strip (`data-testid="tab-strip"`) exposes `style.maxHeight = '<34n-1>px'` in multirow mode (101px at the default 3 rows) and no inline max-height in single-row mode. `max-h-32` is gone. Task 7's handle changes rows and this maxHeight follows via Redux.

- [ ] **Step 1: Write/adjust the failing unit tests (RED)**

In `test/unit/client/components/TabBar.multirow.test.tsx`:

(a) Update the existing test (~line 147) `'applies h-auto to the outer wrapper and max-h-32 to the tab strip when multirowTabs is enabled'` — rename to `'applies h-auto to the outer wrapper and a 3-row max-height to the tab strip when multirowTabs is enabled'`, keep its `h-auto` wrapper assertion, and replace the `max-h-32` strip assertion with:

```tsx
      const strip = screen.getByTestId('tab-strip')
      expect(strip.className).not.toContain('max-h-32')
      expect(strip.style.maxHeight).toBe('101px')
```

(b) Add two new tests:

```tsx
  it('derives the strip max-height from panes.tabBarRows', () => {
    const store = createStore({ tabs: [/* existing fixture */], activeTabId: /* its id */, multirowTabs: true, tabBarRows: 5 })
    renderWithStore(<TabBar />, store)
    expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('169px')
  })

  it('applies no inline max-height in single-row mode', () => {
    const store = createStore({ tabs: [/* existing fixture */], activeTabId: /* its id */, multirowTabs: false })
    renderWithStore(<TabBar />, store)
    expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('')
  })
```

(c) Extend `createStore` to accept `tabBarRows?: number` — build the panes patch explicitly:

```ts
function buildPanesPatch(options: { multirowTabs?: boolean; tabBarRows?: number }) {
  const panes: { multirowTabs?: boolean; tabBarRows?: number } = {}
  if (options.multirowTabs !== undefined) panes.multirowTabs = options.multirowTabs
  if (options.tabBarRows !== undefined) panes.tabBarRows = options.tabBarRows
  return Object.keys(panes).length > 0 ? { panes } : undefined
}
```

and in `createStore`: `const localSettings = resolveLocalSettings(buildPanesPatch(options))` (this replaces Task 1 Step 6(a)'s construction; keep the explicit-boolean semantics).

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx`
Expected: FAIL — strip still has `max-h-32`, `style.maxHeight` is `''`.

- [ ] **Step 3: Implement (GREEN)**

In `src/components/TabBar.tsx`:

(a) Imports:

```ts
import { TAB_BAR_ROWS_DEFAULT } from '@shared/settings'
import { tabBarRowsToMaxHeightPx } from '@/lib/tab-bar-metrics'
```

(If this file does not already import from `@shared/settings`, keep the alias — it is the same alias the stores and tests use.)

(b) Selector, next to the `multirowTabs` selector:

```ts
  const tabBarRows = useAppSelector((s) => s.settings?.settings?.panes?.tabBarRows ?? TAB_BAR_ROWS_DEFAULT)
```

(c) The strip div — remove `max-h-32` from the multirow branch and add the inline style:

```tsx
          <div
            ref={combinedRef}
            data-testid="tab-strip"
            className={cn(
              "flex items-end gap-0.5 pt-px flex-1 min-w-0",
              multirowTabs
                ? "flex-wrap overflow-y-auto"
                : "overflow-x-auto overflow-y-hidden scrollbar-none"
            )}
            style={multirowTabs ? { maxHeight: tabBarRowsToMaxHeightPx(tabBarRows) } : undefined}
          >
            {tabs.map(renderSortableTab)}
          </div>
```

- [ ] **Step 4: Run the unit tests; sweep for `max-h-32`**

Run: `npm run test:vitest -- run test/unit/client/components/ && grep -rn "max-h-32" src/ test/unit/`
Expected: tests PASS; grep finds no remaining `max-h-32` in `src/` or `test/unit/` (fix any stragglers to the new inline-style contract).

- [ ] **Step 5: Update the e2e max-height assertion**

In `test/e2e-browser/specs/multirow-tabs.spec.ts`, test `'multi-row mode applies flex-wrap to tab strip'`: replace `await expect(tabStrip).toHaveClass(/max-h-32/)` with:

```ts
    await expect(tabStrip).toHaveCSS('max-height', '101px')
```

- [ ] **Step 6: Run the e2e spec**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs --project=chromium`
Expected: 5 passed.

- [ ] **Step 7: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/ test/e2e-browser/specs/multirow-tabs.spec.ts
git commit -m "feat(tabs): size the multirow tab strip from the tabBarRows setting"
```

---

### Task 6: `TabBarResizeHandle` component (+ PaneDivider `keyboardStep`/`ariaLabel` props)

**Files:**
- Modify: `src/components/panes/PaneDivider.tsx`
- Create: `src/components/TabBarResizeHandle.tsx`
- Test: `test/unit/client/components/panes/PaneDivider.test.tsx`
- Test: `test/unit/client/components/TabBarResizeHandle.test.tsx`

**Interfaces:**
- Consumes: `PaneDivider` (delta-based `onResize(delta, shiftHeld?)`, `onResizeEnd()`, document-level mouse/touch listeners, keyboard arrows), metrics from Task 3.
- Produces (used by Task 7):
  - `PaneDivider` gains optional `keyboardStep?: number` (px per arrow press, default 10 — existing consumers unchanged) and `ariaLabel?: string` (defaults to the existing generic label).
  - `TabBarResizeHandle` with props `{ rows: number; onRowsChange: (rows: number) => void }`; renders an absolutely-positioned hover splitter (`data-testid="tab-bar-resize-handle"`, accessible name `"Resize tab bar height"`) straddling the tab bar's bottom edge.

- [ ] **Step 1: Write the failing PaneDivider prop tests (RED)**

In `test/unit/client/components/panes/PaneDivider.test.tsx`, add (matching the file's existing render/fireEvent conventions):

```tsx
  it('uses a custom keyboardStep when provided', () => {
    const onResize = vi.fn()
    render(
      <PaneDivider direction="vertical" onResize={onResize} onResizeEnd={vi.fn()} keyboardStep={34} />,
    )
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' })
    expect(onResize).toHaveBeenCalledWith(34)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    expect(onResize).toHaveBeenCalledWith(-34)
  })

  it('uses a custom aria-label when provided', () => {
    render(
      <PaneDivider direction="vertical" onResize={vi.fn()} onResizeEnd={vi.fn()} ariaLabel="Resize tab bar height" />,
    )
    expect(screen.getByRole('separator', { name: 'Resize tab bar height' })).toBeTruthy()
  })
```

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneDivider.test.tsx`
Expected: FAIL — unknown props / step is 10 / name mismatch.

- [ ] **Step 2: Implement the PaneDivider props (GREEN)**

In `src/components/panes/PaneDivider.tsx`:

(a) Props interface gains:

```ts
  /** Pixels per keyboard arrow press (default 10). */
  keyboardStep?: number
  /** Accessible name; defaults to the generic pane divider label. */
  ariaLabel?: string
```

(b) Destructure with defaults: `keyboardStep = 10, ariaLabel,`.

(c) In `handleKeyDown`, replace `const step = 10 // keyboard resize step in pixels` with:

```ts
    const step = keyboardStep
```

and add `keyboardStep` to the `useCallback` dependency array: `[direction, onResize, onResizeEnd, keyboardStep]`.

(d) On the root div, replace the `aria-label` value with:

```tsx
      aria-label={ariaLabel ?? `Pane divider (${direction === 'horizontal' ? 'horizontal' : 'vertical'} resize)`}
```

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneDivider.test.tsx`
Expected: PASS (all existing tests too — defaults preserve current behavior).

- [ ] **Step 3: Write the failing TabBarResizeHandle tests (RED)**

Create `test/unit/client/components/TabBarResizeHandle.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import TabBarResizeHandle from '@/components/TabBarResizeHandle'

afterEach(() => {
  cleanup()
})

describe('TabBarResizeHandle', () => {
  it('renders an accessible separator', () => {
    render(<TabBarResizeHandle rows={3} onRowsChange={vi.fn()} />)
    expect(screen.getByRole('separator', { name: 'Resize tab bar height' })).toBeTruthy()
    expect(screen.getByTestId('tab-bar-resize-handle')).toBeTruthy()
  })

  it('adds a row per ArrowDown press', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowDown' })
    expect(onRowsChange).toHaveBeenCalledWith(4)
  })

  it('removes a row per ArrowUp press', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    expect(onRowsChange).toHaveBeenCalledWith(2)
  })

  it('never goes below one row', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={1} onRowsChange={onRowsChange} />)
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowUp' })
    expect(onRowsChange).not.toHaveBeenCalled()
  })

  it('converts a mouse drag into row changes', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { clientY: 200 })
    fireEvent.mouseMove(document, { clientY: 268 }) // +68px = +2 rows
    fireEvent.mouseUp(document)

    expect(onRowsChange).toHaveBeenLastCalledWith(5)
  })

  it('drags back up to shrink', () => {
    const onRowsChange = vi.fn()
    render(<TabBarResizeHandle rows={3} onRowsChange={onRowsChange} />)
    const separator = screen.getByRole('separator')

    fireEvent.mouseDown(separator, { clientY: 200 })
    fireEvent.mouseMove(document, { clientY: 166 }) // -34px = -1 row
    fireEvent.mouseUp(document)

    expect(onRowsChange).toHaveBeenLastCalledWith(2)
  })
})
```

Run: `npm run test:vitest -- run test/unit/client/components/TabBarResizeHandle.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement the component (GREEN)**

Create `src/components/TabBarResizeHandle.tsx`:

```tsx
import { useCallback, useEffect, useRef } from 'react'

import { PaneDivider } from '@/components/panes'
import {
  TAB_BAR_KEYBOARD_STEP_PX,
  tabBarHeightPxToRows,
  tabBarRowsToMaxHeightPx,
} from '@/lib/tab-bar-metrics'

interface TabBarResizeHandleProps {
  /** Currently persisted visible row count. */
  rows: number
  /** Called with the new clamped row count whenever a drag/keypress crosses a row boundary. */
  onRowsChange: (rows: number) => void
}

/**
 * Hover splitter at the bottom edge of the multirow tab bar. Converts
 * PaneDivider's incremental pixel deltas into whole-row changes.
 */
export default function TabBarResizeHandle({ rows, onRowsChange }: TabBarResizeHandleProps) {
  // Accumulated height in px during an active drag; null when idle.
  const dragPxRef = useRef<number | null>(null)
  const rowsRef = useRef(rows)
  useEffect(() => {
    rowsRef.current = rows
  }, [rows])

  const handleResize = useCallback((delta: number) => {
    const base = dragPxRef.current ?? tabBarRowsToMaxHeightPx(rowsRef.current)
    const next = base + delta
    dragPxRef.current = next
    const nextRows = tabBarHeightPxToRows(next)
    if (nextRows !== rowsRef.current) {
      rowsRef.current = nextRows
      onRowsChange(nextRows)
    }
  }, [onRowsChange])

  const handleResizeEnd = useCallback(() => {
    dragPxRef.current = null
  }, [])

  return (
    <div
      className="absolute inset-x-0 bottom-0 z-30 translate-y-1/2"
      data-testid="tab-bar-resize-handle"
    >
      <PaneDivider
        direction="vertical"
        onResize={handleResize}
        onResizeEnd={handleResizeEnd}
        keyboardStep={TAB_BAR_KEYBOARD_STEP_PX}
        ariaLabel="Resize tab bar height"
      />
    </div>
  )
}
```

(`PaneDivider` is exported from the barrel `src/components/panes/index.ts`. Note `onResizeEnd` fires after every keyboard step too, which resets the accumulator — that is exactly why `keyboardStep` is one full row pitch, 34px.)

- [ ] **Step 5: Run the tests**

Run: `npm run test:vitest -- run test/unit/client/components/TabBarResizeHandle.test.tsx test/unit/client/components/panes/PaneDivider.test.tsx`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/components/panes/PaneDivider.tsx src/components/TabBarResizeHandle.tsx \
  test/unit/client/components/panes/PaneDivider.test.tsx test/unit/client/components/TabBarResizeHandle.test.tsx
git commit -m "feat(tabs): tab bar resize handle built on PaneDivider (keyboardStep, ariaLabel)"
```

---

### Task 7: Integrate the resize handle into TabBar

**Files:**
- Modify: `src/components/TabBar.tsx`
- Test: `test/unit/client/components/TabBar.multirow.test.tsx`

**Interfaces:**
- Consumes: `TabBarResizeHandle` (Task 6), `TAB_BAR_MULTI_ROW_THRESHOLD_PX` (Task 3), `updateSettingsLocal` from `@/store/settingsSlice`, the strip node via the existing `multirowContainerRef`.
- Produces: handle rendered only when `multirowTabs && hasMultipleRows`; dragging/keying it dispatches `updateSettingsLocal({ panes: { tabBarRows } })`, which re-renders the strip max-height (Task 5) and persists via the browser-preferences middleware (Task 2).

- [ ] **Step 1: Write the failing integration tests (RED)**

In `test/unit/client/components/TabBar.multirow.test.tsx`, add a `describe('tab bar resize handle', ...)` block. jsdom reports `scrollHeight` as 0, so mock it where multiple rows are needed:

```tsx
  describe('tab bar resize handle', () => {
    it('does not render in single-row mode', () => {
      const store = createStore({ tabs: [/* fixture */], activeTabId: /* id */, multirowTabs: false })
      renderWithStore(<TabBar />, store)
      expect(screen.queryByTestId('tab-bar-resize-handle')).toBeNull()
    })

    it('does not render when tabs fit in one row', () => {
      // jsdom scrollHeight is 0 -> below the multi-row threshold.
      const store = createStore({ tabs: [/* fixture */], activeTabId: /* id */, multirowTabs: true })
      renderWithStore(<TabBar />, store)
      expect(screen.queryByTestId('tab-bar-resize-handle')).toBeNull()
    })

    it('renders when the strip wraps to multiple rows', () => {
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      try {
        const store = createStore({ tabs: [/* fixture */], activeTabId: /* id */, multirowTabs: true })
        renderWithStore(<TabBar />, store)
        expect(screen.getByTestId('tab-bar-resize-handle')).toBeTruthy()
      } finally {
        scrollHeightSpy.mockRestore()
      }
    })

    it('keyboard-resizing the handle updates the strip max-height via the store', () => {
      const scrollHeightSpy = vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockReturnValue(67)
      try {
        const store = createStore({ tabs: [/* fixture */], activeTabId: /* id */, multirowTabs: true })
        renderWithStore(<TabBar />, store)
        expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('101px')

        fireEvent.keyDown(screen.getByRole('separator', { name: 'Resize tab bar height' }), { key: 'ArrowDown' })

        expect(screen.getByTestId('tab-strip').style.maxHeight).toBe('135px')
        expect(store.getState().settings.localSettings.panes.tabBarRows).toBe(4)
      } finally {
        scrollHeightSpy.mockRestore()
      }
    })
  })
```

(Add `fireEvent` to the existing `@testing-library/react` import if not present.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx`
Expected: FAIL — no `tab-bar-resize-handle` is ever rendered.

- [ ] **Step 3: Implement the integration (GREEN)**

In `src/components/TabBar.tsx`:

(a) Imports:

```ts
import { useState } from 'react' // merge into the existing react import
import TabBarResizeHandle from '@/components/TabBarResizeHandle'
import { TAB_BAR_MULTI_ROW_THRESHOLD_PX } from '@/lib/tab-bar-metrics' // merge with the Task 5 import
import { updateSettingsLocal } from '@/store/settingsSlice'
```

(b) Multi-row detection — after the `combinedRef` definition (which stores the strip node in `multirowContainerRef`):

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
      setHasMultipleRows(node.scrollHeight > TAB_BAR_MULTI_ROW_THRESHOLD_PX)
    }
    update()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(update)
    observer.observe(node)
    return () => observer.disconnect()
  }, [multirowTabs, tabs.length])
```

(The `typeof ResizeObserver === 'undefined'` guard copies `src/components/Sidebar.tsx`'s jsdom-safety pattern; the `tabs.length` dependency re-measures when tabs are added/removed, since that changes `scrollHeight` without firing a resize.)

(c) Dispatch callback, near the other `useCallback`s:

```tsx
  const handleTabBarRowsChange = useCallback((rows: number) => {
    dispatch(updateSettingsLocal({ panes: { tabBarRows: rows } }))
  }, [dispatch])
```

(d) Render the handle inside the outer wrapper div (the one with `relative z-20 shrink-0 flex items-end px-2 bg-background`), as its last child — after `</DndContext>`, before the closing `</div>`:

```tsx
      {multirowTabs && hasMultipleRows && (
        <TabBarResizeHandle rows={tabBarRows} onRowsChange={handleTabBarRowsChange} />
      )}
```

(The wrapper is `relative`, so the handle's `absolute inset-x-0 bottom-0 translate-y-1/2` straddles the bar's bottom edge; `z-30` keeps it above the 1px bottom rule and the pane area below.)

- [ ] **Step 4: Run the tests**

Run: `npm run test:vitest -- run test/unit/client/components/TabBar.multirow.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite + quality gates**

Run: `npm run test:unit && npm run lint && npm run typecheck`
Expected: PASS / clean. (Watch for `console.error`-fatal failures from the new effect — none expected.)

- [ ] **Step 6: Commit**

```bash
git add src/components/TabBar.tsx test/unit/client/components/TabBar.multirow.test.tsx
git commit -m "feat(tabs): drag-resizable multirow tab bar height (default 3 rows)"
```

---

### Task 8: E2E coverage for resize + persistence

**Files:**
- Create: `test/e2e-browser/specs/tab-bar-resize.spec.ts`

**Interfaces:**
- Consumes: fixtures `test`/`expect` from `../helpers/fixtures.js` (`freshellPage`, `harness`), the `[data-context="tab-add"]` button, `data-testid="tab-strip"` / `tab-bar-resize-handle`, the `Resize tab bar height` separator, the test harness dispatch.
- Produces: end-user proof of spec item 4 — default 3 rows, drag to reveal more/fewer, per-browser persistence across reload, handle hidden with a single row.

- [ ] **Step 1: Write the spec**

Create `test/e2e-browser/specs/tab-bar-resize.spec.ts`:

```ts
import { test, expect } from '../helpers/fixtures.js'

test.describe('Tab bar height resize', () => {
  test('defaults to 3 visible rows and drags to reveal more', async ({ freshellPage: page, harness }) => {
    // Create enough tabs to wrap into 3+ rows at any desktop viewport width
    // (20 tabs x >=150px basis is >= 3000px of tabs).
    for (let i = 0; i < 19; i++) {
      await page.locator('[data-context="tab-add"]').click()
    }
    await harness.waitForTabCount(20)

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toHaveClass(/flex-wrap/)
    // Default: exactly 3 rows visible (3*32 + 2*2 + 1 = 101px).
    await expect(tabStrip).toHaveCSS('max-height', '101px')

    const handle = page.getByRole('separator', { name: 'Resize tab bar height' })
    await expect(handle).toBeVisible()

    const box = await handle.boundingBox()
    expect(box).not.toBeNull()
    const startX = box!.x + box!.width / 2
    const startY = box!.y + box!.height / 2
    await page.mouse.move(startX, startY)
    await page.mouse.down()
    await page.mouse.move(startX, startY + 68, { steps: 4 }) // +2 rows
    await page.mouse.up()

    // 5 rows: 5*32 + 4*2 + 1 = 169px.
    await expect(tabStrip).toHaveCSS('max-height', '169px')
  })

  test('keyboard arrows resize one row at a time (fewer than default)', async ({ freshellPage: page, harness }) => {
    for (let i = 0; i < 9; i++) {
      await page.locator('[data-context="tab-add"]').click()
    }
    await harness.waitForTabCount(10)

    const tabStrip = page.getByTestId('tab-strip')
    await expect(tabStrip).toHaveCSS('max-height', '101px')

    const handle = page.getByRole('separator', { name: 'Resize tab bar height' })
    await expect(handle).toBeVisible()
    await handle.focus()
    await page.keyboard.press('ArrowUp')

    // 2 rows: 2*32 + 1*2 + 1 = 67px.
    await expect(tabStrip).toHaveCSS('max-height', '67px')
  })

  test('persists the chosen row count across reloads', async ({ freshellPage: page }) => {
    await page.evaluate(() => {
      window.__FRESHELL_TEST_HARNESS__?.dispatch({
        type: 'settings/updateSettingsLocal',
        payload: { panes: { tabBarRows: 5 } },
      })
    })
    await expect(page.getByTestId('tab-strip')).toHaveCSS('max-height', '169px')

    // The browser-preferences middleware flushes on pagehide, so a reload persists it.
    await page.reload()
    await expect(page.getByTestId('tab-strip')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('tab-strip')).toHaveCSS('max-height', '169px')
  })

  test('hides the resize handle when tabs fit in a single row', async ({ freshellPage: page }) => {
    await expect(page.getByTestId('tab-strip')).toBeVisible()
    await expect(page.getByTestId('tab-bar-resize-handle')).toHaveCount(0)
  })
})
```

- [ ] **Step 2: Run it**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts tab-bar-resize --project=chromium`
Expected: 4 passed. If the drag test is flaky on row math (sub-pixel handle position), adjust only the drag distance (`+68`), never the assertions.

- [ ] **Step 3: Run the neighboring spec too (regression)**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs --project=chromium`
Expected: 5 passed.

- [ ] **Step 4: Commit**

```bash
git add test/e2e-browser/specs/tab-bar-resize.spec.ts
git commit -m "test(e2e): tab bar height resize, keyboard steps, and per-browser persistence"
```

---

### Task 9: Full verification sweep + screenshot baselines

**Files:**
- Possibly modify: `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/*` (regenerated), any straggler test surfaced by the full runs.

**Interfaces:**
- Consumes: everything above.
- Produces: a fully green tree — unit, lint, typecheck, touched e2e, and refreshed visual baselines that reflect the new defaults.

- [ ] **Step 1: Full unit suite + gates**

Run: `npm run test:unit && npm run lint && npm run typecheck`
Expected: PASS / clean. Fix any straggler test that still assumes single-row default, 180px tabs, or `max-h-32` using the explicit-mode patterns from Tasks 1/4/5 (check `test/e2e/*.test.tsx` jsdom app-flow tests in particular).

- [ ] **Step 2: Check settings-related e2e for default assumptions**

Run: `grep -rln "multirowTabs\|multi-row" test/e2e-browser/specs/`
Expected: `multirow-tabs.spec.ts`, `tab-bar-resize.spec.ts`, and possibly `settings-persistence-split.spec.ts`. Run every match:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts multirow-tabs tab-bar-resize settings-persistence-split --project=chromium
```

Expected: all pass. If `settings-persistence-split.spec.ts` used `multirowTabs: true` as its "non-default local value" sample, switch that sample to `multirowTabs: false` (now the non-default) or `tabBarRows: 5`, keeping the test's intent identical.

- [ ] **Step 3: Screenshot baselines**

The Settings→Panes visual baseline shows the Multi-row toggle (now on by default), and any main-view baseline shows tab widths (180 → up to 200px):

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts screenshot-baselines --project=chromium
```

If it fails ONLY with diffs matching our intended changes (toggle on, tab width), regenerate and eyeball the new images:

```bash
npx playwright test --config test/e2e-browser/playwright.config.ts screenshot-baselines --project=chromium --update-snapshots
```

Expected: pass on re-run. Any diff NOT explained by this feature is a regression — stop and fix it instead of updating the baseline.

- [ ] **Step 4: Commit any fixups/baselines**

```bash
git add -A test/
git commit -m "test: refresh baselines and default-mode assumptions for multirow tab bar"
```

(Skip the commit if Steps 1–3 produced no changes.)

---

## Self-Review (completed by the plan author)

1. **Spec coverage:** (1) default TRUE → Task 1; (2) multirow min 150 / stretch / max 200 → Task 4; (3) single-row fixed 175 → Task 4; (4) resizable height, hover splitter at bottom edge, default exactly 3 rows, drag to more or fewer rows, per-browser localStorage persistence (not server config) → Tasks 2, 3, 5, 6, 7, with e2e proof in Task 8 (drag more, keyboard fewer, reload persistence, hidden when one row). Docs note (multirow-by-default is a major UI change) → Task 1 Step 10.
2. **No silent deferrals:** every requirement lands as production behavior verified by real-browser e2e (widths via boundingBox, height via computed CSS, persistence via reload); the only mock is jsdom's `scrollHeight` in unit tests, and the production behavior it stands in for is proven by Task 8's real-browser handle-visibility assertions.
3. **Placeholder scan:** the `/* fixture */` markers in unit-test snippets deliberately reuse the tab factory already defined in `TabBar.multirow.test.tsx` (named there, visible to the implementer in the same file) — every genuinely new API, class string, constant, and assertion is written out in full.
4. **Type consistency:** `tabBarRows: number` (Tasks 2→5→7→8), `tabBarRowsToMaxHeightPx`/`tabBarHeightPxToRows`/`TAB_BAR_KEYBOARD_STEP_PX`/`TAB_BAR_MULTI_ROW_THRESHOLD_PX` (Tasks 3→6→7), `TabBarResizeHandle({ rows, onRowsChange })` (Tasks 6→7), `PaneDivider` `keyboardStep`/`ariaLabel` (Task 6 only), width class strings identical across Task 4 code, unit tests, and e2e assertions; heights 33/67/101/135/169/339 consistent everywhere with maxHeight(n) = 34n − 1.
