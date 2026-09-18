# Pane Header Hit Zones Implementation Plan

> **For agentic workers:** Execute this plan task by task with a fresh
> implementer and a specification-plus-quality review after every task. Track
> progress with the checkbox steps below.

## User Request

### Requested result
The approved pane-header redesign is implemented in Freshell: desktop (viewport ≥ 640px) keeps today's visual sizes exactly (28px header, 12px button glyphs, 14px pane icons) while its invisible icon-button hit zones grow to 28×28 full-header-height squares that touch edge-to-edge with zero horizontal gap and no overlap; mobile (viewport < 640px) gets a ×1.5 size increase (63px header, 27px glyphs, 21px pane icons) with 63×63 full-height touching zones; the fresh-agent settings gear follows the same geometry and its popover anchors to the glyph; the ≤180px container-query fallback updates proportionally; covered by unit and e2e tests.

### Explicit constraints
- Font sizes never change: title stays text-sm (14px), meta stays text-xs (12px).
- Desktop visuals are unchanged: header stays sm:h-7 (28px), button glyphs stay sm:h-3 (12px), pane/repo icons stay 14px.
- Hit zones are squares spanning the full header height, touching edge-to-edge (zero horizontal gap), never overlapping.
- The size increase is mobile-only.
- The fresh-agent settings gear keeps lockstep geometry; its popover anchors to the glyph, not the full-height button box.
- Title/meta horizontal spacing is preserved via an explicit meta margin when the actions gap goes to zero.
- Repo rules: work in the dedicated worktree; never dirty main; no PR creation without explicit user approval.

### Accepted tradeoffs and residuals
- Button centers spread horizontally (desktop 24→28px, mobile 32→63px), slightly reducing title space.
- Mobile landscape split views spend more vertical space on headers (two stacked panes = 126px).
- Hover/focus surfaces grow with the zone (VSCode-tab-like close hover) — accepted.

**Goal:** Pane headers look identical on desktop (except icons spreading 4px) while every action button's clickable zone becomes a full-height square that touches its neighbors; mobile headers grow ×1.5 with the same square zones; fonts and desktop glyph/icon sizes are untouched; the change is proven by unit tests and a new browser e2e spec plus regenerated screenshot goldens.

**Architecture:** PaneHeader.tsx is the only pane-header renderer (zoomed panes reuse it; the deck is canvas-only). Zones are implemented by making the button box itself the zone — `h-full aspect-square`, actions `gap-0` — rather than pseudo-element overlays, so zones abut exactly with no overlap and hover/focus naturally fill the zone. Because the header's 1px `border-b` lives inside its border-box height (Tailwind preflight), `h-full` reaches the content box, and `aspect-square` derives the zone's width from that height — so zones are true squares by construction (verified live in Chromium: 27×27 desktop / 62×62 mobile at a 16px root, delta 0, gap 0), immune to border or height changes. This one-pixel deviation from the nominal 28px/63px numbers is a recorded design decision, surfaced to the user at the recap: the nominals are the header's outer heights including the border, and honoring them literally would require either non-square zones or shifting every pane's layout by 1px — both of which violate harder constraints (square zones; desktop visuals unchanged). Because the gear and refresh buttons sit inside auto-height wrapper divs, the wrappers (and FreshAgentSettingsButton's root) get an explicit full-height chain so `h-full` resolves all the way down. The `@container` tiers in index.css keep their space-saving hides (≤480px meta, ≤280px optional actions) and their `gap: 0`, but the ≤180px button/svg shrink overrides are deleted: a square full-height zone cannot compress without violating the square constraint, so the proportional update to that fallback is the removal of the shrink mechanism — ultra-narrow space saving comes from the hides alone. All nominal sizes stay in the current rem/px regime (rem where today's classes are rem, px where today's are px) so `--ui-scale` behavior is unchanged; mobile pane icons use rem (`h-[1.3125rem]` = 21px at the default 16px root) to preserve today's rem-based icon scaling, and mobile glyphs stay px (`h-[27px]`) matching today's `h-[18px]` px glyphs. docs/index.html's static pane-header mock is updated alongside so the documented mock reflects the new geometry.

**Tech Stack:** React 18 + TypeScript, Tailwind CSS (JIT arbitrary values), Vitest + Testing Library (jsdom, className-string assertions per house style), Playwright e2e (test/e2e-browser).

## Global Constraints

- Font class strings never change on the header root (`text-sm`), title, meta (`text-xs`), or the rename input.
- Desktop visual classes stay: `sm:h-7`, `sm:h-3 sm:w-3` (glyphs), `sm:h-3.5 sm:w-3.5` (pane icons).
- Zone contract: buttons `h-full aspect-square` (square by construction at the header's content height — 27px desktop / 62px mobile at the default 16px root, since the 1px `border-b` is inside the border-box header height), actions container `gap-0`; zones touch edge-to-edge and never overlap (flex siblings abut exactly).
- Mobile-only ×1.5: header `h-[3.9375rem]`, glyphs `h-[27px] w-[27px]`, pane icons `h-[1.3125rem] w-[1.3125rem]` (all with `sm:` desktop overrides that keep today's sizes).
- The terminal meta span gains `mr-2` when the actions gap goes to zero; the fresh-agent meta lives in the title area and is untouched.
- Never global-replace class tokens: `h-6 w-6` also matches a TerminalView spinner (src/components/terminal/TerminalView.tsx:5673) and `h-3.5 w-3.5` has 37 non-header uses. Edits are scoped to PaneHeader.tsx and FreshAgentSettingsButton.tsx only.
- A11y contracts stay: `role="banner"`, `aria-label="Pane: <title>"`, `data-context="pane-header"`, all button `title`/`aria-label` attributes. E2e locators use roles/titles/`data-*` only — never css-class locators (a11y-selector-gate ratchets).
- No code comments (repo style). No new files outside the ones named here.
- Tailwind content globs cover only root `index.html` + `src/**` — every new utility class must appear as a complete literal in the edited src files (JIT precedent exists: `h-[2.625rem]`, `h-[18px]`, `max-w-[18rem]`).
- Test coordination: broad suite runs wait for the shared coordinator gate. Focused runs (`npm run test:vitest -- run <paths>`, single e2e specs) are uncoordinated. Pre-existing base failure (allowed, in baseline ledger): Rust `claude::tests::approval_respond_write_failure_keeps_the_pending_entry_and_emits_the_error` — unrelated to this client-side change.
- Before any e2e run, confirm the e2e backend with the user per AGENTS.md (`FRESHELL_E2E_BACKEND` unset on this machine means ask: local vs cloud ~$0.03/run). Snapshot regeneration runs locally.
- Reference material: explorer reports at `.worktrees/.the-usual-logs/pane-header-hit-zones/reports/plan-test-landscape.md` and `.../plan-reference-map.md` (paths relative to /home/dan/code/freshell). All line numbers below are from those reports at base a6c0848ef.

---

### Task 1: PaneHeader zone geometry + container-query fallbacks

**Files:**
- Modify: `src/components/panes/PaneHeader.tsx:166` (header root), `:148,152` (refresh), `:180,187` (terminal icons), `:200,210` (fresh-agent icons), `:261-263` (actions container), `:264-271` (meta span), `:279,283` (search), `:311-320` (zoom), `:330,334` (close)
- Modify: `src/index.css:48-50` (≤280px rule), `:70-78` (≤180px rules)
- Modify: `docs/index.html` (static pane-header mock CSS — gapless square zone buttons, mobile 63px header height; the mock documents the default experience)
- Test: `test/unit/client/components/panes/PaneHeader.test.tsx` (update assertions at lines 758 and 782; add one new describe block)

**Interfaces:**
- Consumes: none (first task).
- Produces: the zone geometry contract that Task 2's gear button must match exactly (`h-full aspect-square` zone classes; `h-[27px] w-[27px] sm:h-3 sm:w-3` glyph classes) and that Task 3's e2e asserts as computed geometry.

- [ ] **Step 1: Write the failing behavioral test**

In `test/unit/client/components/panes/PaneHeader.test.tsx`, first update the two existing pane-icon class assertions at lines 758 and 782: they currently expect `h-3.5 w-3.5` on the PaneIcon / RepoIcon class strings; change each expected fragment to the new mobile-first compound (`h-[1.3125rem] w-[1.3125rem] ... sm:h-3.5 sm:w-3.5`) exactly as the components will render (mirror the surrounding assertion style from the reference-map report, which quotes both lines).

Then append this describe block, reusing the file's existing render helpers and default props pattern:

```tsx
describe('pane header hit zones', () => {
  it('renders full-height square zone classes with zero gap and mobile-only size increase', () => {
    renderPaneHeader()
    const header = screen.getByRole('banner')
    expect(header.className).toContain('h-[3.9375rem]')
    expect(header.className).toContain('sm:h-7')
    expect(header.className).toContain('text-sm')

    const close = screen.getByTitle('Close pane')
    expect(close.className).toContain('h-full')
    expect(close.className).toContain('aspect-square')
    expect(close.className).not.toContain('sm:h-4')
    expect(close.className).not.toContain('sm:w-4')

    const actions = header.querySelector('.pane-header-actions')
    expect(actions?.className).toContain('gap-0')
  })

  it('keeps desktop glyph and icon classes untouched', () => {
    renderPaneHeader()
    const close = screen.getByTitle('Close pane')
    const closeSvg = close.querySelector('svg')
    expect(closeSvg?.getAttribute('class') ?? '').toContain('sm:h-3')
    expect(closeSvg?.getAttribute('class') ?? '').toContain('h-[27px]')
  })
```

For the glyph assertion above, mirror the exact pattern the file already uses for pane-icon class assertions at lines 758/782 (the file mocks lucide icons — if the mock does not render `className` onto the svg, assert the className the mock receives, exactly as lines 758/782 do for PaneIcon/RepoIcon).

```tsx

  it('keeps an explicit meta margin next to the zero-gap actions', () => {
    renderPaneHeader({ metaLabel: 'bash 5.2' })
    const meta = screen.getByText('bash 5.2')
    expect(meta.className).toContain('mr-2')
    expect(meta.className).toContain('text-xs')
  })

  it('gives fresh-agent action wrappers the full-height chain', () => {
    renderPaneHeader({ content: freshAgentPaneContent })
    const header = screen.getByRole('banner')
    const wrappers = header.querySelectorAll('.pane-header-fresh-agent-optional-action')
    expect(wrappers.length).toBeGreaterThanOrEqual(1)
    for (const w of wrappers) {
      expect(w.className).toContain('h-full')
    }
  })
})
```

Adapt helper names (`renderPaneHeader`, prop-passing shape) to the file's existing conventions; keep every assertion about class strings, per house style.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneHeader.test.tsx`

Expected: FAIL — the new zone-class assertions miss (`h-[3.9375rem]`, `h-full`, `aspect-square`, `gap-0`, `mr-2`, `h-[27px]` are absent today) and the updated icon assertions at 758/782 expect `h-[1.3125rem] w-[1.3125rem]` which today renders as `h-3.5 w-3.5`.

- [ ] **Step 3: Add the minimal production implementation**

In `src/components/panes/PaneHeader.tsx`:

Header root (line 166) — mobile height only; desktop unchanged:
```tsx
'pane-header flex h-[3.9375rem] shrink-0 items-center border-b border-border text-sm sm:h-7',
```

Actions container (lines 261-263) — one class instead of the per-variant gap:
```tsx
'pane-header-actions ml-auto flex h-full shrink-0 items-center gap-0',
```

Meta span (line 266) — explicit margin preserving today's 8px gap-2 spacing:
```tsx
'mr-2 max-w-[18rem] truncate text-xs text-muted-foreground text-right'
```

Every action button swaps its size classes for the full-height square zone — one class string serves both breakpoints (no width utility, no `sm:` size variant; keep all other classes exactly as-is per button):

Refresh (line 148):
```tsx
'inline-flex h-full aspect-square shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity'
```
Search (line 279):
```tsx
'inline-flex h-full aspect-square items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity'
```
Zoom (lines 311-314):
```tsx
'inline-flex h-full aspect-square shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 transition-opacity'
```
Close (line 330):
```tsx
'inline-flex h-full aspect-square shrink-0 items-center justify-center rounded opacity-60 hover:opacity-100 hover:bg-background/50 transition-opacity'
```

Glyph sizes — mobile grows, desktop unchanged (all four spots; refresh at 152, search 283, zoom 318-320, close 334):
```tsx
h-[27px] w-[27px] sm:h-3 sm:w-3
```

Pane/repo icons — mobile grows via rem (preserving today's rem-based scaling), desktop unchanged. Terminal RepoIcon (line 180) and terminal PaneIcon fragment (line 187):
```tsx
h-[1.3125rem] w-[1.3125rem] shrink-0 sm:h-3.5 sm:w-3.5
```
Fresh-agent RepoIcon (line 200) and fresh-agent PaneIcon fragment (line 210):
```tsx
h-[1.3125rem] w-[1.3125rem] sm:h-3.5 sm:w-3.5
```

Fresh-agent action wrappers (lines 290 and 300) — the gear and refresh buttons sit inside auto-height wrapper divs, so their zones need a definite-height chain down from the actions row:
```tsx
<div className="pane-header-fresh-agent-optional-action flex h-full">
```
(both wrapper spots; the wrapper's own `height: 100%` resolves against the definite-height actions row, giving Task 2's gear button a definite parent).

In `src/index.css`, ≤280px rule (lines 48-50) — zones always touch, also ultra-narrow:
```css
.pane-header--fresh-agent .pane-header-actions {
  gap: 0;
}
```
Delete the ≤180px button and svg override rules entirely (lines 70-78: the `.pane-header--fresh-agent .pane-header-actions button { height: 1rem; width: 1rem; }` rule and the `.pane-header--fresh-agent .pane-header-actions svg { height: 0.75rem; width: 0.75rem; }` rule). Square full-height zones cannot shrink without violating the square constraint, so the shrink mechanism itself goes away; ultra-narrow space saving comes from the kept ≤280px optional-action hide and ≤480px meta hide. A proportional glyph-only narrow tier (18px at ≤180px) was considered and rejected: the tier's original purpose — fitting four large buttons into a tiny pane — is structurally eliminated by the ≤280px hide, and no reachable layout benefits from a narrower glyph while zones must stay full-height squares; this disposition is recorded for the user to veto at the recap. The neighboring ≤180px title-gap and detail-font-size rules in that block stay unchanged — including the pre-existing `.pane-header-fresh-agent-detail { font-size: 13px }` ultra-narrow override, which predates this change and is deliberately untouched: the font-size constraint governs what this change may alter, and this change alters nothing about fonts.

Also in this step, update the static pane-header mock in `docs/index.html` to the new geometry: its pane-header action buttons become gapless full-height squares (its own CSS — height matching the mock header strip, `aspect-ratio: 1` or equal width/height, `gap: 0` in the actions row), and its mobile pane-header height moves from 42px to 63px. Mirror the mock's existing CSS idiom; this is a nonfunctional static document, so no test covers it.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/panes/PaneHeader.test.tsx`

Expected: PASS (all new and updated assertions).

- [ ] **Step 5: Refactor while green**

No refactor: the four button class strings stay inline like today (the file already repeats per-button strings deliberately; extracting a shared constant is not required by the request and widens the diff). State this in the task gate notes.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: components rendering PaneHeader or asserting its classes/structure — `Pane.test.tsx`, `PaneContainer.test.tsx` (behavior-only Close-pane clicks), the pane-header meta flow (`test/e2e/pane-header-runtime-meta-flow.test.tsx`, a Vitest lane), the busy-indicator flow (`test/e2e/busy-indicator-color-flow.test.tsx`), and the context-menu data-context contract (`test/unit/client/components/context-menu/context-menu-utils.test.ts` — path per test tree; if the exact path differs, locate it under test/unit with the file name from the test-landscape report).

Run: `npm run test:vitest -- run test/unit/client/components/panes/ test/e2e/pane-header-runtime-meta-flow.test.tsx test/e2e/busy-indicator-color-flow.test.tsx test/unit/client/components/context-menu/`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/panes/PaneHeader.tsx src/index.css docs/index.html test/unit/client/components/panes/PaneHeader.test.tsx
git commit -m "feat(panes): full-height square hit zones; mobile-only 1.5x header sizing"
```

### Task 2: FreshAgentSettingsButton gear lockstep + glyph-anchored popover

**Files:**
- Modify: `src/components/fresh-agent/FreshAgentSettingsButton.tsx:278` (button classes), `:291-295` (popover rect), `:300` (Settings glyph), plus a new glyph ref near the existing `buttonRef`
- Test: `test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx` (extend the existing popover suite around lines 709-731)

**Interfaces:**
- Consumes: Task 1's zone geometry contract (`h-full aspect-square` zone; `h-[27px] w-[27px] sm:h-3 sm:w-3` glyph).
- Produces: gear zone + popover anchored to the glyph element; Task 3's e2e does not cover the popover (no fresh-agent provider in the e2e env), so this unit test is the popover's behavioral coverage.

- [ ] **Step 1: Write the failing behavioral test**

Append to `FreshAgentSettingsButton.test.tsx` (reuse the file's existing render/open helpers):

```tsx
it('anchors the popover to the gear glyph, not the button box', async () => {
  const user = userEvent.setup()
  render(<FreshAgentSettingsButton tabId="t1" paneId="p1" paneContent={freshAgentPaneContent} />)
  const gearButton = screen.getByTitle('Agent settings')
  const glyph = gearButton.querySelector('svg')
  expect(glyph).not.toBeNull()
  const glyphRect = {
    top: 10, bottom: 30, left: 90, right: 100, width: 10, height: 20, x: 90, y: 10,
    toJSON: () => ({}),
  } as DOMRect
  vi.spyOn(glyph as SVGElement, 'getBoundingClientRect').mockReturnValue(glyphRect)
  await user.click(gearButton)
  const popover = await findPortaledPopover()
  expect(popover.style.top).toBe('34px')
  expect(popover.style.right).toBe(`${Math.max(8, window.innerWidth - 100)}px`)
})
```

Also assert the gear button's zone classes, the root chain, and the gear glyph's lockstep sizing in the same test:
```tsx
  const settingsRoot = gearButton.parentElement
  expect(settingsRoot?.className).toContain('h-full')
  expect(gearButton.className).toContain('h-full')
  expect(gearButton.className).toContain('aspect-square')
  const gearGlyph = gearButton.querySelector('svg')
  expect(gearGlyph?.getAttribute('class') ?? '').toContain('h-[27px]')
  expect(gearGlyph?.getAttribute('class') ?? '').toContain('sm:h-3')
```
For the glyph assertion, mirror the file's icon-rendering convention (if lucide is mocked in that suite, assert the className the mock receives, as the file already does elsewhere).
Implement `findPortaledPopover()` by copying the popover-locating query the existing portal-escape test at FreshAgentSettingsButton.test.tsx:709-731 already uses — do not invent a new selector. Adapt `freshAgentPaneContent` and the click mechanism to that suite's existing fixtures and helpers (it already opens the popover). jsdom's default rects are all-zero, so with the current button-box anchoring `popover.style.top` is `'4px'` — the assertion fails before the fix for the intended reason.

- [ ] **Step 2: Run the test and verify the intended failure**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx`

Expected: FAIL — popover top is `'4px'` (zero-rect button box + 4), not `'34px'` (glyph rect + 4); zone classes absent.

- [ ] **Step 3: Add the minimal production implementation**

In `FreshAgentSettingsButton.tsx`:

Root container (line 273) — the gear button's percentage height needs a definite-height chain through this auto-height root:
```tsx
<div className="relative flex h-full">
```

Add next to the existing `buttonRef`:
```tsx
const glyphRef = useRef<SVGSVGElement | null>(null)
```

Button classes (line 278):
```tsx
'inline-flex h-full aspect-square items-center justify-center rounded opacity-60 transition-opacity hover:opacity-100',
```

Glyph (line 300):
```tsx
<Settings ref={glyphRef} className="h-[27px] w-[27px] sm:h-3 sm:w-3" />
```

Popover rect (around line 291) — measure the glyph, falling back to the button if the ref is somehow unset:
```tsx
const rect = (glyphRef.current ?? buttonRef.current).getBoundingClientRect()
```
Everything else in the positioning block (top: rect.bottom + 4; right: Math.max(8, window.innerWidth - rect.right)) stays unchanged.

- [ ] **Step 4: Run the focused test**

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx`

Expected: PASS — including the existing portal-escape test at lines 709-731 (the dialog still portals to document.body).

- [ ] **Step 5: Refactor while green**

No refactor needed: the change is two class strings, one ref, and one rect source. The `open && 'bg-background/50 opacity-100'` state style now paints the full zone — that is the accepted VSCode-like hover/focus tradeoff, not a defect.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: everything rendering the gear button — this test file, plus fresh-agent suites that assert the header actions row (`test/unit/client/components/fresh-agent/` directory, including any FreshAgent header integration tests) — plus PaneHeader.test.tsx (it stubs this component, so it must stay green).

Run: `npm run test:vitest -- run test/unit/client/components/fresh-agent/ test/unit/client/components/panes/PaneHeader.test.tsx`

Expected: PASS.

- [ ] **Step 7: Commit the task**

```bash
git add src/components/fresh-agent/FreshAgentSettingsButton.tsx test/unit/client/components/fresh-agent/FreshAgentSettingsButton.test.tsx
git commit -m "feat(fresh-agent): gear zone in lockstep; popover anchors to glyph"
```

### Task 3: e2e geometry spec + screenshot goldens

**Files:**
- Create: `test/e2e-browser/specs/pane-header-hit-zones.spec.ts`
- Modify (generated): screenshot goldens under `test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots/` (`mobile-layout.png`, `default-layout.png`, `multiple-tabs.png`) and `test/e2e-browser/specs/editor-pane.spec.ts-snapshots/`

**Interfaces:**
- Consumes: Tasks 1-2 production geometry; the e2e fixtures/app-server bootstrap used by every spec in `test/e2e-browser/specs/` (import and setup pattern: mirror `pane-system.spec.ts`; geometry-assertion pattern: mirror `sidebar.spec.ts:278-333` boundingRect usage and `fresh-agent-mobile.spec.ts`'s `test.use({ viewport: { width: 390, height: 844 } })`).
- Produces: behavioral proof of the user story at both breakpoints; regenerated goldens committed alongside.

- [ ] **Step 1: Write the spec**

Create `test/e2e-browser/specs/pane-header-hit-zones.spec.ts`. Its first import line copies `pane-system.spec.ts`'s exact `test`/`expect` import (module specifier included) and extends it with the page types:

```ts
import { test, expect } from '<pane-system.spec.ts\'s exact module specifier>'
import type { Page, Locator } from '@playwright/test'
```

(helpers/fixtures.ts exports `test`/`expect` but not the page types — the types come from `@playwright/test`.)

Every test requests `{ freshellPage, page }` exactly as pane-system.spec.ts's tests do — Freshell navigation and initialization live in the non-auto `freshellPage` fixture (helpers/fixtures.ts:279-335), so `{ page }` alone yields an unnavigated page. All expected values are derived from the live root font-size and the live header border so the spec is robust under any `--ui-scale`:

```ts
const rootFontSize = (page: Page) =>
  page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize))

const headerZoneHeight = async (page: Page, header: Locator) => {
  const box = (await header.boundingBox())!
  const borderH = await header.evaluate((el) => parseFloat(getComputedStyle(el).borderBottomWidth))
  return box.height - borderH
}

const closeWithin = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(1)

const expectSquareZone = (box: { width: number; height: number }, zoneHeight: number) => {
  expect(Math.abs(box.width - box.height)).toBeLessThanOrEqual(0.5)
  expect(Math.abs(box.height - zoneHeight)).toBeLessThanOrEqual(0.5)
}

const expectTouching = (boxes: { x: number; width: number }[]) => {
  for (let i = 1; i < boxes.length; i++) {
    expect(Math.abs(boxes[i].x - (boxes[i - 1].x + boxes[i - 1].width))).toBeLessThanOrEqual(0.1)
  }
}

test.describe('desktop pane header hit zones (>= 640px viewport)', () => {
  test('zones are full-height squares that touch; visuals unchanged', async ({ freshellPage, page }) => {
    await createTerminalPane(page)
    const root = await rootFontSize(page)
    const header = page.getByRole('banner', { name: /Pane:/ })
    await expect(header).toBeVisible()
    const headerBox = (await header.boundingBox())!
    closeWithin(headerBox.height, 1.75 * root)
    const zoneH = await headerZoneHeight(page, header)
    closeWithin(zoneH, 1.75 * root - 1)

    const buttons = await header.getByRole('button').all()
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    const boxes: { x: number; width: number; height: number }[] = []
    for (const b of buttons) boxes.push((await b.boundingBox())!)
    boxes.sort((a, b) => a.x - b.x)
    for (const box of boxes) expectSquareZone(box, zoneH)
    expectTouching(boxes)
    const closeSvg = header.getByTitle('Close pane').locator('svg')
    closeWithin((await closeSvg.boundingBox())!.width, 0.75 * root)
    const paneIcon = header.locator('svg').first()
    closeWithin((await paneIcon.boundingBox())!.width, 0.875 * root)
  })

  test('fresh-agent gear zone is a full-height square at normal width', async ({ freshellPage, page }) => {
    await createFreshAgentPane(page)
    const root = await rootFontSize(page)
    const header = page.getByRole('banner', { name: /Pane:/ })
    await expect(header).toBeVisible()
    const zoneH = await headerZoneHeight(page, header)
    closeWithin(zoneH, 1.75 * root - 1)
    const gear = header.getByTitle('Agent settings')
    expectSquareZone((await gear.boundingBox())!, zoneH)
  })

  test('ultra-narrow fresh-agent panes hide optional actions and keep square full-height zones', async ({ freshellPage, page }) => {
    await createFreshAgentPane(page)
    await splitFreshAgentPaneThreeTimes(page)
    const header = page.getByRole('banner', { name: /Pane:/ }).last()
    await expect(header).toBeVisible()
    await expect(header.getByTitle('Agent settings')).toBeHidden()
    await expect(header.getByTitle('Maximize pane')).toBeHidden()
    const zoneH = await headerZoneHeight(page, header)
    const close = header.getByTitle('Close pane')
    expectSquareZone((await close.boundingBox())!, zoneH)
  })
})

test.describe('mobile pane header hit zones (390px viewport)', () => {
  test.use({ viewport: { width: 390, height: 844 } })
  test('size increase is mobile-only; zones are full-height squares that touch', async ({ freshellPage, page }) => {
    await createTerminalPane(page)
    const root = await rootFontSize(page)
    const header = page.getByRole('banner', { name: /Pane:/ })
    await expect(header).toBeVisible()
    const headerBox = (await header.boundingBox())!
    closeWithin(headerBox.height, 3.9375 * root)
    const zoneH = await headerZoneHeight(page, header)
    closeWithin(zoneH, 3.9375 * root - 1)

    const buttons = await header.getByRole('button').all()
    expect(buttons.length).toBeGreaterThanOrEqual(2)
    const boxes: { x: number; width: number; height: number }[] = []
    for (const b of buttons) boxes.push((await b.boundingBox())!)
    boxes.sort((a, b) => a.x - b.x)
    for (const box of boxes) expectSquareZone(box, zoneH)
    expectTouching(boxes)
    const close = header.getByTitle('Close pane')
    const closeSvg = close.locator('svg')
    closeWithin((await closeSvg.boundingBox())!.width, 27)
    const paneIcon = header.locator('svg').first()
    closeWithin((await paneIcon.boundingBox())!.width, 1.3125 * root)
  })
})
```

Implement `createTerminalPane(page)`, `createFreshAgentPane(page)`, and `splitFreshAgentPaneThreeTimes(page)` (split the fresh-agent pane horizontally until its container is under 180px on the default 1280px-wide viewport — three splits of the same pane: 640 → 320 → 160) by mirroring the pane-creation and split flows in `pane-system.spec.ts` and the fresh-agent pane creation in `fresh-agent.spec.ts`; do not invent a new helper mechanism. Note that in fresh-agent panes the Maximize button also carries the `pane-header-fresh-agent-optional-action` class, so at ≤280px only the Close button remains visible — the narrow-tier test measures Close for exactly that reason. Keep all locators role/title-based. Do not add this spec to `CLOUD_SKIP_SPECS` in `test/e2e-browser/playwright.cloud.config.ts` — that would make it non-coverage per repo rules.

- [ ] **Step 2: Run the affected visual specs and verify the intended failure**

Before regenerating goldens, run the snapshot specs that the geometry change intentionally breaks (mobile header 42→63px; desktop button centers 24→28px):

Run: `npm run test:e2e:local -- screenshot-baselines editor-pane`

Expected: FAIL on visual diffs in the affected snapshots — this is the intended failure proving the goldens need regeneration (if these specs pass unchanged, stop and investigate — the change did not reach the built client).

- [ ] **Step 3: Regenerate the goldens**

Run: `npx playwright test --config test/e2e-browser/playwright.config.ts --update-snapshots=all`

The explicit `=all` matters: bare `--update-snapshots` means `changed` in the installed Playwright (1.58), which rewrites only comparisons exceeding the existing 5% tolerance and can silently leave stale goldens — a failure mode this repo has already documented. Confirm with `git status` that only the expected `*-snapshots/` PNGs changed: the screenshot-baselines goldens (mobile and desktop layouts, including `sidebar-collapsed-chromium-linux.png`, whose capture contains the pane header) and the editor-pane goldens.

- [ ] **Step 4: Run the new spec and the regenerated specs**

Run: `npm run test:e2e:local -- pane-header-hit-zones screenshot-baselines editor-pane`

Expected: PASS.

- [ ] **Step 5: Refactor while green**

Review the spec for duplication between the two describes: if the shared measuring logic exceeds ~15 lines, extract a local helper inside the spec file. Otherwise state that no refactor is needed.

- [ ] **Step 6: Run impacted-test verification**

Impacted set: e2e specs that depend on pane-header structure, titles, layout, or viewport-dependent chrome — `pane-system`, `title-sync-convergence`, `auto-title-rust`, `fresh-agent-mobile` (390px viewport), and the local-only `pane-activity-indicator` (in CLOUD_SKIP_SPECS, runs locally). Plus the repo CI gates that touch this area: `npm run lint` and `npm run typecheck:client`.

Run: `npm run test:e2e:local -- pane-system title-sync-convergence auto-title-rust fresh-agent-mobile pane-activity-indicator` then `npm run lint && npm run typecheck:client`

Expected: PASS (lane-wide; any failure matching the baseline's pre-existing Rust failure is attributable per the baseline ledger — but these lanes are client-side and should be green).

- [ ] **Step 7: Commit the task**

```bash
git add test/e2e-browser/specs/pane-header-hit-zones.spec.ts test/e2e-browser/specs/screenshot-baselines.spec.ts-snapshots test/e2e-browser/specs/editor-pane.spec.ts-snapshots
git commit -m "test(e2e): pane header hit-zone geometry spec; regenerate affected goldens"
```
