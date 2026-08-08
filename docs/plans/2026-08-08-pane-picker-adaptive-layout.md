# Pane Picker Adaptive Layout Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

**Goal:** The new-pane picker arranges its option icons into balanced, center-weighted rows that adapt to the pane's shape (wide → fewer rows, tall → more rows) and fluidly scales tile/icon/label sizes to fit the pane, replacing the current fixed 3-per-row breakpoint layout.

**Architecture:** Extract the pure grid math into a testable library module (`src/lib/pane-picker-layout.ts`): a row-count chooser that maximizes tile size from pane pixel dimensions, and a balanced center-out row distributor (13 → 3-4-4-2, 10 → 3-4-3, tall 10 → 2-3-3-2). `PanePicker` measures its own size with a ResizeObserver, sets `--cols`/`--rows` CSS variables on a `container-type: size` root, and lets a container-query-unit tile formula (`min(width/cols, height/rows)`) scale all tiles fluidly in CSS. Visual chrome (padding, gap, icon, label) scales relative to the tile via CSS variables.

**Tech Stack:** React 18 + TypeScript, Tailwind + `@tailwindcss/container-queries` (existing), hand-written container-query CSS in `src/index.css` (existing pattern), Vitest + Testing Library.

## Global Constraints

- Server uses NodeNext/ESM; relative imports must include `.js` extensions. Client files use the `@/` alias (→ `src/`) for imports.
- Red-Green-Refactor TDD for every behavior change; never skip the red step or weaken tests.
- Do not change: option ordering/grouping logic, single-key shortcuts, arrow-key navigation semantics, the fade-on-select transition, or the `toolbar` role + `aria-label="Pane type picker"` (Playwright and e2e selectors depend on them).
- All interactive elements stay semantic `<button>`s with `aria-label`s (a11y is a CI requirement).
- No new dependencies. Tailwind's `@container` class sets `container-type: inline-size`; this plan needs both axes (`cqh`), so the picker root uses `container-type: size` instead.
- Update `docs/index.html` (nonfunctional mock) for this significant picker UI change.
- Work only in the worktree; focused commits per task.

## Requirements

- **R1 — Adaptive rows:** The picker chooses its row count from the pane's width and height so tiles are as large as possible: wide panes get fewer rows, tall panes get more rows. With no measurable size it falls back to a deterministic square-aspect layout.
- **R2 — Balanced distribution:** Options are distributed with extras in the middle rows (center-out). An even row count with a single leftover balances the middle pair by taking one from the last row, guarded so the last row never drops below `base−1 ≥ 2`. Examples the user approved: 13 → 3-4-4-2 (not 4-4-4-1), 10 → 3-4-3 (not 4-4-2), 10 tall → 2-3-3-2. Rows never contain zero items; a dangling singleton last row is avoided whenever `base ≥ 3`.
- **R3 — Fluid fit-to-pane sizing:** Tile size = `min(width − padding − gaps)/cols, (height − padding − gaps)/rows)` in container-query units (`cqw`/`cqh`), clamped 36–120px. Gap, padding, icon, and label scale relative to the tile. Icons/labels never overflow the pane.
- **R4 — Preserve behavior:** Option ordering, keyboard shortcuts, arrow navigation, Escape cancel, fade-on-select, Windows shell variants, and extension options behave exactly as before.
- **R5 — Evidence:** Pure-function unit tests for the layout math, component tests proving ResizeObserver-driven reflow and the fallback layout, updated existing row/responsive tests, a real-browser Playwright geometry spec for R3, docs mock updated, and the default-config unit suite + typecheck + lint green at the end.

---

### Task 1: Layout math library (`pane-picker-layout.ts`) with unit tests

**Requirements served:** R1, R2, R3

**Behavior:**
- `centerOutRowOrder(rowCount)` returns row indices in center-out order: `4 → [1,2,0,3]`, `3 → [1,0,2]`, `5 → [2,1,3,0,4]`, `6 → [2,3,1,4,0,5]`.
- `distributeRows(optionCount, rowCount)` returns an array of per-row sizes (top→bottom) summing to `optionCount`, base `floor(n/r)` everywhere plus extras to the first `rem` center-out rows; when `rowCount` is even, `rem === 1`, and `base >= 3`, instead bump both middle rows by 1 and subtract 1 from the last row (the 3-4-4-2 move). The `base >= 3` guard is required so the diamond move never drops the last row below `base - 1 >= 2` — with `base = 2` (e.g. 9 items in 4 rows) the move would create a trailing singleton `[2,3,3,1]`, so those cases take the ordinary center-out path (`[2,3,2,2]`).
- `chooseRowCount(optionCount, width, height)` returns the row count in `[1, optionCount]` maximizing `min(width/ceil(n/r), height/r)`; `width`/`height` ≤ 0 are treated as 1 (deterministic square-aspect fallback); ties resolve to the smaller row count.
- `computePanePickerLayout(optionCount, width, height)` returns `{ rowSizes, maxCols }` where `maxCols = Math.max(...rowSizes)`.

**Files:**
- Create: `src/lib/pane-picker-layout.ts`
- Test: `test/unit/client/lib/pane-picker-layout.test.ts`

**Interfaces:**
- Produces:
  - `export interface PanePickerGridLayout { rowSizes: number[]; maxCols: number }`
  - `export function centerOutRowOrder(rowCount: number): number[]`
  - `export function distributeRows(optionCount: number, rowCount: number): number[]`
  - `export function chooseRowCount(optionCount: number, width: number, height: number): number`
  - `export function computePanePickerLayout(optionCount: number, width: number, height: number): PanePickerGridLayout`

**Test cases:**
- `chooseRowCount(13, 480, 400)` → 4; `chooseRowCount(13, 640, 300)` → 3; `chooseRowCount(13, 300, 500)` → 5.
- `chooseRowCount(10, 480, 400)` → 3; `chooseRowCount(10, 300, 500)` → 4 (tie with 5 → smaller row count wins); `chooseRowCount(13, 0, 0)` → 4; `chooseRowCount(1, 100, 100)` → 1.
- `distributeRows(13, 4)` → `[3,4,4,2]`; `(10, 4)` → `[2,3,3,2]`; `(10, 3)` → `[3,4,3]`; `(11, 4)` → `[3,3,3,2]`; `(12, 4)` → `[3,3,3,3]`; `(14, 4)` → `[3,4,4,3]`; `(15, 4)` → `[4,4,4,3]`; `(13, 5)` → `[2,3,3,3,2]`; `(7, 3)` → `[2,3,2]` (center-heavy, unlike the old top-heavy `[3,2,2]`); `(7, 4)` → `[2,2,2,1]`; `(9, 4)` → `[2,3,2,2]` (base 2 → ordinary path, no trailing singleton); `(17, 4)` → `[4,5,5,3]`; `(9, 3)` → `[3,3,3]`; `(1, 1)` → `[1]`.
- Property sweep: for `n` in 1..30 and `r` in 1..n, `distributeRows(n, r)` sums to `n`, every row ≥ 1, and when `floor(n/r) >= 3` every row ≥ `floor(n/r) - 1` (no avoidable trailing singleton).
- `centerOutRowOrder(4)` → `[1,2,0,3]`; `(3)` → `[1,0,2]`; `(5)` → `[2,1,3,0,4]`; `(6)` → `[2,3,1,4,0,5]`.
- `computePanePickerLayout(13, 480, 400)` → `{ rowSizes: [3,4,4,2], maxCols: 4 }`; `(10, 300, 500)` → `{ rowSizes: [2,3,3,2], maxCols: 3 }`.

- [ ] **Step 1: Write the failing behavioral test**

Create `test/unit/client/lib/pane-picker-layout.test.ts` importing the four functions above from `@/lib/pane-picker-layout`. Cover every case in **Test cases** (exact array equality, property sweep, and the two `computePanePickerLayout` objects).

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-picker-layout.test.ts`

Expected: FAIL because the module does not exist yet (import resolution error) — the intended "missing behavior", not a syntax accident.

- [ ] **Step 3: Add the minimal production implementation**

Create `src/lib/pane-picker-layout.ts` implementing the four pure functions exactly as specified in **Behavior**. `chooseRowCount` clamps `width`/`height` via `Math.max(v, 1)` and keeps the first (smallest) row count that reaches each new best tile size (comparison with `> bestTile + 1e-6` so exact ties keep the earlier row count).

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/lib/pane-picker-layout.test.ts`

Expected: PASS (all cases).

- [ ] **Step 5: Refactor while green**

Confirm no duplication or dead code; export only what Task 2 consumes. No further refactor expected for a pure 4-function module.

- [ ] **Step 6: Run broader verification**

Run: `npm run typecheck:client`

Expected: PASS (exit 0).

- [ ] **Step 7: Commit the task**

```bash
git add src/lib/pane-picker-layout.ts test/unit/client/lib/pane-picker-layout.test.ts
git commit -m "feat(panes): add adaptive picker layout math library"
```

---

### Task 2: Wire the adaptive grid into `PanePicker` + CSS + component tests

**Requirements served:** R1, R2, R3, R4, R5

**Behavior:**
- `PanePicker` replaces `buildBalancedOptionRows`/`MAX_OPTIONS_PER_ROW` with `computePanePickerLayout(options.length, width, height)`.
- The component measures its own box (`clientWidth`/`clientHeight`) on mount and on resize via a ResizeObserver on the root container; guard `typeof ResizeObserver !== 'undefined'`. Width/height ≤ 0 flow into the library's square-aspect fallback.
- The root element:
  - gains class `pane-picker` and loses `@container` and `p-2 @[250px]:p-4 @[400px]:p-8`;
  - keeps `h-full w-full flex items-center justify-center`, the fade `transition-opacity`/`opacity-0` behavior, `focus:outline-none`, `role="toolbar"`, `aria-label="Pane type picker"`, and all `data-*` attributes;
  - gets inline style `{ '--cols': layout.maxCols, '--rows': layout.rowSizes.length } as React.CSSProperties` (the cast is required — the repo's React CSSProperties type rejects uncast custom-property keys; this matches the existing precedent).
- Rows render from `layout.rowSizes` (top→bottom), each row a `div` with `data-testid="pane-picker-option-row"` and class `pane-picker-option-row`; buttons keep `data-testid`-independent classes and all event handlers, now with class `pane-picker-tile`.
- **Preserve the global flattened index.** The current `buildBalancedOptionRows` assigns each option a global index (`cursor + offset`) that drives `buttonRefs`, `focusedIndex`/`hoveredIndex`, `showHint(index)`, and `handleArrowNav(e, index)`. When rendering rows from `layout.rowSizes` by slicing `options`, compute each option's index as `rowStart + offset` (a running `rowStart` accumulated from prior row sizes) and keep using that global index for all refs/focus/hints/nav — never a local per-row index, or cross-row arrow navigation and hint focus break.
- Icon/label/hint sizing classes (`h-6 w-6 @[250px]:h-8...`, `text-xs @[400px]:text-sm`, `shortcut-hint ... -mt-1`) move into CSS rules in `src/index.css` driven by `--tile`.
- Add to `src/index.css` (near the existing `@container` block, around line 85) a `/* Pane picker: balanced adaptive grid */` block defining `.pane-picker` (`container-type: size; --pad: clamp(8px, 3cqw, 28px); --gap: clamp(6px, 2cqw, 18px); --tile: clamp(36px, min(calc((100cqw - 2*var(--pad) - (var(--cols) - 1)*var(--gap)) / var(--cols)), calc((100cqh - 2*var(--pad) - (var(--rows) - 1)*var(--gap)) / var(--rows))), 120px);` — note: NO `padding` property on the root; the tile calc reserves the margin and the root's flex centering places the grid inside it), `.pane-picker-options` (flex column, `align-items:center; gap: var(--gap)`), `.pane-picker-option-row` (flex row, `justify-content:center; gap: var(--gap)`), `.pane-picker-tile` (`width/height: var(--tile); display:flex; flex-direction:column; align-items:center; justify-content:center; gap: calc(var(--tile)*0.1)`), `.pane-picker-tile svg` (`width/height: calc(var(--tile)*0.44)`), `.pane-picker-tile .pane-picker-tile-label` (`font-size: clamp(9px, calc(var(--tile)*0.15), 15px); max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap`), `.pane-picker-tile .pane-picker-tile-hint` (`font-size: clamp(8px, calc(var(--tile)*0.11), 12px)`).
  - CSS container-unit rules for this block (empirically validated in Chromium — see load-bearing reports/load-bearing-validator-cq.md):
    - `cqw`/`cqh` resolve against the container's padding box (no border here), so `100cqw` is the picker's full width and the calc's `2*var(--pad)` subtraction is exactly the reserved margin — it is NOT double-counting padding. Do not "simplify" the calc.
    - `--pad`, `--gap`, and `--tile` contain cq units and MUST only be *used* on descendant elements (rows/tiles), never on the `.pane-picker` root's own properties — a query container is not its own ancestor, so cq units used on the root itself would resolve against an outer container. This is why the root carries no `padding` property: the margin comes entirely from the tile calc + centering.
- Keep the existing label `<span className="pane-picker-tile-label font-medium">` and hint `<span className="shortcut-hint pane-picker-tile-hint transition-opacity duration-150 ...">` (the `.shortcut-hint` class is asserted by tests).

**Files:**
- Modify: `src/components/panes/PanePicker.tsx`
- Modify: `src/index.css`
- Modify: `test/unit/client/components/panes/PanePicker.test.tsx`
- Create: `test/e2e-browser/specs/pane-picker-layout.spec.ts` (real-browser geometry evidence for R3 — authored in this task's Red step, before the production change)

**Interfaces:**
- Consumes: `computePanePickerLayout` from `@/lib/pane-picker-layout` (Task 1).
- Produces: none new (internal layout only).

**Test cases (component, in `PanePicker.test.tsx`):**
- Existing "balanced icon layout" test (7 options, no explicit size) still yields rows `[2,3,2]` via the square-aspect fallback (changed from the old top-heavy `[3,2,2]`).
- After stubbing a controllable `ResizeObserver` and setting the container to 480×400, 7 options reflow to rows `[2,3,2]`; at 640×300 → `[4,3]`; at 300×500 → `[2,2,2,1]`.
- With a store producing 13 options (fresh agents incl. Kilroy flag, Claude/Codex/OpenCode CLIs, Editor/Browser/Shell, three client extensions) at 480×400 → rows `[3,4,4,2]` (4 rows: 3,4,4,2 buttons).
- Cross-row arrow navigation stays intact (R4): with the 7-option fallback layout `[2,3,2]`, focus the last option of row 1 (global index 1) and press `ArrowRight` → the first option of row 2 (global index 2) receives focus.
- Root keeps `role="toolbar"` and `aria-label="Pane type picker"`.
- Root has class `pane-picker`; options container has class `pane-picker-options`; each row has class `pane-picker-option-row`; each option button has class `pane-picker-tile`.

**Test cases (browser, in `test/e2e-browser/specs/pane-picker-layout.spec.ts`):**
- Open the real picker via `openPanePicker` (helpers/pane-picker.ts). Read the toolbar (`[data-context="pane-picker"]`) box (W, H via `offsetWidth`/`offsetHeight`), the inline `--cols`/`--rows`, and the per-row button counts (`[data-testid="pane-picker-option-row"]`).
- For every option button: `offsetWidth === offsetHeight` (square), `> 0`, and its `getBoundingClientRect()` is fully inside the toolbar rect (no overflow).
- Fluid fit (this is the load-bearing R3 proof, which jsdom cannot provide): expected tile = `min((W − 2·pad − (cols−1)·gap)/cols, (H − 2·pad − (rows−1)·gap)/rows)` with `pad = clamp(8, 0.03·W, 28)` and `gap = clamp(6, 0.02·W, 18)` (the cq values resolve against the container's width). Assert each measured tile width equals the expected value within ±2.5px. Repeat at a second, materially different viewport (e.g. 1280×800 then 900×600 via `page.setViewportSize`), asserting the tiles reflow to a different size that again matches the formula and stays square + contained (poll with `expect.poll` until the ResizeObserver re-render settles).

- [ ] **Step 1: Write the failing behavioral test**

Write BOTH test layers (they are this task's Red step and must exist before the production change):
1. In `PanePicker.test.tsx` (jsdom):
   - Add a module-level controllable `MockResizeObserver` (captures the callback; `vi.stubGlobal('ResizeObserver', MockResizeObserver)` in `beforeEach`, `vi.unstubAllGlobals()` in `afterEach`) and a helper `setContainerSize(width, height)` that defines `clientWidth`/`clientHeight` on the `[data-context="pane-picker"]` container and invokes the captured callback inside `act`.
   - Update the `responsive sizing` describe block: replace the `@container`/`p-2`/`gap-2`/button-`p-2` assertions with the class assertions listed in **Test cases** plus the `role`/`aria-label` assertion.
   - Add the reflow tests (7 options at 480×400 / 640×300 / 300×500) and the 13-option 480×400 → `[3,4,4,2]` test. The 13-option store uses `freshClientsEnabled: true`, `featureFlags: { kilroy: true }`, `availableClis: { claude: true, codex: true, opencode: true }`, `enabledProviders: ['claude','codex','opencode']`, `extensions: [...defaultCliExtensions, mockOpencodeExt, three client extensions]` — this yields 4 fresh agents + 3 CLIs + Editor/Browser/Shell + 3 extensions = 13. Assert `expect(screen.getAllByRole('button')).toHaveLength(13)` first so the row-shape assertion (`[3,4,4,2]` = 4 rows with 3, 4, 4, 2 buttons) is guaranteed to run against exactly 13 options; if the count differs, adjust the number of client extensions up/down until it is exactly 13.
   - Add the cross-row arrow test: with the default store plus 4 more options (so 7 total, fallback rows `[2,3,2]`), focus the button at global index 1 and fire `ArrowRight`; assert the button at global index 2 (`buttonRefs`/DOM order) has focus. Add the store helper used by the existing tests (e.g. `availableClis`/`enabledProviders`/`extensions` yielding 7 options).
   - Change the existing 7-option "balanced icon layout" test from `[3,2,2]` to `[2,3,2]` (rows of 2, 3, 2 buttons) as the no-size fallback case.
2. In `test/e2e-browser/specs/pane-picker-layout.spec.ts` (Playwright): implement the browser test cases above using `test`, `expect` from `../helpers/fixtures.js` and `openPanePicker` from `../helpers/pane-picker.js`.

- [ ] **Step 2: Run the tests and verify the intended failure**

Run the jsdom tests: `npm run test:vitest -- run test/unit/client/components/panes/PanePicker.test.tsx`

Expected: FAIL — new class/reflow/13-option assertions fail against the current layout (`@container`, `p-2`, `gap-2`, 3-per-row fixed rows). The reflow tests fail because the current component has no ResizeObserver and no `--cols`/`--rows`.

Then run the browser test against the CURRENT (unimplemented) layout: `npm run test:e2e:chromium -- pane-picker-layout --reporter=line`

Expected: FAIL — the current content-sized, non-square buttons do not satisfy the square/expected-size assertions. This is the Red run for the R3 geometry; do not implement Task 2's production change before seeing this failure. If Chromium genuinely cannot launch in this environment, STOP and record the exact error as a blocker (R5 requires this evidence; do not silently continue).

- [ ] **Step 3: Add the minimal production implementation**

In `PanePicker.tsx`:
- Remove `MAX_OPTIONS_PER_ROW`, `buildBalancedOptionRows`, and `PickerRowOption`; import `computePanePickerLayout` from `@/lib/pane-picker-layout`.
- Add `const [gridDims, setGridDims] = useState({ width: 0, height: 0 })`; add a `useEffect` on the existing `containerRef` that calls `measure()` once and registers a `ResizeObserver` (guarded by `typeof ResizeObserver !== 'undefined'`), where `measure` sets `setGridDims({ width: el.clientWidth, height: el.clientHeight })`; clean up with `ro.disconnect()`.
- Replace `const optionRows = useMemo(() => buildBalancedOptionRows(options), [options])` with `const layout = useMemo(() => computePanePickerLayout(options.length, gridDims.width, gridDims.height), [options.length, gridDims.width, gridDims.height])`, then build rows from `layout.rowSizes` by slicing `options` cumulatively, keeping a running `rowStart` and passing `rowStart + offset` as the option's global index to `buttonRefs`, focus/hover setters, `showHint`, and `handleArrowNav` (see **Behavior**).
- Update root/options/row/button className strings per **Behavior** and add the inline `--cols`/`--rows` style to the root.
- Move icon/label/hint size classes to the new CSS classes; keep `.shortcut-hint` and its `opacity-*` transition classes on the hint span.
- In `src/index.css`, add the `/* Pane picker: balanced adaptive grid */` block exactly as specified.

- [ ] **Step 4: Run the focused tests**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PanePicker.test.tsx`

Expected: PASS (all updated + new tests).

Then run: `npm run test:e2e:chromium -- pane-picker-layout --reporter=line`

Expected: PASS — real-browser tiles are square, match the expected fluid formula at both viewports, and stay within the pane bounds.

- [ ] **Step 5: Refactor while green**

Confirm no leftover references to `buildBalancedOptionRows`/`MAX_OPTIONS_PER_ROW`/`PickerRowOption`; keep the fade, keyboard, and a11y wiring identical; remove dead container-query variant classes.

- [ ] **Step 6: Run broader verification**

Run: `npm run test:vitest -- run test/unit/client/components/panes test/e2e/directory-picker-flow.test.tsx` then `npm run typecheck:client` and `npm run lint`, then `npm run test:e2e:chromium -- pane-picker pane-picker-layout --reporter=line`

Expected: PASS — panes unit tests, the jsdom directory-picker e2e, typecheck, lint, and both browser specs (existing pane-picker + new geometry) all pass.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/PanePicker.tsx src/index.css test/unit/client/components/panes/PanePicker.test.tsx test/e2e-browser/specs/pane-picker-layout.spec.ts
git commit -m "feat(panes): adaptive balanced rows and fluid tile sizing for the pane picker"
```

---

### Task 3: Update the `docs/index.html` picker mock

**Requirements served:** R3, R5 (docs mock reflects the new picker UI)

**Behavior:**
- The static mock picker (7 options: Claude, Codex, OpenCode, Kimi, Editor, Browser, Shell) displays as fixed square tiles in balanced rows, mirroring the adaptive layout's default look rather than the current flex-wrap pills.

**Files:**
- Modify: `docs/index.html` (CSS around lines 341–376 and markup around lines 698–739)

**Interfaces:**
- None (standalone static mock; no JS).

**Test cases:**
- The mock markup wraps the 7 option buttons into 3 row groups of `[2,3,2]` (matching the adaptive layout for 7 options: 2, then 3, then 2), and the CSS sizes `.picker-option` as square tiles (e.g. `width: 96px; height: 96px; justify-content: center; padding: 0`) with `.picker-grid` as a centered column of rows and a new `.picker-row` class for each centered row.

- [ ] **Step 1: Write the failing behavioral test**

No automated test for a static mock; record the rationale: pure static-doc change with no Red step (per TDD guidance for docs). The verification is visual + structural grep.

- [ ] **Step 2: Verify the intended gap**

Run: `rg -n "picker-row|96px" docs/index.html`

Expected: no matches yet (the new structure/classes do not exist).

- [ ] **Step 3: Update `docs/index.html`**

Edit the picker CSS block: `.picker-grid` → `display:flex; flex-direction:column; align-items:center; gap:24px`, add `.picker-row { display:flex; justify-content:center; gap:24px }`, and `.picker-option { width:96px; height:96px; justify-content:center; padding:0 }` (shrink `.picker-icon`/`.picker-lucide` to `40px` so icons fit the tile). Wrap the 7 option buttons into three `.picker-row` divs containing 2, 3, and 2 options respectively.

- [ ] **Step 4: Verify the change**

Run: `rg -n "picker-row" docs/index.html`

Expected: 4 matches total — one `.picker-row` CSS rule plus three `.picker-row` wrappers in the markup.

- [ ] **Step 5: Refactor while green**

Not needed for a static mock.

- [ ] **Step 6: Broader verification**

Run: `git diff --stat docs/index.html`

Expected: picker CSS + markup only, no other docs sections touched.

- [ ] **Step 7: Commit the task**

```bash
git add docs/index.html
git commit -m "docs: refresh picker mock to balanced adaptive tile layout"
```

---

## Complete verification (Stage 4 end, before final Fresh Eyes)

- `npm run typecheck:client` → exit 0
- `npm run lint` → exit 0
- `npm run test:unit` (coordinated default-config `test/unit` workload) → green
- `npm run test:vitest -- run test/e2e/directory-picker-flow.test.tsx` → green (jsdom e2e covering the picker)
- `npm run test:e2e:chromium -- pane-picker pane-picker-layout --reporter=line` → green (REQUIRED: real-browser geometry evidence for R3 + the existing picker spec). If Chromium cannot launch, this is a blocker for ready-to-merge — record the exact error; do not claim the browser evidence green.
- Record the committed `HEAD` that produced the receipt in the run-state and progress ledger.

Not run (with reason): full Playwright suite (heavy, runs against both Node and Rust servers in CI); server-config suite — client-only change. The `role="toolbar"`/`aria-label` selector used by browser specs is asserted in unit tests too.
