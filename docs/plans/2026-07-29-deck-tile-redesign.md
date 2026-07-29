# Deck Tile Redesign Implementation Plan

> **For agentic workers:** This plan is executed task-by-task by the
> workflow's execute stage: a fresh implementer per task, with a spec +
> quality review after each task. Steps use checkbox (`- [ ]`) syntax
> for tracking.

**Goal:** Replace the Stream Deck key tiles' terminal-preview + status-ring design with a tab-bar-matching design (title on top, centered repo icons, status-driven background fill, white active ring) and sort deck keys by status priority.

**Architecture:** Client-only change confined to `src/deck/` plus two touch points (`src/components/TerminalView.tsx` hook removal, `src/components/VirtualDeckPanel.tsx` ctx/renderer wiring). Tile state (fill / dot / sort priority) is derived from the *same* underlying conditions the tab bar uses (`getBusyPaneIdsForTab`, `state.turnCompletion.attentionByTab`, per-pane `status === 'running'`), repo icons reuse the tab bar's resolution pipeline (`resolvePaneRepoCwd` → `state.repoIcons.byCwd` → `buildRepoIconUrl` / letter-avatar fallback). A new singleton `IconImageCache` loads repo-icon bitmaps asynchronously for canvas drawing with letter-avatar fallback. The virtual deck panel shares the same renderer and controller, so it updates automatically.

**Tech Stack:** React/TypeScript, Redux Toolkit, canvas 2D (via the existing injectable `CtxFactory` seam), Vitest (jsdom, no real canvas — drawing-call spies and spec-encoding renderers).

## Global Constraints

- Work in the worktree `.worktrees/deck-tile-redesign`, branch from `origin/main`, PR targets `main`; do **not** create/open a PR without explicit user approval (stop before `gh pr create`).
- NEVER restart the live Rust server on port 3002; no broad kill patterns. This change is client-only TypeScript — no server changes, no deploy needed during development.
- Red-Green-Refactor TDD for every task; unit **and** e2e coverage.
- Focused test runs: `npm run test:vitest -- run <paths> --config config/vitest/vitest.config.ts` (there is no root vitest config — `--config` is mandatory). Broad runs go through the coordinator gate (`npm test` / `npm run check`); check `npm run test:status` first and never kill a foreign holder.
- Typecheck gate: `npm run typecheck:client`. Lint gate (incl. jsx-a11y): `npm run lint`.
- Commits: Conventional Commits with `(deck)` scope, lowercase imperative subject, one commit per task slice.
- `console.error` is fatal in tests (`test/setup/dom.ts` throws in `afterEach`) — no code path may log errors under test.
- Path aliases: `@/` → `src/`, `@test/` → `test/`.
- The tab bar itself (`TabBar.tsx`, `TabItem.tsx`) must be visually and behaviorally unchanged — this plan only *reads* its helper libs; the only file outside `src/deck/` whose behavior changes is `TerminalView.tsx` (preview-registration hook removal, invisible to users).
- Do NOT touch `/api/panes/:id/capture` or `server/agent-api/capture.ts` — that endpoint is used by `server/cli/index.ts:664` and `server/mcp/freshell-tool.ts:808` and is unrelated to the deck preview machinery (which reads xterm buffers).

## Investigation results this plan is built on (verified 2026-07-29)

These facts were verified by direct code reading; task steps cite them. Implementers can trust them but should re-verify line numbers before editing (the worktree may drift).

**Tab bar state conditions** (`src/components/TabItem.tsx:158-184`, `src/components/TabBar.tsx:329-338`):
- `needsAttention` = `!!state.turnCompletion.attentionByTab[tab.id]`; `busyPaneIds` = `getBusyPaneIdsForTab(...)` (`src/lib/pane-activity.ts:263-309`); setting `tabAttentionStyle: 'highlight'|'darken'|'pulse'|'none'` (default `'highlight'`) read from `state.settings.settings.panes.tabAttentionStyle`.
- **Bar-on-top** ⟺ `isActive && needsAttention && tabAttentionStyle !== 'none'` → 3px `border-t-success` (= `hsl(142 71% 45%)` ≈ `#21c45d`) + `bg-success/15` wash.
- **Green filled** ⟺ `!isActive && needsAttention && tabAttentionStyle !== 'none'` → `bg-emerald-100` (`#d1fae5`) light / `dark:bg-emerald-900/40` dark.
- **Green icon** ⟺ pane not in `busyPaneIds` AND effective status `'running'` (`TabItem.tsx:135-147`; non-terminal pane kinds are hard-coded `'running'` at `TabItem.tsx:136`) → `text-success` `#21c45d`.
- **Blue icon** ⟺ `busyPaneIds.includes(paneId)` → `text-blue-500` `#3b82f6`.
- Repo icons are **never tinted** in the tab bar (`TabItem.tsx:133` passes no color class); pane icons are tinted via `currentColor`. No CSS filters anywhere.

**Repo icon pipeline**: per-pane cwd via `resolvePaneRepoCwd(content, tab, state.terminalMeta.byTerminalId)` (`src/lib/repo-icon.ts:13-27`); probed meta cached at `state.repoIcons.byCwd` as `RepoIconEntry { status: 'loading'|'ready'|'error'; repoRoot?; checkoutRoot?; repoName?; hasIcon? }` (`src/store/repoIconsSlice.ts:5-11`); real icon = `<img src={buildRepoIconUrl(cwd)}>` (`/api/repo-icon?cwd=…`), fallback = letter avatar with `hsl(hueFromString(repoName), 60%, 42%)` circle + white letter (`src/components/icons/RepoIcon.tsx:33-65`; `hueFromString` exported at `:19`). Distinct repo icons cap at 3 (`MAX_REPO_ICONS = 3`, `TabItem.tsx:35`), silently truncated. **Probing (corrected by validation):** `TabBar.tsx:240` is the ONLY `fetchRepoIconMeta` dispatcher in the app, gated at `:230` by `if (!repoIconsOnTabs) return` (setting defaults true, `:189`), and TabBar is *conditionally* mounted (`App.tsx:1644` — hidden in the mobile-landscape terminal view) while deck leader election (`deck-manager.ts:166-203`; the lock-less fallback makes every window an auto-leader) can elect a window whose TabBar is unmounted. The deck therefore CANNOT rely on TabBar to populate `state.repoIcons.byCwd`: the DeckController owns its own probe, un-gated by `repoIconsOnTabs` (Task 8). Double-probing alongside TabBar is harmless — the thunk self-dedupes via its `condition` guard (`repoIconsSlice.ts:36-40`).

**Rust-server terminal-meta coverage (accepted parity limitation):** on the shipping Rust server the `terminal.inventory` handshake carries no terminal meta (`freshell-ws/lib.rs:465-468` hard-codes an empty `terminal_meta`), and only create-time pushes carry a bare `cwd`. `resolvePaneRepoCwd` therefore resolves via the `initialCwd` fallback for coding-CLI/fresh-agent panes and resolves nothing for plain-shell panes. Deck icon coverage on Rust thus EQUALS the tab bar's existing coverage (same resolver, degrades identically); tiles without a resolvable cwd render title-only by design. This is an accepted, documented parity limitation — not a bug this plan fixes.

**Deck internals** (`src/deck/`): `KeySpec` in `frame.ts:6-10` (tab variant: `{ kind:'tab'; tabId; title; previewLines; ring; active }`); `renderKey(spec, caps, createCtx)` with narrow `Ctx2D = Pick<CanvasRenderingContext2D,'fillRect'|'fillText'|'measureText'|'getImageData'> + {fillStyle,font,textBaseline}` (`tile-renderer.ts:8-13`) — **no `drawImage`**; per-key paint cache is `JSON.stringify(spec)` (`deck-controller.ts:126`) so *anything a tile draws must be a KeySpec field*; controller repaint bail-out is `JSON.stringify(selectDeckModel(state))` (`deck-controller.ts:164-176`); preview machinery is `terminal-text-registry.ts` (xterm buffer readers) with sole producer `TerminalView.tsx:103,676-677` and sole consumer `DeckController.previewFor` (`deck-controller.ts:151-160,24`) — **nothing else uses it**; `keyDown` stores only a timestamp (`deck-controller.ts:185-188`) and `handleKeyUp` re-resolves slot→tab from live state at release (`:204-234`) — **no press snapshot exists today**; `selectDeckModel` maps `state.tabs.tabs` verbatim (no sort anywhere); `buildFrame` (`frame.ts:87-113`) assigns keys via `planLayout` + `visibleTabs`; pager = last key when `tabCount > keyCount`, Deck+ pages via dial 1; `VirtualDeckPanel.tsx` uses the same `renderKey` + a real `DeckController` over `FakeDeckDevice` (`:11,81-88`), with `noopCtx`/`safeCtxFactory` (`:21-38`).

**Test landscape**: unit tests in `test/unit/client/deck/`, e2e (fake transport, Vitest not Playwright) in `test/e2e/stream-deck-flow.test.tsx`; renderer tests use a `recordingCtx()` drawing-call spy; controller/e2e tests use spec-encoding renderers (`encodeSpec`/`decodeKey` — pixels are KeySpec JSON); jsdom canvas `getContext` is stubbed to `null`; **no image-loading mock exists** — verified: with this vitest config (no `environmentOptions`), Vitest constructs JSDOM with `resources: undefined`, so jsdom 25.0.1 uses `NoOpResourceLoader`: `Image`s never fetch, never fire `load`/`error`, never complete. Consequences: (a) tests MUST inject the fake loader for any post-load assertion (default-loader promises pend forever in jsdom — harmless but never resolving); (b) `IconImageCache` error paths must be silent (no `console.error`/`console.warn` — `console.error` is fatal in tests); (c) nobody may add `environmentOptions.jsdom.resources` or `userAgent` to the vitest config — either silently enables real fetching and would break these suites. `makeDeckStore(opts)` fixture builder is deliberately duplicated in `deck-controller.test.ts`, `stream-deck-flow.test.tsx`, `VirtualDeckPanel.test.tsx`.

## Design decisions (settled — carry through all tasks)

1. **Sort lives in `selectDeckModel`.** The spec says short-press, long-press, dials, paging all "operate on the sorted order" — sorting the model gives that everywhere for free (dial-0 tab cycling included), and the model-JSON bail-out repaints automatically on re-sorts. Sort is stable (`Array.prototype.sort` is spec-stable): priority ascending, tab-bar order preserved within groups.
2. **Priority buckets** (0 = leftmost keys): 0 bar-on-top (`attention && active`), 1 green-filled (`attention && !active`), 2 green-icon (not busy, has a running pane), 3 blue-icon (any busy pane), 4 rest. A tab with both busy and green panes classifies **blue-icon** (busy dominates: "still working"). Attention is gated on `tabAttentionStyle !== 'none'` (mirroring the tab bar: with `'none'` the bar/fill states don't exist). With style `'darken'` the tab bar shows a darkened treatment instead of green; the deck keeps its single green palette (the *condition* is shared; the deck has one fixed skin).
3. **Green-icon condition is the tab bar's literal condition** (`status === 'running'` and not busy, non-terminal panes always `'running'`). Consequence: most healthy idle tabs are bucket 2 and bucket 4 holds only tabs whose panes are all exited/error/creating (or tabs with no panes). This is faithful to the tab bar's own coloring — do not "improve" it. Tabs with no `state.panes.layouts` entry are a real transient (`addTab` never seeds a layout; `PaneLayout.tsx:30-35` initializes it post-paint) and classify via `panesForTab`'s synthesized single pane from `tab.mode`/`tab.status` (Task 2), mirroring `TabBar.tsx:203-221` — so "tabs with no panes" means genuinely mode-less tabs only.
4. **Status dot instead of tinted icons.** The tab bar never tints *repo* icons — green/blue tinting applies to *pane* icons. The deck centers repo icons (per spec), so the green-icon/blue-icon states are made visible with a small status dot (bottom-center of the tile) using the exact tab-bar tint colors (`#21c45d` / `#3b82f6`) and the exact same conditions. This mirrors the tab bar's own `StatusDot` fallback vocabulary (`fill-success` / `fill-blue-500`).
5. **Backgrounds:** `none` → `#0a0a0a` (existing near-black); `green` (green-filled state) → solid light green `#a7f3d0` (emerald-200 — recognizably the tab bar's emerald attention fill, tuned for the small LCD); `barTop` (bar-on-top state) → same light green fill **plus** a 3px `#21c45d` border ring (the tab bar's `--success` bar color). Active tab keeps a white ring: 3px at inset 0 normally, 2px at inset 3 when the barTop border occupies inset 0 (matching today's status+active ring nesting).
6. **Status rings are removed entirely**, including the amber pending-approval ring — the spec replaces rings with the three-state background and doesn't map amber. Pending approval still works via the long-press action layer (`findApproveTarget` untouched).
7. **Repo icons on tiles ignore `settings.panes.repoIconsOnTabs`** (a tab-bar clutter preference; the deck tile needs its center glyph) and derive from **all** panes in the tab (distinct repos, first-appearance order, cap 3) — the tab bar additionally only considers the first 3 pane icons when picking repo groups; the deck follows the headline "cap repo icons at 3" rule. Resolution logic (cwd → meta → url/letter/hue) is shared, not reimplemented. **The deck OWNS its own icon-meta probing:** the DeckController dispatches `fetchRepoIconMeta(cwd)` for every distinct resolved cwd of the tabs it renders, UN-gated by `repoIconsOnTabs` (Task 8) — this is what makes this decision actually deliverable, since `TabBar.tsx:240` is the app's only other dispatcher, is gated on that very setting (`:230`), and is conditionally mounted (`App.tsx:1644`). Double-probing alongside TabBar is harmless: the thunk self-dedupes (`repoIconsSlice.ts:36-40`).
8. **Icon bitmaps:** singleton `IconImageCache` with injectable loader; while loading or on failure (load error, **or** the cache's post-load drawn-empty probe detecting a blank draw — Task 6) the renderer draws the letter avatar (hue swatch + white letter — canvas analogue of `RepoIcon`'s SVG circle; drawn as a square to keep `Ctx2D` minimal). A tab with no repo info renders title-only (banner + fill + dot + rings). Icon readiness is a KeySpec field (`ready`) so loads trigger repaints through the per-key diff; the controller subscribes to the cache and repaints on load completion.
9. **Press-snapshot guard:** `keyDown` resolves and stores the key's target (`pager` / `tab tabId` / `none`); `keyUp` acts on the snapshot, so a re-sort between press-down and press-up acts on the tab that was displayed at press-down. If the snapshot tab no longer exists at release, the press is a no-op.
10. **Idle dimming, multi-window locking, action layer, dials: unchanged** (they now simply see the sorted model). Re-sort repaints waking a dimmed deck is pre-existing behavior for any repaint (`deck-controller.ts:138`) and stays as-is.

## File structure

| File | Change | Responsibility |
|---|---|---|
| `src/deck/tile-state.ts` | **Create** | Pure per-tab tile classification: `TileFill`, `TileDot`, `TabStatusFlags`, `tileFill()`, `tileDot()`, `tilePriority()` |
| `src/deck/icon-image-cache.ts` | **Create** | Singleton async bitmap cache for repo icons (injectable loader, subscribe/notify, permanent-failure caching, runtime drawn-empty probe for blank-drawing SVGs) |
| `src/deck/deck-selectors.ts` | Modify | `panesForTab` (layout-or-synthesized pane entries), `getTabStatusFlags`, `getTabRepoIcons`, reshaped + sorted `selectDeckModel`; delete `getTabRingStatus`/`TabRingStatus` at cleanup |
| `src/deck/frame.ts` | Modify | `KeySpec` tab variant gains `fill`/`dot`/`icons`, loses `previewLines`/`ring`; `buildFrame` takes `iconReady` instead of `previewFor`; `ringColor`/`RingColor` deleted; `stripText` counts from flags |
| `src/deck/tile-renderer.ts` | Modify | New `drawTab` (fill, icons, dot, banner, rings); `Ctx2D` gains `drawImage`; `iconLayout()`; preview constants/helpers deleted |
| `src/deck/deck-controller.ts` | Modify | Icon-cache wiring (iconReady + subscribe→repaint + getIcon into default renderer), un-gated `fetchRepoIconMeta` probe dispatch per resolved cwd, preview path removal, press-down target snapshot |
| `src/deck/terminal-text-registry.ts` | **Delete** | Dead preview machinery (sole consumer was the deck) |
| `src/components/TerminalView.tsx` | Modify | Remove `useTerminalTextRegistration` hook call + import (lines ~103, ~676-677) |
| `src/components/VirtualDeckPanel.tsx` | Modify | `noopCtx` gains `drawImage`; renderer closure passes the icon cache |
| `test/unit/client/deck/tile-state.test.ts` | **Create** | Classification truth table |
| `test/unit/client/deck/icon-image-cache.test.ts` | **Create** | Cache load/fail/subscribe behavior |
| `test/unit/client/deck/deck-selectors.test.ts` | Modify | Flags, repo icons, sorted model |
| `test/unit/client/deck/frame.test.ts` | Modify | New KeySpec shape, `iconReady`, `ringColor` tests removed |
| `test/unit/client/deck/tile-renderer.test.ts` | Modify | Rewritten `drawTab` assertions (fills, icons, dot, rings) |
| `test/unit/client/deck/deck-controller.test.ts` | Modify | Icon repaint, preview-timer removal, press snapshot |
| `test/unit/client/deck/terminal-text-registry.test.tsx` | **Delete** | With its module |
| `test/e2e/stream-deck-flow.test.tsx` | Modify | Updated KeySpec expectations; new scenarios: sort priority, three backgrounds, icon fallback→ready, sorted paging, mid-press re-sort |

Interfaces consumed from outside `src/deck/` (all verified to exist; read-only **except** the one dispatch noted below):
`getBusyPaneIdsForTab` (`@/lib/pane-activity`), `collectPaneEntries(node: PaneNode): Array<{ paneId: string; content: PaneContent }>` (`@/lib/pane-utils:72-80`), `resolvePaneRepoCwd`, `pathBasename`, `buildRepoIconUrl` (`@/lib/repo-icon`), `hueFromString` (`@/components/icons/RepoIcon`), `state.terminalMeta.byTerminalId`, `state.repoIcons.byCwd`, `state.turnCompletion.attentionByTab`, `state.settings.settings.panes.tabAttentionStyle`. The deck also **dispatches** `fetchRepoIconMeta` from `@/store/repoIconsSlice` (Task 8) — the sole store write the deck performs; the thunk's own `condition` guard (`repoIconsSlice.ts:36-40`) makes it idempotent per cwd, so the deck stays a pure reader of everything else.

---

### Task 1: Pure tile classification module (`tile-state.ts`)

**Files:**
- Create: `src/deck/tile-state.ts`
- Test: `test/unit/client/deck/tile-state.test.ts`

**Interfaces:**
- Consumes: nothing (pure module, no imports).
- Produces (later tasks rely on these exact names):
  - `type TileFill = 'barTop' | 'green' | 'none'`
  - `type TileDot = 'green' | 'blue' | null`
  - `type TabStatusFlags = { busy: boolean; attention: boolean; greenIcon: boolean }`
  - `tileFill(active: boolean, flags: TabStatusFlags): TileFill`
  - `tileDot(flags: TabStatusFlags): TileDot`
  - `tilePriority(active: boolean, flags: TabStatusFlags): number` (0..4)

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/deck/tile-state.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { tileFill, tileDot, tilePriority, type TabStatusFlags } from '@/deck/tile-state'

const f = (over: Partial<TabStatusFlags> = {}): TabStatusFlags => ({
  busy: false, attention: false, greenIcon: false, ...over,
})

describe('tileFill', () => {
  it('bar-on-top for active tab with attention (tab bar: border-t-success + bg wash)', () => {
    expect(tileFill(true, f({ attention: true }))).toBe('barTop')
  })
  it('green fill for inactive tab with attention (tab bar: bg-emerald-100)', () => {
    expect(tileFill(false, f({ attention: true }))).toBe('green')
  })
  it('no fill without attention, regardless of busy/green-icon/active', () => {
    expect(tileFill(true, f())).toBe('none')
    expect(tileFill(false, f({ busy: true, greenIcon: true }))).toBe('none')
  })
})

describe('tileDot', () => {
  it('blue when any pane is busy (tab bar: text-blue-500), even if green icons exist', () => {
    expect(tileDot(f({ busy: true, greenIcon: true }))).toBe('blue')
  })
  it('green for a running non-busy pane (tab bar: text-success)', () => {
    expect(tileDot(f({ greenIcon: true }))).toBe('green')
  })
  it('null otherwise', () => {
    expect(tileDot(f())).toBe(null)
  })
})

describe('tilePriority', () => {
  it('orders: barTop(0) < greenFill(1) < greenIcon(2) < blueIcon(3) < rest(4)', () => {
    expect(tilePriority(true, f({ attention: true }))).toBe(0)
    expect(tilePriority(false, f({ attention: true }))).toBe(1)
    expect(tilePriority(false, f({ greenIcon: true }))).toBe(2)
    expect(tilePriority(false, f({ busy: true, greenIcon: true }))).toBe(3) // busy dominates
    expect(tilePriority(false, f())).toBe(4)
    expect(tilePriority(true, f())).toBe(4) // active alone is not a priority bucket
  })
  it('attention outranks busy/greenIcon', () => {
    expect(tilePriority(false, f({ attention: true, busy: true, greenIcon: true }))).toBe(1)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-state.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — cannot resolve `@/deck/tile-state`.

- [ ] **Step 3: Write minimal implementation**

Create `src/deck/tile-state.ts`:

```ts
// Pure per-tab tile classification for the Stream Deck tiles.
// Mirrors the tab bar's visual states (src/components/TabItem.tsx):
//   bar-on-top  <-> active tab with attention        -> fill 'barTop'
//   green fill  <-> inactive tab with attention      -> fill 'green'
//   green icon  <-> a running, non-busy pane         -> dot 'green'
//   blue icon   <-> any busy pane                    -> dot 'blue'
// Sort priority (spec): barTop, greenFill, greenIcon, blueIcon, rest.

export type TileFill = 'barTop' | 'green' | 'none'
export type TileDot = 'green' | 'blue' | null

export type TabStatusFlags = {
  /** Any pane in the tab is busy (getBusyPaneIdsForTab). */
  busy: boolean
  /** Turn-complete attention (turnCompletion.attentionByTab), gated on tabAttentionStyle !== 'none'. */
  attention: boolean
  /** Any non-busy pane with effective status 'running' (TabItem.tsx:135-147). */
  greenIcon: boolean
}

export function tileFill(active: boolean, flags: TabStatusFlags): TileFill {
  if (flags.attention) return active ? 'barTop' : 'green'
  return 'none'
}

export function tileDot(flags: TabStatusFlags): TileDot {
  if (flags.busy) return 'blue'
  if (flags.greenIcon) return 'green'
  return null
}

/** 0 bar-on-top, 1 green-filled, 2 green-icon, 3 blue-icon, 4 rest. Busy dominates greenIcon. */
export function tilePriority(active: boolean, flags: TabStatusFlags): number {
  if (flags.attention) return active ? 0 : 1
  if (flags.busy) return 3
  if (flags.greenIcon) return 2
  return 4
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-state.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-state.ts test/unit/client/deck/tile-state.test.ts
git commit -m "feat(deck): pure tile classification - fill, dot, and sort priority from tab-bar state flags"
```

---

### Task 2: Selector — `getTabStatusFlags`

**Files:**
- Modify: `src/deck/deck-selectors.ts`
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: `TabStatusFlags` from Task 1; existing private `activityInputs(state)` helper (`deck-selectors.ts:13-22`); `getBusyPaneIdsForTab` from `@/lib/pane-activity`; `collectPaneEntries` from `@/lib/pane-utils` (already imported in this file for `tabHasPendingApproval` — verify the import list at the top of the file and add it if it's imported elsewhere).
- Produces: `getTabStatusFlags(state: RootState, tab: Tab): TabStatusFlags` — exact per-tab busy/attention/greenIcon derivation reused by Task 4 — and `panesForTab(state: RootState, tab: Tab): Array<{ paneId: string; content: PaneContent }>` — layout-or-synthesized pane entries, reused by Task 3 (`getTabRepoIcons`) and Task 8 (probe dispatch).

- [ ] **Step 1: Write the failing test**

Open `test/unit/client/deck/deck-selectors.test.ts` and study how the existing tests build stores (`configureStore` with ~10 reducers + `preloadedState` — reuse the file's existing store-building helper verbatim). Add a new `describe` block. The fixture shapes below follow the file's existing conventions (tabs `t1..tN`, panes `p1..pN`, terminals `term-N` in `claude` mode) — adapt names to the helper actually present in the file:

```ts
describe('getTabStatusFlags', () => {
  it('greenIcon: running non-busy pane sets greenIcon (tab bar green icon condition)', () => {
    const store = makeStore({ tabs: 1 }) // default fixture: claude terminal, status running, not busy
    const state = store.getState()
    const tab = state.tabs.tabs[0]
    expect(getTabStatusFlags(state, tab)).toEqual({ busy: false, attention: false, greenIcon: true })
  })

  it('busy pane sets busy and suppresses greenIcon when it is the only pane', () => {
    const store = makeStore({ tabs: 1, busy: ['term-1'] })
    const state = store.getState()
    expect(getTabStatusFlags(state, state.tabs.tabs[0])).toEqual({ busy: true, attention: false, greenIcon: false })
  })

  it('attention flag mirrors turnCompletion.attentionByTab', () => {
    const store = makeStore({ tabs: 1, attention: { t1: true } })
    const state = store.getState()
    expect(getTabStatusFlags(state, state.tabs.tabs[0]).attention).toBe(true)
  })

  it("attention is gated off when tabAttentionStyle is 'none' (tab bar shows no bar/fill then)", () => {
    const store = makeStore({ tabs: 1, attention: { t1: true } })
    // Patch the settings slice the way the suite's existing settings-dependent tests do; if none
    // exist, build the store with preloadedState.settings.settings.panes.tabAttentionStyle = 'none'.
    const state = withTabAttentionStyle(store.getState(), 'none')
    expect(getTabStatusFlags(state, state.tabs.tabs[0]).attention).toBe(false)
  })

  it('exited terminal pane yields no greenIcon', () => {
    const store = makeStore({ tabs: 1, paneStatus: { p1: 'exited' } })
    const state = store.getState()
    expect(getTabStatusFlags(state, state.tabs.tabs[0]).greenIcon).toBe(false)
  })

  it('tab with NO pane layout classifies from the synthesized pane (tab.mode/tab.status), matching the tab bar', () => {
    // Real transient: addTab (tabsSlice.ts:296) never seeds a layout — PaneLayout.tsx:30-35
    // initializes it in a post-paint useEffect, persisted-state restore can omit layout entries,
    // and the deck repaints synchronously per dispatch, so it WILL paint layout-less tabs.
    const store = makeStore({ tabs: 1 })
    const state = store.getState()
    // Fixture tabs carry mode: 'shell' (verified in all three suites' builders - only pane
    // CONTENTS are mode 'claude'). The synthesized pane inherits tab.mode, and a shell-mode
    // pane never yields greenIcon - so override the tab under test.
    const tab = { ...state.tabs.tabs[0], mode: 'claude' as const, status: 'running' as const }
    const noLayout = { ...state, panes: { ...state.panes, layouts: {} } } as typeof state
    expect(getTabStatusFlags(noLayout, tab)).toEqual({ busy: false, attention: false, greenIcon: true })
  })
})
```

The fixture builders' tabs already HAVE `mode`/`status` fields — but with `mode: 'shell'`, not `'claude'` (verified: all three suites build tabs as `{ ..., status: 'running', mode: 'shell' }`; only pane contents are `mode: 'claude'`). The synthesis fallback reads the tab's own fields, exactly like `TabBar.tsx:203-221`, which is why both layout-less tests above/below override `mode` on the tab object they pass instead of relying on fixture defaults — a shell-mode synthesized pane yields neither `greenIcon` nor a resolvable repo cwd.

If the suite's fixture builder has no `paneStatus` option, extend it: it constructs `TerminalPaneContent` leaves — add `status: opts.paneStatus?.[paneId] ?? 'running'`. Add a small local `withTabAttentionStyle(state, style)` helper that returns a state copy with `settings.settings.panes.tabAttentionStyle` overridden (structured clone + assignment is fine for a test).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `getTabStatusFlags` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/deck/deck-selectors.ts`, add (import `collectPaneEntries` from `@/lib/pane-utils` if not already imported at top; import `type TabStatusFlags` from `./tile-state`):

```ts
import type { TabStatusFlags } from './tile-state'

/**
 * Pane entries for a tab, tolerant of layout-less tabs. This transient is REAL:
 * addTab (tabsSlice.ts:296) never seeds a layout — PaneLayout.tsx:30-35 initializes
 * it in a post-paint useEffect, and persisted-state restore can omit layout entries —
 * while the deck repaints synchronously per dispatch, so it WILL paint such tabs.
 * Mirrors the tab bar's live synthesis fallback (TabBar.tsx:203-221): synthesize a
 * single terminal pane from the tab's own fields. Do NOT touch TabBar; this is the
 * deck-local twin of that fallback.
 */
export function panesForTab(state: RootState, tab: Tab): Array<{ paneId: string; content: PaneContent }> {
  const layout = state.panes.layouts[tab.id]
  if (layout) return collectPaneEntries(layout)
  if (!tab.mode) return []
  return [{
    paneId: tab.id,
    content: {
      kind: 'terminal' as const,
      mode: tab.mode,
      shell: tab.shell,
      createRequestId: tab.createRequestId,
      status: tab.status,
      sessionRef: tab.sessionRef,
      initialCwd: tab.initialCwd,
    },
  }]
}

/**
 * Per-tab status flags, derived from the SAME conditions the tab bar uses:
 * - busy: any pane busy (getBusyPaneIdsForTab, TabBar.tsx:329-338)
 * - attention: turnCompletion.attentionByTab gated on tabAttentionStyle !== 'none'
 *   (TabItem.tsx:158-184 renders no bar/fill when the style is 'none')
 * - greenIcon: any non-busy pane whose effective status is 'running'
 *   (TabItem.tsx:135-147; non-terminal pane kinds count as 'running')
 */
export function getTabStatusFlags(state: RootState, tab: Tab): TabStatusFlags {
  const busyIds = getBusyPaneIdsForTab({
    tab,
    paneLayouts: state.panes.layouts as Record<string, PaneNode | undefined>,
    ...activityInputs(state),
  })
  const entries = panesForTab(state, tab) // layout entries, or the synthesized single pane
  const greenIcon = entries.some(({ paneId, content }) => {
    if (busyIds.includes(paneId)) return false
    const status = content.kind === 'terminal' ? content.status : 'running'
    return status === 'running'
  })
  const attentionStyle = state.settings.settings.panes.tabAttentionStyle
  return {
    busy: busyIds.length > 0,
    attention: !!state.turnCompletion.attentionByTab[tab.id] && attentionStyle !== 'none',
    greenIcon,
  }
}
```

(If `getBusyPaneIdsForTab`'s exact input object differs, mirror the existing `getTabRingStatus` body at `deck-selectors.ts:38-49`, which calls it the same way.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-selectors.ts test/unit/client/deck/deck-selectors.test.ts
git commit -m "feat(deck): getTabStatusFlags - busy/attention/greenIcon from the tab bar's own conditions"
```

---

### Task 3: Selector — `getTabRepoIcons`

**Files:**
- Modify: `src/deck/deck-selectors.ts`
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: `resolvePaneRepoCwd(content, tab, terminalMetaById)`, `pathBasename`, `buildRepoIconUrl` from `@/lib/repo-icon`; `hueFromString` from `@/components/icons/RepoIcon`; `panesForTab` (Task 2 — layout-or-synthesized pane entries); `state.terminalMeta.byTerminalId`; `state.repoIcons.byCwd` (`RepoIconEntry`).
- Produces: `type TileRepoIcon = { url: string | null; letter: string; hue: number }` and `getTabRepoIcons(state: RootState, tab: Tab): TileRepoIcon[]` (max 3, distinct repos, first-appearance order) — consumed by Task 4's model and Task 5's KeySpec.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/client/deck/deck-selectors.test.ts`. First register the real `terminalMeta` and `repoIcons` reducers in this suite's store-builder `configureStore` reducer map (`terminalMeta` from `@/store/terminalMetaSlice`, `repoIcons` from `@/store/repoIconsSlice` — both slices export their reducer) — they are absent today, and `configureStore` silently ignores `preloadedState` keys that have no matching reducer, so seeding without the reducers is a silent no-op. Then extend the fixture builder to support seeding `repoIcons.byCwd` and `terminalMeta.byTerminalId` via `preloadedState` (both are plain records). Fixture panes in this suite are claude-mode terminals, so `resolvePaneRepoCwd` uses `meta?.repoRoot || meta?.checkoutRoot || meta?.cwd || content.initialCwd || tab?.initialCwd` — seed `terminalMeta.byTerminalId['term-1'] = { cwd: '/repos/alpha' }` (match the record shape used by the `terminalMeta` slice; check its initial state for exact field names).

```ts
describe('getTabRepoIcons', () => {
  it('maps a resolved repo cwd with an icon to a repo-icon URL + letter + hue', () => {
    const store = makeStore({
      tabs: 1,
      terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    const state = store.getState()
    expect(getTabRepoIcons(state, state.tabs.tabs[0])).toEqual([
      { url: buildRepoIconUrl('/repos/alpha'), letter: 'A', hue: hueFromString('alpha') },
    ])
  })

  it('falls back to letter-only (url null) when the repo has no icon', () => {
    const store = makeStore({
      tabs: 1,
      terminalMeta: { 'term-1': { cwd: '/repos/beta' } },
      repoIcons: { '/repos/beta': { status: 'error', hasIcon: false, repoName: 'beta' } },
    })
    const state = store.getState()
    expect(getTabRepoIcons(state, state.tabs.tabs[0])).toEqual([
      { url: null, letter: 'B', hue: hueFromString('beta') },
    ])
  })

  it('skips cwds still loading, dedupes by repoKey, caps at 3 distinct repos', () => {
    // 5 panes in one tab across cwds: loading, r1, r1 (dupe), r2, r3, r4 -> expect r1,r2,r3
    // Build with a multi-pane tab; assert result length 3 and first-appearance order.
  })

  it('returns [] for a tab with no repo-resolvable panes', () => {
    const store = makeStore({ tabs: 1 }) // no terminalMeta seeded, no initialCwd
    const state = store.getState()
    expect(getTabRepoIcons(state, state.tabs.tabs[0])).toEqual([])
  })

  it('tab with NO pane layout derives its icon from the synthesized pane (tab.initialCwd), matching the tab bar', () => {
    const store = makeStore({
      tabs: 1,
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    const state = store.getState()
    // Fixture tabs are mode: 'shell', and resolvePaneRepoCwd resolves terminal panes only
    // when their mode is non-shell (isNonShellMode); the synthesized pane inherits tab.mode.
    // Override mode alongside initialCwd or the icon can never appear.
    const tab = { ...state.tabs.tabs[0], mode: 'claude' as const, initialCwd: '/repos/alpha' }
    const noLayout = { ...state, panes: { ...state.panes, layouts: {} } } as typeof state
    expect(getTabRepoIcons(noLayout, tab)).toEqual([
      { url: buildRepoIconUrl('/repos/alpha'), letter: 'A', hue: hueFromString('alpha') },
    ])
  })
})
```

Write the cap/dedupe test in full (build a tab with 6 panes via the fixture builder's multi-pane support, or extend it; assert exact array). Note: the default fixture may set `initialCwd` on panes/tabs — if so, the "returns []" test needs the fixture's cwd to have no `repoIcons.byCwd` entry (unknown cwd → no meta → skipped), which also passes; assert accordingly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `getTabRepoIcons` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `src/deck/deck-selectors.ts`:

```ts
import { resolvePaneRepoCwd, pathBasename, buildRepoIconUrl } from '@/lib/repo-icon'
import { hueFromString } from '@/components/icons/RepoIcon'

/** Mirrors MAX_REPO_ICONS in TabItem.tsx (locked decision: cap distinct repo icons at 3). */
export const MAX_TILE_REPO_ICONS = 3

export type TileRepoIcon = {
  /** /api/repo-icon URL when the repo has a detected icon, else null (letter avatar). */
  url: string | null
  letter: string
  hue: number
}

/**
 * Repo icons for a tab, using the SAME resolution pipeline as the tab bar
 * (TabBar.tsx getPaneEntries -> repoIconInfoByCwd): resolvePaneRepoCwd per pane
 * (panesForTab supplies layout entries or the TabBar.tsx:203-221-style synthesized
 * pane for layout-less tabs), meta from state.repoIcons.byCwd (probed by the
 * DeckController itself in Task 8; TabBar also probes when mounted), distinct
 * repos in first-appearance order, capped at 3, silently truncated.
 * Deliberate divergences from TabItem: considers ALL panes (not just the first
 * 3 pane icons) and ignores settings.panes.repoIconsOnTabs (deck tiles always
 * show their center glyph).
 */
export function getTabRepoIcons(state: RootState, tab: Tab): TileRepoIcon[] {
  const terminalMetaById = state.terminalMeta.byTerminalId
  const byCwd = state.repoIcons.byCwd
  const seen = new Set<string>()
  const icons: TileRepoIcon[] = []
  for (const entry of panesForTab(state, tab)) {
    const cwd = resolvePaneRepoCwd(entry.content, tab, terminalMetaById)
    if (!cwd) continue
    const meta = byCwd[cwd]
    if (!meta || meta.status === 'loading') continue
    const repoKey = meta.repoRoot || cwd
    if (seen.has(repoKey)) continue
    seen.add(repoKey)
    const repoName = meta.repoName || pathBasename(repoKey)
    icons.push({
      url: meta.hasIcon ? buildRepoIconUrl(cwd) : null,
      letter: (repoName.trim()[0] || '?').toUpperCase(),
      hue: hueFromString(repoName),
    })
    if (icons.length >= MAX_TILE_REPO_ICONS) break
  }
  return icons
}
```

If importing `hueFromString` from the `.tsx` component file trips any lint/typecheck rule about importing components into non-React modules, move `hueFromString` into `src/lib/repo-icon.ts` and re-export it from `RepoIcon.tsx` (keeping the tab bar unchanged) — that keeps one shared implementation.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-selectors.ts test/unit/client/deck/deck-selectors.test.ts
git commit -m "feat(deck): getTabRepoIcons - tab-bar repo icon pipeline reused for tiles, cap 3"
```

---

### Task 4: Sorted `selectDeckModel` with the new `DeckTab` shape

**Files:**
- Modify: `src/deck/deck-selectors.ts`
- Test: `test/unit/client/deck/deck-selectors.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3 (`tileFill`, `tileDot`, `tilePriority`, `getTabStatusFlags`, `getTabRepoIcons`, `TileRepoIcon`); existing `getTabRingStatus` (kept temporarily so `frame.ts` still compiles — removed in Task 9).
- Produces (Tasks 5, 8, 11 rely on this exact shape):

```ts
export type DeckTab = {
  id: string
  title: string
  active: boolean
  busy: boolean          // for stripText counts
  attention: boolean     // for stripText counts
  fill: TileFill
  dot: TileDot
  priority: number
  repoIcons: TileRepoIcon[]
  status: TabRingStatus  // TRANSITIONAL - deleted in Task 9
}
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null }
```

- [ ] **Step 1: Write the failing test**

Add to `test/unit/client/deck/deck-selectors.test.ts`:

```ts
describe('selectDeckModel (sorted, tile fields)', () => {
  it('sorts tabs by priority: barTop, greenFill, greenIcon, blueIcon, rest', () => {
    // t1 exited pane (rest), t2 busy (blueIcon), t3 running idle (greenIcon),
    // t4 attention inactive (greenFill), t5 attention + active (barTop)
    const store = makeStore({
      tabs: 5,
      activeTab: 't5',
      paneStatus: { p1: 'exited' },
      busy: ['term-2'],
      attention: { t4: true, t5: true },
    })
    const model = selectDeckModel(store.getState())
    expect(model.tabs.map((t) => t.id)).toEqual(['t5', 't4', 't3', 't2', 't1'])
    expect(model.tabs.map((t) => t.priority)).toEqual([0, 1, 2, 3, 4])
  })

  it('is stable within a priority group (tab-bar order preserved)', () => {
    const store = makeStore({ tabs: 3 }) // all three are greenIcon
    const model = selectDeckModel(store.getState())
    expect(model.tabs.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })

  it('carries fill, dot, and repoIcons per tab', () => {
    const store = makeStore({
      tabs: 2,
      activeTab: 't1',
      attention: { t1: true },
      busy: ['term-2'],
      terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
      repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
    })
    const model = selectDeckModel(store.getState())
    const t1 = model.tabs.find((t) => t.id === 't1')!
    const t2 = model.tabs.find((t) => t.id === 't2')!
    expect(t1.fill).toBe('barTop')
    expect(t1.repoIcons).toEqual([{ url: buildRepoIconUrl('/repos/alpha'), letter: 'A', hue: hueFromString('alpha') }])
    expect(t2.fill).toBe('none')
    expect(t2.dot).toBe('blue')
  })
})
```

The fixture APIs differ per suite (verified — adapt each snippet to the helper actually present): `deck-selectors.test.ts` has `makeState(overrides)` (options `claudeBusy`/`attention`/`pendingPermissions`/`freshAgentRunning`; returns a plain state object, not a store); `deck-controller.test.ts` has `makeStore(opts)` with `tabCount`/`claudeBusy`/`attention`/`freshAgentTab`/`pendingPermissions`/`freshAgentRunning`; only the e2e suite's `makeDeckStore` takes `tabs`. All default the active tab to `t1`. Add an `activeTab?: string` option (sets `preloadedState.tabs.activeTabId` / the built state's `activeTabId`) to whichever builder a test passes it to — only needed where a test wants a non-`t1` active tab.

Also update any existing `selectDeckModel` tests in this file that assert the old `{ id, title, active, status }` shape — extend their expected objects with the new fields (or switch them to `toMatchObject`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-selectors.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — new fields absent, order unsorted.

- [ ] **Step 3: Write minimal implementation**

Replace `selectDeckModel` and the `DeckTab`/`DeckModel` types in `src/deck/deck-selectors.ts`:

```ts
import { tileFill, tileDot, tilePriority, type TileFill, type TileDot } from './tile-state'

export type DeckTab = {
  id: string
  title: string
  active: boolean
  busy: boolean
  attention: boolean
  fill: TileFill
  dot: TileDot
  priority: number
  repoIcons: TileRepoIcon[]
  /** TRANSITIONAL: consumed by frame.ts ringColor/stripText until Task 9 removes rings. */
  status: TabRingStatus
}
export type DeckModel = { tabs: DeckTab[]; activeTabId: string | null }

export function selectDeckModel(state: RootState): DeckModel {
  const activeTabId = state.tabs.activeTabId
  const tabs = state.tabs.tabs.map((tab) => {
    const active = tab.id === activeTabId
    const flags = getTabStatusFlags(state, tab)
    return {
      id: tab.id,
      title: tab.title,
      active,
      busy: flags.busy,
      attention: flags.attention,
      fill: tileFill(active, flags),
      dot: tileDot(flags),
      priority: tilePriority(active, flags),
      repoIcons: getTabRepoIcons(state, tab),
      status: getTabRingStatus(state, tab),
    }
  })
  // Status-priority sort; Array.prototype.sort is stable, so tab-bar order
  // is preserved within each priority group. Paging slices this sorted list
  // (visibleTabs), so the pager pages over the sorted order automatically.
  tabs.sort((a, b) => a.priority - b.priority)
  return { activeTabId, tabs }
}
```

- [ ] **Step 4: Run tests to verify they pass — and check downstream compile**

Run: `npm run test:vitest -- run test/unit/client/deck/ --config config/vitest/vitest.config.ts`
Expected: `deck-selectors.test.ts` PASS. Two distinct downstream failure modes — do not confuse them:

1. `frame.test.ts` constructs `DeckTab` model objects directly — update its fixture tab objects to include the new fields (add `busy:false, attention:false, fill:'none', dot:null, priority:4, repoIcons:[]` as appropriate; a local `makeDeckTab(over)` helper keeps this readable).
2. `deck-controller.test.ts`, `test/e2e/stream-deck-flow.test.tsx`, and `test/unit/client/components/VirtualDeckPanel.test.tsx` build REAL stores (`configureStore` with ~10 reducers) that register neither `terminalMeta` nor `repoIcons` — the moment the controller calls the new `selectDeckModel`, `getTabRepoIcons` reads `state.terminalMeta.byTerminalId` and every test in those suites crashes with a TypeError. Fix by adding the real reducers to each fixture store's reducer map: `terminalMeta` (from `@/store/terminalMetaSlice`) and `repoIcons` (from `@/store/repoIconsSlice`). `preloadedState` seeding alone is NOT a fix — `configureStore` silently ignores preloadedState keys with no matching reducer. (This reducer registration is also the prerequisite that makes Task 8's and Task 11's `terminalMeta`/`repoIcons` seeding work.)

Run the store-backed suites too:

`npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`

The e2e "tabs appear on keys" scenario asserts key order from tab order — with sorting, a busy t1 now lands after green-icon tabs. Update expected key indices to the sorted order (this is the intended behavior change). Then:

Run: `npm run typecheck:client`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-selectors.ts test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): status-priority sorted DeckModel with fill/dot/repoIcons per tab"
```

---

### Task 5: `KeySpec` reshape (additive) + `buildFrame` `iconReady`

**Files:**
- Modify: `src/deck/frame.ts`
- Modify: `src/deck/deck-controller.ts` (one line: pass `iconReady`)
- Test: `test/unit/client/deck/frame.test.ts` (plus fixture updates in `deck-controller.test.ts`, `test/e2e/stream-deck-flow.test.tsx`)

**Interfaces:**
- Consumes: `DeckTab` (Task 4), `TileFill`/`TileDot` (Task 1), `TileRepoIcon` (Task 3).
- Produces (renderer Task 7 and controller Task 8 rely on):

```ts
export type TileIcon = { url: string | null; letter: string; hue: number; ready: boolean }
// tab variant of KeySpec becomes:
// { kind: 'tab'; tabId: string; title: string; previewLines: string[]; ring: RingColor;
//   active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }
// buildFrame inputs gain: iconReady: (url: string) => boolean
```

(`previewLines`/`ring` stay populated until Task 9 — additive first, remove later.)

- [ ] **Step 1: Write the failing test**

In `test/unit/client/deck/frame.test.ts`, extend the `buildFrame` tests. Follow the file's existing model-fixture style:

```ts
it('buildFrame carries fill/dot/icons onto tab keys, with iconReady resolving readiness', () => {
  const model = {
    activeTabId: 't1',
    tabs: [makeDeckTab({
      id: 't1', title: 'alpha', active: true, fill: 'barTop', dot: 'green',
      repoIcons: [
        { url: '/api/repo-icon?cwd=%2Fr%2Fa', letter: 'A', hue: 120 },
        { url: null, letter: 'B', hue: 200 },
      ],
    })],
  }
  const frame = buildFrame({
    model, caps: MINI_CAPS, page: 1, actionLayer: null,
    previewFor: () => [],
    iconReady: (url) => url === '/api/repo-icon?cwd=%2Fr%2Fa',
  })
  expect(frame.keys[0]).toMatchObject({
    kind: 'tab', tabId: 't1', fill: 'barTop', dot: 'green',
    icons: [
      { url: '/api/repo-icon?cwd=%2Fr%2Fa', letter: 'A', hue: 120, ready: true },
      { url: null, letter: 'B', hue: 200, ready: false },
    ],
  })
})
```

Add a `makeDeckTab(over: Partial<DeckTab>): DeckTab` helper at the top of `frame.test.ts` filling all required fields with defaults (`busy:false, attention:false, fill:'none', dot:null, priority:4, repoIcons:[], status:{busy:false,green:false,amber:false}, active:false, title:'tab'`), and refactor the file's existing model fixtures to use it.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/frame.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `iconReady` unknown input, `fill/dot/icons` missing from the produced KeySpec.

- [ ] **Step 3: Write minimal implementation**

In `src/deck/frame.ts`:

```ts
import type { TileFill, TileDot } from './tile-state'

export type TileIcon = { url: string | null; letter: string; hue: number; ready: boolean }

// KeySpec tab variant (replace the existing line):
export type KeySpec =
  | { kind: 'empty' }
  | { kind: 'tab'; tabId: string; title: string; previewLines: string[]; ring: RingColor;
      active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }
  | { kind: 'pager'; page: number; pageCount: number }
  | { kind: 'action'; action: DeckAction; enabled: boolean }
```

In `buildFrame`, add `iconReady` to the input type (`iconReady: (url: string) => boolean`) and extend the tab-key construction (`frame.ts:104-111`):

```ts
keys[keyIndex] = {
  kind: 'tab', tabId: tab.id, title: tab.title,
  previewLines: previewFor(tab.id), ring: ringColor(tab.status), active: tab.active,
  fill: tab.fill, dot: tab.dot,
  icons: tab.repoIcons.map((icon) => ({
    ...icon,
    ready: icon.url !== null && iconReady(icon.url),
  })),
}
```

In `src/deck/deck-controller.ts`, the `buildFrame` call site (`repaint()`, ~`:122`) must now pass `iconReady` — pass a stub for this task (`iconReady: () => false`); Task 8 wires the real cache.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: frame tests PASS. Decoded-KeySpec `toEqual` assertions in `deck-controller.test.ts` and `stream-deck-flow.test.tsx` now fail on the added fields — update every decoded tab-KeySpec expectation to include `fill`, `dot`, `icons` (e.g. the e2e scenario's expectation becomes `{ kind: 'tab', tabId: 't1', title: 'tab1', previewLines: [...], ring: 'blue', active: true, fill: 'none', dot: 'blue', icons: [] }`). Prefer switching bulky ones to `toMatchObject` where the full shape isn't the point. Then `npm run typecheck:client` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/deck/frame.ts src/deck/deck-controller.ts test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): KeySpec gains fill/dot/icons; buildFrame resolves icon readiness"
```

---

### Task 6: `IconImageCache`

**Files:**
- Create: `src/deck/icon-image-cache.ts`
- Test: `test/unit/client/deck/icon-image-cache.test.ts`

**Interfaces:**
- Consumes: nothing app-specific (DOM `Image` in the default loader, `document.createElement('canvas')` in the default probe only).
- Produces (Tasks 7, 8, 12 rely on):
  - `class IconImageCache { constructor(loader?: IconLoader, probe?: IconProbe); bitmapFor(url: string): CanvasImageSource | null; subscribe(cb: () => void): () => void }`
  - `type IconLoader = (url: string) => Promise<CanvasImageSource>`
  - `type IconProbe = (bitmap: CanvasImageSource) => boolean` (true = bitmap actually draws pixels)
  - `hasDrawnPixels(data: Uint8ClampedArray): boolean` (pure threshold logic, exported for tests)
  - `getIconImageCache(): IconImageCache` (singleton), `resetIconImageCacheForTests(cache?: IconImageCache): void`

**Verified jsdom constraints (A3):** under this vitest config (no `environmentOptions`), jsdom 25.0.1 uses `NoOpResourceLoader` — `Image`s never fetch, never fire `load`/`error`, never complete. Therefore: (a) tests MUST always inject the fake loader for any post-load assertion (default-loader promises pend forever in jsdom — harmless but never resolving); (b) every `IconImageCache` error path must be silent — no `console.error`/`console.warn` anywhere in this module (`console.error` is fatal in tests); (c) nobody may add `environmentOptions.jsdom.resources` or `userAgent` to the vitest config — either silently enables real fetching and would break these suites.

**Verified drawn-empty trap (A4):** headless Chromium 145 confirms PNG, .ico, SVGs with width/height, and viewBox-only SVGs all draw non-blank at 96×96 when `drawImage` gets EXPLICIT width/height args — but the server verifiably serves dimensionless SVGs (`repo_icon_detect.rs:51-52` "Unknown dimensions are acceptable"), and two servable shapes fire `onload` yet draw ~0 pixels (no-viewBox SVGs with off-viewport content; width/height=0 SVGs). xmlns-less SVGs fail at load (the `onerror` fallback covers them). So after a successful load the cache runs a runtime-only drawn-empty probe (below) and records near-blank draws as FAILED, making the letter avatar render. The probe lives in the cache — not the tile renderer — so `Ctx2D` stays minimal.

- [ ] **Step 1: Write the failing test**

Create `test/unit/client/deck/icon-image-cache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { IconImageCache, getIconImageCache, resetIconImageCacheForTests, hasDrawnPixels } from '@/deck/icon-image-cache'

const fakeBitmap = { width: 16, height: 16 } as unknown as CanvasImageSource

function deferredLoader() {
  // NOTE: `pending` is a Map keyed by url, so a duplicate load for the same url would
  // overwrite the same key and `pending.size` could never detect it. `calls()` counts
  // actual loader invocations - that is the ONLY signal that can catch duplicate loads
  // or a retry-after-failure implementation.
  const pending = new Map<string, { resolve: (b: CanvasImageSource) => void; reject: (e: Error) => void }>()
  let loads = 0
  const loader = (url: string) => {
    loads++
    return new Promise<CanvasImageSource>((resolve, reject) => pending.set(url, { resolve, reject }))
  }
  return { loader, pending, calls: () => loads }
}

describe('IconImageCache', () => {
  it('returns null while loading, kicks off exactly one load per url, notifies on completion', async () => {
    const { loader, pending, calls } = deferredLoader()
    const cache = new IconImageCache(loader)
    const listener = vi.fn()
    cache.subscribe(listener)
    expect(cache.bitmapFor('/i/a')).toBe(null)
    expect(cache.bitmapFor('/i/a')).toBe(null) // second call: no second load
    expect(calls()).toBe(1) // loader invoked exactly once (pending.size can't see dupes)
    pending.get('/i/a')!.resolve(fakeBitmap)
    await Promise.resolve() // flush microtasks
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.bitmapFor('/i/a')).toBe(fakeBitmap)
  })

  it('caches failures permanently (null forever, no retry) and still notifies', async () => {
    const { loader, pending, calls } = deferredLoader()
    const cache = new IconImageCache(loader)
    const listener = vi.fn()
    cache.subscribe(listener)
    cache.bitmapFor('/i/broken')
    pending.get('/i/broken')!.reject(new Error('404'))
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.bitmapFor('/i/broken')).toBe(null)
    expect(cache.bitmapFor('/i/broken')).toBe(null)
    // The load-bearing no-retry assertion: post-failure reads never re-invoke the loader.
    // (A retrying implementation would re-kick the load on every bitmapFor -> fetch/repaint
    // loop in production; pending.size stays 1 either way, so it proves nothing.)
    expect(calls()).toBe(1)
  })

  it('drawn-empty probe failing records the entry as FAILED (letter avatar renders), no retry', async () => {
    const { loader, pending, calls } = deferredLoader()
    const cache = new IconImageCache(loader, () => false) // injected probe: "drew ~0 pixels"
    const listener = vi.fn()
    cache.subscribe(listener)
    cache.bitmapFor('/i/blank-svg')
    pending.get('/i/blank-svg')!.resolve(fakeBitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).toHaveBeenCalledTimes(1)
    expect(cache.bitmapFor('/i/blank-svg')).toBe(null) // failed, like a load error
    expect(calls()).toBe(1) // permanent: the post-failure read above did not re-invoke the loader
  })

  it('drawn-empty probe passing keeps the bitmap', async () => {
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader, () => true)
    cache.bitmapFor('/i/ok')
    pending.get('/i/ok')!.resolve(fakeBitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(cache.bitmapFor('/i/ok')).toBe(fakeBitmap)
  })

  it('unsubscribe stops notifications', async () => {
    const { loader, pending } = deferredLoader()
    const cache = new IconImageCache(loader)
    const listener = vi.fn()
    cache.subscribe(listener)()
    cache.bitmapFor('/i/a')
    pending.get('/i/a')!.resolve(fakeBitmap)
    await Promise.resolve()
    await Promise.resolve()
    expect(listener).not.toHaveBeenCalled()
  })

  it('singleton: getIconImageCache returns the same instance; reset swaps it for tests', () => {
    resetIconImageCacheForTests()
    const a = getIconImageCache()
    expect(getIconImageCache()).toBe(a)
    const fake = new IconImageCache(async () => fakeBitmap)
    resetIconImageCacheForTests(fake)
    expect(getIconImageCache()).toBe(fake)
    resetIconImageCacheForTests()
  })
})

describe('hasDrawnPixels (drawn-empty threshold)', () => {
  const px = (alphas: number[]): Uint8ClampedArray => {
    const data = new Uint8ClampedArray(alphas.length * 4)
    alphas.forEach((a, i) => { data[i * 4 + 3] = a })
    return data
  }
  it('false for a fully transparent draw', () => {
    expect(hasDrawnPixels(px(new Array(100).fill(0)))).toBe(false)
  })
  it('true at >= 1% alpha coverage', () => {
    expect(hasDrawnPixels(px([255, ...new Array(99).fill(0)]))).toBe(true) // exactly 1%
  })
  it('false just below 1% coverage', () => {
    expect(hasDrawnPixels(px([255, ...new Array(199).fill(0)]))).toBe(false) // 0.5%
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/icon-image-cache.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write minimal implementation**

Create `src/deck/icon-image-cache.ts`:

```ts
// Async bitmap cache for repo icons drawn on Stream Deck tiles.
// Canvas analogue of RepoIcon.tsx's <img> + onError-fallback: while a URL is
// loading (or after it fails) bitmapFor returns null and the tile renderer
// draws the letter avatar; when a load completes, subscribers (the deck
// controller) are notified so tiles repaint with the real icon.
// Failures are cached permanently for the session (like <img onError> ->
// letter avatar; the server caches negatives too).
// All error paths are SILENT - no console.error/console.warn (console.error is
// fatal in tests, and a failed icon is expected, not exceptional).

export type IconLoader = (url: string) => Promise<CanvasImageSource>

const defaultLoader: IconLoader = (url) =>
  new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`repo icon load failed: ${url}`))
    img.src = url
  })

/** True when the decoded bitmap actually draws pixels (guards the SVG drawn-empty trap). */
export type IconProbe = (bitmap: CanvasImageSource) => boolean

export const DRAWN_EMPTY_PROBE_SIZE = 16
/** Minimum fraction of non-transparent pixels for a draw to count as visible. */
export const DRAWN_EMPTY_MIN_ALPHA_COVERAGE = 0.01

/** Pure threshold logic (exported for unit tests): >= 1% of pixels have alpha > 0. */
export function hasDrawnPixels(data: Uint8ClampedArray): boolean {
  const pixels = data.length / 4
  let opaque = 0
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] > 0) opaque++
  }
  return pixels > 0 && opaque / pixels >= DRAWN_EMPTY_MIN_ALPHA_COVERAGE
}

// Runtime-only drawn-empty probe. The server serves dimensionless SVGs first-class
// (repo_icon_detect.rs:51-52 "Unknown dimensions are acceptable"), and two servable
// shapes fire onload yet draw ~0 pixels in real Chromium (no-viewBox SVGs with
// off-viewport content; width/height=0 SVGs). Draw into a small internal canvas with
// EXPLICIT destination dims and count alpha; near-blank -> treat as failure so the
// letter avatar renders. In jsdom, getContext returns null: skip and trust the load.
const defaultProbe: IconProbe = (bitmap) => {
  const canvas = document.createElement('canvas')
  canvas.width = DRAWN_EMPTY_PROBE_SIZE
  canvas.height = DRAWN_EMPTY_PROBE_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return true // jsdom / no 2D context: cannot probe, trust the load
  ctx.clearRect(0, 0, DRAWN_EMPTY_PROBE_SIZE, DRAWN_EMPTY_PROBE_SIZE)
  ctx.drawImage(bitmap, 0, 0, DRAWN_EMPTY_PROBE_SIZE, DRAWN_EMPTY_PROBE_SIZE)
  return hasDrawnPixels(ctx.getImageData(0, 0, DRAWN_EMPTY_PROBE_SIZE, DRAWN_EMPTY_PROBE_SIZE).data)
}

export class IconImageCache {
  private bitmaps = new Map<string, CanvasImageSource>()
  private failed = new Set<string>()
  private pending = new Set<string>()
  private listeners = new Set<() => void>()

  constructor(
    private loader: IconLoader = defaultLoader,
    private probe: IconProbe = defaultProbe,
  ) {}

  /** Returns the decoded bitmap, or null while loading / after failure. Requests the load on first miss. */
  bitmapFor(url: string): CanvasImageSource | null {
    const hit = this.bitmaps.get(url)
    if (hit) return hit
    if (!this.failed.has(url) && !this.pending.has(url)) {
      this.pending.add(url)
      void this.loader(url).then(
        (bitmap) => {
          this.pending.delete(url)
          if (this.probe(bitmap)) {
            this.bitmaps.set(url, bitmap)
          } else {
            this.failed.add(url) // drew ~0 pixels: record as FAILED -> letter avatar
          }
          this.notify()
        },
        () => {
          this.pending.delete(url)
          this.failed.add(url)
          this.notify()
        },
      )
    }
    return null
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

let singleton: IconImageCache | null = null

export function getIconImageCache(): IconImageCache {
  if (!singleton) singleton = new IconImageCache()
  return singleton
}

export function resetIconImageCacheForTests(cache?: IconImageCache): void {
  singleton = cache ?? null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test:vitest -- run test/unit/client/deck/icon-image-cache.test.ts --config config/vitest/vitest.config.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/deck/icon-image-cache.ts test/unit/client/deck/icon-image-cache.test.ts
git commit -m "feat(deck): IconImageCache - async repo-icon bitmaps with letter-avatar fallback and drawn-empty probe"
```

---

### Task 7: Tile renderer redesign

**Files:**
- Modify: `src/deck/tile-renderer.ts`
- Modify: `src/components/VirtualDeckPanel.tsx` (`noopCtx` gains `drawImage`; renderer closures pass the cache getter)
- Test: `test/unit/client/deck/tile-renderer.test.ts`

**Interfaces:**
- Consumes: `TileIcon` KeySpec fields (Task 5), `getIconImageCache` (Task 6, in VirtualDeckPanel wiring).
- Produces (Task 8 and 12 rely on):
  - `Ctx2D` now includes `'drawImage'` in the `Pick`.
  - `type IconSource = (url: string) => CanvasImageSource | null`
  - `renderKey(spec: KeySpec, caps: DeckCapabilities, createCtx: CtxFactory, getIcon?: IconSource): Uint8ClampedArray` (default `() => null`)
  - `iconLayout(w: number, h: number, count: number): Array<{ x: number; y: number; size: number }>`
  - New constants: `TILE_BG = '#0a0a0a'`, `TILE_FILL_GREEN = '#a7f3d0'`, `BAR_TOP_BORDER = '#21c45d'`, `DOT_GREEN = '#21c45d'`, `DOT_BLUE = '#3b82f6'`, `DOT_SIZE = 8`

- [ ] **Step 1: Write the failing tests**

Rewrite the `renderKey` tab-tile tests in `test/unit/client/deck/tile-renderer.test.ts`. Extend the file's `recordingCtx()` with `drawImage` recording and add an `images` array:

```ts
type Img = { x: number; y: number; w: number; h: number }
// inside recordingCtx():
const images: Img[] = []
// add to the ctx object:
drawImage(_src: CanvasImageSource, x: number, y: number, w: number, h: number) {
  images.push({ x, y, w, h })
},
// return { ctx, rects, texts, images }
```

New/updated tests (keep the existing `truncateTitle`/`fitLabel`/`drawRing`/pager/action tests; delete the `previewGeometry`/`cropPreviewLines` tests in Task 9, not here):

```ts
const tabSpec = (over: Partial<Extract<KeySpec, { kind: 'tab' }>> = {}): KeySpec => ({
  kind: 'tab', tabId: 't1', title: 'build', previewLines: [], ring: null,
  active: false, fill: 'none', dot: null, icons: [], ...over,
})

it('no-fill tile: near-black bg, banner, white title, no rings, no dot, no preview text', () => {
  const { out, rects, texts } = renderTab(tabSpec())
  expect(out).toBeInstanceOf(Uint8ClampedArray)
  expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: TILE_BG })
  expect(rects.some((r) => r.y === 0 && r.h === 20 && r.style.startsWith('rgba'))).toBe(true) // banner
  expect(texts.some((t) => t.text === 'build' && t.style === '#ffffff')).toBe(true)           // title
  expect(rects.filter((r) => r.style === ACTIVE_COLOR)).toHaveLength(0)
  expect(texts.filter((t) => t.style === '#a8a8a8')).toHaveLength(0) // preview text gone from drawTab (literal: the constant dies in Task 9)
})

it('green fill state paints the light-green background', () => {
  const { rects } = renderTab(tabSpec({ fill: 'green' }))
  expect(rects[0]).toMatchObject({ x: 0, y: 0, w: 80, h: 80, style: TILE_FILL_GREEN })
})

it('barTop state paints light-green background + 3px green border ring', () => {
  const { rects } = renderTab(tabSpec({ fill: 'barTop', active: true }))
  expect(rects[0].style).toBe(TILE_FILL_GREEN)
  expect(rects.filter((r) => r.style === BAR_TOP_BORDER).length).toBeGreaterThan(0)
  // active tab keeps its white ring nested inside the border
  expect(rects.filter((r) => r.style === ACTIVE_COLOR && r.h <= 1).length).toBeGreaterThan(0)
})

it('active tab without fill gets the plain white ring', () => {
  const { rects } = renderTab(tabSpec({ active: true }))
  expect(rects.filter((r) => r.style === ACTIVE_COLOR).length).toBeGreaterThan(0)
})

it('ready icon draws via drawImage at the centered layout slot', () => {
  const bitmap = {} as CanvasImageSource
  const { images } = renderTab(
    tabSpec({ icons: [{ url: '/i/a', letter: 'A', hue: 120, ready: true }] }),
    (url) => (url === '/i/a' ? bitmap : null),
  )
  const [slot] = iconLayout(80, 80, 1)
  expect(images).toEqual([{ x: slot.x, y: slot.y, w: slot.size, h: slot.size }])
})

it('unready or letter-only icon draws the hue swatch + white letter fallback', () => {
  const { rects, texts, images } = renderTab(
    tabSpec({ icons: [{ url: null, letter: 'B', hue: 200, ready: false }] }),
  )
  expect(images).toHaveLength(0)
  expect(rects.some((r) => r.style === 'hsl(200, 60%, 42%)')).toBe(true)
  expect(texts.some((t) => t.text === 'B' && t.style === '#ffffff')).toBe(true)
})

it('status dot: green and blue variants at bottom-center; absent when null', () => {
  const green = renderTab(tabSpec({ dot: 'green' }))
  expect(green.rects.some((r) => r.style === DOT_GREEN && r.w === DOT_SIZE && r.h === DOT_SIZE)).toBe(true)
  const blue = renderTab(tabSpec({ dot: 'blue' }))
  expect(blue.rects.some((r) => r.style === DOT_BLUE && r.w === DOT_SIZE && r.h === DOT_SIZE)).toBe(true)
  const none = renderTab(tabSpec())
  expect(none.rects.some((r) => r.w === DOT_SIZE && r.h === DOT_SIZE)).toBe(false)
})

it('iconLayout: 1 icon centered large; 3 icons in a centered row below the banner', () => {
  const one = iconLayout(80, 80, 1)
  expect(one).toHaveLength(1)
  expect(one[0].size).toBe(30) // round(min(80, 60) * 0.5)
  expect(one[0].x).toBe(Math.round((80 - 30) / 2))
  expect(one[0].y).toBe(Math.round(20 + (60 - 30) / 2))
  const three = iconLayout(80, 80, 3)
  expect(three).toHaveLength(3)
  expect(three.every((s) => s.size === 18)).toBe(true) // round(60 * 0.3)
  expect(three[1].x - three[0].x).toBe(18 + 3)         // size + gap
})
```

Add a local `renderTab(spec, getIcon?)` helper wrapping the file's existing factory-capture pattern (captures `recordingCtx` output and calls `renderKey(spec, MINI_CAPS, factory, getIcon)`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/tile-renderer.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — `TILE_BG`/`iconLayout`/`IconSource` not exported, `drawTab` still draws previews/rings.

- [ ] **Step 3: Write the implementation**

In `src/deck/tile-renderer.ts`:

1. Widen the ctx seam:

```ts
export type Ctx2D = Pick<
  CanvasRenderingContext2D,
  'fillRect' | 'fillText' | 'measureText' | 'getImageData' | 'drawImage'
> & { fillStyle: string | CanvasGradient | CanvasPattern; font: string; textBaseline: CanvasTextBaseline }

export type IconSource = (url: string) => CanvasImageSource | null
```

2. New constants (keep `BANNER_HEIGHT`, `BANNER_FILL`, `TITLE_FONT_SIZE`, `ACTIVE_COLOR`, `MAX_TITLE_CHARS`, action/pager/strip constants; `PREVIEW_*` constants stay until Task 9):

```ts
export const TILE_BG = '#0a0a0a'
/** Light green fill - the tab bar's emerald attention fill, tuned for the LCD (emerald-200). */
export const TILE_FILL_GREEN = '#a7f3d0'
/** The tab bar's bar-on-top green (--success, hsl(142 71% 45%)). */
export const BAR_TOP_BORDER = '#21c45d'
/** Status dot: the tab bar's icon tint colors (text-success / text-blue-500). */
export const DOT_GREEN = '#21c45d'
export const DOT_BLUE = '#3b82f6'
export const DOT_SIZE = 8
export const ICON_GAP = 3
```

3. Layout helper:

```ts
/** Centered icon slots in the area below the title banner. */
export function iconLayout(w: number, h: number, count: number): Array<{ x: number; y: number; size: number }> {
  if (count <= 0) return []
  const areaTop = BANNER_HEIGHT
  const areaH = h - areaTop
  const scale = count === 1 ? 0.5 : 0.3
  const size = Math.round(Math.min(w, areaH) * scale)
  const rowW = count * size + (count - 1) * ICON_GAP
  const x0 = Math.round((w - rowW) / 2)
  const y = Math.round(areaTop + (areaH - size) / 2)
  return Array.from({ length: count }, (_, i) => ({ x: x0 + i * (size + ICON_GAP), y, size }))
}
```

4. Rewrite `drawTab` (replace the whole function; the preview-drawing block is deleted from `drawTab` here, the helpers/constants themselves are deleted in Task 9). Rule carried from validation (A4): every `drawImage` call takes EXPLICIT destination width and height — that is what rescues viewBox-only SVGs from drawing blank; the drawn-empty shapes that explicit dims cannot rescue are caught by Task 6's cache-side probe, so the renderer stays probe-free:

```ts
function drawTab(ctx: Ctx2D, w: number, h: number, spec: Extract<KeySpec, { kind: 'tab' }>, getIcon: IconSource): void {
  // 1. Background mirrors the tab bar state: no fill / green fill / barTop (fill + border below).
  ctx.fillStyle = spec.fill === 'none' ? TILE_BG : TILE_FILL_GREEN
  ctx.fillRect(0, 0, w, h)

  // 2. Centered repo icons; letter avatar while loading, on failure, or when the repo has no icon.
  const slots = iconLayout(w, h, spec.icons.length)
  spec.icons.forEach((icon, i) => {
    const { x, y, size } = slots[i]
    const bitmap = icon.url && icon.ready ? getIcon(icon.url) : null
    if (bitmap) {
      // ALWAYS pass explicit destination width AND height: dimensionless (viewBox-only)
      // SVGs draw blank without them (verified headless Chromium 145; the server serves
      // dimensionless SVGs first-class - repo_icon_detect.rs:51-52). Never call the
      // 3-arg drawImage(image, dx, dy) form anywhere in this module.
      ctx.drawImage(bitmap, x, y, size, size)
      return
    }
    // Letter avatar (canvas analogue of RepoIcon's SVG circle): hue swatch + white letter.
    ctx.fillStyle = `hsl(${icon.hue}, 60%, 42%)`
    ctx.fillRect(x, y, size, size)
    ctx.font = `600 ${Math.round(size * 0.6)}px sans-serif`
    ctx.textBaseline = 'top'
    ctx.fillStyle = '#ffffff'
    const letterWidth = ctx.measureText(icon.letter).width
    ctx.fillText(icon.letter, Math.round(x + (size - letterWidth) / 2), Math.round(y + size * 0.2))
  })

  // 3. Status dot: the tab bar's green/blue icon-tint states, visible on the deck.
  if (spec.dot) {
    ctx.fillStyle = spec.dot === 'green' ? DOT_GREEN : DOT_BLUE
    ctx.fillRect(Math.round((w - DOT_SIZE) / 2), h - DOT_SIZE - 5, DOT_SIZE, DOT_SIZE)
  }

  // 4. Title banner across the top (unchanged treatment).
  ctx.fillStyle = BANNER_FILL
  ctx.fillRect(0, 0, w, BANNER_HEIGHT)
  ctx.font = `${TITLE_FONT_SIZE}px sans-serif`
  ctx.textBaseline = 'top'
  ctx.fillStyle = ACTIVE_COLOR
  const label = fitLabel((t) => ctx.measureText(t).width, truncateTitle(spec.title), w - 4)
  drawCenteredText(ctx, label, w, 2)

  // 5. Borders/rings: barTop green border; white ring marks the active tab.
  if (spec.fill === 'barTop') {
    drawRing(ctx, w, h, BAR_TOP_BORDER, 3, 0)
    if (spec.active) drawRing(ctx, w, h, ACTIVE_COLOR, 2, 3)
  } else if (spec.active) {
    drawRing(ctx, w, h, ACTIVE_COLOR, 3, 0)
  }
}
```

5. Thread `getIcon` through `renderKey`:

```ts
export function renderKey(
  spec: KeySpec,
  caps: DeckCapabilities,
  createCtx: CtxFactory,
  getIcon: IconSource = () => null,
): Uint8ClampedArray {
  // ... existing body; the 'tab' case becomes: drawTab(ctx, w, h, spec, getIcon)
}
```

6. In `src/components/VirtualDeckPanel.tsx`: add a no-op `drawImage() {}` to `noopCtx` (`:21-31`), and change the controller's renderer wiring (`:81-88`) to:

```ts
renderKey: (spec, c) => renderKey(spec, c, safeCtxFactory, (url) => getIconImageCache().bitmapFor(url)),
```

with `import { getIconImageCache } from '@/deck/icon-image-cache'`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (old drawTab ring/preview assertions were replaced in Step 1; VirtualDeckPanel tests assert DOM/store, unaffected). Then `npm run typecheck:client` — clean (this catches any other fake ctx missing `drawImage`).

- [ ] **Step 5: Commit**

```bash
git add src/deck/tile-renderer.ts src/components/VirtualDeckPanel.tsx test/unit/client/deck/tile-renderer.test.ts
git commit -m "feat(deck): tab-bar-matching tile rendering - fills, repo icons, status dot, active ring"
```

---

### Task 8: Controller — icon-cache wiring + preview path removal

**Files:**
- Modify: `src/deck/deck-controller.ts`
- Test: `test/unit/client/deck/deck-controller.test.ts`

**Interfaces:**
- Consumes: `IconImageCache`/`getIconImageCache` (Task 6), `renderKey` 4-arg form (Task 7), `panesForTab` (Task 2), `resolvePaneRepoCwd` (`@/lib/repo-icon`), `fetchRepoIconMeta` (`@/store/repoIconsSlice` — the deck's sole store write; the thunk self-dedupes, `repoIconsSlice.ts:36-40`).
- Produces: `DeckControllerOptions` gains `iconCache?: IconImageCache`; the controller OWNS repo-icon meta probing (un-gated by `settings.panes.repoIconsOnTabs` — Design decision 7; TabBar cannot be relied on: its probe at `TabBar.tsx:240` is gated at `:230` and TabBar is conditionally mounted, `App.tsx:1644`); `previewFor` and the 3s preview repaint are gone (Task 9 deletes the registry module itself).

- [ ] **Step 1: Write the failing tests**

In `test/unit/client/deck/deck-controller.test.ts` (uses the spec-encoding renderer + `FakeDeckDevice` + fake timers):

```ts
import { IconImageCache } from '@/deck/icon-image-cache'
import { registerTerminalTextReader } from '@/deck/terminal-text-registry'
import { upsertTerminalMeta } from '@/store/terminalMetaSlice'

it('repaints keys when an icon bitmap finishes loading (cache subscription)', async () => {
  // Deferred loader as in icon-image-cache.test.ts
  const { loader, pending } = deferredLoader()
  const cache = new IconImageCache(loader)
  const { device } = setup({
    tabCount: 1,
    terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
    repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
  }, undefined, { iconCache: cache })
  const before = decodeKey(device, 0)!
  expect(before.kind === 'tab' && before.icons[0].ready).toBe(false)
  pending.get(before.kind === 'tab' ? before.icons[0].url! : '')!.resolve({} as CanvasImageSource)
  await vi.advanceTimersByTimeAsync(0) // flush the load microtask under fake timers
  const after = decodeKey(device, 0)!
  expect(after.kind === 'tab' && after.icons[0].ready).toBe(true)
})

it('no periodic preview repaint: 3s of ticks paints nothing even when terminal text changes', () => {
  // A reader with a CHANGING snapshot is what makes this test able to go RED: with
  // no reader registered, previewFor already yields [] and the per-key spec-JSON
  // diff suppresses every paint, so the assertion would pass against unmodified
  // code (vacuous). With the reader, current code's PREVIEW_REFRESH_TICKS branch
  // repaints key 0 at the ~3s tick (new previewLines -> spec differs) and the test
  // fails; it goes green only when previewFor and the tick branch are deleted.
  // (Task 9 deletes the registry module itself; when it does, rework this test to
  // drop the reader registration - the no-repaint guarantee becomes structural via
  // Task 9's grep gate on PREVIEW_REFRESH_TICKS/registerTerminalTextReader.)
  let n = 0
  const unregister = registerTerminalTextReader('term-1', () => [`line ${n++}`])
  const { device } = setup({ tabCount: 1 })
  device.keyImages.clear()
  vi.advanceTimersByTime(3_000)
  expect(device.keyImages.size).toBe(0)
  unregister()
})

it('dispatches fetchRepoIconMeta for tab cwds even when settings.panes.repoIconsOnTabs is false (deck owns the probe)', () => {
  // No repoIcons seeded: the controller itself must probe /repos/alpha. TabBar cannot be
  // relied on (its probe is gated on repoIconsOnTabs and TabBar is conditionally mounted).
  // repoIconsOnTabs is an EXISTING app setting (state.settings.settings.panes, default
  // true) - NOT the controller's brightness-only settings() option. It must be false
  // BEFORE the controller starts (flipping it after start proves nothing: the probe
  // already ran under the default), hence the fixture option below, which the builder
  // applies via store.dispatch(updateSettingsLocal({ panes: { repoIconsOnTabs: false } }))
  // before setup() constructs the controller (precedent: deck-manager.test.ts:128; the
  // suite already registers settingsReducer).
  const { store } = setup({
    tabCount: 1,
    terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
    repoIconsOnTabs: false,
  })
  // The thunk's pending case records { status: 'loading' } synchronously on dispatch.
  expect(store.getState().repoIcons.byCwd['/repos/alpha']).toMatchObject({ status: 'loading' })
})

it('does not re-probe a cwd already present in state.repoIcons.byCwd', () => {
  const { store } = setup({
    tabCount: 1,
    terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
    repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
  })
  expect(store.getState().repoIcons.byCwd['/repos/alpha'].status).toBe('ready') // untouched, no 'loading' overwrite
})

it('probes a cwd that only becomes resolvable AFTER start (late terminalMeta, model JSON unchanged)', () => {
  // Fixture panes have no initialCwd, so nothing is resolvable at start(). A later
  // upsertTerminalMeta makes term-1's cwd resolvable but does NOT change the deck
  // model JSON (icons stay [] until meta AND repoIcons both exist), so this test
  // proves the probe runs BEFORE onStoreChange's model-JSON bail-out - the exact
  // TabBar-less leader scenario the deck-owned probe exists for.
  const { store } = setup({ tabCount: 1 }) // no terminalMeta seeded
  expect(store.getState().repoIcons.byCwd['/repos/alpha']).toBeUndefined()
  store.dispatch(upsertTerminalMeta([{ terminalId: 'term-1', cwd: '/repos/alpha', updatedAt: Date.now() }]))
  expect(store.getState().repoIcons.byCwd['/repos/alpha']).toMatchObject({ status: 'loading' })
})
```

(If the suite's real `api` layer throws synchronously in jsdom, `vi.mock('@/lib/api', ...)` it with a never-resolving `get` — the probe assertions only need the thunk's synchronous `pending` entry.)

This suite's REAL fixture API (verified): `makeStore(opts: StoreOpts)` with options `tabCount`/`claudeBusy`/`attention`/`freshAgentTab`/`pendingPermissions`/`freshAgentRunning`, and `setup(opts, caps)` with TWO params. There is NO `defaultSettings` identifier in this file (it exists only in the e2e suite, where it is a function returning deck-brightness `DeckSettings` — unrelated to app settings); the controller's `settings()` option here is `const settings` at `deck-controller.test.ts:105` and stays untouched. Extend the machinery as follows: (a) `setup()` gains a 3rd arg of extra `DeckController` constructor options (spread last — used above for `iconCache`); (b) `StoreOpts` gains `terminalMeta?` / `repoIcons?`, seeded via `preloadedState` — this works only because Task 4 already registered the real `terminalMeta`/`repoIcons` reducers in this suite's reducer map (`configureStore` silently drops preloadedState keys with no matching reducer); (c) `StoreOpts` gains `repoIconsOnTabs?: boolean` — when set, `makeStore` dispatches `updateSettingsLocal({ panes: { repoIconsOnTabs } })` (import from `@/store/settingsSlice`; `settingsReducer` is already registered in this suite) on the store before returning it, so the value is in place before `setup()` constructs and starts the controller (precedent: `deck-manager.test.ts:128`). Note this suite has NO existing preview or `PREVIEW_REFRESH_TICKS` tests to update or remove — the only preview coverage lives in `test/e2e/stream-deck-flow.test.tsx` (exact `toEqual` assertions on full KeySpecs including `previewLines`); those e2e expectations are updated in Step 4.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — no `iconCache` option; icons never become ready; the no-periodic-repaint test fails because the registered reader's changing snapshot makes the `PREVIEW_REFRESH_TICKS` tick repaint key 0 with new `previewLines`; no probe dispatch exists yet, so `state.repoIcons.byCwd['/repos/alpha']` stays `undefined` in the un-gated probe test and the late-terminalMeta test. (The no-re-probe test guards the implementation once it exists and may already pass here — that is fine; the other probe tests carry the RED gate.)

- [ ] **Step 3: Write the implementation**

In `src/deck/deck-controller.ts`:

1. Options + field:

```ts
import { IconImageCache, getIconImageCache } from './icon-image-cache'
// DeckControllerOptions gains:
//   iconCache?: IconImageCache
private readonly iconCache: IconImageCache
// constructor:
this.iconCache = options.iconCache ?? getIconImageCache()
```

2. Default renderer (where `options.renderKey` falls back to the real renderer) passes the cache:

```ts
this.renderKeyFn = options.renderKey ??
  ((spec, caps) => renderKey(spec, caps, defaultCtxFactory, (url) => this.iconCache.bitmapFor(url)))
```

3. `start()`: subscribe; `stop()`: unsubscribe:

```ts
this.unsubscribeIcons = this.iconCache.subscribe(() => this.repaint())
// stop():
this.unsubscribeIcons?.()
this.unsubscribeIcons = null
```

4. `repaint()`: replace `previewFor` with the real `iconReady`:

```ts
const frame = buildFrame({
  model, caps, page: this.page,
  actionLayer: this.actionLayerInputs(state),
  iconReady: (url) => this.iconCache.bitmapFor(url) !== null,
})
```

(`bitmapFor` both reports readiness and requests the load — first paint of a tile with an unloaded icon starts the fetch.)

5. Delete `previewFor` (`:151-160`), the `getTerminalTextSnapshot` import (`:24`), the `PREVIEW_REFRESH_TICKS` constant (`:40`) and its branch in `tick()` (`:327-331`) — `tick()` keeps running `dutyChecks()` every 500ms for the action-layer timeout and idle dim. Remove `previewFor` from `buildFrame`'s input type in `frame.ts` and delete the `previewLines: previewFor(tab.id)` line — set `previewLines: []` for now (field dies in Task 9). Update `frame.test.ts` call sites to drop `previewFor`.

6. Also remove the "ORDERING (load-bearing)" comment in `onStoreChange` referencing previews (`:164-170`) — the bail-out itself stays.

7. Own the repo-icon meta probe. The deck cannot rely on TabBar to populate `state.repoIcons.byCwd`: `TabBar.tsx:240` is the app's only other dispatcher, gated at `:230` on `repoIconsOnTabs`, and TabBar is conditionally mounted (`App.tsx:1644`) while leader election (`deck-manager.ts:166-203`) can elect a window without it. Add to `deck-controller.ts`:

```ts
import { fetchRepoIconMeta } from '@/store/repoIconsSlice'
import { resolvePaneRepoCwd } from '@/lib/repo-icon'
import { panesForTab } from './deck-selectors'

/**
 * Probe repo-icon meta for every distinct resolved cwd of the tabs we render.
 * Deliberately UN-gated by settings.panes.repoIconsOnTabs (Design decision 7:
 * deck tiles always show their center glyph). Double-probing alongside a
 * mounted TabBar is harmless - the thunk self-dedupes (repoIconsSlice.ts:36-40).
 */
private probeRepoIcons(): void {
  const state = this.store.getState()
  const terminalMetaById = state.terminalMeta.byTerminalId
  const cwds = new Set<string>()
  for (const tab of state.tabs.tabs) {
    for (const entry of panesForTab(state, tab)) {
      const cwd = resolvePaneRepoCwd(entry.content, tab, terminalMetaById)
      if (cwd) cwds.add(cwd)
    }
  }
  for (const cwd of cwds) {
    if (!state.repoIcons.byCwd[cwd]) this.store.dispatch(fetchRepoIconMeta(cwd))
  }
}
```

Call sites: once in `start()` (after the initial repaint), and in `onStoreChange` on EVERY store change, BEFORE the `modelJson === this.lastModelJson` bail-out. This placement is load-bearing: the store events that first make a cwd resolvable — `upsertTerminalMeta`/`setTerminalMetaSnapshot` enriching `terminalMeta.byTerminalId` — do NOT change the model JSON (with no `repoIcons.byCwd` entry yet, `icons` is `[]` both before and after), so a probe placed after the bail-out would never fire in exactly the TabBar-less leader scenario this probe exists for. Pre-bail-out probing is cheap (a Set build over tabs/panes per store change; it dispatches only for unprobed cwds) and cannot loop: the thunk's synchronous `pending` entry lands in `repoIcons.byCwd`, so the `!state.repoIcons.byCwd[cwd]` guard skips that cwd on the re-entrant store change, and when the meta arrives the model JSON changes and the normal repaint path takes over. If the controller's `store` field is typed too narrowly to dispatch thunks, type it with the app store's `AppDispatch` (the same store type `focusTabFromDeck` already dispatches through) rather than casting at the call site.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: controller tests PASS. The e2e suite's preview expectations now decode `previewLines: []` — update those expectations (full preview deletion lands in Task 9). Then `npm run typecheck:client` — clean.

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-controller.ts src/deck/frame.ts test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx
git commit -m "feat(deck): controller loads repo icons via IconImageCache, owns the meta probe, drops the preview repaint"
```

---

### Task 9: Remove dead preview + ring machinery

**Files:**
- Delete: `src/deck/terminal-text-registry.ts`, `test/unit/client/deck/terminal-text-registry.test.tsx`
- Modify: `src/components/TerminalView.tsx` (remove import at ~`:103` and hook call at ~`:676-677`)
- Modify: `src/deck/frame.ts` (drop `previewLines`/`ring` from KeySpec; delete `RingColor`, `ringColor`; `stripText` from flags)
- Modify: `src/deck/tile-renderer.ts` (delete `PREVIEW_BG`→ replaced by `TILE_BG` already, `PREVIEW_TEXT_COLOR`, `PREVIEW_FONT_SIZE`, `PREVIEW_LINE_HEIGHT`, `PREVIEW_CHAR_WIDTH`, `PREVIEW_LEFT_MARGIN`, `previewGeometry`, `cropPreviewLines`, `RING_COLORS`)
- Modify: `src/deck/deck-selectors.ts` (delete `getTabRingStatus`, `TabRingStatus`, and the transitional `status` field on `DeckTab`)
- Test: `test/unit/client/deck/frame.test.ts`, `tile-renderer.test.ts`, `deck-selectors.test.ts`, `deck-controller.test.ts`, `test/e2e/stream-deck-flow.test.tsx` (fixture/expectation updates)

**Interfaces:**
- Consumes: everything from Tasks 4–8 in place.
- Produces: final `KeySpec` tab variant `{ kind: 'tab'; tabId: string; title: string; active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }`; final `DeckTab` without `status`; `stripText` computes `busyCount = tabs.filter(t => t.busy).length`, `waitingCount = tabs.filter(t => t.attention).length`.

- [ ] **Step 1: Write the failing tests (RED via deletion)**

Update `frame.test.ts`: remove the `ringColor` describe block; remove `previewLines`/`ring` from every expected KeySpec; assert `stripText` still reports `X busy Y waiting` from the new flags:

```ts
it('stripText counts busy and waiting from tab flags', () => {
  const model = {
    activeTabId: 't1',
    tabs: [
      makeDeckTab({ id: 't1', title: 'alpha', active: true, busy: true }),
      makeDeckTab({ id: 't2', attention: true }),
      makeDeckTab({ id: 't3' }),
    ],
  }
  expect(stripText(model, 1, 1)).toContain('1 busy 1 waiting')
})
```

Update `tile-renderer.test.ts`: delete `previewGeometry`/`cropPreviewLines` tests; remove `previewLines`/`ring` from `tabSpec`. Update `deck-selectors.test.ts` expectations to drop `status`. Update `deck-controller.test.ts` and `stream-deck-flow.test.tsx` fixtures/expectations to the final KeySpec shape and remove `registerTerminalTextReader` / `resetTerminalTextRegistryForTests` usage.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: FAIL — produced KeySpecs still carry `previewLines`/`ring`, `status` still on model tabs.

- [ ] **Step 3: Delete the machinery**

- `frame.ts`: KeySpec tab variant → `{ kind: 'tab'; tabId: string; title: string; active: boolean; fill: TileFill; dot: TileDot; icons: TileIcon[] }`; delete `export type RingColor`, `export function ringColor`, remove `previewLines`/`ring` from `buildFrame`; `stripText` busy/waiting counts switch to `tab.busy` / `tab.attention`.
- `tile-renderer.ts`: delete the preview constants + `previewGeometry` + `cropPreviewLines` + `RING_COLORS` (keep `drawRing`, `ACTION_RING`, action/pager rendering; keep `TILE_BG` as the sole background constant — if `PREVIEW_BG` was still referenced anywhere, replace with `TILE_BG`).
- `deck-selectors.ts`: delete `getTabRingStatus`, `TabRingStatus`, and `status` from `DeckTab`/`selectDeckModel`.
- Delete `src/deck/terminal-text-registry.ts` and `test/unit/client/deck/terminal-text-registry.test.tsx` (`git rm`).
- `src/components/TerminalView.tsx`: remove the `useTerminalTextRegistration` import and the call (`// Register live terminal text reader for Stream Deck previews` block).

- [ ] **Step 4: Verify — tests, dead-reference grep, typecheck**

Run: `npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx test/unit/client/components/VirtualDeckPanel.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS.

Run: `grep -rn "terminal-text-registry\|registerTerminalTextReader\|getTerminalTextSnapshot\|useTerminalTextRegistration\|readXtermTail\|previewLines\|previewGeometry\|cropPreviewLines\|ringColor\|RingColor\|RING_COLORS\|getTabRingStatus\|TabRingStatus\|PREVIEW_REFRESH_TICKS" src/ test/ shared/ --exclude=SettingsView.core.test.tsx`
Expected: **no matches** (confirms zero dead references). The `--exclude` is required: `test/unit/client/components/SettingsView.core.test.tsx:68-69` has an unrelated local `previewLines` variable (settings terminal-preview UI, not the deck) that pre-dates this work and stays. If any OTHER match appears, it is a real dead reference — fix it. `/api/panes/:id/capture` in `server/` is untouched by design.

Run: `npm run typecheck:client` — clean. Run: `npm run lint` — clean.

- [ ] **Step 5: Commit**

```bash
git add -A src/deck/ src/components/TerminalView.tsx test/
git commit -m "refactor(deck): remove terminal preview machinery and status rings"
```

---

### Task 10: Press-down target snapshot (surprise-press guard)

**Files:**
- Modify: `src/deck/deck-controller.ts`
- Test: `test/unit/client/deck/deck-controller.test.ts`

**Interfaces:**
- Consumes: sorted `selectDeckModel` (Task 4), `planLayout`/`visibleTabs`/`clampPage`/`pageCount` (existing).
- Produces: `pressedAt: Map<number, { at: number; target: PressTarget }>` with `type PressTarget = { kind: 'pager' } | { kind: 'tab'; tabId: string } | { kind: 'none' }` (private; observable behavior below).

- [ ] **Step 1: Write the failing test**

In `test/unit/client/deck/deck-controller.test.ts` (fake timers; store from the suite's fixture builder):

```ts
it('acts on the tab displayed at press-down even if the sort changes mid-press', () => {
  // t1 greenIcon (key 0), t2 greenIcon (key 1). This suite's builder is
  // makeStore({ tabCount }) and it already defaults the active tab to t1.
  const { store, device } = setup({ tabCount: 2 })
  device.emit({ type: 'keyDown', keyIndex: 1 })            // user is pressing "t2"
  // Mid-press: t2 gains attention -> re-sort moves t2 to key 0; key 1 now shows t1.
  // NOTE the object payload: markTabAttention takes { tabId } (the suite already
  // dispatches markTabAttention({ tabId: 't1' }) elsewhere) - a bare-string payload
  // would silently never set attentionByTab, no re-sort would occur, and this test
  // would pass vacuously against unmodified code.
  store.dispatch(markTabAttention({ tabId: 't2' }))
  vi.advanceTimersByTime(100)
  device.emit({ type: 'keyUp', keyIndex: 1 })
  // Snapshot guard: the press focuses t2 (what the user saw), not t1 (what the slot shows now)
  expect(store.getState().tabs.activeTabId).toBe('t2')
})

it('press on a tab that was closed mid-press is a no-op', () => {
  const { store, device } = setup({ tabCount: 2 })
  device.emit({ type: 'keyDown', keyIndex: 1 })
  store.dispatch(closeTab('t2'))                            // async thunk from @/store/tabsSlice - import it; dispatches fine on the fixture store
  vi.advanceTimersByTime(100)
  device.emit({ type: 'keyUp', keyIndex: 1 })
  expect(store.getState().tabs.activeTabId).toBe('t1')
})

it('long-press opens the action layer for the press-down tab despite a mid-press re-sort', () => {
  const { store, device } = setup({ tabCount: 2 })
  device.emit({ type: 'keyDown', keyIndex: 1 })
  store.dispatch(markTabAttention({ tabId: 't2' }))
  vi.advanceTimersByTime(600)
  device.emit({ type: 'keyUp', keyIndex: 1 })
  // Action layer shows BACK/APPROVE/STOP; verify it targets t2 via the frame or controller state
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
  // approve/stop targets resolve against t2 - assert via the suite's existing action-layer helpers
})
```

`markTabAttention` is the real runtime action, exported from `@/store/turnCompletionSlice` with payload `{ tabId: string }` — the suite already imports and dispatches it as `markTabAttention({ tabId: 't1' })`. After each attention dispatch, sanity-check the RED gate is armed: `expect(store.getState().turnCompletion.attentionByTab['t2']).toBe(true)` (or the slice's equivalent flag) — this guards against a payload-shape mistake making the mid-press re-sort never happen and the test passing vacuously. The essential assertion: acting on key 1 after the re-sort affects **t2**.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts --config config/vitest/vitest.config.ts`
Expected: FAIL — current code resolves slot→tab at release, so the press lands on t1.

- [ ] **Step 3: Write the implementation**

In `src/deck/deck-controller.ts`:

```ts
type PressTarget = { kind: 'pager' } | { kind: 'tab'; tabId: string } | { kind: 'none' }
private pressedAt = new Map<number, { at: number; target: PressTarget }>()

// keyDown case in handleInput:
case 'keyDown':
  this.pressedAt.set(event.keyIndex, { at: this.now(), target: this.resolveKeyTarget(event.keyIndex) })
  this.noteActivity()
  break

/** What this key DISPLAYS right now - captured at press-down so re-sorts can't retarget a press. */
private resolveKeyTarget(keyIndex: number): PressTarget {
  const model = selectDeckModel(this.store.getState())
  const plan = planLayout(this.device.capabilities, model.tabs.length)
  if (plan.pagerKey !== null && keyIndex === plan.pagerKey) return { kind: 'pager' }
  const slot = plan.tabSlots.indexOf(keyIndex)
  if (slot === -1) return { kind: 'none' }
  const pages = pageCount(model.tabs.length, plan.tabsPerPage)
  const tab = visibleTabs(model.tabs, clampPage(this.page, pages), plan.tabsPerPage)[slot]
  return tab ? { kind: 'tab', tabId: tab.id } : { kind: 'none' }
}

private handleKeyUp(keyIndex: number): void {
  const press = this.pressedAt.get(keyIndex)
  this.pressedAt.delete(keyIndex)
  this.noteActivity()
  if (press === undefined) return
  if (this.actionLayer) {
    this.handleActionKey(keyIndex)
    return
  }
  const duration = this.now() - press.at
  if (press.target.kind === 'pager') {
    const model = selectDeckModel(this.store.getState())
    const plan = planLayout(this.device.capabilities, model.tabs.length)
    const pages = pageCount(model.tabs.length, plan.tabsPerPage)
    this.page = this.page >= pages ? 1 : this.page + 1
    this.repaint()
    return
  }
  if (press.target.kind !== 'tab') return
  const tabId = press.target.tabId
  const model = selectDeckModel(this.store.getState())
  if (!model.tabs.some((tab) => tab.id === tabId)) return // tab closed mid-press
  if (duration >= LONG_PRESS_MS) {
    this.actionLayer = { tabId, openedAt: this.now() }
    this.repaint()
  } else {
    focusTabFromDeck(this.store, tabId)
    this.repaint()
  }
}
```

Note: when the action layer is open, `keyDown` still snapshots (harmlessly — a wrong-model target) but `handleKeyUp` branches to `handleActionKey` first, exactly as today. Action keys are fixed indices 0/1/2 and unaffected by sorting.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:vitest -- run test/unit/client/deck/deck-controller.test.ts test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS (existing press/pager/long-press tests keep passing — same observable behavior when nothing changes mid-press).

- [ ] **Step 5: Commit**

```bash
git add src/deck/deck-controller.ts test/unit/client/deck/deck-controller.test.ts
git commit -m "feat(deck): snapshot key target at press-down so re-sorts cannot retarget a press"
```

---

### Task 11: E2E scenarios for the redesign

**Files:**
- Modify: `test/e2e/stream-deck-flow.test.tsx`

**Interfaces:**
- Consumes: everything above through the REAL store + REAL `DeckController` + `FakeDeckDevice` + spec-encoding renderer; `IconImageCache` with a deferred fake loader; fixture-builder extensions from Tasks 2–4 (`paneStatus`, `terminalMeta`, `repoIcons` seeding — port them into this suite's `makeDeckStore`).
- Fixtures note (layout-less transient): fixture stores must seed `state.panes.layouts` entries for every created tab (the real `addTab` never does — tabsSlice.ts:296), OR expectations must explicitly account for `panesForTab`'s synthesized single-pane fallback (Task 2) — otherwise sort/icon expectations flake on the layout-less transient.
- Produces: user-story coverage for the redesign.

- [ ] **Step 1: Write the new scenarios (they must fail only if the feature regresses — write them, run, expect PASS since Tasks 1–10 landed; any failure here is a real integration bug to fix before commit)**

Add these scenarios (full code, following the suite's existing `setup()`/`decodeKey` style):

```ts
it('keys are sorted by status priority and stable within groups', () => {
  // 5 tabs: t1 exited(rest), t2 busy(blue), t3 idle-running(green icon),
  // t4 attention(green fill), t5 active+attention(barTop)
  const { device } = setup({
    tabs: 5, activeTab: 't5',
    paneStatus: { p1: 'exited' }, busy: ['term-2'], attention: { t4: true, t5: true },
  })
  const ids = [0, 1, 2, 3, 4].map((k) => {
    const spec = decodeKey(device, k)
    return spec?.kind === 'tab' ? spec.tabId : null
  })
  expect(ids).toEqual(['t5', 't4', 't3', 't2', 't1'])
})

it('tiles carry the three background treatments and the active ring flag', () => {
  const { device } = setup({ tabs: 3, activeTab: 't1', attention: { t1: true, t2: true } })
  expect(decodeKey(device, 0)).toMatchObject({ tabId: 't1', fill: 'barTop', active: true })
  expect(decodeKey(device, 1)).toMatchObject({ tabId: 't2', fill: 'green', active: false })
  expect(decodeKey(device, 2)).toMatchObject({ tabId: 't3', fill: 'none', active: false })
})

it('busy and idle-running tabs expose blue/green dots', () => {
  const { device } = setup({ tabs: 2, busy: ['term-2'] })
  expect(decodeKey(device, 0)).toMatchObject({ tabId: 't1', dot: 'green' }) // idle running
  expect(decodeKey(device, 1)).toMatchObject({ tabId: 't2', dot: 'blue' })  // busy sorts after green
})

it('repo icons: unready at first paint, repaint to ready when the bitmap loads', async () => {
  const { loader, pending } = deferredLoader()
  const cache = new IconImageCache(loader)
  const { device } = setup({
    tabs: 1,
    terminalMeta: { 'term-1': { cwd: '/repos/alpha' } },
    repoIcons: { '/repos/alpha': { status: 'ready', repoRoot: '/repos/alpha', repoName: 'alpha', hasIcon: true } },
  }, undefined, defaultSettings, { iconCache: cache })
  const before = decodeKey(device, 0)
  expect(before).toMatchObject({ icons: [{ letter: 'A', ready: false }] })
  pending.get((before as Extract<KeySpec, { kind: 'tab' }>).icons[0].url!)!.resolve({} as CanvasImageSource)
  await vi.advanceTimersByTimeAsync(0)
  expect(decodeKey(device, 0)).toMatchObject({ icons: [{ letter: 'A', ready: true }] })
})

it('pager pages over the SORTED order', () => {
  // 8 tabs on a 6-key Mini -> 5 tab slots + pager. Make t8 attention: it must appear on page 1 key 0.
  const { device } = setup({ tabs: 8, attention: { t8: true } })
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't8' })
  expect(decodeKey(device, 5)).toMatchObject({ kind: 'pager', page: 1, pageCount: 2 })
  device.press(5) // next page
  // Sorted order: t8,t1,t2,t3,t4 on page 1 (5 tab slots); t5,t6,t7 on page 2.
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'tab', tabId: 't5' })
})

it('a mid-press re-sort does not retarget the press (e2e)', () => {
  const { store, device } = setup({ tabs: 2, activeTab: 't1' })
  device.emit({ type: 'keyDown', keyIndex: 1 })
  store.dispatch(markTabAttention({ tabId: 't2' })) // from '@/store/turnCompletionSlice' - object payload
  vi.advanceTimersByTime(100)
  device.emit({ type: 'keyUp', keyIndex: 1 })
  expect(store.getState().tabs.activeTabId).toBe('t2')
})

it('short-press focuses, long-press opens the action layer - on the sorted layout', () => {
  const { store, device } = setup({ tabs: 3, attention: { t3: true } }) // t3 sorts to key 0
  device.press(0)
  expect(store.getState().tabs.activeTabId).toBe('t3')
  holdKey(device, 1, 600) // long-press whatever now occupies key 1
  expect(decodeKey(device, 0)).toMatchObject({ kind: 'action', action: 'back' })
})
```

Also review the 9 existing scenarios: update key indices for sorted order where fixtures produce mixed statuses, and confirm the idle-dim, dial, STOP-escalation, and teardown scenarios still pass unmodified (they are order-agnostic or now operate on the sorted model by design).

- [ ] **Step 2: Run the suite**

Run: `npm run test:vitest -- run test/e2e/stream-deck-flow.test.tsx --config config/vitest/vitest.config.ts`
Expected: PASS, all scenarios. Fix any real integration bug this surfaces before committing.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/stream-deck-flow.test.tsx
git commit -m "test(deck): e2e coverage for sorted keys, background states, repo icons, press snapshot"
```

---

### Task 12: Full verification sweep

**Files:**
- Modify (only if issues found): any of the above; possibly `docs/index.html`.

- [ ] **Step 1: Focused full deck run**

```bash
npm run test:vitest -- run test/unit/client/deck/ test/e2e/stream-deck-flow.test.tsx \
  test/unit/client/components/VirtualDeckPanel.test.tsx \
  test/unit/client/components/settings/StreamDeckSettings.test.tsx \
  test/unit/shared/settings.stream-deck.test.ts \
  --config config/vitest/vitest.config.ts
```
Expected: all PASS.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck:client` — clean. Run: `npm run lint` — clean (jsx-a11y included; `VirtualDeckPanel` buttons already carry `aria-label`s — verify nothing regressed).

- [ ] **Step 3: TerminalView regression check**

Run the terminal view's own tests (locate with `ls test/unit/client/components/ | grep -i terminal`) to confirm the hook removal broke nothing:
`npm run test:vitest -- run test/unit/client/components/TerminalView* --config config/vitest/vitest.config.ts` (adjust to actual filenames; if none exist, note it and move on).

- [ ] **Step 4: Coordinated broad run**

```bash
npm run test:status                       # respect the gate; wait if held
FRESHELL_TEST_SUMMARY="deck tile redesign" npm run check
```
Expected: typecheck + full coordinated suite green. Never kill a foreign gate holder; wait instead.

- [ ] **Step 5: docs/index.html check**

AGENTS.md requires updating `docs/index.html` for significant UI changes. Search it for Stream Deck tile descriptions (`grep -in "stream deck\|deck" docs/index.html`). If it describes the old tile design (terminal previews / status rings), update that copy to the new design (title + repo icons + status backgrounds + priority sorting); if it only mentions the feature generically, no change needed.

- [ ] **Step 6: Commit any fixes**

```bash
git add -A && git commit -m "chore(deck): verification sweep fixes for tile redesign"   # only if changes exist
```

Do NOT create a PR — stop after committing; PR creation requires explicit user approval.

---

## Self-review record

**1. Spec coverage:**
- Title on top (unchanged banner) → Task 7 step 3 (§4 of `drawTab`).
- Repo icons centered, tab-bar pipeline reuse, cap-3 → Tasks 3, 5, 7; async load + cache + fallback → Tasks 6, 7, 8; no-repo tab renders title-only → Task 7 (`icons: []` → no draws) + Task 3 test; deck-owned un-gated `fetchRepoIconMeta` probing (TabBar's probe is setting-gated and conditionally mounted, so the deck cannot rely on it) → Design decision 7 + Task 8 step 3.7; drawn-empty SVG guard (<1% alpha coverage → entry FAILED → letter avatar) → Task 6; explicit-dims `drawImage` rule → Task 7; Rust-server icon-coverage parity documented as an accepted scope note (Investigation results).
- Layout-less tabs (a real transient: `addTab` never seeds a layout) classify and derive icons via `panesForTab`'s synthesized single pane mirroring `TabBar.tsx:203-221` (TabBar itself untouched) → Tasks 2, 3; e2e fixtures seed layouts or account for the fallback → Task 11.
- Preview removal + dead machinery deletion (registry, TerminalView hook, 3s repaint, preview constants) with `/capture` untouched → Tasks 8, 9 (grep gate in Task 9 step 4).
- Three background treatments driven by shared tab-bar conditions + exact color mapping → Tasks 1, 2, 7 (colors from verified `theme-variables.css` / Tailwind values).
- Icon tinting: investigation showed the tab bar never tints repo icons (only pane icons); green/blue visibility on deck is delivered via the status dot with the same conditions/colors → Design decision 4, Tasks 1, 7.
- Active tab white ring kept → Task 7 (§5) + tests.
- Sorting with stable within-group order, pager over sorted list, dials on sorted order → Tasks 4, 11.
- Surprise-press guard (verified: NO existing snapshot; added) → Task 10 + e2e in Task 11.
- Virtual deck shares renderer (verified) → Task 7 wiring + Task 12 tests.
- Client-only; tab bar unchanged (read-only reuse; `hueFromString` fallback note in Task 3 keeps a single implementation).
- Unit + e2e coverage for sort priority and the three backgrounds → Tasks 1, 4 (unit), 11 (e2e). Lint/typecheck/coordinated suite → Task 12.

**1b. No silent deferrals:** The only test doubles are the established suite seams (spec-encoding renderer, `FakeDeckDevice`, fake icon loader) plus the injectable drawn-empty probe — every double has a production path: the default `IconLoader` uses a real `Image` (Task 6), the default `IconProbe` draws into a real probe canvas with its pure threshold logic (`hasDrawnPixels`) unit-tested directly (Task 6), the default renderer path passes the real cache (Task 8 step 3.2), and the probe dispatch uses the real `fetchRepoIconMeta` thunk in tests and production alike (Task 8 step 3.7). One documented limitation, accepted deliberately (not silent): Rust-server icon coverage equals the tab bar's existing coverage — same resolver, same degradation (Investigation results scope note).

**2. Placeholder scan:** Two intentional adapt-to-fixture instructions remain (Task 2/3: "match the fixture builder actually present in the file") — these are file-drift guards with concrete fallback code shown, not deferrals. The Task 3 cap/dedupe test body is specified by exact expected behavior with construction guidance; implementer writes the fixture wiring. The validation-driven additions (layout-fallback tests, `panesForTab`, probe-dispatch tests + `probeRepoIcons`, drawn-empty probe + `hasDrawnPixels` tests) all carry full runnable code. All other steps carry full code.

**3. Type consistency check:** `TileFill`/`TileDot`/`TabStatusFlags` (Task 1) ← used in Tasks 2, 4, 5, 7. `panesForTab(state, tab): Array<{ paneId; content }>` (Task 2) ← used by `getTabStatusFlags` (Task 2), `getTabRepoIcons` (Task 3), `probeRepoIcons` (Task 8). `TileRepoIcon { url, letter, hue }` (Task 3) → `TileIcon = TileRepoIcon & { ready }` shape (Task 5) → renderer reads `icon.url/letter/hue/ready` (Task 7). `iconReady(url) => boolean` named consistently (Tasks 5, 8). `IconImageCache` constructor `(loader?: IconLoader, probe?: IconProbe)` with `bitmapFor/subscribe` consistent (Tasks 6, 7, 8, 11); `IconProbe`/`hasDrawnPixels` (Task 6) have their production path in `defaultProbe`. `DeckTab` transitional `status` added Task 4, removed Task 9 — both sides documented. `renderKey` 4-arg signature consistent (Tasks 7, 8, VirtualDeckPanel).
