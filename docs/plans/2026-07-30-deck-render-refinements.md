# Deck Render Refinements Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Four refinements to freshell's Stream Deck rendering and layout: slightly smaller tile titles, pure-black tile interiors with a darker composited green fill, a new "reversed" key layout with a permanent top-left pager (default on 6-key decks via an Auto setting), and deck labels that exactly match the tab bar's displayed labels.

**Architecture:** All changes are client-only, in `src/deck/` plus the shared settings layer. The canvas renderer (`tile-renderer.ts`) gets constant-level visual changes. Label parity is a single-point fix in `selectDeckModel` reusing the tab bar's existing pure function `getTabDisplayTitle`. The reversed layout is a new `DeckArrangement` concept: a pure resolver (`resolveArrangement`) maps the new persisted `streamDeck.keyLayout` setting + device key count to `'standard' | 'reversed'`; `planLayout` gains a reversed branch (pager always at key 0); a pure `arrangeTabs` orders tabs (reverse tab-bar order via a new `DeckTab.tabIndex` field). Both `buildFrame` and the controller's press-snapshot resolver consume the same pure functions, so key painting and press targeting stay mirror images.

**Tech Stack:** TypeScript, React, Redux Toolkit, Zod (settings schema), Vitest (jsdom, recording-context canvas harness, `FakeDeckDevice` fake transport), ESLint (jsx-a11y).

## Global Constraints

- Client-only: no server changes; nothing under `crates/` or `server/` is touched.
- STANDARD arrangement behavior is unchanged: attention-priority sorting (gated on `tileStyle === 'status-icons'`), pager bottom-right (`keyCount - 1`) only on overflow. No changes to state classification, transports, long-press action layer, dial semantics, or idle dimming.
- The classic `terminal-previews` tile style is PINNED per repo precedent (`docs/plans/2026-07-29-deck-visual-tweaks.md`): its fonts (`11px monospace`, `16px sans-serif` banner), palette (`PREVIEW_BG '#0a0a0a'`, `PREVIEW_TEXT_COLOR`, `RING_COLORS`), and truncation stay identical. The title shrink applies to the icons-style banner only; the label-parity and arrangement changes apply to both styles (they change WHAT is shown/ordered, not the pinned HOW).
- New setting: `streamDeck.keyLayout` with values `'auto' | 'newest-first' | 'status-sorted'`, default `'auto'`. Auto resolves to the reversed arrangement when `keyCount <= 6`, standard otherwise. Persisted client-side (localStorage blob `freshell.browser-preferences.v1`), live-applied.
- Naming note (deliberate, validated): `'newest-first'` is implemented as strictly REVERSE TAB-BAR ORDER (`tabIndex` descending). Tabs are created by append (`addTab` pushes, tabsSlice.ts:322), so the last tab IS the newest — until the user reorders (drag, Ctrl+Shift+arrows, and context menu are all wired today via `reorderTabs`, tabsSlice.ts:414-422) or a cross-device `hydrateTabs` sync adopts remote order (tabsSlice.ts:375-398). After any reorder the deck mirrors the REVERSED TAB BAR, not creation recency — that is the intended, muscle-memory-stable behavior. The value name keeps the spec's user-facing vocabulary; a later rename remains possible via a normalizer alias.
- New color values (exact): `TILE_BG = '#000000'`; `TILE_FILL_GREEN = '#697d73'` (= `#d1fae5` rgb(209,250,229) composited at 50% opacity over black: `Math.round(c/2)` per channel → rgb(105,125,115)). `BAR_TOP_BORDER '#21c45d'`, `ACTIVE_COLOR '#ffffff'`, and all rings stay full-strength.
- New font size (exact): icons-style banner title `ICONS_TITLE_FONT_SIZE = 14` (down from 16); `TEXT_LETTER_SPACING = '0.4px'` and `TITLE_SIDE_PADDING = 6` from PR #585 are kept.
- Repo rules (AGENTS.md, binding): work only inside the worktree `/home/dan/code/freshell/.worktrees/deck-render-refinements`; do NOT create/open a PR without explicit user approval; NEVER restart the live Rust server on port 3002; no broad kill patterns. Focused tests: `npm run test:vitest -- run <paths> --config config/vitest/vitest.config.ts` (run from inside the worktree; the config excludes `**/.worktrees/**` so you must cd in). Lint: `npm run lint`. Typecheck: `npm run typecheck`. Full coordinated suite: `npm run check`.
- TDD Red-Green-Refactor for every task; commit after every green cycle. `docs/index.html` and README need no changes (no deck content there; verified by exploration).
- Vitest runs with `sequence.shuffle: true` — tests must be order-independent.

---

### Task 1: Smaller icons-banner title font (16 → 14)

**Files:**
- Modify: `src/deck/tile-renderer.ts` (constant near line 55, title draw near lines 305-317)
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: existing `TITLE_FONT_SIZE = 16` (`tile-renderer.ts:55`), `BANNER_HEIGHT = 20` (`:53`), `DECK_FONT_STACK = 'Inter, sans-serif'` (from `src/deck/deck-font.ts`), `drawCenteredText(ctx, text, w, y)` (`:190-193`), `drawIconsTab` title block (`:305-317`).
- Produces: `export const ICONS_TITLE_FONT_SIZE = 14` in `src/deck/tile-renderer.ts`. `TITLE_FONT_SIZE` stays `16` and becomes classic-preview-only. No other task depends on these names, but Task 2 edits the same file — keep the constants block tidy.

**Why this shape:** `TITLE_FONT_SIZE` is dual-use today: the icons banner (`:313`) AND the PINNED classic-preview banner (`:216`, `` `${TITLE_FONT_SIZE}px sans-serif` ``). Shrinking the shared constant would silently shrink the pinned preview, and the existing pin test (`test:364-368`) interpolates the constant so it cannot catch that drift. So: new constant for the icons banner, literal-string guards in tests. The fit/truncation math (`truncateTitle` 10-char cap + `fitLabel` measure-driven pixel fit) needs **no code change** — `fitLabel` consumes the injected `measure`, and real Chromium `measureText` scales with `ctx.font` automatically, so a smaller font mechanically fits more text at runtime. The test harness's `measureText` stub ignores `ctx.font` (models `6px/char + letterSpacing`), so the existing fit test (`test:404-420`) keeps passing unchanged — we deliberately do NOT make the stub font-aware (it would ripple into the `'+3'` badge geometry pins at `test:486-488` for zero user-facing value); the shrink is guarded by literal font-string pins instead.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/tile-renderer.test.ts`, add `ICONS_TITLE_FONT_SIZE` to the existing import from `@/deck/tile-renderer`, then add inside the existing `describe('title fitting')` block (near line 98):

```ts
it('icons banner title is 14px and vertically centered in the 20px banner', () => {
  // Literal pins on purpose: an interpolated pin cannot catch drift.
  expect(ICONS_TITLE_FONT_SIZE).toBe(14)
  const { texts } = renderTab(tabSpec({ title: 'build' }))
  const title = texts.find((t) => t.text === 'build')
  expect(title?.font).toBe('400 14px Inter, sans-serif')
  // y = Math.round((BANNER_HEIGHT - ICONS_TITLE_FONT_SIZE) / 2) = (20 - 14) / 2 = 3
  expect(title?.y).toBe(3)
})

it('classic preview banner stays PINNED at literal 16px sans-serif (does not follow the icons shrink)', () => {
  const { texts } = renderTab(previewSpec({ title: 'build', previewLines: ['$ ls'] }))
  expect(texts.find((t) => t.text === 'build')?.font).toBe('16px sans-serif')
})
```

Also update two existing tests in the same file to stop interpolating the now-split constant:
- In `'icons tile: banner title renders regular-weight (400) Inter; avatar letter keeps RepoIcon 600'` (near line 331): change the expected title font from `` `400 ${TITLE_FONT_SIZE}px ${DECK_FONT_STACK}` `` to the literal `'400 14px Inter, sans-serif'`.
- In `'classic preview tile is PINNED: monospace body, sans-serif banner'` (near line 364): change `` `${TITLE_FONT_SIZE}px sans-serif` `` to the literal `'16px sans-serif'`.

(`tabSpec` and `previewSpec` are existing in-file spec builders — see their usage at lines 182 and 365.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `ICONS_TITLE_FONT_SIZE` is not exported (import error), and after a stub export, font-string mismatch `'400 16px Inter, sans-serif' !== '400 14px Inter, sans-serif'`.

- [ ] **Step 3: Implement**

In `src/deck/tile-renderer.ts`, directly below `export const TITLE_FONT_SIZE = 16` (line 55):

```ts
/** Icons-style banner title. 2px smaller than the classic banner: 16px read
 * too large on 72-80px keys. The classic terminal-previews banner is PINNED
 * and keeps TITLE_FONT_SIZE = 16. Fit math needs no change: fitLabel is
 * measure-driven and Chromium's measureText scales with ctx.font. */
export const ICONS_TITLE_FONT_SIZE = 14
```

In `drawIconsTab`'s title block (lines 310-317), change the font assignment and recenter the title vertically:

```ts
ctx.letterSpacing = TEXT_LETTER_SPACING
// Weight rule: 400 everywhere, EXCEPT where the deck mirrors the app UI —
// the letter avatar and +N badge keep RepoIcon's 600 (see RepoIcon.tsx).
ctx.font = `400 ${ICONS_TITLE_FONT_SIZE}px ${DECK_FONT_STACK}`
ctx.textBaseline = 'top'
ctx.fillStyle = ACTIVE_COLOR
const label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 2 * TITLE_SIDE_PADDING)
drawCenteredText(ctx, label, w, Math.round((BANNER_HEIGHT - ICONS_TITLE_FONT_SIZE) / 2))
```

(The only two changed lines are the `ctx.font = ...` line and the final `drawCenteredText(...)` y argument, previously the literal `2`. Do NOT touch `drawPreviewTab` at `:198-231`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (whole file).

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): shrink icons-banner title to 14px, recentered; classic preview stays pinned at 16px"
```

---

### Task 2: Pure-black tile background + darker composited green fill

**Files:**
- Modify: `src/deck/tile-renderer.ts` (constants at lines 90-91, token-mapping comment block at lines 63-88, comment at ~line 326's test counterpart)
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `TILE_BG` (`:90`), `TILE_FILL_GREEN` (`:91`) — the single fill constant used for BOTH green states (`ctx.fillStyle = spec.fill === 'none' ? TILE_BG : TILE_FILL_GREEN` at `:234-236`; `TileFill = 'barTop' | 'green' | 'none'`). `EMPTY_BG = '#000000'` (`:100`, the #585 surround) is already pure black.
- Produces: `TILE_BG = '#000000'`, `TILE_FILL_GREEN = '#697d73'`. One shared constant deliberately keeps serving both green-fill states — they differ only by border today (barTop adds the bright `BAR_TOP_BORDER` ring) and the spec darkens both fills identically.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/tile-renderer.test.ts`, inside `describe('palette derives from the app UI tokens (mapping block in tile-renderer.ts)')` (near line 423), update the two literal pins in `'matches the documented app-token values'`:

```ts
expect(TILE_BG).toBe('#000000')          // deck-only pure black (matches EMPTY_BG surround)
expect(TILE_FILL_GREEN).toBe('#697d73')  // emerald-100 #d1fae5 @ 50% over black, precomputed
```

And add a derivation test in the same describe:

```ts
it('TILE_FILL_GREEN is emerald-100 composited at 50% opacity over black (round(c/2) per channel)', () => {
  // #d1fae5 = rgb(209,250,229) -> rgb(105,125,115) = #697d73. Same hue, darker.
  const composite = ['d1', 'fa', 'e5']
    .map((h) => Math.round(parseInt(h, 16) / 2).toString(16).padStart(2, '0'))
    .join('')
  expect(TILE_FILL_GREEN).toBe(`#${composite}`)
  // Borders stay full strength: the barTop BORDER is NOT darkened.
  expect(BAR_TOP_BORDER).toBe('#21c45d')
  expect(ACTIVE_COLOR).toBe('#ffffff')
})
```

Rename three now-inaccurate test names and one comment (behavior assertions unchanged — they reference the constants symbolically):
- `:166` `'no-fill tile: near-black bg, ...'` → `'no-fill tile: pure-black bg, banner, white title, no rings, no dot, no preview text'`
- `:176` `'green fill state paints the light-green background'` → `'green fill state paints the darker composited green background'`
- `:181` `'barTop state paints light-green background + 3px green border ring'` → `'barTop state paints the darker composited green background + full-strength 3px green border ring'`
- `:326` comment `// emerald-100 green fill` → `// composited green fill (emerald-100 @ 50% over black)`

Do NOT convert any index-based `rects[N]` assertion into a `rects.find(r => r.style === TILE_BG)` lookup — with `TILE_BG === EMPTY_BG` the surround (`rects[0]`) and interior (`rects[1]`) are now value-identical; index assertions stay unambiguous.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `'#09090b' !== '#000000'` and `'#d1fae5' !== '#697d73'`.

- [ ] **Step 3: Implement**

In `src/deck/tile-renderer.ts` change the two constants (lines 90-91):

```ts
export const TILE_BG = '#000000'
export const TILE_FILL_GREEN = '#697d73'
```

Update the token-mapping comment block (lines 63-88) — replace the `TILE_BG` and `TILE_FILL_GREEN` lines with:

```ts
//   TILE_BG           <- deck-only pure black (was --background dark #09090b).
//                        Matches EMPTY_BG, so unfilled tiles read as plain
//                        black keys: only banner/icons/rings carry state.     #000000
//   TILE_FILL_GREEN   <- bg-emerald-100     (TabItem.tsx green-filled tab)    #d1fae5
//                        precomposited at 50% opacity over the black tile:
//                        round(c/2) per channel -> rgb(105,125,115) = #697d73.
//                        Same hue as the tab bar's green, dark enough for the
//                        LCD. Both fill states (green + barTop) use it; the
//                        barTop BORDER stays full-strength BAR_TOP_BORDER.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): pure-black tile interiors; green fills precomposited at 50% over black (#697d73)"
```

---

### Task 3: Deck labels reuse the tab bar's `getTabDisplayTitle`

**Files:**
- Modify: `src/deck/deck-selectors.ts` (import + line 208)
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: `getTabDisplayTitle(tab: Tab, layout?: PaneNode, paneTitles?: Record<string, string>, extensions?: ClientExtensionEntry[]): string` from `src/lib/tab-title.ts:19-38` — the tab bar's already-extracted pure derivation (user-set title > single-pane override > non-placeholder programmatic title > derived name; discards `/^Tab \d+$/` placeholders). Call shape mirrors the tab bar and the e2e helper at `test/e2e/coding-agent-naming-flow.test.tsx:43`: `getTabDisplayTitle(tab, state.panes.layouts[tab.id], state.panes.paneTitles?.[tab.id], state.extensions?.entries)`.
- Produces: `DeckTab.title` (and therefore every `KeySpec.title` and the touch-strip `stripText` active-tab text, both of which copy `DeckTab.title`) now carries the tab bar's displayed label. No signature changes; Tasks 6-8 build on the model unchanged.

**Parity decision (explicit):** for a layout-less tab, `getTabDisplayTitle` returns the stored title (possibly `Tab N`) — exactly what the tab bar shows in that case (`TabBar.deriveTitle` test `:405` "falls back to stored title when no pane layout exists"). We pass `state.panes.layouts[tab.id]` directly like TabBar does and do NOT synthesize a leaf layout: the requirement is parity ("never a raw placeholder **when the tab bar would show something better**"), not divergence.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/deck-selectors.test.ts`, add imports:

```ts
import { getTabDisplayTitle } from '@/lib/tab-title'
```

Add a new describe (use the file's existing fixture builders — `makeState({ tabs, ... })` and the `claudeLeaf(...)` pane helper; mirror how the existing `'freshopencode targets carry cwd'` describe at `:167` seeds a leaf pane with an `initialCwd`):

```ts
describe('deck titles match the tab bar (getTabDisplayTitle parity)', () => {
  it('replaces a "Tab N" placeholder with the tab bar derived label (cwd basename)', () => {
    // Seed one tab whose stored title is the raw placeholder and whose single
    // claude pane has initialCwd '/home/dan/code/freshell'.
    const state = makeState({
      tabs: [{ id: 't1', title: 'Tab 1', pane: claudeLeaf('p1', 'term-1', '/home/dan/code/freshell') }],
    })
    const model = selectDeckModel(state)
    expect(model.tabs[0].title).toBe('freshell')
    // Load-bearing parity assertion: byte-identical with the tab bar's call.
    const tab = state.tabs.tabs[0]
    expect(model.tabs[0].title).toBe(
      getTabDisplayTitle(tab, state.panes.layouts[tab.id], state.panes.paneTitles?.[tab.id], state.extensions?.entries),
    )
  })

  it('keeps a user-set custom title verbatim', () => {
    const state = makeState({
      tabs: [{ id: 't1', title: 'my custom name', titleSetByUser: true, pane: claudeLeaf('p1', 'term-1', '/tmp/x') }],
    })
    expect(selectDeckModel(state).tabs[0].title).toBe('my custom name')
  })

  it('layout-less tab falls back to the stored title, exactly like the tab bar', () => {
    const state = makeState({ tabs: [{ id: 't1', title: 'Tab 1' }] }) // no pane layout
    const tab = state.tabs.tabs[0]
    expect(selectDeckModel(state).tabs[0].title).toBe(
      getTabDisplayTitle(tab, state.panes.layouts[tab.id], state.panes.paneTitles?.[tab.id], state.extensions?.entries),
    )
  })
})
```

Adapt the fixture-shape details to `makeState`'s actual option shape in that file (it already builds tabs + pane layouts + settings); the three assertions above are the contract. Note the deck unit-test store does NOT register the `extensions` reducer — the implementation must use `state.extensions?.entries` optional chaining or these tests crash.

Also check the existing pin at `:124` (`expect(model.tabs[0]).toMatchObject({ id: 't1', title: 'build', ... })`): `'build'` is a non-placeholder stored title that differs from the derived name, so `getTabDisplayTitle` keeps it and the pin should still pass. If the fixture's derived name happens to equal the stored title, update the fixture title rather than weakening the assertion.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `'Tab 1' !== 'freshell'` (deck currently copies the raw store title).

- [ ] **Step 3: Implement**

In `src/deck/deck-selectors.ts` add the import:

```ts
import { getTabDisplayTitle } from '@/lib/tab-title'
```

In `selectDeckModel` (line 208), replace `title: tab.title,` with:

```ts
// Same label the tab bar displays (custom title, else derived default such as
// the working-directory basename) — reuse the tab bar's derivation verbatim.
// extensions uses ?. because unit-test stores may omit that reducer.
title: getTabDisplayTitle(tab, state.panes.layouts[tab.id], state.panes.paneTitles?.[tab.id], state.extensions?.entries),
```

No changes to `frame.ts` or `tile-renderer.ts`: tiles (`frame.ts:119`/`:124`), previews, and the touch strip (`stripText` reads `active?.title` at `frame.ts:83`) all copy `DeckTab.title`. Live repaint is free — `DeckController.onStoreChange` JSON-diffs the model, so a title change repaints automatically.

- [ ] **Step 4: Run tests to verify they pass, and run neighbors**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS. If any existing deck test seeded a placeholder-titled tab WITH a cwd-bearing pane and pinned the placeholder, update that pin to the derived label (that is the new correct behavior). (Strip/e2e parity coverage is added in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-selectors.ts test/unit/client/deck/deck-selectors.test.ts
git commit -m "feat(deck): tiles and strip show the tab bar's displayed label via getTabDisplayTitle"
```

---

### Task 4: `streamDeck.keyLayout` setting — shared layer + persistence

**Files:**
- Modify: `shared/settings.ts` (value tuple + type near line 99, `LocalSettings.streamDeck` at 225-231, zod schema near 266, patch normalizer at 635-655, defaults at 902-908, legacy-seed `pickKeys` allowlist at ~1463)
- Modify: `src/store/browserPreferencesPersistence.ts` (streamDeck block at lines 145-153)
- Modify (fixture ripple, same task): `test/unit/client/components/settings/StreamDeckSettings.test.tsx` (`renderSection` default streamDeck object at ~line 24). Do NOT touch `defaultSettings()` in `test/e2e/stream-deck-flow.test.tsx` (see Step 3).
- Test: `test/unit/shared/settings.stream-deck.test.ts`

**Interfaces:**
- Consumes: the `tileStyle` precedent end-to-end (`DECK_TILE_STYLE_VALUES`/`DeckTileStyle`/`DeckTileStyleSchema`/normalizer/defaults/persistence).
- Produces: `export const DECK_KEY_LAYOUT_VALUES = ['auto', 'newest-first', 'status-sorted'] as const`; `export type DeckKeyLayout = (typeof DECK_KEY_LAYOUT_VALUES)[number]`; `LocalSettings['streamDeck']` gains `keyLayout: DeckKeyLayout`; `defaultLocalSettings.streamDeck.keyLayout === 'auto'`. Tasks 5-8 consume `DeckKeyLayout` and the persisted value at `state.settings.settings.streamDeck.keyLayout`.

- [ ] **Step 1: Write the failing tests**

In `test/unit/shared/settings.stream-deck.test.ts`, mirroring the existing `describe('streamDeck.tileStyle')` block exactly (same imports and helpers), add:

```ts
describe('streamDeck.keyLayout', () => {
  it('defaults to auto', () => {
    expect(defaultLocalSettings.streamDeck.keyLayout).toBe('auto')
  })

  it('round-trips newest-first through patch normalization and persistence', () => {
    // Mirror the tileStyle round-trip test one-for-one, substituting
    // { streamDeck: { keyLayout: 'newest-first' } } and asserting the
    // resolved settings carry keyLayout 'newest-first' and
    // buildLocalSettingsPatch emits streamDeck.keyLayout 'newest-first'.
  })

  it('drops invalid keyLayout values during extraction', () => {
    // Mirror the tileStyle invalid-value test: extractLegacyLocalSettingsSeed
    // with streamDeck.keyLayout: 'sideways' must not emit a keyLayout key.
  })

  it('produces no persisted entry at the default value', () => {
    // buildLocalSettingsPatch(defaultLocalSettings) has no streamDeck.keyLayout.
  })

  it('survives the reload path: a parsed browser-preferences record preserves streamDeck.keyLayout', () => {
    // Reload-path proxy (round-trip tests alone cannot catch a whitelist-on-read
    // gap): boot hydration routes the localStorage blob through
    // parseBrowserPreferencesRaw -> extractLegacyLocalSettingsSeed (pickKeys
    // allowlist, settings.ts ~:1463) -> normalizeExtractedLocalSeed (value gate,
    // ~:635-655). BOTH gates strip unknown keys, so each must learn keyLayout or
    // the setting persist-then-vanishes on reload. Parse
    // JSON.stringify({ settings: { streamDeck: { keyLayout: 'newest-first' } } })
    // with the real parse function from src/lib/browser-preferences (adapt the
    // import to its actual export) and assert the resulting record carries
    // streamDeck.keyLayout 'newest-first'.
  })
})
```

Fill each body by copying the adjacent `tileStyle` test in the same file and substituting the key/value — those tests are the canonical template (they exercise `resolveLocalSettings`, `buildLocalSettingsPatch`, and `extractLegacyLocalSettingsSeed`). Also update the two full-object assertions that will now fail: `'has safe defaults'` (`:12`) and `'round-trips a patch through resolve -> buildLocalSettingsPatch'` (`:22`) gain `keyLayout: 'auto'` in their expected `streamDeck` objects.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/shared/settings.stream-deck.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `defaultLocalSettings.streamDeck.keyLayout` is `undefined`.

- [ ] **Step 3: Implement**

In `shared/settings.ts`, next to the `DECK_TILE_STYLE_VALUES` block:

```ts
/** Key layout for the Stream Deck. 'auto' resolves per device: reversed
 * ("newest first", pager pinned top-left) on the smallest decks
 * (keyCount <= 6, e.g. the 6-key Mini), status-sorted on larger decks.
 * 'newest-first' = strictly reverse tab-bar order: newest tab first while
 * tabs are unreordered; after a manual reorder (or cross-device order sync)
 * the deck mirrors the reversed tab bar. Deliberate — see plan naming note. */
export const DECK_KEY_LAYOUT_VALUES = ['auto', 'newest-first', 'status-sorted'] as const
export type DeckKeyLayout = (typeof DECK_KEY_LAYOUT_VALUES)[number]
```

Next to `DeckTileStyleSchema` (~line 266):

```ts
const DeckKeyLayoutSchema = z.enum(DECK_KEY_LAYOUT_VALUES)
```

In `LocalSettings.streamDeck` (~line 230), add `keyLayout: DeckKeyLayout`. In the patch normalizer's streamDeck block (~line 649), alongside the tileStyle guard:

```ts
if (DeckKeyLayoutSchema.safeParse(patch.streamDeck.keyLayout).success) {
  streamDeck.keyLayout = patch.streamDeck.keyLayout as DeckKeyLayout
}
```

In `defaultLocalSettings.streamDeck` (~line 907), add `keyLayout: 'auto'`. In `extractLegacyLocalSettingsSeed`'s `pickKeys` allowlist (~line 1463), append `'keyLayout'`:

```ts
pickKeys(raw.streamDeck, ['enabled', 'brightness', 'idleBrightness', 'idleTimeoutSeconds', 'tileStyle', 'keyLayout'])
```

(Both read-path gates are individually load-bearing: boot hydration routes the localStorage blob through `extractLegacyLocalSettingsSeed`'s pickKeys allowlist AND `normalizeExtractedLocalSeed`'s value gate. Miss either one and the setting persists but silently vanishes on reload — while the patch round-trip tests still pass. The reload-path test in Step 1 guards exactly this.)

In `src/store/browserPreferencesPersistence.ts` streamDeck block (~line 150), add:

```ts
assignChangedScalar(streamDeck, localSettings.streamDeck, defaultLocalSettings.streamDeck, 'keyLayout')
```

Fixture ripple (runtime, not typecheck — test files sit outside BOTH tsconfig includes, so no test file can ever produce a typecheck error in this repo): add `keyLayout: 'auto' as const` to the `renderSection` default streamDeck object in `test/unit/client/components/settings/StreamDeckSettings.test.tsx` (~line 24) — Task 5's `value={streamDeck.keyLayout}` control needs it at runtime to render 'Auto' as pressed. Do NOT touch `defaultSettings()` in `test/e2e/stream-deck-flow.test.tsx`: that object is the controller's settings-callback shape (`DeckControllerOptions.settings`, `deck-controller.ts:37`), which never carries `keyLayout` — keyLayout reaches the deck via the store (`updateSettingsLocal` → `selectDeckModel`, Task 6) — and adding `keyLayout` to that annotated literal is an excess-property type error (TS2353) in an editor, not a fix.

- [ ] **Step 4: Run tests + typecheck to verify green**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/shared/settings.stream-deck.test.ts test/unit/client/components/settings/StreamDeckSettings.test.tsx test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts && npm run typecheck`
Expected: PASS + clean typecheck. Fix any remaining full-object streamDeck literal the typechecker flags (mechanical: add `keyLayout: 'auto'`) — note tsc covers only `src/` + `shared/` (tests are outside both tsconfig includes, so fixture drift never surfaces via typecheck); the only production full-object literal is `defaultLocalSettings.streamDeck`, already edited above.

- [ ] **Step 5: Commit**

```bash
git add shared/settings.ts src/store/browserPreferencesPersistence.ts test/unit/shared/settings.stream-deck.test.ts test/e2e/stream-deck-flow.test.tsx test/unit/client/components/settings/StreamDeckSettings.test.tsx
git commit -m "feat(settings): streamDeck.keyLayout (auto | newest-first | status-sorted), persisted client-side"
```

---

### Task 5: Settings UI — "Key layout" segmented control

**Files:**
- Modify: `src/components/settings/StreamDeckSettings.tsx` (new `SettingsRow` after the "Tile style" row at lines 79-95)
- Test: `test/unit/client/components/settings/StreamDeckSettings.test.tsx`

**Interfaces:**
- Consumes: `DeckKeyLayout` from Task 4; existing `SettingsRow` + `SegmentedControl` primitives (`settings-controls.tsx` — `role="group"` + per-option `<button aria-pressed>`); `applyLocalSetting({ streamDeck: { ... } })` prop.
- Produces: user-facing control patching `streamDeck.keyLayout`. Live-apply needs no wiring: Task 6 puts `keyLayout` on `DeckModel`, and the controller's JSON model diff repaints on change.

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/components/settings/StreamDeckSettings.test.tsx`, mirroring the existing tile-style tests one-for-one:

```ts
it('offers the key layout choice with Auto selected by default', () => {
  renderSection()
  const group = screen.getByRole('group', { name: /key layout/i })
  expect(within(group).getByRole('button', { name: 'Auto' })).toHaveAttribute('aria-pressed', 'true')
  expect(within(group).getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'false')
  expect(within(group).getByRole('button', { name: 'Status sorted' })).toHaveAttribute('aria-pressed', 'false')
})

it('selecting Newest first patches streamDeck.keyLayout', () => {
  const { applyLocalSetting } = renderSection()
  fireEvent.click(within(screen.getByRole('group', { name: /key layout/i })).getByRole('button', { name: 'Newest first' }))
  expect(applyLocalSetting).toHaveBeenCalledWith({ streamDeck: { keyLayout: 'newest-first' } })
})
```

(Match `renderSection`'s actual return shape in that file — the existing `'selecting Terminal previews patches streamDeck.tileStyle'` test shows how it exposes the `applyLocalSetting` spy.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/components/settings/StreamDeckSettings.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — no `group` named "key layout".

- [ ] **Step 3: Implement**

In `src/components/settings/StreamDeckSettings.tsx`, extend the type import at line 9 to `import type { DeckTileStyle, DeckKeyLayout } from '../../../shared/settings'` and add, directly after the "Tile style" `SettingsRow`:

```tsx
      <SettingsRow
        label="Key layout"
        description="Auto uses Newest first on small decks (6 keys or fewer) and Status sorted on larger ones. Newest first pins the pager top-left and mirrors the tab bar in reverse — newest tabs first — in stable positions. Status sorted orders keys by attention, with a pager only on overflow."
      >
        <SegmentedControl
          value={streamDeck.keyLayout}
          aria-label="Key layout"
          options={[
            { value: 'auto', label: 'Auto' },
            { value: 'newest-first', label: 'Newest first' },
            { value: 'status-sorted', label: 'Status sorted' },
          ]}
          onChange={(v: string) => {
            const keyLayout = v as DeckKeyLayout
            applyLocalSetting({ streamDeck: { keyLayout } })
          }}
        />
      </SettingsRow>
```

- [ ] **Step 4: Run tests + lint to verify green**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/components/settings/StreamDeckSettings.test.tsx --config config/vitest/vitest.config.ts && npm run lint`
Expected: PASS; lint clean (jsx-a11y: the group/aria-pressed pattern is the repo's established accessible pattern).

- [ ] **Step 5: Commit**

```bash
git add src/components/settings/StreamDeckSettings.tsx test/unit/client/components/settings/StreamDeckSettings.test.tsx
git commit -m "feat(settings): Key layout control (Auto / Newest first / Status sorted) in Stream Deck settings"
```

---

### Task 6: Arrangement machinery — `resolveArrangement`, `arrangeTabs`, reversed `planLayout`, model plumbing

**Files:**
- Modify: `src/deck/frame.ts` (new exports; `planLayout` at lines 32-51; `buildFrame` at 96-145)
- Modify: `src/deck/deck-selectors.ts` (`DeckTab` at 18-30 gains `tabIndex`; `DeckModel` gains `keyLayout`; `selectDeckModel` at 200-228)
- Test: `test/unit/client/deck/frame.test.ts`, `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: `DeckKeyLayout` from Task 4 (`@shared/settings`); `DeckCapabilities.keyCount`; `MINI_CAPS` (6 keys) / `PLUS_CAPS` (8 keys, 4 dials, strip) from `@/deck/fake-deck-device`.
- Produces (exact signatures — Tasks 7-8 depend on these):
  - `export type DeckArrangement = 'standard' | 'reversed'` (frame.ts)
  - `export const AUTO_REVERSED_MAX_KEYS = 6` (frame.ts)
  - `export function resolveArrangement(keyLayout: DeckKeyLayout, keyCount: number): DeckArrangement` (frame.ts)
  - `export function arrangeTabs(tabs: DeckTab[], arrangement: DeckArrangement): DeckTab[]` (frame.ts)
  - `export function planLayout(caps: DeckCapabilities, tabCount: number, arrangement: DeckArrangement = 'standard'): LayoutPlan` — third param TEMPORARILY defaulted so the controller still compiles; Task 7 removes the default.
  - `DeckTab` gains `tabIndex: number` (position in the tab bar); `DeckModel` gains `keyLayout: DeckKeyLayout`.
  - `LayoutPlan` shape is unchanged (no new fields — reversed is fully expressed via `pagerKey: 0` + `tabSlots: [1..keyCount-1]`), so the full-`toEqual` planner tests keep their shape.

**Design notes (locked):** the model keeps its existing order (priority-sorted for `status-icons`, raw for `terminal-previews`) so the STANDARD path — including `selectDeckModel`'s sort tests — is untouched. `tabIndex` records the tab-bar position; `arrangeTabs(tabs, 'reversed')` sorts by `tabIndex` descending, which is strictly reverse tab-bar order regardless of any prior priority sort (deterministic, muscle-memory-stable; status still shows via fills/icons/rings). Reversed reserves the pager at key 0 ALWAYS (even when tabs fit, even in dial/strip "full" mode) so positions never shift; `tabsPerPage` is therefore constant at `keyCount - 1`. The action layer cannot collide with the key-0 pager: `buildFrame` returns the action frame before pager placement, and `handleKeyUp` routes to the action handler before consulting the press snapshot. Do NOT touch `deck-controller.ts` in this task: the controller keeps calling `planLayout(caps, n)` (temporary `'standard'` default) and stays standard-only until Task 7 — threading the arrangement into any controller call site early breaks the migrated deck-controller and VirtualDeckPanel suites at this task's green gate.

- [ ] **Step 1: Write the failing tests**

First, migrate fixtures so the whole suite stays green and arrangement-explicit at this task's boundary (settings default `keyLayout: 'auto'` resolves REVERSED on the 6-key Mini, which would silently flip every Mini-based fixture):

1. `test/unit/client/deck/frame.test.ts`: `makeDeckTab` gains a `tabIndex: 0` default (overridable); the `model(n)` helper stamps `tabIndex: i` on each tab and adds `keyLayout: 'status-sorted' as const` to the returned model, with this comment: `// Existing tests document the STANDARD arrangement explicitly; 'auto' resolution and the reversed arrangement have dedicated tests.` ALSO migrate the two tests that build inline `DeckModel` literals WITHOUT the `model(n)` helper — `'buildFrame carries fill/paneIcons/icons onto tab keys, with iconReady resolving readiness'` (`:86-112`, local `const model: DeckModel` shadows the helper) and `'pane icon readiness is stamped from iconReady using the tinted data URL'` (`:113-133`, local `m`) — by adding `keyLayout: 'status-sorted' as const` to each literal (their tabs come from `makeDeckTab`, so the new `tabIndex: 0` default covers them). Without this, `undefined` falls into the `'auto'` branch, MINI_CAPS (6 keys) resolves REVERSED, key 0 becomes the pager, and both tests' `frame.keys[0]` assertions fail. CAUTION: test files sit outside every tsconfig include, so tsc will NOT flag a missed literal — before Step 4, grep the file for `activeTabId:` to enumerate every inline model and confirm each has an explicit `keyLayout`.
2. `test/unit/client/deck/deck-controller.test.ts`: add `keyLayout?: DeckKeyLayout` to `StoreOpts` (`:38-59`), seeded wherever `tileStyle` is seeded (store settings AND the controller `settings()` thunk if it carries it — mirror the `tileStyle` mechanism and its invariant comment at `:50-56`), defaulting to `'status-sorted'` with the same rationale comment. This keeps every existing expectation (pager at key 5, sorted tile order, press-snapshot tests) valid and meaningful once the controller becomes arrangement-aware in Task 7, and keeps this task's intermediate state (buildFrame arrangement-aware, controller not yet) consistent.
3. `test/e2e/stream-deck-flow.test.tsx`: same for `DeckStoreOpts` — `keyLayout?: DeckKeyLayout` applied via the production action mirroring `tileStyle` at `:127-129` (`store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout } }))`), defaulting existing tests to `'status-sorted'`.

Then add the new tests in `test/unit/client/deck/frame.test.ts`:

```ts
import { arrangeTabs, resolveArrangement } from '@/deck/frame'

describe('resolveArrangement', () => {
  it('auto resolves reversed on <= 6 keys and standard on larger decks', () => {
    expect(resolveArrangement('auto', 6)).toBe('reversed')
    expect(resolveArrangement('auto', 8)).toBe('standard')
  })
  it('explicit values override auto regardless of key count', () => {
    expect(resolveArrangement('newest-first', 8)).toBe('reversed')
    expect(resolveArrangement('status-sorted', 6)).toBe('standard')
  })
})

describe('arrangeTabs', () => {
  it('reversed returns strictly reverse tab-bar order, ignoring priority', () => {
    const tabs = [
      makeDeckTab({ id: 'a', title: 'a', tabIndex: 0, priority: 4 }),
      makeDeckTab({ id: 'b', title: 'b', tabIndex: 1, priority: 0 }),
      makeDeckTab({ id: 'c', title: 'c', tabIndex: 2, priority: 2 }),
    ]
    expect(arrangeTabs(tabs, 'reversed').map((t) => t.id)).toEqual(['c', 'b', 'a'])
    expect(tabs.map((t) => t.id)).toEqual(['a', 'b', 'c']) // input not mutated
  })
  it('standard returns the input order untouched', () => {
    const tabs = [makeDeckTab({ id: 'a', title: 'a', tabIndex: 0 }), makeDeckTab({ id: 'b', title: 'b', tabIndex: 1 })]
    expect(arrangeTabs(tabs, 'standard')).toBe(tabs)
  })
})

describe('planLayout reversed arrangement', () => {
  it('mini reversed: pager reserved at key 0 even when tabs fit, 5 tabs per page', () => {
    expect(planLayout(MINI_CAPS, 3, 'reversed')).toEqual({
      mode: 'keys', keyCount: 6, tabSlots: [1, 2, 3, 4, 5], pagerKey: 0, tabsPerPage: 5,
      useDials: false, useStrip: false,
    })
  })
  it('plus reversed: pager at key 0 with dials and strip still active', () => {
    expect(planLayout(PLUS_CAPS, 2, 'reversed')).toEqual({
      mode: 'full', keyCount: 8, tabSlots: [1, 2, 3, 4, 5, 6, 7], pagerKey: 0, tabsPerPage: 7,
      useDials: true, useStrip: true,
    })
  })
})

describe('buildFrame reversed', () => {
  const reversedModel = (n: number) => ({ ...model(n), keyLayout: 'newest-first' as const })

  it('newest-first on the mini: pager on key 0, last tab on key 1, older tabs on page 2', () => {
    const m = reversedModel(7) // tabs tab-0 .. tab-6 in tab-bar order
    const f1 = buildFrame({ model: m, caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f1.keys[0]).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
    expect(f1.keys[1]).toMatchObject({ kind: 'tab', tabId: 'tab-6' }) // newest = last in the bar
    expect(f1.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-5' })
    expect(f1.keys[5]).toMatchObject({ kind: 'tab', tabId: 'tab-2' })
    const f2 = buildFrame({ model: m, caps: MINI_CAPS, page: 2, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f2.keys[0]).toMatchObject({ kind: 'pager', page: 2, pageCount: 2 })
    expect(f2.keys[1]).toMatchObject({ kind: 'tab', tabId: 'tab-1' })
    expect(f2.keys[2]).toMatchObject({ kind: 'tab', tabId: 'tab-0' })
    expect(f2.keys[3]).toEqual({ kind: 'empty' })
  })

  it('pager renders 1/1 and stays reserved when all tabs fit', () => {
    const f = buildFrame({ model: reversedModel(3), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(f.keys[0]).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
    expect(f.keys[1]).toMatchObject({ kind: 'tab', tabId: 'tab-2' })
  })

  it('auto on the mini resolves reversed; auto on the plus stays standard', () => {
    const auto = (n: number) => ({ ...model(n), keyLayout: 'auto' as const })
    const mini = buildFrame({ model: auto(2), caps: MINI_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(mini.keys[0]).toMatchObject({ kind: 'pager' })
    const plus = buildFrame({ model: auto(2), caps: PLUS_CAPS, page: 1, actionLayer: null, iconReady: noIcon, previewFor: noPreview })
    expect(plus.keys[0]).toMatchObject({ kind: 'tab', tabId: 'tab-0' }) // full mode, no pager
  })
})
```

In `test/unit/client/deck/deck-selectors.test.ts`, add (clone the `withTileStyle` helper at `:225-229` into a `withKeyLayout(state, keyLayout)` sibling):

```ts
it('exposes keyLayout on the model (default auto)', () => {
  expect(selectDeckModel(makeState({ tabs: [/* one plain tab */] })).keyLayout).toBe('auto')
  expect(selectDeckModel(withKeyLayout(base, 'newest-first')).keyLayout).toBe('newest-first')
})

it('stamps tabIndex with the tab-bar position, surviving the priority sort', () => {
  // Reuse the sort fixture from 'sorts tabs by priority...' (:365): after the
  // sort, each DeckTab.tabIndex still equals its position in state.tabs.tabs.
  const model = selectDeckModel(sortFixtureState)
  for (const t of model.tabs) {
    expect(t.tabIndex).toBe(sortFixtureState.tabs.tabs.findIndex((tab) => tab.id === t.id))
  }
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/frame.test.ts test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `resolveArrangement`/`arrangeTabs` not exported; `keyLayout`/`tabIndex` missing.

- [ ] **Step 3: Implement**

In `src/deck/deck-selectors.ts`: add `import type { DeckKeyLayout } from '@shared/settings'` (alongside the existing `DeckTileStyle` import); add `tabIndex: number` to `DeckTab` and `keyLayout: DeckKeyLayout` to `DeckModel`; in `selectDeckModel`, change the map to `state.tabs.tabs.map((tab, index) => { ... tabIndex: index, ... })` and the return to `{ activeTabId, tabs, tileStyle, keyLayout: state.settings.settings.streamDeck.keyLayout }`. The priority sort at `:220-225` is untouched (it is stable, so `tabIndex` stays truthful to bar position).

In `src/deck/frame.ts`, add above `planLayout`:

```ts
import type { DeckKeyLayout } from '@shared/settings'

export type DeckArrangement = 'standard' | 'reversed'

/** Smallest decks (<= 6 keys, e.g. the 6-key Mini) default to the reversed
 * "newest first" arrangement under keyLayout 'auto'; larger decks keep the
 * status-sorted standard. */
export const AUTO_REVERSED_MAX_KEYS = 6

export function resolveArrangement(keyLayout: DeckKeyLayout, keyCount: number): DeckArrangement {
  if (keyLayout === 'newest-first') return 'reversed'
  if (keyLayout === 'status-sorted') return 'standard'
  return keyCount <= AUTO_REVERSED_MAX_KEYS ? 'reversed' : 'standard'
}

/** Reversed = strictly reverse tab-bar order (newest first while tabs are
 * unreordered; after a manual reorder or cross-device order sync it mirrors
 * the reversed tab bar) with NO status sorting, so key positions are
 * deterministic and muscle-memory-stable (status still shows via
 * fills/icons/rings). Standard keeps the model's order: status-sorted for
 * status-icons, raw tab-bar order for previews. */
export function arrangeTabs(tabs: DeckTab[], arrangement: DeckArrangement): DeckTab[] {
  if (arrangement !== 'reversed') return tabs
  return [...tabs].sort((a, b) => b.tabIndex - a.tabIndex)
}
```

(`DeckTab`/`DeckModel` are already imported from `./deck-selectors` for `buildFrame`; extend that type import with `DeckTab` if not present.)

Change `planLayout` to take the third parameter and add the reversed branch FIRST:

```ts
export function planLayout(caps: DeckCapabilities, tabCount: number, arrangement: DeckArrangement = 'standard'): LayoutPlan {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i)
  if (arrangement === 'reversed') {
    const full = caps.dialCount >= 2 && caps.hasTouchStrip
    return {
      mode: full ? 'full' : 'keys',
      keyCount: caps.keyCount,
      // Pager ALWAYS reserved at top-left (key 0) — even when all tabs fit —
      // so tab positions never shift as the tab count crosses capacity.
      tabSlots: range(caps.keyCount - 1).map((i) => i + 1),
      pagerKey: 0,
      tabsPerPage: caps.keyCount - 1,
      useDials: full,
      useStrip: caps.hasTouchStrip,
    }
  }
  // ... the existing three branches, byte-for-byte unchanged ...
}
```

In `buildFrame` (lines 96-145), derive the arrangement and slice the arranged list:

```ts
const arrangement = resolveArrangement(model.keyLayout, caps.keyCount)
const plan = planLayout(caps, model.tabs.length, arrangement)
```
and change line 112 from `visibleTabs(model.tabs, current, plan.tabsPerPage)` to:
```ts
const visible = visibleTabs(arrangeTabs(model.tabs, arrangement), current, plan.tabsPerPage)
```
Everything else in `buildFrame` (action-layer early return, `plan.tabSlots.forEach` slot assignment, `keys[plan.pagerKey] = { kind: 'pager', page: current, pageCount: pages }`, `stripText(model, ...)`) is unchanged — the pager placement line already handles key 0.

- [ ] **Step 4: Run tests to verify green (deck dir + e2e)**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts && npm run typecheck`
Expected: ALL PASS — the Step 1 fixture migration pinned existing controller/e2e suites to `'status-sorted'`, so this task's intermediate state (buildFrame arrangement-aware, controller still standard-only) is consistent and green. `VirtualDeckPanel.test.tsx` also stays green here: it asserts press effects only, and press resolution is unchanged until Task 7.

- [ ] **Step 5: Commit**

```bash
git add src/deck/frame.ts src/deck/deck-selectors.ts test/unit/client/deck/frame.test.ts test/unit/client/deck/deck-selectors.test.ts test/unit/client/deck/deck-controller.test.ts test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): reversed arrangement machinery - resolveArrangement, arrangeTabs, always-reserved top-left pager plan"
```

---

### Task 7: Controller integration — reversed arrangement live, press-snapshot safe

**Files:**
- Modify: `src/deck/deck-controller.ts` (call sites at lines ~147, ~238, ~273, ~294, ~358, ~378; new private helper)
- Modify: `src/deck/frame.ts` (remove the temporary `= 'standard'` default from `planLayout`)
- Test: `test/unit/client/deck/deck-controller.test.ts`, `test/unit/client/components/VirtualDeckPanel.test.tsx` (existing-test update only)

**Interfaces:**
- Consumes: `resolveArrangement`, `arrangeTabs`, `planLayout(caps, tabCount, arrangement)` and `DeckArrangement` from Task 6; `DeckModel.keyLayout`.
- Produces: private `layout(model)` helper inside `DeckController`; all plan/order consumers (repaint diffing, page clamping, press-snapshot resolver, pager handler, dial handlers) go through it. `planLayout`'s third parameter becomes required, so tsc proves no call site was missed.

- [ ] **Step 1: Write the failing tests**

The fixture migration (StoreOpts/DeckStoreOpts `keyLayout` defaulting to `'status-sorted'`) already landed in Task 6, so the existing suite documents the standard arrangement explicitly and stays green throughout. In `test/unit/client/deck/deck-controller.test.ts`, add the new tests (using the file's existing `setup`, `decodeKey`, `shortPress`, `longPress` helpers and `PLUS_CAPS` import):

```ts
it('reversed: pager pinned to key 0; newest tab on key 1; press advances and wraps', () => {
  const { device } = setup({ tabCount: 8, keyLayout: 'newest-first' }) // MINI: 5 tabs/page -> 2 pages
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't8' }) // last tab in the bar
  expect(decodeKey(device, 5)).toMatchObject({ kind: 'tab', tabId: 't4' })
  shortPress(device, 0)
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 2, pageCount: 2 })
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
  shortPress(device, 0) // wraps
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
})

it('reversed: pager press with a single page is a harmless wrap to the same page', () => {
  const { device } = setup({ tabCount: 2, keyLayout: 'newest-first' })
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
  shortPress(device, 0)
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't2' }) // unchanged
})

it('auto resolves reversed on the 6-key Mini and standard on the 8-key Plus', () => {
  const mini = setup({ tabCount: 3, keyLayout: 'auto' })
  expect(decodeKey(mini.device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
  expect(decodeKey(mini.device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
  const plus = setup({ tabCount: 3, keyLayout: 'auto' }, PLUS_CAPS)
  expect(decodeKey(plus.device, 0)).toMatchObject({ kind: 'tab', tabId: 't1' }) // full mode, no pager
})

it('reversed: short press on key 1 focuses the newest tab', () => {
  const { store, device } = setup({ tabCount: 3, keyLayout: 'newest-first' })
  shortPress(device, 1)
  // Mirror the assertion style of 'short press focuses the tab in the browser' (:204)
  expect(store.getState().tabs.activeTabId).toBe('t3')
})

it('reversed: press-snapshot guard - a tab opened mid-press cannot retarget the press', () => {
  // Mirror 'acts on the tab displayed at press-down even if the sort changes
  // mid-press' (:215): keyDown on key 1 (currently t3, the newest), dispatch
  // the store action that adds a new tab t4 (shifting t3 to key 2), then keyUp
  // on key 1 - the press must still focus t3, not t4.
})

it('switching key layout live re-arranges keys and preserves the page when tabsPerPage is unchanged', () => {
  const { store, device } = setup({ tabCount: 8, keyLayout: 'status-sorted' })
  expect(decodeKey(device, 5)).toMatchObject({ kind: 'pager' }) // standard overflow pager, bottom-right
  shortPress(device, 5) // go to page 2 in standard
  store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 2, pageCount: 2 }) // page preserved: tabsPerPage unchanged (5), clampPage(2, 2) === 2
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' }) // reversed page 2 shows t3, t2, t1
})
```

Note on the last test: on a 6-key deck with 8 tabs, `tabsPerPage` is 5 in BOTH arrangements, so the existing `tabsPerPage`-change page reset (deck-controller.ts:238-240) does not fire, and `clampPage(2, 2) === 2` preserves page 2 — the deterministic outcome is: page 2 preserved, pager repainted at key 0, reversed page 2 showing `t3, t2, t1` (so key 1 → `t3`). The frame must still repaint into the reversed arrangement (the model JSON diff includes `keyLayout`). The literals above pin exactly that outcome; the reset-to-page-1 behavior is covered by the next test, where `tabsPerPage` genuinely changes.

Also add the layout-change page-reset behavior test where `tabsPerPage` DOES change (Plus, explicit switch): `setup({ tabCount: 9, keyLayout: 'status-sorted' }, PLUS_CAPS)` is full-mode (8/page); dispatching `keyLayout: 'newest-first'` makes it 7/page and must reset to page 1 via the existing `tabsPerPage`-change reset (`deck-controller.ts:238-240`).

And in `test/unit/client/components/VirtualDeckPanel.test.tsx`, update the existing `'clicking key 2 focuses tab 2 in the store (short press)'` test for the new Mini default (its real 13-reducer store defaults `keyLayout: 'auto'`, which now resolves REVERSED on the 6-key Mini once the controller honors it): re-point the expectation so the DEFAULT experience is what the virtual-deck suite documents — `Deck key 1` (physical index 0) is the pager, and clicking `Deck key 2` (physical index 1) focuses the LAST tab in tab-bar order.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — controller still plans with the standard arrangement (pager at key 5 or absent; key 1 shows t2 not t3).

- [ ] **Step 3: Implement**

In `src/deck/deck-controller.ts`, extend the frame import with `arrangeTabs, resolveArrangement` and `type DeckArrangement`, and add a private helper next to `resolveKeyTarget`:

```ts
/** Single source of arrangement truth for this device: plan + ordered tabs.
 * buildFrame derives the same pair internally from model.keyLayout + caps,
 * so painting and press targeting stay mirror images. */
private layout(model: DeckModel): { arrangement: DeckArrangement; plan: LayoutPlan; tabs: DeckTab[] } {
  const arrangement = resolveArrangement(model.keyLayout, this.device.capabilities.keyCount)
  return {
    arrangement,
    plan: planLayout(this.device.capabilities, model.tabs.length, arrangement),
    tabs: arrangeTabs(model.tabs, arrangement),
  }
}
```

Replace every `planLayout(this.device.capabilities, model.tabs.length)` call with the helper:
- `repaint()` (~:147): `const { plan } = this.layout(model)` (page clamp + `lastTabsPerPage` logic unchanged).
- `onStoreChange()` (~:238): same substitution; the `tabsPerPage`-change reset and clamp are unchanged.
- `resolveKeyTarget()` (~:273): use `const { plan, tabs } = this.layout(model)`; keep the pager check and `plan.tabSlots.indexOf(keyIndex)`; change the final lookup to `visibleTabs(tabs, clampPage(this.page, pages), plan.tabsPerPage)[slot]`.
- pager press handler (~:294): `const { plan } = this.layout(model)` for `pages` (wrap logic unchanged — with one page it wraps to page 1, a no-op).
- `handleDialRotate` (~:358): dial 0 cycles the ARRANGED list (`const { tabs } = this.layout(model)` and index over `tabs`), dial 1 pages via the helper's plan — dials operate on whatever arrangement is active, semantics unchanged.
- `handleDialPress` (~:378): same substitution for its plan usage.

Then in `src/deck/frame.ts` remove the temporary default: `planLayout(caps: DeckCapabilities, tabCount: number, arrangement: DeckArrangement)`. Run `npm run typecheck` — the compiler now proves every call site passes an arrangement (grep `planLayout(` across `src/` must show only three-argument calls).

- [ ] **Step 4: Run tests to verify green**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/unit/client/deck/ --config config/vitest/vitest.config.ts && npm run typecheck`
Expected: PASS (all deck unit tests, including the migrated standard-arrangement suite).

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-controller.ts src/deck/frame.ts test/unit/client/deck/deck-controller.test.ts test/unit/client/components/VirtualDeckPanel.test.tsx
git commit -m "feat(deck): controller honors keyLayout - reversed arrangement live with snapshot-safe press targeting"
```

---

### Task 8: E2E + virtual deck coverage, full quality gates

**Files:**
- Modify: `test/e2e/stream-deck-flow.test.tsx`
- Modify: `test/unit/client/components/VirtualDeckPanel.test.tsx`

**Interfaces:**
- Consumes: everything above via the REAL store + REAL `DeckController` + `FakeDeckDevice`; `decodeKey`/`decodeStrip` spec-decoding helpers; `updateSettingsLocal` production action; `getTabDisplayTitle` for parity assertions.
- Produces: end-user-story coverage — the tests that prove the spec's success criteria at the highest level of abstraction available (jsdom e2e over the fake transport; there is no browser/hardware deck harness in this repo).

- [ ] **Step 1: Write the failing e2e tests**

In `test/e2e/stream-deck-flow.test.tsx`: the `DeckStoreOpts.keyLayout` option (default `'status-sorted'`, applied via the production `updateSettingsLocal` action) already landed in Task 6 — that store dispatch is the ONLY seeding mechanism for keyLayout (the controller's `settings()` thunk never carries it; it reaches the deck via `selectDeckModel`, so leave `defaultSettings()` untouched). Add:

```ts
it('newest-first on the 6-key profile: pager top-left, newest tab beside it, older tabs on page 2', async () => {
  const { store, device } = setupLive({ tabs: 8, keyLayout: 'newest-first' })
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't8' })
  expect(decodeKey(device, 2)).toMatchObject({ kind: 'tab', tabId: 't7' })
  device.press(0)
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
  device.press(0) // wraps back
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't8' })
})

it('auto default: the 6-key deck is newest-first, the 8-key Plus stays status-sorted', async () => {
  const mini = setupLive({ tabs: 3, keyLayout: 'auto' })
  expect(decodeKey(mini.device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
  expect(decodeKey(mini.device, 1)).toMatchObject({ kind: 'tab', tabId: 't3' })
  const plus = setupLive({ tabs: 3, keyLayout: 'auto' }, PLUS_CAPS)
  expect(decodeKey(plus.device, 0)).toMatchObject({ kind: 'tab' }) // full mode, no pager
})

it('changing Key layout in settings re-arranges the deck live, without reconnecting', async () => {
  const { store, device } = setupLive({ tabs: 4, keyLayout: 'status-sorted' })
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' }) // standard: no pager when tabs fit
  store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'pager', page: 1, pageCount: 1 })
  expect(decodeKey(device, 1)).toMatchObject({ kind: 'tab', tabId: 't4' })
  store.dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'status-sorted' } }))
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab' })
})

it('tiles and the touch strip show the tab bar displayed label (getTabDisplayTitle parity)', async () => {
  // Seed a tab whose stored title is the raw 'Tab 1' placeholder and whose
  // pane layout is a claude leaf with initialCwd '/home/dan/code/freshell'
  // (extend makeDeckStore's tab builder the same way the deck-selectors
  // fixtures seed initialCwd), on the PLUS profile so the strip renders.
  const { store, device } = setupLive({ tabs: 1, keyLayout: 'status-sorted', /* cwd seeding */ }, PLUS_CAPS)
  const s = store.getState()
  const tab = s.tabs.tabs[0]
  const expected = getTabDisplayTitle(tab, s.panes.layouts[tab.id], s.panes.paneTitles?.[tab.id], s.extensions?.entries)
  expect(expected).toBe('freshell') // and NOT 'Tab 1'
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', title: expected })
  expect(decodeStrip(device)).toContain(expected) // active-tab text on the strip
})
```

In `test/unit/client/components/VirtualDeckPanel.test.tsx` (real 13-reducer store, keys addressed as `getByRole('button', { name: 'Deck key N' })`, N is 1-based):

```ts
it('Mini defaults to newest-first: Deck key 1 is the pager and Deck key 2 focuses the newest tab', () => {
  // Default settings keyLayout 'auto' + MINI_CAPS(6) => reversed.
  // Press Deck key 2 (physical key index 1) and assert the LAST tab in
  // tab-bar order becomes active. Pressing Deck key 1 (the pager) with a
  // single page must not change any tab.
})

it('Plus profile honors an explicit Newest first selection (pager on Deck key 1)', () => {
  // dispatch(updateSettingsLocal({ streamDeck: { keyLayout: 'newest-first' } }))
  // then switch to the Plus profile and press Deck key 2 -> newest tab focuses.
})
```

Update the existing `'clicking key 2 focuses tab 2 in the store (short press)'` test for the new Mini default (auto → reversed): either re-point its expectation (key 2 = physical index 1 = newest tab) or seed `keyLayout: 'status-sorted'` and keep it as the standard-arrangement regression — prefer the first so the DEFAULT experience is what the virtual-deck suite documents.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/dan/code/freshell/.worktrees/deck-render-refinements && npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL only on the newly added tests before fixture plumbing (`keyLayout` opt, cwd seeding) is written; implement that plumbing in the test files.

- [ ] **Step 3: Make them pass**

No production-code changes are expected in this task — all behavior shipped in Tasks 1-7. If an e2e test exposes a real gap (e.g. the strip not repainting on a title change), fix it in the owning module (`frame.ts` / `deck-controller.ts`) with the failing e2e as the RED test.

- [ ] **Step 4: Full quality gates**

```bash
cd /home/dan/code/freshell/.worktrees/deck-render-refinements
npm run lint          # incl. jsx-a11y for the new settings control
npm run typecheck
npm run check         # typecheck + coordinated full suite
```
Expected: all green. Do NOT restart anything on port 3002; do NOT open a PR.

Known baseline flake (verified pre-plan, 2026-07-30): a full `npm run check` on the base commit failed ONCE in `test/integration/server/test-coordinator.test.ts` ('waits to acquire the gate…' — timing-sensitive gate-queueing test) plus a timeout in `test/helpers/coding-cli/real-session-contract-harness.ts`; the coordinator test passes 31/31 when run solo (`npm run test:vitest -- run test/integration/server/test-coordinator.test.ts --config config/vitest/vitest.server.config.ts`). This plan is client-only. If `npm run check` fails ONLY in these timing-sensitive server tests, re-run the failing file solo to distinguish pre-existing flake from regression before treating the gate as red.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/stream-deck-flow.test.tsx test/unit/client/components/VirtualDeckPanel.test.tsx
git commit -m "test(deck): e2e + virtual-deck coverage for reversed layout, auto default, live switch, and label parity"
```

---

## Self-Review Record

**1. Spec coverage:**
- Smaller title font, letter-spacing kept, fit/pinned values updated → Task 1 (fit math verified measure-driven; literal font pins added; classic preview guarded).
- Pure-black tile interior + darker composited green fills (both states), bright borders kept, derivation documented next to the token block → Task 2.
- Reversed layout: pager always slot 0, reverse tab-bar order (last tab at slot 1), no status sorting, reserved slot with no-op/wrap pager on one page, paging of older tabs → Tasks 6-7; three-value setting with Auto default resolving by `keyCount <= 6`, client-side persistence, live apply, virtual 8-key deck honoring explicit Newest first → Tasks 4, 5, 7, 8. Action layer / dials / idle dim / tile styles / press-snapshot guard unchanged-but-operating-on-arrangement → Task 7 (helper routes all consumers; dedicated snapshot + dial-page tests).
- Tab-bar label parity for tiles and strip, reusing `getTabDisplayTitle` (not reimplemented) → Tasks 3, 8.
- Scope/quality: client-only; standard sorting untouched (model sort code untouched); lint incl. a11y, typecheck, coordinated suites, virtual deck coverage → Tasks 5, 8.

**1b. No silent deferrals:** every requirement lands as production behavior with real tests: colors/fonts are literal-pinned against the real renderer constants and draw calls; the arrangement is exercised through the REAL `DeckController` + production `updateSettingsLocal` action over the `FakeDeckDevice` transport (the repo's established e2e surface for deck hardware — spec-encoding renderers assert exactly what lands on each physical key); persistence is proven through the real `buildLocalSettingsPatch`/normalizer round-trip. No stubs stand in for required behavior; the only test double is the repo-standard fake transport + recording canvas, which are the sanctioned substitutes for physical hardware. No known-limitations deferrals.

**2. Placeholder scan:** two test bodies in Task 7 and two in Task 8 are specified as "mirror test X at line Y" with the exact scenario, actions, and assertions spelled out in the comment — the repo-specific fixture builders (`makeState`, `setupLive` option shapes) are the only detail delegated to the implementer, with the exact template test named each time. No TBD/TODO/"handle edge cases" items remain.

**2b. Load-bearing validation updates (Stage 2, 2026-07-30):** all 10 surfaced assumptions resolved (ledger: `.worktrees/.the-usual-logs/deck-render-refinements/load-bearing-ledger.md`). Verified: Chromium `measureText` scales with `ctx.font` incl. letterSpacing (headless probe) — Task 1's no-fit-math-change stands; VirtualDeckPanel/deck-manager suites have zero arrangement-sensitive assertions (caution added: do not touch `deck-controller.ts` in Task 6); both reload-path gates traced (reload-proxy test added to Task 4 Step 1); `?.` pattern has compiled production precedent; baseline green (typecheck + all plan-touched suites on HEAD ceee98a6; full-check flake documented in Task 8 Step 4). Falsified & fixed: (a) Task 4's `defaultSettings()` "typecheck ripple" — that object is the controller callback shape and tests sit outside every tsconfig include, so the instruction was corrected (StreamDeckSettings runtime fixture only) and Task 8's seeding note re-pointed; (b) "last tab-bar position ≡ newest tab" — tab reordering is fully wired (drag/keyboard/context menu) and cross-device sync can adopt remote order, so `'newest-first'` semantics (strictly reverse tab-bar order) are now documented deliberately at every surface (Global Constraints naming note, Task 4 comment, Task 5 UI copy, Task 6 `arrangeTabs` comment); the spec's value name is kept, with a normalizer-alias rename path noted.

**3. Type consistency:** `DeckKeyLayout` (Task 4) is consumed by `resolveArrangement(keyLayout, keyCount)` and `DeckModel.keyLayout` (Task 6) and `StoreOpts.keyLayout` (Tasks 7-8). `DeckArrangement = 'standard' | 'reversed'` is produced in Task 6 and consumed in Task 7's `layout()` helper. `planLayout(caps, tabCount, arrangement)` third param is optional in Task 6 and made required in Task 7 (explicitly sequenced). `DeckTab.tabIndex: number` is produced in Task 6's selector and consumed by `arrangeTabs`. `ICONS_TITLE_FONT_SIZE`/`TILE_BG`/`TILE_FILL_GREEN` names match between implementation and test steps.
